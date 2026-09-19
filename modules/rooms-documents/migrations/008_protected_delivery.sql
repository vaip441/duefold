-- Protected page delivery, download leases, preview evidence.
-- Protected tables have no runtime table privileges. Narrow SECURITY DEFINER
-- functions bind every read to a live viewer session and effective grant.

CREATE TABLE watermark_cache (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  viewer_id text NOT NULL REFERENCES viewer(id),
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version_id text NOT NULL REFERENCES document_version(id),
  derivative_id text NOT NULL REFERENCES document_derivative(id),
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 10000),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^watermarks/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$'),
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/webp')),
  state text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating','active','deletion_pending','deleted')),
  access_date date NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE INDEX live_watermark_cache ON watermark_cache(viewer_id,session_id,room_id,document_id)
  WHERE state IN ('creating','active');
COMMENT ON TABLE watermark_cache IS 'Private provider-encrypted, per-viewer/per-session watermarked page cache metadata.';

CREATE TABLE preview_activity (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  viewer_id text NOT NULL REFERENCES viewer(id),
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version_id text NOT NULL REFERENCES document_version(id),
  correlation_id text NOT NULL CHECK (correlation_id ~ '^corr_[A-Za-z0-9_-]{32}$'),
  network_period char(7) NOT NULL CHECK (network_period ~ '^[0-9]{4}-[0-9]{2}$'),
  network_hmac char(64) NOT NULL CHECK (network_hmac ~ '^[a-f0-9]{64}$'),
  browser_category text NOT NULL CHECK (browser_category IN ('chromium','firefox','safari','other')),
  os_category text NOT NULL CHECK (os_category IN ('windows','macos','linux','ios','android','other')),
  device_category text NOT NULL CHECK (device_category IN ('desktop','mobile','tablet','other')),
  page_ranges int4multirange NOT NULL DEFAULT '{}'::int4multirange,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','closed','inactive')),
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  summarized_at timestamptz,
  UNIQUE(viewer_id,session_id,version_id),
  CHECK ((state='active' AND summarized_at IS NULL) OR (state<>'active' AND summarized_at IS NOT NULL))
);
COMMENT ON TABLE preview_activity IS 'Mutable preview session state only; contains no dwell, completion, score, ranking, or proof-of-reading metric.';

CREATE TABLE preview_delivery_telemetry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activity_id text NOT NULL REFERENCES preview_activity(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 10000),
  delivered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '24 hours',
  CHECK (expires_at <= delivered_at + interval '24 hours')
);
CREATE INDEX preview_telemetry_expiry ON preview_delivery_telemetry(expires_at);
COMMENT ON TABLE preview_delivery_telemetry IS 'Short-lived operations data, deliberately separate from immutable audit evidence.';

