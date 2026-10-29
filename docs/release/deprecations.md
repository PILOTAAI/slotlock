# Deprecating old versions

npm serves every version Slotlock has published, and the MCP Registry lists each server version as
active, so a pinned or careless install still gets 0.1.0 with no warning. Deprecating a version
keeps it installable but makes npm print the message on every install, and the registry show it.
The maintainer runs these commands from their own npm session (two-factor authentication: npm asks
for a code on each one) and their own GitHub login. Nothing in CI can do it.

What each version is (checked with `npm view` on 24 October 2026): `0.0.0-stage` is the placeholder
npm created while staged publishing was set up, with no code; 0.1.0, 0.1.1 and 0.2.0 all pin
`zod@4.6.5` (GHSA-mrhx-c7xc-m3w5); 0.2.0 is `latest` and has the double-booking defects in
[0.2.0-known-issues.md](0.2.0-known-issues.md). None is deprecated yet.

## Deprecate now

Preview first: `--dry-run` prints what npm would change and changes nothing.

```sh
npm deprecate slotlock@0.1.0 "x" --dry-run
```

Then:

```sh
npm deprecate slotlock@0.0.0-stage "Placeholder from setting up staged publishing; it contains no code. Install slotlock@latest."
npm deprecate slotlock@0.1.0 "Unsupported: booking defects fixed later, and pins zod 4.6.5 (GHSA-mrhx-c7xc-m3w5). Install slotlock@latest. https://github.com/PILOTAAI/slotlock/blob/main/docs/release/0.2.0-known-issues.md#the-known-issues"
npm deprecate slotlock@0.1.1 "Unsupported: booking defects fixed later, and pins zod 4.6.5 (GHSA-mrhx-c7xc-m3w5). Install slotlock@latest. https://github.com/PILOTAAI/slotlock/blob/main/docs/release/0.2.0-known-issues.md#the-known-issues"
npm deprecate slotlock@0.2.0 "Can double-book around daylight-saving changes, and pins zod 4.6.5 (GHSA-mrhx-c7xc-m3w5). Upgrade to 0.3.0 or later. https://github.com/PILOTAAI/slotlock/blob/main/docs/release/0.2.0-known-issues.md#the-known-issues"
```

npm reads the version as a range with prereleases included (`lib/commands/deprecate.js` in npm
11.17.0), and an exact version matches only itself, so each command touches one version. Check:

```sh
npm view slotlock@0.0.0-stage deprecated
npm view slotlock@0.1.0 deprecated
npm view slotlock@0.1.1 deprecated
npm view slotlock@0.2.0 deprecated
```

Deprecating 0.2.0 while it is the newest version means every install warns until 0.3.0 is out; that
is the point. To take a deprecation back: `npm undeprecate slotlock@0.2.0`.

The MCP Registry entries for 0.1.0 and 0.1.1 point at images of the same code. Install
`mcp-publisher` (`brew install mcp-publisher`), sign in with the GitHub account that can publish
`io.github.PILOTAAI/*`, and deprecate them (registry docs: `docs/reference/cli/commands.md` in
modelcontextprotocol/registry, read 24 October 2026):

```sh
mcp-publisher login github
mcp-publisher status --status deprecated --message "Unsupported: upgrade to the latest version." io.github.PILOTAAI/slotlock 0.1.0
mcp-publisher status --status deprecated --message "Unsupported: upgrade to the latest version." io.github.PILOTAAI/slotlock 0.1.1
```

GHCR has no deprecation. The `0.1.0`, `0.1` and `0.1.1` image tags stay; the image's `latest` tag
moves only to a later release (scripts/dist-tag.sh).

## When 0.3.0 is published

Change 0.2.0's message to point at the fix, deprecate its registry entry, and publish the two
advisories in [0.2.0-known-issues.md](0.2.0-known-issues.md) with 0.3.0 as the patched version:

```text
npm deprecate slotlock@0.2.0 "Upgrade to 0.3.0 or later: it fixes double bookings around daylight-saving changes and moves zod past GHSA-mrhx-c7xc-m3w5."
mcp-publisher status --status deprecated --message "Upgrade to 0.3.0 or later." io.github.PILOTAAI/slotlock 0.2.0
```
