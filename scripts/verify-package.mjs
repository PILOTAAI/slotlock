import { strict as assert } from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = join(packageRoot, 'dist');
const sourceManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(artifactRoot, 'package.json'), 'utf8'));
const npmCache = mkdtempSync(join(tmpdir(), 'slotlock-npm-pack-'));
const packedRoot = join(npmCache, 'packed');
const consumerRoot = join(npmCache, 'consumer');
mkdirSync(packedRoot);
mkdirSync(consumerRoot);

assert.equal(manifest.private, undefined, 'a publishable package must not set private');
assert.notEqual(manifest.version, '0.0.0', 'a publishable package needs a real initial version');
assert.equal(manifest.license, 'Apache-2.0');
assert.equal(manifest.type, 'module');
assert.equal(manifest.sideEffects, false);
assert.equal(sourceManifest.private, true, 'the workspace root must reject accidental publication');
assert.equal(sourceManifest.exports?.['.']?.default, './src/index.ts');
assert.equal(sourceManifest.exports?.['./node-server']?.default, './src/node-server.ts');
assert.equal(manifest.exports?.['.']?.types, './index.d.ts');
assert.equal(manifest.exports?.['.']?.import, './index.js');
assert.equal(manifest.exports?.['./node-server']?.types, './node-server.d.ts');
assert.equal(manifest.exports?.['./node-server']?.import, './node-server.js');
assert.equal(manifest.exports?.['./manifest'], './slotlock.manifest.json');
assert.equal(manifest.exports?.['./manifest.schema'], './slotlock-manifest.schema.json');
assert.deepEqual(sourceManifest.bin, { slotlock: './dist/cli.js' });
assert.deepEqual(manifest.bin, { slotlock: 'cli.js' }, 'the artifact must carry the slotlock bin');
assert.match(
  readFileSync(join(artifactRoot, 'cli.js'), 'utf8'),
  /^#!\/usr\/bin\/env node\n/,
  'the slotlock bin must start with a node shebang',
);
assert.equal(manifest.publishConfig?.access, 'public');
assert.equal(manifest.engines?.node, '>=22.12.0');
assert.equal(manifest.author, 'TREFT LTD');
assert.ok(
  !JSON.stringify(manifest).includes('workspace:'),
  'the standalone manifest must not depend on a workspace protocol',
);
// The embedder passes its own postgres client in; a nested copy would give Slotlock a second,
// incompatible `Sql` type, so postgres is only ever a peer.
assert.deepEqual(manifest.peerDependencies, { postgres: '^3.4.5' });
assert.equal(manifest.dependencies?.postgres, undefined, 'postgres must be a peer dependency');

const notice = readFileSync(join(artifactRoot, 'NOTICE'), 'utf8');
assert.match(notice, /^Copyright \d{4} TREFT LTD$/m, 'NOTICE must name the copyright holder');
assert.match(
  readFileSync(join(artifactRoot, 'LICENSE'), 'utf8'),
  /^ {3}Copyright \d{4} TREFT LTD$/m,
  'the LICENSE appendix must name the copyright holder',
);
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  assert.ok(notice.includes(`${name} ${version},`), `NOTICE must list ${name} ${version}`);
}
for (const [name, range] of Object.entries(manifest.peerDependencies)) {
  assert.ok(notice.includes(`(${name}) ${range},`), `NOTICE must list peer ${name} ${range}`);
}

const packed = JSON.parse(
  execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packedRoot, '--cache', npmCache],
    { cwd: artifactRoot, encoding: 'utf8' },
  ),
)[0];
assert.ok(packed, 'npm pack must describe one package');