CREATE TABLE download_lease (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  viewer_id text NOT NULL REFERENCES viewer(id),
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version_id text NOT NULL REFERENCES document_version(id),
  correlation_id text NOT NULL CHECK (correlation_id ~ '^corr_[A-Za-z0-9_-]{32}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144000),
  bytes_served bigint NOT NULL DEFAULT 0 CHECK (bytes_served >= 0),
  served_ranges int8multirange NOT NULL DEFAULT '{}'::int8multirange,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','failed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  summarized_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK ((state='active' AND summarized_at IS NULL) OR (state<>'active' AND summarized_at IS NOT NULL))
);
COMMENT ON TABLE download_lease IS 'Server-side original download lease. No object key or URL is exposed through its public result.';

CREATE FUNCTION enqueue_watermark_deletion(p_cache watermark_cache) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p_job_id text:=replace(gen_random_uuid()::text,'-','');
BEGIN
  UPDATE watermark_cache SET state='deletion_pending'
    WHERE id=p_cache.id AND state IN ('creating','active');
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
  VALUES(p_job_id,'document.watermark.delete','watermark-delete:'||p_cache.id,
    jsonb_build_object('cacheId',p_cache.id),statement_timestamp())
  ON CONFLICT(idempotency_key) DO UPDATE SET
    available_at=LEAST(job_queue.available_at,EXCLUDED.available_at);
END $$;

CREATE FUNCTION resolve_presented_viewer(p_session_digest text)
RETURNS TABLE(viewer_id text,session_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.viewer_id,s.id
  FROM session s JOIN viewer v ON v.id=s.viewer_id AND v.state='active'
  WHERE s.secret_digest=p_session_digest AND s.principal_kind='viewer'
    AND s.state='active' AND s.idle_expires_at>statement_timestamp()
    AND s.absolute_expires_at>statement_timestamp()
$$;

CREATE FUNCTION begin_watermark_cache(
  p_cache_id text,p_session_digest text,p_room_id text,p_document_id text,
  p_page_number integer,p_object_key text
) RETURNS TABLE(cache_id text,version_id text,source_object_key text,media_type text,
  width integer,height integer,accessible_label text,text_layer jsonb,viewer_email text,
  room_name text,access_date date,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected record; identity record; expiry timestamptz:=statement_timestamp()+interval '24 hours'; day date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN; END IF;
  IF p_page_number NOT BETWEEN 1 AND 10000 OR p_object_key !~ '^watermarks/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$' THEN
    RAISE EXCEPTION 'invalid protected page request' USING ERRCODE='22023';
  END IF;
  SELECT p.published_version_id,d.id derivative_id,d.object_key,d.media_type,d.width,d.height,
    d.accessible_label,d.text_layer,v.email_display,r.title
  INTO selected
  FROM published_structure_entry p
  JOIN document_derivative d ON d.version_id=p.published_version_id AND d.page_number=p_page_number
  JOIN viewer v ON v.id=identity.viewer_id
  JOIN room r ON r.id=p.room_id
  WHERE p.room_id=p_room_id AND p.resource_kind='document' AND p.resource_id=p_document_id
    AND viewer_can_preview_document(identity.viewer_id,identity.session_id,p_room_id,p_document_id);
  IF selected.derivative_id IS NULL THEN RETURN; END IF;
  INSERT INTO watermark_cache(id,viewer_id,session_id,room_id,document_id,version_id,
    derivative_id,page_number,object_key,media_type,access_date,expires_at)
  VALUES(p_cache_id,identity.viewer_id,identity.session_id,p_room_id,p_document_id,selected.published_version_id,
    selected.derivative_id,p_page_number,p_object_key,selected.media_type,day,expiry);
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
  VALUES(replace(gen_random_uuid()::text,'-',''),'document.watermark.delete',
    'watermark-delete:'||p_cache_id,jsonb_build_object('cacheId',p_cache_id),expiry);
  RETURN QUERY SELECT p_cache_id,selected.published_version_id,selected.object_key,selected.media_type,
    selected.width,selected.height,selected.accessible_label,selected.text_layer,
    selected.email_display,selected.title,day,expiry;
END $$;

CREATE FUNCTION finish_watermark_cache(p_cache_id text,p_session_digest text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE; identity record;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO selected FROM watermark_cache c WHERE c.id=p_cache_id
    AND c.viewer_id=identity.viewer_id AND c.session_id=identity.session_id FOR UPDATE;
  IF selected.id IS NULL THEN RETURN false; END IF;
  IF selected.state='creating' AND selected.expires_at>statement_timestamp()
     AND viewer_can_preview_document(identity.viewer_id,identity.session_id,selected.room_id,selected.document_id) THEN
    UPDATE watermark_cache SET state='active' WHERE id=p_cache_id;
    RETURN true;
  END IF;
  PERFORM enqueue_watermark_deletion(selected);
  RETURN false;
END $$;

CREATE FUNCTION authorize_watermark_delivery(p_cache_id text,p_session_digest text,p_activity_id text)
RETURNS TABLE(object_key text,media_type text,activity_version_id text,room_id text,document_id text,page_number integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE; activity preview_activity%ROWTYPE; identity record;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN; END IF;
  SELECT * INTO selected FROM watermark_cache c WHERE c.id=p_cache_id
    AND c.viewer_id=identity.viewer_id AND c.session_id=identity.session_id FOR UPDATE;
  IF selected.id IS NULL THEN RETURN; END IF;
  IF selected.state='active' AND selected.expires_at>statement_timestamp()
     AND viewer_can_preview_document(identity.viewer_id,identity.session_id,selected.room_id,selected.document_id) THEN
    SELECT * INTO activity FROM preview_activity a WHERE a.id=p_activity_id
      AND a.viewer_id=identity.viewer_id AND a.session_id=identity.session_id
      AND a.room_id=selected.room_id AND a.document_id=selected.document_id
      AND a.version_id=selected.version_id AND a.state='active' FOR UPDATE;
    IF activity.id IS NULL THEN RETURN; END IF;
    UPDATE preview_activity SET page_ranges=page_ranges+int4multirange(int4range(selected.page_number,selected.page_number+1,'[)'))
      WHERE id=activity.id;
    INSERT INTO preview_delivery_telemetry(activity_id,page_number) VALUES(activity.id,selected.page_number);
    RETURN QUERY SELECT selected.object_key,selected.media_type,selected.version_id,
      selected.room_id,selected.document_id,selected.page_number;
    RETURN;
  END IF;
  PERFORM enqueue_watermark_deletion(selected);
END $$;

CREATE FUNCTION read_protected_text_layer(p_session_digest text,p_room_id text,
  p_document_id text,p_page_number integer)
RETURNS TABLE(version_id text,accessible_label text,text_layer jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p.published_version_id,d.accessible_label,d.text_layer
  FROM resolve_presented_viewer(p_session_digest) i
  JOIN published_structure_entry p ON p.room_id=p_room_id AND p.resource_kind='document'
    AND p.resource_id=p_document_id
  JOIN document_derivative d ON d.version_id=p.published_version_id AND d.page_number=p_page_number
  WHERE viewer_can_preview_document(i.viewer_id,i.session_id,p_room_id,p_document_id)
$$;

CREATE FUNCTION begin_preview_activity(p_id text,p_session_digest text,p_room_id text,
  p_document_id text,p_version_id text,p_correlation_id text,p_network_period text,p_network_hmac text,
  p_browser text,p_os text,p_device text,p_audit_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE activity text; identity record;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL
     OR NOT viewer_can_preview_document(identity.viewer_id,identity.session_id,p_room_id,p_document_id)
     OR NOT EXISTS(SELECT 1 FROM published_structure_entry p WHERE p.room_id=p_room_id
       AND p.resource_kind='document' AND p.resource_id=p_document_id AND p.published_version_id=p_version_id) THEN
    RETURN NULL;
  END IF;
  SELECT id INTO activity FROM preview_activity WHERE viewer_id=identity.viewer_id
    AND session_id=identity.session_id AND version_id=p_version_id AND state='active';
  IF activity IS NOT NULL THEN RETURN activity; END IF;
  /*
   * A summarized activity must not be handed back unchanged: delivery requires
   * state='active', so reusing a closed row made every reopened document fail.
   * This table is mutable session state (see the table comment); the immutable
   * record is the preview.start audit event, which is limited to exactly
   * ONE of those per viewer/session/version. So reopening reactivates the same
   * row and deliberately does NOT write a second start event, and the UNIQUE
   * (viewer_id,session_id,version_id) constraint keeps a duplicate impossible.
   */
  UPDATE preview_activity SET state='active',summarized_at=NULL,
    heartbeat_at=statement_timestamp()
  WHERE viewer_id=identity.viewer_id AND session_id=identity.session_id
    AND version_id=p_version_id
  RETURNING id INTO activity;
  IF activity IS NOT NULL THEN RETURN activity; END IF;
  INSERT INTO preview_activity(id,viewer_id,session_id,room_id,document_id,version_id,correlation_id,
    network_period,network_hmac,browser_category,os_category,device_category)
  VALUES(p_id,identity.viewer_id,identity.session_id,p_room_id,p_document_id,p_version_id,p_correlation_id,
    p_network_period,p_network_hmac,p_browser,p_os,p_device);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
    resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'preview.start','viewer',identity.viewer_id,identity.session_id,p_room_id,'document_version',
    p_version_id,'success','PREVIEW_STARTED',p_correlation_id,'{}'::jsonb);
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
  VALUES(replace(gen_random_uuid()::text,'-',''),'preview.inactivity.finalize','preview-inactivity:'||p_id||':initial',
    jsonb_build_object('activityId',p_id),statement_timestamp()+interval '2 minutes');
  RETURN p_id;
END $$;

CREATE FUNCTION record_preview_page(p_activity_id text,p_viewer_id text,p_session_id text,p_page integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected preview_activity%ROWTYPE;
BEGIN
  SELECT * INTO selected FROM preview_activity WHERE id=p_activity_id AND viewer_id=p_viewer_id
    AND session_id=p_session_id AND state='active' FOR UPDATE;
  IF selected.id IS NULL OR p_page NOT BETWEEN 1 AND 10000
     OR NOT viewer_can_preview_document(p_viewer_id,p_session_id,selected.room_id,selected.document_id) THEN
    RETURN false;
  END IF;
  UPDATE preview_activity SET page_ranges=page_ranges+int4multirange(int4range(p_page,p_page+1,'[)'))
    WHERE id=p_activity_id;
  INSERT INTO preview_delivery_telemetry(activity_id,page_number) VALUES(p_activity_id,p_page);
  RETURN true;
END $$;

CREATE FUNCTION heartbeat_preview(p_activity_id text,p_session_digest text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected preview_activity%ROWTYPE; identity record;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO selected FROM preview_activity WHERE id=p_activity_id AND viewer_id=identity.viewer_id
    AND session_id=identity.session_id AND state='active' FOR UPDATE;
  IF selected.id IS NULL OR NOT viewer_can_preview_document(identity.viewer_id,identity.session_id,selected.room_id,selected.document_id) THEN
    RETURN false;
  END IF;
  IF selected.heartbeat_at>statement_timestamp()-interval '50 seconds' THEN RETURN false; END IF;
  UPDATE preview_activity SET heartbeat_at=statement_timestamp() WHERE id=p_activity_id;
  RETURN true;
END $$;

CREATE FUNCTION summarize_preview(p_activity_id text,p_session_digest text,p_status text,p_audit_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected preview_activity%ROWTYPE; identity record;
BEGIN
  IF p_status NOT IN ('closed','inactive') THEN RAISE EXCEPTION 'invalid preview status' USING ERRCODE='22023'; END IF;
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO selected FROM preview_activity WHERE id=p_activity_id AND viewer_id=identity.viewer_id
    AND session_id=identity.session_id FOR UPDATE;
  IF selected.id IS NULL OR selected.state<>'active' THEN RETURN false; END IF;
  IF p_status='inactive' AND selected.heartbeat_at>statement_timestamp()-interval '2 minutes' THEN RETURN false; END IF;
  UPDATE preview_activity SET state=p_status,summarized_at=statement_timestamp() WHERE id=p_activity_id;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
    resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'preview.summary','viewer',identity.viewer_id,identity.session_id,selected.room_id,
    'document_version',selected.version_id,'success',
    CASE WHEN p_status='closed' THEN 'PREVIEW_CLOSED' ELSE 'PREVIEW_INACTIVE' END,
    selected.correlation_id,jsonb_build_object('pageRanges',selected.page_ranges::text,'status',p_status));
  RETURN true;
END $$;

CREATE FUNCTION create_download_lease(p_id text,p_session_digest text,p_room_id text,
  p_document_id text,p_correlation_id text)
RETURNS TABLE(lease_id text,version_id text,size_bytes bigint,expires_at timestamptz,filename text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected record; identity record; expiry timestamptz:=statement_timestamp()+interval '15 minutes';
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN; END IF;
  SELECT p.published_version_id,v.size_bytes,p.display_name,v.detected_media_type INTO selected
  FROM published_structure_entry p JOIN document_version v ON v.id=p.published_version_id
  WHERE p.room_id=p_room_id AND p.resource_kind='document' AND p.resource_id=p_document_id
    AND viewer_can_preview_document(identity.viewer_id,identity.session_id,p_room_id,p_document_id)
    AND resolve_document_download_policy(p_document_id)='allow';
  IF selected.published_version_id IS NULL THEN RETURN; END IF;
  INSERT INTO download_lease(id,viewer_id,session_id,room_id,document_id,version_id,
    correlation_id,size_bytes,expires_at)
  VALUES(p_id,identity.viewer_id,identity.session_id,p_room_id,p_document_id,selected.published_version_id,
    p_correlation_id,selected.size_bytes,expiry);
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
  VALUES(replace(gen_random_uuid()::text,'-',''),'download.lease.finalize','download-finalize:'||p_id,
    jsonb_build_object('leaseId',p_id),expiry);
  RETURN QUERY SELECT p_id,selected.published_version_id,selected.size_bytes,expiry,
    left(regexp_replace(selected.display_name,'[.](pdf|png|jpe?g|webp|txt|csv|xlsx|ods)$','','i'),250) ||
    CASE selected.detected_media_type WHEN 'application/pdf' THEN '.pdf' WHEN 'image/png' THEN '.png'
      WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/webp' THEN '.webp' WHEN 'text/plain' THEN '.txt'
      WHEN 'text/csv' THEN '.csv' WHEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' THEN '.xlsx'
      WHEN 'application/vnd.oasis.opendocument.spreadsheet' THEN '.ods' ELSE '' END;
END $$;

CREATE FUNCTION finalize_download(p_lease download_lease,p_state text,p_audit_id text,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_lease.state<>'active' THEN RETURN; END IF;
  UPDATE download_lease SET state=p_state,summarized_at=statement_timestamp() WHERE id=p_lease.id AND state='active';
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
    resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'download.summary','viewer',p_lease.viewer_id,p_lease.session_id,p_lease.room_id,
    'document_version',p_lease.version_id,CASE WHEN p_state='completed' THEN 'success' ELSE 'failure' END,
    p_reason,p_lease.correlation_id,jsonb_build_object('documentId',p_lease.document_id,
      'versionId',p_lease.version_id,'bytesServed',p_lease.bytes_served,'status',p_state));
END $$;

CREATE FUNCTION authorize_download_range(p_lease_id text,p_session_digest text,p_audit_id text)
RETURNS TABLE(object_key text,size_bytes bigint,version_id text,correlation_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected download_lease%ROWTYPE; source_key text; identity record;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN; END IF;
  SELECT * INTO selected FROM download_lease l WHERE l.id=p_lease_id AND l.viewer_id=identity.viewer_id
    AND l.session_id=identity.session_id FOR UPDATE;
  IF selected.id IS NULL THEN RETURN; END IF;
  IF selected.state='active' AND selected.expires_at>statement_timestamp()
     AND viewer_can_preview_document(identity.viewer_id,identity.session_id,selected.room_id,selected.document_id)
     AND resolve_document_download_policy(selected.document_id)='allow' THEN
    SELECT v.object_key INTO source_key FROM document_version v WHERE v.id=selected.version_id;
    RETURN QUERY SELECT source_key,selected.size_bytes,selected.version_id,selected.correlation_id;
    RETURN;
  END IF;
  IF selected.state='active' THEN
    PERFORM finalize_download(selected,'failed',p_audit_id,
      CASE WHEN selected.expires_at<=statement_timestamp() THEN 'DOWNLOAD_LEASE_EXPIRED' ELSE 'DOWNLOAD_AUTHORIZATION_REVOKED' END);
  END IF;
END $$;

CREATE FUNCTION record_download_range(p_lease_id text,p_session_digest text,
  p_start bigint,p_end_exclusive bigint,p_bytes bigint,p_audit_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected download_lease%ROWTYPE; complete boolean; identity record;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO selected FROM download_lease l WHERE l.id=p_lease_id AND l.viewer_id=identity.viewer_id
    AND l.session_id=identity.session_id FOR UPDATE;
  IF selected.id IS NULL OR selected.state<>'active' OR selected.expires_at<=statement_timestamp()
     OR NOT viewer_can_preview_document(identity.viewer_id,identity.session_id,selected.room_id,selected.document_id)
     OR resolve_document_download_policy(selected.document_id)<>'allow'
     OR p_start<0 OR p_end_exclusive<=p_start OR p_end_exclusive>selected.size_bytes
     OR p_bytes<>p_end_exclusive-p_start THEN RETURN false; END IF;
  UPDATE download_lease SET bytes_served=bytes_served+p_bytes,
    served_ranges=served_ranges+int8multirange(int8range(p_start,p_end_exclusive,'[)')) WHERE id=p_lease_id
    RETURNING * INTO selected;
  complete:=selected.served_ranges @> int8range(0,selected.size_bytes,'[)');
  IF complete THEN PERFORM finalize_download(selected,'completed',p_audit_id,'DOWNLOAD_COMPLETED'); END IF;
  RETURN true;
END $$;

CREATE FUNCTION finalize_expired_download(p_lease_id text,p_job_id text,p_owner text,p_token text,p_audit_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected download_lease%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id
    AND j.job_type='download.lease.finalize' AND j.payload->>'leaseId'=p_lease_id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()) THEN
    RAISE EXCEPTION 'download finalizer lease lost' USING ERRCODE='55000';
  END IF;
  SELECT * INTO selected FROM download_lease WHERE id=p_lease_id FOR UPDATE;
  IF selected.id IS NULL OR selected.state<>'active' THEN RETURN 'already-final'; END IF;
  IF selected.expires_at>statement_timestamp() THEN RAISE EXCEPTION 'download lease not expired' USING ERRCODE='55000'; END IF;
  PERFORM finalize_download(selected,'failed',p_audit_id,'DOWNLOAD_LEASE_EXPIRED');
  RETURN 'summarized';
END $$;

CREATE FUNCTION fail_download(p_lease_id text,p_session_digest text,p_audit_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected download_lease%ROWTYPE; identity record;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO selected FROM download_lease l WHERE l.id=p_lease_id AND l.viewer_id=identity.viewer_id
    AND l.session_id=identity.session_id FOR UPDATE;
  IF selected.id IS NULL OR selected.state<>'active' THEN RETURN false; END IF;
  PERFORM finalize_download(selected,'failed',p_audit_id,'DOWNLOAD_FAILED');
  RETURN true;
END $$;

CREATE FUNCTION finalize_or_reschedule_preview(p_activity_id text,p_job_id text,p_owner text,p_token text,p_successor_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected preview_activity%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id
    AND j.job_type='preview.inactivity.finalize' AND j.payload->>'activityId'=p_activity_id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()) THEN
    RAISE EXCEPTION 'preview inactivity lease lost' USING ERRCODE='55000';
  END IF;
  SELECT * INTO selected FROM preview_activity WHERE id=p_activity_id FOR UPDATE;
  IF selected.id IS NULL OR selected.state<>'active' THEN RETURN 'already-final'; END IF;
  IF selected.heartbeat_at>statement_timestamp()-interval '2 minutes' THEN
    INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
    VALUES(p_successor_id,'preview.inactivity.finalize',
      'preview-inactivity:'||p_activity_id||':'||extract(epoch FROM selected.heartbeat_at)::bigint,
      jsonb_build_object('activityId',p_activity_id),selected.heartbeat_at+interval '2 minutes')
    ON CONFLICT(idempotency_key) DO NOTHING;
    RETURN 'rescheduled';
  END IF;
  UPDATE preview_activity SET state='inactive',summarized_at=statement_timestamp() WHERE id=p_activity_id;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
    resource_id,result,reason_code,correlation_id,detail)
  VALUES(replace(gen_random_uuid()::text,'-',''),'preview.summary','viewer',selected.viewer_id,
    selected.session_id,selected.room_id,'document_version',selected.version_id,'success',
    'PREVIEW_INACTIVE',selected.correlation_id,
    jsonb_build_object('pageRanges',selected.page_ranges::text,'status','inactive'));
  RETURN 'summarized';
END $$;

CREATE FUNCTION purge_expired_preview_telemetry()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE removed bigint;
BEGIN
  DELETE FROM preview_delivery_telemetry WHERE expires_at<=statement_timestamp();
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END $$;

CREATE FUNCTION watermark_cache_grant_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE;
BEGIN
  IF OLD.state='active' AND NEW.state='revoked' THEN
    FOR selected IN SELECT c.* FROM watermark_cache c WHERE c.room_id=NEW.room_id
      AND c.state IN ('creating','active')
      AND NOT viewer_can_preview_document(c.viewer_id,c.session_id,c.room_id,c.document_id)
    LOOP PERFORM enqueue_watermark_deletion(selected); END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grant_revocation_deletes_watermarks AFTER UPDATE OF state ON access_grant
FOR EACH ROW EXECUTE FUNCTION watermark_cache_grant_revoked();

CREATE FUNCTION watermark_session_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE;
BEGIN
  IF OLD.state='active' AND NEW.state<>'active' THEN
    FOR selected IN SELECT c.* FROM watermark_cache c WHERE c.session_id=NEW.id
      AND c.state IN ('creating','active')
    LOOP PERFORM enqueue_watermark_deletion(selected); END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION watermark_viewer_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE;
BEGIN
  IF OLD.state='active' AND NEW.state<>'active' THEN
    FOR selected IN SELECT c.* FROM watermark_cache c WHERE c.viewer_id=NEW.id
      AND c.state IN ('creating','active')
    LOOP PERFORM enqueue_watermark_deletion(selected); END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION watermark_membership_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE;
BEGIN
  IF OLD.state='active' AND NEW.state<>'active' THEN
    FOR selected IN SELECT c.* FROM watermark_cache c WHERE c.viewer_id=NEW.viewer_id
      AND c.room_id=NEW.room_id AND c.state IN ('creating','active')
    LOOP PERFORM enqueue_watermark_deletion(selected); END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_revocation_deletes_watermarks AFTER UPDATE OF state ON session
FOR EACH ROW EXECUTE FUNCTION watermark_session_revoked();
CREATE TRIGGER viewer_revocation_deletes_watermarks AFTER UPDATE OF state ON viewer
FOR EACH ROW EXECUTE FUNCTION watermark_viewer_revoked();
CREATE TRIGGER membership_revocation_deletes_watermarks AFTER UPDATE OF state ON viewer_room_membership
FOR EACH ROW EXECUTE FUNCTION watermark_membership_revoked();

CREATE FUNCTION watermark_counterparty_membership_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE;
BEGIN
  IF OLD.state='active' AND NEW.state<>'active' THEN
    FOR selected IN SELECT c.* FROM watermark_cache c WHERE c.viewer_id=NEW.viewer_id
      AND c.room_id=NEW.room_id AND c.state IN ('creating','active')
      AND NOT viewer_can_preview_document(c.viewer_id,c.session_id,c.room_id,c.document_id)
    LOOP PERFORM enqueue_watermark_deletion(selected); END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER counterparty_membership_revocation_deletes_watermarks AFTER UPDATE OF state ON counterparty_viewer
FOR EACH ROW EXECUTE FUNCTION watermark_counterparty_membership_revoked();

CREATE FUNCTION begin_watermark_deletion(p_cache_id text,p_job_id text,p_owner text,p_token text)
RETURNS TABLE(object_key text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE;
BEGIN
  SELECT c.* INTO selected FROM watermark_cache c JOIN job_queue j ON j.id=p_job_id
  WHERE c.id=p_cache_id AND c.state IN ('creating','active','deletion_pending')
    AND (c.state='deletion_pending' OR c.expires_at<=statement_timestamp())
    AND j.job_type='document.watermark.delete' AND j.payload->>'cacheId'=c.id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp() FOR UPDATE OF c;
  IF selected.id IS NULL THEN RETURN; END IF;
  UPDATE watermark_cache SET state='deletion_pending' WHERE id=selected.id;
  RETURN QUERY SELECT selected.object_key;
END $$;
CREATE FUNCTION finish_watermark_deletion(p_cache_id text,p_job_id text,p_owner text,p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE watermark_cache c SET state='deleted' FROM job_queue j
  WHERE c.id=p_cache_id AND c.state='deletion_pending' AND j.id=p_job_id
    AND j.job_type='document.watermark.delete' AND j.payload->>'cacheId'=c.id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'watermark cleanup lease lost' USING ERRCODE='55000'; END IF;
END $$;

REVOKE ALL ON watermark_cache,preview_activity,preview_delivery_telemetry,download_lease
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
REVOKE ALL ON FUNCTION enqueue_watermark_deletion(watermark_cache),resolve_presented_viewer(text),
 begin_watermark_cache(text,text,text,text,integer,text),finish_watermark_cache(text,text),
 authorize_watermark_delivery(text,text,text),read_protected_text_layer(text,text,text,integer),
 begin_preview_activity(text,text,text,text,text,text,text,text,text,text,text,text),
 record_preview_page(text,text,text,integer),heartbeat_preview(text,text),
 summarize_preview(text,text,text,text),create_download_lease(text,text,text,text,text),
 finalize_download(download_lease,text,text,text),authorize_download_range(text,text,text),
 record_download_range(text,text,bigint,bigint,bigint,text),fail_download(text,text,text),
 finalize_expired_download(text,text,text,text,text),
 purge_expired_preview_telemetry(),finalize_or_reschedule_preview(text,text,text,text,text),watermark_cache_grant_revoked(),
 watermark_session_revoked(),watermark_viewer_revoked(),watermark_membership_revoked(),
 watermark_counterparty_membership_revoked(),begin_watermark_deletion(text,text,text,text),
 finish_watermark_deletion(text,text,text,text)
 FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION begin_watermark_cache(text,text,text,text,integer,text),
 finish_watermark_cache(text,text),authorize_watermark_delivery(text,text,text),
 read_protected_text_layer(text,text,text,integer),
 begin_preview_activity(text,text,text,text,text,text,text,text,text,text,text,text),
 heartbeat_preview(text,text),summarize_preview(text,text,text,text),
 create_download_lease(text,text,text,text,text),authorize_download_range(text,text,text),
 record_download_range(text,text,bigint,bigint,bigint,text),fail_download(text,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION begin_watermark_deletion(text,text,text,text),
 finish_watermark_deletion(text,text,text,text),purge_expired_preview_telemetry(),
 finalize_or_reschedule_preview(text,text,text,text,text),finalize_expired_download(text,text,text,text,text) TO duefold_worker;

ALTER TABLE watermark_cache OWNER TO duefold_migration;
ALTER TABLE preview_activity OWNER TO duefold_migration;
ALTER TABLE preview_delivery_telemetry OWNER TO duefold_migration;
ALTER TABLE download_lease OWNER TO duefold_migration;
ALTER FUNCTION enqueue_watermark_deletion(watermark_cache) OWNER TO duefold_migration;
ALTER FUNCTION resolve_presented_viewer(text) OWNER TO duefold_migration;
ALTER FUNCTION begin_watermark_cache(text,text,text,text,integer,text) OWNER TO duefold_migration;
ALTER FUNCTION finish_watermark_cache(text,text) OWNER TO duefold_migration;
ALTER FUNCTION authorize_watermark_delivery(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_protected_text_layer(text,text,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION begin_preview_activity(text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION heartbeat_preview(text,text) OWNER TO duefold_migration;
ALTER FUNCTION summarize_preview(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION create_download_lease(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_download(download_lease,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION authorize_download_range(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION record_download_range(text,text,bigint,bigint,bigint,text) OWNER TO duefold_migration;
ALTER FUNCTION fail_download(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_expired_download(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION purge_expired_preview_telemetry() OWNER TO duefold_migration;
ALTER FUNCTION finalize_or_reschedule_preview(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION watermark_cache_grant_revoked() OWNER TO duefold_migration;
ALTER FUNCTION watermark_session_revoked() OWNER TO duefold_migration;
ALTER FUNCTION watermark_viewer_revoked() OWNER TO duefold_migration;
ALTER FUNCTION watermark_membership_revoked() OWNER TO duefold_migration;
ALTER FUNCTION watermark_counterparty_membership_revoked() OWNER TO duefold_migration;
ALTER FUNCTION begin_watermark_deletion(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finish_watermark_deletion(text,text,text,text) OWNER TO duefold_migration;
