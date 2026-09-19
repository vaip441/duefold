-- Optional constrained branding: quarantined uploads and worker-sanitized raster output.
CREATE TABLE branding_upload_intent (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  asset_kind text NOT NULL CHECK (asset_kind IN ('logo','square-mark')),
  created_by text NOT NULL REFERENCES member(id),
  declared_media_type text NOT NULL CHECK (declared_media_type IN ('image/png','image/jpeg','image/webp')),
  declared_size bigint NOT NULL CHECK (declared_size BETWEEN 1 AND 262144000),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^quarantine/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$'),
  upload_id text NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 1024),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','processing','ready','failed')),
  expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '24 hours',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE branding_asset (
  asset_kind text PRIMARY KEY CHECK (asset_kind IN ('logo','square-mark')),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^branding/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}\.png$'),
  media_type text NOT NULL CHECK (media_type='image/png'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 268435456),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 32768),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 32768),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE FUNCTION create_branding_upload_intent(p_id text,p_actor_id text,p_asset_kind text,
  p_media_type text,p_size bigint,p_object_key text,p_upload_id text,p_audit_id text,p_correlation_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active' AND global_role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'branding forbidden' USING ERRCODE='42501';
  END IF;
  INSERT INTO branding_upload_intent(id,asset_kind,created_by,declared_media_type,declared_size,object_key,upload_id)
  VALUES(p_id,p_asset_kind,p_actor_id,p_media_type,p_size,p_object_key,p_upload_id);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES(p_audit_id,'branding.upload','member',p_actor_id,'branding_upload',p_id,'success','BRANDING_UPLOAD_CREATED',p_correlation_id);
  RETURN true;
END $$;
CREATE FUNCTION read_branding_upload_completion(p_id text,p_actor_id text,p_upload_id text)
RETURNS TABLE(object_key text,declared_size bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT b.object_key,b.declared_size FROM branding_upload_intent b
  WHERE b.id=p_id AND b.created_by=p_actor_id AND b.upload_id=p_upload_id
    AND b.state='open' AND b.expires_at>statement_timestamp()
$$;
CREATE FUNCTION finalize_branding_upload(p_id text,p_actor_id text,p_size bigint,p_job_id text,
  p_audit_id text,p_correlation_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE branding_upload_intent SET state='processing' WHERE id=p_id AND created_by=p_actor_id
    AND state='open' AND expires_at>statement_timestamp() AND declared_size=p_size;
  IF NOT FOUND THEN RAISE EXCEPTION 'branding upload cannot finalize' USING ERRCODE='55000'; END IF;
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
  VALUES(p_job_id,'branding.image.process','branding-process:'||p_id,jsonb_build_object('intentId',p_id),statement_timestamp(),5);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES(p_audit_id,'branding.upload','member',p_actor_id,'branding_upload',p_id,'success','BRANDING_UPLOAD_FINALIZED',p_correlation_id);
  RETURN true;
END $$;
CREATE FUNCTION claim_branding_processing(p_intent_id text,p_job_id text,p_owner text,p_token text)
RETURNS TABLE(object_key text,declared_media_type text,asset_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT b.object_key,b.declared_media_type,b.asset_kind FROM branding_upload_intent b JOIN job_queue j ON j.id=p_job_id
  WHERE b.id=p_intent_id AND b.state='processing' AND j.job_type='branding.image.process'
    AND j.payload->>'intentId'=b.id AND j.state='running' AND j.lease_owner=p_owner
    AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp()
$$;
CREATE FUNCTION complete_branding_processing(p_intent_id text,p_job_id text,p_owner text,p_token text,
  p_object_key text,p_size bigint,p_width integer,p_height integer,p_audit_id text,p_correlation_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE kind text;
BEGIN
  SELECT b.asset_kind INTO kind FROM branding_upload_intent b JOIN job_queue j ON j.id=p_job_id
  WHERE b.id=p_intent_id AND b.state='processing' AND j.job_type='branding.image.process'
    AND j.payload->>'intentId'=b.id AND j.state='running' AND j.lease_owner=p_owner
    AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp() FOR UPDATE OF b,j;
  IF kind IS NULL THEN RAISE EXCEPTION 'branding lease lost' USING ERRCODE='55000'; END IF;
  INSERT INTO branding_asset(asset_kind,object_key,media_type,size_bytes,width,height)
  VALUES(kind,p_object_key,'image/png',p_size,p_width,p_height)
  ON CONFLICT(asset_kind) DO UPDATE SET object_key=EXCLUDED.object_key,size_bytes=EXCLUDED.size_bytes,
    width=EXCLUDED.width,height=EXCLUDED.height,updated_at=statement_timestamp();
  UPDATE branding_upload_intent SET state='ready' WHERE id=p_intent_id;
  INSERT INTO audit_event(id,event_type,actor_kind,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES(p_audit_id,'branding.process','system','branding_asset',kind,'success','BRANDING_ASSET_READY',p_correlation_id);
  RETURN true;
END $$;
ALTER TABLE branding_upload_intent OWNER TO duefold_migration;
ALTER TABLE branding_asset OWNER TO duefold_migration;
REVOKE ALL ON branding_upload_intent,branding_asset FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
REVOKE ALL ON FUNCTION create_branding_upload_intent(text,text,text,text,bigint,text,text,text,text),read_branding_upload_completion(text,text,text),finalize_branding_upload(text,text,bigint,text,text,text),claim_branding_processing(text,text,text,text),complete_branding_processing(text,text,text,text,text,bigint,integer,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_branding_upload_intent(text,text,text,text,bigint,text,text,text,text),read_branding_upload_completion(text,text,text),finalize_branding_upload(text,text,bigint,text,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION claim_branding_processing(text,text,text,text),complete_branding_processing(text,text,text,text,text,bigint,integer,integer,text,text) TO duefold_worker;
ALTER FUNCTION create_branding_upload_intent(text,text,text,text,bigint,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_branding_upload_completion(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_branding_upload(text,text,bigint,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION claim_branding_processing(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION complete_branding_processing(text,text,text,text,text,bigint,integer,integer,text,text) OWNER TO duefold_migration;
