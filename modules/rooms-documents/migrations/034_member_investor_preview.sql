-- Investor preview (§4.2): a Room Manager reads the room's published content as an
-- investor sees it, to confirm every file renders. Preview never resolves a viewer
-- session and never writes watermark caches, preview evidence, or download leases, so
-- investor activity records stay attributable to investors alone. Pages are the stored
-- derivatives without a watermark; each document opened is audited instead.

CREATE FUNCTION assert_member_preview(p_actor_id text,p_room_id text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
END $$;

-- Visibility matches read_viewer_published_structure for a whole-room grant: folders
-- always, documents only with publication evidence, so preview cannot show a file
-- investors would not see. The room state says whether investors can reach it at all.
-- NULL means the room does not exist.
CREATE FUNCTION read_member_preview_room(p_actor_id text,p_room_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_member_preview(p_actor_id,p_room_id);
  RETURN (
    SELECT jsonb_build_object('title',r.title,'state',r.state,'entries',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'entryId',v.entry_id,'resourceKind',v.resource_kind,'resourceId',v.resource_id,
          'parentFolderId',v.parent_folder_id,'displayName',v.display_name,
          'description',v.description,'publishedVersionId',v.published_version_id,
          'siblingPosition',v.sibling_position)
        ORDER BY v.order_key,v.entry_id)
      FROM (
        SELECT e.entry_id,e.resource_kind,e.resource_id,e.parent_folder_id,e.display_name,
          e.description,e.published_version_id,e.order_key,
          row_number() OVER(PARTITION BY e.parent_folder_id ORDER BY e.order_key,e.entry_id)::integer sibling_position
        FROM published_structure_entry e
        WHERE e.room_id=r.id AND (e.resource_kind='folder' OR (e.published_version_id IS NOT NULL
          AND version_has_publication_evidence(e.published_version_id,e.resource_id)))
      ) v
    ),'[]'::jsonb))
    FROM room r WHERE r.id=p_room_id
  );
END $$;

-- The audit row commits with the read, and only when something is disclosed.
CREATE FUNCTION read_member_preview_document(p_actor_id text,p_room_id text,p_document_id text,
  p_audit_id text,p_correlation_id text)
RETURNS TABLE(document_id text,display_title text,published_version_id text,page_count integer,
  download_policy text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected record;
BEGIN
  PERFORM assert_member_preview(p_actor_id,p_room_id);
  SELECT p.resource_id id,p.display_name::text title,p.published_version_id version_id,
    count(d.id)::integer pages,resolve_document_download_policy(p.resource_id) policy
  INTO selected
  FROM published_structure_entry p
  JOIN document_derivative d ON d.version_id=p.published_version_id
  WHERE p.room_id=p_room_id AND p.resource_kind='document' AND p.resource_id=p_document_id
    AND version_has_publication_evidence(p.published_version_id,p.resource_id)
  GROUP BY p.resource_id,p.display_name,p.published_version_id;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'room.preview.document','member',p_actor_id,p_room_id,'document',p_document_id,
    'success','INVESTOR_PREVIEW',p_correlation_id,jsonb_build_object('versionId',selected.version_id));
  RETURN QUERY SELECT selected.id,selected.title,selected.version_id,selected.pages,selected.policy;
END $$;

-- Always the currently published version, so a republication mid-preview serves the
-- new derivative and a page past its end returns nothing.
CREATE FUNCTION read_member_preview_page(p_actor_id text,p_room_id text,p_document_id text,
  p_page_number integer)
RETURNS TABLE(version_id text,object_key text,media_type text,accessible_label text,text_layer jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_member_preview(p_actor_id,p_room_id);
  RETURN QUERY
  SELECT p.published_version_id,d.object_key,d.media_type,d.accessible_label,d.text_layer
  FROM published_structure_entry p
  JOIN document_derivative d ON d.version_id=p.published_version_id AND d.page_number=p_page_number
  WHERE p.room_id=p_room_id AND p.resource_kind='document' AND p.resource_id=p_document_id
    AND version_has_publication_evidence(p.published_version_id,p.resource_id);
END $$;

REVOKE ALL ON FUNCTION assert_member_preview(text,text),
  read_member_preview_room(text,text),
  read_member_preview_document(text,text,text,text,text),
  read_member_preview_page(text,text,text,integer)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION read_member_preview_room(text,text),
  read_member_preview_document(text,text,text,text,text),
  read_member_preview_page(text,text,text,integer)
  TO duefold_runtime;

ALTER FUNCTION assert_member_preview(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_member_preview_room(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_member_preview_document(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_member_preview_page(text,text,text,integer) OWNER TO duefold_migration;
