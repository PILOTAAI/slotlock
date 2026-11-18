// slotlock_get_invitation (RFC 0007 4.1): the invitation an agent sends from the person's own
// mailbox. Slotlock returns it and sends nothing.
import ICAL from 'ical.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  type SlotlockAgentCalendarBackend,
  createSlotlockAgentServer,
} from '../agent-server.js';
import { projectSlotlockCalendarEvent } from '../agent-store-backend.js';
import { SLOTLOCK_EVENT_OUTPUT } from '../event-schema.js';
import { SLOTLOCK_EVENT_INVITATION_MAX_BYTES, slotlockICalUid, slotlockEventInvitation } from '../event-invitation.js';
import type { SlotlockCalendarEvent } from '../types.js';

const INTERNAL_ID = '5e8ff9bf-55ba-4508-9d22-e984129be6b5';
const EVENT_ID = 'agent:9c4f1e1a5d6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d';
const LINK = 'https://meet.example.com/abc-defg-hij';
const NOW = new Date('2027-06-01T08:30:15.250Z');

const STORED: SlotlockCalendarEvent = {
  id: INTERNAL_ID,
  tenantRef: 'tenant-a',
  ownerRef: 'agent:owner',
  externalRef: EVENT_ID,
  resourceId: 'room-1',
  revision: 3,
  source: 'agent-server',
  materializationWindow: { start: new Date('2027-06-12T09:00:00Z'), end: new Date('2027-06-12T10:00:00Z') },
  createdAt: new Date('2027-06-01T08:00:00Z'),
  updatedAt: new Date('2027-06-01T08:00:00Z'),
  start: new Date('2027-06-12T09:00:00Z'),
  end: new Date('2027-06-12T10:00:00Z'),
  timezone: 'Europe/London',
  summary: 'Handover call',
  description: 'Bring the keys.',
  status: 'confirmed',
  transparency: 'opaque',
  organizer: { email: 'ana@example.com', name: 'Ana' },
  attendees: [
    { email: 'ben@example.com', name: 'Ben', role: 'required', participationStatus: 'needs_action', rsvp: true },
    { email: 'cy@example.com', role: 'optional', participationStatus: 'needs_action', rsvp: false },
  ],
  conference: { requested: 'user_supplied', url: LINK },
};
/** Changes to the stored event; `undefined` removes a field. */
type Changes = { [Key in keyof SlotlockCalendarEvent]?: SlotlockCalendarEvent[Key] | undefined };
const event = (changes: Changes = {}) =>
  SLOTLOCK_EVENT_OUTPUT.parse(projectSlotlockCalendarEvent({ ...STORED, ...changes } as SlotlockCalendarEvent));
const invite = (method: 'request' | 'cancel' | 'publish', changes: Changes = {}) =>
  slotlockEventInvitation(event(changes), method, { tenantRef: 'tenant-a', now: NOW });
const vevent = (ical: string) =>
  new ICAL.Component(ICAL.parse(ical)).getFirstSubcomponent('vevent') as ICAL.Component;

