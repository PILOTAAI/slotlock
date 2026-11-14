# Privacy notice for hosted Slotlock

Last updated: 14 November 2026.

What it says about our staff console, and about the privacy requests our staff handle there (in
"What we hold", "How our staff see your account", "Why we use it, and our lawful basis" and "Your
rights"), takes effect on 14 November 2026.

This notice covers hosted Slotlock (Slotlock Cloud): the API at `https://slotlock-api.pylota.io`
(MCP, A2A and REST) and the dashboard at `https://app.slotlock.pylota.io`. Any GitHub or Google
account can sign in. It does not cover Slotlock you run yourself: the open-source package sends nothing to us,
and whoever runs it is responsible for the data in it. It does not cover the Pylota app or
pylota.io, which have their own notices.

## Who we are

Hosted Slotlock is run by TREFT LTD, trading as Pylota, a company registered in England and Wales
(number 16211391), registered office 20 Wenlock Road, London, England, N1 7GU. For anything about
your data, write to [privacy@pylota.io](mailto:privacy@pylota.io). We have not appointed a data
protection officer.

## Two roles

- **Your account.** For the details of your account and how you use the service, we are the
  controller: we decide why and how they are processed.
- **Your calendars.** What you, your agents and your integrations store in Slotlock (resources,
  bookings, events, contacts, busy time from your other calendars, and the people named in them) is
  yours. For that content we are your processor: we process it only to run the service for you,
  under the data processing terms in the [Terms of Service](TERMS.md#data-processing-terms). If it
  names other people, such as attendees' names and email addresses, or your customers' contact
  details, you are their controller: you tell them how their data is used, and you record on which
  channels they agreed to be told about their bookings.

## What we hold

| Data | Where it comes from | Kept |
| --- | --- | --- |
| Your GitHub user id, which names your account (`github:<id>`) | GitHub, when you sign in to the dashboard | While your account exists |
| Your GitHub login | GitHub, when you sign in | Only in your session cookie, never in the database, unless team workspaces are offered (below) |
| If you sign in with Google: your Google account's id, which names your account (`google:<id>`), and its email address once Google has verified it | Google, when you sign in | The id while your account exists; the email only in your session cookie, never in the database, unless team workspaces are offered (below) |
| Once teams are offered: the GitHub organizations you are an owner or member of (up to 20: their ids, logins and your role) | GitHub, when you sign in | Only in your session cookie, never in the database |
| Once teams are offered: each organization turned on for Slotlock, by its GitHub id and login, whether it is on, and the GitHub user id of the owner who last turned it on or off, and when | An owner of the organization, on the Teams page | Until the organization's account is erased |
| When you last signed in to the dashboard, and the number your sessions carry so that **Sign out everywhere** can end them all | The service, when you sign in | While your account exists |
| Each dashboard session: a SHA-256 digest of its id (never the id itself), when it began, when it was last used (to five minutes), when it ends, and the browser and internet address it began from, listed on your Account page | The service, when you sign in and as you use the dashboard | Until a day after the session ends, expires or is signed out, then deleted; at once when your account is erased |
| Once teams are offered: your membership of each organization or team workspace (your role in it, whether it is active, where it came from, and when it began and last changed) | GitHub, when you sign in, an invitation you accept, or the workspace's owners and admins | Until the workspace's account or yours is erased; an ended membership is kept so that being added back restores your role |
| Once team workspaces are offered: your GitHub login, or your Google account's email once Google has verified it, to show you to the members of your team workspaces, and to our staff in their console (below) | GitHub or Google, when you sign in | While your account exists, replaced at each sign-in; erased with your account |
| From 14 November 2026, once team workspaces are offered: the name on your GitHub profile or your Google account, if you gave one there (up to 80 characters, without invisible, control or text-direction characters), so our staff can tell accounts apart in their console. Never shown to anyone else, and never your profile picture | GitHub or Google, when you sign in | While your account exists, replaced at each sign-in, and removed at your next sign-in once you remove it there; erased with your account |
| Once team workspaces are offered: each team workspace's name and handle, when it was created, and the account that created it | The person who creates it | Until the team's account is erased; the creator's account id until that account is erased |
| Once team workspaces are offered: invitations to a team workspace: the email address invited, the role offered, who invited and when, when it expires, and a SHA-256 digest of the link's token (never the link itself) | A member of the team who invites you | Until 30 days after it is accepted, withdrawn or expires, then deleted; at once when the team's account, or the inviter's or accepter's, is erased. The email that carries an invitation is kept by Resend for 30 days (Who else processes it) |
| Once team workspaces are offered, to accept an invitation sent to an email address while signed in with GitHub: the addresses GitHub has verified for your account, read once, of which only the invited one is kept | GitHub, when you confirm the address | Only in your session cookie, never in the database, until you join |
| Once verified domains are offered: a team's claim on a domain: the domain, its DNS verification token, who added it and when, and each check's result (the DNS answer, which is public) | A team's owner; public DNS | Until 90 days after the claim ends (released, lapsed, or never verified); its record in the audit log as that log keeps it; at once when the team is erased. Erasing the person who added it removes their name from it |
| Once verified domains are offered, to find or join a team at your domain: your verified address there, how it was verified (a Google Workspace account, or Google or GitHub), and your request to join (the team, when, and who decided) | You, and Google or GitHub, which verified the address | The address in your session cookie only while you look; a request until 30 days after it is decided or expires, then deleted; at once when you or the team are erased |
| Once verified domains are offered: a SHA-256 digest of an address a team removed or declined, so it asks again rather than joining at once | The team's owners and admins, by removing or declining | A year, or until a request from it is approved, or the team is erased; it names no account, so it stays when one is erased |
| Once single sign-on is offered: a team's connection to its identity provider (the provider's URLs, its client ID, its client secret sealed with AES-256-GCM and its last four characters, who set it up) and what its last test sign-in returned (subject, email, groups; never a token) | The team's owners | Until the connection is deleted or the team is erased; what a test returned, until the owner who ran it is erased |
| Once single sign-on is offered: who you are at your team's identity provider (its subject; with Microsoft Entra, the tenant and object id) and the email it last sent, linked to your Slotlock account, and when each of your sessions last signed in through it | Your team's identity provider, when you sign in through it | Until you or the team are erased, or the team deletes the connection; a session's record goes with the session. If you sign in only through your team's provider, your Slotlock account is erased with the team, or when it deletes the connection |
| Once SCIM is offered: what your team's identity provider sends about you (your user name, name, work email and the provider's id for you, whether you are active, and your groups), linked to your Slotlock account when you sign in with that address; and the team's SCIM tokens (their SHA-256, who made them, when last used) | Your team's identity provider; the team's owners | Until the provider deletes you or the team is erased; your link to it, until you are erased |
| The audit log of each workspace (each event chained to the one before by a SHA-256 hash, so changes show): who (an account id or a key id, never a name or an email) created, rotated or revoked a key, changed a webhook, the plan, billing or the assistant's model, forgot a contact, signed in or out everywhere, or was refused, when, and the internet address and browser it came from | The service, as it happens | 180 days (400 days on the Team plan), or until the workspace's account is erased. A team's log keeps its events by people its identity provider signed in (an account id, internet address and browser) for as long, even once those people are erased, so the team's record stays whole |
| Your API keys: name, scopes, expiry, the first characters and a SHA-256 digest of each key (never the key itself), who created it (a GitHub user id), and when it was created, last used and revoked | You, in the dashboard or the API | While your account exists; a revoked or expired key stays listed until your account is erased |
| Calendar content: resources with their names, descriptions, labels, the attributes you give them, time zones, weekly hours, booking rules and pools, and the locations and groups you put them in, with their names; holds, bookings and waitlist entries with their times, references and the holder names your agents give; events with their titles, descriptions, locations, organisers, attendees' names and email addresses, reminders and recurrence; and the outside calendars you record coverage from, by the source name you give (which can be a calendar address) with the last error reported for it | You and your agents | While your account exists, or until you delete it. Holds end when they expire and are then deleted; finished waitlist entries are deleted 30 days after their window |
| Contacts, if you keep them: each person's reference, name, email address, phone and WhatsApp numbers and language; whether they agreed to be told by email, SMS or WhatsApp, and when each agreement was given or withdrawn; and on each booking, the contact it is for, whether to tell them, and its reminders | You and your systems, through the API or the dashboard's Contacts page | Until you delete the contact, which also takes it off every booking, or your account is erased. Changes and webhooks name a contact only by its reference, never its details |
| Busy time from your other calendars: when each busy period starts and ends, never its title, description or attendees, for the resources you link a calendar to, by the source you name | You or an integration you run (such as `@slotlock/sync`), through the API | 30 days after the period ends, then deleted; at once when you retire the source or your account is erased |
| Payments for holds that wait for one: the amount the hold asks, the payment's reference at your payment provider (a Stripe PaymentIntent id, say), the amount received and when, and whether the hold was booked. Never card or bank details, nor who paid | You or an integration you run (such as `@slotlock/payments-stripe`), through the API | Until the resource is deleted or your account is erased |
| A record of each reminder put on your change feed (its booking or event and when it was due), so it is said once | The service | Until the booking or event is deleted |
| Webhooks: each endpoint's address, its signing secret, the change types it receives, and its delivery state and last error | You | While your account exists, or until you delete the endpoint |
| Activity history: each change to your resources, holds, bookings, events, coverage and waitlist, with ids, times, references, which key or GitHub user made it and through which interface. It never holds titles, descriptions or attendees | The service | 30 days on the Free plan, 90 days on Developer and 400 days on Team. The server cannot change or delete an entry: entries go only when that time has passed, when you erase a person from them (their references are then replaced), or when your account is erased |
| A record of each event write, so a retried request returns the first result | The service | 30 days |
| Exports of your account that you ask for: a copy of everything in it at one moment, each table's rows without secrets | You, through the API or the dashboard; or our staff, for your privacy request | 24 hours after it is ready (or after you asked, if it never is), 7 days for one made for your privacy request, then deleted; at once when you delete it or your account is erased |
| The references of cancelled bookings, so a delayed retry never books one again; an agent's cancelled events | The service | Booking references until your account is erased; an agent's cancelled events 30 days after cancellation |
| Records of finished sign-ins, signed-out sessions and sent dashboard forms, as digests | The service | Until they expire, within 12 hours, and are then deleted as new ones are written |
| Your dashboard session, in a cookie | The service | 12 hours |
| The sign-in in progress, in a cookie | The service | 10 minutes |
| Dashboard assistant settings, if the dashboard offers the assistant and you set it up: the provider, its address, the model, and your provider key, stored only encrypted (AES-256-GCM) with its last four characters to show; and your conversations with it, each titled by its first message | You | Settings while your account exists or until you remove them; each conversation until the person who had it deletes it or the account is erased, at most 100 per person (past that, the least recently used is deleted) |
| Your plan: which plan, its status and renewal date (or, once you cancel it, the date it ends, and whether it is in a trial), and the Stripe customer and subscription ids that link your account to its purchase. Your name, email, billing address, tax id and payment details go to Stripe directly and never reach us | The service and Stripe, if you upgrade | While your account exists |
| How much your account uses the service: for each day (UTC), how many operations your keys and the dashboard assistant ran, how many bookings and holds you made, how many changes your webhooks accepted, how many messages were sent to the assistant, and how many resources you held, by API key and by interface (MCP, A2A, REST, the assistant), and which notices of a monthly allowance used (80%, 100%) your account was sent this month. Counts only: never what was asked or answered | The service | 400 days, then deleted; the notices, until the next month's first |
| Connection details at Cloudflare: IP addresses, request times, paths and headers | Your browser or client, through Cloudflare | Cloudflare's dashboard request logs: at most 7 days |
| Connection details at our server: IP address, time, path and user agent of each API request, in the log of the proxy in front of it | Your client, through Cloudflare | One file of at most 10 MB, overwritten as it fills |
| The API server's own logs | The service | See below |
| Backups of the whole database, encrypted | The service | About five weeks: four weekly full backups and the changes between them |
| From 14 November 2026, the staff log: each time one of our staff signs in to the staff console, opens an account's page, searches for an account, or acts on an account, with your account's id and the reason given, never your calendar content. A search by name, login or email is logged only as a digest keyed with a secret of ours, never as the words searched for | The service | Six years, then deleted. It is kept when your account is erased |
| From 14 November 2026, our staff's internal notes about your account | Our staff | Until your account is erased |
| From 14 November 2026, abuse cases: a report to abuse@ or what our staff saw, the section of the Acceptable Use Policy, the evidence, what was done and how it ended, with your account's id | A reporter, our staff | Six years after the case is closed, then deleted. Once your account is erased, a case stays without its link to your account |
| From 14 November 2026, your privacy requests: your account's id, what you asked for, when it arrived, where it is in our privacy mailbox, the word we sent you, the key that showed it was you, and which of our staff handled each step. Never your email address, which stays in the mailbox (below) | You, our staff | Six years after the request is closed, then deleted. Once your account is erased, the request keeps only a digest of its id |
| From 14 November 2026, what our staff show on your dashboard: announcements to every account or to your plan's accounts (planned maintenance, a change to Slotlock, an incident), and a notice to your account alone, with your account's id, the text, an optional link, when it shows and who wrote it | Our staff | A year after it ends or is ended, then deleted; a notice to your account alone, at once when your account is erased |
| From 14 November 2026, a feature our staff turned on or off for your account (the assistant, or creating team workspaces), with your account's id, the reason and who did it | Our staff | Until they take it away, or your account is erased |
| From 14 November 2026, when our hourly maintenance of your account last failed: your account's id, when it first and last failed, how many times, and the error's class, code and first line, cut at its first quotation mark. Never your calendar content | The service | Until maintenance runs for your account again, and at most 30 days after it last failed; at once when your account is erased |
| From 14 November 2026, an erasure's receipt: the request, a digest of your account's id (SHA-256 with a secret of ours), how many rows were erased, which of our staff asked, approved and erased, and when. The receipt itself names your account only by that digest; the staff log (above) keeps its own record of each step, with your account's id, for its six years | The service | Six years, then deleted |
| From 14 November 2026, a payment of yours that failed, or a second subscription your account bought: your account's id, the Stripe invoice or subscription id, and the amount, currency, attempt count and next attempt Stripe reported. Never card or address details | Stripe, through its webhook | While your account exists |
| From 14 November 2026, a plan or limits our staff gave your account until a date: the plan, the limits and allowances, the reason given, and which of our staff gave, approved or ended it | Our staff | While your account exists |

