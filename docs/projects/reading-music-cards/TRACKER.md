# Tracker

## Phase 0 — `description` field mapping fix ✅

- [x] Add `description ?? ogDescription` coalesce to `formatArticle` helper (covers /recent, /articles list, /articles/{id}, /currently-reading, /archive)
- [x] Same coalesce in `/reading/articles/{id}/related` inline mapper
- [x] Verify with local `npm test` — no regression
- [x] Regenerate `openapi.snapshot.json` via `npx vitest run ... --update` (no changes — schema type unchanged)
- [x] Commit: 923466e `fix(reading): serve og_description when editorial description is null`
- [ ] Post-deploy empirical sample: `curl /reading/recent?limit=50 | jq '[.data[] | select(.description != null)] | length'` returns ≥ ~27

## Phase 1 — SERVER_INSTRUCTIONS prose-link rule ✅

- [x] Add `LINKING` block to `SERVER_INSTRUCTIONS` in `mcp-server/src/server.ts`
- [x] Mirror condensed rule into `find-article` prompt (`mcp-server/src/prompts.ts`)
- [x] Run `npm run mcp:update` to refresh manifest snapshot
- [x] Commit: e1d6eaa `feat(mcp): prose-link rule for reading + music tool results`
- [ ] User test: "find articles about the simpsons" — verify titles come back as clickable markdown links (pending rewind-local reload)
- [ ] User test: "what are my top albums this month" — verify album/artist names come back as markdown links to Apple Music

## Phase 2 — Reading card UI

### 2a — Scaffold ✅

- [x] Create `mcp-server/web/recent-reads.html`
- [x] Create `mcp-server/web/recent-reads.tsx` entry component
- [x] Create `mcp-server/web/components/ArticleCard.tsx` (Instapaper-style row)
- [x] Create `mcp-server/web/components/ArticleList.tsx`
- [x] Create `mcp-server/web/lib/time-ago.ts` (ISO → "6d ago")

### 2b — Card rendering ✅

- [x] Title row (2-line clamp, 16px bold)
- [x] Meta row (domain · N min read · time ago)
- [x] Excerpt row (2-line clamp, 14px, description)
- [x] Right-column image (80×80 rounded, thumbhash fade-in)
- [x] No-image fallback tile (accent_color background + domain text)
- [x] Whole-card click → `instapaper_url` in new tab
- [x] Theme-aware styles (CSS variables from host)

### 2c — Wiring ✅

- [x] Add `_meta.ui.resourceUri` to `get_recent_reads` registration
- [x] Register `ui://rewind/recent-reads.html` in `server.ts`
- [x] Build: `INPUT=recent-reads.html npm run build:web` (468KB raw / 455KB inlined)
- [x] `npm run mcp:update`
- [x] All 99 tests pass
- [x] Commit: 1864c65 `feat(mcp): interactive article card list UI for get_recent_reads`

### 2d — Iteration (user-driven) ⏳

- [ ] User reloads Claude Desktop rewind-local entry
- [ ] User runs `get_recent_reads`, screenshots result
- [ ] Design review cycle 1: user feedback, I adjust
- [ ] Design review cycle 2: user feedback, I adjust
- [ ] Design review cycle N: until user says "ship it"

## Phase 3 — Music card UIs

### 3a — `get_top_albums` (album grid) ✅

- [x] `components/AlbumCard.tsx` (square cover + name + artist + playcount)
- [x] `components/AlbumGrid.tsx` (responsive grid wrapper)
- [x] `top-albums.html` + `top-albums.tsx`
- [x] Wire `_meta.ui.resourceUri` on `get_top_albums` (converted to `server.registerTool`)
- [x] Register in `server.ts`
- [x] Build: `INPUT=top-albums.html npm run build:web`

### 3b — `get_top_artists` (circular portrait grid) ✅

- [x] `components/ArtistCard.tsx` (circular portrait + name + play count)
- [x] `components/ArtistGrid.tsx`
- [x] `top-artists.html` + `top-artists.tsx`
- [x] Wire `_meta.ui.resourceUri` on `get_top_artists`
- [x] Register in `server.ts`
- [x] Build: `INPUT=top-artists.html npm run build:web`

### 3c — Ship ✅

- [x] `npm run mcp:update` (manifest snapshot regen)
- [x] All 99 tests pass
- [x] Bundle sizes: top-albums 454KB, top-artists 454KB (well under 1MB per-resource cap)

### 3d — Iteration (user-driven) ⏳

- [ ] User reloads Claude Desktop rewind-local entry
- [ ] User runs `get_top_albums`, screenshots result
- [ ] User runs `get_top_artists`, screenshots result
- [ ] Design review cycles until user says "ship it"

## Phase 4 — stretch (not committed)

- [ ] Extend card UI to `search` / `semantic_search` when `domain=reading` or `domain=listening`
- [ ] Extend to `find_similar_articles`
- [ ] Extend to `get_recent_listens` (scrobble feed)

## Phase 5 — publish

- [ ] User green-lights ship
- [ ] Bump `rewind-mcp-server` version (minor: 0.4.3 → 0.5.0, since it's a meaningful UI addition)
- [ ] `npm publish`
- [ ] Deploy remote Worker at `mcp.rewind.rest`
- [ ] Update docs-mintlify changelog
- [ ] Verify Claude Desktop users on `rewind` (npm) entry get the same experience as `rewind-local` users

## Blockers / escalations

_If a task here can't complete, pause and raise with the user before moving on._

- [ ] (none yet)

## Shipped

_Move completed phases here with their commit SHAs for traceability._
