// Team invitations by email (dashboard.ts SlotlockInvitationSender): a transactional message with
// the link, sent through Resend or Postmark with the deployment's own key. Nothing else is sent, and
// no address is kept by this module.
import { createHash } from 'node:crypto';
import type { SlotlockInvitationSender } from './dashboard.js';

/** Where invitations are sent from (SLOTLOCK_INVITATION_EMAIL, _KEY, _FROM). */
export interface SlotlockInvitationEmailConfig {
  provider: 'resend' | 'postmark';
  /** Resend's API key, or Postmark's server token. */
  key: string;
  /** The sender, as the provider has it verified: `Slotlock <team@example.com>` or an address. */
  from: string;
}

type Invitation = Parameters<SlotlockInvitationSender['send']>[0];

/** A provider's refusal: its name and HTTP status alone (its text can echo the address). */
export class SlotlockInvitationEmailError extends Error {
  override name = 'SlotlockInvitationEmailError';
}

/** Resend refuses a request without a User-Agent (403), and a Worker's fetch sends none. */
const USER_AGENT = 'Slotlock (+https://slotlock.pylota.io)';

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/**
 * The message an invitation sends: a formal subject, and text and HTML saying the same, with no
 * marketing, no image and no link but the invitation's. The HTML is built as mail clients render it:
 * tables, inline styles, one button that is a link in a coloured cell, the link again as text for a
 * client that drops the button, a preheader, and dark colours where the client honours them.
 */
export function slotlockInvitationEmail(
  invitation: Invitation,
  brandName = 'Slotlock',
): { subject: string; text: string; html: string } {
  const until = `${invitation.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const subject = `Invitation to join ${invitation.workspace} on ${brandName}`;
  const said = `${invitation.inviter} invited you to join ${invitation.workspace} on ${brandName} as ${invitation.role}.`;
  const facts: [string, string][] = [
    ['Team', invitation.workspace],
    ['Role', invitation.role],
    ['Invited by', invitation.inviter],
    ['Expires', until],
  ];
  const ignore = 'The link works once, for this address. If you weren’t expecting this invitation, you can ignore this email: nothing happens unless you use the link.';
  const text = [
    subject,
    said,
    `Accept the invitation: ${invitation.link}`,
    facts.map(([label, value]) => `${label}: ${value}`).join('\n'),
    ignore,
  ].join('\n\n');
  const factRows = facts
    .map(
      ([label, value], index) =>
        `<tr><td class="muted rule" style="padding:10px 0;${index === 0 ? '' : 'border-top:1px solid #ECECEC;'}font-family:${FONT};font-size:13px;line-height:20px;color:#767676;">${escape(label)}</td><td class="ink rule" align="right" style="padding:10px 0;${index === 0 ? '' : 'border-top:1px solid #ECECEC;'}font-family:${FONT};font-size:13px;line-height:20px;font-weight:600;color:#191919;word-break:break-word;">${escape(value)}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escape(subject)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .bg { background-color: #141414 !important; }
  .card { background-color: #1F1F1F !important; border-color: #363636 !important; }
  .ink { color: #F2F2F2 !important; }
  .muted { color: #A6A6A6 !important; }
  .rule { border-color: #363636 !important; }
  .button-cell { background-color: #F2F2F2 !important; }
  .button-link { color: #141414 !important; }
}
@media (max-width: 600px) { .card { padding: 28px 24px !important; } }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:#F8F8F8;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escape(said)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F8F8F8;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td class="ink" style="padding:0 4px 20px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#191919;">${escape(brandName)}</td></tr>
<tr><td class="card" style="background-color:#FFFFFF;border:1px solid #ECECEC;border-radius:12px;padding:36px 40px;">
<h1 class="ink" style="margin:0 0 12px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.02em;color:#191919;">Join ${escape(invitation.workspace)} on ${escape(brandName)}</h1>
<p class="muted" style="margin:0 0 24px;font-family:${FONT};font-size:15px;line-height:22px;color:#5E5E5E;">${escape(said)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 28px;">${factRows}</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="button-cell" bgcolor="#191919" style="border-radius:8px;background-color:#191919;"><a class="button-link" href="${escape(invitation.link)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">Accept invitation</a></td></tr></table>
<p class="muted" style="margin:28px 0 6px;font-family:${FONT};font-size:13px;line-height:20px;color:#767676;">If the button doesn’t work, copy this link into your browser:</p>
<p class="ink" style="margin:0;font-family:${MONO};font-size:12px;line-height:18px;color:#191919;word-break:break-all;">${escape(invitation.link)}</p>
</td></tr>
<tr><td class="muted" style="padding:20px 4px 0;font-family:${FONT};font-size:12px;line-height:18px;color:#767676;">${escape(ignore)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject, text: `${text}\n`, html };
}

/** Sends each invitation once through the provider; throws on any answer but success. */
export function createSlotlockInvitationEmailSender(
  config: SlotlockInvitationEmailConfig,
  options: { fetch?: typeof fetch; brandName?: string } = {},
): SlotlockInvitationSender {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async send(invitation) {
      const message = slotlockInvitationEmail(invitation, options.brandName);
      const request =
        config.provider === 'resend'
          ? {
              url: 'https://api.resend.com/emails',
              headers: {
                authorization: `Bearer ${config.key}`,
                'content-type': 'application/json',
                'user-agent': USER_AGENT,
                // One send per link, however often the person inviting submits: keyed by the link,
                // as a digest, so the key names no address.
                'idempotency-key': createHash('sha256').update(invitation.link, 'utf8').digest('hex'),
              },
              body: { from: config.from, to: [invitation.to], subject: message.subject, text: message.text, html: message.html },
            }
          : {
              url: 'https://api.postmarkapp.com/email',
              headers: {
                'x-postmark-server-token': config.key,
                'content-type': 'application/json',
                accept: 'application/json',
                'user-agent': USER_AGENT,
              },
              body: {
                From: config.from,
                To: invitation.to,
                Subject: message.subject,
                TextBody: message.text,
                HtmlBody: message.html,
                MessageStream: 'outbound',
              },
            };
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        // The status alone: a provider's error text can echo the address.
        throw new SlotlockInvitationEmailError(`${config.provider === 'resend' ? 'Resend' : 'Postmark'} answered HTTP ${response.status}`);
      }
    },
  };
}
