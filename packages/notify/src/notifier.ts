// The notifier (RFC 0004 C2): reads a tenant's changes (polled, or delivered by webhook) and tells
// the people they concern.
//
// - A booking that names a contact tells them when it is booked, moved and cancelled, and reminds
//   them at its reminder_minutes, on the channels they agreed to.
// - An event tells its attendees by email when it is booked, moved and cancelled, and reminds them
//   when an email reminder comes due.
// - `notify: false` on a booking or event tells no one.
//
// Each send is claimed in the ledger under the change's id, its channel and its recipient before it
// is made, so it is made once, however often the change is read. A change older than `maxAgeMs`
// (default a day) is not sent at all, nor a reminder for what has started: a notifier back from a
// long stop, or one reading the feed from its start, never sends stale news. A feed cursor that
// expired is dropped and the feed read again from what it keeps.
import { type NotifyChannel, ChannelError } from './channels.js';
import type { NotifyChannelKind, NotifyLedger, RememberedRecipient } from './ledger.js';
import {
  type SlotlockChange,
  type SlotlockContact,
  type SlotlockEvent,
  type SlotlockNotifyApi,
  SlotlockApiError,
  createSlotlockNotifyApi,
} from './slotlock-api.js';
import {
  DEFAULT_TEMPLATES,
  type NotifyMessageKind,
  type NotifyTemplates,
  formatWhen,
  renderTemplate,
} from './templates.js';

/** What the notifier needs to know of a tenant. */
export interface NotifyTenant {
  /** Its Slotlock admin key (it reads contacts and events). */
  apiKey: string;
  /** Who the messages are from, as people know the tenant. */
  name: string;
  /** Its senders: a verified address, an SMS number or messaging service, a WhatsApp number. */
  from: Partial<Record<NotifyChannelKind, string>>;
  templates?: Partial<NotifyTemplates>;
  /** The language when the person's is not known (default en-GB). */
  locale?: string;
  /** Tell an event's attendees (default true); a booking's contact is told either way. */
  notifyAttendees?: boolean;
}

export interface NotifierOptions {
  ledger: NotifyLedger;
  /** Slotlock's REST root (without /v1). */
  slotlockUrl: string;
  /** The tenant's settings, or null to tell no one of it. */
  tenant(tenantRef: string): Promise<NotifyTenant | null>;
  channels: Partial<Record<NotifyChannelKind, NotifyChannel>>;
  /** Where a test environment's (`<tenant>~test`) messages go instead: never a real channel. */
  testChannels: Partial<Record<NotifyChannelKind, NotifyChannel>>;
  fetch?: typeof fetch;
  /** Tries of a send that failed (default 5). */
  maxAttempts?: number;
  /** A change older than this is not sent (default a day). */
  maxAgeMs?: number;
  now?: () => Date;
}

export interface HandleResult {
  sent: number;
  /** Already sent, being sent, stale, opted out, or with no channel or sender for it. */
  skipped: number;
  failed: number;
}

interface Recipient {
  channel: NotifyChannelKind;
  address: string;
  name: string | null;
  locale: string | null;
}

/** The channels a contact agreed to: email unless they said no, SMS and WhatsApp only if they said yes. */
export function contactRecipients(contact: SlotlockContact): Recipient[] {
  const recipients: Recipient[] = [];
  const base = { name: contact.name, locale: contact.locale };
  if (contact.email && contact.consent.email !== false) recipients.push({ channel: 'email', address: contact.email, ...base });
  if (contact.phone && contact.consent.sms === true) recipients.push({ channel: 'sms', address: contact.phone, ...base });
  if (contact.whatsapp && contact.consent.whatsapp === true) recipients.push({ channel: 'whatsapp', address: contact.whatsapp, ...base });
  return recipients;
}

const isTestTenant = (tenantRef: string) => tenantRef.endsWith('~test');
const date = (value: unknown) => new Date(String(value));
/** Attendees are kept until a day after their event ends. */
const KEEP_AFTER_END_MS = 24 * 60 * 60 * 1_000;

const attendeesOf = (event: Pick<SlotlockEvent, 'attendees'>): RememberedRecipient[] =>
  event.attendees.map((attendee) => ({ address: attendee.address, name: attendee.name ?? null }));

