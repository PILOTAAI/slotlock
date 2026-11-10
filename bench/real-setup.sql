-- The write workloads against Slotlock's own schema (RFC 0004 A7), beside RFC 0002's two designs:
-- its reservations table, with the exclusion constraint, the triggers that keep occupied time,
-- composite claims and the change feed, and the indexes, as a booking meets them once the store's
-- checks have passed. Needs the schema applied (slotlock migrate) and a role past row-level
-- security, as the bench's own superuser is. Run after setup.sql, which makes slotlock_bench.
INSERT INTO slotlock.resources (tenant_ref, external_ref, timezone)
SELECT 'slotlock-bench', 'bench-' || n, 'UTC' FROM generate_series(1, 1000) n
ON CONFLICT DO NOTHING;

CREATE TABLE slotlock_bench.real_resources (n integer PRIMARY KEY, id uuid NOT NULL);
INSERT INTO slotlock_bench.real_resources
SELECT substring(external_ref FROM 7)::integer, id FROM slotlock.resources
 WHERE tenant_ref = 'slotlock-bench';

CREATE FUNCTION slotlock_bench.book_real(r integer, starts timestamptz, minutes integer)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO slotlock.reservations (resource_id, tenant_ref, external_ref, starts_at, ends_at, source)
  SELECT id, 'slotlock-bench', gen_random_uuid()::text, starts, starts + make_interval(mins => minutes), 'bench'
    FROM slotlock_bench.real_resources WHERE n = r;
  RETURN true;
EXCEPTION WHEN exclusion_violation THEN
  RETURN false;
END $$;

-- Every run starts empty, as the two designs' do.
CREATE FUNCTION slotlock_bench.reset_real() RETURNS void LANGUAGE sql AS $$
  DELETE FROM slotlock.reservations WHERE tenant_ref = 'slotlock-bench';
  DELETE FROM slotlock.outbox WHERE tenant_ref = 'slotlock-bench';
$$;
