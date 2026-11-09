# /brag plan, variation 3 "Clinic": Slotlock (https://slotlock.pylota.io/)

There are no vans in this one. The example is a clinic: **Dr Shah** and **Room 3**, both from the site's own demo data.
It's **square (1080×1080)** in an **app-store** tone: clean feature cards with smooth slides between them. The site's heading "What a fleet or a clinic needs" sets it up.

## Answers
- **What:** an open-source calendar for AI agents, where PostgreSQL refuses every overlapping booking.
- **For:** a clinic whose patients' assistants and front-desk agent all book the same doctors and rooms.
- **What sets it apart:** beyond refusing the double booking, it runs waitlists, books a doctor and a room together, and releases no-shows.
- **Best claim:** "Freed time goes to the waitlist in join order, as a hold for the next person."
- **Visual hook:** two assistants asking for the same 10:00 with Dr Shah.
- **Real UI and copy:** the site's calendar rows and blocks (booked, hold, busy), its tool names (`slotlock_hold_slots`, `slotlock_book_together`) and its Capabilities copy (waitlists and check-in, book together).
- **Share caption:** Two assistants want Dr Shah at 10:00, so one books it and the other joins the waitlist.

"Patient assistant" and "Front desk agent" are role labels, not people.

## Music
120 BPM (a beat is 0.5 s, a bar 2 s) in G major, G–Em–C–D, with marimba, a soft kick, claps on 2 and 4, and a round bass. Every cut is on a bar. Effects are in key: marimba blips as cards land, a soft "tock" on the refusal, a rising two-note figure when a hold passes to the next in line, and a G-major bell at the outro.

## Storyboard (23 s, smooth slides)
| # | Time | Caption | On screen |
|---|---|---|---|
| 1 | 0–4 | "Two assistants want Dr Shah at 10:00." | Request cards slide in from the left and right: Patient assistant and Front desk agent, both asking for Dr Shah · Tue 10:00–11:00 |
| 2 | 4–8 | "One books it. The other joins the waitlist." | Front desk → booked (green). Patient → refused: overlap, then "waitlist · #1" (amber) |
| 3 | 8–12 | "Someone cancels. The next in line gets a hold." | Dr Shah's row: the 10:00 booking is cancelled and becomes "held for waitlist #1" |
| 4 | 12–16 | "Doctor and room, together. All or none." | Dr Shah and Room 3; `slotlock_book_together` drops a 12:00 consult onto both at once |
| 5 | 16–20 | "No check-in? Released and offered on." | A 09:00 booking waits for check-in, gets no check-in, then becomes "offered to waitlist #2" |
| 6 | 20–23 | — | Logo, "What a fleet or a clinic needs.", "OPEN SOURCE · SLOTLOCK.PYLOTA.IO" |
