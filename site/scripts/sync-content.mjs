// Builds the docs and the landing page's facts from the repository, so neither can drift from it.
//
//   docs-src/*.md          hand-written pages with <!-- include … --> markers
//   ../README.md, SPEC.md, CHANGELOG.md, SECURITY.md   included by heading
//   ../src/*.ts            tool registry and schemas, protocol versions, limits, the exclusion
//                          constraint (the tools reference: scripts/tool-schemas.mjs, tools-page.mjs)
//
// Writes (all git-ignored, rebuilt on every `npm run dev` / `npm run build`):
//   src/content/docs/docs/*.md        the Starlight pages
//   src/generated/facts.json          numbers and names the landing page prints
//   public/schema/manifest.schema.json
//   public/openapi.json               the REST API, which client generators read
//
// Any fact it cannot find fails the build: a renamed constant must be looked at, not guessed.
import { statSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderApiReference } from './api-reference.mjs';
import { readOperations } from './tool-schemas.mjs';
import { renderToolsPage } from './tools-page.mjs';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(SITE, '..');
const REPO = 'https://github.com/PILOTAAI/slotlock';
const DOCS_SRC = join(SITE, 'docs-src');
const DOCS_OUT = join(SITE, 'src/content/docs/docs');
const GENERATED = join(SITE, 'src/generated');

const read = (path) => readFile(join(ROOT, path), 'utf8');

function fail(message) {
  console.error(`sync-content: ${message}`);
  process.exit(1);
}

function must(value, what) {
  if (value === undefined || value === null || value === '' || Number.isNaN(value)) {
    fail(`could not read ${what} from the source; update scripts/sync-content.mjs`);
  }
  return value;
}

/** GitHub-style heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Split markdown into sections keyed by heading slug; fenced code is never read as a heading. */
function sections(markdown) {
  const lines = markdown.split('\n');
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = /^(```+|~~~+)/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (line.startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) headings.push({ index, level: heading[1].length, text: heading[2].trim() });
  });
  const out = new Map();
  const text = (from, to) => lines.slice(from, to).join('\n').trim();
  headings.forEach((heading, i) => {
    const next = headings.slice(i + 1).find((h) => h.level <= heading.level);
    const end = next ? next.index : lines.length;
    const firstChild = headings[i + 1];
    const leadEnd = firstChild && firstChild.index < end ? firstChild.index : end;
    out.set(slug(heading.text), {
      heading: lines[heading.index],
      body: text(heading.index + 1, end),
      lead: text(heading.index + 1, leadEnd),
    });
  });
  // `_intro`: the text between the document title and its first section.
  const first = headings[0]?.level === 1 ? headings[1] : headings[0];
  const titleLine = headings[0]?.level === 1 ? headings[0].index + 1 : 0;
  out.set('_intro', { heading: '', body: text(titleLine, first ? first.index : lines.length) });
  return out;
}

/**
 * Render one included section. Modifiers: `body` drops the heading, `lead` stops at the first
 * subheading, `promote` raises every heading one level (### to ##, never above ##), for a README
 * subsection that is a section of its docs page.
 */
function renderSection(section, modifiers) {
  const words = new Set((modifiers ?? '').trim().split(/\s+/).filter(Boolean));
  const content = words.has('lead') ? section.lead : section.body;
  const text = words.has('body') || !section.heading ? content : `${section.heading}\n\n${content}`;
  return words.has('promote') ? promoteHeadings(text) : text;
}

/** ### to ##, #### to ###, … outside fenced code; ## stays ##. */
function promoteHeadings(markdown) {
  let fence = null;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^(```+|~~~+)/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (line.startsWith(fence)) fence = null;
        return line;
      }
      if (fence) return line;
      return line.replace(/^#(#{2,5}) /, '$1 ');
    })
    .join('\n');
}

const SITE_LINKS = {
  'SPEC.md': '/docs/specification/',
  'CHANGELOG.md': '/docs/changelog/',
  'slotlock-manifest.schema.json': '/schema/manifest.schema.json',
  'openapi.json': '/openapi.json',
  'clients/README.md': '/docs/clients/',
  'PRIVACY.md': '/docs/privacy/',
  'TERMS.md': '/docs/terms/',
  'ACCEPTABLE-USE.md': '/docs/acceptable-use/',
  'VERSIONING.md': '/docs/versioning/',
  'docs/hosted/README.md': '/docs/hosted/',
  'docs/hosted/status.md': '/docs/status/',
};

