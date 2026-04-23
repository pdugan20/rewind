# Reading Search -- Task Tracker

Legend: [ ] pending, [x] done, [~] in progress.

## Phase 1: Tier 1 -- normalized FTS + excerpt surfacing -- CODE COMPLETE, AWAITING DEPLOY

Goal: the motivating NYT `S.N.L.` article is retrievable end-to-end by an MCP `search "SNL writer"` call, and the model sees the "writer Jim Downey" description in the response.

**1.1 -- Text normalizer** -- COMPLETE

- [x] **1.1.1** `src/lib/search-normalize.ts` with `normalizeForSearch(s)` per DESIGN.md
- [x] **1.1.2** `src/lib/search-normalize.test.ts`: 11 cases, including negative check that sentence-style `.` is preserved
- [x] **1.1.3** All normalizer tests pass (11/11)

**1.2 -- FTS schema v2 + normalizer wiring** -- COMPLETE

- [x] **1.2.1** `migrations/0026_search_index_v2.sql`: DROP and CREATE VIRTUAL TABLE with new `body` column
- [x] **1.2.2** `upsertSearchIndex` normalizes title+subtitle+body at insert; new `SearchIndexItem` type exports `body` and `imageKey`
- [x] **1.2.3** `/v1/search` normalizes the user's `q` before FTS match; also empties-early when query normalizes to whitespace
- [x] **1.2.4** `search.test.ts` gains two tests: `S.N.L.` -> `SNL` match, and body-column retrieval

**1.3 -- Image enrichment on search results via JOIN** -- COMPLETE (scope change)

Original plan was per-domain image_key plumbing. During implementation we found no existing domain populates image_key, and a query-time LEFT JOIN against the `images` table on (domain, entity_type, entity_id) gets every domain for free.

- [x] **1.3.1** `search.ts` SELECT now LEFT JOINs `images` and returns `image: { cdn_url, thumbhash, dominant_color } | null` on each result
- [x] **1.3.2** `reading` is now a valid domain filter on `/v1/search` (was previously missing from the enum)

**1.4 -- API: surface `description` on reading endpoints** -- COMPLETE

- [x] **1.4.1** `description` already on `formatArticle`; verified it flows through `/recent`
- [x] **1.4.2** `ArticleDetailSchema` gains `excerpt: string | null`; handler reads `bodyExcerpt` column (null until Tier 2)
- [x] **1.4.3** `reading.test.ts` still passes (30/30)
- [x] **1.4.4** OpenAPI snapshot regenerated

**1.5 -- Admin reindex endpoint** -- COMPLETE

- [x] **1.5.1** `POST /v1/admin/reindex-search` in new `src/routes/admin-reindex.ts`; accepts optional `{domains: [...]}` body filter
- [x] **1.5.2** Reading: iterates `reading_items`, builds `{ title, subtitle: description }` items
- [x] **1.5.3** All five domains covered with direct SELECTs (listening uses in-memory join for artist subtitles on albums/tracks; collecting joins through `discogs_release_artists`)
- [x] **1.5.4** `admin-reindex.test.ts`: auth rejection + reading reindex end-to-end + default-all-domains path (3/3)

**1.6 -- MCP: surface description + image on search results** -- COMPLETE

- [x] **1.6.1** `Article` type in `mcp-server/src/tools/reading.ts` gains `description: string | null`
- [x] **1.6.2** `get_recent_reads` adds truncated description (160 char word-bounded) per item in text output via new `truncateAtWord` helper
- [x] **1.6.3** structuredContent shape unchanged (already passed raw API items through)
- [x] **1.6.4** `search` tool emits imageBlocks (top-5) when result.image is non-null, uses `LIST_IMAGE_PX` (150px) transform
- [x] **1.6.5** `SearchResult` type extended with `image: {cdn_url, thumbhash, dominant_color} | null`

**1.7 -- Deploy + smoke test** -- MOSTLY COMPLETE

