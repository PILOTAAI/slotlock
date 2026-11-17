// @slotlock/sync (RFC 0004 C1, C4): busy time from Google Calendar, Microsoft 365 and iCalendar
// URLs into Slotlock, and confirmed bookings written back. A process of its own (`slotlock-sync`),
// with its own schema and secrets, talking to Slotlock over its API with each tenant's key.
export { type SealKeys, open, parseSealKeys, seal } from './seal.js';
export {
  type OAuthClient,
  type OAuthProvider,
  type OAuthTokens,
  OAuthError,
  beginAuthorization,
  exchangeCode,
  oauthScopes,
  refreshTokens,
} from './oauth.js';
export {
  type CalendarWriter,
  type ICalendarFeedParser,
  PROVIDER_WINDOW_MS,
  type ProviderCalendar,
  ProviderError,
  type WrittenEventState,
  googleWriter,
  listGoogleCalendars,
  listMicrosoftCalendars,
  microsoftWriter,
  readGoogleBusy,
  readIcsBusy,
  readMicrosoftBusy,
  readMicrosoftCalendarBusy,
  retryAfterMs,
  revokeGoogleToken,
  windowParts,
} from './providers.js';
export {
  type Interval,
  SLOTLOCK_CHANGE_TYPE_PREFIX,
  type SlotlockBooking,
  type SlotlockChange,
  type SlotlockResourceSummary,
  type SlotlockSyncApi,
  SlotlockApiError,
  createSlotlockSyncApi,
  withShortType,
} from './slotlock-api.js';
export {
  SLOTLOCK_SYNC_DDL,
  type SyncConnection,
  type SyncMapping,
  type SyncOAuthState,
  type SyncProviderKind,
  type SyncStore,
  type SyncTenant,
  type SyncWriteBack,
  createMemorySyncStore,
  createPostgresSyncStore,
} from './store.js';
export { type MappingSyncResult, type Syncer, type SyncerOptions, backoffMs, createSyncer, stateHash, withoutOwn } from './syncer.js';
export { type SyncHttpOptions, createSyncHttpHandler } from './http.js';
export { serveFetchHandler } from './node-http.js';