export function createNotifier(options: NotifierOptions) {
  const maxAttempts = options.maxAttempts ?? 5;
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1_000;
  const now = options.now ?? (() => new Date());
  const apiFor = (tenant: NotifyTenant) =>
    createSlotlockNotifyApi({ baseUrl: options.slotlockUrl, apiKey: tenant.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) });

  async function remember(tenantRef: string, event: SlotlockEvent): Promise<void> {
    const attendees = attendeesOf(event);
    if (attendees.length === 0) return options.ledger.forgetRecipients(tenantRef, event.id);
    await options.ledger.rememberRecipients(tenantRef, event.id, attendees, new Date(date(event.ends_at).getTime() + KEEP_AFTER_END_MS));
  }

  async function messageFor(
    api: SlotlockNotifyApi,
    tenantRef: string,
    tenant: NotifyTenant,
    change: SlotlockChange,
  ): Promise<{ kind: NotifyMessageKind; recipients: Recipient[]; what: string; zone: string; reference: string } | null> {
    const data = change.data;
    if (data.notify === false) return null;
    const before = data.before as { start?: unknown; end?: unknown } | undefined;
    const moved = before !== undefined && (String(before.start) !== String(data.start) || String(before.end) !== String(data.end));
    // A booking's own: it names whom to tell.
    const forBooking = change.type.startsWith('reservation.') || (change.type === 'reminder.due' && typeof data.reservation_id === 'string');
    if (forBooking) {
      const kind: NotifyMessageKind | null =
        change.type === 'reservation.created'
          ? 'confirmed'
          : change.type === 'reservation.rescheduled'
            ? 'rescheduled'
            : change.type === 'reservation.cancelled'
              ? 'cancelled'
              : change.type === 'reminder.due'
                ? 'reminder'
                : null;
      if (!kind || typeof data.contact_ref !== 'string' || typeof data.resource_id !== 'string') return null;
      const contact = await api.getContact(data.contact_ref);
      if (!contact) return null;
      const resource = await api.getResource(data.resource_id);
      return {
        kind,
        recipients: contactRecipients(contact),
        what: resource?.name ?? resource?.external_ref ?? 'Your booking',
        zone: resource?.timezone ?? 'UTC',
        reference: typeof data.reference === 'string' ? data.reference : change.subject,
      };
    }
    const eventId = typeof data.event_id === 'string' ? data.event_id : typeof data.id === 'string' ? data.id : null;
    if (!eventId || tenant.notifyAttendees === false) return null;
    const byEmail = (people: RememberedRecipient[]) =>
      people.map((person) => ({ channel: 'email' as const, address: person.address, name: person.name, locale: null }));
    if (change.type === 'event.cancelled') {
      // The event is gone: tell those it had when last read, then forget them.
      return {
        kind: 'cancelled',
        recipients: byEmail(await options.ledger.recallRecipients(tenantRef, eventId)),
        what: 'Your booking',
        zone: typeof data.timezone === 'string' ? data.timezone : 'UTC',
        reference: eventId,
      };
    }
    if (change.type !== 'event.updated' && change.type !== 'event.created' && change.type !== 'reminder.due') return null;
    const kind: NotifyMessageKind | null =
      change.type === 'event.created'
        ? 'confirmed'
        : change.type === 'event.updated' && moved
          ? 'rescheduled'
          : change.type === 'reminder.due' && data.action === 'email'
            ? 'reminder'
            : null;
    const event = await api.getEvent(eventId);
    if (!event) return null;
    // Kept for a cancellation, which no longer reads the event.
    await remember(tenantRef, event);
    if (!kind) return null;
    return { kind, recipients: byEmail(attendeesOf(event)), what: event.title ?? 'Your booking', zone: event.timezone, reference: eventId };
  }

  /** Whether a change is too old to send: older than maxAgeMs, or a reminder for what has started. */
  function stale(change: SlotlockChange): boolean {
    const at = Date.parse(change.time);
    if (Number.isFinite(at) && now().getTime() - at > maxAgeMs) return true;
    return change.type === 'reminder.due' && date(change.data.start).getTime() <= now().getTime();
  }

  /** Tell the people one change concerns. */
  async function handle(tenantRef: string, change: SlotlockChange): Promise<HandleResult> {
    const result: HandleResult = { sent: 0, skipped: 0, failed: 0 };
    const tenant = await options.tenant(tenantRef);
    if (!tenant) return result;
    if (stale(change)) {
      // Still kept for a later cancellation, though too old to announce.
      if ((change.type === 'event.created' || change.type === 'event.updated') && typeof change.data.id === 'string') {
        const event = await apiFor(tenant).getEvent(change.data.id);
        if (event) await remember(tenantRef, event);
      }
      result.skipped += 1;
      return result;
    }
    const message = await messageFor(apiFor(tenant), tenantRef, tenant, change);
    if (!message) return result;
    const channels = isTestTenant(tenantRef) ? options.testChannels : options.channels;
    const template = { ...DEFAULT_TEMPLATES, ...tenant.templates }[message.kind];
    const before = change.data.before as { start?: unknown; end?: unknown } | undefined;
    for (const recipient of message.recipients) {
      const channel = channels[recipient.channel];
      const from = tenant.from[recipient.channel];
      if (!channel || !from || (await options.ledger.isOptedOut(tenantRef, recipient.channel, recipient.address))) {
        result.skipped += 1;
        continue;
      }
      const key = { tenantRef, changeId: change.id, channel: recipient.channel, recipient: recipient.address };
      if (!(await options.ledger.claim(key, maxAttempts))) {
        result.skipped += 1;
        continue;
      }
      const locale = recipient.locale ?? tenant.locale ?? 'en-GB';
      const rendered = renderTemplate(template, {
        name: recipient.name ?? '',
        what: message.what,
        when: formatWhen(date(change.data.start), date(change.data.end), message.zone, locale),
        previously: before ? formatWhen(date(before.start), date(before.end), message.zone, locale) : '',
        reference: message.reference,
        sender: tenant.name,
      });
      try {
        const sent = await channel.send({
          to: recipient.address,
          from,
          subject: rendered.subject,
          text: recipient.channel === 'email' ? rendered.text : `${rendered.subject}. ${tenant.name}`,
          ...(recipient.channel === 'email' && rendered.html ? { html: rendered.html } : {}),
          idempotencyKey: `${change.id}:${recipient.channel}:${recipient.address}`,
        });
        await options.ledger.settle(key, { ok: true, providerId: sent.providerId });
        result.sent += 1;
      } catch (error) {
        await options.ledger.settle(key, { ok: false, error: error instanceof ChannelError ? error.message : 'send failed' });
        result.failed += 1;
      }
    }
    if (change.type === 'event.cancelled') {
      const eventId = typeof change.data.id === 'string' ? change.data.id : null;
      if (eventId) await options.ledger.forgetRecipients(tenantRef, eventId);
    }
    return result;
  }

  return {
    handle,

    /**
     * Read a tenant's feed on from where the ledger says it stopped, a page at a time, and handle
     * each change. A page that fails is read again next time; its sends already made are skipped.
     * A cursor the feed no longer keeps (410: stopped past its 30 days) is dropped, and the feed
     * read from what it keeps, stale changes skipped; `gap` says it happened.
     */
    async poll(tenantRef: string, pages = 20): Promise<HandleResult & { gap: boolean }> {
      const total = { sent: 0, skipped: 0, failed: 0, gap: false };
      const tenant = await options.tenant(tenantRef);
      if (!tenant) return total;
      const api = apiFor(tenant);
      let cursor = await options.ledger.getCursor(tenantRef);
      for (let page = 0; page < pages; page++) {
        let read: Awaited<ReturnType<SlotlockNotifyApi['listChanges']>>;
        try {
          read = await api.listChanges(cursor);
        } catch (error) {
          if (!(error instanceof SlotlockApiError) || error.status !== 410 || cursor === null) throw error;
          cursor = null;
          total.gap = true;
          continue;
        }
        for (const change of read.changes) {
          const done = await handle(tenantRef, change);
          total.sent += done.sent;
          total.skipped += done.skipped;
          total.failed += done.failed;
        }
        cursor = read.next;
        await options.ledger.setCursor(tenantRef, cursor);
        if (read.changes.length === 0) break;
      }
      return total;
    },

    /**
     * Keep the attendees of each event to come (the next `days`, default 30) for its cancellation,
     * so events made before the notifier started, or while it was away, reach theirs too.
     */
    async rememberUpcoming(tenantRef: string, days = 30): Promise<number> {
      const tenant = await options.tenant(tenantRef);
      if (!tenant || tenant.notifyAttendees === false) return 0;
      const api = apiFor(tenant);
      const window = { start: now(), end: new Date(now().getTime() + days * 24 * 60 * 60 * 1_000) };
      let kept = 0;
      for (const resource of await api.listResources()) {
        for (const event of await api.listEvents(resource.id, window)) {
          await remember(tenantRef, event);
          kept += 1;
        }
      }
      return kept;
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
