// Where messages go (RFC 0004 C2): email by Postmark, Resend or Amazon SES, and SMS and WhatsApp by
// Twilio. Each sender is the tenant's own account, configured by whoever runs the notifier; a test
// tenant's messages go to a capture inbox instead (captureChannel).
import { createHash, createHmac } from 'node:crypto';
import type { NotifyChannelKind } from './ledger.js';

export interface OutgoingMessage {
  /** The address or E.164 number it goes to. */
  to: string;
  /** The sender: an address for email, a number (or messaging service) for SMS and WhatsApp. */
  from: string;
  subject: string;
  text: string;
  html?: string;
  /** The send's key (change id, channel, recipient), for providers that take one. */
  idempotencyKey: string;
}

export interface NotifyChannel {
  kind: NotifyChannelKind;
  /** Send one message; the provider's id for it. Throws on a refusal. */
  send(message: OutgoingMessage): Promise<{ providerId: string | null }>;
}

/** A provider's refusal: its HTTP status and what it said. */
export class ChannelError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

async function post(send: typeof fetch, url: string, init: RequestInit, provider: string): Promise<Record<string, unknown>> {
  const response = await send(url, { ...init, method: 'POST', signal: AbortSignal.timeout(20_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = body.message ?? body.Message ?? (body.error as { message?: unknown } | undefined)?.message ?? '';
    throw new ChannelError(`${provider} answered HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`, response.status);
  }
  return body;
}

/** Email through Postmark's API with a server token. */
export function postmarkEmail(options: { serverToken: string; messageStream?: string; fetch?: typeof fetch }): NotifyChannel {
  return {
    kind: 'email',
    async send(message) {
      const body = await post(
        options.fetch ?? fetch,
        'https://api.postmarkapp.com/email',
        {
          headers: { 'x-postmark-server-token': options.serverToken, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            From: message.from,
            To: message.to,
            Subject: message.subject,
            TextBody: message.text,
            ...(message.html ? { HtmlBody: message.html } : {}),
            MessageStream: options.messageStream ?? 'outbound',
          }),
        },
        'Postmark',
      );
      return { providerId: typeof body.MessageID === 'string' ? body.MessageID : null };
    },
  };
}

/** Email through Resend's API, which takes the send's key as its Idempotency-Key. */
export function resendEmail(options: { apiKey: string; fetch?: typeof fetch }): NotifyChannel {
  return {
    kind: 'email',
    async send(message) {
      const body = await post(
        options.fetch ?? fetch,
        'https://api.resend.com/emails',
        {
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': message.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          }),
        },
        'Resend',
      );
      return { providerId: typeof body.id === 'string' ? body.id : null };
    },
  };
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();

/**
 * AWS Signature Version 4 for one request: the headers to send (host, x-amz-date, and the
 * session token when given, all signed, with any others passed).
 */
export function signAwsRequest(params: {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  now?: Date;
}): Record<string, string> {
  const amzDate = (params.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    host: params.url.host,
    'x-amz-date': amzDate,
    ...(params.credentials.sessionToken ? { 'x-amz-security-token': params.credentials.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const query = [...params.url.searchParams.entries()]
    .map(([name, value]) => [encodeURIComponent(name), encodeURIComponent(value)])
    .sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonical = [
    params.method,
    params.url.pathname || '/',
    query,
    ...names.map((name) => `${name}:${headers[name]}`),
    '',
    names.join(';'),
    sha256(params.body),
  ].join('\n');
  const scope = `${day}/${params.region}/${params.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${params.credentials.secretAccessKey}`, day), params.region), params.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

/** Email through Amazon SES (API v2), signed with SigV4. */
export function sesEmail(options: {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  configurationSet?: string;
  fetch?: typeof fetch;
}): NotifyChannel {
  return {
    kind: 'email',
    async send(message) {
      const url = new URL(`https://email.${options.region}.amazonaws.com/v2/email/outbound-emails`);
      const body = JSON.stringify({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
        ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
      });
      const headers = signAwsRequest({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body,
        region: options.region,
        service: 'ses',
        credentials: options.credentials,
      });
      const answer = await post(options.fetch ?? fetch, url.toString(), { headers, body }, 'Amazon SES');
      return { providerId: typeof answer.MessageId === 'string' ? answer.MessageId : null };
    },
  };
}

/**
 * SMS, or WhatsApp with `whatsapp: true`, through Twilio's Messages API. For WhatsApp outside a
 * 24-hour session, Meta requires an approved template: pass its Content SID as `contentSid`, and the
 * message's text goes as its variable `1`.
 */
export function twilioMessages(options: {
  accountSid: string;
  authToken: string;
  whatsapp?: boolean;
  contentSid?: string;
  fetch?: typeof fetch;
}): NotifyChannel {
  const prefix = options.whatsapp ? 'whatsapp:' : '';
  return {
    kind: options.whatsapp ? 'whatsapp' : 'sms',
    async send(message) {
      const form = new URLSearchParams({
        To: `${prefix}${message.to}`,
        // A messaging service SID (MG...) sends from its pool; otherwise a number.
        ...(message.from.startsWith('MG') ? { MessagingServiceSid: message.from } : { From: `${prefix}${message.from}` }),
        ...(options.contentSid
          ? { ContentSid: options.contentSid, ContentVariables: JSON.stringify({ 1: message.text }) }
          : { Body: message.text }),
      });
      const body = await post(
        options.fetch ?? fetch,
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`,
        {
          headers: {
            authorization: `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        },
        'Twilio',
      );
      return { providerId: typeof body.sid === 'string' ? body.sid : null };
    },
  };
}

/** Messages kept, not sent: a test tenant's inbox, and tests'. */
export function captureChannel(kind: NotifyChannelKind): NotifyChannel & { messages: OutgoingMessage[] } {
  const messages: OutgoingMessage[] = [];
  return {
    kind,
    messages,
    async send(message) {
      messages.push(message);
      return { providerId: `captured-${messages.length}` };
    },
  };
}
