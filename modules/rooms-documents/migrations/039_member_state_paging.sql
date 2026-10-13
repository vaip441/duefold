-- Processing and export state, paged to completion instead of stopping at the first page.
--
-- Both readers returned one keyset page with no way to tell a full page from the last one,
-- and the web process rebuilt the cursor from a JavaScript Date. A Date keeps milliseconds
-- while `created_at` keeps microseconds, so a cursor built from it resumes at the wrong
-- position and skips or repeats rows created within the same millisecond. Each row now
-- carries its exact `created_at` for the cursor as UTC ISO 8601 text with all six fractional
-- digits, built with to_char at UTC so it does not depend on the session's DateStyle or
-- TimeZone. `continues` states whether a further page exists, proved by one probe row past
-- the limit rather than inferred from a full page.

DROP FUNCTION read_member_processing_state(text,text,timestamptz,text,integer);
CREATE FUNCTION read_member_processing_state(
  p_actor_id text,p_room_id text,p_after_created_at timestamptz,p_after_version_id text,p_limit integer
) RETURNS TABLE(document_id text,version_id text,display_title text,state text,failure_kind text,
  failure_code text,manual_retry_count smallint,retained_until timestamptz,created_at timestamptz,
  cursor_created_at text,continues boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid processing page size' USING ERRCODE='22023';
  END IF;
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,false) THEN
    RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT d.id AS document_id,v.id AS version_id,d.display_title,v.state,v.failure_kind,
      v.failure_code,v.manual_retry_count,v.retained_until,v.created_at,
      row_number() OVER (ORDER BY v.created_at DESC,v.id DESC) AS ordinal
    FROM document d JOIN document_version v ON v.document_id=d.id
    WHERE d.room_id=p_room_id AND
      (p_after_created_at IS NULL OR (v.created_at,v.id)<(p_after_created_at,p_after_version_id))
    ORDER BY v.created_at DESC,v.id DESC LIMIT p_limit+1
  )
  SELECT c.document_id,c.version_id,c.display_title,c.state,c.failure_kind,c.failure_code,
    c.manual_retry_count,c.retained_until,c.created_at,
    to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    (SELECT count(*) FROM candidates)>p_limit
  FROM candidates c WHERE c.ordinal<=p_limit ORDER BY c.ordinal;
END $$;

DROP FUNCTION read_member_exports(text,text,timestamptz,text,integer);
CREATE FUNCTION read_member_exports(
  p_actor_id text,p_room_id text,p_after_created_at timestamptz,p_after_export_id text,p_limit integer
) RETURNS TABLE(export_id text,preset text,include_originals boolean,state text,size_bytes bigint,
  created_at timestamptz,expires_at timestamptz,consumed_at timestamptz,deleted_at timestamptz,
  cursor_created_at text,continues boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid export page size' USING ERRCODE='22023';
  END IF;
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'export listing forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT e.id AS export_id,e.preset,e.include_originals,e.state,e.size_bytes,e.created_at,
      e.expires_at,e.consumed_at,e.deleted_at,
      row_number() OVER (ORDER BY e.created_at DESC,e.id DESC) AS ordinal
    FROM export_request e
    WHERE e.room_id=p_room_id AND e.created_by=p_actor_id AND
      (p_after_created_at IS NULL OR (e.created_at,e.id)<(p_after_created_at,p_after_export_id))
    ORDER BY e.created_at DESC,e.id DESC LIMIT p_limit+1
  )
  SELECT c.export_id,c.preset,c.include_originals,c.state,c.size_bytes,c.created_at,
    c.expires_at,c.consumed_at,c.deleted_at,
    to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    (SELECT count(*) FROM candidates)>p_limit
  FROM candidates c WHERE c.ordinal<=p_limit ORDER BY c.ordinal;
END $$;

REVOKE ALL ON FUNCTION read_member_processing_state(text,text,timestamptz,text,integer),
 read_member_exports(text,text,timestamptz,text,integer)
 FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
GRANT EXECUTE ON FUNCTION read_member_processing_state(text,text,timestamptz,text,integer),
 read_member_exports(text,text,timestamptz,text,integer) TO duefold_runtime;
ALTER FUNCTION read_member_processing_state(text,text,timestamptz,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION read_member_exports(text,text,timestamptz,text,integer) OWNER TO duefold_migration;
