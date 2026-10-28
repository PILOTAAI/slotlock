-- One resource's busy times over a day: the taken slots in the window.
\set resource random(1, 1000)
\set hour random(0, 76)
\set until :hour + 24
SELECT slot FROM slotlock_bench.slots
WHERE resource = :resource
  AND slot >= timestamptz '2030-01-01' + make_interval(hours => :hour)
  AND slot < timestamptz '2030-01-01' + make_interval(hours => :until)
ORDER BY slot;
