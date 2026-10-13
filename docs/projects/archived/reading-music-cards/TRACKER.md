# Tracker

> **Archived October 13, 2026.** Implementation and client validation are recorded in this tracker’s Shipped section: reading and music cards, inline links, and v0.5.0 publication. The project explicitly wound down. Optional card ideas remain deferred. The historical shared-provider-key rotation item has no completion evidence here and remains an operator follow-up; archival does not mark it complete.

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

## Phase 4 — deferred

Revisit only if searching feels worse than browsing. The inline-markdown-links bonus fix already solved clickability in prose, so the card UI here is cosmetic — real visual richness matters most during browsing flows (`get_recent_reads`, `get_top_albums`), less during search where the user already has a query in mind.

If revisiting, in priority order:

- [ ] Card UI for `find_similar_articles` (trivial — reuse `ArticleList` verbatim)
- [ ] Card UI for `search` / `semantic_search` when `domain=reading` or `domain=listening` (reading especially)
- [ ] Card UI for `get_recent_listens` (new `ScrobbleRow` component)
- [ ] Mixed-domain card UI — skip unless a strong use-case emerges; text + inline links is good enough
- [ ] Revisit 33 still-unrescuable articles if ScraperAPI's DataDome relationship shifts

## Phase 5 — publish to npm + remote Worker ✅ shipped

- [x] Bump `rewind-mcp-server` 0.4.3 → 0.5.0 (package.json + server.ts version string)
- [x] Manifest snapshot regenerated for version change
- [x] `check:docs` passes
- [x] `npm publish` — live at [rewind-mcp-server@0.5.0](https://www.npmjs.com/package/rewind-mcp-server)
- [x] `wrangler deploy` — Worker live at `mcp.rewind.rest`
- [x] `docs-mintlify/changelog.mdx` v0.5.0 entry
- [x] Commit: `2c23f02`
- [ ] (deferred by user) Rotate the loaned ScraperAPI + OpenGraph.io keys — currently using the shared keys from claudenotes in prod Worker secrets

## Shipped

- Phase 0: `description` ?? `og_description` coalesce
- Phase 1: SERVER_INSTRUCTIONS LINKING (superseded by inline markdown)
- Phase 2: reading card UI (`get_recent_reads`)
- Phase 3: music card UIs (`get_top_albums`, `get_top_artists`)
- Phase 5: v0.5.0 published to npm + Worker deployed
- All bonus infrastructure (multi-tier OG fetch, placeholder retry-days, author URL cleanup, parallel backfill, inline markdown links)

**Final measured result**: reading image CDN coverage 54% → 97% (599/1111 → 1078/1111), ~5,700 ScraperAPI credits used (5.7% of quota).

## Blockers / escalations

None. Project wound down.
