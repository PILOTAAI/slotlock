# @slotlock/sync

Calendar sync for Slotlock (RFC 0004 C1 and C4). It reads busy time from Google Calendar
(freeBusy), Microsoft 365 (a calendar's `calendarView`, or `getSchedule` for a mailbox by address)
and iCalendar URLs into Slotlock, and writes confirmed bookings back to Google and Microsoft
calendars.

It runs as a process of its own (`slotlock-sync`), with its own schema (`slotlock_sync`) and its
own secrets, and talks to Slotlock only through Slotlock's API with each tenant's admin key.
Slotlock itself never holds a provider token.

## What it does

- **Reading.** Each calendar mapped to a resource is read over the coming window (60 days by
  default) and recorded with `PUT /v1/resources/{resource_id}/coverage/{source}/busy` at the next
  coverage revision. Slotlock then refuses bookings over that time, counts it in free/busy and every
  search, and reports a confirmed booking the calendar newly shows busy time over as
  `coverage.conflict`. A read that fails is recorded as the source's failure and retried later: when
  the provider says (429 or 503 with Retry-After), else after a minute, doubling to six hours. Its
  coverage is left to go stale meanwhile, so the time is unproven, not free.
- **Writing back.** It reads each tenant's change feed and keeps every confirmed booking and
  one-off event on the resource's calendars that write back, moved and removed with it. Times only,
  under a neutral title (`Busy`): never a booking's title, people or notes. A Google event is named
  after the booking and a Microsoft one carries it as its transaction id, so a retried create never
  makes a second one. Once a day, and whenever the feed's cursor has expired (the sync was down past
  the feed's 30 days), each tenant's calendars are reconciled with its bookings as they are now.
- **Slotlock stays the source of truth.** The sync subtracts the bookings it wrote from what it
  reads back, where the calendar still has them as written. One moved, made free or deleted in the
  calendar is reported on Slotlock's feed as `coverage.conflict` (`changed_in_calendar` with where
  the calendar now has it, or `removed_from_calendar`), once for each change; the time it moved to
  comes back as busy time. Nothing a provider says changes a booking.

## Connecting a calendar

The operator (whoever runs the sync) uses its API with `SYNC_ADMIN_TOKEN`:

```bash
curl -X PUT "$SYNC/v1/tenants/fleet-ops" -H "Authorization: Bearer $SYNC_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"api_key":"<the tenant'"'"'s Slotlock admin key>"}'
```

```bash
curl -X POST "$SYNC/v1/tenants/fleet-ops/connect-links" -H "Authorization: Bearer $SYNC_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"provider":"google","write_back":true}'
```

The answer is a link, signed and valid for 30 minutes, for the tenant's person. It sends them to
Google or Microsoft (OAuth code flow with PKCE and a state the sync keeps, used once), back to
`/oauth/callback`, and to a page listing the account's calendars beside the tenant's resources: they
choose which calendar's busy time blocks which resource. That form is signed for the connection.
The sync asks for the calendar list and free/busy, and events only to write back.

Other operator routes: `POST /v1/tenants/{tenant}/ics` (`{"url"}`, an iCalendar URL, read only),
`GET /v1/tenants/{tenant}/connections` (connections, their mappings and health),
`POST /v1/connections/{id}/mappings` (`{"calendar_id","resource_id"}`), `DELETE /v1/connections/{id}`
(removes what it wrote from the calendars, retires its sources in Slotlock, revokes a Google token,
and forgets it), and `POST /v1/run` (a pass now).

## Secrets

OAuth tokens, iCalendar URLs (which often carry a token), each tenant's Slotlock key and each
OAuth flow's verifier are kept sealed with AES-256-GCM, each bound to what it belongs to, so a
sealed value copied to another row does not open. Keys rotate: list `id:base64` pairs, newest first.
OAuth states are kept only as SHA-256 digests.

## Run it

```bash
export SLOTLOCK_SYNC_KEYS="k2:$(openssl rand -base64 32),k1:<the previous key>"
```

```bash
slotlock-sync migrate
```

```bash
slotlock-sync serve
```

Settings: `SYNC_DATABASE_URL`, `SLOTLOCK_URL`, `SLOTLOCK_SYNC_KEYS`, `SYNC_ADMIN_TOKEN` (32+
characters), `SYNC_LINK_SECRET` (32+ bytes), `SYNC_PUBLIC_URL` (https; OAuth apps redirect to
`<SYNC_PUBLIC_URL>/oauth/callback`), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
`MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/`MICROSOFT_DIRECTORY`, `SYNC_INTERVAL_SECONDS`
(300), `SYNC_WINDOW_DAYS` (60), `HOST`, `PORT` (8090). iCalendar URLs need the slotlock package
installed beside it (the image has it), and are fetched through its guarded fetch, which refuses
private addresses. `packages/integrations.Dockerfile` builds an image with all three integrations.

## Limits

- Provider windows are read in parts of 60 days.
- A recurring Slotlock event is not written back; its time still blocks the calendar's owner from
  Slotlock's side.
- An iCalendar feed with a series Slotlock cannot read is not recorded at all, since that series'
  time is unknown.
- At most 50 written events are read back in one pass to see where they went.

## Status

T2: an independent security review is needed before it runs on Cloud.