The API server's logs record each call's operation and outcome, never its arguments or who made it.
For each minute in which the server refused requests, they also record how many it refused (over a
rate limit or a monthly allowance, while too busy, too large, or with a credential it did not
accept) and list the ten
clients refused most, each named only by a pseudonym: a hash of its IP address, keyed by a secret
held only in the running server's memory and replaced when it restarts. The server keeps a rotating
copy of these logs of at most 100 MB, and sends them to a log store we run on the same server, which
keeps them for 30 days and then deletes them.

Expired holds, finished waitlist entries, busy time that ended 30 days ago and the records kept for
30 days are deleted by a maintenance job that runs every hour for every account that has data,
whether or not its keys are in use.

Sign-in asks GitHub for no permissions beyond your public profile; once teams are offered, it also
asks to read which organizations you belong to (`read:org`), so you can work in the ones turned on.
GitHub's token is used once, to read your user id, login and profile name (and those organizations),
and is then dropped. Signing in with Google asks for your account's id, email address and name
(`openid email profile`); Google's tokens are not kept, nor anything else of your profile. The dashboard sets two cookies, both needed for
sign-in to work: `__Host-slotlock-oauth` for the ten minutes a sign-in takes, and
`__Host-slotlock-session` for your session. Both are secure, HTTP-only and limited to the dashboard's
own site. We use no analytics or advertising cookies, so there is nothing to consent to or turn off.

