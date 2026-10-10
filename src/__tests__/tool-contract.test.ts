// The tool list is the contract every agent reads, so it changes only on purpose: a dependency bump
// that changes what the schemas say fails here. (Zod 4 through zod-to-json-schema turned every
// schema into `{}`, and the official MCP SDKs then refused the whole list.)
import { describe, expect, it } from 'vitest';
import { slotlockAgentTools } from '../agent-server.js';

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(nodes)];
}

describe('advertised tool contract', () => {
  it('matches the committed contract', async () => {
    await expect(`${JSON.stringify(slotlockAgentTools(), null, 2)}\n`).toMatchFileSnapshot(
      './tool-contract.json',
    );
  });

  it('describes every input and output as an object with properties', () => {
    for (const tool of slotlockAgentTools()) {
      for (const schema of [tool.inputSchema, tool.outputSchema] as Record<string, unknown>[]) {
        expect(schema, tool.name).toMatchObject({ type: 'object' });
        expect(Object.keys((schema.properties ?? {}) as object), tool.name).not.toHaveLength(0);
      }
    }
  });

  it('states a format without restating it as a pattern', () => {
    const formatted = nodes(slotlockAgentTools()).filter((node) => typeof node.format === 'string');
    expect(formatted.length).toBeGreaterThan(0);
    for (const node of formatted) expect(node).not.toHaveProperty('pattern');
  });
});
