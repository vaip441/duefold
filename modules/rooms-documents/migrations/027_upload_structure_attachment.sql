-- Attach every newly uploaded document to the room's working collection in the
-- same transaction that creates its quarantined first version. Existing
-- finalized uploads from the affected release are recovered before the
-- replacement function is exposed.

CREATE TEMP TABLE duefold_recovered_upload_document ON COMMIT DROP AS
SELECT d.id,d.room_id,d.display_title,
  row_number() OVER (PARTITION BY d.room_id ORDER BY d.created_at,d.id) AS position
FROM document d
LEFT JOIN working_structure_entry attached ON attached.document_id=d.id
WHERE attached.id IS NULL
  AND EXISTS (
    SELECT 1
    FROM document_version version
    JOIN upload_intent intent ON intent.object_key=version.object_key
    WHERE version.document_id=d.id AND intent.document_id IS NULL
      AND intent.room_id=d.room_id AND intent.member_id=d.created_by
      AND intent.state='finalized'
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM duefold_recovered_upload_document d
    JOIN working_structure_entry sibling
      ON sibling.room_id = d.room_id
     AND sibling.parent_folder_id IS NULL
     AND sibling.normalized_name = canonical_structure_name(d.display_title)
     AND NOT sibling.staged_removed
  ) OR EXISTS (
    SELECT 1
    FROM duefold_recovered_upload_document d
    GROUP BY d.room_id, canonical_structure_name(d.display_title)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'unattached upload name collision requires resolution' USING ERRCODE='23505';
  END IF;
END $$;

WITH room_tail AS (
  SELECT room_id,COALESCE(max(order_key),0) AS maximum
  FROM working_structure_entry
  WHERE parent_folder_id IS NULL AND NOT staged_removed
  GROUP BY room_id
)
INSERT INTO working_structure_entry(id,room_id,document_id,parent_folder_id,display_name,order_key)
SELECT detached.id,detached.room_id,detached.id,NULL,detached.display_title,
  COALESCE(room_tail.maximum,0)+(detached.position*1024)
FROM duefold_recovered_upload_document detached
LEFT JOIN room_tail ON room_tail.room_id=detached.room_id;

UPDATE room SET working_revision=room.working_revision+recovered.count
FROM (
  SELECT room_id,count(*)::integer AS count
  FROM duefold_recovered_upload_document
  GROUP BY room_id
) recovered
WHERE room.id=recovered.room_id;

INSERT INTO audit_event(
  id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
  result,reason_code,correlation_id,detail
)
SELECT md5('upload-document-recovered:'||d.id),'room.structure','system',NULL,d.room_id,
  'document',d.id,'success','UPLOAD_DOCUMENT_RECOVERED',
  'corr_'||md5('upload-document-recovered-correlation:'||d.id),
  jsonb_build_object('entryId',entry.id)
FROM duefold_recovered_upload_document d
JOIN working_structure_entry entry ON entry.document_id=d.id;

CREATE OR REPLACE FUNCTION authorize_upload_destination(
  p_actor_id text,p_room_id text,p_document_id text,p_display_title text
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM room r JOIN member m ON m.id=p_actor_id AND m.state='active'
    LEFT JOIN room_assignment a ON a.room_id=r.id AND a.member_id=m.id AND a.state='active'
    WHERE r.id=p_room_id AND r.state<>'archived'
      AND (m.global_role IN ('owner','admin') OR a.room_role IN ('manager','contributor'))
      AND (p_document_id IS NULL OR EXISTS(
        SELECT 1 FROM document d WHERE d.id=p_document_id AND d.room_id=r.id
      ))
  ) THEN
    RETURN false;
  END IF;
  IF p_document_id IS NULL AND EXISTS(
    SELECT 1 FROM working_structure_entry entry
    WHERE entry.room_id=p_room_id AND entry.parent_folder_id IS NULL
      AND entry.normalized_name=canonical_structure_name(p_display_title)
      AND NOT entry.staged_removed
  ) THEN
    RAISE EXCEPTION 'working sibling name collision' USING ERRCODE='23505';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION authorize_upload_destination(text,text,text,text)
  FROM PUBLIC,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION authorize_upload_destination(text,text,text,text)
  TO duefold_runtime;
ALTER FUNCTION authorize_upload_destination(text,text,text,text) OWNER TO duefold_migration;
REVOKE ALL ON FUNCTION authorize_upload_destination(text,text,text) FROM duefold_runtime;

CREATE OR REPLACE FUNCTION create_quarantined_document_version(
  p_version_id text,p_document_id text,p_intent_id text,p_actor_id text,
  p_size_bytes bigint,p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_intent upload_intent%ROWTYPE; next_working_revision integer; next_order numeric;
BEGIN
  SELECT * INTO selected_intent FROM upload_intent u
   WHERE u.id=p_intent_id AND u.member_id=p_actor_id AND u.state='completing'
     AND u.expires_at>transaction_timestamp() AND u.declared_size=p_size_bytes
   FOR UPDATE;
  IF selected_intent.id IS NULL THEN
    RAISE EXCEPTION 'upload intent cannot create version' USING ERRCODE='55000';
  END IF;
  IF selected_intent.document_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM document WHERE id=p_document_id) THEN
      RAISE EXCEPTION 'document id already exists' USING ERRCODE='55000';
    END IF;
    UPDATE room SET working_revision=working_revision+1
      WHERE id=selected_intent.room_id AND state<>'archived'
      RETURNING working_revision INTO next_working_revision;
    IF next_working_revision IS NULL THEN
      RAISE EXCEPTION 'upload destination unavailable' USING ERRCODE='55000';
    END IF;
    SELECT COALESCE(max(order_key),0)+1024 INTO next_order
    FROM working_structure_entry
    WHERE room_id=selected_intent.room_id AND parent_folder_id IS NULL AND NOT staged_removed;
    INSERT INTO document(id,room_id,display_title,created_by)
      VALUES(p_document_id,selected_intent.room_id,selected_intent.display_title,p_actor_id);
    INSERT INTO working_structure_entry(
      id,room_id,document_id,parent_folder_id,display_name,order_key
    ) VALUES(
      p_document_id,selected_intent.room_id,p_document_id,NULL,selected_intent.display_title,next_order
    );
    INSERT INTO audit_event(
      id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
      result,reason_code,correlation_id,detail
    ) VALUES(
      md5('upload-document-attached:'||p_audit_id),'room.structure','member',p_actor_id,
      selected_intent.room_id,'document',p_document_id,'success','DOCUMENT_ATTACHED',
      p_correlation_id,jsonb_build_object(
        'entryId',p_document_id,'workingRevision',next_working_revision
      )
    );
  ELSIF selected_intent.document_id<>p_document_id OR NOT EXISTS(
    SELECT 1 FROM document d WHERE d.id=p_document_id AND d.room_id=selected_intent.room_id
  ) THEN
    RAISE EXCEPTION 'upload destination mismatch' USING ERRCODE='55000';
  END IF;
  INSERT INTO document_version
    (id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
  VALUES (p_version_id,p_document_id,selected_intent.original_filename,selected_intent.object_key,
    selected_intent.declared_media_type,p_size_bytes,'quarantine');
  UPDATE upload_intent SET state='finalized' WHERE id=p_intent_id;
  INSERT INTO audit_event
    (id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'upload.finalized','member',p_actor_id,p_intent_id,selected_intent.room_id,
    'document_version',p_version_id,'success','UPLOAD_QUARANTINED',p_correlation_id);
END $$;

REVOKE ALL ON FUNCTION create_quarantined_document_version(text,text,text,text,bigint,text,text)
  FROM PUBLIC,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION create_quarantined_document_version(text,text,text,text,bigint,text,text)
  TO duefold_runtime;
ALTER FUNCTION create_quarantined_document_version(text,text,text,text,bigint,text,text)
  OWNER TO duefold_migration;