The website at `https://slotlock.pylota.io` counts visits with Cloudflare Web Analytics. It sets no
cookie and stores nothing in your browser; it records the page, the site that linked to it, the
browser, the country and how long the page took to load, and we see only totals. We use the totals
to learn which pages people read and how they find them. From 14 November 2026 our staff console
also reads, from Google Search Console and Bing Webmaster Tools, how often each page of the website
and each search showed in their results and was clicked: totals by page and by search, never who
searched.

If you write to us at support@, abuse@ or privacy@pylota.io, we keep what you send and our reply in
our mailboxes, hosted by Google Workspace, for two years and then delete them.

## How our staff see your account

From 14 November 2026, the people who run hosted Slotlock use a staff console of our own. Each of
them signs in through Cloudflare Access, with GitHub, and with a passkey, and our database checks
their role again on every page.

- **What they see:** your account's id, the name and login or email it is shown by, its plan and
  that plan's status, usage counts, the names, prefixes and dates of your keys, when your dashboard
  sessions began and were last used, and your audit log.
  Never your calendar content: no staff page shows a booking's or an event's title, description,
  attendees or contacts.
- **Names:** the console shows a person's account by the name, and the GitHub login or verified
  email, kept from their last sign-in (What we hold), and finds it by either; it never asks GitHub to
  name an account. Only when staff search for a GitHub login that the database does not hold (no one
  has signed in with it since 14 November 2026) does the console ask GitHub's public profile API
  which account id it is, and keep the answer in its memory for an hour.
