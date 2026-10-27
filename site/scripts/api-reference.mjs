// Renders the REST API reference (/docs/api/) and the Postman collection from openapi.json, so
// both describe exactly the routes the server serves. One page per operation, grouped by what it
// works on; the overview lists every route. scripts/sync-content.mjs calls it and fails the build
// when an operation has no group here, or a group names an operation that no longer exists.
//
// Example values: the eight agent-tool operations use the tool's own example arguments (read from
// src/agent-server.ts by scripts/tool-schemas.mjs); the rest are built from the schema.

/** What each operation works on: the sidebar groups, in order, and their operations in order. */
export const GROUPS = [
  {
    name: 'Resources',
    operations: [
      'slotlock_list_resources',
      'slotlock_create_resource',
      'slotlock_get_resource',
      'slotlock_archive_resource',
      'slotlock_restore_resource',
      'slotlock_delete_resource',
      'slotlock_set_resource_booking_rules',
    ],
  },
  {
    name: 'Availability',
    operations: [
      'slotlock_get_free_busy',
      'slotlock_find_next_available',
      'slotlock_find_available_slots',
      'slotlock_list_busy',
      'slotlock_set_resource_availability',
      'slotlock_set_tenant_availability',
      'slotlock_record_coverage',
    ],
  },
  {
    name: 'Events',
    operations: [
      'slotlock_hold_slots',
      'slotlock_release_slots',
      'slotlock_book_together',
      'slotlock_create_event',
      'slotlock_list_events',
      'slotlock_get_event',
      'slotlock_update_event',
      'slotlock_delete_event',
      'slotlock_list_tenant_events',
      'slotlock_get_tenant_event',
      'slotlock_cancel_tenant_event',
    ],
  },
  {
    name: 'Holds',
    operations: [
      'slotlock_acquire_hold',
      'slotlock_get_hold',
      'slotlock_list_holds',
      'slotlock_confirm_hold',
      'slotlock_release_hold',
    ],
  },
  {
    name: 'Reservations',
    operations: [
      'slotlock_put_reservation',
      'slotlock_get_reservation',
      'slotlock_list_reservations',
      'slotlock_cancel_reservation',
    ],
  },
  {
    name: 'Changes and webhooks',
    operations: [
      'slotlock_list_changes',
      'slotlock_create_webhook',
      'slotlock_list_webhooks',
      'slotlock_delete_webhook',
      'slotlock_enable_webhook',
    ],
  },
  {
    name: 'Tenant',
    operations: ['slotlock_get_tenant', 'slotlock_run_maintenance', 'slotlock_erase_tenant'],
  },
];

/** What a status code means on every route; a route's own codes are in the README and tools page. */
const STATUS = {
  400: 'The request is malformed or out of bounds',
  401: 'No key, or a revoked or expired one',
  403: 'The key lacks the scope this route needs',
  404: "Not this tenant's, or gone",
  409: 'A conflict with what is stored: an overlap, a stale revision, a resource in use',
  410: 'The change cursor is older than the 7 days the feed keeps (`cursor_expired`): read from the start',
  422: 'The idempotency key was used with another request (`idempotency_conflict`)',
  428: 'The server asks a person to confirm this write first (`confirmation_required`)',
  429: 'Rate limited: retry after `Retry-After` seconds',
};

const SCOPE_TEXT = {
  read: '`read`',
  write: '`write`',
  admin: '`admin` (Full in the dashboard)',
};

export const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];

/** `slotlock_create_event` → `create-event`. */
export const pageSlug = (operationId) => operationId.replace(/^slotlock_/, '').replace(/_/g, '-');

const cell = (text) =>
  String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const format = (n) => n.toLocaleString('en-GB');

/** The operations of the document, by id. */
export function readApiOperations(openApi) {
  const operations = new Map();
  for (const [path, item] of Object.entries(openApi.paths)) {
    for (const method of METHOD_ORDER) {
      const operation = item[method];
      if (operation) operations.set(operation.operationId, { ...operation, method, path });
    }
  }
  return operations;
}

