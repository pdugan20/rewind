# Project: Reading Search Recall

Follow-up to `reading-search` (Tier 2/4 shipped April 2026). The
motivating ESPN-on-Ichiro article — full body in `reading_items.content`,
4,647 words — was being missed by `semantic_search("Ichiro work ethic
batting cages Japan training")` despite the searched-for phrases being
present verbatim in the article body. Diagnosis traced the regression
to a single structural cause: the search-side representation of an
article (`body_excerpt`) is capped at 3,000 characters, and both the
FTS5 body column and the Voyage embedding input feed off it. For any
article where the memorable content sits past char 3,000 — common in
long-form features — neither index can find it.

This project lifts that ceiling.

## Motivation

Concrete failure case: user asks `find me that ESPN article about
Ichiro's work ethic, going to batting cages in Japan and training`.
Article 1121 ("Ichiro Suzuki, Mariners resolve internal battle",
espn.com, 28 KB body) is the right answer. Before this fix:

- `search(mode: keyword, "Ichiro batting cages")` → 0 results. FTS body
  column only saw the first 3,000 chars; "batting cage" first appears
  at ~char 3,400.
- `search(mode: hybrid, "Ichiro batting cages")` → low-quality fusion
  for the same reason.
- `semantic_search("Ichiro work ethic batting cages Japan training")` →
  rank 5/6, score 0.519. Embedding input was `title + description +
body_excerpt` truncated at 3,500 chars, so the vector had no signal
  for the user's distinctive query terms; the article tied with every
  other generic Ichiro biography piece in the cluster around 0.52.

Single-article validation in prod (2026-04-29):

| Query                                                               | Before         | After                   |
| ------------------------------------------------------------------- | -------------- | ----------------------- |
| `search(keyword, "Ichiro batting cages")`                           | 0 results      | rank 1 (only match)     |
| `search(hybrid, "Ichiro batting cages")`                            | n/a            | rank 1, RRF score 0.032 |
| `semantic_search("Ichiro work ethic batting cages Japan training")` | rank 5 @ 0.519 | rank 5 @ 0.520          |
| Embed token count                                                   | ~875           | 2,332                   |

Headline finding: **the FTS / hybrid path is where the user-visible win
lives.** Pure semantic-only barely moves because the article's
batting-cage anecdote is one paragraph in a 28 KB character study —
competing Ichiro biographies (Cooperstown, Farewell 51) are more
topically dense on "Ichiro + training" and outscore it on aggregate
cosine similarity. Hybrid mode + a longer FTS body recovers the
article cleanly.

## Scope

One PR + one backfill run.

1. Bump `body_excerpt` cap from 3,000 → 12,000 chars at every call site
   (Instapaper sync, admin backfill route, embeddings input).
2. Add a `force` flag to `POST /admin/backfill-body-excerpt` so we can
   re-derive existing rows (the route currently only touches
   `body_excerpt IS NULL`).
3. Push `LIMIT/OFFSET` into `buildReading`'s SQL select. Currently the
   chunked reindex slices in memory after loading all rows; at the new
   payload size that's ~190 MB resident, over Worker's 128 MB cap.
4. Tool description tweaks: `semantic_search` and `search` get nudges
   to prefer `mode: hybrid` when the user mentions a publisher and to
   raise `limit` when scores cluster within ~0.03.
5. Backfill the existing archive: re-derive body_excerpt → reindex FTS
   → reembed Vectorize.

## Non-goals

- **Multi-vector chunking.** Embedding N chunks per article would
  meaningfully improve pure-semantic recall for long-form features but
  adds rollup logic in the search response and an extra Voyage call
  per chunk per ingest. Defer until a second article fails the same
  way after this fix lands.
- **Highlights as separate vectors.** Reading highlights are FTS-indexed
  but not in Vectorize. Filing this as a follow-up; rich snippet-level
  retrieval is a real user value but orthogonal to the structural fix
  here.
- **Embedding-input cap optimization.** voyage-3-lite supports 16K
  tokens (~64 KB chars); we use 12 KB. Could push higher, but vector
  dilution is a real cost and 12 KB is enough headroom for every
  long-form feature in the audited archive (see TRACKER §0).

## Architecture

### Before

```
reading_items
  title (~50 chars)
  description (~150 chars)        <- Instapaper subtitle
  content (5-30 KB HTML/text)     <- full article body, served by get_article
  body_excerpt (≤3000 chars)      <- htmlToText(content, maxChars: 3000)
                                     CONSUMED BY: FTS body, Vectorize embedding
                                     NOT CONSUMED BY: card render or LLM context

search_index FTS5
  title, subtitle, body=body_excerpt[≤3000]

Vectorize (rewind-reading)
  vector = voyage-3-lite(title + description + body_excerpt)[≤3500]
```

### After

```
reading_items
  body_excerpt (≤12000 chars)     <- htmlToText(content, maxChars: 12000)

search_index FTS5
  body=body_excerpt[≤12000]

Vectorize (rewind-reading)
  vector = voyage-3-lite(title + description + body_excerpt)[≤12000]
```

No schema changes — `body_excerpt` is already TEXT. Pure data + code.

## Risk register

| Risk                                                                                                                             | Mitigation                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Vector dilution: precise headline-matching queries score slightly lower because the 12K-char vector averages across more topics. | Net-positive in aggregate. If a second query regresses post-backfill, revisit multi-vector chunking.                           |
| Worker memory on full reindex: `buildReading` loads all 19K rows into a single array.                                            | Item 3 of scope: push pagination into SQL select. Required, not optional.                                                      |
| Reembed wall-clock per call: 2.7× larger Voyage calls.                                                                           | Tune route `limit` to 1000–2000 per invocation; 30–40s per Voyage call × 100–200 batches stays under Worker 15-min wall-clock. |
| Sync-path drift: new articles regress to 3K excerpts after backfill.                                                             | Update `enrichArticle` in the same PR.                                                                                         |
| Sequence error: reembedding before re-deriving body_excerpt would re-embed stale 3K excerpts.                                    | Document order in TRACKER. Each step idempotent and recoverable.                                                               |

## What `body_excerpt` is and isn't

This is the load-bearing mental model the project depends on. From
`mcp-server/src/tools/reading.ts:130-214`:

- **The article card render** (Claude Desktop / iOS) reads
  `description`, never `body_excerpt`. Bumping the excerpt does not
  change card UX.
- **The text content shipped to Claude** by `get_article` reads
  `content` first, falling back to `excerpt` only when `content` is
  null (failed enrichment). Bumping the excerpt only matters in the
  fallback case, where it's an improvement.
- **Search and semantic search** are the _only_ consumers that drive
  off `body_excerpt`. Treat it as the search-side representation of
  the article — optimize purely for retrieval quality.

## Validation evidence

- Single-article test on 1121 (live in prod since 2026-04-29):
  `scripts/test-body-bump-1121.ts` — derives the new excerpt, updates
  D1 + FTS, prints the offset for `/admin/reembed-reading`. Token
  count went from ~875 to 2,332 confirming the longer input was used.
- Conversation transcript that produced the diagnosis lives in the
  parent project `reading-search` — this project picks up where that
  one ends.
