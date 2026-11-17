// Changes delivered by Slotlock's webhooks (Standard Webhooks): verify the signature before reading
// a byte of the body as a change, and refuse one too old or too new to be a delivery.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type SlotlockChange, withShortType } from './slotlock-api.js';

/** Why a delivery was refused: it is not from Slotlock, or not now. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * The change a webhook delivery carries, once its `webhook-signature` proves `secret` signed its
 * id, timestamp and body, and its timestamp is within `toleranceSeconds` (default 300) of now.
 * Pass the body exactly as received.
 */
export function verifySlotlockWebhook(params: {
  secret: string;
  headers: Headers | Record<string, string | undefined>;
  body: string;
  toleranceSeconds?: number;
  now?: Date;
}): SlotlockChange {
  const header = (name: string) =>
    params.headers instanceof Headers ? params.headers.get(name) : (params.headers[name] ?? params.headers[name.toLowerCase()]);
  const id = header('webhook-id');
  const timestamp = header('webhook-timestamp');
  const signatures = header('webhook-signature');
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError('The delivery has no webhook signature headers');
  if (!params.secret.startsWith('whsec_')) throw new TypeError('A Slotlock webhook secret starts with whsec_');
  const seconds = Number(timestamp);
  const now = (params.now ?? new Date()).getTime() / 1_000;
  if (!Number.isInteger(seconds) || Math.abs(now - seconds) > (params.toleranceSeconds ?? 300)) {
    throw new WebhookVerificationError('The delivery is too old or too new');
  }
  const expected = createHmac('sha256', Buffer.from(params.secret.slice('whsec_'.length), 'base64'))
    .update(`${id}.${timestamp}.${params.body}`)
    .digest();
  const matches = signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw new WebhookVerificationError('The delivery is not signed with this secret');
  return withShortType(JSON.parse(params.body) as SlotlockChange);
}
