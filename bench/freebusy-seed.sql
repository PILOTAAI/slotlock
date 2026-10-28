-- 1,000 resources, 50 one-hour bookings each, every other hour from 2030-01-01, in both designs.
INSERT INTO slotlock_bench.ranges
SELECT r, tstzrange(timestamptz '2030-01-01' + make_interval(hours => 2 * h),
                    timestamptz '2030-01-01' + make_interval(hours => 2 * h + 1), '[)')
FROM generate_series(1, 1000) AS r, generate_series(0, 49) AS h;
INSERT INTO slotlock_bench.slots
SELECT r, timestamptz '2030-01-01' + make_interval(hours => 2 * h, mins => 15 * q)
FROM generate_series(1, 1000) AS r, generate_series(0, 49) AS h, generate_series(0, 3) AS q;
ANALYZE slotlock_bench.ranges, slotlock_bench.slots;
