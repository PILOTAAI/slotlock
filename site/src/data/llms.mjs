// The project-specific part of /llms.txt (starlight-llms-txt's `details`), apart from
// astro.config.mjs so the repository's tests can read what it tells agents without building the site.

/**
 * @param {string} pageList the docs pages as Markdown links, one per line
 * @param {string} version the package version the site is built from
 */
export function llmsDetails(pageList, version) {
  // 0.2 can accept double bookings around daylight-saving changes (docs/known-issues).
  const knownIssues = version.startsWith('0.2.')
    ? ` Version ${version} has known double-booking defects around daylight-saving changes, to be fixed in 0.3.0: https://slotlock.pylota.io/docs/known-issues.md.`
    : '';
  return `Slotlock is an early (0.x) TypeScript library and MCP/A2A server, on npm as \`slotlock\`. You run it against your own PostgreSQL 16 or newer: hosted Slotlock (https://slotlock-api.pylota.io) is not open, and self-hosting is the only supported path today (https://slotlock.pylota.io/docs/hosted.md).${knownIssues}

Instructions for AI agents:

- Append \`.md\` to a docs page URL for its Markdown source, for example https://slotlock.pylota.io/docs/quickstart.md. The landing page is https://slotlock.pylota.io/index.md.
- Tool names are \`slotlock_<verb>\` (for example \`slotlock_find_next_available\`). Every tool's input and output fields and error codes are at https://slotlock.pylota.io/docs/tools.md. A refused or conflicting call is a tool result \`{"error":{"code":"…"}}\`, not a protocol error: read the code, then act. \`overlap\` means the time is already taken.
- A slot is free only when its coverage is certain. Treat \`uncertain\` (reason \`coverage_incomplete\`) as unknown, never as free.
- Event writes (\`slotlock_create_event\`, \`slotlock_update_event\`, \`slotlock_delete_event\`) need an \`idempotency_key\`; retry with the same key and arguments. Updates and deletes also need the \`expected_revision\` you last read. Holds belong to the application API, not the tools.
- On hosted Slotlock a write takes effect at once; no person is asked to confirm it. A \`429 rate_limited\` answer carries \`Retry-After\`: wait that long.
- Slotlock does not sync Google or Microsoft calendars by itself; adapters live in the embedding application.
- The normative semantics are https://slotlock.pylota.io/docs/specification.md; the capability manifest schema is https://slotlock.pylota.io/schema/manifest.schema.json.

Docs pages as Markdown:

${pageList}`;
}
