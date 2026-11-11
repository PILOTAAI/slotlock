// Who may do what in a workspace: six fixed roles, each a set of capabilities, and every dashboard
// route named by the capability it needs. The dashboard reads a person's role from the database on
// every request (workspaces.ts) and checks it here before any handler runs, so a role changed or a
// membership ended applies at the next request, and a route missing from the table is refused.
//
// The roles follow what API products settled on (Stripe, Vercel): a Developer holds credentials but
// not people or money; Billing and Viewer hold the least. Owner and Admin differ by money and by
// the workspace itself. A capability marked fresh also needs a sign-in in the last 15 minutes.

/** The roles, most powerful first. */
export const SLOTLOCK_WORKSPACE_ROLES = Object.freeze([
  'owner',
  'admin',
  'developer',
  'member',
  'viewer',
  'billing',
] as const);
export type SlotlockWorkspaceRole = (typeof SLOTLOCK_WORKSPACE_ROLES)[number];

/** Each role as the dashboard names it. */
export const SLOTLOCK_WORKSPACE_ROLE_NAMES: Readonly<Record<SlotlockWorkspaceRole, string>> = Object.freeze({
  owner: 'Owner',
  admin: 'Admin',
  developer: 'Developer',
  member: 'Member',
  viewer: 'Viewer',
  billing: 'Billing',
});

export const SLOTLOCK_WORKSPACE_CAPABILITIES = Object.freeze([
  /** Switch workspace or environment, sign out, see one's own account. Every role. */
  'account.use',
  /** Read the workspace: overview, resources, bookings, contacts, history, key and webhook lists. */
  'workspace.read',
  /** The plan, its limits and this month's use. */
  'usage.read',
  /** Chat with the assistant; what it proposes still waits for a person to approve. */
  'assistant.chat',
  /** Run the booking desk: approvals, the waitlist, hours, closures and holiday calendars. */
  'operations.run',
  /** Resources, their booking rules, pools, locations and groups. */
  'resources.manage',
  /** The test environment's seed, reset and fast-forward. */
  'sandbox.manage',
  /** Read-only, read-write or resource-limited keys; rotate, revoke and limit one's own. */
  'keys.manage_own',
  /** Full-access keys (the admin scope: contacts, webhooks, history, erasure). Fresh. */
  'keys.full',
  /** Rotate, revoke or limit a key someone else created. */
  'keys.manage_any',
  /** Add, delete and enable webhooks, which stream every change to an outside address. Fresh. */
  'webhooks.manage',
  /** Forget a contact: an erasure request. */
  'contacts.forget',
  /** Connect, test or disconnect the assistant's model and its key. Fresh. */
  'assistant.settings',
  /** Invite, change roles and remove people, up to one's own powers. */
  'members.manage',
  /** Read the audit log. */
  'audit.read',
  /**
   * Export the workspace's data, and find, export or erase what it keeps about one person (RFC 0004
   * D3). Fresh.
   */
  'privacy.manage',
  /** Change the plan and open billing. Fresh. */
  'billing.manage',
  /** Grant Owner or Billing, transfer, delete the workspace, link a GitHub organization. Fresh. */
  'workspace.own',
] as const);
export type SlotlockWorkspaceCapability = (typeof SLOTLOCK_WORKSPACE_CAPABILITIES)[number];

/** Capabilities that also need a sign-in in the last 15 minutes (as GitHub's sudo mode). */
export const SLOTLOCK_FRESH_CAPABILITIES: ReadonlySet<SlotlockWorkspaceCapability> = new Set([
  'keys.full',
  'webhooks.manage',
  'assistant.settings',
  'billing.manage',
  'workspace.own',
  'privacy.manage',
]);

const everyCapability = SLOTLOCK_WORKSPACE_CAPABILITIES;
const without = (...left: SlotlockWorkspaceCapability[]) => everyCapability.filter((capability) => !left.includes(capability));

/** What each role may do. */
export const SLOTLOCK_ROLE_CAPABILITIES: Readonly<Record<SlotlockWorkspaceRole, ReadonlySet<SlotlockWorkspaceCapability>>> =
  Object.freeze({
    owner: new Set(everyCapability),
    admin: new Set(without('billing.manage', 'workspace.own')),
    developer: new Set<SlotlockWorkspaceCapability>([
      'account.use',
      'workspace.read',
      'usage.read',
      'assistant.chat',
      'operations.run',
      'resources.manage',
      'sandbox.manage',
      'keys.manage_own',
    ]),
    member: new Set<SlotlockWorkspaceCapability>(['account.use', 'workspace.read', 'usage.read', 'assistant.chat', 'operations.run']),
    viewer: new Set<SlotlockWorkspaceCapability>(['account.use', 'workspace.read', 'usage.read', 'assistant.chat']),
    billing: new Set<SlotlockWorkspaceCapability>(['account.use', 'usage.read', 'billing.manage']),
  });

