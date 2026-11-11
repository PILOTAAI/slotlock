// What a message says (RFC 0004 C2): one template per kind of message, each a subject and a text
// (and an HTML body for email), with `{{name}}` placeholders. A tenant may replace any of them.
// Values put into HTML are escaped; a placeholder with no value is left empty.

export type NotifyMessageKind = 'confirmed' | 'rescheduled' | 'cancelled' | 'reminder';

export interface NotifyTemplate {
  subject: string;
  text: string;
  /** Email only; without it, email is sent as text. */
  html?: string;
}

export type NotifyTemplates = Record<NotifyMessageKind, NotifyTemplate>;

/** What a template may name. */
export interface NotifyTemplateValues {
  /** The person's name, or empty. */
  name: string;
  /** The event's title, or the resource's name or reference. */
  what: string;
  /** When it starts and ends, in the resource's or event's zone and the person's language. */
  when: string;
  /** When it started before a move. */
  previously: string;
  /** The booking's reference, or the event's id. */
  reference: string;
  /** Who sends: the tenant's name. */
  sender: string;
}

export const DEFAULT_TEMPLATES: NotifyTemplates = Object.freeze({
  confirmed: {
    subject: 'Booked: {{what}}, {{when}}',
    text: 'Hello {{name}},\n\nYou are booked: {{what}}, {{when}}.\nReference: {{reference}}\n\n{{sender}}',
    html: '<p>Hello {{name}},</p><p>You are booked: <strong>{{what}}</strong>, {{when}}.</p><p>Reference: {{reference}}</p><p>{{sender}}</p>',
  },
  rescheduled: {
    subject: 'Moved: {{what}}, now {{when}}',
    text: 'Hello {{name}},\n\n{{what}} has moved to {{when}} (it was {{previously}}).\nReference: {{reference}}\n\n{{sender}}',
    html: '<p>Hello {{name}},</p><p><strong>{{what}}</strong> has moved to {{when}} (it was {{previously}}).</p><p>Reference: {{reference}}</p><p>{{sender}}</p>',
  },
  cancelled: {
    subject: 'Cancelled: {{what}}, {{when}}',
    text: 'Hello {{name}},\n\n{{what}}, {{when}}, is cancelled.\nReference: {{reference}}\n\n{{sender}}',
    html: '<p>Hello {{name}},</p><p><strong>{{what}}</strong>, {{when}}, is cancelled.</p><p>Reference: {{reference}}</p><p>{{sender}}</p>',
  },
  reminder: {
    subject: 'Reminder: {{what}}, {{when}}',
    text: 'Hello {{name}},\n\nA reminder: {{what}}, {{when}}.\nReference: {{reference}}\n\n{{sender}}',
    html: '<p>Hello {{name}},</p><p>A reminder: <strong>{{what}}</strong>, {{when}}.</p><p>Reference: {{reference}}</p><p>{{sender}}</p>',
  },
});

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function fill(template: string, values: NotifyTemplateValues, escape: boolean): string {
  return template.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (_, name: string) => {
    const value = Object.hasOwn(values, name) ? String(values[name as keyof NotifyTemplateValues]) : '';
    return escape ? value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] as string) : value;
  });
}

/** A template filled in: subject and text as they are, HTML with its values escaped. */
export function renderTemplate(template: NotifyTemplate, values: NotifyTemplateValues): NotifyTemplate {
  return {
    // A subject is one line.
    subject: fill(template.subject, values, false).replace(/[\r\n]+/g, ' ').trim(),
    text: fill(template.text, values, false),
    ...(template.html ? { html: fill(template.html, values, true) } : {}),
  };
}

/** `start` to `end`, as `locale` says it in `timeZone`. */
export function formatWhen(start: Date, end: Date, timeZone: string, locale = 'en-GB'): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone }).formatRange(start, end);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).formatRange(start, end);
  }
}
