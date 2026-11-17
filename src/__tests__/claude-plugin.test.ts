// The Claude Code plugin marketplace this repository serves (.claude-plugin/marketplace.json): its
// plugin points at Slotlock Cloud's MCP endpoint, follows the repository's commits, and its skills
// say only what Slotlock does: the tools they name exist, the refusals they explain are ones the
// server gives, and the setup skill is the docs site's setup prompt, word for word.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { slotlockAgentTools } from '../agent-server.js';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const PLUGIN = 'plugins/slotlock';
/** A skill's body, after its frontmatter. */
const body = (skill: string) => read(`${PLUGIN}/skills/${skill}/SKILL.md`).replace(/^---\n[\s\S]*?\n---\n\n/, '');

describe('the Claude Code plugin marketplace', () => {
  it('lists the slotlock plugin from this repository', () => {
    const marketplace = json('.claude-plugin/marketplace.json');
    expect(marketplace).toMatchObject({ name: 'slotlock', owner: { name: 'PILOTAAI' } });
    const plugins = marketplace.plugins as { name: string; source: string }[];
    expect(plugins.map((plugin) => [plugin.name, plugin.source])).toEqual([['slotlock', `./${PLUGIN}`]]);
    const manifest = json(`${PLUGIN}/.claude-plugin/plugin.json`);
    expect(manifest.name).toBe('slotlock');
    // No version: an install follows the repository's commits, so it never goes stale behind a
    // version nobody bumped (Claude Code then versions it by commit).
    expect(manifest).not.toHaveProperty('version');
    expect(manifest.privacyPolicyUrl).toBe('https://slotlock.pylota.io/docs/privacy/');
  });

  it("connects to Slotlock Cloud's MCP endpoint with the key from the environment", () => {
    const hosted = /^\| MCP \| `([^`]+)` \|$/m.exec(read('docs/hosted/README.md'))?.[1];
    expect(hosted, 'canary: the hosted MCP address').toBe('https://slotlock-api.pylota.io/mcp');
    expect(json(`${PLUGIN}/.mcp.json`)).toEqual({
      mcpServers: {
        slotlock: { type: 'http', url: hosted, headers: { Authorization: 'Bearer ${SLOTLOCK_API_KEY}' } },
      },
    });
  });

  it("makes the setup skill the docs site's setup prompt, word for word", () => {
    const prompt = read('site/src/data/agent-setup-prompt.md');
    const published = ' It was {{version}} when this prompt was published.';
    expect(prompt, 'canary: the prompt names its version').toContain(published);
    expect(body('set-up-slotlock')).toBe(prompt.replace(published, ''));
  });

  it('names only tools that exist, and refusals the server gives', () => {
    const skill = body('book-with-slotlock');
    const tools = new Set<string>(slotlockAgentTools().map((tool) => tool.name));
    const named = [...new Set(skill.match(/slotlock_[a-z_]+/g) ?? [])];
    expect(named.length).toBeGreaterThan(10);
    for (const name of named) expect(tools.has(name), name).toBe(true);
    // The agent server's own codes, and the store's, which its backend passes on.
    const server = ['src/agent-server.ts', 'src/agent-store-backend.ts', 'src/store.ts'].map(read).join('\n');
    const codes = [...skill.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1] as string);
    expect(codes).toEqual(expect.arrayContaining(['overlap', 'approval_pending', 'revision_conflict']));
    for (const code of codes) expect(server, code).toMatch(new RegExp(`['\`]${code}['\`]`));
  });

  it("uses the brand's own icon", () => {
    expect(readFileSync(new URL(`../../${PLUGIN}/.claude-plugin/icon.png`, import.meta.url))).toEqual(
      readFileSync(new URL('../../site/public/brand/slotlock-512.png', import.meta.url)),
    );
  });
});
