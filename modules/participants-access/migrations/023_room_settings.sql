-- Duefold room settings, visibility, and counterparties. Immutable after application.

/*
 * What the actor may change about this room. Each key mirrors exactly one function's
 * refusals, so a control the surface offers and a call the database accepts cannot
 * drift:
 *
 *   publish        apply_room_visibility(published): Room Manager; room is draft; its
 *                  structure has been published at least once.
 *   archive        apply_room_visibility(archived): Room Manager; room is draft or published.
 *   returnToDraft  apply_room_visibility(draft): Room Manager; room is published or
 *                  archived; no live purge pins it.
 *   setRetention   apply_audit_retention: Owner; room is draft.
 *   schedulePurge  schedule_room_purge: Owner; room is archived; no uncancelled purge.
 *   cancelPurge    cancel_room_purge: Owner; a scheduled purge inside its window.
 */
CREATE FUNCTION room_settings_capabilities(p_actor_id text,p_room_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object(
    'publish', facts.is_manager AND r.state='draft' AND r.published_revision>0,
    'archive', facts.is_manager AND r.state IN ('draft','published'),
    'returnToDraft', facts.is_manager AND r.state IN ('published','archived') AND NOT facts.pinned,
    'setRetention', facts.is_owner AND r.state='draft',
    'schedulePurge', facts.is_owner AND r.state='archived' AND NOT facts.purge_held,
    'cancelPurge', facts.is_owner AND facts.cancellable)
  FROM room r
  CROSS JOIN LATERAL (
    SELECT
      member_can_mutate_room(p_actor_id,r.id,true) AS is_manager,
      EXISTS(SELECT 1 FROM member m
              WHERE m.id=p_actor_id AND m.state='active' AND m.global_role='owner') AS is_owner,
      EXISTS(SELECT 1 FROM room_purge p WHERE p.room_id=r.id
                AND p.state IN ('scheduled','marker_pending','purging')) AS pinned,
      EXISTS(SELECT 1 FROM room_purge p WHERE p.room_id=r.id AND p.state<>'cancelled') AS purge_held,
      EXISTS(SELECT 1 FROM room_purge p WHERE p.room_id=r.id AND p.state='scheduled'
                AND p.purge_after>statement_timestamp()) AS cancellable
  ) facts
  WHERE r.id=p_room_id
$$;

CREATE FUNCTION read_room_settings(p_actor_id text,p_room_id text)
RETURNS TABLE(room_id text,state text,revision integer,published_revision integer,
              audit_retention_years smallint,default_grant_expires_at timestamptz,
              download_policy text,installation_download_policy text,
              purge_id text,purge_state text,purge_after timestamptz,capabilities jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM room WHERE id=p_room_id)
     OR NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT r.id,r.state,r.revision,r.published_revision,r.audit_retention_years,
           r.default_grant_expires_at,r.download_policy,o.installation_download_policy,
           p.id,p.state,p.purge_after,room_settings_capabilities(p_actor_id,r.id)
      FROM room r
     CROSS JOIN organization o
      LEFT JOIN room_purge p ON p.room_id=r.id AND p.state<>'cancelled'
     WHERE r.id=p_room_id;
END $$;

CREATE FUNCTION read_room_download_overrides(p_actor_id text,p_room_id text)
RETURNS TABLE(document_id text,download_policy text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM room WHERE id=p_room_id)
     OR NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT d.id,d.download_policy FROM document d
     WHERE d.room_id=p_room_id AND d.download_policy IS NOT NULL
     ORDER BY d.id;
END $$;

REVOKE ALL ON FUNCTION room_settings_capabilities(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_room_settings(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_room_download_overrides(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_room_settings(text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_room_download_overrides(text,text) TO duefold_runtime;
ALTER FUNCTION room_settings_capabilities(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_room_settings(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_room_download_overrides(text,text) OWNER TO duefold_migration;

-- Visibility. Publishing or archiving is reviewed first; the review counts the viewers
-- whose access the change grants or ends, which is participants-access data and why
-- these functions live in this module.
--
-- The count is an UPPER BOUND, not an exact promise. `room.revision` binds the apply to the
-- room the review saw, but reach also falls when a grant passes its `expires_at` and when a
-- trash removal revokes the grants beneath it, neither of which advances the revision. Both
-- only remove reach, so a Manager is never shown fewer viewers than the change affects.
CREATE FUNCTION dry_run_room_visibility(p_actor_id text,p_room_id text,p_state text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected room%ROWTYPE; reach integer; documents integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM room WHERE id=p_room_id)
     OR NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('published','archived') THEN
    RAISE EXCEPTION 'visibility review names published or archived' USING ERRCODE='22023';
  END IF;
  SELECT * INTO selected FROM room WHERE id=p_room_id;
  IF (p_state='published' AND (selected.state<>'draft' OR selected.published_revision=0))
     OR (p_state='archived' AND selected.state NOT IN ('draft','published')) THEN
    RAISE EXCEPTION 'visibility change unavailable from this state' USING ERRCODE='55000';
  END IF;
  SELECT count(*)::integer INTO reach FROM viewer_room_membership m
   WHERE m.room_id=p_room_id AND m.state='active'
     AND EXISTS(SELECT 1 FROM effective_access_grants(m.viewer_id,p_room_id));
  SELECT count(*)::integer INTO documents FROM published_structure_entry e
   WHERE e.room_id=p_room_id AND e.resource_kind='document';
  RETURN jsonb_build_object(
    'roomId',p_room_id,
    'currentState',selected.state,
    'proposedState',p_state,
    -- Viewers who gain access by publishing, or lose it by archiving a published room.
    'viewerCount',CASE WHEN p_state='published' OR selected.state='published' THEN reach ELSE 0 END,
    'publishedDocumentCount',documents,
    'requiresFreshAuthentication',p_state='published',
    'expectedRevision',selected.revision,
    'confirmation',CASE p_state WHEN 'published' THEN 'PUBLISH ROOM' ELSE 'ARCHIVE ROOM' END);
END $$;

-- Returning to draft is the kill switch: no review, no phrase, no freshness. Publishing
-- exposes content, so it alone needs a fresh sign-in. Authority is checked first, so a
-- caller who may not act is never told to sign in again.
CREATE FUNCTION apply_room_visibility(
  p_actor_id text,p_room_id text,p_state text,p_expected_revision integer,
  p_oidc_authenticated_at timestamptz,p_confirmation text,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_state text; impact jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM room WHERE id=p_room_id)
     OR NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('draft','published','archived')
     OR (p_state='draft') <> (p_confirmation IS NULL) THEN
    RAISE EXCEPTION 'invalid visibility change' USING ERRCODE='22023';
  END IF;
  SELECT r.state INTO current_state FROM room r WHERE r.id=p_room_id FOR UPDATE;
  IF current_state=p_state THEN
    RAISE EXCEPTION 'room already has that visibility' USING ERRCODE='55000';
  END IF;
  IF p_state='published' AND (p_oidc_authenticated_at IS NULL
       OR p_oidc_authenticated_at>statement_timestamp()
       OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes') THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  IF p_state<>'draft' THEN
    impact:=dry_run_room_visibility(p_actor_id,p_room_id,p_state);
    IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
      RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
    END IF;
  END IF;
  RETURN change_room_state(p_room_id,p_state,p_actor_id,p_expected_revision,p_audit_id,p_correlation_id);
END $$;

REVOKE ALL ON FUNCTION dry_run_room_visibility(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_room_visibility(text,text,text,integer,timestamptz,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dry_run_room_visibility(text,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION apply_room_visibility(text,text,text,integer,timestamptz,text,text,text) TO duefold_runtime;
ALTER FUNCTION dry_run_room_visibility(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION apply_room_visibility(text,text,text,integer,timestamptz,text,text,text) OWNER TO duefold_migration;

