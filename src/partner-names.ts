// The names partner accounts use (RFC 0003 part 4), with no imports, so the operation schemas
// (application-api.ts) and the partner store (partners.ts) share them without a cycle.

/** The scope a partner key carries, and the partner API needs. */
export const SLOTLOCK_PARTNER_SCOPE = 'partner';
/** A partner's id: lowercase, 2-40 characters, a letter first. */
export const SLOTLOCK_PARTNER_ID = /^[a-z][a-z0-9-]{1,39}$/;
/** A partner's id for one of its users: its own, 1-128 letters, digits, dots, dashes or underscores. */
export const SLOTLOCK_PARTNER_ACCOUNT = /^[A-Za-z0-9._-]{1,128}$/;
/** A contract plan's name. */
export const SLOTLOCK_PARTNER_PLAN = /^[a-z][a-z0-9_]{0,40}$/;
