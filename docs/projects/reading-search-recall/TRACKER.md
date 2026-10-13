# Reading Search Recall — Task Tracker

> **Reconciled 2026-08-11:** completed/historical working ledger. Remaining
> unchecked ideas are not active unless promoted to a current GitHub or Linear
> issue.

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

## Phase 3: Backfill — COMPLETE (2026-04-29)

Sequence matters: re-derive → FTS → embed. Driven by
`scripts/run-phase3-backfill.ts` against the deployed Worker after
PR #95 merged + auto-deployed.

- [x] **3.1** Re-derive `body_excerpt` — **16,489 rows updated** across 10
      calls (~13 min). Each call ~75–95s. Cleanly done.
- [x] **3.2** Reindex FTS — **client-driven calls completed**, but we
      hit two real issues that needed mitigation: 1. **Headers timeout at chunk_offset=14000.** Calls were getting
      slower as offset grew (152s → 293s) because `LIMIT/OFFSET` in
      SQLite is O(N) on the offset side, not O(1). The next call
      crossed undici's default 300s headers timeout. Fixes applied
      to the driver: bumped headers timeout to 600s and shrunk
      chunk_size from 2000 → 1000. Resumed cleanly from 14000.
      Followup: switch admin-reindex pagination to id-cursor
      (WHERE id > last_id) instead of OFFSET — Phase 5.4. 2. **Concurrent reindex from the parallel Instapaper-backfill
      project.** That project's Phase 2 (no-body recovery) finished
      around 12:21 PDT and immediately kicked off its own
      reindex-search reading sweep. The route's
      `chunk_offset === 0` DELETE step nuked our just-written rows.
      End state was correct (their reindex re-populated from the
      same `body_excerpt` column we'd updated), but for ~30 min
      row counts looked like data loss. Initially diagnosed as
      D1 replica lag; correct cause was concurrent execution.
      Followup: add a domain-level advisory lock on
      reindex-search so two simultaneous calls with chunk_offset=0
      can't race-DELETE each other's work — Phase 5.6.
- [x] **3.3** Reembed Vectorize — **19,939 vectors, 19.2M tokens,
      $0.38**, 40 calls (~50 min). Bumped per-call limit down from
      2000 → 500 because Voyage calls dominate per-row cost. Clean.

## Phase 4: Validation — COMPLETE (2026-04-29)

| Test                                                                            | Pre-fix      | Post-fix                  |
| ------------------------------------------------------------------------------- | ------------ | ------------------------- |
| `search(keyword, "Ichiro batting cages")`                                       | 0 results    | rank 1 ✅                 |
| `search(hybrid, "Ichiro work ethic batting cages")`                             | n/a          | rank 1, 0.031 ✅          |
| `search(keyword, "Colin Powell hardliner Bush administration")` → 20035 (~3.5K) | 0 results    | rank 1 ✅                 |
| `search(keyword, "steam room sauna etiquette grooming")` → 20040 (~4.5K)        | 0 results    | rank 1 ✅                 |
| `search(keyword, "White House Iran missile")` → 20037 (406-char body)           | n/a          | rank 1 (no regression) ✅ |
| `semantic_search("Ichiro work ethic batting cages Japan training")` → 1121      | rank 5 @ .52 | rank 7 @ .524             |

- [x] **4.1** Ichiro article: keyword and hybrid both rank 1 decisively.
      Pure semantic dropped 5 → 7 because every other Ichiro biography
      ALSO got a richer 12K vector and pulled ahead — the dilution
      effect we documented as a known tradeoff. Hybrid mode +
      tool-description nudge is the answer for this query class and
      it works.
- [x] **4.2** Two long-form body-recall checks at ~3.5K and ~4.5K
      char depth — both rank 1. FTS body coverage is the headline
      win.
- [x] **4.3** Short article (406-char body) still rank 1 on
      title-keyword search. No regression.

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
- [ ] **5.4** Switch admin-reindex pagination from `LIMIT/OFFSET` to
      id-cursor (`WHERE id > last_id ORDER BY id LIMIT N`) so chunked
      reindex performance is constant per call regardless of offset.
      Today late chunks take ~2× the time of early chunks because
      SQLite has to walk the prior rows on every offsetted SELECT.
- [ ] **5.5** Switch admin-reindex pagination from `LIMIT/OFFSET` to
      id-cursor: see 5.4 (kept here for visibility — the same fix
      addresses both the perf cliff and the long-tail timeout risk).
- [ ] **5.6** Add a domain-level advisory lock on
      `POST /admin/reindex-search`. Two concurrent calls with
      `chunk_offset=0` race-DELETE each other's writes. The current
      "DELETE only on chunk 0" pattern assumes a single caller; with
      multiple agents touching the same domain (real scenario in this
      project — collided with the Instapaper-backfill project's
      post-Phase-2 reindex), the loser silently loses work. Cheapest
      guard: refuse a chunk_offset=0 call if a row was inserted for
      the domain in the last 60s.
- [ ] **5.7** The other agent's `recover-no-body.ts` script writes
      `body_excerpt = text.slice(0, 3000)` (line 381) — predates this
      project's 12K cap bump. The 561 articles it recovered carry
      shorter excerpts than the 16,489 we re-derived. In practice
      doesn't matter (recovered bodies are paywall stubs typically
      <500 chars), but for strict consistency, run another
      `force:true` re-derive when convenient. Script update is one
      line: `text.slice(0, 12000)`.
