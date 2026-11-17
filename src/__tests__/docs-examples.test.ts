// Every TypeScript example the docs show is a checked region of examples/*.ts. The README quotes
// each of its blocks after an `<!-- example: <file>#<region> -->` marker; the docs site's pages
// (site/docs-src) name theirs with `<!-- code <file>#<region> -->`, which the site build expands.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { slot } from '../../examples/availability.js';
import { oauth } from '../../examples/oauth.js';
import {
  createSlotlockAgentServer,
  slotlockAgentOperationScope,
  slotlockAgentTools,
} from '../agent-server.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(packageRoot, path), 'utf8');
const readme = read('README.md');
const pages = readdirSync(join(packageRoot, 'site', 'docs-src'))
  .filter((file) => file.endsWith('.md'))
  .map((file) => [`site/docs-src/${file}`, read(`site/docs-src/${file}`)] as const);

function region(file: string, name: string): string {
  const source = read(file);
  const open = `// #region ${name}\n`;
  const start = source.indexOf(open);
  const end = source.indexOf(`// #endregion ${name}\n`);
  if (start < 0 || end < start) throw new Error(`${file} has no region ${name}`);
  return source.slice(start + open.length, end);
}

/** `file#region` for every example marker in the README and every code marker on a docs page. */
function shown(): Map<string, string> {
  const where = new Map<string, string>();
  for (const [, file, name] of readme.matchAll(/<!-- example: ([^#\s]+)#([\w-]+) -->/g)) {
    where.set(`${file}#${name}`, 'README.md');
  }
  for (const [page, text] of pages) {
    for (const [, file, name] of text.matchAll(/<!-- code ([^#\s]+)#([\w-]+) -->/g)) {
      where.set(`${file}#${name}`, page);
    }
  }
  return where;
}

describe('documentation examples', () => {
  it('quotes every README TypeScript block from a checked example region', () => {
    const blocks = [
      ...readme.matchAll(/(<!-- example: ([^#\s]+)#([\w-]+) -->\n)?```ts\n([\s\S]*?)```/g),
    ];
    expect(blocks.length, 'canary: the README quick start is TypeScript').toBeGreaterThan(0);
    for (const [, marker, file, name, code] of blocks) {
      expect(marker, `README ts block without an example marker:\n${code}`).toBeDefined();
      expect(code, `${file}#${name}`).toBe(region(file as string, name as string));
    }
  });

  it('names only example regions that exist on the docs pages', () => {
    for (const [page, text] of pages) {
      for (const [, file, name] of text.matchAll(/<!-- code ([^#\s]+)#([\w-]+) -->/g)) {
        expect(() => region(file as string, name as string), page).not.toThrow();
      }
    }
  });

  it('shows every example region in the README or on a docs page', () => {
    const where = shown();
    expect(where.size, 'canary: the docs show the examples').toBeGreaterThanOrEqual(10);
    for (const file of readdirSync(join(packageRoot, 'examples'))) {
      const source = read(`examples/${file}`);
      for (const [, name] of source.matchAll(/^\/\/ #region ([\w-]+)$/gm)) {
        expect(where.has(`examples/${file}#${name}`), `examples/${file}#${name} is not shown`).toBe(
          true,
        );
      }
    }
  });

  it('counts the tools the read scope covers as the code scopes them', () => {
    const reads = slotlockAgentTools().filter(
      ({ name }) => slotlockAgentOperationScope(name) === 'read',
    );
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    expect(reads.length, 'canary: a count the keys page can spell').toBeLessThan(words.length);
    expect(read('site/docs-src/keys.md')).toContain(
      `\`read\` covers the ${words[reads.length]} tools that only look`,
    );
  });

  it("shows the application API's hours body as the REST schema takes it", () => {
    expect(read('site/docs-src/reference.md')).toMatch(
      /^\| `PUT \/v1\/resources\/\{resource_id\}\/availability` \| `\{"rules":\[…\]\}`:/m,
    );
  });

  it('finds the slot the quick start promises', () => {
    expect(slot).toEqual({
      start: new Date('2026-09-14T10:00:00Z'),
      end: new Date('2026-09-14T12:00:00Z'),
    });
  });

  it('accepts the documented OAuth discovery options', async () => {
    const server = createSlotlockAgentServer({
      publicBaseUrl: 'https://calendar.example.com/slotlock',
      backend: {} as never,
      authenticate: async () => null,
      authorize: async () => false,
      health: async () => ({ ready: true, checks: [] }),
      oauth,
    });
    const metadata = await server.fetch(
      new Request('https://calendar.example.com/.well-known/oauth-protected-resource/slotlock/mcp'),
    );
    expect(await metadata.json()).toMatchObject({
      resource: 'https://calendar.example.com/slotlock/mcp',
      authorization_servers: ['https://auth.example.com'],
    });
  });
});
