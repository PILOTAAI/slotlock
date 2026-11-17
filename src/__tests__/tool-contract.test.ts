// The tool list is the contract every agent reads, so a dependency bump that changes the schemas
// fails here (zod 4 through zod-to-json-schema once made every schema `{}`).
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

  // MCP's destructiveHint: a client that confirms destructive calls (Claude does) asks a person
  // first. Overwriting or moving a booking is destructive even though it can be undone; letting go
  // of one's own hold, which lapses within minutes anyway, is not.
  it('marks every write that overwrites, moves or removes a booking destructive', () => {
    const destructive = slotlockAgentTools()
      .filter((tool) => tool.annotations.destructiveHint)
      .map((tool) => tool.name)
      .sort();
    expect(destructive).toEqual(['slotlock_cancel', 'slotlock_delete_event', 'slotlock_reschedule', 'slotlock_update_event']);
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
