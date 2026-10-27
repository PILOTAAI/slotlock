-- The two designs RFC 0002 compares, in a schema of their own: Slotlock's range exclusion
-- constraint, and one row per 15-minute slot with a primary key. Each books through a function
-- that catches its conflict, as a server would, so a refused booking is an answer, not an error.
DROP SCHEMA IF EXISTS slotlock_bench CASCADE;
CREATE SCHEMA slotlock_bench;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE slotlock_bench.ranges (
  resource integer NOT NULL,
  during tstzrange NOT NULL,
  EXCLUDE USING gist (resource WITH =, during WITH &&)
);

CREATE TABLE slotlock_bench.slots (
  resource integer NOT NULL,
  slot timestamptz NOT NULL,
  PRIMARY KEY (resource, slot)
);

CREATE FUNCTION slotlock_bench.book_range(r integer, starts timestamptz, minutes integer)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO slotlock_bench.ranges VALUES (r, tstzrange(starts, starts + make_interval(mins => minutes), '[)'));
  RETURN true;
EXCEPTION WHEN exclusion_violation THEN
  RETURN false;
END $$;

CREATE FUNCTION slotlock_bench.book_slots(r integer, starts timestamptz, minutes integer)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO slotlock_bench.slots
  SELECT r, slot FROM generate_series(starts, starts + make_interval(mins => minutes - 15), interval '15 minutes') AS slot;
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false;
END $$;