/** `string`, `string (date-time)`, `"a" \| "b"`, `string[]`, `object`, with `null` when nullable. */
function typeOf(schema) {
  if (!schema) return 'any';
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' | ');
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.type === 'array') return `${typeOf(schema.items)}[]`;
  if (schema.type === 'string' && schema.format) return `string (${schema.format})`;
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  return schema.type ?? 'object';
}

/** Bounds and defaults, in words: `1-200 characters`, `up to 100`, `default "opaque"`. */
function notesOf(schema) {
  if (!schema) return '';
  if (schema.anyOf) {
    return schema.anyOf
      .map(notesOf)
      .filter(Boolean)
      .join('; ');
  }
  const notes = [];
  const range = (min, max, unit) => {
    if (min !== undefined && max !== undefined) {
      notes.push(min === max ? `${format(min)} ${unit}` : `${format(min)}-${format(max)} ${unit}`);
    } else if (max !== undefined) notes.push(`up to ${format(max)} ${unit}`);
    else if (min !== undefined) notes.push(`at least ${format(min)} ${unit}`);
  };
  if (schema.type === 'string') range(schema.minLength, schema.maxLength, 'characters');
  if (schema.type === 'array') range(schema.minItems, schema.maxItems, 'items');
  if (schema.type === 'integer' || schema.type === 'number') {
    // The safe-integer bound only says "a JSON number"; leave it out.
    const max = schema.maximum >= Number.MAX_SAFE_INTEGER ? undefined : schema.maximum;
    if (max !== undefined || schema.minimum > 0) range(schema.minimum, max, '');
  }
  if (schema.default !== undefined) notes.push(`default \`${JSON.stringify(schema.default)}\``);
  return notes.join(', ').replace(/ ,/g, ',').trim();
}

/** The object form of a schema: itself, or the object member of an `anyOf` with `null`. */
function objectOf(schema) {
  if (schema?.type === 'object' && schema.properties) return schema;
  if (schema?.type === 'array') return objectOf(schema.items);
  return schema?.anyOf?.map(objectOf).find(Boolean);
}

/** Table rows for an object's fields, and its nested objects' fields as `parent.child`. */
function fieldRows(schema, prefix = '', depth = 0) {
  const object = objectOf(schema);
  if (!object) return [];
  const required = new Set(object.required ?? []);
  const rows = [];
  for (const [name, field] of Object.entries(object.properties)) {
    const path = `${prefix}${name}`;
    rows.push({ path, type: typeOf(field), required: required.has(name), notes: notesOf(field) });
    const nested = objectOf(field);
    if (nested && depth < 1) {
      const suffix = field.type === 'array' || field.anyOf?.some((s) => s.type === 'array') ? '[].' : '.';
      rows.push(...fieldRows(field, `${path}${suffix}`, depth + 1));
    }
  }
  return rows;
}

/** One code span per alternative, so a long union wraps between them, never inside one. */
const typeCell = (type) =>
  type
    .split(' | ')
    .map((part) => `\`${cell(part)}\``)
    .join(' \\| ');

function fieldTable(rows, { required = true } = {}) {
  const head = required
    ? ['| Field | Type | Required | Notes |', '| --- | --- | --- | --- |']
    : ['| Field | Type | Notes |', '| --- | --- | --- |'];
  return [
    ...head,
    ...rows.map((row) =>
      required
        ? `| \`${row.path}\` | ${typeCell(row.type)} | ${row.required ? 'Yes' : ''} | ${cell(row.notes)} |`
        : `| \`${row.path}\` | ${typeCell(row.type)} | ${cell(row.notes)} |`,
    ),
  ].join('\n');
}

