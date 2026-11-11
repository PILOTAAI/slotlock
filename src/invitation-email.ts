// Team invitations by email (dashboard.ts SlotlockInvitationSender): a plain transactional message
// with the link, sent through Resend or Postmark with the deployment's own key. Nothing else is
// sent, and no address is kept by this module.
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

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The message an invitation sends: subject, text and HTML saying the same, with no marketing. */
export function slotlockInvitationEmail(
  invitation: Invitation,
  brandName = 'Slotlock',
): { subject: string; text: string; html: string } {
  const until = `${invitation.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const subject = `${invitation.inviter} invited you to ${invitation.workspace} on ${brandName}`;
  const lines = [
    `${invitation.inviter} invited you to join ${invitation.workspace} on ${brandName} as ${invitation.role}.`,
    `Join: ${invitation.link}`,
    `The link works once, for this address, until ${until}. If you did not expect it, ignore this email: nothing happens unless you use the link.`,
  ];
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111"><p>${escape(lines[0] as string)}</p><p><a href="${escape(invitation.link)}">Join ${escape(invitation.workspace)}</a></p><p style="color:#555;font-size:14px">${escape(lines[2] as string)}</p></body></html>`;
  return { subject, text: `${lines.join('\n\n')}\n`, html };
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
        throw new Error(`${config.provider === 'resend' ? 'Resend' : 'Postmark'} answered HTTP ${response.status}`);
      }
    },
  };
}
