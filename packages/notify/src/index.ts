// @slotlock/notify (RFC 0004 C2): confirmations, changes and reminders from Slotlock's change feed,
// by email (Postmark, Resend or Amazon SES), SMS and WhatsApp (Twilio), each sent once. A process of
// its own, with its own schema and secrets; Slotlock itself sends nothing.
export {
  ChannelError,
  type NotifyChannel,
  type OutgoingMessage,
  captureChannel,
  postmarkEmail,
  resendEmail,
  sesEmail,
  signAwsRequest,
  twilioMessages,
} from './channels.js';
export {
  type NotifyChannelKind,
  type NotifyLedger,
  type RememberedRecipient,
  SLOTLOCK_NOTIFY_DDL,
  type SendKey,
  createMemoryLedger,
  createPostgresLedger,
  recipientDigest,
} from './ledger.js';
export { type HandleResult, type Notifier, type NotifierOptions, type NotifyTenant, contactRecipients, createNotifier } from './notifier.js';
export { type NotifyHttpOptions, createNotifyHttpHandler } from './http.js';
export { type SealKeys, open, parseSealKeys, seal } from './seal.js';
export { serveFetchHandler } from './node-http.js';
export {
  SLOTLOCK_CHANGE_TYPE_PREFIX,
  SlotlockApiError,
  type SlotlockChange,
  type SlotlockContact,
  createSlotlockNotifyApi,
  withShortType,
} from './slotlock-api.js';
export {
  DEFAULT_TEMPLATES,
  type NotifyMessageKind,
  type NotifyTemplate,
  type NotifyTemplateValues,
  type NotifyTemplates,
  formatWhen,
  renderTemplate,
} from './templates.js';
export { WebhookVerificationError, verifySlotlockWebhook } from './webhook.js';