const files = new Set(packed.files.map((entry) => entry.path));
const expectedFiles = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'SECURITY.md',
  'SPEC.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
  'MAINTAINERS.md',
  'slotlock.manifest.json',
  'slotlock-manifest.schema.json',
  'agent-server.js',
  'agent-server.d.ts',
  'agent-store-backend.js',
  'agent-store-backend.d.ts',
  'api-keys.js',
  'api-keys.d.ts',
  'cli.js',
  'cli.d.ts',
  'dashboard.js',
  'dashboard.d.ts',
  'ddl.js',
  'ddl.d.ts',
  'engine.js',
  'engine.d.ts',
  'index.js',
  'index.d.ts',
  'mcp-app.js',
  'mcp-app.d.ts',
  'mcp-modern.js',
  'mcp-modern.d.ts',
  'node-server.js',
  'node-server.d.ts',
  'rules.js',
  'rules.d.ts',
  'self-host.js',
  'self-host.d.ts',
  'store.js',
  'store.d.ts',
  'sync.js',
  'sync.d.ts',
  'timezone.js',
  'timezone.d.ts',
  'types.js',
  'types.d.ts',
]);
assert.deepEqual(
  [...files].sort(),
  [...expectedFiles].sort(),
  'published artifact file set must match the reviewed allowlist exactly',
);
assert.equal(
  packed.files.find((entry) => entry.path === 'cli.js')?.mode,
  0o755,
  'the packed slotlock bin must be executable',
);
for (const path of files) {
  assert.ok(!path.startsWith('src/'), `source/test file leaked into package: ${path}`);
  assert.ok(!path.startsWith('scripts/'), `release script leaked into package: ${path}`);
  assert.ok(!path.includes('.test.'), `test file leaked into package: ${path}`);
  assert.ok(!path.endsWith('.map'), `source map without published sources leaked: ${path}`);
  assert.ok(!path.includes('.turbo'), `Turbo output leaked into package: ${path}`);
  assert.ok(!path.endsWith('.tsbuildinfo'), `TypeScript cache leaked into package: ${path}`);
  assert.ok(!path.startsWith('.npm-cache/'), `npm cache leaked into package: ${path}`);
}

// TypeScript 5.5+ drops a triple-slash directive from declaration output unless it is marked
// `preserve`. Without it a consumer compiling with `"types": []` cannot resolve `node:http` or the
// Request/Response/AbortSignal globals the public types use.
for (const entry of ['index.d.ts', 'node-server.d.ts']) {
  assert.match(
    readFileSync(join(artifactRoot, entry), 'utf8'),
    /^\/\/\/ <reference types="node" preserve="true" \/>$/m,
    `${entry} must keep its Node types reference`,
  );
}

const capabilityManifest = JSON.parse(
  readFileSync(join(artifactRoot, 'slotlock.manifest.json'), 'utf8'),
);
const capabilitySchema = JSON.parse(
  readFileSync(join(artifactRoot, 'slotlock-manifest.schema.json'), 'utf8'),
);
const validateManifest = new Ajv2020({ allErrors: true, strict: true }).compile(capabilitySchema);
assert.equal(
  validateManifest(capabilityManifest),
  true,
  `capability manifest violates its schema: ${JSON.stringify(validateManifest.errors)}`,
);
assert.equal(capabilityManifest.schemaVersion, '1.0');
assert.equal(capabilityManifest.package, manifest.name);
assert.equal(capabilityManifest.version, manifest.version);
const changelog = readFileSync(join(artifactRoot, 'CHANGELOG.md'), 'utf8');
// Every build needs a heading for the version; only a release needs its date, and
// scripts/check-release-tag.sh refuses a tag whose heading is still "Unreleased".
assert.match(
  changelog,
  new RegExp(
    `^## ${manifest.version.replaceAll('.', '\\.')} - (\\d{4}-\\d{2}-\\d{2}|Unreleased)$`,
    'm',
  ),
  'CHANGELOG must contain a heading for the package version, dated or "Unreleased"',
);
assert.deepEqual(capabilityManifest.intervalSemantics, {
  boundary: '[)',
  timezone: 'IANA',
  timestampEncoding: 'RFC3339',
});
assert.ok(capabilityManifest.capabilities.includes('atomic-holds'));
assert.ok(capabilityManifest.capabilities.includes('find-next-available'));
assert.ok(capabilityManifest.capabilities.includes('external-calendar-normalization'));
assert.ok(capabilityManifest.capabilities.includes('trusted-event-crud'));
assert.ok(capabilityManifest.capabilities.includes('coverage-aware-free-busy'));
assert.ok(capabilityManifest.capabilities.includes('itip-interchange'));
assert.ok(capabilityManifest.capabilities.includes('mcp-agent-server'));
assert.ok(capabilityManifest.capabilities.includes('mcp-app-calendar-ui'));
assert.ok(capabilityManifest.capabilities.includes('a2a-agent-server'));
assert.ok(capabilityManifest.capabilities.includes('event-retention'));
assert.ok(capabilityManifest.capabilities.includes('oauth-protected-resource-metadata'));
for (const capability of [
  'all-day-events',
  'long-events',
  'mcp-human-confirmation',
  'mcp-calendar-resources',
  'mcp-live-updates',
  'trace-context-propagation',
]) {
  assert.ok(capabilityManifest.capabilities.includes(capability), capability);
}

