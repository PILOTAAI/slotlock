# Terms of Service for hosted Slotlock

Last updated: 10 November 2026.

These terms are an agreement between you and TREFT LTD, trading as Pylota (company number 16211391,
registered office 20 Wenlock Road, London, England, N1 7GU), for hosted Slotlock: the API at
`https://slotlock-api.pylota.io` (MCP, A2A and REST) and the dashboard at
`https://app.slotlock.pylota.io`. By signing
in or calling the API, you accept them. If you use the service for an organisation, you accept them
for it and confirm you may.

The Slotlock software is open source under the Apache License 2.0. These terms do not cover running
it yourself, and nothing here limits your rights under that licence.

## The service

- Hosted Slotlock has a Free plan and paid Developer and Team plans, described under
  [Plans and payment](#plans-and-payment). On every plan it is provided on a best-effort basis,
  with no service level agreement: it may be slow, unavailable or changed without notice, and it
  may lose data. Keep your own records of anything you cannot afford to lose.
- It runs a released version of Slotlock. Its REST API follows the stability and deprecation
  policy in [VERSIONING.md](VERSIONING.md). Writes take effect at once: hosted Slotlock does not
  ask a person to confirm them.
- Its limits are published on the [hosted service page](docs/hosted/README.md). We may change
  them, and we may slow or refuse requests that exceed them.
- We may end the service. We will give at least 30 days' notice on the hosted service page and the
  status page, during which you can read your data through the API.

## Plans and payment

- **Free** costs nothing and has the limits shown on the [hosted service page](docs/hosted/README.md#plans).
  Accounts created before 9 November 2026 move to those limits on 9 December 2026.
- From 10 December 2026, each plan also allows a number of operations (calls to the API, the
  assistant's included) and bookings each calendar month, shown on the
  [hosted service page](docs/hosted/README.md#monthly-allowances). We tell you in your account's
  change feed and on the Plan page when you have used 80% and 100% of either. On Free, calls past an
  allowance are refused until the month ends; on Developer and Team, calls past 110% of it are. Use
  past an allowance is never charged for.
- **Developer** costs $10 a month or $100 a year, shown at checkout in your currency with any sales
  tax or VAT added. Stripe sells it to you as merchant of record: Stripe takes the payment, charges
  the tax and issues the invoices, under its own terms for buyers, which it shows at checkout. These
  terms cover the service itself.
- **Team** is for a shared workspace: a team workspace, or a GitHub organization that an owner has
  turned Slotlock on for. It costs $40 a month or $400 a year for the whole workspace, however many
  people use it, and is bought, sold and taxed as Developer is. Only the workspace's Owners and
  Billing managers can buy, change or cancel it. If Slotlock is turned off for an organization, its
  plan continues until it is cancelled. On Free, a team workspace has up to 3 people, open
  invitations included, and each person may create one.
- A Developer or Team plan renews at the end of each period until you cancel it, which you can do at any
  time from **Manage billing** on the dashboard's Plan page. It then runs to the end of the period
  already paid for. Payments are not refunded for part of a period, except where the law gives you
  a right to a refund or where we end the service.
- If a payment fails, Stripe tries again for a few weeks and the plan continues meanwhile; if it is
  still not paid, the account returns to Free. When an account returns to Free nothing is deleted,
  but nothing more can be added while it holds more than Free allows.
- We will give at least 30 days' notice of a new price before it applies to your next renewal, and
  of any lower limit on a plan before it applies to you. If we end the service, we refund the unused
  part of any period already paid for.
- **Custom**, Slotlock run on your own infrastructure with our support, is agreed separately in
  writing.

## Your account

- Any GitHub account can sign in. Your account is your GitHub user, and it holds one Slotlock
  account; keep that GitHub account secure.
- You are responsible for the API keys you create and for everything done with them. Give each
  agent its own key with the narrowest scope it needs, and revoke a key you no longer trust.
- You must follow the [Acceptable Use Policy](ACCEPTABLE-USE.md), which is part of these terms.
- **Team workspaces.** A team workspace belongs to its Owners, who are responsible for it as for an
  account: who they invite, the role each person has, and what members do in it. Invite only people
  who expect it, at an address they gave you. Members of a workspace see each other's GitHub login
  or Google email, their roles, and the workspace's audit log as their role allows. When someone
  leaves or is removed, what they made in the workspace stays the workspace's.

## Your content

What you and your agents store (resources, bookings, events and everything in them) stays yours.
You give us permission to store and process it only to run the service for you. You confirm you
have the right to store it, including any personal data of other people in it, and that you have
told those people what they need to know.

## Data processing terms

For personal data in your content, you are the controller and we are your processor. These terms
are the contract UK GDPR Article 28(3) requires.

- **Subject matter and duration:** hosting your content in hosted Slotlock, for as long as your
  account exists.
- **Nature and purpose:** storing, reading, expanding and checking calendar data so the service can
  answer your requests, sending your changes to the webhooks you set up, keeping the history and
  backups the [privacy notice](PRIVACY.md#what-we-hold) describes, and nothing else.
- **Types of personal data:** whatever you put in your content, typically names, email addresses,
  and the times, places and descriptions of bookings and events, the holder names and references
  your agents give, and the addresses of the calendars and webhooks you set up.
- **Categories of data subjects:** the people your content is about, such as your staff,
  customers and event attendees.

We will:

1. process that data only on your documented instructions, which are these terms and your use of
   the service, including any transfer of it outside the United Kingdom (the
   [privacy notice](PRIVACY.md#international-transfers) says which transfers the service makes),
   unless the law requires otherwise, in which case we will tell you first unless the law forbids
   it;
2. make sure everyone who can access it is bound to confidentiality;
3. keep it secure, as described in [SECURITY.md](SECURITY.md): every tenant's data is kept apart by
   PostgreSQL row-level security, API keys are stored only as digests, backups are encrypted, and
   traffic is encrypted in transit;
4. use only the subprocessors named in the [privacy notice](PRIVACY.md#who-else-processes-it),
   bind each to data protection terms that match these, and remain responsible for them. We will
   post any new subprocessor on the privacy notice at least 30 days before it starts; if you object,
   you may close your account and have your data erased;
5. help you answer requests from the people your content is about: you can read and change your
   content, and cancel or delete events and bookings, through the API, and we erase anything else
   you ask us to;
6. help you meet your security, breach notification and impact assessment duties, and tell you
   without undue delay after we become aware of a personal data breach affecting your content;
7. erase your content when your account ends, or when you ask, unless the law requires us to keep
   it; copies in our backups are replaced within about five weeks; and
8. give you the information you need to show these terms are met, allow for and contribute to
   audits, including inspections, by you or an auditor you mandate, and tell you at once if we think
   an instruction of yours breaks data protection law.

If you set up the dashboard assistant with your own AI provider key, what you send it, and the
calendar data it reads to answer you, go to that provider under your own agreement with it. That
provider is not our subprocessor.

## Security research

You may test the security of hosted Slotlock only against your own account and only as
[SECURITY.md](SECURITY.md) describes: report what you find privately, and do not access other
people's data, degrade the service for others, or keep data you come across.

## Suspension and ending

You can stop using the service at any time and ask us to erase your account (see the
[privacy notice](PRIVACY.md#your-rights)). We may suspend keys or your account, or erase it, if you
break these terms, if your use puts the service or other users at risk, or if the law requires it.
Where we can, we will tell you first and give you a chance to fix the problem.

## Liability

The service is provided as it is, without warranties, to the extent the law allows. We are not
liable for loss of profit, revenue, business or data, or for any indirect loss. Our total liability
to you for anything arising from the service is limited to £100. Nothing in these terms limits
liability for death or personal injury caused by negligence, for fraud, or for anything else the
law does not allow to be limited.

## Changes and law

We may change these terms. We will post a change here with its date at least 30 days before it
takes effect, unless it is needed sooner for legal or security reasons. Using the service after a
change takes effect means you accept it.

These terms are governed by the law of England and Wales, and its courts have exclusive
jurisdiction.

## Contact

Questions about these terms: [support@pylota.io](mailto:support@pylota.io). Abuse:
[abuse@pylota.io](mailto:abuse@pylota.io). Privacy: [privacy@pylota.io](mailto:privacy@pylota.io).
Security vulnerabilities: GitHub private vulnerability reporting, as [SECURITY.md](SECURITY.md)
describes.
