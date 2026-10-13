# Reading Search -- Design

Canonical shapes, contracts, and decisions. Referenced by TRACKER.md tasks.

## Text normalizer

**Contract.** `normalizeForSearch(s: string | null | undefined): string`

- Empty / null in, empty string out.
- Output is the input with the following transformations, in order:
  1. Unicode NFKC normalization (compose ligatures, canonical-decompose + recompose).
  2. Lowercase via `.toLocaleLowerCase('en')`.
  3. Collapse dotted acronyms: `/\b(?:[a-z]\.){2,}[a-z]?\b/g` -> match, strip all `.`. So `s.n.l.` -> `snl`, `u.s.a.` -> `usa`, `a.i.` -> `ai`. Regular sentence punctuation (`foo.bar`) is NOT matched because the rule requires at least two `letter.` tokens in a row.
  4. Strip smart quotes (`"`, `"`, `'`, `'`) -> empty string.
  5. Collapse runs of whitespace to single space; trim.

Applied at BOTH index time (`upsertSearchIndex` input) and query time (`search` query parser). The caller at query time must also strip FTS5 special chars (already done: `[/'"*]/g`).

Location: `src/lib/search-normalize.ts`. Exported from the lib. Has its own unit tests covering: empty/null, dotted acronyms with trailing letter and without, mixed-case input, smart-quote input, multi-word input.

## FTS schema v2

Drop + recreate `search_index` with an additional `body` column and ensure `image_key` is populated on every insert:

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  domain UNINDEXED,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  title,
  subtitle,
  body,         -- NEW in Tier 2
  image_key UNINDEXED,
  tokenize='unicode61'
);
```

**Column contents, post-normalization:**

| Column    | Reading article                             | Other domains                          |
| --------- | ------------------------------------------- | -------------------------------------- |
| title     | normalize(bookmark.title)                   | normalize(artist/album/movie/etc name) |
| subtitle  | normalize(bookmark.description)             | existing behavior unchanged            |
| body      | normalize(body_excerpt) -- first 3000 chars | NULL (only reading populates for now)  |
| image_key | reading_items.og_image_url's image row key  | existing behavior unchanged            |

**BM25 weights** (Tier 2):

```sql
ORDER BY bm25(search_index, 10.0, 5.0, 1.0)
```

Title boosted 10x over body, subtitle 5x over body. We keep title dominant so "exact title match" still wins over "body mention".

**Migration approach.** Can't `ALTER` an FTS5 virtual table to add a column. The migration drops `search_index`, recreates it with the new schema, and the reindex admin endpoint backfills it from source tables. Document in migration SQL: `-- safe to run repeatedly; reindex endpoint must be hit after this runs`.

## Reindex admin endpoint

`POST /v1/admin/reindex-search`

- Requires admin API key.
- Body: `{ "domains"?: ("listening"|"running"|"watching"|"collecting"|"reading")[] }` -- default all.
- For each included domain, truncates `search_index` rows for that domain and re-inserts from the source tables.
- Response: `{ "domains": { "<name>": { "indexed": N, "took_ms": M } } }`
- Non-transactional across domains; one domain's failure doesn't block the others (each wrapped in try/catch, errors accumulated in response).

Built in Phase 1, extended in Phase 2 (body excerpt) and Phase 3 (highlights).

## `reading_items.description` surfacing

**API changes:**

- `GET /v1/reading/recent` response items gain `description: string | null`.
- `GET /v1/reading/articles/{id}` response gains `description: string | null` and `excerpt: string | null`. The `excerpt` field is the Tier 2 `body_excerpt` (read from DB, null until Tier 2 populates it).

Schema: no change (column already exists).

**MCP changes:**

- `Article` type in `mcp-server/src/tools/reading.ts` gains `description: string | null`.
- `get_recent_reads` text output includes a truncated (120 char) description line per item when present.
- structuredContent passes `description` verbatim.

## Search result enrichment with `image_key`

`src/routes/search.ts` currently SELECTs `domain, entity_type, entity_id, title, subtitle`. Extend:

```sql
SELECT si.domain, si.entity_type, si.entity_id, si.title, si.subtitle,
       si.image_key, i.cdn_url, i.thumbhash, i.dominant_color
