import { describe, expect, it } from 'vitest';
import { SLOTLOCK_ASSISTANT_TOOL_USE } from '../assistant.js';
import { slotlockAssistantActionVerb, slotlockAssistantStepLabel } from '../dashboard-assistant-ui.js';

const offered = (use: 'read' | 'propose') =>
  Object.entries(SLOTLOCK_ASSISTANT_TOOL_USE)
    .filter(([, each]) => each === use)
    .map(([operation]) => operation);

describe('the assistant names every tool it offers', () => {
  it.each(offered('read'))('says what %s does in words of its own, not its title', (operation) => {
    const title = 'Tool title';
    for (const state of ['run', 'ok', 'bad'] as const) {
      expect(slotlockAssistantStepLabel(operation, title, state)).not.toContain(title);
    }
  });

  it.each(offered('propose'))('approves %s with a verb that says what it does', (operation) => {
    expect(slotlockAssistantActionVerb(operation).verb).not.toBe('Approve');
  });

  it('holds a set held together as it holds one slot, and names a range search', () => {
    expect(slotlockAssistantActionVerb('slotlock_hold_together')).toEqual(slotlockAssistantActionVerb('slotlock_hold_slots'));
    expect(slotlockAssistantStepLabel('slotlock_find_available_ranges', 'Find available ranges', 'ok')).toBe('Found free ranges');
  });
});
