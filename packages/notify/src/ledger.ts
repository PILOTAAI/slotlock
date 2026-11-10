// What the notifier keeps, in its own schema (`slotlock_notify`), apart from Slotlock's (RFC 0004
// D1). Every send is recorded under its key (the change's id, the channel, the recipient) before it
// is made, so however often a change is read or delivered, each person is sent each message once.
// A send whose outcome is unknown (the process stopped mid-send) is never made again: a message
// missed is better than one sent twice. Recipients are kept as digests, never their addresses.
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export type NotifyChannelKind = 'email' | 'sms' | 'whatsapp';

export interface SendKey {
  tenantRef: string;
  changeId: string;
  channel: NotifyChannelKind;
  /** The address, number or chat it goes to; kept only as a digest. */
  recipient: string;
}

/** A person the notifier will tell about an event when it is cancelled (its attendees by then are gone). */
export interface RememberedRecipient {
  address: string;
  name: string | null;
}

export interface NotifyLedger {
  /**
   * Claim a send: true when it may be made now (never claimed, or failed fewer than `maxAttempts`
   * times), false when it was sent, is being sent, or its outcome is unknown.
   */
  claim(key: SendKey, maxAttempts?: number): Promise<boolean>;
  /** How the claimed send went. */
  settle(key: SendKey, outcome: { ok: true; providerId: string | null } | { ok: false; error: string }): Promise<void>;
  getCursor(tenantRef: string): Promise<string | null>;
  setCursor(tenantRef: string, cursor: string): Promise<void>;
  /** A person said stop on a channel (an unsubscribe link, STOP by SMS). */
  optOut(tenantRef: string, channel: NotifyChannelKind, address: string): Promise<void>;
  isOptedOut(tenantRef: string, channel: NotifyChannelKind, address: string): Promise<boolean>;
  rememberRecipients(tenantRef: string, eventId: string, recipients: RememberedRecipient[]): Promise<void>;
  recallRecipients(tenantRef: string, eventId: string): Promise<RememberedRecipient[]>;
  forgetRecipients(tenantRef: string, eventId: string): Promise<void>;
}

/** A recipient as the ledger keeps it: a digest of the channel and the address, lowercased. */
export function recipientDigest(channel: NotifyChannelKind, address: string): string {
  return createHash('sha256').update(`${channel}:${address.trim().toLowerCase()}`).digest('hex');
}

/** A ledger in memory, for tests and a single process that may forget. */
export function createMemoryLedger(): NotifyLedger & { sends: Map<string, { status: string; attempts: number }> } {
  const sends = new Map<string, { status: string; attempts: number; providerId?: string | null; error?: string }>();
  const cursors = new Map<string, string>();
  const optOuts = new Set<string>();
  const recipients = new Map<string, RememberedRecipient[]>();
  const id = (key: SendKey) => [key.tenantRef, key.changeId, key.channel, recipientDigest(key.channel, key.recipient)].join('\n');
  return {
    sends,
    async claim(key, maxAttempts = 5) {
      const found = sends.get(id(key));
      if (!found) {
        sends.set(id(key), { status: 'sending', attempts: 1 });
        return true;
      }
      if (found.status !== 'failed' || found.attempts >= maxAttempts) return false;
      found.status = 'sending';
      found.attempts += 1;
      return true;
    },
    async settle(key, outcome) {
      const found = sends.get(id(key));
      if (!found) return;
      Object.assign(found, outcome.ok ? { status: 'sent', providerId: outcome.providerId } : { status: 'failed', error: outcome.error });
    },
    async getCursor(tenantRef) {
      return cursors.get(tenantRef) ?? null;
    },
    async setCursor(tenantRef, cursor) {
      cursors.set(tenantRef, cursor);
    },
    async optOut(tenantRef, channel, address) {
      optOuts.add(`${tenantRef}\n${recipientDigest(channel, address)}`);
    },
    async isOptedOut(tenantRef, channel, address) {
      return optOuts.has(`${tenantRef}\n${recipientDigest(channel, address)}`);
    },
    async rememberRecipients(tenantRef, eventId, list) {
      recipients.set(`${tenantRef}\n${eventId}`, list.map((each) => ({ ...each })));
    },
    async recallRecipients(tenantRef, eventId) {
      return recipients.get(`${tenantRef}\n${eventId}`) ?? [];
    },
    async forgetRecipients(tenantRef, eventId) {
      recipients.delete(`${tenantRef}\n${eventId}`);
    },
  };
}

