-- Who required mail says it comes from. Immutable after application.

/*
 * Mail names the organization so a recipient knows who invited them, and sends as it.
 * This is an extension point: the optional branding module's 032 migration replaces
 * the function to return its configured sender name. Only those two migrations may
 * define it (test/unit/mail-identity-migrations.test.ts).
 */
CREATE FUNCTION read_mail_identity()
RETURNS TABLE(organization_name text,sender_display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT o.name,o.name FROM organization o
$$;

REVOKE ALL ON FUNCTION read_mail_identity()
  FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;
GRANT EXECUTE ON FUNCTION read_mail_identity() TO duefold_worker;
ALTER FUNCTION read_mail_identity() OWNER TO duefold_migration;
