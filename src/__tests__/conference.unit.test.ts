// Meeting links on events (RFC 0007 3.1): what the store keeps, what iCalendar and JSCalendar
// carry, what the tools accept and what a person confirms.
import ICAL from 'ical.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SlotlockAgentCalendarBackend,
  createSlotlockAgentServer,
  describeSlotlockAgentWrite,
} from '../agent-server.js';
import { projectSlotlockCalendarEvent } from '../agent-store-backend.js';
import { SLOTLOCK_EVENT_OUTPUT } from '../event-schema.js';
import { toJSCalendarEvent } from '../interop.js';
import { CalendarContractError, emitITipCalendar, normalizeCalendarEventContent } from '../sync.js';
import type { CalendarEventContent, SlotlockCalendarEvent } from '../types.js';

const CONTENT: CalendarEventContent = {
  start: new Date('2027-06-12T09:00:00Z'),
  end: new Date('2027-06-12T10:00:00Z'),
  timezone: 'Europe/London',
  summary: 'Handover call',
};
const LINK = 'https://meet.example.com/abc-defg-hij';
const userSupplied = (url: string) => ({ requested: 'user_supplied' as const, url });

describe('a meeting link in event content', () => {
  it('is kept as the URL parser writes it, ASCII, and only when asked for', () => {
    const normalized = normalizeCalendarEventContent({
      ...CONTENT,
      conference: userSupplied('https://Meet.Example.com/room?pwd=a,b;c'),
    });
    expect(normalized.conference).toEqual(userSupplied('https://meet.example.com/room?pwd=a,b;c'));
    // A host in another script is written as xn--, so a look-alike shows as one.
    expect(
      normalizeCalendarEventContent({ ...CONTENT, conference: userSupplied('https://zооm.us/j/1') })
        .conference?.url,
    ).toBe('https://xn--zm-fmca.us/j/1');
    // Content without a link has no conference key, so its command hashes as it did before links.
    expect(Object.keys(normalizeCalendarEventContent(CONTENT))).not.toContain('conference');
    expect(Object.keys(normalizeCalendarEventContent({ ...CONTENT, conference: userSupplied(LINK) })).at(-1)).toBe(
      'conference',
    );
  });

  it('refuses a link that is not https, carries credentials, spaces or controls, or is too long', () => {
    for (const url of [
      'http://meet.example.com/abc',
      'javascript:alert(1)',
      'data:text/html,<p>',
      'https://user:secret@meet.example.com/abc',
      'https://user@meet.example.com/abc',
      'https://meet.example.com/a b',
      'https://meet.example.com/a\nb',
      'https://meet.example.com/a\rMETHOD:CANCEL',
      'https://meet.example.com/a\u0085b',
      ' https://meet.example.com/abc',
      'meet.example.com/abc',
      'https://',
      `https://meet.example.com/${'a'.repeat(2_030)}`,
    ]) {
      expect(() => normalizeCalendarEventContent({ ...CONTENT, conference: userSupplied(url) }), url).toThrowError(
        CalendarContractError,
      );
    }
    expect(() =>
      normalizeCalendarEventContent({ ...CONTENT, conference: { requested: 'user_supplied' } }),
    ).toThrowError(CalendarContractError);
    expect(() =>
      normalizeCalendarEventContent({
        ...CONTENT,
        conference: { requested: 'auto' as never, url: LINK },
      }),
    ).toThrowError(CalendarContractError);
    expect(
      normalizeCalendarEventContent({
        ...CONTENT,
        conference: userSupplied(`https://meet.example.com/${'a'.repeat(2_048 - 25)}`),
      }).conference?.url,
    ).toHaveLength(2_048);
  });
});

