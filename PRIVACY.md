# Privacy notice for hosted Slotlock

> **Draft — requires owner and legal review before the hosted service opens.**

This notice covers hosted Slotlock: the API at `https://slotlock-api.pylota.io` and the dashboard
at `https://app.slotlock.pylota.io`. It does not cover Slotlock you run yourself: the open-source
package sends nothing to us, and whoever runs it is responsible for the data in it. It does not
cover the Pylota app or pylota.io, which have their own notices.

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
| Your GitHub user id and login | GitHub, when you sign in to the dashboard | While your account exists; your user id is the name of your account (`github:<id>`) |
| Your API keys: name, scopes, expiry, the first characters and a SHA-256 digest of each key (never the key itself) | You, in the dashboard or the API | While your account exists; a revoked or expired key stays listed until your account is erased |
| Calendar content: resources, weekly hours, holds, reservations, events with their titles, descriptions, locations, organisers, attendees' names and email addresses, reminders and recurrence, and external calendar coverage | You and your agents | While your account exists, or until you delete it |
| A record of each event write, so a retried request returns the first result | The service | 30 days |
| Records of finished sign-ins, signed-out sessions and sent dashboard forms, as digests | The service | Until they expire, within 12 hours, and are then deleted |
| Your dashboard session, in a cookie | The service | 12 hours |
| Connection details: IP addresses, request times and paths | Your browser or client, through Cloudflare | Cloudflare's dashboard request logs: at most 7 days. The API server's logs record each call's operation and outcome, never its arguments or who made it, in rotating files that keep at most 150 MB |

Sign-in asks GitHub for no permissions beyond your public profile, and we keep nothing from GitHub
but your user id and login. The dashboard sets two cookies, both needed for sign-in to work: one for
the ten minutes a sign-in takes, and the session cookie above. We use no analytics or advertising
cookies.

## Why we use it, and our lawful basis

| Purpose | Data | Lawful basis (UK GDPR Article 6(1)) |
| --- | --- | --- |
| Running your account and the service you signed up for | Account, keys, calendar content, write records, sessions | (b) contract: the Terms of Service |
| Keeping the service secure and available: authenticating requests, rate limiting, stopping abuse, investigating faults | Account, keys, connection details, logs | (f) legitimate interests: a service anyone with a GitHub account can use must be protected from misuse, and the logs hold no request content |
| Answering you when you write to us | What you send | (b) contract, or (f) legitimate interests when you are not a user |
| Meeting a legal obligation, such as a lawful request from an authority | What the request covers | (c) legal obligation |

You do not have to give us any of this, but without a GitHub sign-in we cannot create an account,
and without calendar content there is nothing for the service to do. We make no decisions about you
by automated means that have legal or similarly significant effects, and we do no profiling.

## Who else processes it

| Recipient | What for | Where |
| --- | --- | --- |
| OVHcloud | The server and database that hold all of the data above | Its London (UK1) region, United Kingdom |
| Cloudflare, Inc. | DNS, TLS and the network path to the API; it runs the dashboard and keeps its request logs | Its global network; the dashboard is placed near the London server |
| GitHub, Inc. | Signs you in. GitHub is a separate controller of your GitHub account and learns that you signed in to Slotlock | United States |

We do not sell personal data or share it for advertising. We disclose it to anyone else only when
the law requires us to.

## International transfers

The database is in the United Kingdom. Cloudflare's network can process connection details and
dashboard requests outside the United Kingdom, including in the United States; Cloudflare's data
processing agreement relies on its certification under the Data Privacy Framework for transfers to
the United States. Write to us for a copy of the safeguards.

## Your rights

You can ask us for a copy of your data, to correct it, to erase it, to restrict or object to how we
use it, and to have it in a portable form. To erase your account and everything in it, write to
[privacy@pylota.io](mailto:privacy@pylota.io) naming your GitHub login. We reply with a word; sign in
to the dashboard and create an API key with that word as its name, which shows us the account is
yours. We then erase every resource, booking, event, hold and key in the account and tell you when
it is done. You can revoke keys yourself in the dashboard at any time. We answer every request
within one month.

If your data is in someone else's Slotlock account, for example as an event attendee, that account
holder is your controller: ask them first. If you cannot reach them, write to us and we will pass
your request on.

If you are unhappy with how we handle your data, tell us first at
[privacy@pylota.io](mailto:privacy@pylota.io). You can also complain to the Information
Commissioner's Office at [ico.org.uk](https://ico.org.uk/make-a-complaint/).

## Changes

We will post any change to this notice here, with the date, before it takes effect.
