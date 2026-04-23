# Design

## Phase 0 — description field mapping

**Bug**: `src/db/schema/reading.ts` defines both `description` (always null, reserved for editorial) and `ogDescription` (populated from OG extraction at sync time, line 247 of `src/services/instapaper/sync.ts`). The route handler in `src/routes/reading.ts` returns `readingItems.description` directly, so the response field is always null.

**Fix**: coalesce in the response mapper — `description: row.description ?? row.ogDescription`. Three endpoints touched:

- `GET /v1/reading/recent`
- `GET /v1/reading/articles` (list)
- `GET /v1/reading/articles/{id}` (detail)

**Snapshot regen**: schema type stays `string | nullable`, so `openapi.snapshot.json` likely unchanged. Regen to confirm.

## Phase 1 — SERVER_INSTRUCTIONS prose-link rule

Add a `LINKING` block to `SERVER_INSTRUCTIONS` in `mcp-server/src/server.ts`:

```
LINKING — when presenting results from reading or listening tools in
your response, render each title as a markdown link using the `url`
field from structuredContent:
  [Title](https://...)
For reading articles, if `url` is null, fall back to `instapaper_url`.
For albums and artists, use `apple_music_url`. This is important
because Claude Desktop does not render resource_link blocks inline
with your message — without markdown links in prose, users see no
clickable URLs at all.
```

Same block (condensed) in the `find-article` prompt. Update manifest snapshot via `npm run mcp:update`.

## Phase 2 — Reading card UI

### Card anatomy

Matching the Instapaper iOS list style the user shared:

```
┌───────────────────────────────────────────┬──────────┐
│ With Steph Curry and Draymond Green       │          │
│ cooking, Warriors' Play-In win had...     │  [img]   │
│ nytimes.com · 8 min read · 6d ago         │  80×80   │
│ INGLEWOOD, Calif. — All night, Draymond   │  rounded │
│ Green played the long game in front of... │          │
└───────────────────────────────────────────┴──────────┘
```

- **Row height**: ~140px including padding
- **Left column** (flex:1):
  - Title: 2-line clamp, 16px bold
  - Meta: `{domain} · {estimated_read_min} min read · {timeAgo(saved_at)}` — 13px muted
  - Excerpt: 2-line clamp, 14px, use `description` (post-Phase-0) || `excerpt`
- **Right column** (80×80 fixed):
  - Image: rounded 8px, thumbhash fade-in (reuse `lib/thumbhash.ts` + pattern from `PosterCard.tsx`)
  - CDN URL: `cdn.rewind.rest/cdn-cgi/image/width=160,height=160,fit=cover,format=auto,quality=85/...` (2x for retina)
  - Fallback (~46% of items): solid `accent_color` background with white `domain` text centered, 18px bold

### Interaction

