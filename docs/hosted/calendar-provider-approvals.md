# Calendar provider approvals: Google and Microsoft

What hosted Slotlock needs before `@slotlock/sync` can connect people's Google and Microsoft
calendars on Cloud (RFC 0007, Part 1.3). Google reviews the app's sensitive scopes. Microsoft
verifies the app's publisher. Both take calendar time, not engineering time, so they start now.
Cloud turns each provider on when its approval lands, without a Slotlock release.

The console steps are the owner's: they need TREFT LTD's Google Cloud, Microsoft Entra and
Partner Center accounts. The repository changes are pull requests like any other.

## Status

| # | Item | Who | Status |
| --- | --- | --- | --- |
| B1 | Choose the sync's public hostname on Cloud | Owner | To do |
| B2 | Privacy notice: calendar access and Google's Limited Use statement | PR, owner merges | PILOTAAI/slotlock#247, takes effect 30 days after posting |
| B3 | A page of Slotlock's own before the provider's consent screen | PR to `packages/sync` (T2) | PILOTAAI/slotlock#246 (draft, waits for independent review) |
| B4 | Settle the Google scopes before submitting | Owner reads labels; PR to `packages/sync` | `calendar.events.owned` in PILOTAAI/slotlock#246; owner reads its label (G5) |
| B5 | The sync running at the redirect URI, for the demo video | Owner | To do |
| G1–G7 | Google: project, branding, scopes, client, verification | Owner | To do |
| M1–M8 | Microsoft: tenant, Partner One ID, app registration, publisher verification | Owner | To do |

## Before submitting

**B1. The sync's hostname.** Proposed: `sync.slotlock.pylota.io`. The redirect URI both providers
register is then `https://sync.slotlock.pylota.io/oauth/callback`, which is `SYNC_PUBLIC_URL`
plus `/oauth/callback`. Google requires it on a domain verified in Search Console. RFC 0005's
Phase 0 adds a Domain property for `pylota.io`, which covers every subdomain; check that it is in
place. Add a staging redirect URI too if the demo video is recorded on staging.

**B2. The privacy notice.** Google checks that the policy linked from the consent screen is on the
homepage's domain and says how the app accesses, uses, stores and shares Google user data. That
policy is `https://slotlock.pylota.io/docs/privacy/`, published from PRIVACY.md. Draft text is in
D1 and D2 below. It can go live now, worded "From <date>", 30 days before Cloud runs the sync.

**B3. A page before the consent screen.** Today the sync's `/connect` link sends the person
straight to Google or Microsoft. Google's Workspace developer policy asks for a disclosure in the
app itself before consent, and the review follows the flow in the demo video. The link should
first show a page that says what Slotlock will read and write, links the privacy notice, and has
a "Continue to Google" (or Microsoft) button. Draft text is in D3. The change is in
`packages/sync/src/http.ts`, a T2 path, so it needs the independent review.

**B4. The Google scopes.** Changing scopes after verification means verifying again, so settle
them first. RFC 0007 Part 1.3:
- **Reading:** `calendar.calendarlist.readonly` and `calendar.freebusy`, as built.
- **Writing back:** `calendar.events.owned`, which reaches only calendars the person owns, in place
  of today's `calendar.events`. Read its label in G5 first.
- **If `calendar.events.owned` is adopted:** `packages/sync/src/oauth.ts` changes, and calendars
  the person can edit but does not own appear as read only on the choose page.
- **If it is not:** keep `calendar.events` and give the justification in D4.

**B5. A running sync for the video.** Google needs a video of the real flow: the consent screen
with the production client, then the features each scope serves. The sync must answer at the
redirect URI. Staging is fine, using the production client with a staging redirect URI. Running
it for customers on Cloud still waits for its independent review.

## Google

All in the Google Cloud Console, as a project owner.

**G1. A project of its own.** Create `slotlock-calendar-sync` under TREFT LTD's organization and
billing account, apart from the project that holds Google sign-in. Its 100-user limit before
verification lasts the project's whole life, and its review stays apart from sign-in. Enable the
Google Calendar API.

**G2. A testing project.** Create `slotlock-calendar-sync-test` and leave it in Testing for
development. Testing projects allow 100 test users, and their refresh tokens expire after 7 days.
Never use production's user count for tests.

**G3. Branding** (Google Auth Platform, Branding):