export function isSlotlockWorkspaceRole(value: unknown): value is SlotlockWorkspaceRole {
  return typeof value === 'string' && (SLOTLOCK_WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** Whether a role may use a capability. */
export function slotlockRoleCan(role: SlotlockWorkspaceRole | null | undefined, capability: SlotlockWorkspaceCapability): boolean {
  return role !== null && role !== undefined && SLOTLOCK_ROLE_CAPABILITIES[role].has(capability);
}

/**
 * Whether `granter` may give `role` to someone: never a role with a capability the granter lacks,
 * so an Admin invites up to Admin, never Owner or Billing, and only those who manage members grant
 * at all.
 */
export function slotlockRoleMayGrant(granter: SlotlockWorkspaceRole | null | undefined, role: SlotlockWorkspaceRole): boolean {
  if (!slotlockRoleCan(granter, 'members.manage')) return false;
  for (const capability of SLOTLOCK_ROLE_CAPABILITIES[role]) {
    if (!slotlockRoleCan(granter, capability)) return false;
  }
  return true;
}

/** The API key scopes a role may give a key it creates: admin only with `keys.full`. */
export function slotlockRoleKeyScopes(role: SlotlockWorkspaceRole | null | undefined): readonly ('read' | 'write' | 'admin')[] {
  if (slotlockRoleCan(role, 'keys.full')) return ['read', 'write', 'admin'];
  if (slotlockRoleCan(role, 'keys.manage_own')) return ['read', 'write'];
  return [];
}

/**
 * Each dashboard POST route, by the capability it needs before its handler runs. A handler may ask
 * for more where the form decides (a Full-access key asks `keys.full`; another person's key asks
 * `keys.manage_any`). A route not listed is refused.
 */
export const SLOTLOCK_DASHBOARD_POST_CAPABILITIES: Readonly<Record<string, SlotlockWorkspaceCapability>> = Object.freeze({
  '/sign-out': 'account.use',
  '/sign-out-everywhere': 'account.use',
  '/sessions/end': 'account.use',
  '/organization': 'account.use',
  '/environment': 'account.use',
  '/teams/enable': 'account.use',
  '/teams/disable': 'account.use',
  // Anyone signed in may create a team workspace, join one they were invited to, or leave one.
  '/teams/create': 'account.use',
  // Deleting a team, or keeping one being deleted: its Owners only.
  '/teams/delete': 'workspace.own',
  '/teams/restore': 'workspace.own',
  '/invite/accept': 'account.use',
  '/members/leave': 'account.use',
  // Inviting or changing someone also needs the power the role given carries (dashboard.ts
  // capabilitiesOf): an Owner `workspace.own`, a Billing manager `billing.manage`.
  '/members/invite': 'members.manage',
  '/members/resend': 'members.manage',
  '/members/revoke': 'members.manage',
  '/members/role': 'members.manage',
  // Limiting a member to locations and groups (RFC 0004 D1), or giving them all of it again.
  '/members/scope': 'members.manage',
  '/members/remove': 'members.manage',
  '/keys': 'keys.manage_own',
  '/keys/rotate': 'keys.manage_own',
  '/keys/revoke': 'keys.manage_own',
  '/keys/limits': 'keys.manage_own',
  '/resources': 'resources.manage',
  '/resources/rules': 'resources.manage',
  '/resources/pool': 'resources.manage',
  '/resources/profile': 'resources.manage',
  '/resources/place': 'resources.manage',
  '/resources/parent': 'resources.manage',
  '/locations': 'resources.manage',
  '/locations/delete': 'resources.manage',
  '/groups': 'resources.manage',
  '/groups/delete': 'resources.manage',
  '/webhooks': 'webhooks.manage',
  '/webhooks/delete': 'webhooks.manage',
  '/webhooks/enable': 'webhooks.manage',
  '/waitlist/leave': 'operations.run',
  '/approvals/decide': 'operations.run',
  '/hours': 'operations.run',
  '/closures': 'operations.run',
  '/closures/delete': 'operations.run',
  '/closures/import': 'operations.run',
  '/closures/calendars/delete': 'operations.run',
  '/sandbox/seed': 'sandbox.manage',
  '/sandbox/reset': 'sandbox.manage',
  '/sandbox/fast-forward': 'sandbox.manage',
  '/contacts/forget': 'contacts.forget',
  '/assistant': 'assistant.chat',
  '/assistant/stream': 'assistant.chat',
  '/assistant/reset': 'assistant.chat',
  '/assistant/rename': 'assistant.chat',
  '/assistant/delete': 'assistant.chat',
  // Approving runs the change the assistant proposed: as the desk would.
  '/assistant/approve': 'operations.run',
  '/assistant/dismiss': 'assistant.chat',
  '/settings/assistant': 'assistant.settings',
  '/settings/assistant/test': 'assistant.settings',
  '/settings/assistant/models': 'assistant.settings',
  '/settings/assistant/remove': 'assistant.settings',
  '/plan/upgrade': 'billing.manage',
  '/plan/manage': 'billing.manage',
  '/settings/privacy/export': 'privacy.manage',
  '/settings/privacy/export/delete': 'privacy.manage',
  '/settings/privacy/person': 'privacy.manage',
  '/settings/privacy/person/export': 'privacy.manage',
  '/settings/privacy/person/erase': 'privacy.manage',
});

/** Each dashboard page (GET), by the capability it needs. A page not listed is refused. */
export const SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES: Readonly<Record<string, SlotlockWorkspaceCapability>> = Object.freeze({
  '/': 'workspace.read',
  '/keys': 'workspace.read',
  '/resources': 'workspace.read',
  '/resources/:id': 'workspace.read',
  '/webhooks': 'workspace.read',
  '/waitlist': 'workspace.read',
  '/approvals': 'workspace.read',
  '/hours': 'workspace.read',
  '/closures': 'workspace.read',
  '/contacts': 'workspace.read',
  '/locations': 'workspace.read',
  '/assistant': 'assistant.chat',
  '/assistant/chats': 'assistant.chat',
  '/plan': 'usage.read',
  '/teams': 'account.use',
  '/settings': 'workspace.read',
  '/settings/endpoints': 'workspace.read',
  '/settings/hours': 'workspace.read',
  '/settings/account': 'account.use',
  '/settings/members': 'workspace.read',
  '/settings/audit': 'audit.read',
  '/settings/audit/export': 'audit.read',
  '/settings/team': 'workspace.own',
  '/settings/privacy': 'privacy.manage',
  '/settings/privacy/download': 'privacy.manage',
});

/**
 * A member limited to some locations and groups (RFC 0004 D1) keeps at most these of their role's
 * capabilities: they read and run the desk for those resources, and chat with an assistant that
 * reaches only them. Nothing that reaches the whole workspace (keys, webhooks, people, money, its
 * hours and closures, its data whole or a person's) is theirs.
 */
export const SLOTLOCK_SCOPED_CAPABILITIES: ReadonlySet<SlotlockWorkspaceCapability> = new Set([
  'account.use',
  'workspace.read',
  'assistant.chat',
  'operations.run',
]);

/**
 * The pages a limited member reaches: what the store reads for them is held to their resources by
 * the database (resource_scope_v1), and pages whose content is the whole workspace's (keys,
 * webhooks, contacts, hours, closures, locations, usage, the audit log) are not among them.
 */
export const SLOTLOCK_SCOPED_DASHBOARD_PAGES: ReadonlySet<string> = new Set([
  '/',
  '/resources',
  '/resources/:id',
  '/waitlist',
  '/approvals',
  '/assistant',
  '/assistant/chats',
  '/teams',
  '/settings',
  '/settings/account',
  '/settings/members',
]);

/** The forms a limited member may send: their own account's, and the desk's for their resources. */
export const SLOTLOCK_SCOPED_DASHBOARD_POSTS: ReadonlySet<string> = new Set([
  ...Object.entries(SLOTLOCK_DASHBOARD_POST_CAPABILITIES)
    .filter(([, capability]) => capability === 'account.use' || capability === 'assistant.chat')
    .map(([route]) => route),
  '/waitlist/leave',
  '/approvals/decide',
  '/assistant/approve',
]);

/** Whether a role, limited (`scoped`) or not, may use a capability. */
export function slotlockMemberCan(
  role: SlotlockWorkspaceRole | null | undefined,
  scoped: boolean,
  capability: SlotlockWorkspaceCapability,
): boolean {
  return slotlockRoleCan(role, capability) && (!scoped || SLOTLOCK_SCOPED_CAPABILITIES.has(capability));
}
