-- Whether the organization logo already carries the organization name. Immutable after application.

/*
 * The header used to treat every uploaded logo as a full wordmark and hide the name,
 * so a square mark left the organization unnamed. An administrator now states whether
 * the logo includes the name. The default is false, so an existing logo gains the name
 * beside it rather than losing it: a repeated name is recoverable at a glance, a
 * missing one is not.
 */
ALTER TABLE branding_configuration
  ADD COLUMN logo_includes_name boolean NOT NULL DEFAULT false;

DROP FUNCTION read_public_branding();
DROP FUNCTION read_branding_configuration(text);
DROP FUNCTION update_branding_configuration(text,text,text,text,text,text,text,integer,text,text);

CREATE FUNCTION read_public_branding()
RETURNS TABLE(
  organization_name text,
  accent_color text,
  has_logo boolean,
  has_square_mark boolean,
  logo_includes_name boolean,
  support_contact_kind text,
  support_contact text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT o.name,b.accent_color,
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='logo'),
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='square-mark'),
    b.logo_includes_name,
    b.support_contact_kind,b.support_contact
  FROM branding_configuration b CROSS JOIN organization o WHERE b.singleton;
$$;

CREATE FUNCTION read_branding_configuration(p_actor_id text)
RETURNS TABLE(organization_name text,accent_color text,sender_display_name text,
  room_introduction text,support_contact text,revision integer,has_logo boolean,
  has_square_mark boolean,logo_includes_name boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY SELECT o.name,b.accent_color,
    COALESCE(b.sender_display_name,o.name),
    b.room_introduction,b.support_contact,b.revision,
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='logo'),
    EXISTS(SELECT 1 FROM branding_asset WHERE asset_kind='square-mark'),
    b.logo_includes_name
  FROM branding_configuration b CROSS JOIN organization o WHERE b.singleton;
END $$;

CREATE FUNCTION update_branding_configuration(
  p_actor_id text,p_organization_name text,p_accent_color text,
  p_sender_display_name text,p_room_introduction text,p_support_contact text,
  p_support_contact_kind text,p_logo_includes_name boolean,p_expected_revision integer,
  p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF NOT valid_structure_text(p_organization_name,200,false)
     OR NOT valid_structure_text(p_sender_display_name,200,false)
     OR NOT valid_structure_text(p_room_introduction,2000,true)
     OR NOT valid_branding_accent(p_accent_color)
     OR p_logo_includes_name IS NULL THEN
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
    support_contact_kind=p_support_contact_kind,logo_includes_name=p_logo_includes_name,
    revision=revision+1,updated_at=statement_timestamp()
  WHERE singleton AND revision=p_expected_revision RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'stale branding revision' USING ERRCODE='40001';
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'branding.configuration','member',p_actor_id,'branding','configuration',
    'success','BRANDING_CONFIGURATION_CHANGED',p_correlation_id,
    jsonb_build_object('revision',next_revision,'supportContactConfigured',p_support_contact IS NOT NULL,
      'logoIncludesName',p_logo_includes_name));
  RETURN next_revision;
END $$;

REVOKE ALL ON FUNCTION read_public_branding(),read_branding_configuration(text),
  update_branding_configuration(text,text,text,text,text,text,text,boolean,integer,text,text)
FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
GRANT EXECUTE ON FUNCTION read_public_branding(),read_branding_configuration(text),
  update_branding_configuration(text,text,text,text,text,text,text,boolean,integer,text,text)
TO duefold_runtime;
ALTER FUNCTION read_public_branding() OWNER TO duefold_migration;
ALTER FUNCTION read_branding_configuration(text) OWNER TO duefold_migration;
ALTER FUNCTION update_branding_configuration(text,text,text,text,text,text,text,boolean,integer,text,text)
  OWNER TO duefold_migration;
