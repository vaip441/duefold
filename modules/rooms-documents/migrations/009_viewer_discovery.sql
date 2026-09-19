-- Digest-bound viewer discovery.
--
-- The pre-existing viewer projections accepted caller-supplied viewer/session
-- identifiers. They remain internal composition helpers, but the shared web role
-- may reach discovery only through these session-digest entry points. Identity is
-- resolved from the presented credential in the database before any room,
-- structure, search, or document metadata is read.

/*
 * A room appears only when at least one document the viewer can actually reach
 * has publication evidence. Checking for an effective grant alone leaked the
 * title of a room whose granted content was not ready -- an effective grant is
 * necessary but never sufficient. Reuse read_viewer_published_structure rather
 * than re-deriving visibility: it already resolves grant scope, folder-subtree
 * reachability, publication state, and version readiness, and a second
 * definition here would drift out of agreement with the structure reader.
 */
CREATE FUNCTION read_presented_viewer_rooms(p_session_digest text)
RETURNS TABLE(room_id text,title text,description text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.id,r.title,r.description
  FROM resolve_presented_viewer(p_session_digest) i
  JOIN viewer_room_membership m ON m.viewer_id=i.viewer_id AND m.state='active'
  JOIN room r ON r.id=m.room_id AND r.state='published'
  WHERE EXISTS(
    SELECT 1 FROM read_viewer_published_structure(i.viewer_id,i.session_id,r.id) p
    WHERE p.resource_kind='document' AND p.published_version_id IS NOT NULL
  )
  ORDER BY canonical_structure_name(r.title),r.id
$$;

CREATE FUNCTION read_presented_viewer_structure(p_session_digest text,p_room_id text)
RETURNS TABLE(entry_id text,resource_kind text,resource_id text,parent_folder_id text,
  display_name text,description text,published_version_id text,sibling_position integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p.entry_id,p.resource_kind,p.resource_id,p.parent_folder_id,p.display_name,
    p.description,p.published_version_id,
    row_number() OVER(PARTITION BY p.parent_folder_id ORDER BY p.order_key,p.entry_id)::integer
  FROM resolve_presented_viewer(p_session_digest) i
  CROSS JOIN LATERAL read_viewer_published_structure(i.viewer_id,i.session_id,p_room_id) p
  ORDER BY p.order_key,p.entry_id
$$;

CREATE FUNCTION search_presented_viewer_structure(
  p_session_digest text,p_room_id text,p_query text,p_limit integer
) RETURNS TABLE(resource_kind text,resource_id text,display_name text,description text,path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p.resource_kind,p.resource_id,p.display_name,p.description,p.path
  FROM resolve_presented_viewer(p_session_digest) i
  CROSS JOIN LATERAL read_viewer_published_search(
    i.viewer_id,i.session_id,p_room_id,p_query,p_limit
  ) p
$$;

CREATE FUNCTION read_presented_viewer_document_metadata(
  p_session_digest text,p_room_id text,p_document_id text
) RETURNS TABLE(document_id text,display_title text,published_version_id text,
  page_count integer,download_policy text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p.resource_id,p.display_name,p.published_version_id,
    count(d.id)::integer,resolve_document_download_policy(p.resource_id)
  FROM resolve_presented_viewer(p_session_digest) i
  JOIN published_structure_entry p
    ON p.room_id=p_room_id AND p.resource_kind='document' AND p.resource_id=p_document_id
  JOIN document_version v ON v.id=p.published_version_id
  JOIN document_derivative d ON d.version_id=v.id
  WHERE viewer_can_preview_document(i.viewer_id,i.session_id,p_room_id,p_document_id)
  GROUP BY p.resource_id,p.display_name,p.published_version_id
$$;

-- Caller-supplied identity is not a production authorization boundary.
REVOKE ALL ON FUNCTION read_viewer_published_structure(text,text,text),
  read_viewer_published_search(text,text,text,text,integer)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;

REVOKE ALL ON FUNCTION read_presented_viewer_rooms(text),
  read_presented_viewer_structure(text,text),
  search_presented_viewer_structure(text,text,text,integer),
  read_presented_viewer_document_metadata(text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION read_presented_viewer_rooms(text),
  read_presented_viewer_structure(text,text),
  search_presented_viewer_structure(text,text,text,integer),
  read_presented_viewer_document_metadata(text,text,text)
  TO duefold_runtime;

ALTER FUNCTION read_presented_viewer_rooms(text) OWNER TO duefold_migration;
ALTER FUNCTION read_presented_viewer_structure(text,text) OWNER TO duefold_migration;
ALTER FUNCTION search_presented_viewer_structure(text,text,text,integer) OWNER TO duefold_migration;
ALTER FUNCTION read_presented_viewer_document_metadata(text,text,text) OWNER TO duefold_migration;
