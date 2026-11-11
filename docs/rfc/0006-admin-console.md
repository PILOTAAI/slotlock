# RFC 0006: The admin console: run Slotlock Cloud and its website from one place

| | |
| --- | --- |
| Status | Accepted (2026-11-11): the owner took the recommendations for E1 to E8. Phases 1 and 2 are built and wait for their independent security review and the owner's Phase 0 settings. |
| Target | Phase 0 (owner settings) first; then six phases, each shipped and reviewed on its own |
| Decision | GOVERNANCE.md: this changes tenancy and security boundaries (staff can act across tenants), so it needs this RFC, the maintainer's approval and, while there is one maintainer, an independent security review of each phase. The owner's calls are in Part 7. |

## Summary

Running Slotlock Cloud today takes four tools and a database password:

- the CLI with the schema owner's credentials, to suspend or erase a tenant, mint a key or set the
  default plan;
- Stripe's dashboard, for subscriptions and invoices;
- Cloudflare's dashboard, for the Workers, Access and analytics;
- an editor and a pull request, for every blog post, which is TypeScript data in
  `site/src/data/blog.ts`.

The audit of the code on `main` at `2305a37` (after #186), made on 2026-11-11 and summarised in Part 1, found ten
gaps. In brief:

- **No staff identity.** Every role is per workspace (`src/workspace-roles.ts`), and Cloud lets
  anyone sign in (`SLOTLOCK_DASHBOARD_USERS=*`). Nobody is "staff".
- **No account directory.** A tenant is only a `tenant_ref` string. The CLI cannot list accounts,
  and there is no way to look one up by GitHub login, key prefix or Stripe customer.
- **Operator actions leave no trace.** CLI suspensions, key mints and erasures write no audit row,
  and erasure deletes the tenant's audit log with everything else.
- **Promises without tooling.** PRIVACY.md promises a portable export of an account and erasure on
  request; there is no export, and erasure is a manual CLI run with no tracking. A plan can only
  change through the Stripe webhook, so there is no way to comp an account.
- **Content is code.** A post means editing TypeScript, adding an entry to the image script and
  committing a PNG.

This RFC proposes an **admin console** at `admin.slotlock.pylota.io`:

- a **separate Cloudflare Worker**, behind **Cloudflare Access**, with its own staff sign-in
  (GitHub plus a passkey) and staff roles;
- **cross-tenant data only through new database functions** that check the staff member's role and
  record every call in a staff audit log, in the same transaction, and never return booking
  content;
- a **git-backed CMS**: posts become Markdown files, edited and previewed in the console, and
  published as pull requests that pass the site's own checks before they deploy;
- **twelve modules** (Part 3), designed on the site's own tokens and type, with patterns taken
  from Mobbin and goshenemail.com (Part 4.7);
- **six phases** (Part 6). Phase 1, the account directory, account pages and audited
  suspensions, is useful on its own.

## Part 1: What exists today

Every line was checked in the code; references are `file:line` on `main` at `2305a37`, so line numbers may drift as `main` moves.

| Need | Today | Gap |
| --- | --- | --- |
| Staff identity and roles | Roles are per workspace: owner, admin, developer, member, viewer, billing (`src/workspace-roles.ts:11-18`), 17 capabilities (`:31-66`). Sign-in allowlist is `*` on Cloud (`workers/dashboard/wrangler.jsonc:80`) | No staff concept anywhere |
| Account directory | No accounts table; a tenant is a `tenant_ref` (`github:<id>`, `google:<sub>`, `github-org:<id>`, `team:<uuid>`, `partner:…`, `~test`) (`src/dashboard.ts:2336-2343`). The only tenant list is names-only and owner-only (`src/ddl.ts:3799-3881`) | No search by login, email, key prefix or Stripe customer |
| Cross-tenant reads | Tenant tables use FORCE row-level security; admin tables are "definer tables" reachable only through SECURITY DEFINER functions (`src/ddl.ts:230-363`). `serve` refuses superuser, BYPASSRLS and owner roles (`src/self-host.ts:981-1016`) | No safe path for a staff member to read across tenants |
| Operator functions | `suspend_tenant`, `unsuspend_tenant`, `set_plan_default`, owner-only (`src/ddl.ts:416-425`). CLI: `tenant status\|suspend\|unsuspend\|erase`, `key create\|list\|rotate\|revoke`, `plan status\|default`, `partner …`, `billing daily`, `overage report` (`src/self-host.ts:2453-2778`) | CLI only, with owner credentials, one tenant at a time |
| Audit | `audit_events`: hash-chained per tenant, append-only for the serving role, 180 days or 400 on Team; the change history is append-only too, kept by plan. A tenant reads and verifies its log over `GET /v1/audit` and `/v1/audit/verify`, or `slotlock audit export` and `verify` (#186). Written only by the dashboard and the API; `actor_type 'system'` exists but nothing writes it | Operator and CLI actions are not audited; erasing an account deletes its log (`src/ddl.ts:3376`) |
| Plans and billing | Plans in `src/plans.ts`; `tenant_plans`, `plan_defaults` tables. A plan is set only by the Stripe webhook (`src/billing.ts:285,340`). A duplicate purchase is only logged (`workers/dashboard/worker.ts:549-553`). `billing daily` signals trouble only by its exit code | No comp or override; no view of failed or duplicate payments |
| Usage | `usage_daily`, 400 days (`src/usage.ts`, `src/ddl.ts:2701`); quotas and 80%/100% notices (`src/quotas.ts`). Metrics and traces carry no tenant by design (`src/metrics.ts:1-3`, `src/otel.ts:1-8`) | No per-account usage view for staff |
| Suspension and abuse | `tenant_suspensions` with a reason; a suspended tenant can only read (`src/ddl.ts:2397-2431`, `src/dashboard.ts:8094-8103`) | No case record, no customer-facing message, no UI |
| Privacy requests | Two kinds. **About one of a customer's own customers**: the account holder answers it with `POST /v1/subjects/export` and `/erase`, or `slotlock subject export` and `erase`, which find the person by email or reference, delete their contact, attendee and waitlist entries, and rename their references (#186). **About the account holder**: PRIVACY.md promises a portable copy and erasure on request, verified by email and a key-name proof; `erase_tenant` clears about 55 tables and refuses an active subscription (`src/ddl.ts`). RFC 0003 asked for an erasure runbook that cancels Stripe first; none exists | No whole-account export, no tracked workflow, no record that an account erasure happened |
| Maintenance and health | Hourly maintenance per tenant (`src/maintenance.ts`); Prometheus `/metrics` behind a token; a status probe in GitHub Actions, not yet switched on (`docs/hosted/status.md`) | No view of job runs or failures |
| Content | Posts are TypeScript data (`site/src/data/blog.ts`); each needs an entry in `site/scripts/og-images.mjs` and a committed PNG. Markdown was planned but would bring Expressive Code's inline styles, which the strict CSP refuses (RFC 0005) | No editor, no drafts, no scheduling |
| Customer dashboard conventions | Server-rendered HTML through an escaping `html` template (`src/dashboard.ts:1465-1482`); strict CSP with only `app.js` for progressive enhancement; sessions are HMAC-sealed `__Host-` cookies, 12 hours; every POST checks Origin, a CSRF token and a single-use nonce; a "confirm it's you" step-up within 15 minutes for sensitive actions (`src/dashboard.ts:2148-2334`, `src/workspace-roles.ts:70-76`) | These are the patterns the console reuses |

## Part 2: Who uses it

| Staff role | Who | What they do |
| --- | --- | --- |
| **Owner** | The maintainer | Everything, including staff management, plan overrides, erasure approval and publishing |
| **Support** | Whoever answers support@ | Find an account, see its plan, usage, keys and audit log; end sessions; revoke a key at the customer's request; suspend for abuse; write notes; start privacy requests |
| **Billing** | Finance | Revenue, failed payments, duplicates, overrides up to 90 days, partner month close |
| **Editor** | Anyone writing for the site | Write, preview and submit posts; see site and search numbers |
| **Viewer** | Advisers, auditors | Read the home page, revenue and site numbers; no account detail |

Capabilities follow the dashboard's model (`src/workspace-roles.ts`): each route names the
capability it needs, an unlisted route is refused, and sensitive capabilities need a fresh
passkey check. Four actions need **two people** (four eyes): erasing an account, a plan override
longer than 90 days, changing a staff member's role, and break-glass access to an account's
booking content.

## Part 3: The modules

Each module lists what it shows, what it can do, where its data comes from, and its guardrails.

### M0. The shell

- A left sidebar with counts on the items that hold work ("Privacy requests · 2 due", "Payments ·
  1 failed"), as goshenemail.com puts counts on its inboxes.
- A top bar with global search (⌘K), the environment (Live or Test), and the staff member's menu.
- ⌘K finds an account by GitHub login, verified email, tenant ref, key prefix (`slk_…`), Stripe
  customer id or partner, and jumps to any page or action the staff member's role allows.
- Breadcrumbs on every page; one primary action per page.

### M1. Home

- **Needs attention**, a queue ordered by urgency: privacy requests near their statutory date,
  failed or duplicate payments, `billing daily` mismatches, accounts at 100% of an allowance,
  suspended accounts without a case, maintenance failures, comparison pages past their re-check
  date, open abuse cases.
- **Numbers**: accounts, active in the last 7 days, paying accounts, monthly recurring revenue,
  bookings and operations this month, each with the change from last month.
- **Sign-ups** by day, and the newest accounts.
- **Health**: API and dashboard up, version on each host, last deploy of each Worker, last
  maintenance run.

### M2. Accounts

- A table of every account: name (GitHub login or organization), tenant ref, plan, status
  (active, suspended, deleting), created, last active, operations and bookings this month against
  the plan.
- Filters: plan, status, created and last-active ranges, near a limit, partner, has a Stripe
  customer. Sort by any column; export the current view as CSV (Owner and Billing only).
- Data: a new `account_directory` (Part 4.4), kept by the same functions that create tenants,
  people and plans.

### M3. Account detail

The layout follows Stripe's customer page: sections on the left, a details rail on the right.

- **Header**: name, tenant ref (copyable), plan, status, created, last active; actions as one
  primary button and a "more" menu.
- **Overview**: usage against each allowance as bars; resources, keys, webhooks and members as
  counts; the last ten audit events.
- **Keys**: name, prefix, scope, created, last used, expiry, status. Revoke one, with a reason.
  The secret is never shown; Slotlock keeps only its hash.
- **People and teams**: members and roles, invitations, and sessions with device and last seen.
  End one session or all.
- **Billing**: the Stripe customer and subscription, read from Stripe; invoices with links to
  Stripe; a **plan override** (a plan and an end date, with a reason), which takes precedence over
  the webhook's plan until it ends.
- **Usage**: operations and bookings by day for 90 days, by surface (MCP, A2A, REST, dashboard,
  assistant).
- **Audit**: the account's own audit log, and every staff action on the account.
- **Notes**: internal notes with author and time, never shown to the customer.
- **Danger zone**: suspend (reason, and an optional message the customer sees in the dashboard),
  unsuspend, export the account's data, request erasure.

What staff cannot see: booking titles, descriptions, attendees and contacts, which free/busy and
the audit log never hold either. Seeing them takes **break-glass access**: a reason, the Owner's
approval, one hour, recorded in the staff log and shown to the customer in their audit log.

### M4. Billing and revenue

- Monthly recurring revenue and its change, plan mix, new and cancelled subscriptions.
- **Failed payments** and **duplicate subscriptions**, from Stripe events, each linking to the
  account and to Stripe.
- `billing daily` and `overage report` results, run on a schedule and shown here instead of only
  an exit code.
- Partner accounts: each partner's month, and the **month close** that today runs from the CLI.
- Refunds, disputes and invoices stay in Stripe: the console links there, never re-implements them.

### M5. Usage and limits

- Platform totals by day: operations, bookings, by surface.
- Accounts near or over an allowance; quota refusals today.
- **Temporary allowance increase** for an account, with an end date and a reason: a row in a new
  `tenant_plan_overrides` table, read wherever the plan's limits are read.

### M6. Trust and safety

- **Cases**: opened from an abuse report (abuse@) or from an account page, with the evidence, the
  Acceptable Use Policy section, the action taken and the outcome.
- Actions: suspend or unsuspend an account or a partner (with its accounts), revoke keys.
- Network blocks stay in Cloudflare's WAF; a case links to them.

### M7. Privacy requests

- A queue of access, export, correction and erasure requests, each with the date it arrived and
  its statutory due date (one month under UK GDPR).
- Two kinds, kept apart:
  - **About an account holder.** Slotlock answers these as controller, with the export and the
    erasure below.
  - **About one of an account's own customers.** The account holder is that data's controller and
    answers it with the subject API (#186). Staff only help when the account holder asks, by
    running the same subject export or erasure for them, recorded in the staff log and the
    account's audit log.
- **Verification checklist** as PRIVACY.md describes it: the email the request came from, and
  proof of a key name in the account.
- **Export**: a job that builds the account's data (resources, rules, events as JSCalendar and
  iCalendar, holds, keys' metadata, audit log) as a zip, stores it in R2, and gives a link that
  works for 7 days.
- **Erasure**, as a checklist that cannot be reordered:
  1. cancel the Stripe subscription;
  2. a second staff member approves;
  3. erase;
  4. record an **erasure receipt**: the request id, a hash of the tenant ref, the time and who
     approved. The receipt holds no personal data and survives the erasure.
- Every step lands in the staff log.

### M8. Content (the CMS)

- **Posts**: a list with status (draft, in review, scheduled, published), author, dates and the
  page's search clicks from M9.
- **Editor**:
  - Markdown with a live preview rendered by the site's own renderer and stylesheet, so the
    preview is the page.
  - A settings panel with title, search title, description, slug, tags, author, related links
    and the publish date.
  - Title and description counters with a search-result preview.
  - A preview of the Open Graph image.
- **Checks before submitting**, as a list of passes and failures: the copy lint rules, the length
  rules, alt text on every image, links to pages that exist, a description that is not repeated
  elsewhere.
- **Publishing** (Part 4.5): submitting opens a pull request; the site's CI runs every check; the
  Owner merges from the console, which deploys the site. A post with a future publish date waits
  as a scheduled pull request until a scheduled workflow merges it.
- **Media**: images uploaded with the post, stored beside it in the repository, with size limits
  and required alt text.
- **Authors**: named people with a GitHub profile (RFC 0005, D7), given as `Person` in the post's
  structured data.
- **Comparison pages**: their "last checked" dates, flagged in M1 when a quarter old.
- **Redirects**: a changed slug writes a redirect, so old links keep working.

### M9. Site and search

Read-only:

- Search Console: clicks, impressions, click-through rate and position by query and page, and
  indexing coverage.
- Bing Webmaster: the same for Bing.
- Cloudflare Web Analytics: visits, top pages, referrers.
- The site's last deploy and its SEO check results.
- Pages whose impressions are high and whose click-through rate is under 2%, as candidates for a
  new title (RFC 0005, Phase 5).

### M10. Communications

- **Announcements**: a banner in the customer dashboard, by plan or for everyone, with start and
  end times, for maintenance and changes to the API.
- **Service notices** by email to account owners, for what PRIVACY.md allows on the contract
  basis (an incident, a change to the API). Marketing email is out of scope.
- **Status**: open or update an incident on the status page.

### M11. System

- Health of each host; the version each runs; deploy history from GitHub.
- **Maintenance runs**: each hourly run, its duration, and failures by tenant, from a new
  `maintenance_runs` table.
- Webhook deliveries failing across the platform, as counts (no payloads).
- **Feature flags**: per account or per plan, for what is today an environment variable (the
  assistant, team workspaces), with a history of changes.
- Configuration: the non-secret settings each host runs with.

### M12. Staff and security

- Staff members, their roles, their passkeys and sessions; invite, change a role (four eyes),
  remove.
- The **staff audit log**: every staff action and every cross-tenant read, with who, what, which
  account, the reason and the request id. It is append-only and hash-chained like `audit_events`,
  kept two years, and never deleted by an erasure.
- A quarterly access review: a list of staff and their last use, to confirm or remove.

## Part 4: Architecture

### 4.1 Where it runs

- A third Cloudflare Worker, `workers/admin`, on `admin.slotlock.pylota.io`. It is the customer
  dashboard's sibling, with its own code path, secrets, database role and Access policy, so a bug
  in one cannot open the other.
- Code in `src/admin/`, exported as `createSlotlockAdmin`, built on the dashboard's patterns:
  - the escaping `html` template;
  - sealed `__Host-` cookies;
  - Origin, CSRF and single-use nonce checks on every POST;
  - a strict CSP;
  - one `app.js` for progressive enhancement;
  - a capability per route, and an unlisted route refused.
- The CMS editor and ⌘K need more script: two small modules, served as hashed files under the same
  CSP (`script-src 'self'`). The editor is CodeMirror 6, bundled.
- Not mounted by `slotlock serve`. Self-hosters can opt in later (Part 7, E6).

### 4.2 Staff identity

Three layers, each enough to stop someone the layer before let through:

1. **Cloudflare Access** on the hostname, with GitHub as the identity provider, limited to the
   staff list. Nothing reaches the Worker without it. It is free for up to 50 users.
2. The Worker **verifies the Access JWT** (`Cf-Access-Jwt-Assertion`) against the team's keys and
   audience, so a request that skips Access is refused.
3. **Staff sign-in**:
   - GitHub OAuth, reusing the dashboard's code, mapped to a row in `staff_members`;
   - a **passkey** (WebAuthn) as the second factor, required at sign-in and again within 15
     minutes of a sensitive action;
   - sessions of 8 hours, ended after 30 minutes idle.

### 4.3 Authorization

A staff capability map like `src/workspace-roles.ts`:

| Capability | Owner | Support | Billing | Editor | Viewer |
| --- | --- | --- | --- | --- | --- |
| Home, numbers | ✓ | ✓ | ✓ | ✓ | ✓ |
| Account list and detail | ✓ | ✓ | ✓ | | |
| End sessions, revoke keys, notes | ✓ | ✓ | | | |
| Suspend, unsuspend, cases | ✓ | ✓ | | | |
| Plan override up to 90 days | ✓ | | ✓ | | |
| Plan override over 90 days | ✓ (four eyes) | | | | |
| Revenue, payments, partner close | ✓ | | ✓ | | ✓ (read) |
| Privacy requests | ✓ | ✓ (start, verify) | | | |
| Export | ✓ | ✓ | | | |
| Erasure | ✓ (four eyes) | | | | |
| Break-glass content access | ✓ (four eyes) | | | | |
| Write posts | ✓ | | | ✓ | |
| Publish posts | ✓ | | | | |
| Site and search numbers | ✓ | | | ✓ | ✓ |
| Announcements, feature flags | ✓ | | | | |
| Staff management | ✓ (four eyes) | | | | |

### 4.4 Data access

- A new login role, `slotlock_admin_app`, used by the admin Worker through its own Hyperdrive
  configuration.
  - It has **no table grants**, and is neither superuser nor BYPASSRLS. The Worker checks this at
    start-up and refuses otherwise, as `serve` does.
  - It may only execute a new list, `SLOTLOCK_ADMIN_FUNCTIONS`: SECURITY DEFINER functions owned by
    the deployment role, in the pattern of `SLOTLOCK_OPERATOR_FUNCTIONS`.
- Every admin function:
  - takes the staff session's `staff_ref`, checks that member's role in `staff_members`, and
    writes a `staff_audit_events` row in the same transaction;
  - returns only the columns the console shows, and never booking content (titles, descriptions,
    attendees, contacts);
  - is paginated, and capped at 100 rows a call.
- **New tables**: `staff_members`, `staff_passkeys`, `staff_sessions`, `staff_audit_events`,
  `account_directory`, `account_notes`, `tenant_plan_overrides`, `privacy_requests`,
  `erasure_receipts`, `abuse_cases`, `announcements`, `feature_flags`, `maintenance_runs`.
- **`account_directory`**: one row per tenant (ref, kind, display name, created, last active,
  plan, status, Stripe customer, partner). It is maintained by the functions that create tenants,
  sign people in, change plans and suspend; backfilled once from `dashboard_people`,
  `workspaces`, `tenant_plans` and the tenant list. This fills the "no accounts table" gap without
  changing how tenants work.
- The CLI's operator commands (`tenant suspend`, `key create`, `plan default`, `tenant erase`) gain
  an actor (`cli:<user>`), and write the staff audit log too. Erasure writes its receipt.
- A staff action on an account also writes the customer's own `audit_events`, with `actor_type`
  `system`: the label "Slotlock staff (Support)" and the reason, so customers see what staff did
  (Part 7, E8).

### 4.5 The CMS: git-backed

Posts stay files in the repository and keep every guarantee the site has: review, history, copy
lint, the SEO check and a strict CSP.

1. **Format.** `site/content/blog/<slug>.md`: frontmatter (the fields of today's `Post`, plus
   `author`, `status` and `publishAt`) and a Markdown body. The four posts move across unchanged in
   words; `blog.ts` goes.
2. **Rendering without inline styles.** A content loader renders Markdown with remark and rehype,
   without Expressive Code:
   - code blocks become plain `<pre><code class="language-…">`, styled by `pages.css`;
   - raw HTML is not allowed, so a post cannot carry a script.
   The page and its Markdown twin come from the same file.
3. **Open Graph images.** `og-images.mjs` reads titles from the posts' frontmatter, and the site's
   CI draws any missing image (Playwright, cached) before the build. Nobody commits an image by
   hand.
4. **Publishing.** A GitHub App, "Slotlock CMS", installed on PILOTAAI/slotlock only, with
   contents and pull requests write.
   - **Submit** commits the post and its images to `cms/<slug>`, authored and signed off as the
     staff member, so the DCO check passes. It then opens a pull request, which runs the site's
     checks.
   - **Publish** merges it: Owner only (E5). The merge deploys the site.
   - A **scheduled** post's pull request carries a label; an hourly workflow merges those whose
     `publishAt` has passed and whose checks are green.
5. **Preview.** The editor's live preview uses the same renderer, compiled into the admin
   Worker. Each CMS pull request also gets a preview deploy of the whole site on a `noindex`
   preview Worker, linked from the pull request and the console.
6. **Redirects.** A changed slug adds a line to `site/public/_redirects`.

A database-backed CMS was considered and set aside:

- it would make the site dynamic (server-rendered pages);
- it would move content out of review and out of the checks;
- it would need its own backups and its own CSP exceptions.

The git-backed design costs a few minutes between Publish and the live page, which a blog can
afford.

### 4.6 Integrations

- **Stripe**: a restricted key that can read customers, subscriptions, invoices and events, and
  cancel a subscription (for erasure). Plan overrides live in Slotlock, not in Stripe.
- **Search Console and Bing**: a Google service account with read access to the property, and a
  Bing API key, both read-only.
- **Cloudflare**: an API token that reads Web Analytics, Workers deploys and Access audit logs.
- **GitHub**: the CMS App above, and read access to deploys and the status issues.
- Every external read is cached for an hour in Postgres (`admin_cache`), so the console stays fast
  and within the providers' quotas. Every secret is a Worker secret, never in the repository.

### 4.7 Design

**Design system**

- The console uses the site's own system: the colour tokens in `site/src/styles/tokens.mjs`
  (Pylota's, light and dark), Inter, Inter Tight for headings and JetBrains Mono for ids and code.
- It is checked by the same `contrast.mjs` (WCAG AA in both themes).
- It looks like the customer dashboard's sibling: the dashboard's sign-in card, sidebar and
  notices, with more density for tables.

**From goshenemail.com** (whose layout the Slotlock site already follows: numbered steps, key
cards, eyebrow, title and lede):

- counts and state tags on sidebar items;
- status in plain words ("Failed · Retry");
- numbered sections in long editors;
- checks shown as a list of passes and failures;
- one primary action per page, the rest as text links;
- an object's permissions shown on the object (a key row with its scope, expiry and Revoke).

**From Mobbin**, the screens each module borrows from:

| Module | Pattern | References |
| --- | --- | --- |
| M2 Accounts | Calm rows, pill statuses, search and filter chips, a row menu | [Mercury users](https://mobbin.com/screens/d620d481-387a-4cbc-b0a8-67463a5ecf73), [Docusign users](https://mobbin.com/screens/b5c686e8-3354-42f7-a8f6-7cd067f9561f), [Asana admin users](https://mobbin.com/screens/5c8ac940-052c-4e8b-8598-52686804cbbd) |
| M3 Account detail | Sections with a details rail on the right | [Stripe customer](https://mobbin.com/screens/1a4aa88b-e0be-49b2-a87f-1264e0b5e786), [Airwallex customer drawer](https://mobbin.com/screens/249d171b-4720-49cd-bc5f-367a8263c102) |
| M5 Usage | A breakdown chart above a table with sparklines | [Vercel usage](https://mobbin.com/screens/b7b0e5e1-192b-4306-b2a6-88bca0d49bb6), [Runway usage table](https://mobbin.com/screens/850f0ad4-96f6-4368-865f-7657acabd025) |
| M12 and account audit | Actor, action code chip, IP and time; a filter popover; download | [PlanetScale audit log](https://mobbin.com/screens/350460dd-4eba-4197-9f8e-f18d0e96cfef), [1Password activity log](https://mobbin.com/screens/a5632ec1-f072-43e2-8f2b-ad047df4ca04), [Grok audit log with a chart](https://mobbin.com/screens/673656da-327b-4e01-98fd-8a23f21718a4) |
| M8 Editor | SEO fields with character guidance, slug, social image | [Podia SEO tab](https://mobbin.com/screens/7f6f3d3c-301b-4c61-a635-1cb98f36bfd3), [Hashnode page settings](https://mobbin.com/screens/aa594e1e-fa0a-4ad5-af7a-fdc64d34a1f4), [Kajabi post details](https://mobbin.com/screens/46d03b3b-e04f-4e08-b026-1519decac7c2), [Semrush writing assistant](https://mobbin.com/screens/04b52b42-dd93-4b25-b228-0fda3e37c0ba) |
| M1 Home | "Things to do" queue with quick actions; today and this month | [Remote dashboard](https://mobbin.com/screens/9b8be04d-bec4-46c2-a9ae-a783259431a5), [Teachable dashboard](https://mobbin.com/screens/c9020d16-6244-4d8b-9462-0a5c1175cac9) |

**Interaction rules**

- Server-rendered forms, with confirm popovers for destructive actions: the dashboard's
  `details.act`.
- A notice after every action, saying what changed.
- Every empty state names the next action.
- Keyboard: ⌘K, `/` to search, `g` then a letter to go to a module.
- Tables fit on a phone by stacking, as the site's comparison tables do. No horizontal scroll.

## Part 5: Security and privacy

**Threats, and what answers each**

| Threat | Answer |
| --- | --- |
| A staff member's GitHub account is taken over | Access policy and a passkey: a stolen GitHub session is not enough |
| An insider misuses access | Least privilege per role; four eyes on the most damaging actions; every read and write in the staff log; staff actions shown to the customer |
| A request skips Access | The Worker verifies the Access JWT on every request |
| CSRF or replay | The dashboard's Origin check, CSRF token and single-use nonce |
| XSS through a post | No raw HTML in Markdown; a strict CSP on the site and the console |
| A leaked database credential | `slotlock_admin_app` can only call the admin functions, each of which checks the staff member and writes the log |
| Bulk export of customer data | Lists capped at 100 rows a call; the account export only through a privacy request; CSV export of the directory for Owner and Billing only, and logged |
| The CMS App's token | Scoped to one repository; it can open and merge pull requests, and the site's checks still run |

**Before the console goes live**

- **PRIVACY.md** says:
  - that staff can see account metadata, never booking content without break-glass;
  - how long the staff log is kept;
  - what an export contains;
  - the new processors' roles (Cloudflare Access, GitHub).
- **SECURITY.md** describes the console and how to report a problem with it.
- **An independent security review** of each phase (GOVERNANCE.md), recorded on its pull request.

## Part 6: Delivery plan

Each phase ships on its own and is useful on its own. Each phase is done when:

- its tests pass in CI;
- the console's screenshots are reviewed in light and dark, on a phone and on a desktop;
- axe finds no accessibility violation;
- the independent security review is recorded.

Coding is quick with an agent. The reviews and the owner's settings are what take calendar time,
so the estimates below include them.

| Phase | Scope | Done when | Estimate |
| --- | --- | --- | --- |
| **0. Owner settings** | Cloudflare Access application for `admin.slotlock.pylota.io` with GitHub; the "Slotlock CMS" GitHub App; a Hyperdrive configuration for `slotlock_admin_app`; DNS; the Worker's secrets; decisions E1 to E8 | Access blocks a non-staff GitHub account | An hour |
| **1. Foundation and directory** | `workers/admin` and `src/admin/`; staff tables, sign-in (Access JWT, GitHub, passkey), roles, staff log; `account_directory` and its backfill; M0 shell with ⌘K; M1 Home (numbers, health); M2 Accounts; M3 Account detail, read-only; M12 staff list | Support can find any account by login, key prefix or Stripe id and see its plan, usage, keys and audit log; every view is in the staff log | 1 to 2 weeks |
| **2. Support actions** | Suspend and unsuspend with a reason and a customer message; revoke keys; end sessions; notes; abuse cases (M6); staff actions in the customer's audit log; CLI operator commands audited | A suspension made in the console shows in the customer's dashboard and audit log, and in the staff log | 1 week |
| **3. Billing and usage** | Stripe reads (M4); failed and duplicate payments; `billing daily` and `overage report` on a schedule, shown on Home; plan overrides and temporary allowances (M5); partner month close | An override changes the account's limits at once and ends on its date; a failed payment appears on Home within the hour | 1 week |
| **4. CMS** | Posts to Markdown (content loader, CSP-safe renderer); editor with preview, checks and SEO panel (M8); GitHub App publishing with DCO sign-off; scheduled merges; images drawn in CI; media; authors; redirects; preview deploys | An Editor writes a post, an Owner publishes it from the console, and it is live with its image, structured data and sitemap entry, having passed every site check | 1 to 2 weeks |
| **5. Privacy** | M7 queue with due dates; export job to R2; erasure checklist (Stripe first, four eyes, receipt); PRIVACY.md and SECURITY.md updated | An erasure leaves a receipt and no data; an export opens and contains every table the export promises | 1 week |
| **6. Insights, communications and system** | M9 (Search Console, Bing, Cloudflare); M10 announcements and service notices; M11 maintenance runs, deploys, feature flags | The dashboard shows an announcement scheduled in the console; a maintenance failure appears on Home | 1 week |

**Tests, by layer**

- **Unit**: the capability map (every route has one; every role's set); input validation; the
  Markdown renderer refuses raw HTML.
- **Database integration**, in the existing PostgreSQL suites:
  - each admin function refuses a caller without the role;
  - it writes exactly one staff log row in the same transaction;
  - it never returns a content column (a test lists the columns of every result);
  - `slotlock_admin_app` cannot read a table directly.
- **End to end**, with Playwright against a local stack: a fake Access issuer and fake GitHub
  OAuth (the repository's fakes pattern), and a virtual WebAuthn authenticator. Covered: sign-in,
  search, suspend, override, privacy request, and publishing a post through a fake GitHub API.
- **Visual and accessibility**: screenshots of each page in both themes, and axe on each page.
- **Load**: the directory search over 10,000 accounts answers within 200 ms.

## Part 7: Decisions for the owner

| # | Decision | Recommendation | Owner's decision (2026-11-11) |
| --- | --- | --- | --- |
| E1 | Where the console runs | `admin.slotlock.pylota.io`, its own Worker, behind Cloudflare Access | As recommended |
| E2 | Staff sign-in | GitHub through Access, plus a passkey in the console | As recommended |
| E3 | Booking content | Never shown by default; break-glass with a reason, the Owner's approval, one hour, and a notice to the customer | As recommended |
| E4 | CMS | Git-backed: Markdown files, published as pull requests that pass the site's checks | As recommended |
| E5 | Who publishes | Editors submit; the Owner publishes | As recommended |
| E6 | Self-hosters | Cloud only in the first version; an opt-in for `slotlock serve` later | As recommended |
| E7 | Staff log retention | Two years, never deleted by an erasure | As recommended |
| E8 | Staff actions visible to customers | Yes, in the customer's audit log, with the reason | As recommended |

**Phase 1 is built in two parts**, each its own commit with its tests:

- **1a, the database:** `staff_members`, `staff_passkeys` and `staff_audit_events`; the admin
  functions with their role checks and logging; the grants for `slotlock_admin_app`, applied by
  `slotlock migrate` when `SLOTLOCK_ADMIN_DATABASE_URL` is set; and `slotlock staff
  add|list|role|remove`, run with the deployment role's credentials, which is how the first Owner
  is added.
- **1b, the console:**
  - the Worker, with the Access check, sign-in and passkeys;
  - the pages for Home, Accounts, an account, staff and the staff log, with ⌘K.

**Where Phase 1 stands.** Both parts are built and tested:

- `src/admin/` holds the app, the pages, the passkey verifier (WebAuthn, ES256 and RS256, attestation
  "none", user verification required) and the Access token verifier. `workers/admin` holds the
  Worker and its example configuration. The Dashboard workflow bundles the Worker.
- The end-to-end test (`admin-console.integration.test.ts`) runs against PostgreSQL. It drives
  GitHub sign-in through a fake GitHub and a passkey through a software authenticator. It also
  checks:
  - which pages each role may open;
  - the Origin and form-token checks;
  - tampered, idle and removed-member sessions;
  - what each step writes to the staff log.
- The pages were checked in light and dark, at desktop and phone widths. axe found no violations.

What is left before the console goes live:

- the owner's Phase 0 settings: the Access application, the console's own GitHub OAuth app, a
  Hyperdrive configuration for `slotlock_admin_app`, the Worker's secrets, and the first Owner from
  `slotlock staff add`;
- PRIVACY.md (staff access, GitHub profile lookups, how long the staff log is kept), posted 30 days
  before it takes effect, as the notice itself promises;
- the independent security review, recorded on the pull request.

SECURITY.md already describes the console.

**Where Phase 2 stands.** Support actions are built and tested. Its done-when holds, end to end:
a suspension made in the console shows in the customer's dashboard and audit log, and in the
staff log.

- **The roles.** Two capabilities: `accounts.act` (end sessions, revoke keys, notes) and
  `safety.act` (suspend, lift a suspension, cases). The Owner and Support have both, as 4.3 says.
  An action needs a passkey in the last 15 minutes. Past that, the console asks for the passkey
  and sends the person back to the page.
- **The functions.** Each action is an admin function:
  - `admin_suspend` and `admin_unsuspend`;
  - `admin_revoke_key`;
  - `admin_account_sessions` and `admin_end_sessions`;
  - `admin_account_notes` and `admin_add_note`;
  - `admin_case_open`, `admin_case_update`, `admin_cases` and `admin_case`.
- **The reason.** Each action takes one, of 1 to 200 bytes on one line. The function writes it to
  the staff log and, as "Slotlock staff (<role>)", to the account's own audit log (E8), in the same
  transaction. A suspension can also carry a message for the customer, which their dashboard
  shows on every page while it lasts (`slotlock.tenant_suspension_notice`). The internal reason
  is never shown there.
- **What staff see of sessions.** They see when each session began and was last seen, never the
  address or browser.
- **What the log holds of notes.** The staff log records that a note was added, never its text.
- **Cases (M6).** A case records:
  - where it came from;
  - the Acceptable Use Policy section;
  - the evidence;
  - what was done and the outcome.

  Its history is the staff log's events about it. A suspension linked to a case records itself on
  the case.
- **The CLI.** `slotlock tenant suspend` and `unsuspend` write `cli:<user>` to the staff log in the
  same transaction, and to the customer's audit log as "Slotlock staff (operator)". So do
  `slotlock plan default` and, when `SLOTLOCK_MIGRATE_DATABASE_URL` is set, `slotlock tenant
  erase`.
- **Requests.** Every action is a form POST, with the Origin and session token checked. It
  answers with a redirect to the page it came from, so a reload never sends it twice. Each
  function is idempotent: a second suspension or revocation changes nothing and says so. No
  separate single-use nonce is kept.

Left for later phases:

- suspending a partner with all its accounts (M6);
- the members and invitations of a team on its page (M3);
- what erasure does with an account's notes and cases, decided with the erasure checklist in
  Phase 5. Until then both are kept, like the staff log.

The database keeps no GitHub login or email for a person, only the numeric id, and that does not
change. The console reads logins from GitHub's public profile API when it shows or searches an
account, and caches them for an hour. PRIVACY.md says so before the console goes live.

## Part 8: Non-goals and risks

**Not in this RFC**

- Rebuilding Stripe's dashboard: refunds, disputes and invoices stay in Stripe.
- "Sign in as the customer": break-glass shows data and never acts as the customer.
- Marketing email.
- Editing the landing page or the product pages' words in the CMS: they stay in code, reviewed,
  with their facts read from the repository.
- A WYSIWYG editor: Markdown with a live preview is enough.

**Risks**

- **Scope.** Twelve modules is a lot; the phases are ordered so each one is useful if the next
  never comes.
- **Privacy drift.** A staff tool tends to grow until it shows everything. The function-per-view
  rule, the column test and the customer-visible log are the brakes.
- **A single maintainer.** Four-eyes actions need a second person. Until there is one, the second
  approval comes from the independent reviewer named in GOVERNANCE.md, and is recorded the same
  way.