/** A value for an example, from the field's name and schema. */
function sample(name, schema) {
  if (!schema) return null;
  if (schema.anyOf) return sample(name, schema.anyOf.find((s) => s.type !== 'null'));
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'array') {
    const item = sample(name.replace(/s$/, ''), schema.items);
    return item === null ? [] : [item];
  }
  if (schema.type === 'object') {
    const object = objectOf(schema);
    if (!object) return {};
    return Object.fromEntries(
      (object.required ?? []).map((key) => [key, sample(key, object.properties[key])]),
    );
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') {
    if (/revision/.test(name)) return 1;
    if (/ttl_seconds/.test(name)) return 900;
    if (name === 'start_minutes') return 540;
    if (name === 'duration_minutes') return 480;
    if (/minutes/.test(name)) return 60;
    if (/limit/.test(name)) return 50;
    return schema.minimum ?? 1;
  }
  if (schema.format === 'date-time') {
    return /end|until/.test(name) ? '2030-01-07T10:00:00Z' : '2030-01-07T09:00:00Z';
  }
  if (schema.format === 'email') return 'fleet@example.com';
  if (name === 'rrule') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (/timezone/.test(name)) return 'Europe/London';
  if (name === 'source') return 'google-calendar';
  if (name === 'reservation_ref') return 'BK-42';
  if (/external_ref/.test(name)) return 'vehicle-42';
  if (/^confirm_tenant_ref$/.test(name)) return '<tenant reference from GET /v1/tenant>';
  if (/idempotency_key/.test(name)) return 'booking-BK-42';
  if (/_id$|^id$/.test(name)) return `<${name}>`;
  if (/title|summary/.test(name)) return 'Vehicle handover';
  return `<${name}>`;
}

function exampleArguments(operation, toolExample) {
  if (toolExample) return toolExample;
  const args = {};
  for (const parameter of operation.parameters ?? []) {
    if (parameter.required) args[parameter.name] = sample(parameter.name, parameter.schema);
  }
  const body = operation.requestBody?.content?.['application/json']?.schema;
  if (body) Object.assign(args, sample('body', body));
  // The tenant's list reads the window of the event the create example books.
  if (operation.operationId === 'slotlock_list_tenant_events' && operation.eventWindow) {
    Object.assign(args, operation.eventWindow);
  }
  // Cancelling is a new revision: the one booked plus 1.
  if (operation.operationId === 'slotlock_cancel_reservation') args.revision = 2;
  // Reservations a day after the hold example, so running every example in order books both.
  if (/reservation/.test(operation.operationId)) {
    return JSON.parse(JSON.stringify(args).replaceAll('2030-01-07', '2030-01-08'));
  }
  return args;
}

/** Ids a Postman run carries from the request that creates them to the ones after it. */
const RUN_VARIABLES = {
  resource_id: { from: 'slotlock_create_resource', path: ['resource', 'id'] },
  event_id: { from: 'slotlock_create_event', path: ['event', 'id'] },
  hold_id: { from: 'slotlock_acquire_hold', path: ['hold', 'id'] },
  // The tenant routes name an event by the id their own list gives, at its current revision.
  tenant_event_id: { from: 'slotlock_list_tenant_events', path: ['events', '0', 'id'] },
  tenant_event_revision: { from: 'slotlock_get_tenant_event', path: ['event', 'revision'] },
};

const TENANT_EVENT_ROUTES = new Set(['slotlock_get_tenant_event', 'slotlock_cancel_tenant_event']);

/** An argument's run variable on this operation, if it has one. */
function runVariable(operationId, name) {
  if (TENANT_EVENT_ROUTES.has(operationId)) {
    if (name === 'event_id') return 'tenant_event_id';
    if (name === 'expected_revision') return 'tenant_event_revision';
  }
  return name in RUN_VARIABLES ? name : null;
}

/** The same arguments with each run variable as `{{name}}` (a list of resource ids as one). */
function withRunVariables(operationId, args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    const variable = runVariable(operationId, key);
    if (variable) out[key] = `{{${variable}}}`;
    else if (key === 'resource_ids') out[key] = ['{{resource_id}}'];
    else out[key] = value;
  }
  return out;
}

/**
 * Postman runs folders in order, so the agent's own cancel waits until the tenant routes have read
 * and cancelled the event, and the destructive calls go last.
 */