- **Stripe:** for an account that pays, the console reads its subscriptions and last invoices from
  Stripe, with a key that can only read, and keeps what it read for an hour.
- **What they record:** every sign-in, every account page opened and every action is in the staff
  log. An action on your account (a suspension and its end, a revoked key, ended sessions, a plan
  or limits given until a date, a notice sent to you, a feature turned on or off for you) also goes
  into your account's own audit log, as "Slotlock staff" with the reason given, so you can see it.
- **What they tell you:** a line above every page of your dashboard, for planned maintenance, a
  change to Slotlock, an incident, or a notice to your account alone; and incidents on the status
  page, which are public GitHub issues labelled `status`. Never marketing, and never by email from
  the console.
- **How the service runs:** they see when maintenance of an account failed (as "What we hold"
  says), and how many webhook endpoints are failing across all accounts, as counts: no endpoint's
  address and no delivery's content.
- **Your privacy requests** are handled there: we check it is you as "Your rights" says, make your
  export for you, and erase your account in fixed steps, with a second member of staff approving
  each erasure. An export made for you waits on your dashboard's Privacy page for 7 days; staff see
  how many rows of each table it holds, never the rows.

## Why we use it, and our lawful basis

| Purpose | Data | Lawful basis (UK GDPR Article 6(1)) |
| --- | --- | --- |
| Running your account and the service you signed up for: storing your calendars, answering your agents, sending your webhooks, keeping your activity history | Account, keys, calendar content, contacts, busy time, payments for holds, reminder records, webhooks, history, write records, exports, sessions, assistant settings | (b) contract: the Terms of Service |
| Applying your plan: its limits, upgrading and managing it through Stripe | Account, plan | (b) contract: the Terms of Service |
| Team workspaces: showing members to each other, and inviting a person a member names | Login or verified email, memberships, invitations | (b) contract for members; (f) legitimate interests for an invitation: a member asked for it, it holds an address and a role only, and it is deleted 30 days after it ends; the email that carries it says only who invited, to which team, in which role, with the link, and Resend deletes it 30 days after it is sent |
| Verified domains: proving a team holds its domain, and letting the people at it ask to join | Domain claims, verified addresses, requests to join | (b) contract for the team's members; (f) legitimate interests for a request: the person asked to join, it holds the address they chose to use, and it is deleted 30 days after it is decided |
| Single sign-on: signing a team's members in through the team's own identity provider, as the team chose | Connection settings, identities at the provider, sign-in records | (b) contract with the team, which chose its provider; (f) legitimate interests for its members: the team requires it of them, and Slotlock keeps only the identifiers that sign them in |
| Measuring use: counting what each account uses (operations, bookings, holds, webhook deliveries, assistant messages, resources), to show you your usage and to apply your plan's allowances | Account, usage counts | (b) contract: the Terms of Service |
| Keeping the service secure and available: authenticating requests, rate limiting, stopping abuse, investigating faults, and restoring from backups | Account, keys, connection details, logs, backups | (f) legitimate interests: a service anyone with a GitHub account can use must be protected from misuse and recoverable after a failure, and the logs hold no request content |
| Answering you when you write to us | What you send | (b) contract, or (f) legitimate interests when you are not a user |
| Learning which pages of the website people read, and how they find them | Page views on `slotlock.pylota.io`, counted without cookies (above) | (f) legitimate interests: improving the website, with no way to tell who you are |
| Running the service day to day: support, billing, handling abuse reports, telling you about maintenance and changes, turning features on or off, finding failed maintenance, and recording what our staff do on accounts | Staff log, internal notes, abuse cases, announcements and notices, feature flags, maintenance failures, billing alerts (a payment that failed, a second subscription, a refund that left a plan running), plan overrides, and the name, login or email an account is shown by | (f) legitimate interests: our staff need to see and act on accounts to run the service, and a record of what they did protects you and us; the log holds no calendar content and is deleted after six years |
| Answering your privacy requests, and showing later that we did | Privacy requests, erasure receipts | (c) legal obligation: UK GDPR Articles 12 to 22, and 5(2), which asks us to be able to show it |
| Meeting a legal obligation, such as a lawful request from an authority | What the request covers | (c) legal obligation |

