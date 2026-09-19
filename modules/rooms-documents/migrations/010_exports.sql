-- Private one-hour, single-use exports.
-- Runtime has no table privilege. Every read/mutation authorizes inside a
-- SECURITY DEFINER function; creation and consumption audits are transactional.

CREATE TABLE export_request (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  room_id text NOT NULL REFERENCES room(id),
  created_by text NOT NULL REFERENCES member(id),
  preset text NOT NULL CHECK (preset IN ('room-index-audit','participant-access','selected-documents')),
  selected_document_ids text[] NOT NULL DEFAULT '{}',
  include_originals boolean NOT NULL DEFAULT false,
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^exports/[A-Za-z0-9_-]{32}/[A-Za-z0-9_-]{32}$'),
  content_type text NOT NULL CHECK (content_type IN ('application/json','application/zip')),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 10737418240),
  state text NOT NULL DEFAULT 'generating' CHECK
    (state IN ('generating','ready','consumed','expired','deletion_pending','deleted','failed')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour 1 second'),
  CHECK ((state IN ('consumed','deletion_pending','deleted') AND consumed_at IS NOT NULL) OR
         (state NOT IN ('consumed','deletion_pending','deleted') AND consumed_at IS NULL)),
  CHECK ((state='deleted' AND deleted_at IS NOT NULL) OR (state<>'deleted' AND deleted_at IS NULL)),
  CHECK ((preset='selected-documents') OR
         (cardinality(selected_document_ids)=0 AND include_originals=false)),
  CHECK ((preset='selected-documents') OR content_type='application/json')
);
CREATE INDEX export_expiry_pending ON export_request(expires_at)
  WHERE state IN ('generating','ready');
INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
VALUES(replace(gen_random_uuid()::text,'-',''),'export.cleanup','export-cleanup:initial','{}',
  statement_timestamp()+interval '5 minutes',10);
COMMENT ON TABLE export_request IS
  'Private temporary export lifecycle. Object keys never leave an authorized claim function.';

