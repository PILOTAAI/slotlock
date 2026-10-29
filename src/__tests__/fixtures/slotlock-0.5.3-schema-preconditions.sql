-- 0.5.3's schema preconditions (SLOTLOCK_SCHEMA_PRECONDITIONS in src/ddl.ts at 496f240, constants filled
-- in), the check every 0.5.x applySchema and slotlock migrate runs before changing anything.
DO $slotlock_schema_preconditions$
DECLARE
  installed integer;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 160000 THEN
    RAISE EXCEPTION 'Slotlock needs PostgreSQL 16 or later; this server is %',
      pg_catalog.current_setting('server_version')
      USING ERRCODE = 'feature_not_supported';
  END IF;
  IF pg_catalog.to_regclass('slotlock.schema_version') IS NOT NULL THEN
    EXECUTE 'SELECT version FROM slotlock.schema_version WHERE singleton' INTO installed;
    IF installed > 3 THEN
      RAISE EXCEPTION 'Slotlock will not migrate a schema a newer release migrated (version %; this release is version 3)', installed
        USING ERRCODE = 'object_not_in_prerequisite_state',
              HINT = 'Migrate and serve it with the release that migrated it, or a later one.';
    END IF;
  END IF;
END
$slotlock_schema_preconditions$;
