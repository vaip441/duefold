-- Persisted organization branding configuration.
-- The optional branding module owns custom branding fields. The public
-- projection exposes support contact only; the manager projection remains private.

CREATE FUNCTION protect_branding_organization_name() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name AND current_user<>'duefold_migration' THEN
    RAISE EXCEPTION 'organization name is branding-function only' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER branding_organization_name_guard
BEFORE UPDATE OF name ON organization
FOR EACH ROW EXECUTE FUNCTION protect_branding_organization_name();

CREATE FUNCTION branding_srgb_channel(p_value integer) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_value/255.0<=0.04045 THEN (p_value/255.0)/12.92
    ELSE power(((p_value/255.0)+0.055)/1.055,2.4) END
$$;
CREATE FUNCTION branding_luminance(p_hex text) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 0.2126*branding_srgb_channel(('x'||substr(p_hex,2,2))::bit(8)::integer)
    +0.7152*branding_srgb_channel(('x'||substr(p_hex,4,2))::bit(8)::integer)
    +0.0722*branding_srgb_channel(('x'||substr(p_hex,6,2))::bit(8)::integer)
  WHERE p_hex ~ '^#[0-9a-f]{6}$'
$$;
CREATE FUNCTION valid_branding_accent(p_hex text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH values AS (
    SELECT branding_luminance(p_hex) accent,
      branding_luminance('#f2f3f1') light_ground,
      branding_luminance('#161a18') dark_ground
  )
  SELECT p_hex ~ '^#[0-9a-f]{6}$'
    AND (greatest(accent,light_ground)+0.05)/(least(accent,light_ground)+0.05)>=3.0
    AND (greatest(accent,dark_ground)+0.05)/(least(accent,dark_ground)+0.05)>=3.0
  FROM values
$$;

CREATE TABLE branding_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  accent_color text NOT NULL DEFAULT '#08766a' CHECK (valid_branding_accent(accent_color)),
  sender_display_name text NOT NULL DEFAULT 'Duefold' CHECK (valid_structure_text(sender_display_name,200,false)),
  room_introduction text NOT NULL DEFAULT '' CHECK (valid_structure_text(room_introduction,2000,true)),
  support_contact text,
  support_contact_kind text CHECK (support_contact_kind IN ('email','url')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((support_contact IS NULL)=(support_contact_kind IS NULL)),
  CHECK (support_contact IS NULL OR (
    support_contact_kind='email' AND canonical_email_key(lower(support_contact))
  ) OR (
    support_contact_kind='url' AND support_contact ~ '^https://[^[:space:][:cntrl:]]+$'
      AND support_contact !~ '^https://[^/]*@'
  ))
);
INSERT INTO branding_configuration(singleton) VALUES(true);

CREATE FUNCTION read_public_support_contact()
RETURNS TABLE(kind text,value text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT support_contact_kind,support_contact FROM branding_configuration
  WHERE singleton AND support_contact IS NOT NULL
$$;

CREATE FUNCTION read_branding_configuration(p_actor_id text,p_room_id text)
RETURNS TABLE(organization_name text,accent_color text,sender_display_name text,
  room_introduction text,support_contact text,revision integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'branding management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT o.name,b.accent_color,b.sender_display_name,
    b.room_introduction,b.support_contact,b.revision
  FROM branding_configuration b CROSS JOIN organization o WHERE b.singleton;
END $$;

CREATE FUNCTION update_branding_configuration(
  p_actor_id text,p_room_id text,p_organization_name text,p_accent_color text,
  p_sender_display_name text,p_room_introduction text,p_support_contact text,
  p_support_contact_kind text,p_expected_revision integer,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'branding management forbidden' USING ERRCODE='42501';
  END IF;
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
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
    result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'branding.configuration','member',p_actor_id,p_room_id,'branding','configuration',
    'success','BRANDING_CONFIGURATION_CHANGED',p_correlation_id,
    jsonb_build_object('revision',next_revision,'supportContactConfigured',p_support_contact IS NOT NULL));
  RETURN next_revision;
END $$;

ALTER TABLE branding_configuration OWNER TO duefold_migration;
ALTER FUNCTION protect_branding_organization_name() OWNER TO duefold_migration;
ALTER FUNCTION branding_srgb_channel(integer) OWNER TO duefold_migration;
ALTER FUNCTION branding_luminance(text) OWNER TO duefold_migration;
ALTER FUNCTION valid_branding_accent(text) OWNER TO duefold_migration;
REVOKE ALL ON branding_configuration FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
REVOKE ALL ON FUNCTION read_public_support_contact(),read_branding_configuration(text,text),
 update_branding_configuration(text,text,text,text,text,text,text,text,integer,text,text)
 FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
GRANT EXECUTE ON FUNCTION read_public_support_contact(),read_branding_configuration(text,text),
 update_branding_configuration(text,text,text,text,text,text,text,text,integer,text,text)
 TO duefold_runtime;
ALTER FUNCTION read_public_support_contact() OWNER TO duefold_migration;
ALTER FUNCTION read_branding_configuration(text,text) OWNER TO duefold_migration;
ALTER FUNCTION update_branding_configuration(text,text,text,text,text,text,text,text,integer,text,text) OWNER TO duefold_migration;
