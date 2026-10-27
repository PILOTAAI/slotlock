-- Non-overlapping hours on one resource: every attempt books.
\set hour random(1, 500000000)
SELECT slotlock_bench.book_range(1, timestamptz '2030-01-01' + make_interval(hours => :hour), 60);
