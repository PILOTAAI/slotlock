// Slotlock — resource-first, deterministic calendar and availability primitives for agents.
// The public types use Node's globals (Request, Response, AbortSignal) and `node:` modules. The
// directive is kept in the emitted index.d.ts so a consumer compiling with `"types": []` (the
// TypeScript 6 default) still loads @types/node.
/// <reference types="node" preserve="true" />
export { findNextAvailable, mergeIntervals, subtractBusy } from './engine.js';
export {
  type SlotlockBookingRule,
  type SlotlockBookingRules,
  type SlotlockBookingSearch,
  bookingRuleBroken,
  bookingSearch,
  bookingSearchBlocked,
  bookingSearchReach,
  nextStepStart,
  parseBookingRuleDefaults,
  parseBookingRules,
} from './booking-rules.js';
export {
  SLOTLOCK_GROUPING_REF,
  SLOTLOCK_MAX_GROUPS_PER_RESOURCE,
  SLOTLOCK_MAX_LOCATION_DEPTH,
  SLOTLOCK_MAX_LOCATIONS,
  SLOTLOCK_MAX_RESOURCE_GROUPS,
  SLOTLOCK_RESOURCE_KINDS,
  SLOTLOCK_RESOURCE_LABEL,
  SLOTLOCK_RESOURCE_PROFILE_FIELDS,
  SLOTLOCK_RESOURCE_PROFILE_LIMITS,
  parseSlotlockLocation,
  parseSlotlockResourceGroup,
  parseSlotlockResourceProfile,
  type SlotlockLocation,
  type SlotlockResourceGroup,
  type SlotlockResourceAttributes,
  type SlotlockResourceKind,
  type SlotlockResourceProfileChange,
  type SlotlockResourceProfileInput,
} from './resource-profile.js';
export {
  type CreateWebhookEndpointResult,
  type ListChangesResult,
  SLOTLOCK_CHANGE_ORIGINS,
  SLOTLOCK_CHANGE_RETENTION_DAYS,
  SLOTLOCK_CHANGE_TYPES,
  SLOTLOCK_MAX_WEBHOOK_ENDPOINTS,
  SLOTLOCK_WEBHOOK_FAILING_LIMIT_MS,
  slotlockChangeFeedHead,
  type SlotlockChange,
  type SlotlockChangeOrigin,
  type SlotlockChangeType,
  type SlotlockEventFeed,
  type SlotlockWebhookClaim,
  type SlotlockWebhookEndpoint,
  slotlockCoverageSourceId,
} from './event-feed.js';
export {
  type SlotlockCloudEvent,
  type SlotlockWebhookPassResult,
  type SlotlockWebhookResponse,
  type SlotlockWebhookScheduler,
  type SlotlockWebhookSender,
  createSlotlockGuardedFetch,
  createSlotlockWebhookSender,
  deliverSlotlockWebhooks,
  isPrivateAddress,
  signSlotlockWebhook,
  slotlockCloudEvent,
  slotlockWebhookRetryDelayMs,
  startSlotlockWebhookDelivery,
} from './webhooks.js';
export { type SlotlockMetrics, createSlotlockMetrics } from './metrics.js';
export { expandRules } from './rules.js';
export {
  availabilityRuleProblem,
  parseAvailabilityRules,
  rulesToWeeklyHours,
  SLOTLOCK_MAX_AVAILABILITY_RULES,
  weeklyHoursToRules,
} from './weekly-hours.js';
export type { HoursWindow, Weekday, WeeklyHours } from './weekly-hours.js';
export {
  emitVAvailability,
  parseVAvailability,
  recurrenceRuleFromRRule,
  SLOTLOCK_MAX_VAVAILABILITY_CHARACTERS,
  SLOTLOCK_MAX_VAVAILABILITY_DAYS,
  toJSCalendarEvent,
} from './interop.js';
// Stored hours that inherit, and closures and special days (RFC 0004 B1, B2).
export {
  applicableHours,
  coveredByOpenWindows,
  exceptionDays,
  exceptionRanges,
  openWindows,
  parseExceptionDays,
  SLOTLOCK_MAX_AVAILABILITY_EXCEPTIONS,
  SLOTLOCK_MAX_EXCEPTION_DAYS,
  SLOTLOCK_MAX_EXCEPTION_WINDOWS,
} from './hours.js';
export type {
  SlotlockAvailabilityException,
  SlotlockExceptionDay,
  SlotlockExceptionOutcome,
  SlotlockExceptionSource,
  SlotlockExceptionWindow,
  SlotlockHoursSource,
  SlotlockRankedException,
} from './hours.js';
export type {
  SlotlockAvailabilityDefaults,
  SlotlockAvailabilityDefaultsResult,
  SlotlockAvailabilityExceptionInput,
  SlotlockOverrideResources,
  SlotlockHolidayCalendar,
  SlotlockHolidayImport,
} from './availability-store.js';
export {
  SLOTLOCK_OVERRIDE_RESOURCES,
  SLOTLOCK_HOLIDAY_REIMPORT_DAYS,
  SLOTLOCK_MAX_HOLIDAY_CALENDARS,
} from './availability-store.js';
export {
  type SlotlockHolidayCalendarRead,
  type SlotlockHolidaySource,
  readSlotlockHolidayCalendar,
} from './holiday-import.js';
export {
  fetchHolidayCalendar,
  parseHolidayCalendar,
  SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES,
  SLOTLOCK_MAX_HOLIDAY_DAYS,
} from './holidays.js';
export type { ParsedHolidayCalendar, SlotlockHoliday } from './holidays.js';
// The booking lifecycle, written down (RFC 0004 B4).
export {
  SLOTLOCK_BOOKING_ACTIONS,
  SLOTLOCK_BOOKING_ENDS,
  SLOTLOCK_BOOKING_STATUSES,
  SLOTLOCK_BOOKING_TRANSITIONS,
  slotlockBookingNext,
  slotlockBookingRefusal,
} from './lifecycle.js';
export type { SlotlockBookingAction, SlotlockBookingStatus, SlotlockEndReason } from './lifecycle.js';
export { findEarliestRange, sameTimeDaysLater } from './ranges.js';
export type { SlotlockRangeSearch } from './ranges.js';
export type {
  EmitVAvailabilityOptions,
  JSCalendarAlert,
  JSCalendarEvent,
  JSCalendarParticipant,
  JSCalendarRecurrenceRule,
  ParsedVAvailability,
} from './interop.js';
export {
  createTimeZoneConverter,
  zonedCalendarDate,
  zonedDateTimeToUtc,
  zonedWallTime,
} from './timezone.js';
export type {
  LocalDateTime,
  TimeZoneConverter,
  ZonedCalendarDate,
  ZonedWallTime,
} from './timezone.js';
export {
  createSlotlockAgentServer,
  clientSupportsSlotlockMcpApp,
  invokeSlotlockAgentOperation,
  isSlotlockAgentOperation,
  slotlockAgentTools,
  slotlockApplicationOperations,
  slotlockOpenApi,
  slotlockCalendarResourceUri,
  slotlockMcpToolResult,
  parseSlotlockA2ATimestamp,
  resolveSlotlockAgentOperation,
  slotlockAgentOperationScope,
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  SLOTLOCK_A2A_TASK_PAGE_SIZE,
  SLOTLOCK_A2A_WATCH_SKILL,
  SLOTLOCK_A2A_TASK_STATES,
  SLOTLOCK_AGENT_OPERATION_LEGACY_NAMES,
  SLOTLOCK_AGENT_SERVER_VERSION,
  SLOTLOCK_MAX_ALTERNATIVES,
  SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE,
  SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE,
  SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  SLOTLOCK_MCP_APP_HTML,
  SLOTLOCK_MCP_APP_MIME_TYPE,
  SLOTLOCK_MCP_APP_RESOURCE,
  SLOTLOCK_MCP_APP_RESOURCE_URI,
  SLOTLOCK_MCP_APPS_EXTENSION,
  SlotlockAgentOperationError,
} from './agent-server.js';
export type {
  SlotlockAgentCalendarBackend,
  SlotlockAgentConfirmationOptions,
  SlotlockAgentErrorContext,
  SlotlockAgentInvocationContext,
  SlotlockAgentOperation,
  SlotlockAgentOperationDispatchOptions,
  SlotlockAgentOperationDispatchResult,
  SlotlockAgentPrincipal,
  SlotlockAgentScope,
  SlotlockAgentServerEvent,
  SlotlockAgentServerOAuthOptions,
  SlotlockAgentServerOptions,
  SlotlockAgentSubscriptionOptions,
  SlotlockAgentWriteOperation,
  SlotlockAlternative,
  SlotlockArgumentIssue,
  SlotlockMcpToolResult,
  SlotlockTraceContext,
} from './agent-server.js';
export { createSlotlockNodeServer } from './node-server.js';
export type {
  SlotlockNodeListenOptions,
  SlotlockNodeServer,
  SlotlockNodeServerAddress,
  SlotlockNodeServerCloseResult,
  SlotlockNodeServerErrorPhase,
  SlotlockNodeServerFetchTarget,
  SlotlockNodeServerOptions,
} from './node-server.js';
export {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
  createSlotlockStoreChangeSource,
  projectSlotlockCalendarEvent,
} from './agent-store-backend.js';
export {
  SLOTLOCK_FEED_BUSY_MS,
  SLOTLOCK_FEED_IDLE_MS,
  type SlotlockAgentChange,
  type SlotlockAgentChangeSource,
} from './change-watch.js';
export type {
  SlotlockStoreAgentBackendOptions,
  SlotlockStoreApplicationBackendOptions,
} from './agent-store-backend.js';
export {
  SLOTLOCK_APPLICATION_OPERATIONS,
  SLOTLOCK_APPLICATION_SCOPE,
  isSlotlockApplicationOperation,
} from './application-api.js';
export type {
  SlotlockApplicationBackend,
  SlotlockApplicationInvocationContext,
  SlotlockApplicationOperation,
  SlotlockApplicationOperationDefinition,
} from './application-api.js';
export {
  createSlotlockMaintenanceRecord,
  maintainSlotlockTenant,
  slotlockMaintenanceError,
  startSlotlockMaintenance,
  withSlotlockMaintenanceLock,
} from './maintenance.js';
export type {
  SlotlockMaintenanceError,
  SlotlockMaintenanceRecord,
  SlotlockMaintenanceResult,
  SlotlockMaintenanceRound,
  SlotlockMaintenanceScheduler,
  SlotlockMaintenanceSchedulerOptions,
} from './maintenance.js';
export {
  createSlotlockApiKeyAuthenticator,
  createSlotlockApiKeyStore,
  generateSlotlockApiKey,
  isSlotlockApiKey,
  isSlotlockTestTenant,
  slotlockLiveTenant,
  SLOTLOCK_TEST_API_KEY_PREFIX,
  SLOTLOCK_TEST_TENANT_SUFFIX,
  slotlockApiKeyDigest,
  SLOTLOCK_API_KEY_ACTIVE_LIMIT,
  SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS,
  SLOTLOCK_API_KEY_PREFIX,
  SLOTLOCK_API_KEY_RETAINED_LIMIT,
  SLOTLOCK_API_KEY_SCOPES,
} from './api-keys.js';
export {
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockAcceptanceRecords,
  createSlotlockDashboardState,
  createSlotlockMemoryDashboardState,
  SLOTLOCK_DASHBOARD_MAX_RESOURCES,
} from './dashboard.js';
export type {
  SlotlockDashboard,
  SlotlockDashboardAssistantOptions,
  SlotlockDashboardOptions,
  SlotlockDashboardResources,
  SlotlockDashboardState,
  SlotlockInvitationSender,
} from './dashboard.js';
export {
  createSlotlockAssistantStore,
  createSlotlockMemoryAssistantStore,
  SLOTLOCK_ASSISTANT_TOOL_USE,
} from './assistant.js';
export type { SlotlockAssistantStore } from './assistant.js';
export {
  createSlotlockPartnerKeyAuthenticator,
  createSlotlockPartnerStore,
  parseSlotlockPartnerContract,
  slotlockPartnerTenantRef,
  SLOTLOCK_PARTNER_ACCOUNT,
  SLOTLOCK_PARTNER_ID,
  SLOTLOCK_PARTNER_SCOPE,
} from './partners.js';
export { createSlotlockDashboardTeams, createSlotlockOrganizationCheck } from './teams.js';
export { reportSlotlockOverage, SLOTLOCK_DEFAULT_OVERAGE_STOP_PERCENT } from './overage.js';
export type { SlotlockOverageReport } from './overage.js';
export { createSlotlockOtlpExporter, readSlotlockOtlpConfig, slotlockCallSpan } from './otel.js';
export type { SlotlockOtlpConfig, SlotlockTraceExporter } from './otel.js';
export type { SlotlockDashboardTeams } from './teams.js';
export {
  createSlotlockInvitationEmailSender,
  SlotlockInvitationEmailError,
  slotlockInvitationEmail,
} from './invitation-email.js';
export type { SlotlockInvitationEmailConfig } from './invitation-email.js';
export {
  createSlotlockDashboardWorkspaces,
  createSlotlockMemoryDashboardWorkspaces,
  createSlotlockWorkspaceCheck,
} from './workspaces.js';
export type {
  SlotlockDashboardWorkspaces,
  SlotlockGitHubMembership,
  SlotlockInvitationPreview,
  SlotlockTeamRefusal,
  SlotlockTeamWorkspace,
  SlotlockWorkspaceInvitation,
  SlotlockWorkspaceMember,
  SlotlockWorkspaceStanding,
  SlotlockWorkspaceTeams,
  SlotlockDashboardSession,
  SlotlockDashboardSessions,
  SlotlockSuspensionNotice,
  SlotlockAnnouncement,
  SlotlockDashboardNotices,
} from './workspaces.js';
export {
  SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES,
  SLOTLOCK_DASHBOARD_POST_CAPABILITIES,
  SLOTLOCK_FRESH_CAPABILITIES,
  SLOTLOCK_ROLE_CAPABILITIES,
  SLOTLOCK_SCOPED_CAPABILITIES,
  SLOTLOCK_SCOPED_DASHBOARD_PAGES,
  SLOTLOCK_SCOPED_DASHBOARD_POSTS,
  SLOTLOCK_WORKSPACE_CAPABILITIES,
  SLOTLOCK_WORKSPACE_ROLE_NAMES,
  SLOTLOCK_WORKSPACE_ROLES,
  isSlotlockWorkspaceRole,
  slotlockMemberCan,
  slotlockRoleCan,
  slotlockRoleKeyScopes,
  slotlockRoleMayGrant,
} from './workspace-roles.js';
// For resource adapters of one's own that keep to a limited member's scope (`keepsToScope`).
export { slotlockDashboardRequestScope } from './dashboard-scope.js';
export type { SlotlockWorkspaceCapability, SlotlockWorkspaceRole } from './workspace-roles.js';
export {
  closeSlotlockPartnerMonth,
  priceSlotlockPartnerMonth,
  slotlockClientLabel,
  slotlockPartnerMonthChecksum,
} from './partner-billing.js';
export type {
  SlotlockPartnerAccountMonth,
  SlotlockPartnerInvoiceLine,
  SlotlockPartnerMonthClose,
} from './partner-billing.js';
export type {
  SlotlockPartnerAccount,
  SlotlockPartnerContract,
  SlotlockPartnerPlan,
  SlotlockPartnerPricing,
  SlotlockPartnerStore,
} from './partners.js';
export type {
  CreateSlotlockApiKeyInput,
  SlotlockApiKey,
  SlotlockApiKeyAuthenticatorOptions,
  SlotlockApiKeyChange,
  SlotlockApiKeyIdentity,
  SlotlockApiKeyScope,
  SlotlockApiKeyStore,
} from './api-keys.js';
export {
  ICalendarWorkerBusyError,
  ICalendarWorkerPoolClosedError,
  createICalendarWorkerPool,
} from './ical-worker.js';
export type { ICalendarWorkerPool, ICalendarWorkerPoolOptions } from './ical-worker.js';
export {
  CalendarContractError,
  CalendarExpansionLimitError,
  emitICalendar,
  emitITipCalendar,
  expandCalendarEventOccurrences,
  normalizeCalendarEventContent,
  normalizeExternalCalendarChange,
  parseICalendarChanges,
  parseICalendarFeed,
  parseTrustedICalendarEvents,
  recurrenceRuleProblem,
  storedCalendarEventProblem,
} from './sync.js';
export type {
  ExternalCalendarChange,
  ExternalCalendarChangeInput,
  ExternalCalendarStatus,
  ICalendarEvent,
  ICalendarExpansionWindow,
  ICalendarFeedRead,
  ICalendarSeriesRefusal,
  ITipMethod,
} from './sync.js';
export {
  createSlotlockApplicationRoleGrantsDdl,
  createSlotlockTenantRlsDdl,
  SLOTLOCK_API_KEY_FUNCTIONS,
  SLOTLOCK_API_KEY_TABLES,
  SLOTLOCK_CORE_DDL,
  SLOTLOCK_DASHBOARD_FUNCTIONS,
  SLOTLOCK_DASHBOARD_TABLES,
  SLOTLOCK_APPEND_ONLY_TABLES,
  SLOTLOCK_AUDIT_RETENTION_DAYS,
  SLOTLOCK_CHANGE_RETENTION_BY_PLAN,
  SLOTLOCK_DEFINER_FUNCTIONS,
  SLOTLOCK_DEFINER_TABLES,
  SLOTLOCK_OPERATOR_FUNCTIONS,
  SLOTLOCK_SCHEMA_FUNCTIONS,
  SLOTLOCK_SCHEMA_TABLES,
  SLOTLOCK_SCHEMA_VERSION,
  SLOTLOCK_TENANT_ADMIN_FUNCTIONS,
  SLOTLOCK_TENANT_ADMIN_TABLES,
  SLOTLOCK_TENANT_CONTEXT_SETTING,
  SLOTLOCK_TENANT_RLS_DDL,
  SLOTLOCK_TENANT_TABLES,
} from './ddl.js';
export {
  assertSlotlockSchemaCurrent,
  calendarEventRollingHorizon,
  createSlotlockStore,
  readSlotlockSchemaVersion,
  SLOTLOCK_AGENT_OWNER_COMMAND_QUOTA,
  SLOTLOCK_AGENT_OWNER_EVENT_QUOTA,
  SLOTLOCK_CALENDAR_HORIZON_DAYS,
  SLOTLOCK_SOURCE_BUSY_MAX,
  SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS,
  SLOTLOCK_INTERNAL_EVENT_OWNER_REF,
  SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE,
  SLOTLOCK_MATERIALIZATION_WINDOW_DAYS,
  SLOTLOCK_MAX_EVENT_DURATION_DAYS,
  SLOTLOCK_MAX_CONTACTS_PER_TENANT,
  SLOTLOCK_PAYMENT_HOLD_MAX_TTL_MS,
  SLOTLOCK_TENANT_WRITE_METHODS,
  SLOTLOCK_TENANT_EXPORT_HOURS,
  SLOTLOCK_TENANT_EXPORT_MAX_BYTES,
  SLOTLOCK_TENANT_EXPORT_PART_ROWS,
  SLOTLOCK_MAX_TENANT_EXPORTS,
  buildSlotlockTenantExport,
  slotlockAuditEventRecord,
  type SlotlockAuditEvent,
  type SlotlockAuditEventInput,
  type SlotlockSubject,
  type SlotlockSubjectErasure,
  type SlotlockSubjectExport,
  type SlotlockTenantExport,
  type SlotlockTenantExportPartResult,
  type SlotlockHoldTenantOptions,
  type SlotlockMigrationOptions,
  type SlotlockSql,
  type SlotlockStore,
  type SlotlockStoreOptions,
  type SlotlockTenantLimits,
  type SlotlockTenantStore,
} from './store.js';
export type {
  AcquireHoldResult,
  BookingRetentionResult,
  CalendarAttendee,
  CalendarAttendeeRole,
  CalendarCoverageAssessment,
  CalendarCoverageCommand,
  CalendarCoverageResult,
  CalendarEventContent,
  CalendarEventOccurrence,
  CalendarEventRetentionResult,
  CalendarEventStatus,
  CalendarFreeBusy,
  CalendarHorizonRollCursor,
  CalendarHorizonRollResult,
  CalendarOrganizer,
  CalendarParticipationStatus,
  CalendarRecurrence,
  CalendarRecurrenceException,
  CalendarReminder,
  CalendarTransparency,
  ConfirmHoldResult,
  CancelCalendarEventResult,
  CancelExternalReservationResult,
  CreateReservationResult,
  DeleteResourceResult,
  ExternalReservationCommand,
  ExternalReservationResult,
  Interval,
  SlotlockAgendaEntry,
  SlotlockHold,
  MarkHoldPaidResult,
  SlotlockContact,
  SlotlockContactConsent,
  PutContactResult,
  SourceBusyCommand,
  SourceBusyResult,
  SlotlockCalendarEvent,
  SlotlockBookingDescription,
  SlotlockReservation,
  SlotlockResource,
  SlotlockTenantErasure,
  SlotlockBookingRuleDefaults,
  PutCalendarEventCommand,
  PutCalendarEventResult,
  ReleaseHoldResult,
  TrustedICalendarEvent,
  SlotlockInheritedAvailability,
  WeeklyAvailabilityRule,
  SlotlockSubjectTable,
  SlotlockTenantExportTable,
} from './types.js';
export {
  SLOTLOCK_SUBJECT_TABLES,
  SLOTLOCK_TENANT_EXPORT_LEFT_OUT,
  SLOTLOCK_TENANT_EXPORT_TABLES,
} from './types.js';
