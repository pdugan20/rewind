# Tracker

## Phase 0 — `description` field mapping fix

- [ ] Add `description ?? ogDescription` coalesce to `/reading/recent` response mapper
- [ ] Same coalesce in `/reading/articles` (list endpoint)
- [ ] Same coalesce in `/reading/articles/{id}` (detail endpoint)
- [ ] Verify with local `npm test` — no regression
- [ ] Regenerate `openapi.snapshot.json` via `npx vitest run src/__tests__/openapi-snapshot.test.ts --update`
- [ ] Sample check: `curl /reading/recent?limit=50 | jq '[.data[].description != null] | length'` returns ≥ ~27 (54% of 50)
- [ ] Commit: `fix(reading): serve og_description when editorial description is null`

## Phase 1 — SERVER_INSTRUCTIONS prose-link rule

- [ ] Add `LINKING` block to `SERVER_INSTRUCTIONS` in `mcp-server/src/server.ts`
- [ ] Mirror condensed rule into `find-article` prompt (`mcp-server/src/prompts.ts`)
- [ ] Run `npm run mcp:update` to refresh manifest snapshot
- [ ] Local build (`cd mcp-server && npm run build`) + reload rewind-local in Claude Desktop
- [ ] User test: "find articles about the simpsons" — verify titles come back as clickable markdown links
- [ ] User test: "what are my top albums this month" — verify album/artist names come back as markdown links to Apple Music
- [ ] Commit: `feat(mcp): prose-link rule for reading + music results (SERVER_INSTRUCTIONS)`

## Phase 2 — Reading card UI

### 2a — Scaffold

- [ ] Create `mcp-server/web/recent-reads.html` (mirror `recent-watches.html`)
- [ ] Create `mcp-server/web/recent-reads.tsx` entry component
- [ ] Create `mcp-server/web/components/ArticleCard.tsx` (Instapaper-style row)
- [ ] Create `mcp-server/web/lib/time-ago.ts` (ISO → "6d ago")
- [ ] Create `mcp-server/web/lib/cdn-url.ts` (CDN transform URL builder)

### 2b — Card rendering

- [ ] Title row (2-line clamp, 16px bold)
- [ ] Meta row (domain · N min read · time ago)
- [ ] Excerpt row (2-line clamp, 14px, `description ?? excerpt`)
- [ ] Right-column image (80×80 rounded, thumbhash fade-in via `lib/thumbhash.ts`)
- [ ] No-image fallback tile (accent_color background + domain text)
- [ ] Whole-card click → `instapaper_url` in new tab
- [ ] Theme-aware styles (light/dark, read from host theme)

### 2c — Wiring

- [ ] Add `_meta.ui.resourceUri` to `get_recent_reads` registration in `mcp-server/src/tools/reading.ts`
- [ ] Register `ui://rewind/recent-reads.html` in `mcp-server/src/server.ts`
- [ ] Build: `INPUT=recent-reads.html npm run build:web`
- [ ] Verify `scripts/inline-bundles.mjs` picks up the new file → re-inlines into `ui-bundles.ts`
- [ ] `npm run mcp:update` (manifest snapshot regen)

### 2d — Iteration (user-driven)

- [ ] User reloads Claude Desktop rewind-local entry
- [ ] User runs `get_recent_reads`, screenshots result
- [ ] Design review cycle 1: user feedback, I adjust
- [ ] Design review cycle 2: user feedback, I adjust
- [ ] Design review cycle N: until user says "ship it"
- [ ] Commit: `feat(mcp): interactive article card UI for get_recent_reads`

## Phase 3 — Music card UIs

### 3a — `get_top_albums` (album grid)

- [ ] Generalize `PosterCard.tsx` → `MediaCard.tsx` (accept generic cover + 3 text lines + URL)
- [ ] `top-albums.html` + `top-albums.tsx`
- [ ] Wire `_meta.ui.resourceUri` on `get_top_albums` in `tools/listening.ts`
- [ ] Register in `server.ts`
- [ ] Local test + iterate

### 3b — `get_top_artists` (portrait row)

- [ ] `components/ArtistCard.tsx` (circular portrait + name + play count)
- [ ] `top-artists.html` + `top-artists.tsx`
- [ ] Wire `_meta.ui.resourceUri` on `get_top_artists`
- [ ] Register in `server.ts`
- [ ] Local test + iterate

### 3c — Ship

- [ ] `npm run mcp:update` (manifest snapshot regen)
- [ ] Commit: `feat(mcp): interactive card UIs for get_top_albums and get_top_artists`

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
