// Finding a resource by what a person calls it (resource-search.ts): the edge cases people and
// models bring, each held to an answer.
import { describe, expect, it } from 'vitest';
import { SLOTLOCK_AGENT_RESOURCE_SEARCH_MAX } from '../agent-server.js';
import { SLOTLOCK_RESOURCE_SEARCH_MAX, slotlockResourceSearchWords, slotlockSearchResources } from '../resource-search.js';

const fleet = [
  { id: 'r1', externalRef: 'car-17', name: 'Mercedes-Benz 2025', kind: 'vehicle' as const, labels: ['ev', 'white'], locationName: 'Heathrow' },
  { id: 'r2', externalRef: 'car-18', name: 'Mercedes-Benz 2019', kind: 'vehicle' as const, labels: ['diesel'], locationName: 'Gatwick' },
  { id: 'r3', externalRef: 'phase-b-exit-20261108T142642Z-3444' },
  { id: 'r4', externalRef: 'room-zurich', name: 'Zürich boardroom', kind: 'room' as const, description: 'Seats twelve, with a projector' },
  { id: 'r5', externalRef: '100%_ready', name: 'Ford Transit' },
];

const find = (query: string) => slotlockSearchResources(fleet, slotlockResourceSearchWords(query)).map((match) => match.resource.id);

describe('finding a resource by what a person calls it', () => {
  it('finds it by its name or reference, whatever the case', () => {
    expect(find('Mercedes-Benz 2025')[0]).toBe('r1');
    expect(find('MERCEDES BENZ 2025')[0]).toBe('r1');
    expect(find('car-18')[0]).toBe('r2');
    expect(find('phase-b-exit-20261108T142642Z-3444')).toEqual(['r3']);
    expect(find('phase-b-exit')).toEqual(['r3']);
  });

  it('forgives a typo, a word cut short, words run together or split, and accents', () => {
    expect(find('mercedez 2025')[0]).toBe('r1');
    expect(find('merc 2025')[0]).toBe('r1');
    expect(find('mercedesbenz 2025')[0]).toBe('r1');
    expect(find('car17')[0]).toBe('r1');
    expect(find('car 17')[0]).toBe('r1');
    expect(find('zurich')).toEqual(['r4']);
    expect(find('ZÜRICH')).toEqual(['r4']);
    expect(find('fird transit')).toEqual(['r5']);
  });

  it('finds it by what describes it: labels, kind, location, description', () => {
    expect(find('white ev')[0]).toBe('r1');
    expect(find('the van at heathrow')[0]).toBe('r1');
    expect(find('projector')).toEqual(['r4']);
    expect(find('room')).toEqual(['r4']);
  });

  it('ranks the best first, keeps close ones after, and never matches numbers loosely', () => {
    const ranked = slotlockSearchResources(fleet, slotlockResourceSearchWords('mercedes 2025'));
    expect(ranked.map((match) => match.resource.id)).toEqual(['r1', 'r2']);
    expect(ranked[0]?.score).toBe(1);
    expect((ranked[1]?.score ?? 1) < (ranked[0]?.score ?? 0)).toBe(true);
    // 2026 is not 2025: only the word mercedes finds them, half the search.
    expect(slotlockSearchResources(fleet, slotlockResourceSearchWords('mercedes 2026')).every((match) => match.score <= 0.5)).toBe(true);
    expect(find('2026')).toEqual(['r3']);
  });

  it('finds nothing for what nothing is called, and looks for symbols as written', () => {
    expect(find('tesla')).toEqual([]);
    expect(find('%')).toEqual(['r5']);
    expect(find('_')).toEqual(['r5']);
  });

  it('reads a search into words, dropping filler, and refuses one that is empty, too long or too many words', () => {
    expect(slotlockResourceSearchWords('  the Mercedes   2025 mercedes ')).toEqual(['mercedes', '2025']);
    expect(slotlockResourceSearchWords('the')).toEqual(['the']);
    expect(() => slotlockResourceSearchWords('   ')).toThrow(expect.objectContaining({ code: 'invalid_query' }));
    expect(() => slotlockResourceSearchWords('a b c d e f g h i j k l m')).toThrow(expect.objectContaining({ code: 'invalid_query' }));
    expect(() => slotlockResourceSearchWords('é'.repeat(201))).toThrow(expect.objectContaining({ code: 'invalid_query' }));
  });

  it('bounds a search as the agent tool does', () => {
    expect(SLOTLOCK_AGENT_RESOURCE_SEARCH_MAX).toBe(SLOTLOCK_RESOURCE_SEARCH_MAX);
  });
});
