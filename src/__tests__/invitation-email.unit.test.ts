// Team invitations by email (invitation-email.ts): the message says only what the invitation is,
// in text and HTML alike, and goes to Resend or Postmark as their APIs take it (docs read
// 2026-11-11: resend.com/docs/api-reference/emails/send-email, postmarkapp.com/developer/api/email-api).
import { describe, expect, it, vi } from 'vitest';
import { readDashboardConfig } from '../config.js';
import { createSlotlockInvitationEmailSender, SlotlockInvitationEmailError, slotlockInvitationEmail } from '../invitation-email.js';

const invitation = {
  to: 'desk@clinic.example',
  workspace: 'Acme <Rentals>',
  inviter: '@ada',
  role: 'Member',
  link: 'https://slotlock.example.com/dashboard/invite?t=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde',
  expiresAt: new Date('2026-11-18T10:30:00Z'),
};

describe('invitation email', () => {
  it('says who invited whom to what, until when, in text and HTML alike, and nothing else', () => {
    const message = slotlockInvitationEmail(invitation, 'Slotlock');
    expect(message.subject).toBe('@ada invited you to Acme <Rentals> on Slotlock');
    expect(message.text).toBe(
      '@ada invited you to join Acme <Rentals> on Slotlock as Member.\n\n' +
        `Join: ${invitation.link}\n\n` +
        'The link works once, for this address, until 2026-11-18 10:30 UTC. If you did not expect it, ignore this email: nothing happens unless you use the link.\n',
    );
    // The HTML escapes what people typed, and links nowhere but the invitation.
    expect(message.html).toContain('Acme &#60;Rentals&#62;');
    expect(message.html).not.toContain('<Rentals>');
    expect([...message.html.matchAll(/href="([^"]+)"/g)].map(([, href]) => href)).toEqual([invitation.link]);
    expect(message.html).toContain('until 2026-11-18 10:30 UTC');
  });

  it('sends through Resend with a key that names no address', async () => {
    const fetch = vi.fn(async () => Response.json({ id: 'email-1' }));
    await createSlotlockInvitationEmailSender({ provider: 'resend', key: 're_test_key_123', from: 'Slotlock <team@slotlock.example>' }, { fetch }).send(invitation);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test_key_123');
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['idempotency-key']).not.toContain('desk');
    // Resend refuses a request with no User-Agent (403), and a Worker's fetch adds none.
    expect(headers['user-agent']).toMatch(/^Slotlock /);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: 'Slotlock <team@slotlock.example>', to: ['desk@clinic.example'], subject: '@ada invited you to Acme <Rentals> on Slotlock' });
    expect(body.text).toContain(invitation.link);
    expect(body.html).toContain('Join Acme &#60;Rentals&#62;');
  });

  it("sends through Postmark's transactional stream, and refuses without echoing the provider's answer", async () => {
    const fetch = vi.fn(async () => Response.json({ ErrorCode: 0, MessageID: 'm-1' }));
    const sender = createSlotlockInvitationEmailSender({ provider: 'postmark', key: '00000000-aaaa-bbbb-cccc-000000000000', from: 'team@slotlock.example' }, { fetch });
    await sender.send(invitation);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect((init.headers as Record<string, string>)['x-postmark-server-token']).toBe('00000000-aaaa-bbbb-cccc-000000000000');
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/^Slotlock /);
    expect(JSON.parse(String(init.body))).toMatchObject({ From: 'team@slotlock.example', To: 'desk@clinic.example', MessageStream: 'outbound' });
    fetch.mockResolvedValueOnce(Response.json({ ErrorCode: 406, Message: 'desk@clinic.example is inactive' }, { status: 422 }));
    const refused = await sender.send(invitation).catch((error: Error) => error);
    // Its name tells the dashboard's log it may print the message: the status, never the address.
    expect(refused).toBeInstanceOf(SlotlockInvitationEmailError);
    expect((refused as Error).name).toBe('SlotlockInvitationEmailError');
    expect((refused as Error).message).toBe('Postmark answered HTTP 422');
  });

  it('is configured with all three settings, and only with team workspaces', () => {
    const base = {
      SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liAbCdEfGhIjKlMn',
      SLOTLOCK_GITHUB_CLIENT_SECRET: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      SLOTLOCK_SESSION_SECRET: 'Zq8vN2kLp4Rt6Wx9Yb3Cd5Fg7Hj1Mn0Ps2Uv4Xy6Az8Bc',
      SLOTLOCK_DASHBOARD_USERS: '*',
      SLOTLOCK_DASHBOARD_TEAM_WORKSPACES: 'on',
    };
    const email = { SLOTLOCK_INVITATION_EMAIL: 'resend', SLOTLOCK_INVITATION_EMAIL_KEY: 're_live_abcdefghijkl', SLOTLOCK_INVITATION_EMAIL_FROM: 'Acme <team@acme.example>' };
    expect(readDashboardConfig({ ...base, ...email })?.invitationEmail).toEqual({ provider: 'resend', key: 're_live_abcdefghijkl', from: 'Acme <team@acme.example>' });
    expect(readDashboardConfig(base)?.invitationEmail).toBeUndefined();
    expect(() => readDashboardConfig({ ...base, ...email, SLOTLOCK_DASHBOARD_TEAM_WORKSPACES: 'off' })).toThrow('needs SLOTLOCK_DASHBOARD_TEAM_WORKSPACES=on');
    expect(() => readDashboardConfig({ ...base, ...email, SLOTLOCK_INVITATION_EMAIL: 'smtp' })).toThrow('resend or postmark');
    expect(() => readDashboardConfig({ ...base, ...email, SLOTLOCK_INVITATION_EMAIL_FROM: 'not an address' })).toThrow('SLOTLOCK_INVITATION_EMAIL_FROM');
    expect(() => readDashboardConfig({ ...base, ...email, SLOTLOCK_INVITATION_EMAIL_KEY: '' })).toThrow('SLOTLOCK_INVITATION_EMAIL_KEY');
  });
});
