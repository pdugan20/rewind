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

**1.7 -- Deploy + smoke test** -- AWAITING USER

- [x] **1.7.1** Migration file ready; no drizzle-kit generate needed (raw SQL FTS migration)
- [x] **1.7.2** `npm test` green: API 576/576, MCP 98/98
- [ ] **1.7.3** Deploy API to prod (`npm run deploy` from repo root); after deploy, hit `POST https://api.rewind.rest/v1/admin/reindex-search` once with admin Bearer
- [ ] **1.7.4** Smoke test: `curl 'https://api.rewind.rest/v1/search?q=SNL+writer&domain=reading' -H 'Authorization: Bearer rw_...'` returns the NYT article with `image` populated
- [ ] **1.7.5** Smoke test: in Claude Desktop, MCP `search "SNL writer"` returns the article with hero image block + resource_link to `rewind://article/{id}`
- [ ] **1.7.6** Bump mcp-server to 0.4.0, rebuild, `npm publish`

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

## Phase 3: Tier 3 -- highlight indexing -- BLOCKED on Phase 1

Goal: "find that quote I highlighted about X" works via `search`.

**3.1 -- Highlight search items**

- [ ] **3.1.1** `src/services/instapaper/sync.ts` `upsertHighlights` returns the highlight rows it touched
- [ ] **3.1.2** Sync loop pushes highlight searchItems: `{ domain: 'reading', entityType: 'highlight', entityId, title: first80(text), subtitle: parentArticleTitle, imageKey: parentArticleImageKey }`
- [ ] **3.1.3** Reindex endpoint extended to iterate `reading_highlights` with JOIN to parent

**3.2 -- Highlight detail endpoint + entity resource**

- [ ] **3.2.1** `GET /v1/reading/highlights/{id}` returns highlight + article context
- [ ] **3.2.2** MCP `resources.ts` registers `rewind://highlight/{id}` handler calling the new endpoint
- [ ] **3.2.3** `cross-domain.ts:32` URI map gains `'reading:highlight': 'highlight'`

**3.3 -- Tests + smoke**

- [ ] **3.3.1** Test: search hits a highlight's text content and returns `rewind://highlight/{id}` resource link
- [ ] **3.3.2** Test: `rewind://highlight/{id}` resource returns expected shape
- [ ] **3.3.3** MCP smoke test in Claude Desktop -- highlight search returns + drill-in works

## Phase 4: Tier 4 -- vector embeddings + semantic search -- BLOCKED on Phase 2

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
