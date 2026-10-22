-- The room index and audit export streams its audit rows in keyset pages. Building
-- them as one jsonb value scanned every audit row and failed outright once the
-- room's trail passed PostgreSQL's jsonb size limit.

CREATE INDEX audit_event_room_sequence ON audit_event(room_id,sequence);

CREATE OR REPLACE FUNCTION read_export_payload(p_export_id text,p_actor_id text)
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
    -- 'audit' is read page by page through read_export_audit_page.
    SELECT jsonb_build_object('preset',e.preset,'roomId',e.room_id,
      'index',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',p.resource_kind,'id',p.resource_id,'name',p.display_name) ORDER BY p.order_key,p.entry_id) FROM published_structure_entry p WHERE p.room_id=e.room_id),'[]'::jsonb)) INTO payload;
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
-- Only read_export_job_payload calls this, under a live job lease.
REVOKE EXECUTE ON FUNCTION read_export_payload(text,text) FROM duefold_runtime;

-- Never called: the worker marks exports ready and deleted under its job lease
-- (mark_export_job_ready, finalize_export_cleanup). The runtime role could otherwise mark
-- an export ready before any object existed.
DROP FUNCTION mark_export_ready(text,text,bigint);
DROP FUNCTION finalize_export_deletion(text,text,text,text);

-- Raises rather than returning an empty page when the export may no longer be
-- generated, so the worker never completes a truncated audit trail.
CREATE FUNCTION read_export_audit_page(p_export_id text,p_job_id text,p_owner text,p_token text,
  p_after_sequence bigint) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e export_request%ROWTYPE;
BEGIN
  SELECT x.* INTO e FROM export_request x JOIN job_queue j ON j.id=p_job_id
  WHERE x.id=p_export_id AND j.job_type='export.generate' AND j.payload->>'exportId'=x.id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp();
  IF e.id IS NULL THEN RAISE EXCEPTION 'export job lease lost' USING ERRCODE='55000'; END IF;
  IF e.preset<>'room-index-audit' OR e.state<>'generating' OR e.expires_at<=statement_timestamp()
     OR NOT member_can_mutate_room(e.created_by,e.room_id,true) THEN
    RAISE EXCEPTION 'export unavailable' USING ERRCODE='55000';
  END IF;
  RETURN QUERY
    SELECT jsonb_build_object('sequence',a.sequence,'eventType',a.event_type,'result',a.result,'occurredAt',a.occurred_at)
    FROM audit_event a WHERE a.room_id=e.room_id AND a.sequence>p_after_sequence
    ORDER BY a.sequence LIMIT 1000;
END $$;
REVOKE ALL ON FUNCTION read_export_audit_page(text,text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_export_audit_page(text,text,text,text,bigint) TO duefold_worker;
ALTER FUNCTION read_export_audit_page(text,text,text,text,bigint) OWNER TO duefold_migration;