CREATE FUNCTION validate_export_selection(p_room_id text,p_preset text,p_selected text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p_preset IN ('room-index-audit','participant-access','selected-documents')
    AND cardinality(p_selected)<=1000
    AND (p_preset='selected-documents' OR cardinality(p_selected)=0)
    AND (p_preset<>'selected-documents' OR cardinality(p_selected)>0)
    AND cardinality(p_selected)=cardinality(ARRAY(SELECT DISTINCT x FROM unnest(p_selected) x))
    AND NOT EXISTS(
      SELECT 1 FROM unnest(p_selected) x
      LEFT JOIN document d ON d.id=x AND d.room_id=p_room_id
      WHERE d.id IS NULL
    )
$$;

CREATE FUNCTION export_preflight(
  p_actor_id text,p_room_id text,p_preset text,p_selected text[],p_include_originals boolean
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE files integer; estimated bigint; pii jsonb;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'export forbidden' USING ERRCODE='42501';
  END IF;
  IF NOT validate_export_selection(p_room_id,p_preset,p_selected)
     OR (p_include_originals AND p_preset<>'selected-documents') THEN
    RAISE EXCEPTION 'export selection invalid' USING ERRCODE='22023';
  END IF;
  IF p_preset='selected-documents' THEN
    SELECT count(*)::integer,
      COALESCE(sum(CASE WHEN p_include_originals THEN v.size_bytes ELSE 1024 END),0)::bigint
      INTO files,estimated
    FROM document d JOIN unnest(p_selected) x ON x=d.id
    LEFT JOIN LATERAL (
      SELECT dv.size_bytes FROM document_version dv
      WHERE dv.id=d.working_version_id AND version_has_publication_evidence(dv.id,d.id)
    ) v ON true;
    pii:='["document titles"]'::jsonb;
  ELSIF p_preset='participant-access' THEN
    SELECT count(*)::integer, GREATEST(count(*)*512,1)::bigint INTO files,estimated
    FROM viewer_room_membership WHERE room_id=p_room_id;
    pii:='["viewer identity","access grants","expiry"]'::jsonb;
  ELSE
    SELECT count(*)::integer, GREATEST(count(*)*1024,1)::bigint INTO files,estimated
    FROM published_structure_entry WHERE room_id=p_room_id AND resource_kind='document';
    pii:='["member and viewer evidence references","audit timestamps"]'::jsonb;
  END IF;
  RETURN jsonb_build_object('piiCategories',pii,'fileCount',files,'estimatedSize',estimated,
    'retentionEffect','Private temporary object; one download; expires and is deleted after one hour',
    'originalsIncluded',p_include_originals);
END $$;

CREATE FUNCTION create_export_request(
  p_id text,p_actor_id text,p_room_id text,p_preset text,p_selected text[],p_include_originals boolean,
  p_oidc_authenticated_at timestamptz,p_object_key text,p_content_type text,p_job_id text,
  p_audit_id text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb; expiry timestamptz;
BEGIN
  IF p_oidc_authenticated_at IS NULL OR p_oidc_authenticated_at>statement_timestamp()
     OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes' THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  impact:=export_preflight(p_actor_id,p_room_id,p_preset,p_selected,p_include_originals);
  expiry:=statement_timestamp()+interval '1 hour';
  INSERT INTO export_request(id,room_id,created_by,preset,selected_document_ids,
    include_originals,object_key,content_type,expires_at)
  VALUES(p_id,p_room_id,p_actor_id,p_preset,p_selected,p_include_originals,p_object_key,p_content_type,expiry);
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
  VALUES(p_job_id,'export.generate','export-generate:'||p_id,jsonb_build_object('exportId',p_id),
    statement_timestamp(),5);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'export.created','member',p_actor_id,p_room_id,'export',p_id,
    'success','EXPORT_CREATED',p_correlation_id,
    jsonb_build_object('preset',p_preset,'expiresAt',expiry,'includeOriginals',p_include_originals));
  RETURN impact || jsonb_build_object('exportId',p_id,'expiresAt',expiry);
END $$;

CREATE FUNCTION read_export_payload(p_export_id text,p_actor_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e export_request%ROWTYPE; payload jsonb;
BEGIN
  SELECT * INTO e FROM export_request WHERE id=p_export_id AND created_by=p_actor_id
    AND state='generating' AND expires_at>statement_timestamp();
  IF e.id IS NULL OR NOT member_can_mutate_room(p_actor_id,e.room_id,true) THEN RETURN NULL; END IF;
  IF e.preset='participant-access' THEN
    SELECT jsonb_build_object('preset',e.preset,'roomId',e.room_id,'rows',COALESCE(jsonb_agg(row ORDER BY row->>'viewerId'),'[]'::jsonb)) INTO payload
    FROM (SELECT jsonb_build_object('viewerId',m.viewer_id,'state',m.state,'grantCount',count(g.id)) row
      FROM viewer_room_membership m LEFT JOIN access_grant g ON g.viewer_id=m.viewer_id AND g.room_id=m.room_id
      WHERE m.room_id=e.room_id GROUP BY m.viewer_id,m.state) x;
  ELSIF e.preset='room-index-audit' THEN
    SELECT jsonb_build_object('preset',e.preset,'roomId',e.room_id,
      'index',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',p.resource_kind,'id',p.resource_id,'name',p.display_name) ORDER BY p.order_key,p.entry_id) FROM published_structure_entry p WHERE p.room_id=e.room_id),'[]'::jsonb),
      'audit',COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence',a.sequence,'eventType',a.event_type,'result',a.result,'occurredAt',a.occurred_at) ORDER BY a.sequence) FROM audit_event a WHERE a.room_id=e.room_id),'[]'::jsonb)) INTO payload;
  ELSE
    SELECT jsonb_build_object('preset',e.preset,'roomId',e.room_id,
      'originalsIncluded',e.include_originals,
      'documents',COALESCE(jsonb_agg(jsonb_build_object(
        'documentId',d.id,'title',d.display_title,
        'objectKey',CASE WHEN e.include_originals THEN v.object_key ELSE NULL END
      ) ORDER BY d.id),'[]'::jsonb)) INTO payload
    FROM document d JOIN unnest(e.selected_document_ids) x ON x=d.id
    LEFT JOIN document_version v ON v.id=d.working_version_id
      AND version_has_publication_evidence(v.id,d.id)
    WHERE d.room_id=e.room_id;
    IF e.include_originals AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(payload->'documents') x WHERE x->>'objectKey' IS NULL
    ) THEN RAISE EXCEPTION 'selected original unavailable' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN payload;
END $$;

CREATE FUNCTION read_export_job_payload(p_export_id text,p_job_id text,p_owner text,p_token text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT read_export_payload(e.id,e.created_by)||jsonb_build_object('exportObjectKey',e.object_key)
  FROM export_request e JOIN job_queue j ON j.id=p_job_id
  WHERE e.id=p_export_id AND e.state='generating' AND e.expires_at>statement_timestamp()
    AND j.job_type='export.generate' AND j.payload->>'exportId'=e.id AND j.state='running'
    AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()
$$;
CREATE FUNCTION mark_export_job_ready(p_export_id text,p_job_id text,p_owner text,p_token text,p_size_bytes bigint)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE export_request e SET state='ready',size_bytes=p_size_bytes FROM job_queue j
  WHERE e.id=p_export_id AND e.state='generating' AND e.expires_at>statement_timestamp()
    AND p_size_bytes BETWEEN 1 AND 10737418240 AND j.id=p_job_id
    AND j.job_type='export.generate' AND j.payload->>'exportId'=e.id AND j.state='running'
    AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp() RETURNING true
$$;

CREATE FUNCTION mark_export_ready(p_export_id text,p_actor_id text,p_size_bytes bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE export_request SET state='ready',size_bytes=p_size_bytes
    WHERE id=p_export_id AND created_by=p_actor_id AND state='generating'
      AND expires_at>statement_timestamp() AND member_can_mutate_room(p_actor_id,room_id,true);
  RETURN FOUND;
END $$;

CREATE FUNCTION claim_export_download(p_export_id text,p_actor_id text,p_oidc_authenticated_at timestamptz,p_audit_id text,p_correlation_id text)
RETURNS TABLE(object_key text,content_type text,size_bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e export_request%ROWTYPE;
BEGIN
  IF p_oidc_authenticated_at IS NULL OR p_oidc_authenticated_at>statement_timestamp()
     OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes' THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  UPDATE export_request x SET state='deletion_pending',consumed_at=statement_timestamp()
    WHERE x.id=p_export_id AND x.created_by=p_actor_id AND x.state='ready'
      AND x.expires_at>statement_timestamp()
      AND member_can_mutate_room(p_actor_id,x.room_id,true)
    RETURNING x.* INTO e;
  IF e.id IS NULL THEN RETURN; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'export.download','member',p_actor_id,e.room_id,'export',e.id,
    'success','EXPORT_CLAIMED',p_correlation_id,jsonb_build_object('sizeBytes',e.size_bytes));
  RETURN QUERY SELECT e.object_key,e.content_type,e.size_bytes;
END $$;

CREATE FUNCTION finalize_export_deletion(p_export_id text,p_actor_id text,p_audit_id text,p_correlation_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text;
BEGIN
  UPDATE export_request SET state='deleted',deleted_at=statement_timestamp()
    WHERE id=p_export_id AND created_by=p_actor_id AND state='deletion_pending'
    RETURNING room_id INTO selected_room;
  IF selected_room IS NULL THEN RETURN false; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id)
  VALUES(p_audit_id,'export.deleted','member',p_actor_id,selected_room,'export',p_export_id,
    'success','EXPORT_OBJECT_DELETED',p_correlation_id);
  RETURN true;
END $$;

CREATE FUNCTION expire_exports(p_job_id text,p_owner text,p_token text)
RETURNS SETOF text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RETURN QUERY UPDATE export_request e SET state='deletion_pending',consumed_at=statement_timestamp()
    FROM job_queue j
    WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner
      AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp()
      AND e.state IN ('generating','ready') AND e.expires_at<=statement_timestamp()
    RETURNING e.id;
END $$;

CREATE FUNCTION claim_export_cleanup(p_job_id text,p_owner text,p_token text)
RETURNS TABLE(export_id text,object_key text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT e.id,e.object_key FROM export_request e JOIN job_queue j ON j.id=p_job_id
  WHERE j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp() AND e.state='deletion_pending'
  ORDER BY e.consumed_at,e.id LIMIT 100
$$;
CREATE FUNCTION finalize_export_cleanup(p_export_id text,p_job_id text,p_owner text,p_token text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE export_request e SET state='deleted',deleted_at=statement_timestamp()
  FROM job_queue j WHERE e.id=p_export_id AND e.state='deletion_pending'
    AND j.id=p_job_id AND j.state='running' AND j.lease_owner=p_owner
    AND j.lease_token=p_token AND j.lease_expires_at>statement_timestamp()
  RETURNING true
$$;

ALTER TABLE export_request OWNER TO duefold_migration;
REVOKE ALL ON export_request FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
REVOKE ALL ON FUNCTION validate_export_selection(text,text,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION export_preflight(text,text,text,text[],boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_export_request(text,text,text,text,text[],boolean,timestamptz,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_export_payload(text,text),read_export_job_payload(text,text,text,text),mark_export_job_ready(text,text,text,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_export_ready(text,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_export_download(text,text,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_export_deletion(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_export_cleanup(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_export_cleanup(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_exports(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_preflight(text,text,text,text[],boolean),
  create_export_request(text,text,text,text,text[],boolean,timestamptz,text,text,text,text,text),
  read_export_payload(text,text),mark_export_ready(text,text,bigint),
  claim_export_download(text,text,timestamptz,text,text),finalize_export_deletion(text,text,text,text)
  TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_export_job_payload(text,text,text,text),mark_export_job_ready(text,text,text,text,bigint),expire_exports(text,text,text),claim_export_cleanup(text,text,text),finalize_export_cleanup(text,text,text,text) TO duefold_worker;
ALTER FUNCTION validate_export_selection(text,text,text[]) OWNER TO duefold_migration;
ALTER FUNCTION export_preflight(text,text,text,text[],boolean) OWNER TO duefold_migration;
ALTER FUNCTION create_export_request(text,text,text,text,text[],boolean,timestamptz,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_export_payload(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_export_job_payload(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION mark_export_job_ready(text,text,text,text,bigint) OWNER TO duefold_migration;
ALTER FUNCTION mark_export_ready(text,text,bigint) OWNER TO duefold_migration;
ALTER FUNCTION claim_export_download(text,text,timestamptz,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_export_deletion(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION claim_export_cleanup(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION finalize_export_cleanup(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION expire_exports(text,text,text) OWNER TO duefold_migration;