FROM search_index si
LEFT JOIN images i ON i.image_key = si.image_key
WHERE si.search_index MATCH ? ...
```

Return shape adds an optional `image: { cdn_url, thumbhash, dominant_color } | null` on each result.

Reading articles populate `image_key` from the matching `images` table row (derived from `og_image_url`). On write: the sync pipeline has to look up the image row key for the article's og image. Stored in `SearchItem.imageKey`; pass-through to FTS already exists.

**MCP changes:** `search` tool adds `imageBlock` calls for top-5 results that carry a non-null image. Mirrors `get_recent_reads` pattern.

## Body excerpt derivation (Tier 2)

**Column:** `reading_items.body_excerpt TEXT`. Nullable. Backfilled on migration from existing `content`.

**HTML -> text:** `src/lib/html-to-text.ts`. Uses `HTMLRewriter` (Workers built-in, zero deps). Contract:

```ts
htmlToText(html: string | null, opts?: { maxChars?: number }): string
```

- Strips `<script>`, `<style>`, `<noscript>`, and HTML comments entirely (drop element + contents).
- For every other element, preserve its text. Insert a single space between block-level elements (`<p>`, `<h1>`-`<h6>`, `<li>`, `<br>`, `<tr>`, `<td>`) to prevent word-joining.
- Decode HTML entities.
- Collapse whitespace runs; trim.
- If `maxChars` provided, truncate at the nearest word boundary <= maxChars; append nothing (no "...").

Default `maxChars = 3000` for body_excerpt.

**Sync integration:** `enrichArticle` in `src/services/instapaper/sync.ts`, after it stores `content`:

```ts
updates.body_excerpt = htmlToText(html, { maxChars: 3000 });
```

**Backfill:** A Drizzle migration-accompanying script or admin endpoint that iterates `reading_items WHERE body_excerpt IS NULL AND content IS NOT NULL`, applies `htmlToText`, writes back. Batched 100 at a time. Can be re-run idempotently.

## Highlight indexing (Tier 3)

**Search items:** each highlight emits:

```ts
{
  domain: 'reading',
  entityType: 'highlight',
  entityId: String(highlight.id),
  title: first80chars(highlight.text),
  subtitle: parentArticle.title,
  imageKey: parentArticle.imageKey,  // so highlight search results show the article's hero
}
```

**Sync integration:** `upsertHighlights` in Instapaper sync currently returns a count; extend to return the highlight rows it inserted/updated, push into `searchItems` alongside articles.

**Entity resource:** `rewind://highlight/{id}` served by `GET /v1/reading/highlights/{id}`. Returns highlight text, note, created_at, and nested article context (title, author, url, domain, id).

**MCP wiring:** `cross-domain.ts:32` map gains `'reading:highlight': 'highlight'`. `rewindUri('reading', 'highlight', id)` returns `rewind://highlight/{id}`. `search` results pointing at highlights become resource_links the client can drill into.

## Vector embeddings (Tier 4)

### Infrastructure

`wrangler.toml`:

```toml
[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORIZE_READING"
index_name = "rewind-reading"
```

`src/types/env.ts` gains `AI: Ai`, `VECTORIZE_READING: VectorizeIndex`.

Index config (created via wrangler CLI):

```bash
wrangler vectorize create rewind-reading \
  --dimensions=768 \
  --metric=cosine
wrangler vectorize create-metadata-index rewind-reading \
  --property-name=saved_at --type=number
wrangler vectorize create-metadata-index rewind-reading \
  --property-name=status --type=string
```

### Embedding pipeline

`src/services/embeddings/reading.ts`:

```ts
export async function embedArticle(
  env: Env,
  article: ReadingItem
): Promise<void>;
export async function embedArticles(
  env: Env,
  articles: ReadingItem[]
): Promise<void>; // batch
export async function deleteArticleVector(env: Env, id: number): Promise<void>;
```

**Text composition** (what gets embedded):

```
<title>

<description>

<body_excerpt>
```

Truncated at 512 tokens (bge input cap). Title and description are small enough that truncation mostly bites the body.

**Model:** `@cf/baai/bge-base-en-v1.5`, batched 10 per `env.AI.run()` call to amortize per-request overhead.

**ID scheme:** `reading:article:{id}`. Matches the search entity_id shape, so one lookup table (`reading_items`) resolves both FTS and vector hits.

