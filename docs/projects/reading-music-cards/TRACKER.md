# Tracker

## Phase 0 — `description` field mapping fix ✅ shipped

- [x] Add `description ?? ogDescription` coalesce to `formatArticle` helper
- [x] Same coalesce in `/reading/articles/{id}/related` inline mapper
- [x] Regenerate `openapi.snapshot.json` (no changes — schema type unchanged)
- [x] Post-deploy verified: ~54% of recent articles return non-null description
- [x] Commit: `923466e`

## Phase 1 — SERVER_INSTRUCTIONS prose-link rule ✅ shipped + superseded

Superseded in-practice by the inline-markdown-link change (see "Bonus fixes"). LINKING stays as belt-and-suspenders for any endpoint we haven't converted.

- [x] Add `LINKING` block to `SERVER_INSTRUCTIONS`
- [x] Mirror rule into `find-article` prompt
- [x] User test: "find articles about the simpsons" — confirmed clickable markdown links ✓
- [x] Commits: `e1d6eaa`, strengthened via `67dd581`

## Phase 2 — Reading card UI ✅ shipped

- [x] Scaffold: `recent-reads.{html,tsx}`, `ArticleCard.tsx`, `ArticleList.tsx`, `lib/time-ago.ts`
- [x] Card rendering: title, meta row with author, excerpt, 80×80 thumbnail with thumbhash fade, accent-color fallback tile, clickable card
- [x] Wiring: `_meta.ui.resourceUri`, `registerUiResource`, CSP for `cdn.rewind.rest`
- [x] User confirmed card UI in Claude Desktop ✓
- [x] Commits: `1864c65`, follow-ups for primary click target (`ca61e87`) and author meta (`0a62cde`)

## Phase 3 — Music card UIs ✅ shipped

- [x] `AlbumCard`/`AlbumGrid` + `top-albums.{html,tsx}`, `_meta.ui.resourceUri` on `get_top_albums`
- [x] `ArtistCard`/`ArtistGrid` + `top-artists.{html,tsx}`, `_meta.ui.resourceUri` on `get_top_artists`
- [x] Clickable fallback to Last.fm URL when `apple_music_url` null
- [x] User confirmed both UIs in Claude Desktop ✓
- [x] Commit: `be8c0b8`

## Bonus fixes (emerged during iteration)

Scope that wasn't in the original plan but shipped because we hit it.

- [x] **Browser-mimicking OG fetch** — Chrome UA + Sec-Fetch-\* + Referer. Rescues medium-hard sources (Atlantic, Vulture, Wired). Commit `7e01d7e`
- [x] **ScraperAPI + OpenGraph.io tier-3/4 fallback** — rescues DataDome (NYT) and PerimeterX (Bloomberg) + WSJ via OG.io. Commit `d2c8409`
- [x] **Parallel backfill with 5-slot pool** — matches ScraperAPI Hobby concurrency, 5× faster batches. Commit `215ec21`
- [x] **Clear-placeholders admin endpoint** — `POST /v1/admin/clear-reading-image-placeholders`. Commit `d53f0d3`
- [x] **PLACEHOLDER_RETRY_DAYS for reading** — mirrors listening pattern, auto-expires stale placeholders after 7 days, refreshes createdAt on retry. Commit `50744dd`
- [x] **NYT URL-shaped author fix** — forward extraction titlecases slug, one-shot cleanup endpoint ran on 98 existing rows. Commit `50744dd`
- [x] **Inline markdown links in tool text** — `[title](url)` in all reading + music tool outputs, not just SERVER_INSTRUCTIONS nudge. Commit `67dd581`
- [x] **OG backfill executed**: 54% → 97% CDN image coverage (from 599 to 1078 of 1111 articles). ~5,700 ScraperAPI credits used (5.7% of quota).

## Phase 4 — stretch (not committed)

Optional extensions. No pressure to do any of these unless motivated.

- [ ] Interactive **card UI for `search` / `semantic_search`** when `domain=reading` or `domain=listening` (text/prose path already has markdown links via the bonus fix, so benefit is smaller)
- [ ] Card UI for `find_similar_articles`
- [ ] Card UI for `get_recent_listens` (scrobble feed — would reuse AlbumCard components)
- [ ] Revisit 33 genuinely-unrescuable articles in case ScraperAPI + DataDome relationship changes

## Phase 5 — publish to npm + remote Worker ⏳

- [ ] User green-lights ship
- [ ] Bump `rewind-mcp-server` version: 0.4.3 → **0.5.0** (meaningful new UI surface: 3 new interactive cards + inline links + new tools + bonus infra)
- [ ] `npm publish`
- [ ] Deploy remote Worker at `mcp.rewind.rest` via `cd mcp-server && npm run deploy:worker` (or wrangler deploy)
- [ ] Update `docs-mintlify/changelog.mdx` with v0.5.0 entry
- [ ] Rotate the loaned ScraperAPI + OpenGraph.io keys from claudenotes (user mentioned they'd do this; currently using the shared keys in prod Worker secrets)
- [ ] Verify Claude Desktop users on the public `rewind` (npm) entry see parity with `rewind-local`

## Shipped

- Phase 0, 1, 2, 3 as documented above
- All bonus infra

## Blockers / escalations

None open.
