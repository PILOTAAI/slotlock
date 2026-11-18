// An event's invitation, for the agent to send from the person's own mailbox (RFC 0007 4.1): an iTIP
// iCalendar, a subject and a short plain-text body. Slotlock returns it and sends nothing, so replies
// go to the person and Slotlock is never the sender.
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { SLOTLOCK_EVENT_OUTPUT } from './event-schema.js';
import { type ICalendarEvent, type ITipMethod, emitITipCalendar } from './sync.js';
import type { CalendarAttendee, CalendarOrganizer, SlotlockEventInvitationRefusal } from './types.js';

export type SlotlockEventInvitationMethod = 'request' | 'cancel' | 'publish';

/** The most an invitation's iCalendar may be: an agent passes it on whole, as one attachment. */
export const SLOTLOCK_EVENT_INVITATION_MAX_BYTES = 262_144;

/** What an invitation is attached as. */
export const SLOTLOCK_EVENT_INVITATION_FILENAME = 'invite.ics';

export interface SlotlockEventInvitation {
  method: SlotlockEventInvitationMethod;
  ical_uid: string;
  sequence: number;
  /** `text/calendar; charset=utf-8; method=…`, the attachment's media type (RFC 6047). */
  content_type: string;
  filename: string;
  ical: string;
  /** The organizer's address: the mailbox to send from, so replies reach the person. */
  organizer: string | null;
  /** Every attendee's address; none for `publish`. */
  recipients: string[];
  join_url: string | null;
  subject: string;
  text: string;
}

export type SlotlockEventInvitationResult =
  | { ok: true; invitation: SlotlockEventInvitation }
  | { ok: false; code: SlotlockEventInvitationRefusal };

type ToolEvent = z.infer<typeof SLOTLOCK_EVENT_OUTPUT>;

const METHODS: Readonly<Record<SlotlockEventInvitationMethod, ITipMethod>> = Object.freeze({
  request: 'REQUEST',
  cancel: 'CANCEL',
  publish: 'PUBLISH',
});

/**
 * The iCalendar UID an event keeps in every invitation: a UUID (RFC 9562 version 8) made from
 * SHA-256 of the tenant and the event's id. It names neither, and cannot be turned back into
 * either; the same event always gets the same one, so a cancellation matches its request.
 */
export function slotlockICalUid(tenantRef: string, eventId: string): string {
  const bytes = createHash('sha256')
    .update(`slotlock ical uid v1\0${tenantRef}\0${eventId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The invitation for an event as the event tools return it. `request` invites its attendees and
 * needs an organizer and at least one attendee. `cancel` withdraws a request: the same UID at the
 * SEQUENCE the cancellation will give the event, so it is read before cancelling and sent after.
 * `publish` is a copy for a calendar, without attendees (RFC 5546 §3.2.1).
 */
export function slotlockEventInvitation(
  event: ToolEvent,
  method: SlotlockEventInvitationMethod,
  options: { tenantRef: string; now: Date },
): SlotlockEventInvitationResult {
  const organizer: CalendarOrganizer | undefined = event.organizer
    ? { email: event.organizer.address, ...(event.organizer.name ? { name: event.organizer.name } : {}) }
    : undefined;
  const attendees: CalendarAttendee[] =
    method === 'publish'
      ? []
      : event.attendees.map((attendee) => ({
          email: attendee.address,
          ...(attendee.name ? { name: attendee.name } : {}),
          role: attendee.role,
          participationStatus: attendee.participation_status,
          rsvp: attendee.rsvp,
        }));
  if (method !== 'publish') {
    if (!organizer) return { ok: false, code: 'organizer_required' };
    if (attendees.length === 0) return { ok: false, code: 'attendees_required' };
  }
  const joinUrl = event.conference?.join_url ?? null;
  const exceptions = event.recurrence_exceptions;
  // Each moved or cancelled occurrence repeats the event's content in its own VEVENT: an event too
  // large to send is refused before it is written out.
  const perComponent =
    Buffer.byteLength(
      JSON.stringify([event.title, event.description, event.location, event.organizer, attendees, joinUrl]),
      'utf8',
    ) + 1_024;
  if ((1 + exceptions.length) * perComponent > SLOTLOCK_EVENT_INVITATION_MAX_BYTES) {
    return { ok: false, code: 'invitation_too_large' };
  }
  const uid = slotlockICalUid(options.tenantRef, event.id);
  const sequence = method === 'cancel' ? event.revision + 1 : event.revision;
  const title = event.title ?? 'Busy';
  const input: ICalendarEvent = {
    uid,
    sequence,
    updatedAt: new Date(Math.floor(options.now.getTime() / 1_000) * 1_000),
    start: new Date(event.starts_at),
    end: new Date(event.ends_at),
    timezone: event.timezone,
    summary: title,
    status: event.status === 'tentative' ? 'tentative' : 'confirmed',
    transparency: event.transparency,
    ...(event.description !== null ? { description: event.description } : {}),
    ...(event.location !== null ? { location: event.location } : {}),
    ...(organizer ? { organizer } : {}),
    ...(attendees.length > 0 ? { attendees } : {}),
    ...(event.recurrence_rule !== null
      ? {
          recurrence: {
            rrule: event.recurrence_rule,
            exceptions: exceptions.map((exception) => ({
              recurrenceId: new Date(exception.recurrence_id),
              ...(exception.cancelled ? { cancelled: true } : {}),
              ...(exception.starts_at !== null ? { start: new Date(exception.starts_at) } : {}),
              ...(exception.ends_at !== null ? { end: new Date(exception.ends_at) } : {}),
            })),
          },
        }
      : {}),
    // Written as RFC 7986 CONFERENCE, the place where there is none, and the description's last line.
    ...(joinUrl !== null ? { conference: { requested: 'user_supplied', url: joinUrl } } : {}),
  };
  const ical = emitITipCalendar(input, METHODS[method]);
  if (Buffer.byteLength(ical, 'utf8') > SLOTLOCK_EVENT_INVITATION_MAX_BYTES) {
    return { ok: false, code: 'invitation_too_large' };
  }
  const when = invitationWhen(input.start, input.end, event.timezone);
  const lines =
    method === 'cancel'
      ? [`Cancelled: ${title}`, when]
      : [
          title,
          when,
          ...(event.recurrence_rule !== null ? ['Repeats: the attached invitation has the schedule.'] : []),
          ...(joinUrl !== null ? [`Join: ${joinUrl}`] : []),
          ...(event.location !== null ? [`Where: ${event.location}`] : []),
          ...(event.description !== null ? ['', event.description] : []),
        ];
  return {
    ok: true,
    invitation: {
      method,
      ical_uid: uid,
      sequence,
      content_type: `text/calendar; charset=utf-8; method=${METHODS[method]}`,
      filename: SLOTLOCK_EVENT_INVITATION_FILENAME,
      ical,
      organizer: organizer?.email ?? null,
      recipients: attendees.map((attendee) => attendee.email),
      join_url: joinUrl,
      subject: method === 'cancel' ? `Cancelled: ${title}` : title,
      text: `${lines.join('\n')}\n`,
    },
  };
}

/** "Tuesday, 2 March 2027, 09:00–10:00 (Europe/London)", or from one day to another. */
function invitationWhen(start: Date, end: Date, zone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  // An end at midnight closes the day before it.
  return day.format(start) === day.format(new Date(end.getTime() - 1))
    ? `${day.format(start)}, ${time.format(start)}–${time.format(end)} (${zone})`
    : `${day.format(start)}, ${time.format(start)} to ${day.format(end)}, ${time.format(end)} (${zone})`;
}
