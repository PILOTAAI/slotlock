# Versions, stability and deprecation

What a Slotlock version number promises, what stays stable in the REST API under `/v1`, the MCP
tools and the A2A skills, and how anything is retired. GOVERNANCE.md commits the project to semantic
versioning; this file says what that means before and after 1.0.

## Version numbers

Slotlock is versioned `MAJOR.MINOR.PATCH` ([semver.org](https://semver.org)). Until 1.0:

- A **patch** release (0.3.1) fixes defects and moves dependencies. It never removes or renames
  anything, and never changes what an existing call means, except to stop it doing what a fix
  forbids (refusing an overlap it used to accept, say).
- A **minor** release (0.4.0) may also make breaking changes. Each is listed in CHANGELOG.md under
  **Changed** or **Removed**, with what to do instead.

From 1.0, breaking changes need a new major version.

The npm package, the server image, the MCP Registry entry and the five language clients carry the
same version. npm's `latest` tag is always the highest release; a fix to an older line is published
under `latest-<major>.<minor>` (for example `slotlock@latest-0.2`, if a 0.2 fix is ever published), and a prerelease under `next`.
Security fixes go to the latest minor release, as SECURITY.md says, and each security release names
the lowest safe version.

## What stays stable

Within a major version, and across 0.x minor releases unless CHANGELOG.md lists the change under
**Changed** or **Removed**:

- **REST under `/v1`.** Routes, methods, field names and types, error codes and the HTTP status that
  goes with each keep their meaning. New routes, new optional request fields, new response fields
  and new error codes may appear in any release, so clients must ignore response fields they do not
  know and treat an unknown error code by its HTTP status. A change that would break a `/v1` client
  goes under a new prefix, `/v2`, served beside `/v1` while `/v1` is deprecated.
- **MCP tools and A2A skills.** Tool and skill names, argument names and error codes keep their
  meaning. A renamed tool keeps answering to its old name: `calendar.<verb>` and `calendar_<verb>`
  still work beside `slotlock_<verb>`.
- **The database schema.** `applySchema` and `slotlock migrate` upgrade an existing schema in place.
  Downgrading the package against an upgraded schema is not supported; take a backup first.
- **The library.** Everything exported from `slotlock` and its documented subpaths, with the types
  in its declarations.

Not covered: anything undocumented, the exact text of messages, log lines, and the order of items a
list does not promise to sort.

## Deprecation

A feature to be removed is first deprecated:

1. CHANGELOG.md lists it under **Deprecated**, with its replacement and the earliest release that
   may remove it.
2. The README and the docs mark it as deprecated.
3. It is removed no sooner than the next minor release before 1.0, or the next major release from
   1.0.

Follow releases in CHANGELOG.md or the release feed,
<https://github.com/PILOTAAI/slotlock/releases.atom>.

## Hosted Slotlock

Hosted Slotlock (`https://slotlock-api.pylota.io`) runs one released version at a time; its agent
card says which (`/.well-known/agent-card.json`, `version`). Upgrading it follows the rules above,
with a notice period on top:

- A release that changes or removes anything under `/v1`, a tool or a skill is deployed only after
  the change has been announced on the [hosted service page](docs/hosted/README.md) and in the
  release feed for at least **90 days**.
- Additive changes and fixes are deployed without notice. A security fix may be deployed at once,
  even when it changes behaviour, and is announced as soon as it is safe to.