You do not have to give us any of this, but without a GitHub sign-in we cannot create an account,
and without calendar content there is nothing for the service to do. We make no decisions about you
by automated means that have legal or similarly significant effects, and we do no profiling. We do
not use your data for marketing, and we do not use your calendar content to train any model.

## Who else processes it

| Recipient | What for | Where |
| --- | --- | --- |
| OVHcloud | The server and database that hold all of the data above, and our log store | Its London (UK1) region, United Kingdom |
| Cloudflare, Inc. | DNS, TLS and the network path to the API, including the tunnel to our server; it serves the website and counts its visits (Web Analytics); it runs the dashboard and keeps its request logs, connects the dashboard to the database (Hyperdrive), and stores our encrypted backups (R2). From 14 November 2026 it also runs our staff console and checks who may reach it (Cloudflare Access): that is our staff's sign-in, not yours | Its global network; the dashboard is placed near the London server; backups in its European Union jurisdiction |
| GitHub, Inc. | Signs you in. GitHub is a separate controller of your GitHub account and learns that you signed in to Slotlock. From 14 November 2026 our staff console also reads a public GitHub profile when staff search for a login no account has signed in with since, to find its account id | United States |
| Google LLC (Google Workspace) | Hosts the support, abuse and privacy mailboxes, so it holds the email you send us | Its global data centres, including the United States |
| Resend | Since 12 November 2026, sends each team invitation by email: the invited address, the team's name, who invited, the role offered and the link. It keeps each message, link included, for 30 days and then deletes it; erasing an account here does not reach that copy | The United States |
| Stripe (the Stripe company named on your invoice) | Sells the Developer plan as merchant of record: takes the payment, calculates and pays sales tax or VAT, and issues invoices. We send it your account's id (`github:<id>`) with each purchase; Stripe is a separate controller of the purchase and keeps its records under [its own privacy policy](https://stripe.com/privacy) | Ireland, the United States and its other locations |