| Field | Value |
| --- | --- |
| App name | Slotlock |
| User support email | support@pylota.io |
| App logo | 120×120 px PNG, made from `site/public/brand/slotlock-512.png` |
| App home page | https://slotlock.pylota.io/ |
| Privacy policy | https://slotlock.pylota.io/docs/privacy/ |
| Terms of service | https://slotlock.pylota.io/docs/terms/ |
| Authorized domains | pylota.io |
| Developer contact | A TREFT address the owner reads; the review team writes to project owners and editors |

Then run "Verify branding". The automated check takes minutes, and a pass is valid for 7 days, so
submit G7 within that week.

**G4. Audience.** User type External. Publish to production when G7 is ready. Until verified,
people see the unverified-app warning and the project is limited to 100 users.

**G5. Data access.** Add the three scopes from B4 and record the label Google shows for each.
Every Calendar scope is expected to be sensitive, and none restricted, so no CASA assessment.

**G6. The client** (Clients, Create client):
- Type Web application, named "Slotlock calendar sync".
- Authorized redirect URIs: the production callback (B1), plus staging if used. No JavaScript
  origins.
- Do not tick "Use this client for an AI-powered agent": the sync calls Google's REST API, not an
  MCP server.
- Put the ID and secret in the sync's secrets as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`,
  never in the repository.

**G7. Verification** (Verification Center, Prepare for verification):
- Scope justifications, from D4.
- The demo video's URL: unlisted on YouTube, recorded from the script in D5.
- Submit.

Google says sensitive-scope review "can take up to 10 days", and longer waits are reported. It
writes by email to the project's owners and editors. If it stalls, Cronofy, which has a UK data
centre, is RFC 0007's contingency for Cloud.

## Microsoft

There is no review queue: publisher verification completes once its requirements are met. The
long step is the partner enrolment (M2).

**M1. A Microsoft tenant with `pylota.io`.** The app must be registered with a work account in an
Entra tenant, not a personal Microsoft account. TREFT's mail is on Google Workspace, so it may have
no Microsoft tenant yet; create one if so (it is free). Add `pylota.io` as a custom domain and
verify it with the DNS TXT record Microsoft gives, in Cloudflare. `*.onmicrosoft.com` cannot be a
publisher domain.

**M2. Partner One ID.** Enrol TREFT LTD in the Microsoft AI Cloud Partner Program with a work
account on `pylota.io`:
- legal name TREFT LTD;
- company number 16211391;
- registered office 20 Wenlock Road, London, England, N1 7GU.

Microsoft verifies the company, which can take days. Record the **global** Partner One ID:
publisher verification does not accept a location ID. There is no fee.

**M3. App registration** (Entra admin center, App registrations, New registration):
- Name: Slotlock.
- Supported account types: accounts in any organizational directory and personal Microsoft
  accounts. The sync's `MICROSOFT_DIRECTORY` stays `common`.
- Redirect URI, platform Web: the production callback (B1), plus staging if used.

**M4. API permissions.** Microsoft Graph, delegated: `offline_access`, `User.Read`,
`Calendars.Read` and `Calendars.ReadWrite`, matching `packages/sync/src/oauth.ts`. No application
permissions.

**M5. Client secret.**
- An app open to personal accounts may hold at most two secrets: keep one live and use the second
  only while rotating.
- Set the longest expiry offered (24 months at most) and add a calendar reminder to rotate it.
- Store the Application (client) ID and the secret as `MICROSOFT_CLIENT_ID` and
  `MICROSOFT_CLIENT_SECRET`.

**M6. Branding and properties:**
- name, logo (215×215 px PNG), home page, terms and privacy URLs, as in G3;
- publisher domain `pylota.io`.

**M7. Publisher verification.** In Branding and properties, "Add Partner One ID to verify
publisher", and give the global ID from M2. It needs:
- the person doing it to be signed in with a work account in the tenant;
- a Partner Center role on that partner account that Microsoft's publisher-verification page
  lists.

It removes the "unverified" warning, and lets tenants that allow only verified publishers consent.

**M8. Admin consent for customers.** Microsoft's managed default consent policy, the default for
new tenants, keeps ordinary users from consenting to any `Calendars.*` permission, so an
organization's admin approves Slotlock once. The dashboard's Calendars page (RFC 0007, Part 1.2)
will offer the link. Its expected form, to confirm in testing:
`https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=<client id>&scope=https://graph.microsoft.com/.default&redirect_uri=<callback>&state=<state>`.
People with personal Outlook.com accounts consent for themselves.

