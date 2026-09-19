-- Public projection of effective branding and delivery routes for processed brand assets.
-- Served derivatives only; quarantined uploads are never exposed.

CREATE FUNCTION read_public_branding()
RETURNS TABLE(
  organization_name text,
  accent_color text,
  has_logo boolean,
  has_square_mark boolean,
  support_contact_kind text,
  support_contact text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    o.name AS organization_name,
    b.accent_color,
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='logo') AS has_logo,
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='square-mark') AS has_square_mark,
    b.support_contact_kind,
    b.support_contact
  FROM branding_configuration b
  CROSS JOIN organization o
  WHERE b.singleton;
$$;

CREATE FUNCTION read_viewer_branding_introduction(p_session_digest text)
RETURNS TABLE(room_introduction text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT b.room_introduction
  FROM resolve_presented_viewer(p_session_digest) i
  CROSS JOIN branding_configuration b
  WHERE b.singleton
    AND EXISTS(
      SELECT 1
      FROM viewer_room_membership m
      JOIN room r ON r.id=m.room_id AND r.state='published'
      WHERE m.viewer_id=i.viewer_id AND m.state='active'
        AND EXISTS(
          SELECT 1 FROM read_viewer_published_structure(i.viewer_id,i.session_id,r.id) p
          WHERE p.resource_kind='document' AND p.published_version_id IS NOT NULL
        )
    )
$$;

CREATE FUNCTION read_public_branding_asset(p_kind text)
RETURNS TABLE(object_key text, media_type text, size_bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT object_key, media_type, size_bytes FROM branding_asset
  WHERE asset_kind = p_kind;
$$;

CREATE FUNCTION read_branding_asset_for_delete(
  p_actor_id text,
  p_room_id text,
  p_asset_kind text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_key text;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id, p_room_id, true) THEN
    RAISE EXCEPTION 'branding asset deletion forbidden' USING ERRCODE='42501';
  END IF;
  IF p_asset_kind NOT IN ('logo', 'square-mark') THEN
    RAISE EXCEPTION 'invalid asset kind' USING ERRCODE='22023';
  END IF;
  SELECT object_key INTO v_key FROM branding_asset
  WHERE asset_kind = p_asset_kind FOR UPDATE;
  RETURN v_key;
END $$;

CREATE FUNCTION delete_branding_asset(
  p_actor_id text,
  p_room_id text,
  p_asset_kind text,
  p_audit_id text,
  p_correlation_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_key text;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id, p_room_id, true) THEN
    RAISE EXCEPTION 'branding asset deletion forbidden' USING ERRCODE='42501';
  END IF;
  IF p_asset_kind NOT IN ('logo', 'square-mark') THEN
    RAISE EXCEPTION 'invalid asset kind' USING ERRCODE='22023';
  END IF;
  DELETE FROM branding_asset WHERE asset_kind = p_asset_kind RETURNING object_key INTO v_key;
  IF v_key IS NOT NULL THEN
    INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
      result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'branding.asset.delete','member',p_actor_id,p_room_id,'branding_asset',p_asset_kind,
      'success','BRANDING_ASSET_DELETED',p_correlation_id,
      jsonb_build_object('assetKind',p_asset_kind));
  END IF;
  RETURN v_key;
END $$;

DROP FUNCTION IF EXISTS read_branding_configuration(text,text);
CREATE FUNCTION read_branding_configuration(p_actor_id text,p_room_id text)
RETURNS TABLE(organization_name text,accent_color text,sender_display_name text,
  room_introduction text,support_contact text,revision integer,has_logo boolean,has_square_mark boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'branding management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT o.name,b.accent_color,b.sender_display_name,
    b.room_introduction,b.support_contact,b.revision,
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='logo'),
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='square-mark')
  FROM branding_configuration b CROSS JOIN organization o WHERE b.singleton;
END $$;

CREATE FUNCTION read_effective_mail_sender()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT b.sender_display_name FROM branding_configuration b WHERE b.singleton;
$$;

ALTER FUNCTION read_public_branding() OWNER TO duefold_migration;
ALTER FUNCTION read_viewer_branding_introduction(text) OWNER TO duefold_migration;
ALTER FUNCTION read_public_branding_asset(text) OWNER TO duefold_migration;
ALTER FUNCTION read_branding_asset_for_delete(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION delete_branding_asset(text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_branding_configuration(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_effective_mail_sender() OWNER TO duefold_migration;

REVOKE ALL ON FUNCTION read_public_branding(), read_viewer_branding_introduction(text),
 read_public_branding_asset(text),
 read_branding_asset_for_delete(text,text,text), delete_branding_asset(text,text,text,text,text),
 read_branding_configuration(text,text), read_effective_mail_sender()
 FROM PUBLIC, duefold_runtime, duefold_authenticator, duefold_worker;

GRANT EXECUTE ON FUNCTION read_public_branding(), read_viewer_branding_introduction(text),
 read_public_branding_asset(text),
 read_branding_asset_for_delete(text,text,text), delete_branding_asset(text,text,text,text,text),
 read_branding_configuration(text,text), read_effective_mail_sender()
 TO duefold_runtime;

GRANT EXECUTE ON FUNCTION read_effective_mail_sender() TO duefold_worker;
