-- Manager-authorized participant and grant discovery.
-- Runtime retains no table privileges; this projection authorizes before returning
-- protected viewer identity, counterparty membership, or grant details.

CREATE FUNCTION read_room_participants(p_actor_id text,p_room_id text)
RETURNS TABLE(viewer_id text,email_display text,membership_state text,membership_revision integer,
  counterparty_id text,counterparty_name text,grants jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT m.viewer_id,v.email_display,m.state,m.revision,c.id,c.name,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'grantId',g.id,
        'source',CASE WHEN g.grantee_kind='viewer' THEN 'direct' ELSE 'counterparty' END,
        'targetKind',g.target_kind,
        'folderId',g.folder_id,
        'documentId',g.document_id,
        'expiresAt',g.expires_at,
        'effective',g.state='active' AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp()),
        'revision',g.revision
      ) ORDER BY g.created_at,g.id)
      FROM access_grant g
      WHERE g.room_id=p_room_id AND g.state='active'
        AND ((g.grantee_kind='viewer' AND g.viewer_id=m.viewer_id)
          OR (g.grantee_kind='counterparty' AND g.counterparty_id=c.id))
    ),'[]'::jsonb)
  FROM viewer_room_membership m
  JOIN viewer v ON v.id=m.viewer_id
  LEFT JOIN counterparty_viewer cv ON cv.viewer_id=m.viewer_id AND cv.room_id=m.room_id
    AND cv.state='active'
  LEFT JOIN counterparty c ON c.id=cv.counterparty_id AND c.room_id=cv.room_id
  WHERE m.room_id=p_room_id
  ORDER BY lower(v.email_display),m.viewer_id;
END $$;

REVOKE ALL ON FUNCTION read_room_participants(text,text) FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
GRANT EXECUTE ON FUNCTION read_room_participants(text,text) TO duefold_runtime;
ALTER FUNCTION read_room_participants(text,text) OWNER TO duefold_migration;
