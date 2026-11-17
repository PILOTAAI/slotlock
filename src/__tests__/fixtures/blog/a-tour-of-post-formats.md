---
title: "A tour of every format a Slotlock post can carry"
description: "Screenshots, GIFs, videos, players, tables, dividers and slides in one post: the fixture the site's build test renders and checks."
date: 2026-11-14
author: maintainers
tags:
  - writing
  - blog
image: blog-holds
imageAlt: "A week calendar with one slot held by an agent."
status: published
related:
  - "Holds | /docs/concepts/"
---
Slotlock {{facts.version}} keeps a slot for an agent while a person decides. This post shows how, in every format a post on this blog can use, so the build test can check each one as a reader sees it.

## A screenshot of the calendar

The week below is what an agent reads before it proposes a time. One slot is held; the rest are booked or free.

![A week calendar for van 3 with one slot held by an agent for thirty seconds](/blog/a-tour-of-post-formats/calendar-week.png "The calendar an agent reads, with one hold.")

## The hold, as it runs

A hold counts down until the agent books the slot or lets it go. The GIF loops through one hold that ends in a booking.

![A held slot counting down from thirty seconds, then booked](/blog/a-tour-of-post-formats/hold-expires.gif)

The same hold as a video, with its controls, in MP4 and in WebM:

![The hold counting down and the slot turning booked](/blog/a-tour-of-post-formats/hold-to-booking.mp4 "Thirty seconds of a hold, sped up.")

![The same hold, in WebM](/blog/a-tour-of-post-formats/hold-to-booking.webm)

### Pictures in other formats

A photo as a JPEG, a diagram as a WebP and a chart as an AVIF file:

![A white van parked at dawn](/blog/a-tour-of-post-formats/van-at-dawn.jpg)

![An agent asks Slotlock for a slot, Slotlock holds it, and PostgreSQL keeps one owner per slot](/blog/a-tour-of-post-formats/how-a-hold-works.webp "How a hold works.")

![A bar chart: 92 double bookings without locking, 41 with row locks, 17 with an application check, 1 with an exclusion constraint](/blog/a-tour-of-post-formats/double-bookings-chart.avif)

---

## The talk, on YouTube and Vimeo

Each player loads from youtube-nocookie.com or with Vimeo's do-not-track setting, only on a page that shows one:

![Holds that wait for a person, the talk](https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m5s "The talk, from the part about holds.")

![Holds that wait for a person, on Vimeo](https://vimeo.com/76979871)

## The numbers, as a table

| Approach | Double bookings | Where it is checked | What the agent is told |
| --- | --- | --- | --- |
| No locking | 92 | Nowhere | Booked, twice |
| Row lock | 41 | The application | Booked, sometimes twice |
| Application check | 17 | Before the insert | Booked, rarely twice |
| Exclusion constraint | 1 | `PostgreSQL` | `slot_taken`, with the next free time |

The one left in the last row is a test of the clock, not of the constraint.

```sql caption="The constraint that keeps one owner per slot"
ALTER TABLE bookings ADD CONSTRAINT one_owner_per_slot
  EXCLUDE USING gist (resource_id WITH =, during WITH &&);
```

> A hold is a promise with an end: the agent books before it, or the slot is free again.

- **Screenshots** are pasted straight into the editor.
- *GIFs* and videos upload from the toolbar.
1. Write the post.
2. Check the preview.

Download [the talk's slides (PDF)](/blog/a-tour-of-post-formats/holds-talk-slides.pdf) for the diagrams at full size, or read [the concepts](/docs/concepts/).