const CLEAN_UP = new Set([
  'slotlock_delete_event',
  'slotlock_delete_resource',
  'slotlock_erase_tenant',
]);

/** Split example arguments into path values, query pairs and a JSON body. */
function requestParts(operation, args) {
  const path = { ...args };
  const pathParams = (operation.parameters ?? []).filter((p) => p.in === 'path');
  const queryParams = (operation.parameters ?? []).filter((p) => p.in === 'query');
  let url = operation.path;
  for (const parameter of pathParams) {
    url = url.replace(`{${parameter.name}}`, encodeURIComponent(String(path[parameter.name] ?? `<${parameter.name}>`)).replace(/%3C|%3E/g, (m) => (m === '%3C' ? '<' : '>')));
    delete path[parameter.name];
  }
  const query = [];
  for (const parameter of queryParams) {
    if (!(parameter.name in path)) continue;
    const value = path[parameter.name];
    for (const item of Array.isArray(value) ? value : [value]) {
      query.push([parameter.name, typeof item === 'string' ? item : JSON.stringify(item)]);
    }
    delete path[parameter.name];
  }
  const hasBody = Boolean(operation.requestBody);
  return { url, query, body: hasBody ? path : null };
}

function curlExample(operation, parts) {
  const qs = parts.query.map(([k, v]) => `${k}=${v}`).join('&');
  const lines = [
    `curl ${operation.method === 'get' ? '' : `-X ${operation.method.toUpperCase()} `}"$SLOTLOCK_URL${parts.url}${qs ? `?${qs}` : ''}" \\`,
    '  -H "Authorization: Bearer $SLOTLOCK_API_KEY"',
  ];
  if (parts.body) {
    lines[lines.length - 1] += ' \\';
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '${JSON.stringify(parts.body, null, 2).replace(/\n/g, '\n  ')}'`);
  }
  return lines.join('\n');
}

const methodBadge = (method) =>
  `<span class="api-method api-method-${method}">${method.toUpperCase()}</span>`;

/** One operation's page. */
function renderPage(operation, { order, group, toolNames }) {
  const isTool = toolNames.has(operation.operationId);
  const params = operation.parameters ?? [];
  const pathParams = params.filter((p) => p.in === 'path');
  const queryParams = params.filter((p) => p.in === 'query');
  const body = operation.requestBody?.content?.['application/json']?.schema;
  const response = operation.responses?.['200']?.content?.['application/json']?.schema;
  const paramRows = (list) =>
    list.map((p) => ({
      path: p.name,
      type: typeOf(p.schema),
      required: Boolean(p.required),
      notes: [notesOf(p.schema), p.description].filter(Boolean).join('. '),
    }));
  const errors = Object.keys(operation.responses ?? {})
    .filter((code) => /^[45]\d\d$/.test(code))
    .map((code) => `| \`${code}\` | ${STATUS[code] ?? cell(operation.responses[code].description ?? '')} |`);
  const parts = requestParts(operation, exampleArguments(operation, operation.toolExample));

  const sections = [
    '---',
    `title: ${JSON.stringify(operation.summary)}`,
    `description: ${JSON.stringify(operation.description)}`,
    'sidebar:',
    `  order: ${order}`,
    `  label: ${JSON.stringify(operation.summary)}`,
    '  badge:',
    `    text: ${operation.method.toUpperCase()}`,
    `    class: api-badge api-badge-${operation.method}`,
    'tableOfContents: false',
    '---',
    '',
    `<p class="api-endpoint">${methodBadge(operation.method)}<code>${operation.path}</code></p>`,
    '',
    `Needs a key with the ${SCOPE_TEXT[operation['x-slotlock-scope']] ?? `\`${operation['x-slotlock-scope']}\``} scope.` +
      (isTool
        ? ` Agents call the same operation as the MCP tool [\`${operation.operationId}\`](/docs/tools/#${operation.operationId}), which explains its fields and errors in full.`
        : ' Application API: never an MCP tool, and never waits for a confirmation.'),
  ];
  if (pathParams.length) sections.push('', '## Path parameters', '', fieldTable(paramRows(pathParams)));
  if (queryParams.length) sections.push('', '## Query parameters', '', fieldTable(paramRows(queryParams)));
  if (body) sections.push('', '## Body', '', fieldTable(fieldRows(body)));
  if (response) {
    const rows = fieldRows(response);
    sections.push('', '## Response', '', rows.length ? fieldTable(rows, { required: false }) : '`200` with an empty object.');
  }
  sections.push(
    '',
    '## Errors',
    '',
    'An error answers an RFC 9457 problem with one of these statuses; its `code` says why. The [overview](/docs/api/#errors) lists what each means.',
    '',
    '| Status | When |',
    '| --- | --- |',
    ...errors,
    '',
    '## Example',
    '',
    '```sh',
    curlExample(operation, parts),
    '```',
  );
  return `${sections.join('\n')}\n`;
}

