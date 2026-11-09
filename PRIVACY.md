# Privacy notice for hosted Slotlock

Last updated: 9 November 2026.

This notice covers hosted Slotlock (Slotlock Cloud): the API at `https://slotlock-api.pylota.io`
(MCP, A2A and REST) and the dashboard at `https://app.slotlock.pylota.io`. Any GitHub account can
sign in. It does not cover Slotlock you run yourself: the open-source package sends nothing to us,
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
- **Your calendars.** What you and your agents store in Slotlock (resources, bookings, events and
  the people named in them) is yours. For that content we are your processor: we process it only to
  run the service for you, under the data processing terms in the [Terms of Service](TERMS.md#data-processing-terms).
  If your events name other people, such as attendees' names and email addresses, you are their
  controller and you tell them how their data is used.

## What we hold

| Data | Where it comes from | Kept |
| --- | --- | --- |
| Your GitHub user id, which names your account (`github:<id>`) | GitHub, when you sign in to the dashboard | While your account exists |
| Your GitHub login | GitHub, when you sign in | Only in your session cookie, never in the database |
| Your API keys: name, scopes, expiry, the first characters and a SHA-256 digest of each key (never the key itself), who created it (a GitHub user id), and when it was created, last used and revoked | You, in the dashboard or the API | While your account exists; a revoked or expired key stays listed until your account is erased |
| Calendar content: resources with their names, time zones, weekly hours, booking rules and pools; holds, bookings and waitlist entries with their times, references and the holder names your agents give; events with their titles, descriptions, locations, organisers, attendees' names and email addresses, reminders and recurrence; and the outside calendars you record coverage from, by the source name you give (which can be a calendar address) with the last error reported for it | You and your agents | While your account exists, or until you delete it. Holds end when they expire and are then deleted; finished waitlist entries are deleted 30 days after their window |
| Webhooks: each endpoint's address, its signing secret, the change types it receives, and its delivery state and last error | You | While your account exists, or until you delete the endpoint |
| Activity history: each change to your resources, holds, bookings, events, coverage and waitlist, with ids, times, references, which key or GitHub user made it and through which interface. It never holds titles, descriptions or attendees | The service | 30 days |
| A record of each event write, so a retried request returns the first result | The service | 30 days |
| The references of cancelled bookings, so a delayed retry never books one again; an agent's cancelled events | The service | Booking references until your account is erased; an agent's cancelled events 30 days after cancellation |
| Records of finished sign-ins, signed-out sessions and sent dashboard forms, as digests | The service | Until they expire, within 12 hours, and are then deleted as new ones are written |
| Your dashboard session, in a cookie | The service | 12 hours |
| The sign-in in progress, in a cookie | The service | 10 minutes |
| Dashboard assistant settings, if the dashboard offers the assistant and you set it up: the provider, its address, the model, and your provider key, stored only encrypted (AES-256-GCM) with its last four characters to show; and your conversation with it | You | Settings while your account exists or until you remove them; a conversation 2 hours after its last message |
| Your plan: which plan, its status and renewal date, and the Stripe customer and subscription ids that link your account to its purchase. Your name, email, billing address, tax id and payment details go to Stripe directly and never reach us | The service and Stripe, if you upgrade | While your account exists |
| Connection details at Cloudflare: IP addresses, request times, paths and headers | Your browser or client, through Cloudflare | Cloudflare's dashboard request logs: at most 7 days |
| Connection details at our server: IP address, time, path and user agent of each API request, in the log of the proxy in front of it | Your client, through Cloudflare | One file of at most 10 MB, overwritten as it fills |
| The API server's own logs | The service | See below |
| Backups of the whole database, encrypted | The service | About five weeks: four weekly full backups and the changes between them |

The API server's logs record each call's operation and outcome, never its arguments or who made it.
For each minute in which the server refused requests, they also record how many it refused (over a
rate limit, while too busy, too large, or with a credential it did not accept) and list the ten
clients refused most, each named only by a pseudonym: a hash of its IP address, keyed by a secret
held only in the running server's memory and replaced when it restarts. The server keeps a rotating
copy of these logs of at most 100 MB, and sends them to a log store we run on the same server, which
keeps them for 30 days and then deletes them.

Expired holds, finished waitlist entries and the records kept for 30 days are deleted by a
maintenance job that runs every hour for every account that has data, whether or not its keys are
in use.

Sign-in asks GitHub for no permissions beyond your public profile. GitHub's token is used once, to
read your user id and login, and is then dropped. The dashboard sets two cookies, both needed for
sign-in to work: `__Host-slotlock-oauth` for the ten minutes a sign-in takes, and
`__Host-slotlock-session` for your session. Both are secure, HTTP-only and limited to the dashboard's
own site. We use no analytics or advertising cookies, so there is nothing to consent to or turn off.

If you write to us at support@, abuse@ or privacy@pylota.io, we keep what you send and our reply in
our mailboxes, hosted by Google Workspace, for two years and then delete them.

## Why we use it, and our lawful basis

| Purpose | Data | Lawful basis (UK GDPR Article 6(1)) |
| --- | --- | --- |
| Running your account and the service you signed up for: storing your calendars, answering your agents, sending your webhooks, keeping your activity history | Account, keys, calendar content, webhooks, history, write records, sessions, assistant settings | (b) contract: the Terms of Service |
| Applying your plan: its limits, upgrading and managing it through Stripe | Account, plan | (b) contract: the Terms of Service |
| Keeping the service secure and available: authenticating requests, rate limiting, stopping abuse, investigating faults, and restoring from backups | Account, keys, connection details, logs, backups | (f) legitimate interests: a service anyone with a GitHub account can use must be protected from misuse and recoverable after a failure, and the logs hold no request content |
| Answering you when you write to us | What you send | (b) contract, or (f) legitimate interests when you are not a user |
| Meeting a legal obligation, such as a lawful request from an authority | What the request covers | (c) legal obligation |

You do not have to give us any of this, but without a GitHub sign-in we cannot create an account,
and without calendar content there is nothing for the service to do. We make no decisions about you
by automated means that have legal or similarly significant effects, and we do no profiling. We do
not use your data for marketing, and we do not use your calendar content to train any model.

## Who else processes it

| Recipient | What for | Where |
| --- | --- | --- |
| OVHcloud | The server and database that hold all of the data above, and our log store | Its London (UK1) region, United Kingdom |
| Cloudflare, Inc. | DNS, TLS and the network path to the API, including the tunnel to our server; it runs the dashboard and keeps its request logs, connects the dashboard to the database (Hyperdrive), and stores our encrypted backups (R2) | Its global network; the dashboard is placed near the London server; backups in its European Union jurisdiction |
| GitHub, Inc. | Signs you in. GitHub is a separate controller of your GitHub account and learns that you signed in to Slotlock | United States |
| Google LLC (Google Workspace) | Hosts the support, abuse and privacy mailboxes, so it holds the email you send us | Its global data centres, including the United States |
| Stripe (the Stripe company named on your invoice) | Sells the Developer plan as merchant of record: takes the payment, calculates and pays sales tax or VAT, and issues invoices. We send it your account's id (`github:<id>`) with each purchase; Stripe is a separate controller of the purchase and keeps its records under [its own privacy policy](https://stripe.com/privacy) | Ireland, the United States and its other locations |

Our uptime monitor, healthchecks.io, receives only whether the service is up, how many errors it
served, and how much space the database and its disk use: no personal data.

If you set up the dashboard assistant with your own provider key, your messages and the calendar
data the assistant reads to answer them go to the provider you chose, under your own agreement with
it. That provider is not our subprocessor.

We do not sell personal data or share it for advertising. We disclose it to anyone else only when
the law requires us to.

## International transfers

The database and our logs are in the United Kingdom. Our backups are in the European Union, to which
UK law allows personal data to be transferred without further safeguards. Cloudflare's network can
process connection details and dashboard requests outside the United Kingdom, including in the
United States; Cloudflare's data processing agreement relies on its certification under the Data
Privacy Framework for transfers to the United States. Google Workspace, which holds the email you
send us, can also process it outside the United Kingdom; Google's data processing terms provide the
safeguards for those transfers. Stripe receives your account's id with each purchase, including in
the United States, under the safeguards in its own terms. Write to us for a copy of the safeguards.

## Security

Every account's data is kept apart in the database by PostgreSQL row-level security. API keys are
stored only as digests, assistant provider keys only encrypted, and backups only encrypted. Traffic
is encrypted in transit between you and Cloudflare and between Cloudflare and our server. No system
is perfectly secure: [SECURITY.md](SECURITY.md) says how to report a vulnerability.

## Your rights

You can ask us for a copy of your data, to correct it, to erase it, to restrict or object to how we
use it, and to have it in a portable form. Much of it you can read, change, export and delete
yourself through the API and the dashboard, and you can revoke keys yourself in the dashboard at any
time.

To erase your account and everything in it, write to [privacy@pylota.io](mailto:privacy@pylota.io)
naming your GitHub login. We reply with a word; sign in to the dashboard and create an API key with
that word as its name, which shows us the account is yours. We then erase every resource, booking,
event, hold, waitlist entry, webhook, history entry, assistant setting, plan and key in the account, in one
step, and tell you when it is done. What stays: the digests of your erased keys, with nothing about
you, so those keys are never accepted again; a record that the account was suspended, with the reason we gave, if it was; log
lines until they age out as described above; and backups, until they are replaced within about five
weeks. A Developer plan is cancelled before the account is erased; Stripe keeps its own records of the
purchase, as its privacy policy says.

We answer every request within one month.

If your data is in someone else's Slotlock account, for example as an event attendee, that account
holder is your controller: ask them first. If you cannot reach them, write to us and we will pass
your request on.

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
