import { describe, it, expect } from 'vitest';
import {
  D1_PARAM_CAP,
  chunkForSelectIn,
  chunkForInsertValues,
} from './d1-chunk.js';

describe('D1_PARAM_CAP', () => {
  it('is the empirically-proven 88', () => {
    // Tied to the attending activity-feed backfill: 8 rows * 11 cols = 88.
    // If this changes, audit existing call sites that hard-coded the value.
    expect(D1_PARAM_CAP).toBe(88);
  });
});

describe('chunkForSelectIn', () => {
  it('yields nothing for an empty input', () => {
    expect([...chunkForSelectIn([])]).toEqual([]);
  });

  it('yields a single chunk under the cap', () => {
    const ids = Array.from({ length: 50 }, (_, i) => i);
    const chunks = [...chunkForSelectIn(ids)];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(50);
  });

  it('splits at exactly D1_PARAM_CAP', () => {
    const ids = Array.from({ length: D1_PARAM_CAP }, (_, i) => i);
    const chunks = [...chunkForSelectIn(ids)];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(D1_PARAM_CAP);
  });

  it('splits over the cap', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i);
    const chunks = [...chunkForSelectIn(ids)];
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(D1_PARAM_CAP);
    expect(chunks[1]).toHaveLength(D1_PARAM_CAP);
    expect(chunks[2]).toHaveLength(200 - 2 * D1_PARAM_CAP);
  });

  it('reserves params for additional predicates', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i);
    const chunks = [...chunkForSelectIn(ids, 8)];
    const expectedSize = D1_PARAM_CAP - 8; // 80
    expect(chunks[0]).toHaveLength(expectedSize);
    expect(chunks).toHaveLength(Math.ceil(200 / expectedSize));
  });

  it('preserves all values across chunks (no drops, no dupes)', () => {
    const ids = Array.from({ length: 300 }, (_, i) => i);
    const flat = [...chunkForSelectIn(ids, 5)].flat();
    expect(flat).toEqual(ids);
  });

  it('rejects negative reservedParams', () => {
    expect(() => [...chunkForSelectIn([1], -1)]).toThrow(/reservedParams/);
  });

  it('rejects reservedParams >= cap', () => {
    expect(() => [...chunkForSelectIn([1], D1_PARAM_CAP)]).toThrow(
      /reservedParams/
    );
  });
});

describe('chunkForInsertValues', () => {
  it('yields nothing for an empty input', () => {
    expect([...chunkForInsertValues([], 5)]).toEqual([]);
  });

  it('chunks at floor(cap / columnsPerRow)', () => {
    // 11 cols × 8 rows = 88 params (the activity-feed shape).
    const rows = Array.from({ length: 25 }, (_, i) => ({ i }));
    const chunks = [...chunkForInsertValues(rows, 11)];
    expect(chunks[0]).toHaveLength(8);
    expect(chunks[1]).toHaveLength(8);
    expect(chunks[2]).toHaveLength(8);
    expect(chunks[3]).toHaveLength(1);
  });

  it('handles a single wide row', () => {
    const rows = [{ a: 1 }];
    const chunks = [...chunkForInsertValues(rows, 50)];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(rows);
  });

  it('preserves all rows in order across chunks', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ i }));
    const flat = [...chunkForInsertValues(rows, 7)].flat();
    expect(flat).toEqual(rows);
  });

  it('rejects zero or negative columnsPerRow', () => {
    expect(() => [...chunkForInsertValues([{}], 0)]).toThrow(
      /columnsPerRow must be positive/
    );
    expect(() => [...chunkForInsertValues([{}], -1)]).toThrow(
      /columnsPerRow must be positive/
    );
  });

  it('rejects columnsPerRow over the cap', () => {
    expect(() => [...chunkForInsertValues([{}], D1_PARAM_CAP + 1)]).toThrow(
      /exceeds D1_PARAM_CAP/
    );
  });
});