Our uptime monitor, healthchecks.io, receives only whether the service is up, how many errors it
served, and how much space the database and its disk use: no personal data.

If you set up the dashboard assistant with your own provider key, your messages and the calendar
data the assistant reads to answer them go to the provider you chose, under your own agreement with
it. That provider is not our subprocessor.

Hosted Slotlock sends no email, SMS or WhatsApp message to your contacts, holds no token for your
Google or Microsoft calendars or your payment provider, and moves no money for your bookings. If you run integrations
that do (such as `@slotlock/notify`, `@slotlock/sync` or `@slotlock/payments-stripe`), they read
from and write to Slotlock through the API like any client, and what they send to those providers
is under your own agreements with them. Those providers are not our subprocessors.

We do not sell personal data or share it for advertising. We disclose it to anyone else only when
the law requires us to.

## International transfers

The database and our logs are in the United Kingdom. Our backups are in the European Union, to which
UK law allows personal data to be transferred without further safeguards. Cloudflare's network can
process connection details and dashboard requests outside the United Kingdom, including in the
United States; Cloudflare's data processing agreement relies on its certification under the Data
Privacy Framework for transfers to the United States. Google Workspace, which holds the email you
send us, can also process it outside the United Kingdom; Google's data processing terms provide the
safeguards for those transfers. Resend, which sends team invitations, holds them in the United
States; its data processing agreement relies on its certification under the Data Privacy Framework,
with the UK Extension, and on the standard contractual clauses with the UK Addendum. Stripe receives
your account's id with each purchase, including in the United States, under the safeguards in its
own terms. Write to us for a copy of the safeguards.