writeFileSync(
  join(consumerRoot, 'package.json'),
  `${JSON.stringify({ name: 'slotlock-clean-consumer', private: true, type: 'module' }, null, 2)}\n`,
);
const tarball = resolve(packedRoot, packed.filename);
// The consumer holds the LOWEST postgres the peer range admits, so the type check below proves the
// range, and the same @types/node the package is built against.
const consumerPostgres = '3.4.5';
const consumerNodeTypes = sourceManifest.devDependencies['@types/node'];
execFileSync(
  'npm',
  [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--cache',
    npmCache,
    tarball,
    `postgres@${consumerPostgres}`,
    `@types/node@${consumerNodeTypes}`,
  ],
  { cwd: consumerRoot, stdio: 'pipe', timeout: 120_000 },
);
assert.equal(
  JSON.parse(readFileSync(join(consumerRoot, 'node_modules/postgres/package.json'), 'utf8'))
    .version,
  consumerPostgres,
);
assert.throws(
  () =>
    readFileSync(join(consumerRoot, 'node_modules/slotlock/node_modules/postgres/package.json')),
  { code: 'ENOENT' },
  'Slotlock must resolve the consumer postgres, not a nested copy',
);
const consumerSmoke = `
import { strict as assert } from 'node:assert';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  createSlotlockAgentServer,
  findNextAvailable,
  slotlockCalendarResourceUri,
} from 'slotlock';
import { createSlotlockNodeServer } from 'slotlock/node-server';

const slotStart = new Date('2026-09-14T09:00:00.000Z');
const slot = findNextAvailable({
  busy: [],
  windows: [{ start: slotStart, end: new Date('2026-09-14T12:00:00.000Z') }],
  durationMs: 3_600_000,
});
assert.equal(slot?.start.getTime(), slotStart.getTime());

let authorizationCount = 0;
const agentServer = createSlotlockAgentServer({
  publicBaseUrl: 'http://localhost/slotlock',
  allowInsecureLocalhost: true,
  backend: {
    listResources: async (context, input) => {
      assert.deepEqual(context.principal, {
        subject: 'package-verification-principal',
        tenantRef: 'package-verification-tenant',
      });
      // Tool calls ask for 2; MCP resources/list pages with the default of 50.
      assert.ok(
        [2, 50].includes(input.limit) && Object.keys(input).join() === 'limit',
        JSON.stringify(input),
      );
      return {
        resources: [{ id: 'resource-verification', external_ref: null, timezone: 'UTC' }],
        next_cursor: null,
      };
    },
  },
  authenticate: async (request) =>
    request.headers.get('authorization') === 'Bearer package-verification'
      ? {
          subject: 'package-verification-principal',
          tenantRef: 'package-verification-tenant',
        }
      : null,
  authorize: async () => {
    authorizationCount += 1;
    return true;
  },
  health: async () => ({ ready: true, checks: ['backend'] }),
});

const listener = createSlotlockNodeServer(agentServer, {
  requestOrigin: 'http://localhost',
  handlerTimeoutMs: 5_000,
  shutdownGraceMs: 1_000,
});
const address = await listener.listen({ host: '127.0.0.1', port: 0 });
const authenticatedHeaders = {
  Authorization: 'Bearer package-verification',
  'Content-Type': 'application/json',
};

async function rpc(path, body, protocolHeaders = {}) {
  return fetch(address.origin + path, {
    method: 'POST',
    headers: { ...authenticatedHeaders, ...protocolHeaders },
    body: JSON.stringify(body),
  });
}

try {
  const health = await fetch(address.origin + '/slotlock/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: 'ready',
    version: '1.0.0',
    checks: ['backend'],
  });

  const manifest = await (await fetch(address.origin + '/slotlock/manifest.json')).json();
  assert.equal(manifest.protocols.mcp.endpoint, 'http://localhost/slotlock/mcp');
  assert.equal(manifest.protocols.a2a.endpoint, 'http://localhost/slotlock/a2a');
  const agentCard = await (
    await fetch(address.origin + '/slotlock/.well-known/agent-card.json')
  ).json();
  assert.equal(agentCard.supportedInterfaces[0].protocolVersion, SLOTLOCK_A2A_PROTOCOL_VERSION);
  assert.equal(agentCard.capabilities.streaming, false);

  const unauthorized = await fetch(address.origin + '/slotlock/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'unauthorized', method: 'tools/list' }),
  });
  assert.equal(unauthorized.status, 401);

  // MCP 2025-11-25: \`initialize\`, then every request names the negotiated revision in its header.
  const legacyHeaders = { 'MCP-Protocol-Version': SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION };
  const initialized = await rpc(
    '/slotlock/mcp',
    {
      jsonrpc: '2.0',
      id: 'initialize',
      method: 'initialize',
      params: {
        protocolVersion: SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'slotlock-clean-consumer', version: '1.0.0' },
      },
    },
  );
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get('mcp-protocol-version'), SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION);
  assert.equal(
    (await initialized.json()).result.protocolVersion,
    SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
  );

  const listed = await rpc(
    '/slotlock/mcp',
    { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} },
    legacyHeaders,
  );
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.ok(listedBody.result.tools.some((tool) => tool.name === 'slotlock_list_resources'));
  for (const tool of listedBody.result.tools) assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);

  const called = await rpc(
    '/slotlock/mcp',
    {
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'slotlock_list_resources', arguments: { limit: 2 } },
    },
    legacyHeaders,
  );
  assert.equal(called.status, 200);
  assert.equal((await called.json()).result.structuredContent.resources[0].id, 'resource-verification');

  // A client written against the pre-0.1 dotted names keeps working.
  const legacy = await rpc(
    '/slotlock/mcp',
    {
      jsonrpc: '2.0',
      id: 'legacy',
      method: 'tools/call',
      params: { name: 'calendar.list_resources', arguments: { limit: 2 } },
    },
    legacyHeaders,
  );
  assert.equal((await legacy.json()).result.structuredContent.resources[0].id, 'resource-verification');

  // A failure is an isError result with no structuredContent, which MCP SDKs validate.
  const invalid = await rpc(
    '/slotlock/mcp',
    {
      jsonrpc: '2.0',
      id: 'invalid',
      method: 'tools/call',
      params: { name: 'slotlock_get_event', arguments: {} },
    },
    legacyHeaders,
  );
  assert.equal(invalid.status, 200);
  const invalidResult = (await invalid.json()).result;
  assert.equal(invalidResult.isError, true);
  assert.equal(invalidResult.structuredContent, undefined);
  assert.deepEqual(JSON.parse(invalidResult.content[0].text), {
    error: { code: 'invalid_arguments' },
  });

  // MCP 2026-07-28: no handshake; every request carries the \`_meta\` envelope and mirrors it in headers.
  const modernMeta = {
    'io.modelcontextprotocol/protocolVersion': SLOTLOCK_MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'slotlock-clean-consumer', version: '1.0.0' },
  };
  const discovered = await rpc(
    '/slotlock/mcp',
    { jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: { _meta: modernMeta } },
    { 'MCP-Protocol-Version': SLOTLOCK_MCP_PROTOCOL_VERSION, 'Mcp-Method': 'server/discover' },
  );
  assert.equal(discovered.status, 200);
  const discoveredResult = (await discovered.json()).result;
  assert.equal(discoveredResult.resultType, 'complete');
  assert.ok(discoveredResult.supportedVersions.includes(SLOTLOCK_MCP_PROTOCOL_VERSION));
  assert.ok(discoveredResult.supportedVersions.includes(SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION));

  const modernCall = await rpc(
    '/slotlock/mcp',
    {
      jsonrpc: '2.0',
      id: 'modern-call',
      method: 'tools/call',
      params: {
        name: 'slotlock_list_resources',
        arguments: { limit: 2 },
        _meta: modernMeta,
      },
    },
    {
      'MCP-Protocol-Version': SLOTLOCK_MCP_PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'slotlock_list_resources',
    },
  );
  assert.equal(modernCall.status, 200);
  const modernResult = (await modernCall.json()).result;
  assert.equal(modernResult.resultType, 'complete');
  assert.equal(modernResult.structuredContent.resources[0].id, 'resource-verification');

  // Each tenant resource is an MCP resource a client can read and subscribe to.
  const resourceList = await rpc(
    '/slotlock/mcp',
    { jsonrpc: '2.0', id: 'resources', method: 'resources/list', params: { _meta: modernMeta } },
    { 'MCP-Protocol-Version': SLOTLOCK_MCP_PROTOCOL_VERSION, 'Mcp-Method': 'resources/list' },
  );
  assert.equal(resourceList.status, 200);
  const listedUris = (await resourceList.json()).result.resources.map((resource) => resource.uri);
  assert.ok(listedUris.includes(slotlockCalendarResourceUri('resource-verification')));

  const a2a = await rpc(
    '/slotlock/a2a',
    {
      jsonrpc: '2.0',
      id: 'a2a',
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'package-verification-message',
          role: 'ROLE_USER',
          parts: [
            {
              data: { skill: 'slotlock_list_resources', arguments: { limit: 2 } },
              mediaType: 'application/json',
            },
          ],
        },
      },
    },
    { 'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION },
  );
  assert.equal(a2a.status, 200);
  const a2aBody = await a2a.json();
  assert.equal(
    a2aBody.result.message.parts[0].data.resources[0].id,
    'resource-verification',
  );
  assert.equal(a2aBody.result.message.role, 'ROLE_AGENT');
  assert.equal(authorizationCount, 5);
} finally {
  assert.deepEqual(await listener.close(), { forced: false });
}
`;
writeFileSync(join(consumerRoot, 'smoke.mjs'), consumerSmoke);
execFileSync(process.execPath, ['smoke.mjs'], {
  cwd: consumerRoot,
  stdio: 'pipe',
  timeout: 15_000,
});

