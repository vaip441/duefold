-- A directory upload recreates its folders, so an upload intent may name the working
-- folder that receives its new document. Trash purge deletes folders without touching
-- intents, so the folder is checked when the intent is authorized and again by the
-- working-structure integrity trigger when the document is attached, not by a foreign key.
ALTER TABLE upload_intent ADD COLUMN parent_folder_id text
  CHECK (parent_folder_id IS NULL
    OR (parent_folder_id ~ '^[A-Za-z0-9_-]{32}$' AND document_id IS NULL));

DROP FUNCTION authorize_upload_destination(text,text,text,text);
CREATE FUNCTION authorize_upload_destination(
  p_actor_id text,p_room_id text,p_document_id text,p_display_title text,p_parent_folder_id text
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
      AND (p_parent_folder_id IS NULL OR EXISTS(
        SELECT 1 FROM working_structure_entry parent
        WHERE parent.folder_id=p_parent_folder_id AND parent.room_id=r.id
          AND NOT parent.staged_removed
      ))
  ) THEN
    RETURN false;
  END IF;
  IF p_document_id IS NULL AND EXISTS(
    SELECT 1 FROM working_structure_entry entry
    WHERE entry.room_id=p_room_id
      AND entry.parent_folder_id IS NOT DISTINCT FROM p_parent_folder_id
      AND entry.normalized_name=canonical_structure_name(p_display_title)
      AND NOT entry.staged_removed
  ) THEN
    RAISE EXCEPTION 'working sibling name collision' USING ERRCODE='23505';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION authorize_upload_destination(text,text,text,text,text)
  FROM PUBLIC,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION authorize_upload_destination(text,text,text,text,text)
  TO duefold_runtime;
ALTER FUNCTION authorize_upload_destination(text,text,text,text,text) OWNER TO duefold_migration;

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
    WHERE room_id=selected_intent.room_id
      AND parent_folder_id IS NOT DISTINCT FROM selected_intent.parent_folder_id
      AND NOT staged_removed;
    INSERT INTO document(id,room_id,display_title,created_by)
      VALUES(p_document_id,selected_intent.room_id,selected_intent.display_title,p_actor_id);
    INSERT INTO working_structure_entry(
      id,room_id,document_id,parent_folder_id,display_name,order_key
    ) VALUES(
      p_document_id,selected_intent.room_id,p_document_id,selected_intent.parent_folder_id,
      selected_intent.display_title,next_order
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
