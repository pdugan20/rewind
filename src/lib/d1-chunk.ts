// D1 bound-parameter chunking helpers.
//
// Cloudflare D1's effective per-query parameter cap is ~100 in practice,
// not the 256 documented in the platform notes. Both `IN (?, ?, ...)`
// SELECTs and `INSERT INTO t (...) VALUES (?, ?), (?, ?)` multi-row
// writes can blow past this with batches of 200+ rows — we hit it twice
// during the attending activity-feed backfill before settling on
// SELECT_CHUNK=80 + INSERT_CHUNK=8 (8 rows × 11 cols = 88 params).
//
// This module captures that empirically-derived cap in one place so
// future bulk admin endpoints don't rediscover the wall mid-prod-backfill.
//
// Usage:
//   for (const ids of chunkForSelectIn(sourceIds)) {
//     const rows = await db.select(...).where(inArray(t.sourceId, ids));
//   }
//
//   for (const rows of chunkForInsertValues(items, 11)) {
//     await db.insert(t).values(rows);
//   }

/**
 * Empirically-derived effective parameter cap for D1. Documented as 256
 * but the planner trips well before that for large IN-lists; 88 is
 * comfortably under the wall and proven against prod.
 *
 * Set deliberately on the conservative side so callers never have to
 * tune it. If you find yourself wanting to push past this, write tests
 * that reproduce the failure mode first — the docs lie.
 */
export const D1_PARAM_CAP = 88;

/**
 * Chunk an array of values for use in a `WHERE col IN (?, ?, ...)`
 * predicate. Each chunk has at most `D1_PARAM_CAP - reservedParams`
 * entries so callers can leave room for other bound parameters in the
 * same query (e.g. an additional `WHERE domain = ?` predicate).
 *
 * Yields nothing for an empty input — caller is responsible for the
 * "skip the query entirely" short-circuit when that matters.
 */
export function* chunkForSelectIn<T>(
  values: readonly T[],
  reservedParams = 0
): Generator<T[]> {
  if (reservedParams < 0 || reservedParams >= D1_PARAM_CAP) {
    throw new Error(
      `reservedParams must be 0..${D1_PARAM_CAP - 1}, got ${reservedParams}`
    );
  }
  const size = D1_PARAM_CAP - reservedParams;
  for (let i = 0; i < values.length; i += size) {
    yield values.slice(i, i + size);
  }
}

/**
 * Chunk an array of row objects for a multi-row INSERT VALUES write.
 * Each chunk has at most `floor(D1_PARAM_CAP / columnsPerRow)` rows so
 * the resulting bound parameters fit under the cap.
 *
 * Throws if `columnsPerRow` exceeds the cap — single-row INSERTs of
 * that width can't be batched at all and the caller needs to either
 * narrow the column set or insert one row per statement.
 */
export function* chunkForInsertValues<T>(
  rows: readonly T[],
  columnsPerRow: number
): Generator<T[]> {
  if (columnsPerRow <= 0) {
    throw new Error(`columnsPerRow must be positive, got ${columnsPerRow}`);
  }
  if (columnsPerRow > D1_PARAM_CAP) {
    throw new Error(
      `columnsPerRow=${columnsPerRow} exceeds D1_PARAM_CAP=${D1_PARAM_CAP}; insert one row at a time instead`
    );
  }
  const size = Math.floor(D1_PARAM_CAP / columnsPerRow);
  for (let i = 0; i < rows.length; i += size) {
    yield rows.slice(i, i + size);
  }
}