// The installed `slotlock` executable, run through the link npm created, against the consumer's
// lowest-admitted postgres. A minimal environment keeps a developer's own variables out of it.
const slotlockBin = join(consumerRoot, 'node_modules', '.bin', 'slotlock');
const binEnv = { PATH: process.env.PATH ?? '' };
function runBin(args, env = binEnv) {
  return spawnSync(slotlockBin, args, {
    cwd: consumerRoot,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}
const versionRun = runBin(['--version']);
assert.equal(versionRun.status, 0, versionRun.stderr);
assert.equal(versionRun.stdout, `${manifest.version}\n`);
const helpRun = runBin(['--help']);
assert.equal(helpRun.status, 0, helpRun.stderr);
assert.match(helpRun.stdout, /slotlock <command>[\s\S]*migrate[\s\S]*serve \[--migrate\]/);
const unconfigured = runBin(['serve']);
assert.equal(unconfigured.status, 2, 'serve without configuration must refuse to start');
assert.match(unconfigured.stderr, /DATABASE_URL is required/);
const weakToken = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const weakRun = runBin(['serve'], {
  ...binEnv,
  DATABASE_URL: 'postgresql://app:pw@127.0.0.1:1/slotlock',
  SLOTLOCK_AUTH_TOKEN: weakToken,
});
assert.equal(weakRun.status, 2, 'serve with a weak token must refuse to start');
assert.match(weakRun.stderr, /SLOTLOCK_AUTH_TOKEN is too weak/);
assert.ok(!weakRun.stderr.includes(weakToken), 'a refusal must not print the token');

// With a database, the packed executable migrates, serves MCP and stops on SIGTERM.
const databaseUrl = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
let liveServe = 'skipped (no DATABASE_URL)';
if (databaseUrl) {
  const token = randomBytes(32).toString('hex');
  const child = spawn(slotlockBin, ['serve', '--migrate'], {
    cwd: consumerRoot,
    env: {
      ...binEnv,
      DATABASE_URL: databaseUrl,
      SLOTLOCK_AUTH_TOKEN: token,
      SLOTLOCK_CONFIRMATION_SECRET: randomBytes(32).toString('hex'),
      SLOTLOCK_TENANT: 'package-verification',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    const listening = await new Promise((resolveListening, rejectListening) => {
      const timer = setTimeout(
        () => rejectListening(new Error(`packed serve did not start:\n${stdout}${stderr}`)),
        20_000,
      );
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const line = stdout.split('\n').find((entry) => entry.includes('"event":"listening"'));
        if (line) {
          clearTimeout(timer);
          resolveListening(JSON.parse(line));
        }
      });
      void exited.then((code) => {
        clearTimeout(timer);
        rejectListening(new Error(`packed serve exited ${code}:\n${stdout}${stderr}`));
      });
    });
    const health = await fetch(`${listening.address}/healthz`);
    assert.equal(health.status, 200, 'packed serve must report ready');
    const mcp = (body, headers = {}) =>
      fetch(`${listening.address}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const initialized = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'slotlock-package-verification', version: '1.0.0' },
      },
    });
    assert.equal((await initialized.json()).result.protocolVersion, '2025-11-25');
    const tools = await mcp(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'MCP-Protocol-Version': '2025-11-25' },
    );
    assert.equal((await tools.json()).result.tools.length, 8);
  } finally {
    child.kill('SIGTERM');
  }
  assert.equal(await exited, 0, `packed serve must stop cleanly on SIGTERM:\n${stderr}`);
  assert.match(stdout, /"event":"stopped"/);
  assert.ok(!stdout.includes(token) && !stderr.includes(token), 'serve must not log the token');
  liveServe = 'migrated, served MCP initialize/tools/list, stopped on SIGTERM';
}

// A strict TypeScript consumer: its own postgres client (and transaction) passes into the store,
// with `"types": []` (TypeScript 6's default) and library checking on, so a missing Node types
// reference or a second postgres type surfaces here rather than in someone's build.
const consumerTypes = `
import postgres from 'postgres';
import {
  type SlotlockSql,
  type SlotlockStore,
  createSlotlockAgentServer,
  createSlotlockStore,
  createSlotlockStoreAgentBackend,
  slotlockMcpToolResult,
  resolveSlotlockAgentOperation,
} from 'slotlock';
import { createSlotlockNodeServer } from 'slotlock/node-server';

const sql = postgres('postgresql://slotlock@localhost:5432/slotlock', { max: 1 });
const client: SlotlockSql = sql;
export const store: SlotlockStore = createSlotlockStore(client, { agentOwnerEventQuota: 500 });

export function prune(tenantRef: string): Promise<number> {
  return sql.begin(async (tx) => {
    const result = await createSlotlockStore(tx).pruneCalendarEventRetention({ tenantRef });
    return result.commandsDeleted + result.tombstonesDeleted;
  });
}

const server = createSlotlockAgentServer({
  publicBaseUrl: 'https://calendar.example.com/slotlock',
  backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
  authenticate: async (request: Request) =>
    request.headers.get('authorization') === 'Bearer token'
      ? { subject: 'agent-1', tenantRef: 'tenant-a' }
      : null,
  authorize: async ({ operation }) => operation === 'slotlock_list_resources',
  health: async () => ({ ready: true, checks: ['database'] }),
  oauth: { authorizationServers: ['https://auth.example.com'], requiredScopes: ['calendar'] },
});
export const listener = createSlotlockNodeServer(server, {
  requestOrigin: 'https://calendar.example.com',
});
export const failure = slotlockMcpToolResult({ ok: false, code: 'not_found' });
export const operation = resolveSlotlockAgentOperation('calendar.get_event');
`;
writeFileSync(join(consumerRoot, 'consumer.ts'), consumerTypes);
writeFileSync(
  join(consumerRoot, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        noEmit: true,
        types: [],
      },
      files: ['consumer.ts'],
    },
    null,
    2,
  )}\n`,
);
try {
  execFileSync(
    process.execPath,
    [join(packageRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: consumerRoot, encoding: 'utf8', stdio: 'pipe', timeout: 120_000 },
  );
} catch (error) {
  throw new Error(`strict TypeScript consumer failed to compile:\n${error.stdout ?? error}`);
}

process.stdout.write(
  `slotlock package smoke: ${files.size} clean files, clean consumer HTTP health/discovery/MCP/A2A passed, slotlock bin (live serve: ${liveServe}), strict TypeScript consumer (postgres ${consumerPostgres}, "types": []) compiled\n`,
);
