# @slotlock/notify

Notifications for Slotlock (RFC 0004 C2): confirmations, moves, cancellations and reminders, by
email (Postmark, Resend or Amazon SES), SMS and WhatsApp (Twilio).

It runs as a process of its own (`slotlock-notify`), with its own schema (`slotlock_notify`) and the
sending accounts' credentials, and reads Slotlock through its API with each tenant's admin key, by
polling the change feed or taking its signed webhook deliveries (`POST /webhooks/<tenant>`).
Slotlock itself sends nothing.

## Who is told what

- **A booking that names a contact** (`contact_ref`, kept with `PUT /v1/contacts/{contact_ref}`):
  told when it is booked, moved and cancelled, and reminded at its `reminder_minutes`. Email unless the contact said no to it
  (`consent.email: false`); SMS and WhatsApp only when they said yes (`consent.sms: true`,
  `consent.whatsapp: true`).
- **An event's attendees**, by email: told when it is booked, moved and cancelled, and reminded
  when one of its email reminders comes due (`reminder.due`). For a cancellation, once the event is
  gone, the notifier keeps the attendees it last read: sealed with AES-256-GCM, until a day after
  the event ends, and deleted once told. Each day it also keeps those of the coming 30 days' events,
  so events made before it started, or while it was away, reach theirs too.
- **No one** about a booking or event with `notify: false`, or a person who opted out
  (`ledger.optOut`).
- A test environment's (`<tenant>~test`) messages go to `testChannels`, never a real channel.

## Each message once

Every send is recorded in the ledger under its key (the change's id, the channel, the recipient)
before it is made. However often a change is read or delivered, each person gets each message
once. A send that failed is tried again, up to five times; one whose outcome is unknown (the
process stopped mid-send) is not, since a missed message is better than a doubled one. The send
ledger and opt-outs keep recipients only as digests. Resend also gets the key as its
Idempotency-Key.

## Nothing stale

A change older than a day is not sent, nor a reminder for what has started: a notifier reading the
feed from its start, or back from a long stop, never sends old news. When the feed's cursor has
expired (stopped past its 30 days), it reads again from what the feed keeps and says so (`gap`).

## Use

```ts
import postgres from 'postgres';
import { createNotifier, createPostgresLedger, parseSealKeys, postmarkEmail, twilioMessages, captureChannel } from '@slotlock/notify';

const ledger = createPostgresLedger(postgres(process.env.NOTIFY_DATABASE_URL!), {
  keys: parseSealKeys(process.env.NOTIFY_SEAL_KEYS!),
});
await ledger.applySchema();
const notifier = createNotifier({
  ledger,
  slotlockUrl: 'https://slotlock.example.com',
  channels: {
    email: postmarkEmail({ serverToken: process.env.POSTMARK_TOKEN! }),
    sms: twilioMessages({ accountSid, authToken }),
    whatsapp: twilioMessages({ accountSid, authToken, whatsapp: true, contentSid }),
  },
  testChannels: { email: captureChannel('email'), sms: captureChannel('sms') },
  tenant: async (tenantRef) => ({
    apiKey: await secrets.slotlockKey(tenantRef),
    name: 'Fleet Co',
    from: { email: 'bookings@fleet.example', sms: 'MG...', whatsapp: '+447700900998' },
    locale: 'en-GB',
  }),
});

// Poll every minute or so, or verify webhook deliveries and handle each:
await notifier.poll('fleet-ops');
const change = verifySlotlockWebhook({ secret, headers: request.headers, body: await request.text() });
await notifier.handle('fleet-ops', change);
```

Templates (`DEFAULT_TEMPLATES`) have a subject, a text and an HTML body with `{{name}}`, `{{what}}`,
`{{when}}`, `{{previously}}`, `{{reference}}` and `{{sender}}`; a tenant may replace any. Values
are escaped in HTML. Times are written in the resource's or event's zone, in the person's language.

WhatsApp messages outside a 24-hour session need a template Meta approved: pass its Content SID.

## Run it

`slotlock-notify migrate`, then `slotlock-notify serve`. Settings: `NOTIFY_DATABASE_URL`,
`SLOTLOCK_URL`, `NOTIFY_SEAL_KEYS`, `NOTIFY_TENANTS_FILE` (a JSON file, kept as a secret: per tenant
`apiKey`, `webhookSecret`, `name`, `from`, `locale`, `notifyAttendees`, `templates`; a test
environment is a tenant of its own, with its test key), and the channels: `POSTMARK_SERVER_TOKEN`,
`RESEND_API_KEY`, or `SES_REGION` with AWS credentials; `TWILIO_ACCOUNT_SID` and
`TWILIO_AUTH_TOKEN` (and `TWILIO_WHATSAPP_CONTENT_SID`). `NOTIFY_INTERVAL_SECONDS` (60), `HOST`,
`PORT` (8091). A test environment's messages are only logged as captured, never sent.

## On Cloud

Sending on Cloud is a paid add-on whose per-message price waits on decision D5. Until then the
package runs where its operator runs it, with their own sending accounts.

## Status

T1 for the package; T2 (an independent security review) before Cloud sends with it.
