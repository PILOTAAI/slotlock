// Finding a resource by what a person calls it: the agent tools take a resource's id, and a person
// names it ("the Mercedes", "mercedez benz 2025", "car 17", "Zürich room"). This ranks a tenant's
// resources against such words, forgiving what people and models get wrong: case, accents, words
// run together or split ("mercedesbenz"), a word cut short ("merc"), a typo ("mercedez"), and words
// that describe it rather than name it (its labels, kind, location or description). Best first.
// Numbers are never matched loosely: "2025" is not "2026". What it cannot know (that a van is a
// vehicle) is the model's to judge, with the resources in front of it.
import type { SlotlockResource } from './types.js';

/** The longest search, and the most words one may have once read. */
export const SLOTLOCK_RESOURCE_SEARCH_MAX = 200;
const MAX_WORDS = 12;

/** What a search looks at: a resource as listResources gives it. */
export type SlotlockSearchableResource = Pick<
  SlotlockResource,
  'id' | 'externalRef' | 'name' | 'description' | 'kind' | 'labels' | 'locationName' | 'location'
>;

/** Words that say nothing about which resource is meant, when others do. */
const FILLER = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'of', 'for', 'at', 'in', 'on', 'to', 'and', 'with']);

/** Lower case, accents and other marks taken off: "Zürich" reads as "zurich". */
const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
const wordsOf = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');

/**
 * A search's words, or `invalid_query` when it is empty, longer than 200 characters or more than 12
 * words. Filler ("the", "my") is dropped when other words remain.
 */
export function slotlockResourceSearchWords(query: string): string[] {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (trimmed === '' || [...trimmed].length > SLOTLOCK_RESOURCE_SEARCH_MAX) throw invalidQuery();
  const words = [...new Set(wordsOf(trimmed))];
  if (words.length > MAX_WORDS) throw invalidQuery();
  const meaningful = words.filter((word) => !FILLER.has(word));
  // Only symbols ("%", "#"): looked for as written.
  if (words.length === 0) return [fold(trimmed)];
  return meaningful.length > 0 ? meaningful : words;
}

function invalidQuery() {
  return Object.assign(
    new Error(
      `Slotlock resource search must be 1-${String(SLOTLOCK_RESOURCE_SEARCH_MAX)} characters of at most ${String(MAX_WORDS)} words`,
    ),
    { code: 'invalid_query' as const },
  );
}

/** Edits between two words (a swap of neighbours is one), or more than `most` once past it. */
function distance(a: string, b: string, most: number): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let smallest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (before[j - 2] as number) + 1);
      }
      current[j] = value;
      smallest = Math.min(smallest, value);
    }
    if (smallest > most) return most + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length] as number;
}

const DIGITS = /^\p{N}+$/u;

/** How well one word of a search names a field (0 to 1), given the field's words and those run together. */
function wordScore(word: string, field: { words: readonly string[]; joined: string }): number {
  let best = 0;
  for (const candidate of field.words) {
    if (candidate === word) return 1;
    if (word.length >= 2 && candidate.startsWith(word)) best = Math.max(best, 0.85);
  }
  // "mercedesbenz" for "Mercedes-Benz", "car17" for "car-17".
  if (word.length >= 3 && field.joined.includes(word)) best = Math.max(best, 0.75);
  if (best < 0.7 && !DIGITS.test(word) && word.length >= 4) {
    const most = word.length >= 8 ? 2 : 1;
    for (const candidate of field.words) {
      if (DIGITS.test(candidate)) continue;
      const edits = distance(word, candidate, most);
      if (edits <= most) best = Math.max(best, edits === 1 ? 0.7 : 0.6);
      // A typo in a word cut short: "merced" for "mercedes" is a prefix; "mercad" is one edit off one.
      if (candidate.length > word.length && distance(word, candidate.slice(0, word.length), 1) <= 1) {
        best = Math.max(best, 0.6);
      }
    }
  }
  return best;
}

/** How much a match in each field counts: a name most, a description least. */
const FIELDS: readonly [keyof Searchable, number][] = [
  ['name', 1],
  ['ref', 0.95],
  ['labels', 0.7],
  ['kind', 0.6],
  ['location', 0.6],
  ['description', 0.4],
];

type Searchable = Record<'name' | 'ref' | 'labels' | 'kind' | 'location' | 'description', { words: string[]; joined: string }>;

const indexed = (text: string | undefined | null) => {
  const words = text ? wordsOf(text) : [];
  return { words, joined: words.join('') };
};

/**
 * The resources that match a search's words, best first, each with its score (0 to 1). A resource is
 * kept when at least half of the words find it somewhere; one that every word names exactly scores 1.
 * Ties keep the order the resources were given in.
 */
export function slotlockSearchResources<T extends SlotlockSearchableResource>(
  resources: readonly T[],
  words: readonly string[],
): { resource: T; score: number }[] {
  if (words.length === 0) return [];
  const scored: { resource: T; score: number; at: number }[] = [];
  resources.forEach((resource, at) => {
    const fields: Searchable = {
      name: indexed(resource.name),
      ref: indexed(resource.externalRef),
      labels: indexed(resource.labels?.join(' ')),
      kind: indexed(resource.kind),
      location: indexed(resource.locationName ?? resource.location),
      description: indexed(resource.description),
    };
    let total = 0;
    let found = 0;
    for (const word of words) {
      let best = 0;
      for (const [field, weight] of FIELDS) best = Math.max(best, weight * wordScore(word, fields[field]));
      // A search of symbols only ("%"): looked for as written in the name and reference.
      if (best === 0 && !/[\p{L}\p{N}]/u.test(word)) {
        if (fold(`${resource.name ?? ''} ${resource.externalRef ?? ''}`).includes(word)) best = 1;
      }
      total += best;
      if (best >= 0.3) found += 1;
    }
    const score = total / words.length;
    if (found * 2 >= words.length && score >= 0.3) scored.push({ resource, score, at });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map(({ resource, score }) => ({ resource, score: Math.round(score * 100) / 100 }));
}
