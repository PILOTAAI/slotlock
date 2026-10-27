-- One resource, 100 hours: once booked, almost every attempt is refused.
\set hour random(1, 100)
SELECT slotlock_bench.book_slots(1, timestamptz '2030-01-01' + make_interval(hours => :hour), 60);