/** Repository sections that are docs pages of their own, included without their heading. */
const SECTION_LINKS = {
  'README.md#known-issues-in-020': '/docs/known-issues/',
};

/** README in-page anchors whose section lives on another docs page (postbuild checks every link). */
const ANCHORS = {
  '#application-api': '/docs/reference/#application-api',
  '#confirm-before-writing': '/docs/security/#confirmation-before-writes',
  '#operations': '/docs/operations/',
  '#rest-and-openapi': '/docs/reference/#rest-and-openapi',
};

/** Rewrite repository-relative links so they work on slotlock.pylota.io. */
function rewriteLinks(markdown) {
  const anchored = markdown.replace(/\]\((#[a-z0-9-]+)\)/g, (match, anchor) =>
    ANCHORS[anchor] ? `](${ANCHORS[anchor]})` : match,
  );
  return anchored.replace(/\]\((?:\.\/)?([A-Za-z0-9_./-]+?)(#[^)]*)?\)/g, (match, target, hash) => {
    if (/^(https?:|mailto:|#)/.test(target)) return match;
    // A file path from the repository root (GitHub reads /PRIVACY.md so); any other /path, such as
    // /docs/hosted/, is the site's.
    if (target.startsWith('/')) {
      if (!statSync(join(ROOT, target), { throwIfNoEntry: false })?.isFile()) return match;
      target = target.slice(1);
    }
    const section = SECTION_LINKS[`${target}${hash ?? ''}`];
    if (section) return `](${section})`;
    const site = SITE_LINKS[target];
    if (site) return `](${site}${hash ?? ''})`;
    const kind = target.endsWith('/') ? 'tree' : 'blob';
    return `](${REPO}/${kind}/main/${target}${hash ?? ''})`;
  });
}

function clean(markdown) {
  return rewriteLinks(markdown.replace(/^<!-- example: [^>]+ -->\n/gm, ''));
}

/**
 * A file's relative links as paths from the repository root, so an included clients/README.md's
 * `[python](python)` still names clients/python/ once rewriteLinks reads it. Directories end in `/`.
 */
function rebase(markdown, file) {
  const dir = posix.dirname(file);
  if (dir === '.') return markdown;
  return markdown.replace(/\]\((?:\.\/)?([A-Za-z0-9_./-]+?)(#[^)]*)?\)/g, (match, target, hash) => {
    if (/^(https?:|mailto:|\/|#)/.test(target)) return match;
    const path = posix.normalize(posix.join(dir, target));
    if (path.startsWith('..')) return match;
    const directory = statSync(join(ROOT, path), { throwIfNoEntry: false })?.isDirectory();
    return `](${path}${directory && !path.endsWith('/') ? '/' : ''}${hash ?? ''})`;
  });
}

const sourceCache = new Map();
async function sourceSections(file) {
  if (!sourceCache.has(file)) {
    const text = await read(file);
    sourceCache.set(file, { text, sections: sections(text) });
  }
  return sourceCache.get(file);
}

/** Expand the include markers of one docs-src page. */
async function expand(template, facts, page, toolsPage) {
  // Optional includes keep their fallback when the README section does not exist yet.
  const optional =
    /<!-- include\? ([^#\s]+)#([a-z0-9_-]+)((?: (?:body|lead|promote))*) -->\n([\s\S]*?)<!-- end include -->/g;
  let out = '';
  let last = 0;
  for (const match of template.matchAll(optional)) {
    out += template.slice(last, match.index);
    const [, file, anchor, modifiers, fallback] = match;
    const section = (await sourceSections(file)).sections.get(anchor);
    out += section ? `${renderSection(section, modifiers)}\n` : fallback;
    facts.optionalIncludes[`${file}#${anchor}`] = Boolean(section);
    last = match.index + match[0].length;
  }
  out += template.slice(last);

  const required =
    /<!-- include ([^#\s>]+)(?:#([a-z0-9_-]+))?((?: (?:body|lead|promote|snippet))*) -->/g;
  const parts = [];
  last = 0;
  for (const match of out.matchAll(required)) {
    parts.push(out.slice(last, match.index));
    const [, file, anchor, modifiers] = match;
    const source = await sourceSections(file);
    if (!anchor) {
      // Whole file without its title. `snippet` also drops its opening paragraph and a closing
      // pointer back to the overview, for a page that already says both once (a client's README).
      let whole = source.text.replace(/^# .*\n+/, '').trim();
      if (/\bsnippet\b/.test(modifiers)) {
        whole = whole
          .replace(/^(?!```)[^\n]+(?:\n(?!\n)[^\n]+)*\n+/, '')
          .replace(/\n+The \[clients overview\]\([^)]*\)[^\n]*$/, '')
          // A coordinate written for every release reads at this one's version on the site.
          .replace(/:<version>"/g, `:${facts.version}"`);
      }
      parts.push(rebase(whole, file));
    } else {
      const section = source.sections.get(anchor);
      if (!section) fail(`${page}: ${file} has no heading #${anchor}`);
      parts.push(rebase(renderSection(section, modifiers), file));
    }
    last = match.index + match[0].length;
  }
  parts.push(out.slice(last));
  // `<!-- code examples/store.ts#book -->`: a region of an example file, which the repository's
  // tests type-check and run, as a TypeScript block.
  const joined = parts.join('');
  const codeParts = [];
  last = 0;
  for (const match of joined.matchAll(/<!-- code ([^#\s]+)#([a-z0-9-]+) -->/g)) {
    codeParts.push(joined.slice(last, match.index));
    const [, file, region] = match;
    const text = await read(file);
    const found = new RegExp(
      `// #region ${region}\\n([\\s\\S]*?)// #endregion ${region}`,
    ).exec(text);
    if (!found) fail(`${page}: ${file} has no region ${region}`);
    codeParts.push(`\`\`\`ts\n${found[1].trimEnd()}\n\`\`\``);
    last = match.index + match[0].length;
  }
  codeParts.push(joined.slice(last));
  // Facts first: the generated tools reference is already final text.
  return clean(codeParts.join(''))
    .replace(/\{\{(\w+)\}\}/g, (_, key) => String(must(facts[key], `fact ${key}`)))
    .replace(/<!-- agent-setup-prompt -->/g, () => `\`\`\`markdown wrap\n${facts.agentSetupPrompt}\`\`\``)
    .replace(/<!-- tools-overview -->/g, () => toolsPage.overview)
    .replace(/<!-- tools-details -->/g, () => toolsPage.details)
    .replace(/<!-- tools-objects -->/g, () => toolsPage.objects);
}

/** Read the operation registry the MCP and A2A servers are projected from. */
function readTools(agentServer) {
  const start = agentServer.indexOf('const OPERATION_DEFINITIONS = [');
  const end = agentServer.indexOf('] as const satisfies readonly OperationDefinition[]');
  if (start < 0 || end < 0) fail('OPERATION_DEFINITIONS not found in src/agent-server.ts');
  const block = agentServer.slice(start, end);
  const tools = [];
  for (const chunk of block.split(/\n {2}\{\n {4}name: /).slice(1)) {
    const name = /^'([a-z_]+)'/.exec(chunk)?.[1];
    const title = /\n {4}title: '([^']+)'/.exec(chunk)?.[1];
    const description = /\n {4}description:\s*'((?:[^'\\]|\\.)+)'/.exec(chunk)?.[1];
    const risk =
      /\n {4}risk: \{ readOnly: (true|false), destructive: (true|false), idempotent: (true|false) \}/.exec(
        chunk,
      );
    must(name && title && description && risk, `tool definition near "${chunk.slice(0, 40)}"`);
    tools.push({
      name,
      title,
      description,
      readOnly: risk[1] === 'true',
      destructive: risk[2] === 'true',
      idempotent: risk[3] === 'true',
    });
  }
  if (tools.length === 0) fail('no tools read from OPERATION_DEFINITIONS');
  return tools;
}

function numberConst(source, name) {
  const match = new RegExp(`(?:export )?const ${name} = ([0-9_ *]+);`).exec(source);
  if (!match) return undefined;
  return match[1]
    .split('*')
    .map((part) => Number(part.trim().replace(/_/g, '')))
    .reduce((a, b) => a * b, 1);
}

function boundedDefault(source, name) {
  const match = new RegExp(`bounded\\('${name}', ([0-9_]+), ([0-9_]+), ([0-9_]+)\\)`).exec(source);
  return match ? Number(match[3].replace(/_/g, '')) : undefined;
}

async function readFacts() {
  const [pkg, agentServer, store, ddl, rules, config, eventFeed, selfHost, dashboard, clientDirs] =
    await Promise.all([
      read('package.json').then(JSON.parse),
      read('src/agent-server.ts'),
      read('src/store.ts'),
      read('src/ddl.ts'),
      read('src/rules.ts'),
      read('src/config.ts'),
      read('src/event-feed.ts'),
      read('src/self-host.ts'),
      read('src/dashboard.ts'),
      readdir(join(ROOT, 'clients'), { withFileTypes: true }),
    ]);
  const assistantSource = await read('src/assistant.ts');
  const conversationTtl = /conversationTtlMs \?\? ([0-9]+) \* 3_600_000/.exec(dashboard);
  const messageRate = /rate \?\? \{ perSecond: ([0-9]+) \/ 60,/.exec(dashboard);
  const assistantProviders = [
    ...dashboard.matchAll(/<option value="(?:anthropic|openai)"\$\{selected\('(?:anthropic|openai)'\)\}>([^<]+)<\/option>/g),
  ].map((match) => match[1]);
  const compatible = /`OpenAI-compatible`, which covers ([A-Za-z ,\n]+?)\),/.exec(await read('README.md'));
  // slotlock_hold_slots' input: how many candidates one call holds, and for how long.
  const holdInput =
    /\.max\(([0-9]+)\),\n\s+ttl_seconds: z\.number\(\)\.int\(\)\.min\(([0-9]+)\)\.max\(([0-9]+)\)/.exec(
      agentServer,
    );
  // The server's default per-holder caps (SLOTLOCK_LIMITS holder_holds, holder_held_hours).
  const holderCap = (name) => {
    const match = new RegExp(`\\n\\s+${name}: ([0-9_]+),`).exec(config);
    return match ? Number(match[1].replace(/_/g, '')) : undefined;
  };
  // The language clients, in the order clients/README.md lists them.
  const CLIENT_LABELS = [
    ['python', 'Python'],
    ['go', 'Go'],
    ['rust', 'Rust'],
    ['java', 'Java'],
    ['dotnet', '.NET'],
  ];
  const dirs = new Set(clientDirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  for (const dir of dirs) {
    if (!CLIENT_LABELS.some(([id]) => id === dir)) fail(`clients/${dir} has no label in sync-content.mjs`);
  }
  const clients = CLIENT_LABELS.filter(([id]) => dirs.has(id)).map(([, label]) => label);
  const tools = readTools(agentServer);
  const mcpModern = /SLOTLOCK_MCP_PROTOCOL_VERSION = '([0-9-]+)'/.exec(agentServer)?.[1];
  const mcpLegacy = /SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION = '([0-9-]+)'/.exec(agentServer)?.[1];
  const mcpOlder = /SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,\n\s+'([0-9-]+)',\n\] as const\)/.exec(
    agentServer,
  )?.[1];
  const a2a = /SLOTLOCK_A2A_PROTOCOL_VERSION = '([0-9.]+)'/.exec(agentServer)?.[1];
  const confirmTtl = /const ttlSeconds = value\.ttlSeconds \?\? ([0-9_]+);/.exec(agentServer)?.[1];
  const confirmRange = /ttlSeconds < ([0-9_]+) \|\| ttlSeconds > ([0-9_]+)\)/.exec(agentServer);
  const exclude =
    /( {2}CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist \([\s\S]*?\n {2}\))/.exec(
      ddl,
    )?.[1];
  const holdTtlMs = numberConst(store, 'MAX_HOLD_TTL_MS');
  const readme = await read('README.md');
  const readmeSections = sections(readme);
  const firstFence = (text, lang) =>
    new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\``).exec(text ?? '')?.[1];
  const quickStart = firstFence(readmeSections.get('quick-start-the-next-free-slot')?.body, 'ts');
  const claudeMcpAdd = /```sh\n(claude mcp add[\s\S]*?)\n```/.exec(readme)?.[1];
  const exampleResourceId = /const EXAMPLE_RESOURCE_ID = '([0-9a-f-]+)'/.exec(agentServer)?.[1];
  const exampleWindow = /const EXAMPLE_WINDOW = \{ start: '([^']+)', end: '([^']+)' \}/.exec(
    agentServer,
  );
  return {
    version: must(pkg.version, 'package.json version'),
    packageName: must(pkg.name, 'package.json name'),
    license: must(pkg.license, 'package.json license'),
    published: pkg.private !== true,
    nodeEngine: must(pkg.engines?.node, 'package.json engines.node'),
    postgresPeer: must(pkg.peerDependencies?.postgres, 'postgres peer range'),
    tools,
    toolCount: tools.length,
    readToolCount: tools.filter((tool) => tool.readOnly).length,
    writeToolCount: tools.filter((tool) => !tool.readOnly).length,
    mcpModern: must(mcpModern, 'SLOTLOCK_MCP_PROTOCOL_VERSION'),
    mcpLegacy: must(mcpLegacy, 'SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION'),
    mcpOlder: must(mcpOlder, 'the third supported MCP revision'),
    a2a: must(a2a, 'SLOTLOCK_A2A_PROTOCOL_VERSION'),
    horizonDays: must(numberConst(rules, 'SLOTLOCK_CALENDAR_HORIZON_DAYS'), 'horizon days'),
    maxEventDays: must(numberConst(store, 'SLOTLOCK_MAX_EVENT_DURATION_DAYS'), 'max event days'),
    maxEventDaysText: must(
      numberConst(store, 'SLOTLOCK_MAX_EVENT_DURATION_DAYS'),
      'max event days',
    ).toLocaleString('en-GB'),
    retentionDays: must(
      numberConst(store, 'SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS'),
      'retention days',
    ),
    // How long the change feed keeps changes, and the setting that changes it once the server has one.
    changeRetentionDays: must(
      numberConst(eventFeed, 'SLOTLOCK_CHANGE_RETENTION_DAYS'),
      'SLOTLOCK_CHANGE_RETENTION_DAYS',
    ),
    retentionSetting: selfHost.includes("'SLOTLOCK_RETENTION_DAYS'") ? 'SLOTLOCK_RETENTION_DAYS' : null,
    holdSlotsMax: must(holdInput && Number(holdInput[1]), 'slotlock_hold_slots slots max'),
    holdTtlMin: must(holdInput && Number(holdInput[2]), 'slotlock_hold_slots ttl minimum'),
    holdTtlMax: must(holdInput && Number(holdInput[3]), 'slotlock_hold_slots ttl maximum'),
    holderHolds: must(holderCap('holder_holds'), 'the holder_holds default'),
    holderHeldHours: must(holderCap('holder_held_hours'), 'the holder_held_hours default'),
    holderHeldHoursText: must(holderCap('holder_held_hours'), 'the holder_held_hours default').toLocaleString('en-GB'),
    dashboardOrgs: selfHost.includes("'SLOTLOCK_DASHBOARD_ORGS'"),
    metrics: selfHost.includes("'SLOTLOCK_METRICS_TOKEN'"),
    dashboardWorker: statSync(join(ROOT, 'workers/dashboard'), { throwIfNoEntry: false })?.isDirectory() ?? false,
    // The dashboard assistant (src/assistant.ts, src/dashboard.ts), offered once the server reads its secret.
    assistant: selfHost.includes("'SLOTLOCK_ASSISTANT_SECRET'"),
    assistantMaxSteps: must(
      numberConst(assistantSource, 'SLOTLOCK_ASSISTANT_MAX_STEPS'),
      'SLOTLOCK_ASSISTANT_MAX_STEPS',
    ),
    assistantMaxPending: must(
      numberConst(assistantSource, 'SLOTLOCK_ASSISTANT_MAX_PENDING'),
      'SLOTLOCK_ASSISTANT_MAX_PENDING',
    ),
    assistantConversationHours: must(
      conversationTtl && Number(conversationTtl[1]),
      'the conversationTtlMs default in src/dashboard.ts',
    ),
    assistantMessagesPerMinute: must(
      messageRate && Number(messageRate[1]),
      'the assistant rate default in src/dashboard.ts',
    ),
    assistantProviders: must(
      assistantProviders.length === 2 ? assistantProviders : undefined,
      'the provider options in src/dashboard.ts',
    ),
    assistantCompatible: must(
      compatible?.[1].replace(/\s+/g, ' ').split(/, | and /),
      'the OpenAI-compatible list in the README',
    ),
    dashboardAgendaDays: must(numberConst(dashboard, 'AGENDA_DAYS'), 'AGENDA_DAYS in src/dashboard.ts'),
    clients,
    clientCount: clients.length,
    eventQuota: must(numberConst(store, 'SLOTLOCK_AGENT_OWNER_EVENT_QUOTA'), 'event quota'),
    commandQuota: must(numberConst(store, 'SLOTLOCK_AGENT_OWNER_COMMAND_QUOTA'), 'command quota'),
    maxHoldDays: must(holdTtlMs && holdTtlMs / 86_400_000, 'MAX_HOLD_TTL_MS'),
    confirmTtlSeconds: must(confirmTtl && Number(confirmTtl.replace(/_/g, '')), 'confirmation ttl'),
    confirmTtlMin: must(confirmRange && Number(confirmRange[1].replace(/_/g, '')), 'ttl minimum'),
    confirmTtlMax: must(confirmRange && Number(confirmRange[2].replace(/_/g, '')), 'ttl maximum'),
    subscriptionsPerPrincipal: must(
      boundedDefault(agentServer, 'maxPerPrincipal'),
      'maxPerPrincipal',
    ),
    subscriptionsTotal: must(boundedDefault(agentServer, 'maxTotal'), 'maxTotal'),
    excludeConstraint: must(exclude, 'the reservations EXCLUDE constraint in src/ddl.ts')
      .split('\n')
      .map((line) => line.slice(2))
      .join('\n'),
    readmeQuickStart: must(quickStart, 'the README quick start TypeScript block'),
    // The Docker quickstart, offered on the landing page only while the README documents it.
    composeUp:
      readmeSections.get('self-host-with-docker')?.body.match(/^docker compose up[^\n]*$/m)?.[0] ??
      null,
    claudeMcpAdd: must(claudeMcpAdd, 'the README `claude mcp add` command'),
    exampleResourceId: must(exampleResourceId, 'EXAMPLE_RESOURCE_ID'),
    exampleWindow: {
      start: must(exampleWindow?.[1], 'EXAMPLE_WINDOW start'),
      end: must(exampleWindow?.[2], 'EXAMPLE_WINDOW end'),
    },
    optionalIncludes: {},
  };
}

/**
 * The tools reference: each operation's schemas and example, parsed from the registry, plus the
 * instructions the server gives the model. The names must match what readTools found.
 */
async function readToolsReference(facts) {
  const [agentServerOwn, eventSchema, store, backend, types, rules] = await Promise.all([
    read('src/agent-server.ts'),
    read('src/event-schema.ts'),
    read('src/store.ts'),
    read('src/agent-store-backend.ts'),
    read('src/types.ts'),
    read('src/rules.ts'),
  ]);
  // The event output lives in src/event-schema.ts, which the agent server imports as EVENT. Its
  // declarations come after the agent server's own, so a name both declare reads the agent server's.
  const eventOutput = eventSchema.replace(
    /^export const SLOTLOCK_EVENT_OUTPUT\b/m,
    'const EVENT',
  );
  if (eventOutput === eventSchema) fail('no SLOTLOCK_EVENT_OUTPUT in src/event-schema.ts');
  const agentServer = `${agentServerOwn}\n${eventOutput}\n`;
  let parsed;
  try {
    parsed = readOperations(agentServer, {
      SLOTLOCK_CALENDAR_HORIZON_DAYS: numberConst(rules, 'SLOTLOCK_CALENDAR_HORIZON_DAYS'),
      SLOTLOCK_MAX_EVENT_DURATION_DAYS: numberConst(store, 'SLOTLOCK_MAX_EVENT_DURATION_DAYS'),
    });
  } catch (error) {
    fail(`could not read the tool schemas from src/agent-server.ts: ${error.message}`);
  }
  const { operations, reader } = parsed;
  const names = operations.map((operation) => operation.name).join(',');
  if (names !== facts.tools.map((tool) => tool.name).join(',')) {
    fail(`the schema reader found ${names}, the registry reader ${facts.tools.map((t) => t.name)}`);
  }
  facts.mcpInstructions = must(
    reader.value(reader.declaration('SLOTLOCK_MCP_INSTRUCTIONS')),
    'SLOTLOCK_MCP_INSTRUCTIONS',
  );
  const page = renderToolsPage({ operations, facts, sources: [agentServer, backend, types], fail });
  facts.commonErrors = page.commonErrors;
  return { page, toolExamples: Object.fromEntries(operations.map((op) => [op.name, op.example])) };
}

async function main() {
  const facts = await readFacts();
  const { page: toolsPage, toolExamples } = await readToolsReference(facts);
  // The prompt for a coding agent: a docs page shows it and /slotlock-setup-prompt.md serves it.
  facts.agentSetupPrompt = (
    await readFile(join(SITE, 'src/data/agent-setup-prompt.md'), 'utf8')
  ).replace(/\{\{(\w+)\}\}/g, (_, key) => String(must(facts[key], `fact ${key}`)));
  await rm(join(SITE, 'src/content/docs'), { recursive: true, force: true });
  await mkdir(DOCS_OUT, { recursive: true });
  await mkdir(GENERATED, { recursive: true });

  const pages = (await readdir(DOCS_SRC)).filter((file) => file.endsWith('.md')).sort();
  for (const page of pages) {
    const template = await readFile(join(DOCS_SRC, page), 'utf8');
    const body = await expand(template, facts, page, toolsPage);
    if (/<!-- include/.test(body)) fail(`${page}: an include marker was left unexpanded`);
    // 404.md is Starlight's not-found page and lives at the collection root.
    await writeFile(page === '404.md' ? join(DOCS_OUT, '..', page) : join(DOCS_OUT, page), body);
  }

  await mkdir(join(SITE, 'public/schema'), { recursive: true });
  const schema = JSON.parse(await read('slotlock-manifest.schema.json'));
  if (schema.$id !== 'https://slotlock.pylota.io/schema/manifest.schema.json') {
    fail(`slotlock-manifest.schema.json has $id ${schema.$id}, not the slotlock.pylota.io URL`);
  }
  await copyFile(
    join(ROOT, 'slotlock-manifest.schema.json'),
    join(SITE, 'public/schema/manifest.schema.json'),
  );
  const openApi = JSON.parse(await read('openapi.json'));
  if (openApi.openapi !== '3.1.0' || openApi.servers?.[0]?.url !== '{baseUrl}') {
    fail('openapi.json is not the repository\'s OpenAPI 3.1 document with a {baseUrl} server');
  }
  await copyFile(join(ROOT, 'openapi.json'), join(SITE, 'public/openapi.json'));

  // The REST reference and the Postman collection, both from openapi.json.
  const api = renderApiReference({ openApi, version: facts.version, toolExamples, fail });
  await mkdir(join(DOCS_OUT, 'api'), { recursive: true });
  await writeFile(join(DOCS_OUT, 'api', 'index.md'), api.overview);
  for (const apiPage of api.pages) {
    await writeFile(join(DOCS_OUT, 'api', `${apiPage.slug}.md`), apiPage.markdown);
  }
  await writeFile(join(SITE, 'public/slotlock-setup-prompt.md'), facts.agentSetupPrompt);
  await writeFile(
    join(SITE, 'public/slotlock.postman_collection.json'),
    `${JSON.stringify(api.postman, null, 2)}\n`,
  );

  await writeFile(join(GENERATED, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
  const { tokensCss } = await import('../src/styles/tokens.mjs');
  await writeFile(join(GENERATED, 'tokens.css'), tokensCss());
  const missing = Object.entries(facts.optionalIncludes)
    .filter(([, found]) => !found)
    .map(([key]) => key);
  console.log(
    `sync-content: ${pages.length} docs pages, ${api.operationCount} REST pages, ${facts.toolCount} tools, version ${facts.version}` +
      (missing.length
        ? ` (README sections not there yet, fallback used: ${missing.join(', ')})`
        : ''),
  );
}

await main();
