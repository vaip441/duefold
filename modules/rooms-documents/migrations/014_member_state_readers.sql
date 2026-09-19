-- Bounded member-facing processing and export state projections.
-- Original filenames, object keys, hashes, and content remain outside the web role.

CREATE FUNCTION read_member_processing_state(
  p_actor_id text,p_room_id text,p_after_created_at timestamptz,p_after_version_id text,p_limit integer
) RETURNS TABLE(document_id text,version_id text,display_title text,state text,failure_kind text,
  failure_code text,manual_retry_count smallint,retained_until timestamptz,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid processing page size' USING ERRCODE='22023';
  END IF;
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,false) THEN
    RAISE EXCEPTION 'room contribution forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT d.id,v.id,d.display_title,v.state,v.failure_kind,v.failure_code,
    v.manual_retry_count,v.retained_until,v.created_at
  FROM document d JOIN document_version v ON v.document_id=d.id
  WHERE d.room_id=p_room_id AND
    (p_after_created_at IS NULL OR (v.created_at,v.id)<(p_after_created_at,p_after_version_id))
  ORDER BY v.created_at DESC,v.id DESC LIMIT p_limit;
END $$;

CREATE FUNCTION read_member_exports(
  p_actor_id text,p_room_id text,p_after_created_at timestamptz,p_after_export_id text,p_limit integer
) RETURNS TABLE(export_id text,preset text,include_originals boolean,state text,size_bytes bigint,
  created_at timestamptz,expires_at timestamptz,consumed_at timestamptz,deleted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid export page size' USING ERRCODE='22023';
  END IF;
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'export listing forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT e.id,e.preset,e.include_originals,e.state,e.size_bytes,e.created_at,e.expires_at,
    e.consumed_at,e.deleted_at
  FROM export_request e
  WHERE e.room_id=p_room_id AND e.created_by=p_actor_id AND
    (p_after_created_at IS NULL OR (e.created_at,e.id)<(p_after_created_at,p_after_export_id))
  ORDER BY e.created_at DESC,e.id DESC LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION read_member_processing_state(text,text,timestamptz,text,integer),
 read_member_exports(text,text,timestamptz,text,integer)
 FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
GRANT EXECUTE ON FUNCTION read_member_processing_state(text,text,timestamptz,text,integer),
 read_member_exports(text,text,timestamptz,text,integer) TO duefold_runtime;
ALTER FUNCTION read_member_processing_state(text,text,timestamptz,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION read_member_exports(text,text,timestamptz,text,integer) OWNER TO duefold_migration;
