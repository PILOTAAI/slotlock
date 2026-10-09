# Governance

Slotlock uses a maintainer-led, review-based model. The maintainers are listed in
[MAINTAINERS.md](./MAINTAINERS.md).

## Roles

- Contributors propose issues, documentation, tests, and code.
- Maintainers triage work, review changes, cut releases, and enforce project policy.
- Security maintainers receive private reports and may coordinate embargoed fixes.

Maintainer status is earned through sustained, constructive contributions and is granted by
consensus of the existing maintainers. Inactive maintainers may move to emeritus status.

## Decisions

Routine changes require one approving maintainer and green required checks. Changes to public API,
data model, scheduling semantics, tenancy, security boundaries, or governance require an issue or
RFC and two maintainer approvals. Security-sensitive changes also require an independent security
review. A maintainer with a material conflict of interest must recuse themselves.

### While there is one maintainer

Until a second maintainer is appointed, a change that requires two maintainer approvals instead
requires the maintainer's approval **and** an independent security review of that change by someone
other than its author, recorded on the pull request. A change the maintainer authored still needs
that independent review before it merges. An automated or AI-generated review does not count as
that independent review. This rule ends when MAINTAINERS.md lists two maintainers.

## Licence commitment

The Slotlock engine, its specification, its MCP and A2A server, and every package this repository
publishes stay under the Apache License 2.0 or another licence approved by the Open Source
Initiative. Contributions are accepted under the Developer Certificate of Origin with no contributor
licence agreement, so every contribution arrives under the same Apache-2.0 terms it leaves under and
no single party can relicense the contributions of others. Once the project has a maintainer from
outside TREFT LTD, changing this commitment also needs that maintainer's approval.

## Releases

Releases follow semantic versioning and are built only by the repository release workflow from a
protected `v<version>` tag on `main`. The tag must match `package.json` and a `CHANGELOG.md`
heading. The workflow stages the tested artifact to npm with trusted publishing (short-lived OIDC
credentials and provenance); a maintainer then approves the staged version with two-factor
authentication. Long-lived npm tokens are not accepted. Release artifacts must pass the
package-content and consumer checks.

## Project changes

License changes, transfer to another organization, archival, or changes to this governance model
require a public proposal, a minimum seven-day comment period, and unanimous active-maintainer
approval, and are bound by the licence commitment above.