/** The overview page: base URL, keys, errors, paging, and every route by group. */
function renderOverview(operations, version) {
  const groups = GROUPS.map((group) => {
    const rows = group.operations.map((id) => {
      const operation = operations.get(id);
      return `| ${methodBadge(operation.method)} | [\`${operation.path}\`](/docs/api/${pageSlug(id)}/) | ${cell(operation.summary)} | \`${operation['x-slotlock-scope']}\` |`;
    });
    return [`### ${group.name}`, '', '| Method | Route | Does | Scope |', '| --- | --- | --- | --- |', ...rows].join('\n');
  });
  return `---
title: REST API
description: Every Slotlock operation as plain HTTP with JSON, described by an OpenAPI 3.1 document you can import into Postman, Insomnia, Bruno or any client generator.
sidebar:
  order: 0
  label: Overview
---

\`slotlock serve\` answers REST beside MCP and A2A. Each route below has a page with its fields,
errors and a \`curl\` example.

## Import it

| | |
| --- | --- |
| **Postman** | [\`slotlock.postman_collection.json\`](/slotlock.postman_collection.json): in Postman, **Import** and drop the file in. Set the \`baseUrl\` and \`apiKey\` variables. |
| **OpenAPI 3.1** | [\`openapi.json\`](/openapi.json): import it into Insomnia, Bruno, Hoppscotch or Swagger Editor, or generate a client. A running server serves its own at \`/openapi.json\`. |
| **Your coding agent** | [Set up with a coding agent](/docs/agent-setup/) has a prompt to paste. |

## Base URL and keys

Requests go to your server's URL (\`SLOTLOCK_PUBLIC_URL\`, \`http://localhost:8080\` with Docker).
Send a key as a bearer token:

\`\`\`sh
export SLOTLOCK_URL=http://localhost:8080
export SLOTLOCK_API_KEY=slk_…        # slotlock key create "Me" --scope read,write,admin
curl "$SLOTLOCK_URL/v1/resources" -H "Authorization: Bearer $SLOTLOCK_API_KEY"
\`\`\`

| Scope | Routes |
| --- | --- |
| \`read\` | The agent tools that only look: resources, free/busy, next available, events |
| \`write\` | The agent tools that create, update and delete events |
| \`admin\` | The application API: resources, hours, holds, reservations, coverage, the tenant. The server token is never admin. |

[API keys](/docs/keys/) says how to create one.

## Requests and responses

- \`GET\` and \`DELETE\` take query parameters; a list repeats (\`resource_ids=a&resource_ids=b\`).
  \`POST\`, \`PUT\` and \`PATCH\` take a JSON body.
- Times are RFC 3339 (\`2030-01-07T09:00:00Z\`). Time zones are IANA names (\`Europe/London\`).
- An event's own times are \`starts_at\` and \`ends_at\`; a window to search or list is \`start\` and
  \`end\`. A wrong field name answers \`400 invalid_arguments\`, so check each route's page.
- Lists page with \`limit\` (up to 100) and \`cursor\`, the \`next_cursor\` of the page before.
- Writes are safe to retry: a repeated reservation answers \`replayed: true\` and a confirmed hold
  confirms again. A write with an \`idempotency_key\` also takes it as the \`Idempotency-Key\`
  header, quoted (\`"booking-BK-42"\`) or bare; other routes refuse it. A write that needs a key
  and gets none answers \`400 idempotency_key_required\`, and the same key with another request
  \`422 idempotency_conflict\`. An event write's key is kept 30 days, a hold's while the hold could
  be live.
- There are no CORS headers: call the API from a server, not a browser.

## Errors

An error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
(\`application/problem+json\`) with an HTTP status:

\`\`\`json
{
  "type": "tag:slotlock.pylota.io,2026:problem:overlap",
  "title": "The time is taken",
  "status": 409,
  "code": "overlap",
  "resource_id": "0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b",
  "start": "2027-03-02T09:00:00Z",
  "end": "2027-03-02T10:00:00Z",
  "error": { "code": "overlap" }
}
\`\`\`

\`type\` names the problem, one per \`code\`; \`error.code\` repeats the code for clients written
before. Act on the \`code\`:

| Status | Means | Common codes |
| --- | --- | --- |
| \`400\` | The request is malformed or out of bounds | \`invalid_arguments\`, \`calendar_work_limit\`, \`idempotency_key_required\` |
| \`401\` | No key, or a revoked or expired one | \`authentication_required\` |
| \`403\` | The key lacks the route's scope | \`forbidden\` |
| \`404\` | Not this tenant's, or gone | \`resource_not_found\`, \`event_not_found\`, \`hold_not_found\`, \`reservation_not_found\`, or \`not_found\`: act on the status |
| \`409\` | It conflicts with what is stored | \`overlap\`, \`stale_revision\`, \`resource_in_use\` |
| \`422\` | An idempotency key reused with another request | \`idempotency_conflict\` |
| \`428\` | A person must confirm this write first | \`confirmation_required\` |
| \`429\` | Rate limited, or an agent's own quota is full | \`rate_limited\` (retry after the \`Retry-After\` header's seconds), \`owner_event_quota_exceeded\`, \`owner_command_quota_exceeded\` |

An \`overlap\` is the answer, not a fault: the time is taken. Read free/busy again and offer another
slot.

## Routes

${groups.join('\n\n')}

The same document describes Slotlock ${version}; [Versions and stability](/docs/versioning/) says
what stays the same across releases.
`;
}

