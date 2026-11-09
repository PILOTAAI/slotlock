# /brag plan — Slotlock (https://slotlock.pylota.io/)

## Answers
- **What:** an open-source calendar for AI agents, where PostgreSQL refuses every overlapping booking.
- **For:** teams whose agents book vans, rooms, people and machines over MCP, A2A or REST.
- **What sets it apart:** two agents racing for one slot get exactly one booking; the loser gets the conflict back as data it can act on.
- **Best claim:** "Two agents, one slot, one booking."
- **Visual hook:** two agent cursors diving at the same van at the same moment.
- **Real UI shown:** the site's hero calendar (Van AB12 CDE, holds, refused, booked, closed, unproven), its call log (`slotlock_hold_slots`, `slotlock_find_next_available`, `slotlock_create_event`) and its overlap result.
- **Tone:** `polished`, with a dry edge. The race is the joke.
- **Share caption:** Two agents ask for the same van and PostgreSQL lets one through.

All names on screen (Van AB12 CDE, Room 3, Dr Shah, Mill 2, BK-1838, Job 4471) are the site's own demo data. No secrets, keys or real people.

## Identity
Site tokens: canvas `#f6f4ee`, paper `#fff`, ink `#171716`, accent `#2655ff`, confirmed `#167758`, hold `#935d12` on `#f7ebd6` with stripes, refused `#a32d2d` on `#f4e0df`, code `#0e0e10`.
Fonts: Inter Tight (display), Inter (body), JetBrains Mono (code), self-hosted copies from `site/public/fonts`. Logo is the site's padlock mark.

## Music
120 BPM in 4/4, so a beat is 0.5 s and a bar is 2 s. D major, D–A–Bm–G. Soft kick, hats, bass, pad and pluck. Cuts land on bar lines at 4, 8, 12 and 16 s. Effects are in key: a muted low thud on the refusal, a pluck for each hold, a D-major chime when the booking lands.

## Storyboard (20 s)
| # | Time | Scene | On screen | Sound |
|---|---|---|---|---|
| 1 | 0–4 s | **Hook** | Van row on the real calendar. Agent A and Agent B cursors fly in from both sides and drag 10–12 and 11–13 together. Caption: "Two agents want the same van." | Groove starts; two plucks on the drag |
| 2 | 4–8 s | **Refusal** | A's slot locks as an amber `A · hold`. B's shakes red as `B · refused`. The code strip shows `{ refused: [{ index: 0, code: 'overlap' }] }`. Caption: "PostgreSQL lets one through." | Low thud on the refusal |
| 3 | 8–12 s | **Recovery** | B calls `slotlock_find_next_available` and gets 12:00–14:00 · certain, then holds it. A's hold turns green as `A · booked`. Caption: "The loser gets a result it can act on." | Pluck, then the chime |
| 4 | 12–16 s | **Reveal** | The card grows into the full calendar: Room 3, Dr Shah (unproven after 14:00) and Mill 2 (Europe/Berlin). Chips: MCP · A2A · REST. Caption: "Every car, room, person and machine is its own calendar." | Fill builds |
| 5 | 16–20 s | **Outro** | Dips to canvas, then the padlock logo, "slotlock", "The calendar AI agents cannot double-book." and "Open source · Apache-2.0 · slotlock.pylota.io". | Chord swell and fade |
