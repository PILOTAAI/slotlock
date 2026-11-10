// The notifier (RFC 0004 C2): reads a tenant's changes (polled, or delivered by webhook) and tells
// the people they concern. A booking that names a contact tells them on the channels they agreed
// to; an event tells its attendees by email; a reminder that came due (`reminder.due`, action
// email) reminds them. `notify: false` on a booking or event tells no one. Each send is claimed in
// the ledger under the change's id, its channel and its recipient before it is made, so it is made
// once, however often the change is read.
import { type NotifyChannel, ChannelError } from './channels.js';
import type { NotifyChannelKind, NotifyLedger, RememberedRecipient } from './ledger.js';
import {
  type SlotlockChange,
  type SlotlockContact,
  type SlotlockNotifyApi,
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
}

export interface HandleResult {
  sent: number;
  /** Already sent, being sent, opted out, or with no channel or sender for it. */
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

export function createNotifier(options: NotifierOptions) {
  const maxAttempts = options.maxAttempts ?? 5;

  async function messageFor(
    api: SlotlockNotifyApi,
    tenantRef: string,
    tenant: NotifyTenant,
    change: SlotlockChange,
  ): Promise<{ kind: NotifyMessageKind; recipients: Recipient[]; what: string; zone: string; reference: string } | null> {
    const data = change.data;
    if (data.notify === false) return null;
    const before = data.before as { start?: unknown; end?: unknown } | undefined;
    const moved =
      before !== undefined && (String(before.start) !== String(data.start) || String(before.end) !== String(data.end));
    if (change.type.startsWith('reservation.')) {
      const kind: NotifyMessageKind | null =
        change.type === 'reservation.created'
          ? 'confirmed'
          : change.type === 'reservation.rescheduled'
            ? 'rescheduled'
            : change.type === 'reservation.cancelled'
              ? 'cancelled'
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
    const attendees = (event: { attendees: { address: string; name?: string | null }[] }): RememberedRecipient[] =>
      event.attendees.map((attendee) => ({ address: attendee.address, name: attendee.name ?? null }));
    if (change.type === 'event.cancelled') {
      // The event is gone: tell those it had when last read, then forget them.
      const remembered = await options.ledger.recallRecipients(tenantRef, eventId);
      return {
        kind: 'cancelled',
        recipients: remembered.map((person) => ({ channel: 'email' as const, address: person.address, name: person.name, locale: null })),
        what: 'Your booking',
        zone: typeof data.timezone === 'string' ? data.timezone : 'UTC',
        reference: eventId,
      };
    }
    const kind: NotifyMessageKind | null =
      change.type === 'event.created'
        ? 'confirmed'
        : change.type === 'event.updated' && moved
          ? 'rescheduled'
          : change.type === 'reminder.due' && data.action === 'email'
            ? 'reminder'
            : null;
    if (change.type !== 'event.updated' && change.type !== 'event.created' && change.type !== 'reminder.due') return null;
    const event = await api.getEvent(eventId);
    if (!event) return null;
    // Kept for a cancellation, which no longer reads the event.
    await options.ledger.rememberRecipients(tenantRef, eventId, attendees(event));
    if (!kind) return null;
    return {
      kind,
      recipients: attendees(event).map((person) => ({ channel: 'email' as const, address: person.address, name: person.name, locale: null })),
      what: event.title ?? 'Your booking',
      zone: event.timezone,
      reference: eventId,
    };
  }

  /** Tell the people one change concerns. */
  async function handle(tenantRef: string, change: SlotlockChange): Promise<HandleResult> {
    const result: HandleResult = { sent: 0, skipped: 0, failed: 0 };
    const tenant = await options.tenant(tenantRef);
    if (!tenant) return result;
    const api = createSlotlockNotifyApi({ baseUrl: options.slotlockUrl, apiKey: tenant.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const message = await messageFor(api, tenantRef, tenant, change);
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
     */
    async poll(tenantRef: string, pages = 20): Promise<HandleResult> {
      const total: HandleResult = { sent: 0, skipped: 0, failed: 0 };
      const tenant = await options.tenant(tenantRef);
      if (!tenant) return total;
      const api = createSlotlockNotifyApi({ baseUrl: options.slotlockUrl, apiKey: tenant.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) });
      let cursor = await options.ledger.getCursor(tenantRef);
      for (let page = 0; page < pages; page++) {
        const read = await api.listChanges(cursor);
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
  };
}
