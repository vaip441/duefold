-- Participants, allow-only grants, expiry, and uniform download policy.
--
-- All tables remain unreachable to duefold_runtime. The web role receives only
-- narrow SECURITY DEFINER functions which authorize before reading or mutating.

ALTER TABLE organization ADD COLUMN installation_download_policy text NOT NULL DEFAULT 'deny'
  CHECK (installation_download_policy IN ('allow','deny')),
  ADD COLUMN policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision>0);
ALTER TABLE room
  ADD COLUMN default_grant_expires_at timestamptz,
  ADD COLUMN download_policy text CHECK (download_policy IN ('allow','deny'));
ALTER TABLE document ADD COLUMN download_policy text CHECK (download_policy IN ('allow','deny'));
-- organization predates column-level security policy and the runtime role holds
-- UPDATE so first-owner bootstrap can take its explicit EXCLUSIVE table lock.
-- Preserve that proven bootstrap contract, but make the new security policy
-- migration-function-only so blanket table authority cannot silently alter it.
CREATE FUNCTION protect_installation_download_policy() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.installation_download_policy IS DISTINCT FROM OLD.installation_download_policy
     AND current_user<>'duefold_migration' THEN
    RAISE EXCEPTION 'installation download policy is mutation-function only' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER installation_download_policy_guard
BEFORE UPDATE OF installation_download_policy ON organization
FOR EACH ROW EXECUTE FUNCTION protect_installation_download_policy();

CREATE TABLE counterparty (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (valid_structure_text(name,200,false)),
  normalized_name text GENERATED ALWAYS AS (canonical_structure_name(name)) STORED,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (id,room_id),
  UNIQUE (room_id,normalized_name)
);

CREATE TABLE viewer_room_membership (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  viewer_id text NOT NULL REFERENCES viewer(id),
  room_id text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (viewer_id,room_id)
);

CREATE TABLE counterparty_viewer (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  counterparty_id text NOT NULL,
  room_id text NOT NULL,
  viewer_id text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (counterparty_id,room_id) REFERENCES counterparty(id,room_id) ON DELETE CASCADE,
  FOREIGN KEY (viewer_id,room_id) REFERENCES viewer_room_membership(viewer_id,room_id) ON DELETE CASCADE
);
-- A viewer can belong to several counterparties installation-wide, but never to
-- two counterparties in the same room. This is a database invariant, not a
-- service-layer check; concurrent inserts race on this index and one loses.
CREATE UNIQUE INDEX one_active_counterparty_per_viewer_room
  ON counterparty_viewer(viewer_id,room_id) WHERE state='active';

