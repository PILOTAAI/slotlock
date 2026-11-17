#!/usr/bin/env node
// slotlock-notify: the notifier as a process of its own (RFC 0004 C2).
//
//   slotlock-notify migrate    apply its schema (as the schema's owner), then exit
//   slotlock-notify serve      serve webhook deliveries and poll every NOTIFY_INTERVAL_SECONDS
//
// Settings (environment): NOTIFY_DATABASE_URL, SLOTLOCK_URL, NOTIFY_SEAL_KEYS (id:base64 keys,
// newest first, for the attendees kept for cancellations), NOTIFY_TENANTS_FILE (a JSON file, kept
// as a secret: each tenant's apiKey, webhookSecret, name, from, locale, notifyAttendees, templates);
// email by POSTMARK_SERVER_TOKEN, RESEND_API_KEY, or SES_REGION with AWS_ACCESS_KEY_ID and
// AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN); SMS and WhatsApp by TWILIO_ACCOUNT_SID and
// TWILIO_AUTH_TOKEN (TWILIO_WHATSAPP_CONTENT_SID for an approved WhatsApp template);
// NOTIFY_INTERVAL_SECONDS (default 60), HOST, PORT (default 8091). A test environment's messages
// (`<tenant>~test`) are only logged as captured, never sent.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import postgres from 'postgres';
import { type NotifyChannel, captureChannel, postmarkEmail, resendEmail, sesEmail, twilioMessages } from './channels.js';
import { createNotifyHttpHandler } from './http.js';
import { type NotifyChannelKind, createPostgresLedger } from './ledger.js';
import { every, serveFetchHandler, setting } from './node-http.js';
import { type NotifyTenant, createNotifier } from './notifier.js';
import { parseSealKeys } from './seal.js';

const log = (level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }));

type TenantSettings = NotifyTenant & { webhookSecret?: string };

/** The tenants file, checked: every tenant has a key, a name and senders. */
function readTenants(path: string): Map<string, TenantSettings> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, TenantSettings>;
  const tenants = new Map<string, TenantSettings>();
  for (const [tenantRef, tenant] of Object.entries(parsed)) {
    if (typeof tenant?.apiKey !== 'string' || typeof tenant.name !== 'string' || typeof tenant.from !== 'object' || tenant.from === null) {
      throw new TypeError(`Tenant ${tenantRef} needs apiKey, name and from`);
    }
    if (tenant.webhookSecret !== undefined && !String(tenant.webhookSecret).startsWith('whsec_')) {
      throw new TypeError(`Tenant ${tenantRef}'s webhookSecret must start with whsec_`);
    }
    tenants.set(tenantRef, tenant);
  }
  return tenants;
}

function channelsFromEnvironment(): Partial<Record<NotifyChannelKind, NotifyChannel>> {
  const env = process.env;
  const channels: Partial<Record<NotifyChannelKind, NotifyChannel>> = {};
  if (env.POSTMARK_SERVER_TOKEN) channels.email = postmarkEmail({ serverToken: env.POSTMARK_SERVER_TOKEN });
  else if (env.RESEND_API_KEY) channels.email = resendEmail({ apiKey: env.RESEND_API_KEY });
  else if (env.SES_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    channels.email = sesEmail({
      region: env.SES_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      },
    });
  }
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    channels.sms = twilioMessages({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN });
    channels.whatsapp = twilioMessages({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      whatsapp: true,
      ...(env.TWILIO_WHATSAPP_CONTENT_SID ? { contentSid: env.TWILIO_WHATSAPP_CONTENT_SID } : {}),
    });
  }
  return channels;
}

/** A test environment's inbox: kept in memory and logged (never the address or text), never sent. */
function loggedCapture(kind: NotifyChannelKind): NotifyChannel {
  const inbox = captureChannel(kind);
  return {
    kind,
    async send(message) {
      const sent = await inbox.send(message);
      inbox.messages.splice(0, Math.max(0, inbox.messages.length - 100));
      log('info', 'captured for a test environment', { channel: kind, subject: message.subject });
      return sent;
    },
  };
}

async function main(command: string): Promise<void> {
  const sql = postgres(setting('NOTIFY_DATABASE_URL'), { max: 5, onnotice: () => {} });
  const ledger = createPostgresLedger(sql, { keys: parseSealKeys(setting('NOTIFY_SEAL_KEYS')) });
  if (command === 'migrate') {
    await ledger.applySchema();
    await sql.end();
    log('info', 'schema applied');
    return;
  }
  if (command !== 'serve') {
    console.error('usage: slotlock-notify migrate | serve');
    process.exit(2);
  }
  const tenants = readTenants(setting('NOTIFY_TENANTS_FILE'));
  const channels = channelsFromEnvironment();
  const notifier = createNotifier({
    ledger,
    slotlockUrl: setting('SLOTLOCK_URL'),
    // A test environment is listed as a tenant of its own, with its test key: never its live one's.
    tenant: async (tenantRef) => tenants.get(tenantRef) ?? null,
    channels,
    testChannels: { email: loggedCapture('email'), sms: loggedCapture('sms'), whatsapp: loggedCapture('whatsapp') },
  });
  const handler = createNotifyHttpHandler({
    notifier,
    webhookSecret: async (tenantRef) => tenants.get(tenantRef)?.webhookSecret ?? null,
  });
  const server = createServer(
    serveFetchHandler(handler, { maxBodyBytes: 256 * 1024, onError: (error) => log('error', 'request failed', { error: String(error) }) }),
  );
  server.listen(Number(setting('PORT', '8091')), setting('HOST', '0.0.0.0'));
  log('info', 'serving', { tenants: tenants.size, channels: Object.keys(channels) });

  const stop = new AbortController();
  let lastDaily = 0;
  const loop = every(Number(setting('NOTIFY_INTERVAL_SECONDS', '60')) * 1_000, stop.signal, async () => {
    const daily = Date.now() - lastDaily > 24 * 60 * 60 * 1_000;
    if (daily) lastDaily = Date.now();
    for (const tenantRef of tenants.keys()) {
      try {
        if (daily) await notifier.rememberUpcoming(tenantRef);
        const result = await notifier.poll(tenantRef);
        if (result.gap) log('warn', 'the feed cursor had expired: changes older than a day were not sent', { tenant: tenantRef });
        if (result.sent || result.failed) log('info', 'pass', { tenant: tenantRef, sent: result.sent, failed: result.failed });
      } catch (error) {
        log('error', 'poll failed', { tenant: tenantRef, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (daily) await ledger.prune().catch(() => 0);
  });
  const shutdown = async () => {
    stop.abort();
    server.close();
    await loop;
    await sql.end({ timeout: 5 });
    log('info', 'stopped');
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main(process.argv[2] ?? 'serve').catch((error: unknown) => {
  log('error', 'failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
