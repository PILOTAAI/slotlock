// The README's TypeScript is quoted from examples/*.ts, which `tsc -p tsconfig.examples.json`
// typechecks and examples.integration.test.ts runs against PostgreSQL. This keeps the quotes exact:
// every ```ts block follows an `<!-- example: <file>#<region> -->` marker and equals that region.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { slot } from '../../examples/availability.js';
import { oauth } from '../../examples/oauth.js';
import { createSlotlockAgentServer } from '../agent-server.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');

function region(file: string, name: string): string {
  const source = readFileSync(join(packageRoot, file), 'utf8');
  const open = `// #region ${name}\n`;
  const start = source.indexOf(open);
  const end = source.indexOf(`// #endregion ${name}\n`);
  if (start < 0 || end < start) throw new Error(`${file} has no region ${name}`);
  return source.slice(start + open.length, end);
}

describe('README examples', () => {
  it('quotes every TypeScript block from a checked example region', () => {
    const blocks = [
      ...readme.matchAll(/(<!-- example: ([^#\s]+)#([\w-]+) -->\n)?```ts\n([\s\S]*?)```/g),
    ];
    expect(blocks.length).toBeGreaterThanOrEqual(10);
    for (const [, marker, file, name, code] of blocks) {
      expect(marker, `README ts block without an example marker:\n${code}`).toBeDefined();
      expect(code, `${file}#${name}`).toBe(region(file as string, name as string));
    }
  });

  it('quotes every example region', () => {
    const quoted = new Set(
      [...readme.matchAll(/<!-- example: ([^#\s]+)#([\w-]+) -->/g)].map(
        ([, file, name]) => `${file}#${name}`,
      ),
    );
    for (const file of readdirSync(join(packageRoot, 'examples'))) {
      const source = readFileSync(join(packageRoot, 'examples', file), 'utf8');
      for (const [, name] of source.matchAll(/^\/\/ #region ([\w-]+)$/gm)) {
        expect(quoted, `examples/${file}#${name} is not in the README`).toContain(
          `examples/${file}#${name}`,
        );
      }
    }
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