/** A Postman v2.1 collection: one folder per group, `baseUrl` and `apiKey` as variables. */
function renderPostman(operations, version) {
  const folders = [
    ...GROUPS.map((group) => ({
      name: group.name,
      ids: group.operations.filter((id) => !CLEAN_UP.has(id)),
    })),
    { name: 'Clean up', ids: [...CLEAN_UP] },
  ].map((folder) => ({
    name: folder.name,
    item: folder.ids.map((id) => {
      const operation = operations.get(id);
      const parts = requestParts(
        operation,
        withRunVariables(id, exampleArguments(operation, operation.toolExample)),
      );
      const pathSegments = operation.path
        .split('/')
        .filter(Boolean)
        .map((segment) => segment.replace(/^\{(.+)\}$/, ':$1'));
      const queryNames = (operation.parameters ?? []).filter((p) => p.in === 'query');
      const query = [];
      for (const parameter of queryNames) {
        const given = parts.query.filter(([name]) => name === parameter.name);
        if (given.length) for (const [key, value] of given) query.push({ key, value });
        else query.push({ key: parameter.name, value: '', disabled: true, description: notesOf(parameter.schema) || undefined });
      }
      const pathVars = (operation.parameters ?? [])
        .filter((p) => p.in === 'path')
        .map((p) => ({
          key: p.name,
          value: runVariable(id, p.name)
            ? `{{${runVariable(id, p.name)}}}`
            : String(sample(p.name, p.schema)),
        }));
      const request = {
        method: operation.method.toUpperCase(),
        header: parts.body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
        url: {
          raw: `{{baseUrl}}${operation.path.replace(/\{(.+?)\}/g, ':$1')}${query.some((q) => !q.disabled) ? `?${query.filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&')}` : ''}`,
          host: ['{{baseUrl}}'],
          path: pathSegments,
          ...(query.length ? { query } : {}),
          ...(pathVars.length ? { variable: pathVars } : {}),
        },
        description: `${operation.description}\n\nScope: ${operation['x-slotlock-scope']}. Docs: https://slotlock.pylota.io/docs/api/${pageSlug(id)}/`,
      };
      if (parts.body) {
        request.body = {
          mode: 'raw',
          raw: JSON.stringify(parts.body, null, 2),
          options: { raw: { language: 'json' } },
        };
      }
      const item = { name: operation.summary, request };
      const saves = Object.entries(RUN_VARIABLES).filter(([, v]) => v.from === id);
      if (saves.length) {
        item.event = [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: [
                'if (pm.response.code === 200) {',
                '  const body = pm.response.json();',
                ...saves.map(
                  ([name, v]) =>
                    `  pm.collectionVariables.set('${name}', body${v.path.map((k) => (/^\d+$/.test(k) ? `[${k}]` : `.${k}`)).join('')});`,
                ),
                '}',
              ],
            },
          },
        ];
      }
      return item;
    }),
  }));
  return {
    info: {
      name: `Slotlock ${version}`,
      description:
        'The Slotlock REST API. Set baseUrl to your server (http://localhost:8080 with Docker) and apiKey to a key with the read, write and admin scopes (slotlock key create "Postman" --scope read,write,admin). Run the folders in order on a fresh tenant: each request saves the ids the next ones use. The Clean up folder ends with three refusals that are correct answers: the event the tenant route already cancelled (404), a resource that still has a booking (409 resource_in_use), and tenant erasure, which slotlock serve leaves off (403). Docs: https://slotlock.pylota.io/docs/api/',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }] },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:8080' },
      { key: 'apiKey', value: 'slk_replace_me' },
      ...Object.keys(RUN_VARIABLES).map((key) => ({ key, value: '' })),
    ],
    item: folders,
  };
}

