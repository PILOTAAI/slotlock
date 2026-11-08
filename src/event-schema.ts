// A calendar event as the event tools and the application API return it. Its own module so the
// application API need not import the agent server at runtime (that would be a cycle).
import { z } from 'zod';

const DATE_TIME = z.string().datetime({ offset: true });
const RESOURCE_ID = z.string().trim().min(1).max(200);
const EVENT_ID = z.string().trim().min(1).max(500);
const REVISION = z.number().int().positive();
// Output bounds mirror the store's UTF-8 byte ceilings, which never exceed as many UTF-16 code
// units, so every stored event serializes untruncated.
const TRUSTED_SUMMARY_OUTPUT_MAX = 4_096;
const TRUSTED_TEXT_OUTPUT_MAX = 16_384;
const TRUSTED_PERSON_NAME_OUTPUT_MAX = 1_024;
const TRUSTED_RECURRENCE_EXCEPTION_OUTPUT_MAX = 1_000;
const TRUSTED_REMINDER_MINUTES_OUTPUT_MAX = 366 * 24 * 60;

// The grammar the store keeps an address in (sync.ts normalizeEmail): an imported address need not
// pass z.email() (ops@localhost).
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

