-- One resource, 100 hours: once booked, almost every attempt is refused. On Slotlock's own schema (real-setup.sql).
\set hour random(1, 100)
SELECT slotlock_bench.book_real(1, timestamptz '2030-01-01' + make_interval(hours => :hour), 60);
