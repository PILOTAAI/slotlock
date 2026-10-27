// A calendar event as the event tools return it, and as the application API returns any of a
// tenant's events. Its own module because both the agent server and the application API describe
// events with it, and the application API imports nothing from the agent server at runtime (the
// agent server imports it, so the reverse would be a cycle).
import { z } from 'zod';

const DATE_TIME = z.string().datetime({ offset: true });
const RESOURCE_ID = z.string().trim().min(1).max(200);
const EVENT_ID = z.string().trim().min(1).max(500);
const REVISION = z.number().int().positive();
// Output bounds mirror the trusted store's byte ceilings. A value admitted by a UTF-8 byte
// ceiling can never exceed that many UTF-16 code units, so every valid stored/provider event is
// serializable without truncating recurrence semantics or calendar identities.
const TRUSTED_SUMMARY_OUTPUT_MAX = 4_096;
const TRUSTED_TEXT_OUTPUT_MAX = 16_384;
const TRUSTED_PERSON_NAME_OUTPUT_MAX = 1_024;
const TRUSTED_RECURRENCE_EXCEPTION_OUTPUT_MAX = 1_000;
const TRUSTED_REMINDER_MINUTES_OUTPUT_MAX = 366 * 24 * 60;

// The grammar the store keeps an address in (normalizeEmail in sync.ts), so every stored one can be
// returned: an address from an imported feed need not be one z.email() takes (ops@localhost).
const STORED_ADDRESS = z
  .string()
  .min(3)
  .max(320)
  .refine((value) => /^[^\s@]+@[^\s@]+$/.test(value), {
    message: 'must be one @ between characters other than spaces',
  });

const ORGANIZER = z
  .object({
    address: STORED_ADDRESS,
    name: z.string().trim().max(TRUSTED_PERSON_NAME_OUTPUT_MAX).nullable(),
  })
  .strict();
const ATTENDEE = z
  .object({
    address: STORED_ADDRESS,
    name: z.string().trim().max(TRUSTED_PERSON_NAME_OUTPUT_MAX).nullable(),
    role: z.enum(['chair', 'required', 'optional', 'non_participant']),
    participation_status: z.enum([
      'needs_action',
      'accepted',
      'declined',
      'tentative',
      'delegated',
    ]),
    rsvp: z.boolean(),
  })
  .strict();
const REMINDER = z
  .object({
    minutes_before: z.number().int().min(0).max(TRUSTED_REMINDER_MINUTES_OUTPUT_MAX),
    channel: z.enum(['display', 'email']),
  })
  .strict();
const RECURRENCE_EXCEPTION = z
  .object({
    recurrence_id: DATE_TIME,
    cancelled: z.boolean(),
    starts_at: DATE_TIME.nullable(),
    ends_at: DATE_TIME.nullable(),
  })
  .strict();

export const SLOTLOCK_EVENT_OUTPUT = z
  .object({
    id: EVENT_ID,
    resource_id: RESOURCE_ID,
    starts_at: DATE_TIME,
    ends_at: DATE_TIME,
    timezone: z.string().min(1).max(100),
    title: z.string().max(TRUSTED_SUMMARY_OUTPUT_MAX).nullable(),
    description: z.string().max(TRUSTED_TEXT_OUTPUT_MAX).nullable(),
    location: z.string().max(TRUSTED_TEXT_OUTPUT_MAX).nullable(),
    organizer: ORGANIZER.nullable(),
    attendees: z.array(ATTENDEE).max(100),
    reminders: z.array(REMINDER).max(20),
    status: z.enum(['tentative', 'confirmed', 'cancelled']),
    transparency: z.enum(['opaque', 'transparent']),
    sequence: z.number().int().nonnegative(),
    revision: REVISION,
    recurrence_rule: z.string().max(TRUSTED_SUMMARY_OUTPUT_MAX).nullable(),
    recurrence_exceptions: z
      .array(RECURRENCE_EXCEPTION)
      .max(TRUSTED_RECURRENCE_EXCEPTION_OUTPUT_MAX),
    recurrence_id: DATE_TIME.nullable(),
  })
  .strict();

