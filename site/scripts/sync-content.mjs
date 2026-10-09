// Builds the docs and the landing page's facts from the repository, so neither can drift from it.
//
//   docs-src/*.md          hand-written pages with <!-- include … --> markers
//   ../README.md, SPEC.md, CHANGELOG.md, SECURITY.md   included by heading
//   ../src/*.ts            tool registry, protocol versions, limits, the exclusion constraint
//
// Writes (all git-ignored, rebuilt on every `npm run dev` / `npm run build`):
//   src/content/docs/docs/*.md        the Starlight pages
//   src/generated/facts.json          numbers and names the landing page prints
//   public/schema/manifest.schema.json
//
// Any fact it cannot find fails the build: a renamed constant must be looked at, not guessed.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Render one included section. Modifiers: `body` drops the heading, `lead` stops at the first subheading. */
function renderSection(section, modifiers) {
  const words = new Set((modifiers ?? '').trim().split(/\s+/).filter(Boolean));
  const content = words.has('lead') ? section.lead : section.body;
  return words.has('body') || !section.heading ? content : `${section.heading}\n\n${content}`;
}

const SITE_LINKS = {
  'SPEC.md': '/docs/specification/',
  'CHANGELOG.md': '/docs/changelog/',
  'slotlock-manifest.schema.json': '/schema/manifest.schema.json',
};

/** README in-page anchors whose section lives on another docs page (postbuild checks every link). */
const ANCHORS = {
  '#confirm-before-writing': '/docs/security/#confirmation-before-writes',
};

/** Rewrite repository-relative links so they work on slotlock.pylota.io. */
function rewriteLinks(markdown) {
  const anchored = markdown.replace(/\]\((#[a-z0-9-]+)\)/g, (match, anchor) =>
    ANCHORS[anchor] ? `](${ANCHORS[anchor]})` : match,
  );
  return anchored.replace(/\]\((?:\.\/)?([A-Za-z0-9_./-]+?)(#[^)]*)?\)/g, (match, target, hash) => {
    if (/^(https?:|mailto:|\/|#)/.test(target)) return match;
    const site = SITE_LINKS[target];
    if (site) return `](${site}${hash ?? ''})`;
    const kind = target.endsWith('/') ? 'tree' : 'blob';
    return `](${REPO}/${kind}/main/${target}${hash ?? ''})`;
  });
}

function clean(markdown) {
  return rewriteLinks(markdown.replace(/^<!-- example: [^>]+ -->\n/gm, ''));
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
async function expand(template, facts, page) {
  // Optional includes keep their fallback when the README section does not exist yet.
  const optional =
    /<!-- include\? ([^#\s]+)#([a-z0-9_-]+)((?: (?:body|lead))*) -->\n([\s\S]*?)<!-- end include -->/g;
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

  const required = /<!-- include ([^#\s>]+)(?:#([a-z0-9_-]+))?((?: (?:body|lead))*) -->/g;
  const parts = [];
  last = 0;
  for (const match of out.matchAll(required)) {
    parts.push(out.slice(last, match.index));
    const [, file, anchor, modifiers] = match;
    const source = await sourceSections(file);
    if (!anchor) {
      // Whole file without its title.
      parts.push(source.text.replace(/^# .*\n+/, '').trim());
    } else {
      const section = source.sections.get(anchor);
      if (!section) fail(`${page}: ${file} has no heading #${anchor}`);
      parts.push(renderSection(section, modifiers));
    }
    last = match.index + match[0].length;
  }
  parts.push(out.slice(last));
  return clean(parts.join(''))
    .replace(/<!-- tools-table -->/g, toolsTable(facts.tools))
    .replace(/\{\{(\w+)\}\}/g, (_, key) => String(must(facts[key], `fact ${key}`)));
}

function toolsTable(tools) {
  const hint = (tool) =>
    tool.readOnly ? 'read-only' : tool.destructive ? 'write, destructive' : 'write';
  return [
    '| Tool | Title | Description | Hints |',
    '| --- | --- | --- | --- |',
    ...tools.map(
      (tool) =>
        `| \`${tool.name}\` | ${tool.title} | ${tool.description.replace(/\|/g, '\\|')} | ${hint(tool)}${tool.idempotent ? ', idempotent' : ''} |`,
    ),
  ].join('\n');
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
  const [pkg, agentServer, store, ddl] = await Promise.all([
    read('package.json').then(JSON.parse),
    read('src/agent-server.ts'),
    read('src/store.ts'),
    read('src/ddl.ts'),
  ]);
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
    horizonDays: must(numberConst(store, 'SLOTLOCK_CALENDAR_HORIZON_DAYS'), 'horizon days'),
    maxEventDays: must(numberConst(store, 'SLOTLOCK_MAX_EVENT_DURATION_DAYS'), 'max event days'),
    retentionDays: must(
      numberConst(store, 'SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS'),
      'retention days',
    ),
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

async function main() {
  const facts = await readFacts();
  await rm(join(SITE, 'src/content/docs'), { recursive: true, force: true });
  await mkdir(DOCS_OUT, { recursive: true });
  await mkdir(GENERATED, { recursive: true });

  const pages = (await readdir(DOCS_SRC)).filter((file) => file.endsWith('.md')).sort();
  for (const page of pages) {
    const template = await readFile(join(DOCS_SRC, page), 'utf8');
    const body = await expand(template, facts, page);
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

  await writeFile(join(GENERATED, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
  const { tokensCss } = await import('../src/styles/tokens.mjs');
  await writeFile(join(GENERATED, 'tokens.css'), tokensCss());
  const missing = Object.entries(facts.optionalIncludes)
    .filter(([, found]) => !found)
    .map(([key]) => key);
  console.log(
    `sync-content: ${pages.length} docs pages, ${facts.toolCount} tools, version ${facts.version}` +
      (missing.length
        ? ` (README sections not there yet, fallback used: ${missing.join(', ')})`
        : ''),
  );
}

await main();
