# @slotlock/sync

Calendar sync for Slotlock (RFC 0004 C1 and C4). It reads busy time from Google Calendar
(freeBusy), Microsoft 365 (Graph `getSchedule`) and iCalendar URLs into Slotlock, and writes
confirmed bookings back to Google and Microsoft calendars.

It runs as a process of its own, with its own schema (`slotlock_sync`) and its own secrets, and
talks to Slotlock only through Slotlock's API with each tenant's admin key. Slotlock itself never
holds a provider token.

## What it does

- **Reading.** For each calendar mapped to a resource, it reads the coming window (60 days by
  default) and records it with `PUT /v1/resources/{resource_id}/coverage/{source}/busy` at the
  next coverage revision. Slotlock then refuses bookings over that time, counts it in free/busy, and
  reports a confirmed booking the calendar newly shows busy time over as `coverage.conflict`. A
  read that fails is recorded as the source's failure, and its coverage is left to go stale: the
  time is then unproven, not free.
- **Writing back.** It reads each tenant's change feed and keeps every confirmed booking and
  one-off event on the resource's calendars that write back, moved and removed with it. It writes
  times only, under a neutral title (`Busy`), never a booking's title, people or notes. A Google
  event is named after the booking, so a retried insert never makes a second one.
- **Slotlock stays the source of truth.** The sync subtracts the bookings it wrote from what it
  reads back. A written booking moved or deleted in the calendar is reported as the source's
  failure, and the time it moved to comes back as busy time: Slotlock reports that as a conflict
  where it meets a booking. Nothing a provider says changes a booking.

## Secrets

OAuth tokens, iCalendar URLs (which often carry a token) and each tenant's Slotlock key are kept
sealed with AES-256-GCM (`seal.ts`), each bound to what it belongs to, so a sealed value copied to
another row does not open. Keys rotate: pass `id:base64` pairs, newest first.

```bash
export SLOTLOCK_SYNC_KEYS="k2:$(openssl rand -base64 32),k1:<the previous key>"
```

OAuth uses the authorization code flow with PKCE (S256) and a random state, and asks for free/busy
only, plus events when write-back is on.

## Use

```ts
import postgres from 'postgres';
import { createSlotlockGuardedFetch, parseICalendarFeed } from 'slotlock';
import { createPostgresSyncStore, createSyncer, parseSealKeys } from '@slotlock/sync';

const store = createPostgresSyncStore(postgres(process.env.SYNC_DATABASE_URL!));
await store.applySchema();
const syncer = createSyncer({
  store,
  keys: parseSealKeys(process.env.SLOTLOCK_SYNC_KEYS!),
  slotlockUrl: 'https://slotlock.example.com',
  clients: {
    google: { provider: 'google', clientId, clientSecret, redirectUri },
    microsoft: { provider: 'microsoft', clientId, clientSecret, redirectUri, directory: 'organizations' },
  },
  parseICalendar: parseICalendarFeed,
  icsFetch: createSlotlockGuardedFetch(),
});

await syncer.putTenant({ tenantRef: 'fleet-ops', apiKey: process.env.FLEET_OPS_ADMIN_KEY! });
// Connecting: send the person to `url`; keep `state` and `verifier` in their session.
const { url, state, verifier } = syncer.beginConnection('google', { writeBack: true });
// ...when they come back with `code` and a `state` equal to the one kept:
const connection = await syncer.finishConnection({ tenantRef: 'fleet-ops', provider: 'google', account, code, verifier, writeBack: true });
await syncer.mapCalendar({ connectionId: connection.id, calendarId: 'primary', resourceId });

// Then, every few minutes:
await syncer.syncAll();
await syncer.writeBackChanges();
```

## Limits

- Microsoft and Google windows are read in parts of 60 days.
- A recurring Slotlock event is not written back; its time still blocks the calendar's owner from
  Slotlock's side.
- An iCalendar feed with a series Slotlock cannot read is not recorded at all, since that series'
  time is unknown.

## Status

T2: an independent security review is needed before it runs on Cloud.
