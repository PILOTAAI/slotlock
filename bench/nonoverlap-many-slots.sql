-- Non-overlapping hours across 1,000 resources.
\set resource random(1, 1000)
\set hour random(1, 500000000)
SELECT slotlock_bench.book_slots(:resource, timestamptz '2030-01-01' + make_interval(hours => :hour), 60);
