-- Organization branding is administered by Owners and Admins. Immutable after application.

/*
 * Branding is installation-wide, so it was wrong to authorize it through a room: any
 * Room Manager could rename the organization, while logo uploads already required an
 * Owner or Admin. Every branding mutation now takes the same organization gate.
 *
 * An unchosen sender name is NULL rather than the old 'Duefold' default, so every
 * reader falls back to the organization name. A never-saved row still holds that
 * default and is cleared.
 */
ALTER TABLE branding_configuration
  ALTER COLUMN sender_display_name DROP NOT NULL,
  ALTER COLUMN sender_display_name DROP DEFAULT;
UPDATE branding_configuration SET sender_display_name=NULL WHERE revision=1;

DROP FUNCTION read_branding_configuration(text,text);
DROP FUNCTION update_branding_configuration(text,text,text,text,text,text,text,text,integer,text,text);
DROP FUNCTION read_branding_asset_for_delete(text,text,text);
DROP FUNCTION delete_branding_asset(text,text,text,text,text);
DROP FUNCTION read_effective_mail_sender();

CREATE FUNCTION read_branding_configuration(p_actor_id text)
RETURNS TABLE(organization_name text,accent_color text,sender_display_name text,
  room_introduction text,support_contact text,revision integer,has_logo boolean,has_square_mark boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY SELECT o.name,b.accent_color,
    COALESCE(b.sender_display_name,o.name),
    b.room_introduction,b.support_contact,b.revision,
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='logo'),
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='square-mark')
  FROM branding_configuration b CROSS JOIN organization o WHERE b.singleton;
END $$;

CREATE FUNCTION update_branding_configuration(
  p_actor_id text,p_organization_name text,p_accent_color text,
  p_sender_display_name text,p_room_introduction text,p_support_contact text,
  p_support_contact_kind text,p_expected_revision integer,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF NOT valid_structure_text(p_organization_name,200,false)
     OR NOT valid_structure_text(p_sender_display_name,200,false)
     OR NOT valid_structure_text(p_room_introduction,2000,true)
     OR NOT valid_branding_accent(p_accent_color) THEN
    RAISE EXCEPTION 'invalid branding configuration' USING ERRCODE='22023';
  END IF;
  IF p_support_contact_kind IS NOT NULL AND p_support_contact_kind NOT IN ('email','url') THEN
    RAISE EXCEPTION 'invalid support contact kind' USING ERRCODE='22023';
  END IF;
  UPDATE organization SET name=p_organization_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization unavailable' USING ERRCODE='55000';
  END IF;
  UPDATE branding_configuration SET accent_color=p_accent_color,
    sender_display_name=p_sender_display_name,
    room_introduction=p_room_introduction,support_contact=p_support_contact,
    support_contact_kind=p_support_contact_kind,revision=revision+1,
    updated_at=statement_timestamp()
  WHERE singleton AND revision=p_expected_revision RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'stale branding revision' USING ERRCODE='40001';
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'branding.configuration','member',p_actor_id,'branding','configuration',
    'success','BRANDING_CONFIGURATION_CHANGED',p_correlation_id,
    jsonb_build_object('revision',next_revision,'supportContactConfigured',p_support_contact IS NOT NULL));
  RETURN next_revision;
END $$;

CREATE FUNCTION read_branding_asset_for_delete(p_actor_id text,p_asset_kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_key text;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_asset_kind NOT IN ('logo','square-mark') THEN
    RAISE EXCEPTION 'invalid asset kind' USING ERRCODE='22023';
  END IF;
  SELECT object_key INTO v_key FROM branding_asset WHERE asset_kind=p_asset_kind FOR UPDATE;
  RETURN v_key;
END $$;

CREATE FUNCTION delete_branding_asset(
  p_actor_id text,p_asset_kind text,p_audit_id text,p_correlation_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_key text;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_asset_kind NOT IN ('logo','square-mark') THEN
    RAISE EXCEPTION 'invalid asset kind' USING ERRCODE='22023';
  END IF;
  DELETE FROM branding_asset WHERE asset_kind=p_asset_kind RETURNING object_key INTO v_key;
  IF v_key IS NOT NULL THEN
    INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,resource_id,
      result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'branding.asset.delete','member',p_actor_id,'branding_asset',p_asset_kind,
      'success','BRANDING_ASSET_DELETED',p_correlation_id,jsonb_build_object('assetKind',p_asset_kind));
  END IF;
  RETURN v_key;
END $$;

/* Core's mail identity is the extension point this module fills: with the module
   composed, required mail carries the chosen sender name. A guard test fails if any
   other migration redefines it. */
CREATE OR REPLACE FUNCTION read_mail_identity()
RETURNS TABLE(organization_name text,sender_display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT o.name,COALESCE(b.sender_display_name,o.name)
  FROM organization o CROSS JOIN branding_configuration b WHERE b.singleton
$$;

REVOKE ALL ON FUNCTION read_branding_configuration(text),
  update_branding_configuration(text,text,text,text,text,text,text,integer,text,text),
  read_branding_asset_for_delete(text,text),delete_branding_asset(text,text,text,text)
FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
GRANT EXECUTE ON FUNCTION read_branding_configuration(text),
  update_branding_configuration(text,text,text,text,text,text,text,integer,text,text),
  read_branding_asset_for_delete(text,text),delete_branding_asset(text,text,text,text)
TO duefold_runtime;
ALTER FUNCTION read_branding_configuration(text) OWNER TO duefold_migration;
ALTER FUNCTION update_branding_configuration(text,text,text,text,text,text,text,integer,text,text)
  OWNER TO duefold_migration;
ALTER FUNCTION read_branding_asset_for_delete(text,text) OWNER TO duefold_migration;
ALTER FUNCTION delete_branding_asset(text,text,text,text) OWNER TO duefold_migration;
