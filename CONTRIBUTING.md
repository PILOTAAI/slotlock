# Contributing to Slotlock

Slotlock accepts focused issues and pull requests that preserve its resource-first, deterministic
contract. By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md); maintainers are
listed in [MAINTAINERS.md](./MAINTAINERS.md).

## Development

You need Node.js 22.12 or newer and, for the database suites, PostgreSQL 16 or newer (CI runs them
on 16, 17 and 18). From the repository root:

```sh
npm ci
npm run typecheck   # the package, then examples/ as a consumer compiles them
npm test            # tests, build, then the packed-artifact verification
```

Database suites (`*.integration.test.ts`) run when `DATABASE_URL` points at a PostgreSQL 16 or newer
database whose connecting role can create roles, databases and extensions, and are skipped
otherwise (the upgrade suite builds a database of its own and drops it):

```sh
DATABASE_URL=postgresql://slotlock_dev:dev-only-password@localhost:5432/slotlock_test npm test
```

Use a disposable database: the suites apply the schema and forced RLS, and create short-lived
roles. Never point them at production or shared customer data. Connect as any role except one named
`slotlock`, and with a password of 12 or more characters that does not contain "slot" or "lock". A
role named `slotlock` is the package's schema, which `"$user"` puts first on the search path. The
command-line tool redacts the database password from everything it prints, so a short or
product-like password rewrites the output the tests read.

Property suites (`*.property.test.ts`) check the engine, time zones, iCalendar parsing and API
keys on input [fast-check](https://fast-check.dev/) generates, with a new seed each run. A failure
prints the seed and the shrunk counterexample; add `{ seed, path }` from it to that `fc.assert` to
replay it, then keep the counterexample as an ordinary test once it is fixed.

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
and DCO pass on it, and `tag-release.yml` tags the release commit. The tag starts `release.yml`: the
suite, then npm and the GitHub release, and, only once the suite has passed, `image.yml` (the image,
then the MCP Registry). The image and the registry entry each wait for a maintainer to approve their
environment (`ghcr`, `mcp-registry`), and npm holds each staged version until a maintainer approves
it with two-factor authentication (GOVERNANCE.md); the Release run's summary gives the command. A version merged to `main` by hand, with its heading
dated, is released the same way. After a failed run, run it again with the same version: it keeps
the release branch the failed run left when that already holds this release, so checks already run
there still count, replaces it otherwise, and reuses its pull request (`scripts/open-release-pr.sh`).

The pull request is opened and merged by the release app, a GitHub App that can only write this
repository's contents and pull requests. An owner of the organization creates it once with
`node scripts/create-release-app.mjs` (click **Create GitHub App**, then install it on `slotlock`
only); the script checks the installation and stores the app's key in the `release-app` environment,
which only `main` can use. Without the app, the workflow opens the pull request as
github-actions[bot], whose checks GitHub holds until someone with write access approves them on the
pull request (**Approve workflows to run**). GitHub lets a workflow open pull requests at all only
once an admin allows it (Settings > Actions > General > Workflow permissions);
`scripts/configure-github.sh --allow-actions-pull-requests` sets it, and the run says so when it is
off. By default the script leaves it off, since the same switch lets GITHUB_TOKEN approve pull
requests.

Nobody, the admin included, can merge into `main` past a failing or missing required check ("CI
passed" and "Signed-off-by"): a change whose checks cannot pass is fixed in another pull request
first. The npm, `ghcr` and `mcp-registry` environments wait for a maintainer's approval in every
Release run.

When a run needs a step npm or GitHub keeps for a person (the first npm version, the npm trusted
publisher, the image's visibility, and the deploy key `tag-release.yml` pushes tags with), the
failing job names `scripts/bootstrap-release.sh`. One run of it does that step, re-runs the failed
jobs and waits for them.
