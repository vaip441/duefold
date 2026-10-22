-- Two tabs of one session share one activity row, so a beat inside the 50-second window
-- is still authorized and answers true; it is only not recorded. A false answer is kept
-- for an activity that has ended or is no longer authorized.
CREATE OR REPLACE FUNCTION heartbeat_preview(p_activity_id text,p_session_digest text)
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
  IF selected.heartbeat_at<=statement_timestamp()-interval '50 seconds' THEN
    UPDATE preview_activity SET heartbeat_at=statement_timestamp() WHERE id=p_activity_id;
  END IF;
  RETURN true;
END $$;
