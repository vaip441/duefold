-- Grant impact counts what the grantee can read, not only the draft.
--
-- Viewer access follows published_structure_entry, which keeps content the draft has
-- staged for removal or moved elsewhere until the next publication, and a draft room
-- re-exposes its published structure when it returns to published. The working tree is
-- what the next publication exposes. Counting each resource reached through either
-- tree never understates what the grant exposes now or after publication.
CREATE OR REPLACE FUNCTION grant_target_impact(p_room_id text,p_target_kind text,p_folder_id text,p_document_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE entries AS (
    SELECT COALESCE(e.folder_id,e.document_id) resource_id,e.folder_id IS NOT NULL is_folder,
      e.parent_folder_id,e.display_name,false published
    FROM working_structure_entry e WHERE e.room_id=p_room_id AND NOT e.staged_removed
    UNION ALL
    SELECT p.resource_id,p.resource_kind='folder',p.parent_folder_id,p.display_name,true
    FROM published_structure_entry p WHERE p.room_id=p_room_id
  ), paths AS (
    SELECT e.resource_id,e.is_folder,e.published,e.display_name::text full_path,
      (p_target_kind='room'
        OR (p_target_kind='folder' AND e.is_folder AND e.resource_id=p_folder_id)
        OR (p_target_kind='document' AND NOT e.is_folder AND e.resource_id=p_document_id)) affected
    FROM entries e WHERE e.parent_folder_id IS NULL
    UNION ALL
    SELECT e.resource_id,e.is_folder,e.published,(p.full_path||' / '||e.display_name)::text,
      (p.affected
        OR (p_target_kind='folder' AND e.is_folder AND e.resource_id=p_folder_id)
        OR (p_target_kind='document' AND NOT e.is_folder AND e.resource_id=p_document_id))
    FROM paths p JOIN entries e ON e.published=p.published AND e.parent_folder_id=p.resource_id
    WHERE p.is_folder
  ), affected AS (
    SELECT resource_id,full_path FROM paths WHERE affected
  )
  SELECT jsonb_build_object(
    'affectedCount',(SELECT count(DISTINCT resource_id)::integer FROM affected),
    'paths',(SELECT COALESCE(jsonb_agg(full_path ORDER BY full_path),'[]'::jsonb)
      FROM (SELECT DISTINCT full_path FROM affected) distinct_paths))
$$;
