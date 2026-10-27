// Webhook signing, retry schedule, address checks and the delivery pass, without a database. The
// signature is checked with Standard Webhooks' reference library, not only against itself.
import { Webhook } from 'standardwebhooks';
import { describe, expect, it, vi } from 'vitest';
import type { SlotlockChange } from '../event-feed.js';
import {
  deliverSlotlockWebhooks,
  isPrivateAddress,
  signSlotlockWebhook,
  slotlockCloudEvent,
  slotlockWebhookRetryDelayMs,
} from '../webhooks.js';

const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

function change(n: number): SlotlockChange {
  return {
    id: `msg_${n}`,
    type: 'reservation.created',
    resourceId: '0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b',
    subject: `BK-${n}`,
    data: { reference: `BK-${n}` },
    occurredAt: new Date('2027-03-01T09:00:00Z'),
    position: `p${n}`,
  };
}

describe('webhook signatures', () => {
  it('are what the Standard Webhooks reference library verifies', () => {
    const body = JSON.stringify(slotlockCloudEvent(change(1)));
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = signSlotlockWebhook({ secret: SECRET, id: 'msg_1', timestamp, body });
    expect(signature).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/);
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(timestamp), 'webhook-signature': signature };
    expect(new Webhook(SECRET).verify(body, headers)).toMatchObject({ type: 'io.pylota.slotlock.reservation.created' });
    // Any change to the body, the id or the timestamp breaks it.
    expect(() => new Webhook(SECRET).verify(`${body} `, headers)).toThrow();
    expect(() => new Webhook(SECRET).verify(body, { ...headers, 'webhook-id': 'msg_2' })).toThrow();
  });
});

describe('the retry schedule', () => {
  it('grows from 5 seconds to 10 hours, jittered by a tenth, and honours Retry-After', () => {
    const middle = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 12].map((attempt) => slotlockWebhookRetryDelayMs(attempt, undefined, middle))).toEqual([
      5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000, 36_000_000,
    ]);
    expect(slotlockWebhookRetryDelayMs(1, undefined, () => 0)).toBe(4_500);
    expect(slotlockWebhookRetryDelayMs(1, undefined, () => 1)).toBe(5_500);
    expect(slotlockWebhookRetryDelayMs(1, 120_000, middle)).toBe(120_000);
    expect(slotlockWebhookRetryDelayMs(1, 10 * 86_400_000, middle)).toBe(86_400_000);
  });
});

describe('private addresses', () => {
  it('are loopback, private, link-local, shared, multicast and mapped ones, in either family', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '224.0.0.1', 'not-an-ip',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.215.14', '1.1.1.1', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('a delivery pass', () => {
  it('sends in order until one fails, records how far it got, and marks 410 as gone', async () => {
    const settle = vi.fn(async () => {});
    const feed = {
      claimWebhookDeliveries: vi.fn(async () => [
        { endpoint: { id: 'e1', url: 'https://a.example/h', secret: SECRET }, leaseToken: 't1', changes: [change(1), change(2), change(3)] },
        { endpoint: { id: 'e2', url: 'https://b.example/h', secret: SECRET }, leaseToken: 't2', changes: [change(4)] },
      ]),
      settleWebhookDelivery: settle,
    };
    const sent: string[] = [];
    const result = await deliverSlotlockWebhooks({
      feed,
      tenantRef: 'tenant-a',
      now: () => 1_800_000_000_000,
      send: async (request) => {
        sent.push(`${request.url} ${request.headers['webhook-id']}`);
        expect(request.headers['webhook-timestamp']).toBe('1800000000');
        if (request.url.startsWith('https://b')) return { status: 410 };
        return { status: request.headers['webhook-id'] === 'msg_2' ? 500 : 204 };
      },
    });
    expect(result).toEqual({ delivered: 1, failed: 2 });
    expect(sent.filter((line) => line.startsWith('https://a'))).toEqual(['https://a.example/h msg_1', 'https://a.example/h msg_2']);
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: 'e1', leaseToken: 't1', delivered: 'p1', failure: expect.objectContaining({ status: 500 }) }),
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: 'e2', failure: expect.objectContaining({ status: 410, gone: true }) }),
    );
  });
});
