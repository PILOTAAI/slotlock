// Slotlock gap-search engine — pure math, no DB. Half-open `[)` throughout (the Phase-0 canon:
// back-to-back never conflicts).
import { describe, expect, it } from 'vitest';
import { findNextAvailable, mergeIntervals, subtractBusy } from '../engine.js';

const t = (h: number, m = 0) => new Date(Date.UTC(2027, 0, 4, h, m)); // Mon 2027-01-04
const iv = (s: Date, e: Date) => ({ start: s, end: e });
const HOUR = 60 * 60 * 1000;

describe('mergeIntervals', () => {
  it('merges overlapping and touching intervals, keeps gaps', () => {
    const merged = mergeIntervals([
      iv(t(13), t(14)),
      iv(t(9), t(10)),
      iv(t(10), t(11)), // touches previous — half-open ⇒ contiguous busy, merge
      iv(t(10, 30), t(10, 45)),
    ]);
    expect(merged).toEqual([iv(t(9), t(11)), iv(t(13), t(14))]);
  });

  it('empty input → empty output', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('subtractBusy', () => {
  it('carves busy out of a window, half-open at every boundary', () => {
    const free = subtractBusy(iv(t(8), t(18)), [iv(t(9), t(10)), iv(t(12), t(14))]);
    expect(free).toEqual([iv(t(8), t(9)), iv(t(10), t(12)), iv(t(14), t(18))]);
  });

  it('busy covering the whole window → nothing free', () => {
    expect(subtractBusy(iv(t(9), t(17)), [iv(t(8), t(18))])).toEqual([]);
  });

  it('busy ending exactly at window start does not eat into the window', () => {
    expect(subtractBusy(iv(t(10), t(12)), [iv(t(8), t(10))])).toEqual([iv(t(10), t(12))]);
  });
});

describe('findNextAvailable', () => {
  const windows = [iv(t(8), t(12)), iv(t(13), t(18))];

  it('returns the earliest fitting slot in the earliest window', () => {
    const slot = findNextAvailable({ busy: [], windows, durationMs: 2 * HOUR });
    expect(slot).toEqual(iv(t(8), t(10)));
  });

  it('skips past busy inside the window (first fitting gap wins)', () => {
    const slot = findNextAvailable({
      busy: [iv(t(8), t(9, 30))],
      windows,
      durationMs: 2 * HOUR,
    });
    expect(slot).toEqual(iv(t(9, 30), t(11, 30)));
  });

  it('a back-to-back start at a busy end is allowed (half-open)', () => {
    const slot = findNextAvailable({
      busy: [iv(t(8), t(10))],
      windows: [iv(t(8), t(12))],
      durationMs: 2 * HOUR,
    });
    expect(slot).toEqual(iv(t(10), t(12)));
  });

  it('rolls to the next window when the first cannot fit the duration', () => {
    const slot = findNextAvailable({
      busy: [iv(t(9), t(12))],
      windows,
      durationMs: 2 * HOUR,
    });
    expect(slot).toEqual(iv(t(13), t(15)));
  });

  it('no windows (empty rules) → null: never available', () => {
    expect(findNextAvailable({ busy: [], windows: [], durationMs: HOUR })).toBeNull();
  });

  it('busy saturating every window → null', () => {
    expect(findNextAvailable({ busy: [iv(t(0), t(23))], windows, durationMs: HOUR })).toBeNull();
  });

  it('duration longer than any window → null', () => {
    expect(findNextAvailable({ busy: [], windows, durationMs: 6 * HOUR })).toBeNull();
  });

  it('zero/negative duration → null (invalid ask, never a zero-width slot)', () => {
    expect(findNextAvailable({ busy: [], windows, durationMs: 0 })).toBeNull();
    expect(findNextAvailable({ busy: [], windows, durationMs: -HOUR })).toBeNull();
  });
});