/** The schema the Postgres ledger keeps: run it as the schema's owner, once per release. */
export const SLOTLOCK_NOTIFY_DDL = `
CREATE SCHEMA IF NOT EXISTS slotlock_notify;
CREATE TABLE IF NOT EXISTS slotlock_notify.sends (
  tenant_ref text NOT NULL CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500),
  change_id text NOT NULL CHECK (char_length(change_id) BETWEEN 1 AND 100),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  recipient text NOT NULL CHECK (recipient ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  provider_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, change_id, channel, recipient)
);
CREATE INDEX IF NOT EXISTS sends_created_idx ON slotlock_notify.sends (created_at);
CREATE TABLE IF NOT EXISTS slotlock_notify.cursors (
  tenant_ref text PRIMARY KEY,
  cursor text NOT NULL
);
CREATE TABLE IF NOT EXISTS slotlock_notify.opt_outs (
  tenant_ref text NOT NULL,
  recipient text NOT NULL CHECK (recipient ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, recipient)
);
CREATE TABLE IF NOT EXISTS slotlock_notify.event_recipients (
  tenant_ref text NOT NULL,
  event_id text NOT NULL,
  recipients jsonb NOT NULL CHECK (jsonb_typeof(recipients) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, event_id)
);
`;


/** A ledger in PostgreSQL (postgres.js), in schema slotlock_notify: apply SLOTLOCK_NOTIFY_DDL first. */
export function createPostgresLedger(sql: Sql): NotifyLedger & { applySchema(): Promise<void>; prune(days?: number): Promise<number> } {
  const key = (send: SendKey) => [send.tenantRef, send.changeId, send.channel, recipientDigest(send.channel, send.recipient)] as const;
  return {
    async applySchema() {
      await sql.unsafe(SLOTLOCK_NOTIFY_DDL);
    },
    /** Forget sends older than `days` (default 90): the feed keeps changes 30 days, so none comes back. */
    async prune(days = 90) {
      const rows = await sql<{ change_id: string }[]>`
        DELETE FROM slotlock_notify.sends WHERE created_at < now() - make_interval(days => ${days}) RETURNING change_id`;
      return rows.length;
    },
    async claim(send, maxAttempts = 5) {
      const [tenantRef, changeId, channel, recipient] = key(send);
      const rows = await sql<{ status: string }[]>`
        INSERT INTO slotlock_notify.sends (tenant_ref, change_id, channel, recipient, status)
        VALUES (${tenantRef}, ${changeId}, ${channel}, ${recipient}, 'sending')
        ON CONFLICT (tenant_ref, change_id, channel, recipient) DO UPDATE
           SET status = 'sending', attempts = slotlock_notify.sends.attempts + 1, updated_at = now()
         WHERE slotlock_notify.sends.status = 'failed' AND slotlock_notify.sends.attempts < ${maxAttempts}
        RETURNING status`;
      return rows.length > 0;
    },
    async settle(send, outcome) {
      const [tenantRef, changeId, channel, recipient] = key(send);
      await sql`
        UPDATE slotlock_notify.sends
           SET status = ${outcome.ok ? 'sent' : 'failed'},
               provider_id = ${outcome.ok ? outcome.providerId : null},
               error = ${outcome.ok ? null : outcome.error.slice(0, 500)},
               updated_at = now()
         WHERE tenant_ref = ${tenantRef} AND change_id = ${changeId} AND channel = ${channel} AND recipient = ${recipient}`;
    },
    async getCursor(tenantRef) {
      const [row] = await sql<{ cursor: string }[]>`SELECT cursor FROM slotlock_notify.cursors WHERE tenant_ref = ${tenantRef}`;
      return row?.cursor ?? null;
    },
    async setCursor(tenantRef, cursor) {
      await sql`
        INSERT INTO slotlock_notify.cursors (tenant_ref, cursor) VALUES (${tenantRef}, ${cursor})
        ON CONFLICT (tenant_ref) DO UPDATE SET cursor = EXCLUDED.cursor`;
    },
    async optOut(tenantRef, channel, address) {
      await sql`
        INSERT INTO slotlock_notify.opt_outs (tenant_ref, recipient) VALUES (${tenantRef}, ${recipientDigest(channel, address)})
        ON CONFLICT DO NOTHING`;
    },
    async isOptedOut(tenantRef, channel, address) {
      const rows = await sql`
        SELECT 1 FROM slotlock_notify.opt_outs WHERE tenant_ref = ${tenantRef} AND recipient = ${recipientDigest(channel, address)}`;
      return rows.length > 0;
    },
    async rememberRecipients(tenantRef, eventId, recipients) {
      await sql`
        INSERT INTO slotlock_notify.event_recipients (tenant_ref, event_id, recipients)
        VALUES (${tenantRef}, ${eventId}, ${sql.json(recipients.map((each) => ({ address: each.address, name: each.name })))})
        ON CONFLICT (tenant_ref, event_id) DO UPDATE SET recipients = EXCLUDED.recipients, updated_at = now()`;
    },
    async recallRecipients(tenantRef, eventId) {
      const [row] = await sql<{ recipients: RememberedRecipient[] }[]>`
        SELECT recipients FROM slotlock_notify.event_recipients WHERE tenant_ref = ${tenantRef} AND event_id = ${eventId}`;
      return row?.recipients ?? [];
    },
    async forgetRecipients(tenantRef, eventId) {
      await sql`DELETE FROM slotlock_notify.event_recipients WHERE tenant_ref = ${tenantRef} AND event_id = ${eventId}`;
    },
  };
}