describe('a meeting link in iCalendar', () => {
  const request = (event: Partial<CalendarEventContent>) =>
    new ICAL.Component(
      ICAL.parse(
        emitITipCalendar(
          {
            uid: 'call-1@slotlock.example',
            sequence: 0,
            organizer: { email: 'ana@example.com' },
            attendees: [{ email: 'ben@example.com' }],
            ...CONTENT,
            ...event,
          },
          'REQUEST',
        ),
      ),
    ).getFirstSubcomponent('vevent') as ICAL.Component;

  it('is an RFC 7986 CONFERENCE URI, its commas and semicolons unescaped', () => {
    const url = 'https://meet.example.com/j/1?pwd=a,b;c';
    const payload = emitITipCalendar(
      {
        uid: 'call-1@slotlock.example',
        organizer: { email: 'ana@example.com' },
        attendees: [{ email: 'ben@example.com' }],
        ...CONTENT,
        conference: userSupplied(url),
      },
      'REQUEST',
    );
    expect(payload.replace(/\r\n /g, '')).toContain(`CONFERENCE;FEATURE=VIDEO;VALUE=URI:${url}\r\n`);
    const conference = request({ conference: userSupplied(url) }).getFirstProperty('conference');
    expect(conference?.type).toBe('uri');
    expect(conference?.getFirstValue()).toBe(url);
  });

  it('is the place where there is none, and the last line of the description', () => {
    const bare = request({ conference: userSupplied(LINK) });
    expect(bare.getFirstPropertyValue('location')).toBe(LINK);
    expect(bare.getFirstPropertyValue('description')).toBe(`Join: ${LINK}`);
    const placed = request({
      conference: userSupplied(LINK),
      location: 'Depot 7',
      description: 'Bring the keys.',
    });
    expect(placed.getFirstPropertyValue('location')).toBe('Depot 7');
    expect(placed.getFirstPropertyValue('description')).toBe(`Bring the keys.\n\nJoin: ${LINK}`);
  });

  it('leaves a description at its bound as it is, and adds nothing without a link', () => {
    const full = 'd'.repeat(16_384);
    expect(request({ conference: userSupplied(LINK), description: full }).getFirstPropertyValue('description')).toBe(
      full,
    );
    const plain = request({});
    expect(plain.getFirstProperty('conference')).toBeNull();
    expect(plain.getFirstProperty('location')).toBeNull();
    expect(plain.getFirstProperty('description')).toBeNull();
  });

  it('refuses a link in output that the store would refuse', () => {
    expect(() =>
      emitITipCalendar(
        { uid: 'call-2@slotlock.example', ...CONTENT, conference: userSupplied('https://x.example/a\rMETHOD:CANCEL') },
        'PUBLISH',
      ),
    ).toThrowError(CalendarContractError);
  });
});

const STORED: SlotlockCalendarEvent = {
  id: '5e8ff9bf-55ba-4508-9d22-e984129be6b5',
  tenantRef: 't',
  ownerRef: 'o',
  externalRef: 'agent:call',
  resourceId: 'room-1',
  revision: 1,
  source: 'agent-server',
  materializationWindow: { start: CONTENT.start, end: CONTENT.end },
  createdAt: new Date('2027-06-01T10:00:00Z'),
  updatedAt: new Date('2027-06-01T10:00:00Z'),
  ...CONTENT,
  status: 'confirmed',
  transparency: 'opaque',
};

describe('a meeting link in what Slotlock returns', () => {
  it('is a JSCalendar virtual location', () => {
    expect(toJSCalendarEvent({ ...STORED, conference: userSupplied(LINK) }).virtualLocations).toEqual({
      v1: { '@type': 'VirtualLocation', uri: LINK, features: { video: true } },
    });
    expect(toJSCalendarEvent(STORED)).not.toHaveProperty('virtualLocations');
  });

  it('is the event output conference: ready, by the person, or null', () => {
    const linked = projectSlotlockCalendarEvent({ ...STORED, conference: userSupplied(LINK) });
    expect(linked.conference).toEqual({
      requested: 'user_supplied',
      provider: 'user_supplied',
      status: 'ready',
      join_url: LINK,
    });
    expect(SLOTLOCK_EVENT_OUTPUT.safeParse(linked).success).toBe(true);
    const plain = projectSlotlockCalendarEvent(STORED);
    expect(plain.conference).toBeNull();
    expect(SLOTLOCK_EVENT_OUTPUT.safeParse(plain).success).toBe(true);
    // A backend written before meeting links leaves the key out, and still answers.
    const { conference: _left, ...older } = plain;
    expect(SLOTLOCK_EVENT_OUTPUT.safeParse(older).success).toBe(true);
    expect(
      SLOTLOCK_EVENT_OUTPUT.safeParse({ ...plain, conference: { ...linked.conference as object, host_url: LINK } })
        .success,
    ).toBe(false);
  });
});

