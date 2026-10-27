-- 1,000 resources, 50 hours each: bookings and refusals mixed, with real contention.
\set resource random(1, 1000)
\set hour random(1, 50)
SELECT slotlock_bench.book_slots(:resource, timestamptz '2030-01-01' + make_interval(hours => :hour), 60);
