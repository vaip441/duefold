-- Preserve checksum-bound multipart plans for branding uploads and expose only
-- the owning administrator's bounded processing state to the browser.
ALTER TABLE branding_upload_intent
  ADD COLUMN part_plan jsonb
  CHECK (
    part_plan IS NULL OR (
      jsonb_typeof(part_plan)='array' AND jsonb_array_length(part_plan) BETWEEN 1 AND 50
    )
  );

DROP FUNCTION create_branding_upload_intent(text,text,text,text,bigint,text,text,text,text);
CREATE FUNCTION create_branding_upload_intent(
  p_id text,p_actor_id text,p_asset_kind text,p_media_type text,p_size bigint,
  p_object_key text,p_upload_id text,p_audit_id text,p_correlation_id text,p_part_plan jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM member
    WHERE id=p_actor_id AND state='active' AND global_role IN ('owner','admin')
  ) THEN
    RAISE EXCEPTION 'branding forbidden' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_part_plan)<>'array' OR jsonb_array_length(p_part_plan) NOT BETWEEN 1 AND 50
    OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_part_plan) part
      WHERE jsonb_typeof(part)<>'object'
        OR (part->>'partNumber') IS NULL OR (part->>'size') IS NULL
        OR (part->>'checksumSha256') !~ '^[A-Za-z0-9+/]{43}=$'
    ) THEN
    RAISE EXCEPTION 'invalid branding part plan' USING ERRCODE='22023';
  END IF;
  INSERT INTO branding_upload_intent(
    id,asset_kind,created_by,declared_media_type,declared_size,object_key,upload_id,part_plan
  ) VALUES(
    p_id,p_asset_kind,p_actor_id,p_media_type,p_size,p_object_key,p_upload_id,p_part_plan
  );
  INSERT INTO audit_event(
    id,event_type,actor_kind,actor_id,resource_type,resource_id,result,reason_code,correlation_id
  ) VALUES(
    p_audit_id,'branding.upload','member',p_actor_id,'branding_upload',p_id,
    'success','BRANDING_UPLOAD_CREATED',p_correlation_id
  );
  RETURN true;
END $$;

DROP FUNCTION read_branding_upload_completion(text,text,text);
CREATE FUNCTION read_branding_upload_completion(p_id text,p_actor_id text,p_upload_id text)
RETURNS TABLE(object_key text,declared_size bigint,declared_media_type text,part_plan jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT b.object_key,b.declared_size,b.declared_media_type,b.part_plan
  FROM branding_upload_intent b
  JOIN member m ON m.id=p_actor_id AND m.state='active' AND m.global_role IN ('owner','admin')
  WHERE b.id=p_id AND b.created_by=p_actor_id AND b.upload_id=p_upload_id
    AND b.state='open' AND b.expires_at>statement_timestamp()
$$;

CREATE FUNCTION read_branding_upload_state(p_id text,p_actor_id text)
RETURNS TABLE(state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE
    WHEN b.state='ready' THEN 'ready'
    WHEN b.state='failed' OR j.state='failed' THEN 'failed'
    ELSE 'processing'
  END
  FROM branding_upload_intent b
  JOIN member m ON m.id=p_actor_id AND m.state='active' AND m.global_role IN ('owner','admin')
  LEFT JOIN job_queue j ON j.job_type='branding.image.process'
    AND j.payload->>'intentId'=b.id
  WHERE b.id=p_id AND b.created_by=p_actor_id AND b.state IN ('processing','ready','failed')
$$;

REVOKE ALL ON FUNCTION
  create_branding_upload_intent(text,text,text,text,bigint,text,text,text,text,jsonb),
  read_branding_upload_completion(text,text,text),read_branding_upload_state(text,text)
FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
GRANT EXECUTE ON FUNCTION
  create_branding_upload_intent(text,text,text,text,bigint,text,text,text,text,jsonb),
  read_branding_upload_completion(text,text,text),read_branding_upload_state(text,text)
TO duefold_runtime;
ALTER FUNCTION create_branding_upload_intent(text,text,text,text,bigint,text,text,text,text,jsonb)
  OWNER TO duefold_migration;
ALTER FUNCTION read_branding_upload_completion(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_branding_upload_state(text,text) OWNER TO duefold_migration;