## Security

Every account's data is kept apart in the database by PostgreSQL row-level security. API keys are
stored only as digests, assistant provider keys only encrypted, and backups only encrypted. Traffic
is encrypted in transit between you and Cloudflare and between Cloudflare and our server. No system
is perfectly secure: [SECURITY.md](SECURITY.md) says how to report a vulnerability.

## Your rights

You can ask us for a copy of your data, to correct it, to erase it, to restrict or object to how we
use it, and to have it in a portable form. Much of it you can read, change, export and delete
yourself through the API and the dashboard, and you can revoke keys yourself in the dashboard at any
time. `POST /v1/tenant/exports` makes a copy of everything in your account, read at one moment, as
JSON objects table by table, for you to download within 24 hours. If you ask us for a copy instead,
we check it is you as below and make the same copy, which waits on your dashboard's Privacy page for
7 days.

To erase your account and everything in it, write to [privacy@pylota.io](mailto:privacy@pylota.io)
naming your GitHub login. We reply with a word; sign in to the dashboard and create an API key with
that word as its name (for a team or an organization, as one of its Owners), which shows us the
account is yours. We then erase every resource, booking,
event, hold, payment record, waitlist entry, contact, busy period, webhook, export, history entry, assistant
setting, plan, usage count and key in the account, and in its test environment, in one step, with
our internal notes about it, and tell you when it is done. What stays: the digests of your erased keys, with nothing about
you, so those keys are never accepted again; a record that the account was suspended, with the reason we gave, if it was; log
lines until they age out as described above; the staff log's record of what our staff did, an
abuse case without its link to your account, and the erasure's receipt, for six years; and backups,
until they are replaced within about five weeks. A Developer plan is cancelled before the account is erased; Stripe keeps its own records of the
purchase, as its privacy policy says.

We answer every request within one month.

If your data is in someone else's Slotlock account, for example as an event attendee or one of
their contacts, that account holder is your controller: ask them first. If you cannot reach them, write to us and we will pass
your request on.

Account holders can answer such a request themselves. `POST /v1/subjects/export` (or
`slotlock subject export`) lists what their account keeps about one person, found by email
address, holder reference, contact reference or booking reference. `POST /v1/subjects/erase` (or
`slotlock subject erase`) takes the person out: their contact details, attendee entries and waitlist
entries are deleted, and their references in bookings, holds, cancelled bookings, approvals and the
activity history are replaced by a name that is no one's. The bookings themselves stay, as time
taken. Each erasure is recorded in the account's audit log, without the person.

If you are unhappy with how we handle your data, tell us first at
[privacy@pylota.io](mailto:privacy@pylota.io). You can also complain to the Information
Commissioner's Office at [ico.org.uk](https://ico.org.uk/make-a-complaint/).

## Children

Hosted Slotlock is a tool for businesses and developers, not a service for children. If you think a
child has an account, write to [privacy@pylota.io](mailto:privacy@pylota.io) and we will erase it.

## Changes

We will post any change to this notice here, with its date, at least 30 days before it takes effect,
unless it is needed sooner for legal or security reasons. We post a new subprocessor here at least
30 days before it starts.
