-- Non-overlapping hours across 1,000 resources. On Slotlock's own schema (real-setup.sql).
\set resource random(1, 1000)
\set hour random(1, 500000000)
SELECT slotlock_bench.book_real(:resource, timestamptz '2030-01-01' + make_interval(hours => :hour), 60);
