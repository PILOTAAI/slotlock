# /brag plan, variation 2: Slotlock (https://slotlock.pylota.io/)

Variation 1 (`brag-output/`) was a polished landscape race. This one is **vertical (1080×1920)** in a
**deadpan, yc-parody** tone: a startup launch played completely straight, with one claim per scene, hard cuts and no transitions.

## Answers
- **What:** an open-source calendar for AI agents, where PostgreSQL refuses every overlapping booking.
- **For:** anyone whose agents book vans, rooms, people or machines.
- **What sets it apart:** it says no to the second agent, holds time while a person picks, and never treats unsynced time as free.
- **Best claim:** "Two agents, one slot, one booking."
- **Funniest angle:** announcing the word "no" like a product launch.
- **Real UI shown:** the hold call and overlap result, the MCP App slot picker (Pick a time, Van AB12 CDE, Tue 30, 12:00, Held until 09:51, Book this time, Sent to your agent), the hold that runs out ("freed for the next writer") and the Dr Shah row with "unproven after 14:00".
- **Share caption:** Slotlock says no to one of your agents, politely and as data.

All names are the site's own demo data.

## Identity
The same tokens and fonts as the site (see variation 1). There's a persistent mono header, `slotlock`, and a scene counter `01 / 05` in the site's section-counter style.

## Music
100 BPM in 4/4, so a beat is 0.6 s and a bar is 2.4 s. F–Dm–B♭–C with a sparse electric piano, a kick on the downbeat, a muted bass, and a clock tick that turns into the countdown in scene 4. Cuts land on half-bars (multiples of 1.2 s). Effects are in key: a two-note muted "nope" (C→F) on the refusal, soft clicks on the taps, a chime on "Sent" and an airy chime when the hold is freed.

## Storyboard (21.6 s, hard cuts)
| # | Time | Claim (caption) | On screen | Sound |
|---|---|---|---|---|
| 1 | 0–3.6 | "Your agents will try to book the same van." | Two request cards, A in blue and B in ink, both `slotlock_hold_slots van · 10:00–12:00`, landing on beats | Tick, kick |
| 2 | 3.6–6.0 | "Slotlock says no." then "To one of them." | A: `held to 09:51:02`. B shakes to red: `{ refused: [{ index: 0, code: 'overlap' }] }` | "Nope" |
| 3 | 6.0–10.8 | "The agent shows the free slots. You pick one in the chat." | The MCP App picker. Taps on 12:00 and then Book this time; receipt: Sent to your agent | Two clicks, chime |
| 4 | 10.8–14.4 | "Holds expire. No cron job." | `B · hold` countdown 09:59 → 00:00, then the hold dissolves: "no confirm by 09:51 · freed for the next writer" | Ticks, airy chime |
| 5 | 14.4–16.8 | "Unproven is not free." | Dr Shah: busy · .ics, unproven after 14:00; a 15:00 booking with requireCertain is refused | Muted thud |
| 6 | 16.8–21.6 | — | Logo, "Two agents, one slot, one booking.", "OPEN SOURCE · SLOTLOCK.PYLOTA.IO" | F add9 bell, fade |