- [x] **1.7.1** Migration file ready
- [x] **1.7.2** `npm test` green: API 576/576, MCP 98/98
- [x] **1.7.3** Deployed API to prod (commit 8ed0284, version 930e59cc). Migration 0026 applied successfully to remote D1.
- [x] **1.7.4a** Reindex endpoint hit. reading: 1110, watching: 710, listening: 45591 -- all indexed. running + collecting failed late with D1 tail errors after listening's 190s burst; re-running those two individually after a minute resolves (see 1.7.7).
- [x] **1.7.4b** `search?q=SNL` hits the NYT article (entity_id 6) and three other SNL-related articles.
- [x] **1.7.4c** `search?q=SNL+writer` returns the NYT article (ranked #3 after other SNL-adjacent pieces — once Phase 2 backfill combined with Phase 1.8 reenrichment landed, the body excerpt made the match work end-to-end). Full article excerpt -- including "Jim Downey" -- is returned by the `excerpt` field on `/v1/reading/articles/6`.
- [ ] **1.7.5** MCP smoke test in Claude Desktop (verify search tool returns the article + that fetching `rewind://article/6` surfaces the excerpt)
- [ ] **1.7.6** Bump mcp-server to 0.4.0, rebuild, `npm publish`
- [ ] **1.7.7** Re-run reindex for running + collecting domains individually to backfill what tail-errored

## Phase 1.8: Enrichment retry (unblocks Phase 1 smoke test) -- NEW

491 of 1110 reading_items rows (44%) have `enrichment_status = 'failed'`. Root cause: `enrichArticle` in `src/services/instapaper/sync.ts` calls `fetchOgMetadata(url)` without its own try/catch, so a 403 from paywalled sites (NYT, FT, etc.) aborts the whole function before `client.getText(bookmarkId)` runs. Instapaper actually has the full body text in all these cases -- we just never fetched it.

Impact:

- 44% of articles have `description = null`, `content = null`, `author = null`, `word_count = null`
- Phase 1 search quality is proportionally degraded (only title is searchable on these rows)
- Phase 2 body indexing has nothing to index for these articles
- Phase 4 embeddings will be low-quality for these (title-only)

**1.8.1 Fix the bug**

- [ ] Wrap `fetchOgMetadata(url)` in `src/services/instapaper/sync.ts` in its own try/catch so a URL failure doesn't abort `client.getText`
- [ ] When either step succeeds, record `enrichmentStatus = 'completed'`. When both fail, `failed` with the combined errors. Partial success is the common case.
- [ ] Unit test: OG throws + getText succeeds -> content populated, description null, status 'completed'

**1.8.2 Retry admin endpoint**

- [ ] `POST /v1/admin/reenrich-reading` iterates `reading_items WHERE enrichment_status = 'failed'`, rate-limited, calls the fixed `enrichArticle` for each
- [ ] Returns `{ retried: N, succeeded: M, failed: P }`
- [ ] Reasonable rate (5 req/s) to avoid Instapaper API limits

**1.8.3 Run once against prod**

- [ ] Hit `/v1/admin/reenrich-reading`; expect 491 articles retried, most succeed on the getText path
- [ ] Re-run `/v1/admin/reindex-search {domains: ['reading']}` to pick up new descriptions
- [ ] Confirm `search?q=SNL+writer` now returns the NYT article

## Phase 2: Tier 2 -- body indexing -- BLOCKED on Phase 1

Goal: search matches against article body content (first 3000 chars), so mentions like "Tim Robinson" that appear only in prose get found.

**2.1 -- HTML -> text utility**

- [ ] **2.1.1** `src/lib/html-to-text.ts` with `htmlToText(html, opts?)` per DESIGN.md contract
- [ ] **2.1.2** `src/lib/html-to-text.test.ts`: script/style stripping, entity decode, block-level spacing, truncation at word boundary, null/empty input

**2.2 -- `body_excerpt` column**

- [ ] **2.2.1** Drizzle schema: add `bodyExcerpt: text('body_excerpt')` to `readingItems` in `src/db/schema/reading.ts`
- [ ] **2.2.2** `npm run db:generate` to emit `migrations/0027_reading_body_excerpt.sql`
- [ ] **2.2.3** Migration includes backfill: `UPDATE reading_items SET body_excerpt = ... WHERE content IS NOT NULL` -- but since SQLite can't run JS in migrations, this lives in a follow-up admin endpoint (`POST /v1/admin/backfill-body-excerpt`)
- [ ] **2.2.4** Extend `enrichArticle` in `src/services/instapaper/sync.ts` to compute `body_excerpt` alongside `content`

**2.3 -- Backfill endpoint**

- [ ] **2.3.1** `POST /v1/admin/backfill-body-excerpt` iterates `reading_items WHERE body_excerpt IS NULL AND content IS NOT NULL`, 100 at a time, applies `htmlToText`, writes back
- [ ] **2.3.2** Test: given fixture with content but no excerpt, endpoint populates it
- [ ] **2.3.3** Run against prod once

**2.4 -- FTS body column populated + BM25 reweighted**

- [ ] **2.4.1** `src/routes/search.ts` `upsertSearchIndex` now accepts and inserts `body` (normalized body_excerpt). Reading pipeline passes it; other domains pass null.
- [ ] **2.4.2** Search query switches to weighted BM25: `ORDER BY bm25(search_index, 10.0, 5.0, 1.0)`
- [ ] **2.4.3** Reindex endpoint includes body for reading articles
- [ ] **2.4.4** Run reindex against prod

**2.5 -- `excerpt` on API detail + MCP**

- [ ] **2.5.1** `GET /v1/reading/articles/{id}` response `excerpt` field now populated
- [ ] **2.5.2** `rewind://article/{id}` MCP resource handler includes excerpt in returned text
- [ ] **2.5.3** Do NOT add excerpt to list responses (per DESIGN.md)

**2.6 -- Smoke test**

- [ ] **2.6.1** Search for a string that's only in an article body (e.g. "Tim Robinson") returns the NYT article
- [ ] **2.6.2** BM25 weighting: a query whose exact phrase is in a title ranks that article above one where it's only in the body

## Phase 3: Tier 3 -- highlight indexing -- COMPLETE (API deployed)

Goal: "find that quote I highlighted about X" works via `search`.

**3.1 -- Highlight search items** -- COMPLETE

- [x] **3.1.1** `upsertHighlights` now returns `{ count, rows }`; rows contain id, text, note for the current snapshot of highlights on the bookmark
- [x] **3.1.2** Sync loop pushes a searchItem per highlight (title = first 80 chars, subtitle = bookmark title, body = full text + note when longer than title)
- [x] **3.1.3** Reindex `buildReading` JOINs `reading_highlights` to `reading_items` and emits a searchItem per row

**3.2 -- Highlight detail endpoint + entity resource** -- COMPLETE

- [x] **3.2.1** `GET /v1/reading/highlights/{id}` returns highlight + nested parent-article context; 3 new test cases (happy path, 404, invalid id)
- [x] **3.2.2** MCP `resources.ts` registers `rewind://highlight/{id}` handler (not yet published to npm -- see MCP bundle notes below)
- [x] **3.2.3** `cross-domain.ts` URI map gains `'reading:highlight': 'highlight'` (also pending npm publish)

**3.3 -- Deploy + smoke test** -- COMPLETE

- [x] **3.3.1** Commit 13edef0 deployed to prod (version 55ef8854)
- [x] **3.3.2** Reading reindex picked up 129 highlights (1110 articles + 129 highlights = 1239 rows)
- [x] **3.3.3** Smoke: `search?q=Altman+OpenAI` returns the matching highlight as the TOP result, with the parent article title as subtitle. `/v1/reading/highlights/2760` returns the full shape (text, note, parent-article context).
- [ ] **3.3.4** MCP smoke test in Claude Desktop -- gated on publishing mcp-server v0.4.0 with the new highlight resource + URI map

## Phase 4: Tier 4 -- vector embeddings + semantic search -- COMPLETE (API deployed)

Shipped Voyage AI embeddings (voyage-3-lite, 512 dim) + Cloudflare Vectorize
for semantic search and related-articles. All 1110 reading items embedded
and queryable. Hybrid ranking via reciprocal rank fusion in place.

Key smoke-test results:

- `GET /v1/reading/articles/6/related` returns 5 thematically-related
  comedy/SNL articles with cosine scores 0.52-0.60 and no keyword overlap
  required.
- `mode=semantic&q=article+about+a+former+SNL+writer` returns the
  motivating NYT article in the top 3 despite "former" not appearing
  in the text.
- Total backfill cost: ~835K tokens (out of 200M monthly Voyage free
  tier -- 0.4% of budget).

Goal: paraphrased / semantic queries work; "related articles" is a real capability.

**4.1 -- Infrastructure**

- [ ] **4.1.1** Add `[ai]` binding to `wrangler.toml` (`binding = "AI"`)
- [ ] **4.1.2** Create Vectorize index: `wrangler vectorize create rewind-reading --dimensions=768 --metric=cosine`
- [ ] **4.1.3** Create metadata indexes: `saved_at` (number), `status` (string)
- [ ] **4.1.4** Add `[[vectorize]]` binding to `wrangler.toml`
- [ ] **4.1.5** Update `src/types/env.ts` with `AI: Ai` and `VECTORIZE_READING: VectorizeIndex`
- [ ] **4.1.6** `wrangler dev` still starts cleanly; existing tests still pass

**4.2 -- Embedding pipeline**

- [ ] **4.2.1** `src/services/embeddings/reading.ts` with `embedArticle`, `embedArticles` (batch 10), `deleteArticleVector`
- [ ] **4.2.2** Text composition per DESIGN.md: title + description + body_excerpt, 512 token cap
- [ ] **4.2.3** Metadata attached: `article_id`, `saved_at` (unix), `status`, `domain`
- [ ] **4.2.4** Unit test with mocked `env.AI.run`: returns expected vector shape, upsert called with expected id/metadata
- [ ] **4.2.5** `afterSync` wiring for reading: embed new/changed articles in the batch (non-fatal on failure)

**4.3 -- Backfill**

- [ ] **4.3.1** `POST /v1/admin/reembed-reading` endpoint, 50 articles per batch, rate-limited (1 batch / 5s)
- [ ] **4.3.2** Run against prod once Phase 2's body_excerpt backfill is complete
- [ ] **4.3.3** Verify vector count in Vectorize matches `reading_items` count

**4.4 -- Query endpoints**

- [ ] **4.4.1** `POST /v1/search/semantic` per DESIGN.md: embed query, Vectorize query with filters, join to reading_items, return with scores
- [ ] **4.4.2** `GET /v1/reading/articles/{id}/related?limit=5`: fetches own vector, queries excluding self
- [ ] **4.4.3** Hybrid mode in existing `/v1/search`: accept `mode=keyword|semantic|hybrid` (default `hybrid`); RRF combine FTS + semantic
- [ ] **4.4.4** Tests for all three modes; fixture data + expected rankings

**4.5 -- MCP tools**

- [ ] **4.5.1** New tool `semantic_search` in `mcp-server/src/tools/cross-domain.ts` (reading-only for now)
- [ ] **4.5.2** New tool `find_similar_articles(article_id, limit?)` in `mcp-server/src/tools/reading.ts`
- [ ] **4.5.3** Existing `search` tool: add `mode` param, pass through to API
- [ ] **4.5.4** New prompt template `find-article` in `mcp-server/src/prompts.ts`
- [ ] **4.5.5** Update MCP docs in `docs-mintlify/mcp-server.mdx` and `mcp-server/README.md`
- [ ] **4.5.6** Bump mcp-server to 0.5.0, publish

**4.6 -- Smoke + evaluation**

- [ ] **4.6.1** Paraphrased query: "former SNL writer" (not literal match) finds the NYT article
- [ ] **4.6.2** `find_similar_articles` on the NYT article returns thematically related pieces
- [ ] **4.6.3** Hybrid ranking: an exact-title query still ranks that article first, but a vague-concept query now has meaningful results
- [ ] **4.6.4** Cost dashboard: verify a day of usage stays under $0.50