**Metadata stored with each vector:**

```json
{
  "article_id": 12345,
  "saved_at": 1713734400,
  "status": "unread",
  "domain": "nytimes.com"
}
```

**Trigger points:**

- `afterSync` for reading: embed any new/updated articles in the batch.
- Admin endpoint `POST /v1/admin/reembed-reading` for backfill and re-embedding after a body-excerpt rebuild. Batched 50 at a time, rate-limited to avoid blowing the AI quota in one burst.

### Query endpoints

**`POST /v1/search/semantic`**

```json
{
  "q": "article about a former SNL writer",
  "domain": "reading",
  "top_k": 10,
  "filters": { "status": "archived", "since": "2026-01-01" }
}
```

Pipeline: embed query -> `vectorize.query(vec, { topK, filter })` -> join to `reading_items` -> return `{ data: [{ ...article, score }], total }`.

**`GET /v1/reading/articles/{id}/related?limit=5`**
Fetches `{ id: 'reading:article:{id}' }` vector, queries Vectorize excluding self (`filter: { article_id: { $ne: id } }`), returns top-K related articles with scores.

### Hybrid ranking (recommended default for `search`)

Reciprocal Rank Fusion with constant k=60 (standard):

```
score(doc) = sum over retrievers [ 1 / (k + rank_in_retriever(doc)) ]
```

Run FTS and semantic in parallel (both top-20). Fuse. Return top-N.

Opt-in via `search` tool param `mode: 'keyword' | 'semantic' | 'hybrid'`, default `hybrid`. Keyword-only preserves the exact pre-Tier-4 behavior for any caller that wants determinism.

### Cost

- bge-base on Workers AI: ~$0.011 per million tokens. 1000 articles × ~1000 tokens embedded once = ~$0.01 total backfill. Ongoing: every new article + every query embedding = <$0.50/mo at any realistic volume.
- Vectorize: first 5M stored dimensions free. 1000 articles × 768d = 768K dims. Queries: first 50M dimensions queried/mo free.

Both fit free tier for the foreseeable future. Budget alarm at $5/mo anyway.

## MCP tool changes (cumulative)

### Tier 1

- `Article` type: add `description: string | null`
- `get_recent_reads`: include truncated description in text lines
- `search`: emit image blocks (top-5) for results with non-null image

### Tier 2

- `Article` type: add `excerpt: string | null` (the body_excerpt)
- `get_movie_details`-style detail: add excerpt to structuredContent on `get_recent_reads` only on request (would blow up response size otherwise). Actually: keep excerpt OFF list responses; include only on `rewind://article/{id}` detail resource.

### Tier 3

- `search` mapping: `reading:highlight` -> `rewind://highlight/{id}`
- New resource handler in `resources.ts` for highlight URIs

### Tier 4

- New tool `semantic_search(query, domain?, top_k?, filters?)` -> same shape as `search` result, includes score
- New tool `find_similar_articles(article_id, limit?)` -> list of related articles with scores
- `search` tool: new `mode` param (`keyword|semantic|hybrid`), default `hybrid`
- New prompt template `find-article` -- takes a vague recollection, runs hybrid search, presents top + 3 related

## Non-decisions (flagged, not decided)

- Whether to embed highlights in Tier 4 as a separate vector namespace. Argument for: "paraphrased highlight" recall works. Argument against: more infra, not motivated by current user ask. **Decision deferred to end of Phase 3.**
- Whether to also add body-excerpt to structuredContent on list endpoints. **Default: no.** Adds response weight without clear benefit when the excerpt is available via the entity resource.
- Whether to expose a separate "quick recall" MCP prompt distinct from `find-article`. **Defer to post-Phase-4.**

## Test coverage

Every phase adds unit tests. Targets:

- Phase 1: `search-normalize.test.ts` (all 5 transformations), `search.test.ts` asserts normalized FTS match for dotted acronyms, API `/reading/recent` includes `description`
- Phase 2: `html-to-text.test.ts` (script/style removal, entity decode, block-level spacing, truncation at word boundary), sync integration test that a new article gets body_excerpt set
- Phase 3: highlight search test, resource handler test
- Phase 4: embedding pipeline unit tests with a mocked `env.AI.run`, hybrid ranker test with fixture rankings, `/search/semantic` route test
