#!/usr/bin/env node
// slotlock-payments-stripe: the Stripe adapter as a process of its own (RFC 0004 C3). It serves
// /stripe/webhook/<tenant> for each tenant's own Stripe account.
//
// Settings (environment): SLOTLOCK_URL, PAYMENTS_TENANTS_FILE (a JSON file, kept as a secret: each
// tenant's stripeSecretKey, a restricted key that reads PaymentIntents and writes refunds; its
// webhookSecret; its slotlockApiKey; and refundRefused), HOST, PORT (default 8092).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { type StripeTenant, createPaymentsHttpHandler } from './http.js';
import { serveFetchHandler, setting } from './node-http.js';

const log = (level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }));

function readTenants(path: string): Map<string, StripeTenant> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, StripeTenant>;
  const tenants = new Map<string, StripeTenant>();
  for (const [tenantRef, tenant] of Object.entries(parsed)) {
    if (
      typeof tenant?.stripeSecretKey !== 'string' ||
      !/^(sk|rk)_(live|test)_/.test(tenant.stripeSecretKey) ||
      typeof tenant.webhookSecret !== 'string' ||
      !tenant.webhookSecret.startsWith('whsec_') ||
      typeof tenant.slotlockApiKey !== 'string'
    ) {
      throw new TypeError(`Tenant ${tenantRef} needs stripeSecretKey (sk_ or rk_), webhookSecret (whsec_) and slotlockApiKey`);
    }
    tenants.set(tenantRef, tenant);
  }
  return tenants;
}

const tenants = readTenants(setting('PAYMENTS_TENANTS_FILE'));
const handler = createPaymentsHttpHandler({ slotlockUrl: setting('SLOTLOCK_URL'), tenant: async (ref) => tenants.get(ref) ?? null });
const server = createServer(
  serveFetchHandler(handler, { maxBodyBytes: 256 * 1024, onError: (error) => log('error', 'request failed', { error: String(error) }) }),
);
server.listen(Number(setting('PORT', '8092')), setting('HOST', '0.0.0.0'));
log('info', 'serving', { tenants: tenants.size });
const shutdown = () => server.close(() => log('info', 'stopped'));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
