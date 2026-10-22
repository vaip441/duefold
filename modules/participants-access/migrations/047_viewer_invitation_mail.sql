-- A non-pending invitation yields a row with a NULL address so the job completes instead
-- of failing every retry: one pending row serves several rooms (037).
CREATE OR REPLACE FUNCTION read_viewer_invitation_mail(p_invitation_id text,p_room_id text,
  p_job_id text,p_owner text,p_token text)
RETURNS TABLE(email_display text,room_alias text,occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN i.state='pending' AND i.expires_at>statement_timestamp()
      THEN i.email_display END,
    'ROOM-'||upper(substr(md5(r.id),1,10)),i.created_at
  FROM invitation i JOIN viewer v ON v.email_key=i.email_key
  JOIN viewer_room_membership m ON m.viewer_id=v.id AND m.room_id=p_room_id
  JOIN room r ON r.id=m.room_id JOIN job_queue j ON j.id=p_job_id
  WHERE i.id=p_invitation_id AND i.kind='viewer' AND j.job_type='mail.viewer_invitation'
    AND j.payload->>'invitationId'=i.id AND j.payload->>'roomId'=r.id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()
$$;
