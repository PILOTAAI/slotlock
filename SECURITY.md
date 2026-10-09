# Security policy

## Supported versions

Security fixes are provided for the latest minor release. Until 1.0, minor releases may contain
documented breaking changes; security releases will identify the lowest safe version.

## Report a vulnerability

Do not open a public issue. Report privately through GitHub's private vulnerability reporting on the
repository that publishes the package: open its **Security** tab and choose **Report a
vulnerability**. The maintainers listed in [MAINTAINERS.md](./MAINTAINERS.md) receive the report.
Include:

- the affected version and surface;
- reproduction steps or a proof of concept;
- the expected impact;
- any known mitigations.

Do not include real customer, credential, calendar, or booking data. We will acknowledge a report
within three business days and coordinate disclosure after a fix is available.

## Security model

Slotlock treats all external calendar content as untrusted. The parser has explicit size, component,
occurrence, exception, work, and expansion-window bounds. Reservation conflicts are arbitrated by a
PostgreSQL exclusion constraint. Tenant policies are forced and fail closed when their transaction
context is missing. Embedding applications remain responsible for authentication, authorization,
provider-secret storage, webhook verification, network egress, and erasure.

Application traffic must use a role that cannot leave forced RLS. `grantApplicationRole` grants
such a role schema usage and DML on the tenant tables, and first refuses the known ways out, whether
the role holds them itself, through a role it belongs to, or through `PUBLIC`, and names the ones
it found:
- superuser, `BYPASSRLS`, `REPLICATION` or `CREATEROLE`, or membership of `pg_read_server_files`,
  `pg_write_server_files` or `pg_execute_server_program`;
- ownership of the database (whose owner also owns `public`, where `btree_gist` usually lives), of
  anything in it other than its temporary objects and its own default privileges (which reach no
  other session), or of `btree_gist`: an owner can drop what enforces isolation, and
  `DROP EXTENSION ... CASCADE` or `DROP SCHEMA ... CASCADE` takes the exclusion constraints with it;
- `CREATE` on the database or on any schema: a function or operator in a schema on some search path
  (the role's own `"$user"` schema, or one named after the deployment role) decides what a call with
  that name runs, in every tenant's session or in the next deployment;
- `TRUNCATE`, `REFERENCES` or `TRIGGER` on a Slotlock table, which RLS does not filter, or a default
  privilege that grants one on a table a later release adds (a default set by any role that can
  create tables in `slotlock`: a default applies only to the tables its own role creates);
- any right on a server setting (`SET` or `ALTER SYSTEM ON PARAMETER`).

The check reads the catalog when it runs, so rerun it after changing the role's memberships or
rights; a change made after it, or while it runs, is not detected. It is not exhaustive: it does not
read rights on objects that run with their owner's rights when that owner is a role RLS does not
bind (`EXECUTE` on a `SECURITY DEFINER` function, or `SELECT` or DML on a view without
`security_invoker`, which reads its tables as its owner), or foreign-data-wrapper and `dblink` user
mappings that carry another role's credentials. Keep the application role a plain
login role that owns nothing and can create nothing. On a cluster upgraded from PostgreSQL 14 or
earlier, `PUBLIC` may still hold `CREATE` on `public`; the check then refuses every role until
`REVOKE CREATE ON SCHEMA public FROM PUBLIC`. Like any role with DML, the application role can hold
a lock that blocks other tenants: that is availability, not isolation.

Schema changes run under a separate deployment role, which must own the `slotlock` schema and every
object in it (`applySchema` creates the schema when it is missing). The deployment writes rows into
Slotlock tables and resolves every `slotlock.` name in that schema as the owner of every table, and
`IF NOT EXISTS` keeps whatever another role created first, so `applySchema` and `applyTenantRls`
refuse (`unsafe_slotlock_schema`, with the `reasons` found) a `slotlock` schema that another role owns
or can create objects in, that holds an object another role owns (an extension, whose owner can
`DROP EXTENSION ... CASCADE`, included), or whose tables another role may add triggers to or have a
trigger running a function another role owns; superusers are trusted. The names are compared
exactly, so ownership held by a group role the deployment role belongs to is refused too: deploy as
the owning role itself (`SET ROLE`). Every deployment function resolves
names only in `pg_catalog` for its transaction, so an object planted in a schema on the deployment
role's `search_path` never runs with the ownership of the tables; a missing `btree_gist` is created
in `slotlock`, and Slotlock's own functions pin their `search_path`. Whoever owns `btree_gist`, or the
schema it lives in, can drop the exclusion constraints with `DROP EXTENSION ... CASCADE`: create it
as the deployment role or a superuser, or trust its owner as much. `SLOTLOCK_CORE_DDL` and
`createSlotlockTenantRlsDdl()` carry the same pin and refusal (SQLSTATE `42501`) and restore the
caller's `search_path` at their end; apply each in one transaction (`psql --single-transaction`),
since under autocommit the pin ends with the statement that sets it.

The privacy-minimised provider parser cannot return summaries, locations, notes, organizers or
attendees. Full event parsing is a separate trusted API and must only receive authenticated content.
Event command rows retain payload digests and stable results, never duplicate event content. Event
occurrences, tombstones, idempotency rows, and source-coverage rows are tenant scoped under the same
forced, fingerprinted RLS contract as resources and reservations. Embedding applications must still
classify and erase every table because RLS is isolation, not retention. `pruneCalendarEventRetention`
removes only expired idempotency evidence and agent tombstones; it is not an erasure mechanism.

The optional protocol server accepts only HTTPS public origins (except an explicit localhost
development mode), bounds request bodies and every operation schema, authenticates before discovery
or dispatch, authorizes each operation, validates backend output, and exposes only allowlisted error
codes. The authenticated principal supplies the tenant context; protocol input has no tenant
override, and agent event reads and writes are limited to the calling principal's own events. OAuth
protected-resource metadata, when configured, only tells clients where to obtain a token; the
embedder's `authenticate` must verify every token, including its audience. Embedders must provide
bearer-token verification, per-principal authorization, distributed rate limiting, TLS termination,
and a readiness check. Do not place provider credentials or raw calendar content in authentication,
authorization, rate-limit, or health callbacks.