## Drafts

### D1. Privacy notice: connected calendars

For PRIVACY.md's "What we hold" table and its recipients section; counsel and the owner adjust:

> **Calendars you connect** (from <date>). If you connect a Google or Microsoft calendar:
> - the account's email address and the names and ids of its calendars;
> - an access token and a refresh token, stored only encrypted;
> - the busy times of the calendars you choose, as start and end times only, never titles,
>   descriptions, locations or attendees;
> - if you turn on writing back, the ids of the events we write to that calendar for your
>   bookings. Those events carry the booking's times under the title "Busy".
>
> Busy times block bookings on the resource you chose. They are shown, as free and busy time, to
> you and to the applications and AI agents you give access to your Slotlock account. We keep
> them while the calendar is connected and delete them, with its tokens, when you disconnect it or
> your account is erased. When you disconnect a Google calendar we also revoke its token with
> Google; Microsoft gives apps no such call, so for a Microsoft account you can remove Slotlock's
> access in your account's app permissions. Google and Microsoft are your own providers, not our
> processors.

### D2. Google's Limited Use statement

On the privacy page, in Google's words:

> Slotlock's use and transfer to any other app of information received from Google APIs will
> adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
> including the Limited Use requirements.

Under that policy, Slotlock uses calendar data only to provide the features described here. It
never uses it for advertising, never sells it, never uses it to train AI models, and lets no person
read it, except with the user's consent, for security, or as the law requires.

### D3. The page before the consent screen (B3)

> **Connect your Google calendar to Slotlock**
>
> Slotlock will read when your chosen calendars are busy, so it does not book you at times you are
> already taken. It reads start and end times only, never what your events are about. If you turn
> on writing back, Slotlock adds your bookings to your calendar as "Busy". You choose which
> calendars count on the next page, and you can disconnect at any time.
> [How Slotlock uses calendar data](https://slotlock.pylota.io/docs/privacy/)
>
> [Continue to Google]

### D4. Scope justifications (G7)

| Scope | Justification |
| --- | --- |
| `calendar.calendarlist.readonly` | Lists the user's calendars so they can choose which ones count as busy and which one receives bookings. Without it, Slotlock cannot offer the choice; it never reads events through it |
| `calendar.freebusy` | Reads only when the chosen calendars are busy, so Slotlock refuses bookings at those times. It is the narrowest scope that gives busy time; no event details are read |
| `calendar.events.owned` (or `calendar.events`) | Only when the user turns on writing back: Slotlock adds each confirmed booking to the user's chosen calendar as an event titled "Busy", moves it when the booking moves, and deletes it when the booking is cancelled. `calendar.events.owned` limits this to calendars the user owns. If it is not used, `calendar.events` is needed because bookings are written to a calendar the user chose, which may be any calendar they can edit |

### D5. Demo video script (G7)

Record in English, at a resolution where the URL bar can be read, showing the production client
ID in the consent screen's URL:
1. The Slotlock dashboard: a resource, and the Calendars page with "Connect Google calendar". Until
   that page exists (RFC 0007, Part 1.2), open a connect link the sync's operator API made.
2. The page of B3, then Continue.
3. Google's consent screen in full: app name, the scopes, the privacy and terms links.
4. Back in Slotlock: choosing calendars for the resource, and turning on writing back.
5. **`calendar.freebusy`:** an event in Google Calendar, then Slotlock refusing a booking at that
   time and showing it busy in free/busy.
6. **The write scope:** a booking made in Slotlock appearing in Google Calendar as "Busy", then
   moved and cancelled.
7. Disconnecting: the written event removed and access revoked (Google Account, Third-party
   access).

## Sources

Google: [verification requirements](https://support.google.com/cloud/answer/13464321),
[sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification),
[branding](https://support.google.com/cloud/answer/15549049),
[unverified apps](https://support.google.com/cloud/answer/15549945),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth),
[Workspace developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy),
[API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).
Microsoft: [publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview),
[consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies),
[account-type limits](https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation).
Code: `packages/sync/src/oauth.ts` and `packages/sync/src/http.ts` at `f7fd421`. All read
2026-11-10 to 2026-11-18.
