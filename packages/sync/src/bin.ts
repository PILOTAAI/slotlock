#!/usr/bin/env node
// slotlock-sync: the sync as a process of its own (RFC 0004 C1, C4).
//
//   slotlock-sync migrate    apply its schema (as the schema's owner), then exit
//   slotlock-sync serve      serve its HTTP surface and sync every SYNC_INTERVAL_SECONDS
//
// Settings (environment): SYNC_DATABASE_URL, SLOTLOCK_URL, SLOTLOCK_SYNC_KEYS (id:base64 seal keys,
// newest first), SYNC_ADMIN_TOKEN, SYNC_LINK_SECRET, SYNC_PUBLIC_URL; GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_DIRECTORY for
// the providers offered; SYNC_INTERVAL_SECONDS (default 300), SYNC_WINDOW_DAYS (default 60), HOST,
// PORT (default 8090). iCalendar URLs need the slotlock package installed beside it.
import { createServer } from 'node:http';
import postgres from 'postgres';
import { createSyncHttpHandler } from './http.js';
import { every, serveFetchHandler, setting } from './node-http.js';
import type { OAuthClient } from './oauth.js';
import type { ICalendarFeedParser } from './providers.js';
import { parseSealKeys } from './seal.js';
import { withoutTrailingSlashes } from './slotlock-api.js';
import { createPostgresSyncStore } from './store.js';
import { createSyncer } from './syncer.js';

const log = (level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }));

async function main(command: string): Promise<void> {
  const sql = postgres(setting('SYNC_DATABASE_URL'), { max: 5, onnotice: () => {} });
  const store = createPostgresSyncStore(sql);
  if (command === 'migrate') {
    await store.applySchema();
    await sql.end();
    log('info', 'schema applied');
    return;
  }
  if (command !== 'serve') {
    console.error('usage: slotlock-sync migrate | serve');
    process.exit(2);
  }
  const publicUrl = withoutTrailingSlashes(setting('SYNC_PUBLIC_URL'));
  const redirectUri = `${publicUrl}/oauth/callback`;
  const clients: { google?: OAuthClient; microsoft?: OAuthClient } = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    clients.google = { provider: 'google', clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectUri };
  }
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    clients.microsoft = {
      provider: 'microsoft',
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      redirectUri,
      directory: process.env.MICROSOFT_DIRECTORY || 'organizations',
    };
  }
  // iCalendar URLs are read with slotlock's own parser, through its guarded fetch (no private
  // addresses), when the slotlock package is installed beside this one.
  let parseICalendar: ICalendarFeedParser | undefined;
  let icsFetch: typeof fetch | undefined;
  try {
    const slotlock = (await import('slotlock' as string)) as {
      parseICalendarFeed: ICalendarFeedParser;
      createSlotlockGuardedFetch: () => typeof fetch;
    };
    parseICalendar = slotlock.parseICalendarFeed;
    icsFetch = slotlock.createSlotlockGuardedFetch();
  } catch {
    log('warn', 'iCalendar URLs are off: the slotlock package is not installed');
  }
  const syncer = createSyncer({
    store,
    keys: parseSealKeys(setting('SLOTLOCK_SYNC_KEYS')),
    slotlockUrl: setting('SLOTLOCK_URL'),
    clients,
    ...(parseICalendar ? { parseICalendar } : {}),
    ...(icsFetch ? { icsFetch } : {}),
    windowDays: Number(setting('SYNC_WINDOW_DAYS', '60')),
  });
  const handler = createSyncHttpHandler({
    syncer,
    store,
    adminToken: setting('SYNC_ADMIN_TOKEN'),
    linkSecret: setting('SYNC_LINK_SECRET'),
    publicUrl,
  });
  const server = createServer(
    serveFetchHandler(handler, { maxBodyBytes: 64 * 1024, onError: (error) => log('error', 'request failed', { error: String(error) }) }),
  );
  server.listen(Number(setting('PORT', '8090')), setting('HOST', '0.0.0.0'));
  log('info', 'serving', { providers: Object.keys(clients), ics: parseICalendar !== undefined });

  const stop = new AbortController();
  const intervalMs = Number(setting('SYNC_INTERVAL_SECONDS', '300')) * 1_000;
  let lastReconcile = 0;
  const loop = every(intervalMs, stop.signal, async () => {
    const synced = await syncer.syncAll();
    const written = await syncer.writeBackChanges();
    // Daily, every tenant's calendars are reconciled with its bookings, whatever the feed said.
    if (Date.now() - lastReconcile > 24 * 60 * 60 * 1_000) {
      lastReconcile = Date.now();
      for (const tenant of await store.listTenants()) await syncer.reconcileTenant(tenant.tenantRef).catch(() => {});
    }
    log('info', 'pass', {
      synced: synced.filter((result) => result.ok).length,
      unsynced: synced.filter((result) => !result.ok && result.error !== 'waiting').length,
      written: written.written,
      failedTenants: written.failed.length,
    });
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