- **Card click (primary action)**: open `instapaper_url` (user's saved copy with highlights, paywall-free) in a new tab
- **Optional footer row** (only if tight): two small pills `Source` (→ `url`) and `Instapaper app` (→ `instapaper_app_url`, iOS-only). Decide during iteration — the Instapaper screenshot doesn't show any pills, so likely omit and rely on whole-card click.

### File layout

```
mcp-server/web/
  recent-reads.html              # entry, inlined by Vite singleFile
  recent-reads.tsx               # entry component, reads structuredContent
  components/
    ArticleCard.tsx              # new
    ArticleList.tsx              # new
    PosterCard.tsx               # existing (unchanged)
    PosterGrid.tsx               # existing (unchanged)
  lib/
    thumbhash.ts                 # existing
    time-ago.ts                  # new — formats ISO date → "6d ago" / "1w ago"
    cdn-url.ts                   # new — wraps CDN transform URL building
```

### Wiring

`mcp-server/src/tools/reading.ts::registerReadingTools` — on the `get_recent_reads` tool registration, add `_meta`:

```ts
{
  ui: { resourceUri: 'ui://rewind/recent-reads.html' },
  'ui/resourceUri': 'ui://rewind/recent-reads.html',
}
```

(Both modern and legacy keys, matching the watching.ts pattern.)

`mcp-server/src/server.ts` — after the recent-watches `registerUiResource`, add:

```ts
registerUiResource(server, {
  name: 'Rewind -- Recent Reads',
  uri: 'ui://rewind/recent-reads.html',
  html: UI_BUNDLES['recent-reads.html'],
  description:
    'Interactive article card list for recently saved reads. Consumes get_recent_reads structuredContent.',
  csp: {
    resourceDomains: ['https://cdn.rewind.rest'],
  },
});
```

### Build

Add `recent-reads` to the set Vite builds by running `INPUT=recent-reads.html vite build --config web/vite.config.ts`. `scripts/inline-bundles.mjs` already iterates over `web/dist/*.html` so no build-script change needed.

## Phase 3 — Music card UIs

### `get_top_albums` — album cover grid

Grid of 2–4 columns (responsive), each cell is a square album cover with title/artist overlay or below:

```
┌─────────┬─────────┬─────────┐
│ [cover] │ [cover] │ [cover] │
│ Ill Com.│ Hello N.│ Paul's  │
│ B. Boys │ B. Boys │ B. Boys │
│ 53 plays│ 45 plays│ 39 plays│
└─────────┴─────────┴─────────┘
```

Click → open `apple_music_url` in new tab.

Reuses `PosterCard.tsx` pattern closely (both are square artwork + text under). Probably just parameterize PosterCard to accept a generic "cover image + three lines of text + click-through URL" shape and rename to something like `MediaCard`.

### `get_top_artists` — circular portrait row

Horizontal scrollable row or grid of circular artist portraits:

```
 ⦿     ⦿     ⦿     ⦿
 B.Boys O.Rod S.Car Silk
 250    51    22    18
```

Click → open `apple_music_url` for artist in new tab.

### File layout (music)

```
mcp-server/web/
  top-albums.html
  top-albums.tsx
  top-artists.html
  top-artists.tsx
  components/
    MediaCard.tsx                # generalized PosterCard
    ArtistCard.tsx               # circular variant
```

## Fallback paths (non-MCP-Apps clients)

MCP Apps-capable: Claude Desktop, Claude web, VS Code GitHub Copilot, Goose → render the card UI.

All others (Claude iOS primarily, but also any CLI/basic client) → receive text + image + resource_link + structuredContent blocks as they do today, plus the Phase-1 markdown links in the assistant's prose response.

Phase 1 is the insurance policy. Phase 2/3 are the richness.

## CSP / sandbox considerations

Claude Desktop's MCP Apps iframe is sandboxed. Default CSP allows:

- `img-src 'self' data:` — we extend via `csp.resourceDomains` to allow `cdn.rewind.rest`
- Top-level navigation via `<a target="_blank" rel="noopener noreferrer">` works for http(s) URLs
- Custom URI schemes (`instapaper://...`) may be blocked by some hosts — verify during iteration; if blocked, drop the iOS-app pill on Desktop

## Bundle budget

| Bundle                  | Current / estimated | 1MB cap |
| ----------------------- | ------------------- | ------- |
| hello.html              | 461 KB              | ✓ safe  |
| recent-watches.html     | 467 KB              | ✓ safe  |
| recent-reads.html (est) | ~470 KB             | ✓ safe  |
| top-albums.html (est)   | ~470 KB             | ✓ safe  |
| top-artists.html (est)  | ~470 KB             | ✓ safe  |

React per-bundle cost: ~400KB just for React + React-DOM. Each bundle is mostly runtime; actual app code is tiny. No action required until a single bundle approaches ~900KB, which is extremely unlikely without adding large dependencies.

## Testing

- **Local iteration**: `cd mcp-server && npm run build` rebuilds all web entries and re-inlines. User's `rewind-local` MCP Desktop config points at the local build, so reload in Claude Desktop picks up changes immediately. No npm publish during iteration.
- **Smoke**: manifest-snapshot test (drift prevention), openapi-snapshot test (Phase 0 changes)
- **Visual QA**: user-driven via screenshots. Design is approved when user says "ship it."
- **Regression check**: confirm `get_recent_watches` still renders correctly after each phase.