/**
 * Everything the reference is made of. `toolExamples` maps a tool name to its example arguments.
 * Fails (through `fail`) when the groups and the document disagree.
 */
export function renderApiReference({ openApi, version, toolExamples, fail }) {
  const operations = readApiOperations(openApi);
  const grouped = GROUPS.flatMap((group) => group.operations);
  for (const id of grouped) {
    if (!operations.has(id)) fail(`GROUPS in scripts/api-reference.mjs names ${id}, which openapi.json no longer has`);
  }
  for (const id of operations.keys()) {
    if (!grouped.includes(id)) fail(`openapi.json has ${id}; add it to GROUPS in scripts/api-reference.mjs`);
  }
  if (new Set(grouped).size !== grouped.length) fail('GROUPS in scripts/api-reference.mjs lists an operation twice');
  const toolNames = new Set(Object.keys(toolExamples));
  const booked = toolExamples.slotlock_create_event;
  if (booked?.starts_at && booked?.ends_at) {
    // The whole day, so the event still shows after the update example moves it within the day.
    const day = new Date(`${booked.starts_at.slice(0, 10)}T00:00:00Z`);
    operations.get('slotlock_list_tenant_events').eventWindow = {
      start: day.toISOString().replace('.000Z', 'Z'),
      end: new Date(day.getTime() + 86_400_000).toISOString().replace('.000Z', 'Z'),
    };
  }
  for (const [id, operation] of operations) {
    if (toolNames.has(id)) operation.toolExample = toolExamples[id];
    if (!operation.summary || !operation.description) fail(`${id} has no summary or description in openapi.json`);
  }
  const pages = [];
  let order = 1;
  for (const group of GROUPS) {
    for (const id of group.operations) {
      pages.push({ slug: pageSlug(id), group: group.name, markdown: renderPage(operations.get(id), { order: order++, group, toolNames }) });
    }
  }
  return {
    overview: renderOverview(operations, version),
    pages,
    postman: renderPostman(operations, version),
    operationCount: operations.size,
  };
}
