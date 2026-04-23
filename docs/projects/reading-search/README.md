# Project: Reading Search

Make "I remember reading an article about a former SNL writer -- what was his name and where is it?" actually work. Today the MCP `search` tool only hits article titles + Instapaper's short description, and even when it does match, the model doesn't get the excerpt back to answer the "what was it about" half of the question. This project closes the gap across four tiers, culminating in vector-embedding-based semantic search and a "related articles" capability.

## Motivation

The reading domain has the richest per-item text in Rewind (full article bodies via Instapaper's `get_text`, stored in `reading_items.content`), but the retrieval surface is the weakest. Three concrete problems exposed by a single user query:

1. **Tokenizer gap.** FTS5's `unicode61` tokenizer splits `S.N.L.` into three single-letter tokens. Searching `SNL` misses every article whose title or body abbreviates acronyms with periods (NYT style, `A.I.`, `U.S.A.`, etc.).
2. **Excerpt blindness.** The `/v1/reading/recent` response omits Instapaper's `description` field. Even when search hits, the model can only see the title -- not the one-sentence summary that would contain "writer Jim Downey".
3. **No body-text retrieval.** The article body is sitting in `reading_items.content`, unindexed. Any search for a person, place, or concept mentioned only in prose fails.

And two absent capabilities that would make reading the most useful domain in the MCP:

4. **Semantic recall.** "Article about a former SNL writer" should match regardless of whether "former" or "SNL" literally appears; the article is about Jim Downey, and Downey is a former SNL writer.
5. **Related articles.** There's no way to say "and what else was I reading like that?"

## Scope

Four tiers, intended to ship independently so each delivers user-visible value on its own.

| Tier | Scope                                                                                                             | Core dependency                       |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1    | Punctuation-normalized FTS + return `description` in API/MCP + surface `image_key` on search results              | None                                  |
| 2    | Index article body excerpt (derived from existing `reading_items.content`)                                        | Tier 1 (uses same reindex pathway)    |
| 3    | Index highlight text as its own entity, add `rewind://highlight/{id}` resource                                    | Tier 1                                |
| 4    | Vector embeddings via Cloudflare Workers AI + Vectorize. New `semantic_search`, `find_similar_articles` MCP tools | Workers AI + Vectorize bindings (new) |

## Non-goals

- **Cross-domain semantic search.** Tier 4 vectors are scoped to reading for v1. Music/movie embeddings are a separate project.
- **Full-text body indexing.** We index the first ~3000 chars ("body_excerpt"), not the complete content column. The full `content` remains available for detail views but doesn't go into FTS (SQLite FTS5 size limits + bm25 quality both degrade with very long docs).
- **Article body rewriting / summarization.** No LLM-generated summaries at ingest time. The excerpt is mechanical HTML-stripping.
- **Reading shelf MCP Apps UI** (visual card grid parallel to the movie poster grid). Tracked separately; gated on the Anthropic connector regression being fixed for mobile/web anyway.

## Architecture

### Current

```text
Instapaper -> enrichArticle() -> reading_items
                                   (title, description, content [full HTML], og_image_url, ...)
                              -> afterSync() -> search_index FTS5
                                                (title, subtitle=description)
                                                NO body, NO image_key set for reading
```

`search_index` row for our motivating article today:

```
title    = "The Secret Weapon of 'S.N.L.' Finally Gets the Spotlight"  -- tokenizes to [the, secret, weapon, of, s, n, l, finally, gets, the, spotlight]
subtitle = "A documentary about the writer Jim Downey..."              -- tokenizes normally
```

Query `SNL writer` tokenizes to `[snl, writer]`. `snl` matches nothing.

### Target (after all tiers)

```text
Instapaper -> enrichArticle() -> reading_items
                                   (title, description, content [full HTML], body_excerpt [NEW], og_image_url, ...)
                              -> afterSync() -> search_index FTS5
                                                (title_norm, subtitle_norm, body_norm, image_key)
                              -> embedAndUpsert() -> Vectorize  [Tier 4]
                                                     (id=reading:article:{id}, values=768d, metadata)

MCP tools -> search           (hybrid: FTS + optional semantic)
          -> semantic_search  (vector-only)
          -> find_similar_articles(article_id)
```

## Stack

| Component       | Choice                                | Reason                                                               |
| --------------- | ------------------------------------- | -------------------------------------------------------------------- |
| Text normalizer | Regex-based, zero deps                | Acronym collapsing is a ~10-line helper; no tokenizer changes needed |
| HTML -> text    | `HTMLRewriter` (Workers built-in)     | Streaming, no deps, already used in the codebase                     |
| FTS             | SQLite FTS5 (existing `search_index`) | Already in prod; just add a `body` column and normalize inputs       |
| Embedding model | `@cf/baai/bge-base-en-v1.5` (768 dim) | Free tier covers our volume; good quality; Vectorize-native          |
| Vector store    | Cloudflare Vectorize                  | Same Worker runtime; cosine similarity; metadata filters             |
| Hybrid ranking  | Reciprocal Rank Fusion                | Proven, parameter-free combiner for FTS + vector                     |

## Documents

| File                     | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| [TRACKER.md](TRACKER.md) | Phased task checklist                                                  |
| [DESIGN.md](DESIGN.md)   | FTS schema v2, normalizer contract, embedding pipeline, hybrid ranking |

## Phase summary

| Phase | Focus                              | Scope                                                                                                    |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1     | Tier 1 -- normalized FTS + excerpt | Punctuation normalizer, FTS v2 schema, reindex endpoint, `description` on API/MCP, `image_key` on search |
| 2     | Tier 2 -- body indexing            | Derive `body_excerpt` from `reading_items.content`, add `body` column to FTS, reweight bm25              |
| 3     | Tier 3 -- highlight indexing       | Index highlights as FTS entities, `rewind://highlight/{id}` resource, `search` drill-down                |
| 4     | Tier 4 -- vector embeddings        | Workers AI + Vectorize bindings, embed pipeline, `/v1/search/semantic` + `/related`, new MCP tools       |

## Sequencing notes

- **Phase 1 ships first.** It fixes the exact motivating query end-to-end with the smallest diff.
- **Phases 2 and 3 are independent** after Phase 1 and can be done in either order. Phase 2 is higher-impact; Phase 3 is quicker.
- **Phase 4 is the real project.** It introduces new infra (Vectorize) and a new retrieval path. Gate its start on Phase 1-3 being in prod so we have a baseline to compare semantic-vs-keyword quality against.
- **Every phase updates the same reindex admin endpoint**, which is built in Phase 1 and extended as each FTS column is added.

## Confidence

- **High** on Tier 1 -- mechanical changes, existing plumbing
- **High** on Tier 2 -- content is already stored; only new code is the HTML stripper + one column
- **High** on Tier 3 -- follows the exact pattern of the article indexing; half the work
- **Medium** on Tier 4 -- Cloudflare Vectorize + Workers AI are proven but new to this repo; embedding-quality tuning (what to concatenate, how to chunk) will need a feedback loop once we see real queries
- Hybrid ranking design in DESIGN.md documents the RRF approach; we'll validate empirically that it outperforms semantic-only before shipping
