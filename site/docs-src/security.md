---
title: Security model
description: How Slotlock keeps agent writes safe. A person can confirm each one, PostgreSQL decides every overlap, and forced row-level security keeps tenants apart.
---

Three rules hold everywhere: the database decides overlaps, the tenant comes from the authenticated
caller, and an agent's write can be made to wait for a person.

## Confirmation before writes

<!-- include README.md#confirm-before-writing body -->

## Tenant isolation

<!-- include SPEC.md#tenant-isolation body -->

- `grantApplicationRole` refuses a serving role that could leave row-level security: superuser,
  `BYPASSRLS`, ownership of anything, `CREATE` anywhere, or `TRUNCATE`, `REFERENCES` or `TRIGGER` on
  a Slotlock table.
- Deployment functions pin `search_path`, and refuse a `slotlock` schema another role controls.
- External calendar content is untrusted: parsing is bounded, and agents get busy time, not
  content.
- Your application still owns authentication, authorization, rate limiting, TLS, provider secrets
  and erasure.

[SECURITY.md](https://github.com/PILOTAAI/slotlock/blob/main/SECURITY.md#security-model) has the full
threat model, including what the role check does not read.

## Live updates

At most {{subscriptionsPerPrincipal}} open streams per caller and {{subscriptionsTotal}} per server.
Each re-read checks the caller's credentials again, so a revoked token ends its stream.

## Quotas and retention

Each agent may keep 1,000 events and 10,000 idempotency records, so one agent cannot fill the
database. Pruning frees quota; it is not erasure. See
[Operations](https://github.com/PILOTAAI/slotlock#operations).

## Report a vulnerability

<!-- include SECURITY.md#report-a-vulnerability body -->
