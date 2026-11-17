// @slotlock/notify without a network: webhook signatures, AWS signing, templates, consent, each
// provider's request, and the ledger's send-once rule.
import { describe, expect, it } from 'vitest';
import { signSlotlockWebhook } from '../../../src/webhooks.js';
import {
  captureChannel,
  contactRecipients,
  createMemoryLedger,
  postmarkEmail,
  renderTemplate,
  resendEmail,
  signAwsRequest,
  twilioMessages,
  verifySlotlockWebhook,
} from './index.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const recording = (answer: Response) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return answer.clone();
  }) as typeof fetch;
  return { send, calls };
};

describe('webhooks', () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
  const body = JSON.stringify({ id: 'msg_1', type: 'io.pylota.slotlock.reservation.created', subject: 'BK-1', time: '2027-01-01T00:00:00Z', data: {} });
  const timestamp = Math.floor(Date.now() / 1_000);
  const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(timestamp), 'webhook-signature': signSlotlockWebhook({ secret, id: 'msg_1', timestamp, body }) };

  it('takes a delivery Slotlock signed, its type without the prefix', () => {
    expect(verifySlotlockWebhook({ secret, headers, body })).toMatchObject({ id: 'msg_1', type: 'reservation.created' });
    expect(verifySlotlockWebhook({ secret, headers: new Headers(headers), body }).type).toBe('reservation.created');
  });

  it('refuses another secret, a changed body, and an old delivery', () => {
    expect(() => verifySlotlockWebhook({ secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`, headers, body })).toThrow('not signed');
    expect(() => verifySlotlockWebhook({ secret, headers, body: body.replace('BK-1', 'BK-2') })).toThrow('not signed');
    expect(() => verifySlotlockWebhook({ secret, headers, body, now: new Date((timestamp + 600) * 1_000) })).toThrow('too old');
    expect(() => verifySlotlockWebhook({ secret, headers: {}, body })).toThrow('no webhook');
  });
});

describe('AWS Signature Version 4', () => {
  it("matches AWS's get-vanilla test vector", () => {
    const headers = signAwsRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      body: '',
      region: 'us-east-1',
      service: 'service',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('templates and consent', () => {
  const values = { name: '<b>Ada</b>', what: 'Van 42', when: 'Friday', previously: '', reference: 'BK-1', sender: 'Fleet & Co' };

  it('escapes values in HTML only, and keeps a subject on one line', () => {
    const rendered = renderTemplate({ subject: 'Hi\n{{name}}', text: '{{name}} {{unknown}}', html: '<p>{{name}} {{sender}}</p>' }, values);
    expect(rendered).toEqual({ subject: 'Hi <b>Ada</b>', text: '<b>Ada</b> ', html: '<p>&lt;b&gt;Ada&lt;/b&gt; Fleet &amp; Co</p>' });
  });

  it('emails unless the person said no, and texts only if they said yes', () => {
    const contact = { contact_ref: 'c', name: null, email: 'a@example.com', phone: '+447700900123', whatsapp: '+447700900124', locale: null };
    expect(contactRecipients({ ...contact, consent: {} }).map((each) => each.channel)).toEqual(['email']);
    expect(contactRecipients({ ...contact, consent: { email: false, sms: true, whatsapp: true } }).map((each) => each.channel)).toEqual(['sms', 'whatsapp']);
  });
});

describe('channels', () => {
  const message = { to: 'ada@example.com', from: 'bookings@fleet.example', subject: 'S', text: 'T', html: '<p>T</p>', idempotencyKey: 'msg_1:email:ada@example.com' };

  it("sends Postmark's and Resend's requests, Resend with the send's key", async () => {
    const postmark = recording(json({ MessageID: 'pm-1' }));
    expect(await postmarkEmail({ serverToken: 'pm', fetch: postmark.send }).send(message)).toEqual({ providerId: 'pm-1' });
    expect(postmark.calls[0]?.init.headers).toMatchObject({ 'x-postmark-server-token': 'pm' });
    expect(JSON.parse(String(postmark.calls[0]?.init.body))).toMatchObject({ From: message.from, To: message.to, HtmlBody: '<p>T</p>' });
    const resend = recording(json({ id: 're-1' }));
    expect(await resendEmail({ apiKey: 're', fetch: resend.send }).send(message)).toEqual({ providerId: 're-1' });
    expect(resend.calls[0]?.init.headers).toMatchObject({ 'idempotency-key': message.idempotencyKey });
    const refused = recording(json({ message: 'Sender not verified' }, 422));
    await expect(postmarkEmail({ serverToken: 'pm', fetch: refused.send }).send(message)).rejects.toThrow('422: Sender not verified');
  });

  it("sends Twilio's SMS and WhatsApp forms", async () => {
    const twilio = recording(json({ sid: 'SM1' }));
    await twilioMessages({ accountSid: 'AC1', authToken: 'tok', whatsapp: true, fetch: twilio.send }).send({ ...message, to: '+447700900123', from: '+447700900999' });
    const form = new URLSearchParams(String(twilio.calls[0]?.init.body));
    expect(Object.fromEntries(form)).toEqual({ To: 'whatsapp:+447700900123', From: 'whatsapp:+447700900999', Body: 'T' });
    expect(twilio.calls[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    await twilioMessages({ accountSid: 'AC1', authToken: 'tok', fetch: twilio.send }).send({ ...message, to: '+447700900123', from: 'MG123' });
    expect(new URLSearchParams(String(twilio.calls[1]?.init.body)).get('MessagingServiceSid')).toBe('MG123');
  });

  it('keeps what a capture channel is given', async () => {
    const inbox = captureChannel('email');
    await inbox.send(message);
    expect(inbox.messages).toEqual([message]);
  });
});

describe('the ledger', () => {
  it('lets each send be claimed once, and a failed one again until its tries run out', async () => {
    const ledger = createMemoryLedger();
    const key = { tenantRef: 't', changeId: 'msg_1', channel: 'email' as const, recipient: 'Ada@Example.com' };
    expect(await ledger.claim(key)).toBe(true);
    expect(await ledger.claim({ ...key, recipient: 'ada@example.com' })).toBe(false);
    await ledger.settle(key, { ok: false, error: 'HTTP 500' });
    expect(await ledger.claim(key, 2)).toBe(true);
    await ledger.settle(key, { ok: false, error: 'HTTP 500' });
    expect(await ledger.claim(key, 2)).toBe(false);
    expect(JSON.stringify([...ledger.sends.keys()])).not.toContain('example.com');
  });
});
