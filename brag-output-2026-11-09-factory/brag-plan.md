# /brag plan, variation 4 "Factory": Slotlock (https://slotlock.pylota.io/)

Landscape (1920×1080, 30 fps, 23 s), the site's **dark** theme, **cinematic** trailer tone played seriously. There are no vans: the example is **Mill 2 (Europe/Berlin)** and **Job 4471**, both from the site's own hero demo. Mill 1, Mill 3, the "mills" pool and Mill 2's 06:00–22:00 hours are illustrative stand-ins.

## Answers
- **What:** an open-source calendar for AI agents, where PostgreSQL refuses every overlapping booking.
- **For:** operations whose agents schedule machines, rooms, vehicles and people, across time zones.
- **What sets it apart:** one booking per slot however many writers race, pools that hand out the first free member, and rules that run in the resource's own time zone.
- **Best claim:** "Stop checking for conflicts in application code. Let PostgreSQL refuse them."
- **Visual hook:** trailer cards slamming in on the beat: "One mill." "Two agents." "Two time zones."
- **Real UI and code:** `slotlock_hold_slots`, `slotlock_book_pool`, `{ ok: false, code: 'overlap' }`, the site's RRULE, and the real EXCLUDE constraint from `src/ddl.ts` with SQLSTATE 23P01.
- **Tone:** cinematic, in the dark theme.
- **Share caption:** Two agents, two time zones, one mill. PostgreSQL lets one through.

## Identity
Dark tokens from `site/src/styles/tokens.mjs`: canvas `#000`, paper `#0E0E10`, ink `#F7F7F7`, ink-3 `#9E9E9E`, accent `#6B8AFF`, confirmed `#4CC49A`, hold `#E8B76B`, refused `#E87373`, busy `#26262A`, code `#121214`. Fonts are Inter Tight, Inter and JetBrains Mono. Transitions are an accent-edged wipe on each cut.

## Music
120 BPM with a half-time feel; a bar is 2 s. D minor, Dm–B♭–Gm–A. A low drone with a half-time kick and snare, a 16th-note pulse and an eighth-note ostinato from scene 3. A low boom on every cut, risers into scenes 3, 4, 5 and 6, and a braam at the open and the outro. Effects are in key: a low hit on the refusal, a metallic ping when the pool lands, a tick and swell on the daylight-saving flip, and a hit on 23P01.

## Storyboard (23 s)
| # | Time | On screen | Caption | Sound |
|---|---|---|---|---|
| 1 | 0–3 | Trailer cards on beats 0, 1 and 2 s | One mill. / Two agents. / Two time zones. | Braam, booms |
| 2 | 3–7 | Planner agent (America/New_York, 00:00) and shift agent (Europe/Berlin, 06:00) both call `slotlock_hold_slots` for Mill 2 06:00–14:00. Planner: held → booked · Job 4471. Shift: `{ ok: false, code: 'overlap' }` | Same instant. Same machine. One booking. | Hit on the refusal |
| 3 | 7–11 | `slotlock_book_pool mills · 06:00–14:00` scans Mill 1 (busy) and Mill 2 (Job 4471), then holds Mill 3 | Ask for any mill. Get the first free one. | Ostinato, ping |
| 4 | 11–15 | Mill 2 rule (`FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`, Europe/Berlin, 06:00–22:00). The clock flips Sun 29 Mar 02:00 → 03:00 CEST; Mon 23 and Mon 30 both open at 06:00 local (05:00 vs 04:00 UTC) | Its own clock. Daylight saving included. | Tick, swell |
| 5 | 15–19 | `src/ddl.ts` EXCLUDE constraint; racer-a committed, racer-b `SQLSTATE 23P01, exclusion_violation` | Stop checking for conflicts in application code. Let PostgreSQL refuse them. | Hit |
| 6 | 19–23 | Logo, "slotlock", "The calendar AI agents cannot double-book.", OPEN SOURCE · SLOTLOCK.PYLOTA.IO | — | Braam, fade |