describe('a meeting link in the event tools', () => {
  const createEvent = vi.fn();
  const updateEvent = vi.fn();
  const bookTogether = vi.fn();
  const confirmHold = vi.fn();
  const backend = {
    listResources: vi.fn(async () => ({
      resources: [{ id: 'room-1', external_ref: 'room-1', timezone: 'Europe/London' }],
      next_cursor: null,
    })),
    getFreeBusy: vi.fn(),
    findNextAvailable: vi.fn(),
    listEvents: vi.fn(),
    getEvent: vi.fn(),
    createEvent,
    updateEvent,
    deleteEvent: vi.fn(),
    bookTogether,
    confirmHold,
  } as unknown as SlotlockAgentCalendarBackend;
  const EVENT = projectSlotlockCalendarEvent({ ...STORED, conference: userSupplied(LINK) });
  const server = createSlotlockAgentServer({
    publicBaseUrl: 'https://calendar.example.com',
    backend,
    authenticate: async () => ({ subject: 'agent-1', tenantRef: 'tenant-a' }),
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
    rest: true,
  });
  const post = (path: string, body: unknown) =>
    server.fetch(
      new Request(`https://calendar.example.com${path}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const BOOKING = {
    resource_id: 'room-1',
    starts_at: '2027-06-12T09:00:00Z',
    ends_at: '2027-06-12T10:00:00Z',
    timezone: 'Europe/London',
    title: 'Handover call',
    idempotency_key: 'call-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    createEvent.mockResolvedValue({ event: EVENT, replayed: false });
    bookTogether.mockResolvedValue({ events: [EVENT, { ...EVENT, resource_id: 'room-2' }], replayed: false });
  });

  it('takes a link alone or with user_supplied, and returns it', async () => {
    for (const asked of [{ conference_url: LINK }, { conference: 'user_supplied', conference_url: LINK }]) {
      const response = await post('/v1/events', { ...BOOKING, ...asked });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { event: { conference: unknown } }).event.conference).toEqual({
        requested: 'user_supplied',
        provider: 'user_supplied',
        status: 'ready',
        join_url: LINK,
      });
      expect(createEvent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining(asked));
    }
  });

  it('refuses user_supplied without a link, a link with none, and a link that is not https', async () => {
    for (const asked of [
      { conference: 'user_supplied' },
      { conference: 'none', conference_url: LINK },
      { conference_url: 'http://meet.example.com/abc' },
      { conference: 'auto' },
    ]) {
      const response = await post('/v1/events', { ...BOOKING, ...asked });
      expect([response.status, ((await response.json()) as { error: { code: string } }).error.code], JSON.stringify(asked)).toEqual([
        400,
        'invalid_arguments',
      ]);
    }
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('gives every resource booked together the link it was asked for', async () => {
    const response = await post('/v1/bundles', {
      ...BOOKING,
      resource_id: undefined,
      resource_ids: ['room-1', 'room-2'],
      conference_url: LINK,
    });
    expect(response.status).toBe(200);
    expect(bookTogether).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conference_url: LINK }));
  });

  it('names the link by its host in the question a person confirms', async () => {
    const ask = (operation: 'slotlock_create_event' | 'slotlock_book_together' | 'slotlock_update_event', input: Record<string, unknown>) =>
      describeSlotlockAgentWrite({
        backend,
        authorize: async () => true,
        principal: { subject: 'agent-1', tenantRef: 'tenant-a' },
        operation,
        input,
        signal: new AbortController().signal,
      });
    expect(await ask('slotlock_create_event', { ...BOOKING, conference_url: 'https://zооm.us/j/1' })).toContain(
      '(also meeting link on xn--zm-fmca.us)',
    );
    expect(
      await ask('slotlock_book_together', {
        ...BOOKING,
        resource_ids: ['room-1', 'room-2'],
        conference_url: LINK,
      }),
    ).toContain('(also meeting link on meet.example.com)');
    (backend.getEvent as ReturnType<typeof vi.fn>).mockResolvedValue({ event: EVENT });
    expect(
      await ask('slotlock_update_event', {
        event_id: EVENT.id,
        expected_revision: 1,
        conference: 'none',
        idempotency_key: 'drop-link',
      }),
    ).toContain(': also meeting link removed.');
    expect(await ask('slotlock_create_event', { ...BOOKING, conference: 'none' })).not.toContain('meeting link');
  });
});