CREATE TABLE access_grant (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  grantee_kind text NOT NULL CHECK (grantee_kind IN ('viewer','counterparty')),
  viewer_id text REFERENCES viewer(id),
  counterparty_id text REFERENCES counterparty(id),
  target_kind text NOT NULL CHECK (target_kind IN ('room','folder','document')),
  folder_id text REFERENCES folder(id) ON DELETE CASCADE,
  document_id text REFERENCES document(id) ON DELETE CASCADE,
  expires_at timestamptz,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by text NOT NULL REFERENCES member(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT access_grant_grantee_cardinality CHECK
    ((grantee_kind='viewer' AND viewer_id IS NOT NULL AND counterparty_id IS NULL) OR
     (grantee_kind='counterparty' AND viewer_id IS NULL AND counterparty_id IS NOT NULL)),
  -- Exactly one target: room is represented by both resource columns being NULL.
  CONSTRAINT access_grant_target_cardinality CHECK
    ((target_kind='room' AND folder_id IS NULL AND document_id IS NULL) OR
     (target_kind='folder' AND folder_id IS NOT NULL AND document_id IS NULL) OR
     (target_kind='document' AND folder_id IS NULL AND document_id IS NOT NULL)),
  CONSTRAINT access_grant_state_cardinality CHECK
    ((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX active_grant_viewer_room ON access_grant(viewer_id,room_id) WHERE state='active';
CREATE INDEX active_grant_counterparty_room ON access_grant(counterparty_id,room_id) WHERE state='active';
CREATE INDEX grant_folder_target ON access_grant(folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX grant_document_target ON access_grant(document_id) WHERE document_id IS NOT NULL;

CREATE FUNCTION enforce_access_grant_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.grantee_kind='viewer' AND NOT EXISTS(
    SELECT 1 FROM viewer_room_membership m JOIN viewer v ON v.id=m.viewer_id
    WHERE m.viewer_id=NEW.viewer_id AND m.room_id=NEW.room_id AND m.state='active' AND v.state='active'
  ) THEN RAISE EXCEPTION 'viewer is not active in room' USING ERRCODE='23514'; END IF;
  IF NEW.grantee_kind='counterparty' AND NOT EXISTS(
    SELECT 1 FROM counterparty c WHERE c.id=NEW.counterparty_id AND c.room_id=NEW.room_id
  ) THEN RAISE EXCEPTION 'counterparty room mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.target_kind='folder' AND NOT EXISTS(
    SELECT 1 FROM folder f WHERE f.id=NEW.folder_id AND f.room_id=NEW.room_id
  ) THEN RAISE EXCEPTION 'grant folder room mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.target_kind='document' AND NOT EXISTS(
    SELECT 1 FROM document d WHERE d.id=NEW.document_id AND d.room_id=NEW.room_id
  ) THEN RAISE EXCEPTION 'grant document room mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_grant_integrity BEFORE INSERT OR UPDATE OF room_id,grantee_kind,viewer_id,
 counterparty_id,target_kind,folder_id,document_id ON access_grant
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_integrity();

-- The union is centralized. Every viewer authorization consumes this function,
-- so direct and counterparty grants cannot drift across page/search/download paths.
CREATE FUNCTION effective_access_grants(p_viewer_id text,p_room_id text)
RETURNS TABLE(grant_id text,source text,target_kind text,folder_id text,document_id text,expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT g.id,'direct'::text,g.target_kind,g.folder_id,g.document_id,g.expires_at
  FROM access_grant g JOIN viewer v ON v.id=p_viewer_id AND v.state='active'
  JOIN viewer_room_membership m ON m.viewer_id=v.id AND m.room_id=g.room_id AND m.state='active'
  WHERE g.room_id=p_room_id AND g.grantee_kind='viewer' AND g.viewer_id=p_viewer_id
    AND g.state='active' AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())
  UNION ALL
  SELECT g.id,'counterparty'::text,g.target_kind,g.folder_id,g.document_id,g.expires_at
  FROM access_grant g JOIN viewer v ON v.id=p_viewer_id AND v.state='active'
  JOIN viewer_room_membership m ON m.viewer_id=v.id AND m.room_id=g.room_id AND m.state='active'
  JOIN counterparty_viewer cv ON cv.viewer_id=v.id AND cv.room_id=g.room_id
    AND cv.counterparty_id=g.counterparty_id AND cv.state='active'
  WHERE g.room_id=p_room_id AND g.grantee_kind='counterparty'
    AND g.state='active' AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())
$$;

CREATE FUNCTION viewer_can_preview_document(p_viewer_id text,p_session_id text,p_room_id text,p_document_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM session s JOIN viewer live_viewer ON live_viewer.id=s.viewer_id AND live_viewer.state='active'
    WHERE s.id=p_session_id AND s.principal_kind='viewer' AND s.viewer_id=p_viewer_id
      AND s.state='active' AND s.idle_expires_at>statement_timestamp()
      AND s.absolute_expires_at>statement_timestamp()
  ) AND EXISTS(
    WITH RECURSIVE ancestors AS (
      SELECT p.parent_folder_id FROM published_structure_entry p
      WHERE p.room_id=p_room_id AND p.resource_kind='document' AND p.resource_id=p_document_id
        AND p.published_version_id IS NOT NULL
      UNION ALL
      SELECT parent.parent_folder_id FROM ancestors a JOIN published_structure_entry parent
        ON parent.room_id=p_room_id AND parent.resource_kind='folder'
        AND parent.resource_id=a.parent_folder_id
      WHERE a.parent_folder_id IS NOT NULL
    )
    SELECT 1 FROM room r JOIN published_structure_entry p
      ON p.room_id=r.id AND p.resource_kind='document' AND p.resource_id=p_document_id
    JOIN document_version v ON v.id=p.published_version_id
    WHERE r.id=p_room_id AND r.state='published'
      AND version_has_publication_evidence(v.id,p_document_id)
      AND EXISTS(
        SELECT 1 FROM effective_access_grants(p_viewer_id,p_room_id) g
        WHERE g.target_kind='room'
          OR (g.target_kind='document' AND g.document_id=p_document_id)
          OR (g.target_kind='folder' AND g.folder_id IN (SELECT parent_folder_id FROM ancestors))
      )
  )
$$;

-- Viewer authorization consumes only credential-bound projections. The raw
-- publication snapshot helpers that predated viewer grants are intentionally
-- absent from migrations 004 and 005.

-- A viewer-facing projection resolves the live session, active viewer and room
-- membership, direct/counterparty grant union, exact statement-time expiry,
-- publication state, published entries, and publication evidence in one
-- protected database call. `directly_visible` selects only granted entries;
-- `visible_ids` adds ancestor folders solely as navigation paths. It never adds
-- an ancestor's siblings or children, so path disclosure cannot become subtree
-- disclosure.
CREATE FUNCTION read_viewer_published_structure(
  p_viewer_id text,p_session_id text,p_room_id text
) RETURNS TABLE(entry_id text,resource_kind text,resource_id text,parent_folder_id text,
  display_name text,description text,order_key text,published_version_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE session_authorized AS (
    SELECT 1
    FROM session s JOIN viewer v ON v.id=s.viewer_id AND v.state='active'
    JOIN viewer_room_membership m ON m.viewer_id=v.id AND m.room_id=p_room_id AND m.state='active'
    JOIN room r ON r.id=m.room_id AND r.state='published'
    WHERE s.id=p_session_id AND s.viewer_id=p_viewer_id AND s.principal_kind='viewer'
      AND s.state='active' AND s.idle_expires_at>statement_timestamp()
      AND s.absolute_expires_at>statement_timestamp()
  ), grants AS MATERIALIZED (
    SELECT * FROM effective_access_grants(p_viewer_id,p_room_id)
    WHERE EXISTS(SELECT 1 FROM session_authorized)
  ), room_descendants AS (
    SELECT p.entry_id,p.resource_kind,p.resource_id,p.parent_folder_id,p.published_version_id
    FROM published_structure_entry p
    WHERE p.room_id=p_room_id AND p.parent_folder_id IS NULL
      AND EXISTS(SELECT 1 FROM grants g WHERE g.target_kind='room')
    UNION ALL
    SELECT p.entry_id,p.resource_kind,p.resource_id,p.parent_folder_id,p.published_version_id
    FROM room_descendants d JOIN published_structure_entry p
      ON p.room_id=p_room_id AND p.parent_folder_id=d.resource_id
  ), folder_descendants AS (
    SELECT p.entry_id,p.resource_kind,p.resource_id,p.parent_folder_id,p.published_version_id
    FROM published_structure_entry p JOIN grants g
      ON g.target_kind='folder' AND g.folder_id=p.resource_id
    WHERE p.room_id=p_room_id AND p.resource_kind='folder'
    UNION ALL
    SELECT p.entry_id,p.resource_kind,p.resource_id,p.parent_folder_id,p.published_version_id
    FROM folder_descendants d JOIN published_structure_entry p
      ON p.room_id=p_room_id AND p.parent_folder_id=d.resource_id
  ), directly_visible AS (
    SELECT d.entry_id,d.parent_folder_id
    FROM (
      SELECT * FROM room_descendants
      UNION
      SELECT * FROM folder_descendants
      UNION
      SELECT p.entry_id,p.resource_kind,p.resource_id,p.parent_folder_id,p.published_version_id
      FROM published_structure_entry p JOIN grants g
        ON g.target_kind='document' AND g.document_id=p.resource_id
      WHERE p.room_id=p_room_id AND p.resource_kind='document'
    ) d
    WHERE d.resource_kind='folder'
       OR (d.published_version_id IS NOT NULL
         AND version_has_publication_evidence(d.published_version_id,d.resource_id))
  ), visible_ids(entry_id,parent_folder_id) AS (
    SELECT entry_id,parent_folder_id FROM directly_visible
    UNION
    SELECT parent.entry_id,parent.parent_folder_id
    FROM visible_ids child JOIN published_structure_entry parent
      ON parent.room_id=p_room_id AND parent.resource_kind='folder'
      AND parent.resource_id=child.parent_folder_id
    WHERE child.parent_folder_id IS NOT NULL
  )
  SELECT p.entry_id,p.resource_kind,p.resource_id,p.parent_folder_id,p.display_name,
    CASE WHEN EXISTS(SELECT 1 FROM directly_visible d WHERE d.entry_id=p.entry_id)
      THEN p.description ELSE ''::text END,
    p.order_key::text,p.published_version_id
  FROM published_structure_entry p JOIN visible_ids v ON v.entry_id=p.entry_id
  WHERE p.room_id=p_room_id
  ORDER BY p.order_key,p.entry_id
$$;

CREATE FUNCTION read_viewer_published_search(
  p_viewer_id text,p_session_id text,p_room_id text,p_query text,p_limit integer
) RETURNS TABLE(resource_kind text,resource_id text,display_name text,description text,path text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF length(p_query) NOT BETWEEN 1 AND 200 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid search bounds' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH RECURSIVE visible AS (
    SELECT p.*,p.display_name::text full_path
    FROM read_viewer_published_structure(p_viewer_id,p_session_id,p_room_id) p
    WHERE p.parent_folder_id IS NULL
    UNION ALL
    SELECT child.*,(parent.full_path||' / '||child.display_name)::text
    FROM visible parent JOIN read_viewer_published_structure(
      p_viewer_id,p_session_id,p_room_id) child
      ON child.parent_folder_id=parent.resource_id
  ), search_matched AS MATERIALIZED (
    SELECT p.entry_id,p.room_id
    FROM published_structure_entry p
    WHERE search_text_matches(p.display_name||' '||p.description,p_query)
  ), matched AS (
    SELECT p.entry_id
    FROM search_matched p
    WHERE p.room_id=p_room_id
  )
  SELECT v.resource_kind,v.resource_id,v.display_name,v.description,v.full_path
  FROM visible v JOIN matched m ON m.entry_id=v.entry_id
  ORDER BY v.full_path,v.order_key,v.entry_id LIMIT p_limit;
END $$;

-- Legacy room-level authorization remains usable only as a boolean capability
-- check. It does not authorize a subsequent raw projection; viewer data is
-- returned solely by the viewer-aware functions above.
CREATE FUNCTION authorize_viewer_published_room(p_viewer_id text,p_session_id text,p_room_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM session s JOIN viewer v ON v.id=s.viewer_id AND v.state='active'
    WHERE s.id=p_session_id AND s.viewer_id=p_viewer_id AND s.principal_kind='viewer'
      AND s.state='active' AND s.idle_expires_at>statement_timestamp()
      AND s.absolute_expires_at>statement_timestamp()
  ) AND EXISTS(SELECT 1 FROM room r WHERE r.id=p_room_id AND r.state='published')
    AND EXISTS(SELECT 1 FROM effective_access_grants(p_viewer_id,p_room_id) g WHERE g.target_kind='room')
$$;

-- Manager-only explanation. It returns only rows for the named viewer and room;
-- viewer-facing code has no EXECUTE and cannot enumerate counterparties or peers.
CREATE FUNCTION read_effective_permission_preview(p_actor_id text,p_viewer_id text,p_room_id text)
RETURNS TABLE(grant_id text,source text,target_kind text,path text,expires_at timestamptz,
  document_level_exception boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  WITH RECURSIVE paths AS (
    SELECT p.resource_kind,p.resource_id,p.parent_folder_id,p.display_name::text full_path
    FROM published_structure_entry p WHERE p.room_id=p_room_id AND p.parent_folder_id IS NULL
    UNION ALL
    SELECT p.resource_kind,p.resource_id,p.parent_folder_id,(x.full_path||' / '||p.display_name)::text
    FROM paths x JOIN published_structure_entry p
      ON p.room_id=p_room_id AND p.parent_folder_id=x.resource_id
  )
  SELECT g.grant_id,g.source,g.target_kind,
    CASE g.target_kind WHEN 'room' THEN r.title
      WHEN 'folder' THEN COALESCE((SELECT full_path FROM paths WHERE resource_kind='folder' AND resource_id=g.folder_id),'Unpublished folder')
      ELSE COALESCE((SELECT full_path FROM paths WHERE resource_kind='document' AND resource_id=g.document_id),'Unpublished document') END,
    g.expires_at,g.target_kind='document'
  FROM effective_access_grants(p_viewer_id,p_room_id) g JOIN room r ON r.id=p_room_id
  ORDER BY g.target_kind,g.grant_id;
END $$;

CREATE FUNCTION grant_target_impact(p_room_id text,p_target_kind text,p_folder_id text,p_document_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE paths AS (
    SELECT e.folder_id,e.document_id,e.parent_folder_id,e.display_name::text full_path,
      (p_target_kind='room' OR (p_target_kind='folder' AND e.folder_id=p_folder_id)
        OR (p_target_kind='document' AND e.document_id=p_document_id)) affected
    FROM working_structure_entry e
    WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
    UNION ALL
    SELECT e.folder_id,e.document_id,e.parent_folder_id,(p.full_path||' / '||e.display_name)::text,
      (p.affected OR p_target_kind='room'
        OR (p_target_kind='folder' AND e.folder_id=p_folder_id)
        OR (p_target_kind='document' AND e.document_id=p_document_id))
    FROM paths p JOIN working_structure_entry e ON e.parent_folder_id=p.folder_id
    WHERE e.room_id=p_room_id AND NOT e.staged_removed
  ), affected_paths AS (
    SELECT full_path FROM paths WHERE affected
  )
  SELECT jsonb_build_object('affectedCount',count(*)::integer,
    'paths',COALESCE(jsonb_agg(full_path ORDER BY full_path),'[]'::jsonb)) FROM affected_paths
$$;

CREATE FUNCTION dry_run_grant_change(
  p_actor_id text,p_room_id text,p_action text,p_grant_id text,p_grantee_kind text,
  p_viewer_id text,p_counterparty_id text,p_target_kind text,p_folder_id text,
  p_document_id text,p_expires_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected access_grant%ROWTYPE; impact jsonb; resolved_expiry timestamptz; phrase text;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF p_action NOT IN ('grant','revoke','expiry') THEN
    RAISE EXCEPTION 'invalid grant action' USING ERRCODE='22023';
  END IF;
  IF p_action='grant' THEN
    IF p_grantee_kind NOT IN ('viewer','counterparty') OR p_target_kind NOT IN ('room','folder','document') THEN
      RAISE EXCEPTION 'invalid grant shape' USING ERRCODE='22023';
    END IF;
    SELECT COALESCE(p_expires_at,r.default_grant_expires_at) INTO resolved_expiry FROM room r WHERE r.id=p_room_id;
    IF resolved_expiry IS NOT NULL AND resolved_expiry<=statement_timestamp() THEN
      RAISE EXCEPTION 'grant expiry must be in the future' USING ERRCODE='22023';
    END IF;
    impact:=grant_target_impact(p_room_id,p_target_kind,p_folder_id,p_document_id);
    phrase:='GRANT ACCESS TO '||(impact->>'affectedCount')||' ITEMS';
  ELSE
    SELECT * INTO selected FROM access_grant g WHERE g.id=p_grant_id AND g.room_id=p_room_id AND g.state='active';
    IF selected.id IS NULL THEN RAISE EXCEPTION 'active grant not found' USING ERRCODE='40001'; END IF;
    resolved_expiry:=CASE WHEN p_action='expiry' THEN p_expires_at ELSE selected.expires_at END;
    IF p_action='expiry' AND resolved_expiry IS NOT NULL AND resolved_expiry<=statement_timestamp() THEN
      RAISE EXCEPTION 'grant expiry must be in the future' USING ERRCODE='22023';
    END IF;
    impact:=grant_target_impact(selected.room_id,selected.target_kind,selected.folder_id,selected.document_id);
    phrase:=CASE p_action WHEN 'revoke' THEN 'REVOKE ACCESS FROM ' ELSE 'CHANGE EXPIRY FOR ' END
      ||(impact->>'affectedCount')||' ITEMS';
  END IF;
  RETURN impact||jsonb_build_object('action',p_action,'confirmation',phrase,
    'resolvedExpiresAt',CASE WHEN resolved_expiry IS NULL THEN NULL ELSE to_jsonb(resolved_expiry) END,
    'message',CASE p_action
      WHEN 'grant' THEN 'Allow preview access to the listed content.'
      WHEN 'revoke' THEN 'Remove preview access to the listed content immediately.'
      ELSE 'Change the exact UTC expiry for the listed grant.' END);
END $$;

CREATE FUNCTION apply_grant_change(
  p_actor_id text,p_room_id text,p_action text,p_grant_id text,p_grantee_kind text,
  p_viewer_id text,p_counterparty_id text,p_target_kind text,p_folder_id text,
  p_document_id text,p_expires_at timestamptz,p_expected_room_revision integer,
  p_oidc_authenticated_at timestamptz,p_confirmation text,p_audit_id text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb; resolved_expiry timestamptz; changed integer; broad_change boolean;
BEGIN
  impact:=dry_run_grant_change(p_actor_id,p_room_id,p_action,p_grant_id,p_grantee_kind,
    p_viewer_id,p_counterparty_id,p_target_kind,p_folder_id,p_document_id,p_expires_at);
  IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  IF p_action='grant' THEN
    broad_change:=p_target_kind='room' OR p_grantee_kind='counterparty';
  ELSE
    SELECT (g.target_kind='room' OR g.grantee_kind='counterparty') INTO broad_change
    FROM access_grant g WHERE g.id=p_grant_id AND g.room_id=p_room_id AND g.state='active';
  END IF;
  IF COALESCE(broad_change,false) AND
     (p_oidc_authenticated_at IS NULL OR p_oidc_authenticated_at>statement_timestamp()
       OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes') THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  UPDATE room SET revision=revision+1 WHERE id=p_room_id AND revision=p_expected_room_revision
    AND member_can_mutate_room(p_actor_id,p_room_id,true);
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'stale room revision' USING ERRCODE='40001'; END IF;
  resolved_expiry:=NULLIF(impact->>'resolvedExpiresAt','')::timestamptz;
  IF p_action='grant' THEN
    INSERT INTO access_grant(id,room_id,grantee_kind,viewer_id,counterparty_id,target_kind,
      folder_id,document_id,expires_at,created_by)
    VALUES(p_grant_id,p_room_id,p_grantee_kind,p_viewer_id,p_counterparty_id,p_target_kind,
      p_folder_id,p_document_id,resolved_expiry,p_actor_id);
  ELSIF p_action='revoke' THEN
    UPDATE access_grant SET state='revoked',revoked_at=transaction_timestamp(),revision=revision+1
      WHERE id=p_grant_id AND room_id=p_room_id AND state='active';
    IF NOT FOUND THEN RAISE EXCEPTION 'stale grant' USING ERRCODE='40001'; END IF;
  ELSE
    UPDATE access_grant SET expires_at=resolved_expiry,revision=revision+1
      WHERE id=p_grant_id AND room_id=p_room_id AND state='active';
    IF NOT FOUND THEN RAISE EXCEPTION 'stale grant' USING ERRCODE='40001'; END IF;
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
    resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'grant.'||p_action,'member',p_actor_id,COALESCE(p_viewer_id,p_counterparty_id),
    p_room_id,'grant',p_grant_id,'success',upper(p_action)||'_APPLIED',p_correlation_id,
    jsonb_build_object('action',p_action,'affectedCount',impact->'affectedCount','paths',impact->'paths',
      'expiresAt',impact->'resolvedExpiresAt'));
  RETURN impact||jsonb_build_object('roomRevision',p_expected_room_revision+1);
END $$;

CREATE FUNCTION dry_run_room_default_expiry(p_actor_id text,p_room_id text,p_expires_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE room_title text;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at<=statement_timestamp() THEN
    RAISE EXCEPTION 'default expiry must be in the future' USING ERRCODE='22023'; END IF;
  SELECT title INTO room_title FROM room WHERE id=p_room_id;
  RETURN jsonb_build_object('affectedCount',1,'paths',jsonb_build_array(room_title),
    'resolvedExpiresAt',CASE WHEN p_expires_at IS NULL THEN NULL ELSE to_jsonb(p_expires_at) END,
    'confirmation','CHANGE DEFAULT EXPIRY FOR 1 ROOM',
    'message','New grants without an explicit expiry will inherit this exact UTC value.');
END $$;

CREATE FUNCTION apply_room_default_expiry(p_actor_id text,p_room_id text,p_expires_at timestamptz,
  p_expected_room_revision integer,p_confirmation text,p_audit_id text,p_correlation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb;
BEGIN
  impact:=dry_run_room_default_expiry(p_actor_id,p_room_id,p_expires_at);
  IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023'; END IF;
  UPDATE room SET default_grant_expires_at=p_expires_at,revision=revision+1
    WHERE id=p_room_id AND revision=p_expected_room_revision
      AND member_can_mutate_room(p_actor_id,p_room_id,true);
  IF NOT FOUND THEN RAISE EXCEPTION 'stale room revision' USING ERRCODE='40001'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'grant.default_expiry','member',p_actor_id,p_room_id,'room',p_room_id,
    'success','DEFAULT_EXPIRY_CHANGED',p_correlation_id,
    jsonb_build_object('expiresAt',impact->'resolvedExpiresAt'));
  RETURN impact||jsonb_build_object('roomRevision',p_expected_room_revision+1);
END $$;

CREATE FUNCTION resolve_document_download_policy(p_document_id text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE(d.download_policy,r.download_policy,o.installation_download_policy)
  FROM document d JOIN room r ON r.id=d.room_id CROSS JOIN organization o WHERE d.id=p_document_id
$$;
-- Runtime never receives the canonical resolver directly: a guessed opaque
-- document ID must not reveal either existence or policy. The authorizing wrapper
-- returns a row only for a currently preview-authorized viewer. The selected
-- policy remains canonical and viewer-independent.
CREATE FUNCTION read_viewer_document_download_policy(p_viewer_id text,p_session_id text,p_room_id text,p_document_id text)
RETURNS TABLE(policy text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT resolve_document_download_policy(p_document_id)
  WHERE viewer_can_preview_document(p_viewer_id,p_session_id,p_room_id,p_document_id)
$$;

CREATE FUNCTION set_room_download_policy(p_actor_id text,p_room_id text,p_policy text,
  p_expected_room_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  IF p_policy IS NOT NULL AND p_policy NOT IN ('allow','deny') THEN RAISE EXCEPTION 'invalid download policy' USING ERRCODE='22023'; END IF;
  UPDATE room SET download_policy=p_policy,revision=revision+1
    WHERE id=p_room_id AND revision=p_expected_room_revision
      AND member_can_mutate_room(p_actor_id,p_room_id,true)
    RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale or forbidden room policy' USING ERRCODE='40001'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'download.policy','member',p_actor_id,p_room_id,'room',p_room_id,'success','ROOM_DOWNLOAD_POLICY_CHANGED',p_correlation_id,
    jsonb_build_object('policy',p_policy,'roomRevision',next_revision));
  RETURN next_revision;
END $$;
CREATE FUNCTION set_document_download_policy(p_actor_id text,p_document_id text,p_policy text,
  p_expected_document_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; next_revision integer;
BEGIN
  IF p_policy IS NOT NULL AND p_policy NOT IN ('allow','deny') THEN RAISE EXCEPTION 'invalid download policy' USING ERRCODE='22023'; END IF;
  SELECT room_id INTO selected_room FROM document WHERE id=p_document_id;
  IF selected_room IS NULL OR NOT member_can_mutate_room(p_actor_id,selected_room,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  UPDATE document SET download_policy=p_policy,revision=revision+1
    WHERE id=p_document_id AND revision=p_expected_document_revision RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale document policy' USING ERRCODE='40001'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'download.policy','member',p_actor_id,selected_room,'document',p_document_id,'success','DOCUMENT_DOWNLOAD_POLICY_CHANGED',p_correlation_id,
    jsonb_build_object('policy',p_policy,'documentRevision',next_revision));
  RETURN next_revision;
END $$;
CREATE FUNCTION set_installation_download_policy(p_actor_id text,p_policy text,
  p_expected_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  IF p_policy NOT IN ('allow','deny') THEN RAISE EXCEPTION 'invalid download policy' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active' AND global_role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'installation management forbidden' USING ERRCODE='42501'; END IF;
  UPDATE organization SET installation_download_policy=p_policy,policy_revision=policy_revision+1
    WHERE policy_revision=p_expected_revision RETURNING policy_revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale installation policy' USING ERRCODE='40001'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'download.policy','member',p_actor_id,'organization','success','INSTALLATION_DOWNLOAD_POLICY_CHANGED',p_correlation_id,
    jsonb_build_object('policy',p_policy,'policyRevision',next_revision));
  RETURN next_revision;
END $$;

CREATE FUNCTION create_viewer_invitation(
  p_id text,p_viewer_id text,p_membership_id text,p_email_key text,p_email_display text,
  p_room_id text,p_actor_id text,p_expected_room_revision integer,p_job_id text,
  p_audit_id text,p_correlation_id text
) RETURNS TABLE(invitation_id text,viewer_id text,expires_at timestamptz,room_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer; expiry timestamptz:=statement_timestamp()+interval '7 days'; selected_viewer text;
BEGIN
  IF NOT canonical_email_key(p_email_key) OR p_email_display IS NULL
     OR length(p_email_display) NOT BETWEEN 3 AND 320 THEN
    RAISE EXCEPTION 'invalid invitation email' USING ERRCODE='22023';
  END IF;
  UPDATE room SET revision=revision+1
    WHERE id=p_room_id AND revision=p_expected_room_revision
      AND member_can_mutate_room(p_actor_id,p_room_id,true)
    RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'viewer invitation forbidden or stale' USING ERRCODE='42501';
  END IF;
  SELECT v.id INTO selected_viewer FROM viewer v WHERE v.email_key=p_email_key AND v.state='active';
  IF selected_viewer IS NULL THEN
    INSERT INTO viewer(id,email_key,email_display,state,session_family_id)
    VALUES(p_viewer_id,p_email_key,p_email_display,'active',replace(gen_random_uuid()::text,'-',''));
    selected_viewer:=p_viewer_id;
  END IF;
  INSERT INTO viewer_room_membership(id,viewer_id,room_id)
  VALUES(p_membership_id,selected_viewer,p_room_id)
  ON CONFLICT ON CONSTRAINT viewer_room_membership_viewer_id_room_id_key
  DO UPDATE SET state='active',revision=viewer_room_membership.revision+1;
  INSERT INTO invitation(id,kind,email_key,email_display,state,expires_at)
  VALUES(p_id,'viewer',p_email_key,p_email_display,'pending',expiry);
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
  VALUES(p_job_id,'mail.viewer_invitation','viewer-invitation:'||p_id,
    jsonb_build_object('invitationId',p_id,'roomId',p_room_id),statement_timestamp(),5);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'participant.viewer.invite','member',p_actor_id,selected_viewer,p_room_id,'invitation',p_id,
    'success','VIEWER_INVITED',p_correlation_id,jsonb_build_object('expiresAt',expiry));
  RETURN QUERY SELECT p_id,selected_viewer,expiry,next_revision;
END $$;

CREATE FUNCTION read_viewer_invitation_mail(p_invitation_id text,p_room_id text,
  p_job_id text,p_owner text,p_token text)
RETURNS TABLE(email_display text,room_alias text,occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT i.email_display,'ROOM-'||upper(substr(md5(r.id),1,10)),i.created_at
  FROM invitation i JOIN viewer v ON v.email_key=i.email_key
  JOIN viewer_room_membership m ON m.viewer_id=v.id AND m.room_id=p_room_id
  JOIN room r ON r.id=m.room_id JOIN job_queue j ON j.id=p_job_id
  WHERE i.id=p_invitation_id AND i.kind='viewer' AND i.state='pending'
    AND i.expires_at>statement_timestamp() AND j.job_type='mail.viewer_invitation'
    AND j.payload->>'invitationId'=i.id AND j.payload->>'roomId'=r.id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()
$$;

-- Participant setup is manager-only and audited. It grants no content access.
CREATE FUNCTION create_counterparty(p_id text,p_room_id text,p_name text,p_actor_id text,
  p_expected_room_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  UPDATE room SET revision=revision+1 WHERE id=p_room_id AND revision=p_expected_room_revision RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale room revision' USING ERRCODE='40001'; END IF;
  INSERT INTO counterparty(id,room_id,name) VALUES(p_id,p_room_id,p_name);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES(p_audit_id,'participant.counterparty.create','member',p_actor_id,p_room_id,'counterparty',p_id,'success','COUNTERPARTY_CREATED',p_correlation_id);
  RETURN next_revision;
END $$;
CREATE FUNCTION add_viewer_to_room(p_id text,p_viewer_id text,p_room_id text,p_actor_id text,
  p_expected_room_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  UPDATE room SET revision=revision+1 WHERE id=p_room_id AND revision=p_expected_room_revision RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale room revision' USING ERRCODE='40001'; END IF;
  INSERT INTO viewer_room_membership(id,viewer_id,room_id) VALUES(p_id,p_viewer_id,p_room_id);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES(p_audit_id,'participant.viewer.add','member',p_actor_id,p_viewer_id,p_room_id,'viewer',p_viewer_id,'success','VIEWER_ADDED',p_correlation_id);
  RETURN next_revision;
END $$;
CREATE FUNCTION assign_viewer_counterparty(p_id text,p_counterparty_id text,p_viewer_id text,p_room_id text,
  p_actor_id text,p_expected_room_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  UPDATE room SET revision=revision+1 WHERE id=p_room_id AND revision=p_expected_room_revision RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale room revision' USING ERRCODE='40001'; END IF;
  INSERT INTO counterparty_viewer(id,counterparty_id,room_id,viewer_id) VALUES(p_id,p_counterparty_id,p_room_id,p_viewer_id);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES(p_audit_id,'participant.counterparty.assign','member',p_actor_id,p_viewer_id,p_room_id,'counterparty',p_counterparty_id,'success','COUNTERPARTY_ASSIGNED',p_correlation_id);
  RETURN next_revision;
END $$;

-- Trash removes active grants to the root and every descendant. Restore changes
-- only working structure; it has no code path capable of reactivating these rows.
CREATE FUNCTION revoke_grants_for_trash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE revoked_count integer;
BEGIN
  WITH RECURSIVE entries AS (
    SELECT e.folder_id,e.document_id FROM working_structure_entry e WHERE e.id=NEW.root_entry_id
    UNION ALL
    SELECT e.folder_id,e.document_id FROM entries p JOIN working_structure_entry e ON e.parent_folder_id=p.folder_id
  ), revoked AS (
    UPDATE access_grant g SET state='revoked',revoked_at=transaction_timestamp(),revision=revision+1
    WHERE g.state='active' AND g.room_id=NEW.room_id AND
      ((g.folder_id IS NOT NULL AND g.folder_id IN (SELECT folder_id FROM entries)) OR
       (g.document_id IS NOT NULL AND g.document_id IN (SELECT document_id FROM entries)))
    RETURNING g.id
  ) SELECT count(*)::integer INTO revoked_count FROM revoked;
  IF revoked_count>0 THEN
    INSERT INTO audit_event(id,event_type,actor_kind,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
    VALUES(replace(gen_random_uuid()::text,'-',''),'grant.revoke','system',NEW.room_id,'trash',NEW.id,
      'success','TRASH_GRANTS_REVOKED','corr_'||replace(gen_random_uuid()::text,'-',''),
      jsonb_build_object('affectedCount',revoked_count));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trash_revokes_content_grants AFTER INSERT ON room_trash
FOR EACH ROW EXECUTE FUNCTION revoke_grants_for_trash();

REVOKE ALL ON invitation FROM duefold_runtime,duefold_worker;
-- Invitation creation is confined to the audited manager function. Only the
-- isolated authenticator may discover and consume invitation evidence.
GRANT SELECT ON invitation TO duefold_authenticator;
GRANT UPDATE(state) ON invitation TO duefold_authenticator;
REVOKE ALL ON counterparty,viewer_room_membership,counterparty_viewer,access_grant
  FROM PUBLIC,duefold_runtime,duefold_worker;
REVOKE ALL ON FUNCTION enforce_access_grant_integrity(),effective_access_grants(text,text),
 viewer_can_preview_document(text,text,text,text),authorize_viewer_published_room(text,text,text),
 read_viewer_published_structure(text,text,text),read_viewer_published_search(text,text,text,text,integer),
 read_effective_permission_preview(text,text,text),grant_target_impact(text,text,text,text),
 dry_run_grant_change(text,text,text,text,text,text,text,text,text,text,timestamptz),
 apply_grant_change(text,text,text,text,text,text,text,text,text,text,timestamptz,integer,timestamptz,text,text,text),
 dry_run_room_default_expiry(text,text,timestamptz),
 apply_room_default_expiry(text,text,timestamptz,integer,text,text,text),
 resolve_document_download_policy(text),read_viewer_document_download_policy(text,text,text,text),
 set_room_download_policy(text,text,text,integer,text,text),set_document_download_policy(text,text,text,integer,text,text),
 set_installation_download_policy(text,text,integer,text,text),
 create_viewer_invitation(text,text,text,text,text,text,text,integer,text,text,text),create_counterparty(text,text,text,text,integer,text,text),
 add_viewer_to_room(text,text,text,text,integer,text,text),
 assign_viewer_counterparty(text,text,text,text,text,integer,text,text),revoke_grants_for_trash()
 FROM PUBLIC,duefold_runtime,duefold_worker;
GRANT EXECUTE ON FUNCTION viewer_can_preview_document(text,text,text,text),
 authorize_viewer_published_room(text,text,text),read_viewer_published_structure(text,text,text),
 read_viewer_published_search(text,text,text,text,integer),read_effective_permission_preview(text,text,text),
 dry_run_grant_change(text,text,text,text,text,text,text,text,text,text,timestamptz),
 apply_grant_change(text,text,text,text,text,text,text,text,text,text,timestamptz,integer,timestamptz,text,text,text),
 dry_run_room_default_expiry(text,text,timestamptz),
 apply_room_default_expiry(text,text,timestamptz,integer,text,text,text),
 read_viewer_document_download_policy(text,text,text,text),
 set_room_download_policy(text,text,text,integer,text,text),set_document_download_policy(text,text,text,integer,text,text),
 set_installation_download_policy(text,text,integer,text,text),
 create_viewer_invitation(text,text,text,text,text,text,text,integer,text,text,text),create_counterparty(text,text,text,text,integer,text,text),
 add_viewer_to_room(text,text,text,text,integer,text,text),
 assign_viewer_counterparty(text,text,text,text,text,integer,text,text)
 TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_viewer_invitation_mail(text,text,text,text,text) TO duefold_worker;

ALTER TABLE counterparty OWNER TO duefold_migration;
ALTER TABLE viewer_room_membership OWNER TO duefold_migration;
ALTER TABLE counterparty_viewer OWNER TO duefold_migration;
ALTER TABLE access_grant OWNER TO duefold_migration;
ALTER FUNCTION protect_installation_download_policy() OWNER TO duefold_migration;
ALTER FUNCTION enforce_access_grant_integrity() OWNER TO duefold_migration;
ALTER FUNCTION effective_access_grants(text,text) OWNER TO duefold_migration;
ALTER FUNCTION viewer_can_preview_document(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION authorize_viewer_published_room(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_viewer_published_structure(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_viewer_published_search(text,text,text,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION read_effective_permission_preview(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION grant_target_impact(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_grant_change(text,text,text,text,text,text,text,text,text,text,timestamptz) OWNER TO duefold_migration;
ALTER FUNCTION apply_grant_change(text,text,text,text,text,text,text,text,text,text,timestamptz,integer,timestamptz,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_room_default_expiry(text,text,timestamptz) OWNER TO duefold_migration;
ALTER FUNCTION apply_room_default_expiry(text,text,timestamptz,integer,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION resolve_document_download_policy(text) OWNER TO duefold_migration;
ALTER FUNCTION read_viewer_document_download_policy(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION set_room_download_policy(text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION set_document_download_policy(text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION set_installation_download_policy(text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION create_viewer_invitation(text,text,text,text,text,text,text,integer,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_viewer_invitation_mail(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION create_counterparty(text,text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION add_viewer_to_room(text,text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION assign_viewer_counterparty(text,text,text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION revoke_grants_for_trash() OWNER TO duefold_migration;
