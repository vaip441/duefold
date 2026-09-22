-- Reuse of per-session watermarked pages. Immutable after application.

/*
 * A page composited earlier in this session is delivered again rather than
 * recomposited. Reuse is bound to the presented session, the currently published
 * version, and today's UTC date, so a republication or a new day composites a
 * fresh page and the watermark never shows a stale access date. Delivery still
 * rechecks authorization and records the page, so reuse changes cost, not evidence.
 */
CREATE FUNCTION find_active_watermark_cache(p_session_digest text,p_room_id text,
  p_document_id text,p_page_number integer)
RETURNS TABLE(cache_id text,expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT c.id,c.expires_at
  FROM resolve_presented_viewer(p_session_digest) i
  JOIN watermark_cache c ON c.viewer_id=i.viewer_id AND c.session_id=i.session_id
  JOIN published_structure_entry p ON p.room_id=c.room_id AND p.resource_kind='document'
    AND p.resource_id=c.document_id AND p.published_version_id=c.version_id
  WHERE c.room_id=p_room_id AND c.document_id=p_document_id AND c.page_number=p_page_number
    AND c.state='active' AND c.expires_at>statement_timestamp()
    AND c.access_date=(statement_timestamp() AT TIME ZONE 'UTC')::date
    AND viewer_can_preview_document(i.viewer_id,i.session_id,p_room_id,p_document_id)
  ORDER BY c.created_at DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION find_active_watermark_cache(text,text,text,integer)
  FROM PUBLIC,duefold_runtime,duefold_worker,duefold_authenticator;
GRANT EXECUTE ON FUNCTION find_active_watermark_cache(text,text,text,integer) TO duefold_runtime;
ALTER FUNCTION find_active_watermark_cache(text,text,text,integer) OWNER TO duefold_migration;
