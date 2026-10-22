# Contributing to Slotlock

Slotlock accepts focused issues and pull requests that preserve its resource-first, deterministic
contract. By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md); maintainers are
listed in [MAINTAINERS.md](./MAINTAINERS.md).

## Development

You need Node.js 22.12 or newer and, for the database suites, PostgreSQL 16. From the repository
root:

```sh
npm ci
npm run typecheck   # the package, then examples/ as a consumer compiles them
npm test            # tests, build, then the packed-artifact verification
```

Database suites (`*.integration.test.ts`) run when `DATABASE_URL` points at a PostgreSQL 16
database whose connecting role can create roles and extensions, and are skipped otherwise:

```sh
DATABASE_URL=postgresql://slotlock_dev:dev-only-password@localhost:5432/slotlock_test npm test
```

Use a disposable database: the suites apply the schema and forced RLS, and create short-lived
roles. Never point them at production or shared customer data. Connect as any role except one named
`slotlock`, and with a password of 12 or more characters that does not contain "slot" or "lock". A
role named `slotlock` is the package's schema, which `"$user"` puts first on the search path. The
command-line tool redacts the database password from everything it prints, so a short or
product-like password rewrites the output the tests read.

## Sign off your commits

Slotlock uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a
contributor licence agreement. Every commit in a pull request must carry a `Signed-off-by:` line
with your name and email, which certifies that you wrote the change or have the right to submit it
under the project's licence:

```sh
git commit -s -m "Explain the change"
```

A check on each pull request fails when a commit lacks the line. To fix earlier commits, run
`git rebase --signoff main` and force-push your branch.

## Documentation

Every TypeScript block in README.md is quoted from a region of `examples/*.ts`
(`// #region <name>` … `// #endregion <name>`) marked `<!-- example: examples/<file>#<name> -->`.
Edit the example, not the README copy: `readme-examples.test.ts` fails when they differ, and
`examples.integration.test.ts` runs the examples against PostgreSQL. The website and docs live in
`site/`.

## Pull requests

- Add a regression test that fails without the change.
- Preserve half-open interval semantics and structured expected outcomes.
- Document public API changes in `CHANGELOG.md`, and keep SPEC.md normative.
- Run typecheck, tests, build, and package verification.
- Call out database, tenancy, privacy, sync, or supply-chain risk explicitly.
- Do not add provider credentials, product-specific authorization, or network calls to the core.

Changes to exclusion constraints, RLS, identity/idempotency, retention, iCalendar trust boundaries,
protocol error contracts, or release automation require a security review; while the project has
one maintainer, GOVERNANCE.md's single-maintainer rule applies.

## Releases

Add each change's entry under `## Unreleased` in `CHANGELOG.md`, in the pull request that makes it:
that section becomes the release notes.

To release, run **Actions > Release a version** with the version (for example `0.1.1`). It sets the
version in `package.json`, `package-lock.json`, `server.json` and `slotlock.manifest.json` and dates
the `## Unreleased` heading (`scripts/prepare-release.sh`), opens the pull request, merges it once CI
and DCO pass, and starts `tag-release.yml`, which tags the release commit. The tag starts
`release.yml` (the suite, then npm and the GitHub release) and `image.yml` (the image, then the MCP
Registry). npm holds each staged version until a maintainer approves it with two-factor
authentication (GOVERNANCE.md); the Release run's summary gives the command. A version merged to
`main` by hand, with its heading dated, is released the same way.

When a run needs a step npm or GitHub keeps for a person (the first npm version, the npm trusted
publisher, the image's visibility, and the deploy key `tag-release.yml` pushes tags with), the
failing job names `scripts/bootstrap-release.sh`. One run of it does that step, re-runs the failed
jobs and waits for them.
