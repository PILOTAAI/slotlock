-- One resource's busy times over a day: the bookings that overlap the window.
\set resource random(1, 1000)
\set hour random(0, 76)
\set until :hour + 24
SELECT lower(during), upper(during) FROM slotlock_bench.ranges
WHERE resource = :resource
  AND during && tstzrange(timestamptz '2030-01-01' + make_interval(hours => :hour), timestamptz '2030-01-01' + make_interval(hours => :until), '[)');
