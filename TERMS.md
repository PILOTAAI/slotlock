# Terms of Service for hosted Slotlock

> **Draft — requires owner and legal review before the hosted service opens.**

These terms are an agreement between you and TREFT LTD, trading as Pylota (company number 16211391,
registered office 20 Wenlock Road, London, England, N1 7GU), for hosted Slotlock: the API at
`https://slotlock-api.pylota.io` and the dashboard at `https://app.slotlock.pylota.io`. By signing
in or calling the API, you accept them. If you use the service for an organisation, you accept them
for it and confirm you may.

The Slotlock software is open source under the Apache License 2.0. These terms do not cover running
it yourself, and nothing here limits your rights under that licence.

## The service

- Hosted Slotlock is free while it is offered as a preview. It is provided on a best-effort basis,
  with no service level agreement: it may be slow, unavailable or changed without notice, and it
  may lose data. Keep your own records of anything you cannot afford to lose.
- It runs a released version of Slotlock. Its REST API follows the stability and deprecation
  policy in [VERSIONING.md](VERSIONING.md). Writes take effect at once: hosted Slotlock does not
  ask a person to confirm them.
- Its limits are published on the [hosted service page](docs/hosted/README.md). We may change
  them, and we may slow or refuse requests that exceed them.
- We may end the service. We will give at least 30 days' notice on the hosted service page and the
  status page, during which you can read your data through the API.

## Your account

- You sign in with GitHub. Your account is your GitHub user; keep that account secure.
- You are responsible for the API keys you create and for everything done with them. Give each
  agent its own key with the narrowest scope it needs, and revoke a key you no longer trust.
- You must follow the [Acceptable Use Policy](ACCEPTABLE-USE.md), which is part of these terms.

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
  answer your requests, and nothing else.
- **Types of personal data:** whatever you put in your content, typically names, email addresses,
  and the times, places and descriptions of bookings and events.
- **Categories of data subjects:** the people your content is about, such as your staff,
  customers and event attendees.

We will:

1. process that data only on your documented instructions, which are these terms and your use of
   the service, unless the law requires otherwise, in which case we will tell you first unless the
   law forbids it;
2. make sure everyone who can access it is bound to confidentiality;
3. keep it secure, as described in [SECURITY.md](SECURITY.md): every tenant's data is kept apart by
   PostgreSQL row-level security, API keys are stored only as digests, and traffic is encrypted in
   transit;
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
   it; and
8. give you the information you need to show these terms are met, answer reasonable audit
   questions, and tell you at once if we think an instruction of yours breaks data protection law.

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
