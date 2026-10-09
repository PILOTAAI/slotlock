---
title: Security model
description: Confirmation before writes, tenant isolation with forced row-level security, quotas and retention.
---

Three rules hold everywhere. The database decides overlaps; no model holds a lock or judges
whether a write is safe. Tenancy comes from the authenticated caller, never from tool arguments.
And a write an agent proposes can be made to wait for a person.

## Confirmation before writes

<!-- include README.md#confirm-before-writing body -->

The pending confirmation expires after {{confirmTtlSeconds}} seconds by default (`ttlSeconds`
accepts {{confirmTtlMin}} to {{confirmTtlMax}}).

## Tenant isolation

<!-- include SPEC.md#tenant-isolation body -->

<!-- include SECURITY.md#security-model body -->

## Live updates

Open `subscriptions/listen` streams are capped at {{subscriptionsPerPrincipal}} per principal and
{{subscriptionsTotal}} per server by default. Every re-read authenticates the original credentials
again and is authorized, so an expired token or a withdrawn permission ends the stream.

## Quotas and retention

<!-- include README.md#operations body -->

## Report a vulnerability

<!-- include SECURITY.md#report-a-vulnerability body -->
