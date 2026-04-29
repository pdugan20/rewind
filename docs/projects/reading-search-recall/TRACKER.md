# Reading Search Recall — Task Tracker

Legend: [ ] pending, [x] done, [~] in progress.

Background and motivation in `README.md`.

## Phase 0: Validation in prod — COMPLETE (2026-04-29)

Established that the structural fix works on a single article before
committing to the full backfill.

- [x] **0.1** Trace the failure on article 1121 — confirmed `content` has
      "batting cage" / "training" / "japan" but `body_excerpt` has only
      "japan" (cut off at char 3000)
- [x] **0.2** Trace what consumes `body_excerpt` — confirmed it drives
      FTS body + embedding input _only_; card render uses `description`
      and `get_article` text uses `content`
- [x] **0.3** `scripts/test-body-bump-1121.ts` — pulls content from D1,
      runs `htmlToText(content, { maxChars: 10000 })`, updates
      `body_excerpt` and FTS row in remote D1
- [x] **0.4** Bump `MAX_INPUT_CHARS` from 3500 → 12000 in
      `src/services/embeddings/reading.ts` and deploy
- [x] **0.5** Re-embed article 1121 only via
      `POST /admin/reembed-reading` with `{offset: 1120, limit: 1}` —
      2,332 tokens used (vs ~875 before, confirming larger input)
- [x] **0.6** Validate: keyword `"Ichiro batting cages"` → rank 1 (0
      results before); hybrid → rank 1; semantic →
      rank 5 @ 0.520 (vs 0.519 before, marginal — expected)

## Phase 1: Audit — COMPLETE (2026-04-29)

Sized the actual benefit before paying for the full backfill.

- [x] **1.1** Archive content-length distribution (run against remote D1):

  | Metric                          | Count         | % of with_content |
  | ------------------------------- | ------------- | ----------------- |
  | Total articles                  | 19,938        | —                 |
  | With content (non-null)         | 19,847        | 100%              |
  | **Will benefit (content > 3K)** | **13,101**    | **66%**           |
  | Content > 6K                    | 7,130         | 36%               |
  | Still capped (content > 12K)    | 4,107         | 21%               |
  | Very long-form (content > 30K)  | 1,399         | 7%                |
  | Average content length          | 9,084 chars   | —                 |
  | Max content length              | 821,550 chars | —                 |

- [x] **1.2** `enrichment_status='no_body'`: 3,353 rows. Orthogonal —
      these have null content regardless of the cap. The parallel
      Instapaper-backfill / ScraperAPI recovery is rescuing them; if
      that lands before this project's backfill, rescued rows pick up
      the new 12K window automatically.
- [x] **1.3** **Decision: 12K cap confirmed.** Average article (9K) is
      fully captured; 79% of articles (15,840 of 19,847) fit entirely
      under the new cap. The 21% that remain capped are the candidates
      for multi-vector chunking _if_ a real-world query fails on one of
      them post-backfill — defer until then (Phase 5.2).
- [x] **1.4** Cost re-estimate: 19,847 articles × ~2,500 tokens average
      embed input ≈ 50M tokens × $0.02/M = **~$1.00** for a full
      reembed pass. No surprises.

## Phase 2: PR — COMPLETE (2026-04-29)

PR #95: https://github.com/pdugan20/rewind/pull/95
Branch: `reading-search-recall` (12 files changed, +697/-80).

- [x] **2.1** `src/services/instapaper/sync.ts:295` — bumped to
      `htmlToText(html, { maxChars: 12000 })`. New articles use the new
      cap going forward.
- [x] **2.2** `src/routes/admin-reindex.ts` — `backfill-body-excerpt`:
      cap bumped to 12000, `force: boolean` + `offset: number` added to
      body schema. On `force: true`, drops the `body_excerpt IS NULL`
      predicate and uses ORDER BY id + offset for stable pagination.
- [x] **2.3** `src/routes/admin-reindex.ts` — `buildReading`:
      SQL-paginates across the article+highlight stream via LIMIT/OFFSET.
      `buildSearchItemsForDomain(db, domain, offset, limit)` returns
      `{ items, total }`. Other domains use `buildAllThenSlice` (small
      payloads). No-chunk-size callers still get legacy single-call
      semantics; the route loops internally with INTERNAL_CHUNK_SIZE=1000.
- [x] **2.4** `src/services/embeddings/reading.ts` — `MAX_INPUT_CHARS`
      at 12000 (deployed in Phase 0).
- [x] **2.5** `src/services/embeddings/reading.test.ts` — fixed the
      `truncates at the char cap` test (uses 15K input now, asserts
      length === 12000).
- [x] **2.6/2.7** `mcp-server/src/tools/cross-domain.ts` — both `search`
      and `semantic_search` tool descriptions updated. Semantic now
      explicitly tells the model: source domains aren't in the embedding,
      prefer hybrid for publisher hints, raise `limit` when scores
      cluster within ~0.03.
- [x] **2.8** Lint clean, type-check clean, 994/994 vitest passing,
      99/99 mcp-server vitest passing. OpenAPI + manifest snapshots
      regenerated.
- [x] **2.9** PR opened.

## Phase 3: Backfill — PENDING

Run after Phase 2 merges and Worker auto-deploys (~2 min via CI on push
to main). Sequence matters: re-derive → FTS → embed.

- [ ] **3.1** Re-derive `body_excerpt` for the full archive.
      `POST /admin/backfill-body-excerpt` with `{ force: true,
limit: 2000 }`, looped until `scanned < limit`. Expected: ~10
      route calls × 30–60s = 5–15 min.
- [ ] **3.2** Reindex FTS for reading.
      `POST /admin/reindex-search` with
      `{ domains: ["reading"], chunk_size: 2000 }`, looped until
      `has_more === false`. Expected: ~10 calls × 20–40s = 2–5 min.
- [ ] **3.3** Reembed Vectorize.
      `POST /admin/reembed-reading` with
      `{ limit: 2000, batchSize: 10 }` and incrementing `offset` until
      `scanned < limit`. Expected: ~10 calls × 2–4 min = 25–40 min.
      Cost: ~$1 in Voyage tokens.

## Phase 4: Validation — PENDING

After backfill, confirm the fix generalizes.

- [ ] **4.1** Re-run the Ichiro article query in Claude Desktop / iOS;
      should still surface at rank 1 in keyword/hybrid.
- [ ] **4.2** Pick 2–3 other long-form articles (audit query identifies
      candidates with `length(content) > 12000`) and confirm a
      query targeting their _body_ content (not headline) returns them
      at rank 1 in keyword mode.
- [ ] **4.3** Spot-check 2–3 short articles to confirm they're
      unaffected (content < 3000 chars → no change).

## Phase 5: Follow-ups — DEFERRED

Filed for future scoping; explicitly out of this project.

- [ ] **5.1** Embed reading highlights as separate vectors. Current FTS
      indexes highlights but Vectorize doesn't. Would enable
      "find my highlight about X" without re-ranking through
      article-level vectors.
- [ ] **5.2** Multi-vector chunking per article. If a post-backfill
      query regresses on pure semantic for the same reason article
      1121 did (memorable content drowned in long-form context),
      revisit. Otherwise defer indefinitely.
- [ ] **5.3** Audit any consumers of `excerpt` field on the article
      detail API response. With the bump, `excerpt` is now ≤12 KB. Card
      render and `get_article` are confirmed unaffected; check web
      frontend if it pulls `excerpt` for any preview surface.