describe('an event invitation', () => {
  it('keeps one UID per event, made from a hash, that names neither the tenant nor the event', () => {
    const uid = slotlockICalUid('tenant-a', EVENT_ID);
    expect(uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(slotlockICalUid('tenant-a', EVENT_ID)).toBe(uid);
    expect(slotlockICalUid('tenant-b', EVENT_ID)).not.toBe(uid);
    expect(slotlockICalUid('tenant-a', `${EVENT_ID}0`)).not.toBe(uid);
  });

  it('is an iTIP request from the organizer to every attendee, with the link, at the revision', () => {
    const result = invite('request');
    if (!result.ok) throw new Error(result.code);
    const { invitation } = result;
    expect(invitation).toMatchObject({
      method: 'request',
      ical_uid: slotlockICalUid('tenant-a', EVENT_ID),
      sequence: 3,
      content_type: 'text/calendar; charset=utf-8; method=REQUEST',
      filename: 'invite.ics',
      organizer: 'ana@example.com',
      recipients: ['ben@example.com', 'cy@example.com'],
      join_url: LINK,
      subject: 'Handover call',
    });
    expect(invitation.text).toBe(
      `Handover call\nSaturday, 12 June 2027, 10:00–11:00 (Europe/London)\nJoin: ${LINK}\n\nBring the keys.\n`,
    );
    const calendar = new ICAL.Component(ICAL.parse(invitation.ical));
    expect(calendar.getFirstPropertyValue('method')).toBe('REQUEST');
    const component = vevent(invitation.ical);
    expect(component.getFirstPropertyValue('uid')).toBe(invitation.ical_uid);
    expect(component.getFirstPropertyValue('sequence')).toBe(3);
    expect(component.getFirstPropertyValue('organizer')).toBe('mailto:ana@example.com');
    expect(component.getAllProperties('attendee').map((property) => property.getFirstValue())).toEqual([
      'mailto:ben@example.com',
      'mailto:cy@example.com',
    ]);
    expect(component.getFirstProperty('conference')?.getFirstValue()).toBe(LINK);
    // DTSTAMP is when it was written, to the second.
    expect(String(component.getFirstPropertyValue('dtstamp'))).toBe('2027-06-01T08:30:15Z');
  });

  it('never carries the event id, the agent digest or the internal id', () => {
    for (const method of ['request', 'cancel', 'publish'] as const) {
      const result = invite(method);
      if (!result.ok) throw new Error(result.code);
      const written = JSON.stringify(result.invitation);
      expect(written).not.toContain(INTERNAL_ID);
      expect(written).not.toContain(EVENT_ID.slice('agent:'.length, 'agent:'.length + 12));
      expect(written).not.toContain('agent:');
    }
  });

  it('cancels with the same UID at the sequence cancelling makes', () => {
    const request = invite('request');
    const cancel = invite('cancel');
    if (!request.ok || !cancel.ok) throw new Error('refused');
    expect(cancel.invitation).toMatchObject({
      ical_uid: request.invitation.ical_uid,
      sequence: 4,
      content_type: 'text/calendar; charset=utf-8; method=CANCEL',
      subject: 'Cancelled: Handover call',
      recipients: ['ben@example.com', 'cy@example.com'],
    });
    expect(cancel.invitation.text).toBe('Cancelled: Handover call\nSaturday, 12 June 2027, 10:00–11:00 (Europe/London)\n');
    const component = vevent(cancel.invitation.ical);
    expect(component.getFirstPropertyValue('status')).toBe('CANCELLED');
    expect(component.getFirstPropertyValue('sequence')).toBe(4);
  });

  it('publishes a copy without attendees, which needs neither organizer nor attendee', () => {
    const result = invite('publish', { organizer: undefined, attendees: [] });
    if (!result.ok) throw new Error(result.code);
    expect(result.invitation).toMatchObject({ organizer: null, recipients: [] });
    const component = vevent(result.invitation.ical);
    expect(component.getAllProperties('attendee')).toHaveLength(0);
    expect(new ICAL.Component(ICAL.parse(result.invitation.ical)).getFirstPropertyValue('method')).toBe('PUBLISH');
    const withAttendees = invite('publish');
    if (!withAttendees.ok) throw new Error(withAttendees.code);
    expect(vevent(withAttendees.invitation.ical).getAllProperties('attendee')).toHaveLength(0);
  });

  it('refuses a request or cancellation without an organizer or an attendee', () => {
    for (const method of ['request', 'cancel'] as const) {
      expect(invite(method, { organizer: undefined })).toEqual({ ok: false, code: 'organizer_required' });
      expect(invite(method, { attendees: [] })).toEqual({ ok: false, code: 'attendees_required' });
    }
  });

  it('says a series repeats, and spans days by naming both', () => {
    const series = invite('request', { recurrence: { rrule: 'FREQ=WEEKLY;COUNT=4' } });
    if (!series.ok) throw new Error(series.code);
    expect(series.invitation.text).toContain('\nRepeats: the attached invitation has the schedule.\n');
    expect(vevent(series.invitation.ical).getFirstPropertyValue('rrule')?.toString()).toBe('FREQ=WEEKLY;COUNT=4');
    const long = invite('request', {
      end: new Date('2027-06-14T08:00:00Z'),
      location: 'Depot 7',
      conference: undefined,
      description: undefined,
    });
    if (!long.ok) throw new Error(long.code);
    expect(long.invitation.text).toBe(
      'Handover call\nSaturday, 12 June 2027, 10:00 to Monday, 14 June 2027, 09:00 (Europe/London)\nWhere: Depot 7\n',
    );
    expect(long.invitation.join_url).toBeNull();
  });

  it('refuses an event too large to send whole, before writing it out', () => {
    const exceptions = Array.from({ length: 40 }, (_, week) => ({
      recurrenceId: new Date(Date.UTC(2027, 5, 12 + week * 7, 9)),
      start: new Date(Date.UTC(2027, 5, 12 + week * 7, 11)),
      end: new Date(Date.UTC(2027, 5, 12 + week * 7, 12)),
    }));
    const large = invite('request', {
      description: 'd'.repeat(10_000),
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=50', exceptions },
    });
    expect(large).toEqual({ ok: false, code: 'invitation_too_large' });
    const fits = invite('request', {
      description: 'd'.repeat(1_000),
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=50', exceptions },
    });
    if (!fits.ok) throw new Error(fits.code);
    expect(Buffer.byteLength(fits.invitation.ical)).toBeLessThan(SLOTLOCK_EVENT_INVITATION_MAX_BYTES);
  });
});

describe('slotlock_get_invitation', () => {
  const getEvent = vi.fn();
  const backend = {
    listResources: vi.fn(),
    getFreeBusy: vi.fn(),
    findNextAvailable: vi.fn(),
    listEvents: vi.fn(),
    getEvent,
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
  } as unknown as SlotlockAgentCalendarBackend;
  const onError = vi.fn();
  const server = createSlotlockAgentServer({
    publicBaseUrl: 'https://calendar.example.com',
    backend,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer reader'
        ? { subject: 'agent-1', tenantRef: 'tenant-a', scopes: ['read'] }
        : null,
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
    rest: true,
    onError,
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    server.fetch(
      new Request(`https://calendar.example.com${path}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer reader',
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  const mcpCall = (args: Record<string, unknown>) =>
    post(
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slotlock_get_invitation', arguments: args } },
      { 'MCP-Protocol-Version': '2025-11-25' },
    );

  beforeEach(() => {
    vi.clearAllMocks();
    getEvent.mockResolvedValue({ event: event() });
  });

  it('answers a read key over REST, for the method asked', async () => {
    const response = await server.fetch(
      new Request(`https://calendar.example.com/v1/events/${encodeURIComponent(EVENT_ID)}/invitation?method=cancel`, {
        headers: { Authorization: 'Bearer reader' },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ method: 'cancel', sequence: 4, recipients: ['ben@example.com', 'cy@example.com'] });
    expect(getEvent).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'slotlock_get_event' }),
      { event_id: EVENT_ID },
    );
    getEvent.mockResolvedValue({ event: event({ organizer: undefined }) });
    const refused = await server.fetch(
      new Request(`https://calendar.example.com/v1/events/${encodeURIComponent(EVENT_ID)}/invitation`, {
        headers: { Authorization: 'Bearer reader' },
      }),
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('organizer_required');
  });

  it('attaches the iCalendar over MCP as an embedded text/calendar resource', async () => {
    const response = await mcpCall({ event_id: EVENT_ID });
    const { result } = (await response.json()) as {
      result: {
        content: Array<{ type: string; text?: string; resource?: { uri: string; mimeType: string; text: string } }>;
        structuredContent: { ical: string; ical_uid: string };
      };
    };
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: 'resource',
      resource: {
        uri: `slotlock://invitations/${result.structuredContent.ical_uid}/invite.ics`,
        mimeType: 'text/calendar',
        text: result.structuredContent.ical,
      },
    });
    // A result without an invitation carries only its JSON.
    getEvent.mockResolvedValue({ event: event({ attendees: [] }) });
    const refused = (await (await mcpCall({ event_id: EVENT_ID })).json()) as {
      result: { content: unknown[]; isError: boolean };
    };
    expect(refused.result).toMatchObject({ isError: true });
    expect(refused.result.content).toHaveLength(1);
  });

  it('attaches the iCalendar over A2A as a text/calendar part', async () => {
    const response = await post(
      '/a2a',
      {
        jsonrpc: '2.0',
        id: 'a2a-1',
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'message-1',
            role: 'ROLE_USER',
            parts: [
              {
                data: { skill: 'slotlock_get_invitation', arguments: { event_id: EVENT_ID, method: 'publish' } },
                mediaType: 'application/json',
              },
            ],
          },
        },
      },
      { 'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION },
    );
    const parts = ((await response.json()) as { result: { message: { parts: Array<Record<string, unknown>> } } })
      .result.message.parts;
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      text: (parts[0]?.data as { ical: string }).ical,
      mediaType: 'text/calendar',
      filename: 'invite.ics',
    });
  });

  it('is a server fault, not an invitation, when the backend answers an event outside its schema', async () => {
    getEvent.mockResolvedValue({ event: { ...event(), revision: 'three' } });
    const response = (await (await mcpCall({ event_id: EVENT_ID })).json()) as { result?: unknown; error?: unknown };
    expect(JSON.stringify(response)).not.toContain('BEGIN:VCALENDAR');
    expect(onError).toHaveBeenCalled();
  });
});
