-- The caller-supplied-identity viewer authorizers are internal composition helpers.
--
-- They trust whatever viewer and session identifiers they are handed, so a web-role
-- caller could ask about any viewer. The SECURITY DEFINER entry points that resolve
-- identity from the presented session digest keep calling them as their owner.
REVOKE EXECUTE ON FUNCTION viewer_can_preview_document(text,text,text,text),
 authorize_viewer_published_room(text,text,text),
 read_viewer_document_download_policy(text,text,text,text)
 FROM duefold_runtime;
