# MCP Apps -- Design

Canonical shapes, build pipeline, CSP, and component contracts. Deviate from this doc only by updating it first.

## Target clients

- **Claude Desktop** (macOS + Windows) -- primary
- **Claude web** (claude.ai) -- secondary
- **VS Code GitHub Copilot Insiders** -- tertiary (useful for dev testing)
- **Claude iOS** -- not supported at launch (Jan 2026); status April 2026 unclear; fallback must work
- **Claude Code CLI, ChatGPT, Cursor, etc.** -- do not render MCP Apps; fallback must work

Source: [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview), [launch post](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/).

## Protocol

### Tool → UI linkage

A tool declares its UI via `_meta.ui.resourceUri`. The existing tool response shape is unchanged; `_meta` is additive.

```ts
server.tool(
  'get_recent_watches',
  '...existing description...',
  { limit, ...dateFilterParams, ...includeImagesParam },
  READ_ONLY_ANNOTATIONS,
  handler,
  { _meta: { ui: { resourceUri: 'ui://rewind/recent-watches.html' } } }
);
```

Source: [apps.mdx L321-345](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) -- the `McpUiToolMeta` interface.

The existing `registerTool` / `tool` signature may not accept a sixth arg for `_meta`; verify during Phase 2. If not, use the modern `server.registerTool(...)` form which accepts `{ _meta }`.

### UI resource

```ts
server.resource(
  'ui-recent-watches',
  'ui://rewind/recent-watches.html',
  {
    description: 'Poster grid UI for recent watches',
    mimeType: 'text/html;profile=mcp-app',
  },
  async (uri) => {
    const html = await loadAsset(env.ASSETS, 'recent-watches.html');
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/html;profile=mcp-app',
          text: html,
          _meta: {
            ui: {
              csp: {
                resourceDomains: ['https://cdn.rewind.rest'],
              },
            },
          },
        },
      ],
    };
  }
);
```

MIME type MUST be `text/html;profile=mcp-app` exactly. Content is inlined as `text`; external HTTPS URLs for UI resources are reserved for future extensions. Source: [apps.mdx L267-270](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

### Serving the bundle

```ts
async function loadAsset(assets: Fetcher, path: string): Promise<string> {
  const res = await assets.fetch(
    new Request(new URL(`/${path}`, 'https://assets.invalid').toString())
  );
  if (!res.ok) {
    throw new Error(`Asset ${path} missing: ${res.status}`);
  }
  return await res.text();
}
```

Reference: [MCPJam server/mcp.ts L20-55](https://github.com/MCPJam/mcp-app-workers-template/blob/main/server/mcp.ts).

### CSP

Default is `default-src 'none'`. Extend only what's needed.

For the poster grid:

- `resourceDomains: ['https://cdn.rewind.rest']` -- poster `<img>` src
- No `connectDomains` in Phase 2 (structuredContent delivers everything we need)
- No special permissions

If Phase 3b adds `app.callServerTool(...)` for fresh data, the call goes through the host and does not require CSP changes. `openLink` also goes through the host.

Source: [apps.mdx L278-284](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

## Build pipeline

### File layout

```text
mcp-server/
  wrangler.toml                    -- [assets] binding = "ASSETS"
  package.json                     -- adds react, vite, ext-apps deps
  tsconfig.json                    -- existing server TS config (unchanged)
  web/
    tsconfig.json                  -- NEW; JSX, DOM lib, target ES2022
    vite.config.ts                 -- NEW; react() + viteSingleFile(); input = env.INPUT
    hello.html                     -- NEW (Phase 1, deleted in Phase 2)
    hello.tsx                      -- NEW (Phase 1, deleted in Phase 2)
    recent-watches.html            -- NEW (Phase 2)
    recent-watches.tsx             -- NEW (Phase 2)
    components/
      PosterGrid.tsx               -- NEW (Phase 2)
      PosterCard.tsx               -- NEW (Phase 2)
    lib/
      thumbhash.ts                 -- NEW (Phase 3); decode thumbhash -> data: URL
      theme.ts                     -- NEW (Phase 3); apply host theme vars
    dist/                          -- .gitignored; Vite output
      hello.html                   -- Phase 1 temp
      recent-watches.html          -- Phase 2 target
  src/
    types/env.ts                   -- existing; add ASSETS: Fetcher
    worker.ts                      -- existing; pass env to createServer
    server.ts                      -- existing; accept env param, thread to registerResources
    resources/
      ui.ts                        -- NEW; registerUiResource helper + loadAsset helper
    tools/
      debug.ts                     -- NEW (Phase 1, deleted in Phase 2); _ui_hello tool
      watching.ts                  -- existing; add _meta.ui.resourceUri to get_recent_watches
```

### Build command

```bash
# Phase 1
cd mcp-server && INPUT=hello.html npx vite build --config web/vite.config.ts
# Phase 2
cd mcp-server && INPUT=recent-watches.html npx vite build --config web/vite.config.ts
```

Wire both into `package.json`:

```json
{
  "scripts": {
    "build:web": "INPUT=recent-watches.html vite build --config web/vite.config.ts",
    "build:server": "tsc",
    "build": "npm run build:web && npm run build:server",
    "deploy": "npm run build && wrangler deploy"
  }
}
```

`vite-plugin-singlefile` inlines all JS, CSS, and small assets into one HTML file. Expected bundle size: React 19 runtime + ReactDOM ~80KB gzipped, ext-apps SDK ~10KB, our code ~5-10KB, total ~100KB gzipped / ~350KB uncompressed. Well under any practical limit.

## Component contracts

### Data shape in

The app receives the standard tool result via `useApp().ontoolresult`. The payload's `structuredContent` already matches `{ items: RecentWatch[] }` (see `mcp-server/src/tools/watching.ts`). The app does not need to refetch anything.

```ts
// RecentWatch -- reproduced from src/tools/watching.ts; source of truth stays server-side
type RecentWatch = {
  movie: {
    id: number;
    title: string;
    year: number | null;
    director: string | null;
    tmdb_id: number | null;
    image: {
      cdn_url?: string | null;
      url?: string | null;
      thumbhash?: string | null;
      dominant_color?: string | null;
      accent_color?: string | null;
    } | null;
  };
  watched_at: string;
  user_rating: number | null;
  rewatch: boolean;
  source: string | null;
  review: string | null;
  review_url: string | null;
};
```

### `<PosterGrid>`

```ts
type PosterGridProps = {
  items: RecentWatch[];
  onOpen: (url: string) => void; // invoked for review_url clicks
};
```

Renders a responsive grid (CSS Grid, `auto-fill minmax(160px, 1fr)`). Up to 5 columns on wide hosts, 2 on narrow. No virtualization for Phase 2 (we expect <50 items).

### `<PosterCard>`

```ts
type PosterCardProps = {
  watch: RecentWatch;
  onOpen?: (url: string) => void;
};
```

- Poster from `watch.movie.image.cdn_url`, falls back to thumbhash data URL, falls back to solid `dominant_color`
- Title + year below
- Rating badge (top-right, when `user_rating !== null`)
- [REWATCH] tag (top-left, when `rewatch === true`)
- Click opens `review_url` via `onOpen` (no-op if absent)
- Keyboard accessible (native `<button>` or `<a>` as root)

## Host protocol usage

### Phase 2

- `useApp()` hook from `@modelcontextprotocol/ext-apps/react`
- `app.ontoolresult(result)` -- subscribe to tool results; render `result.structuredContent.items`
- `app.openLink(url)` -- open external URLs (review_url) in the user's default browser

### Phase 3b (deferred)

- `app.callServerTool('get_movie_detail', { id })` -- fetch detail on poster click
- `app.sendMessage(...)` -- push context back to the conversation

Source: [apps.mdx Communication Protocol L411-1270](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

## Fallback contract

Clients that do not support MCP Apps (Claude Code CLI, Claude iOS, ChatGPT before launch, Cursor, etc.) ignore `_meta.ui.resourceUri` and render the tool's existing content blocks. The current response shape from `get_recent_watches` must remain untouched:

```ts
return {
  content: [
    text(humanReadableSummary),
    ...topNPosterImages,
    ...topNLetterboxdResourceLinks,
  ],
  structuredContent: { items: data },
};
```

Do not remove the image content blocks or the resource_links. MCP Apps is additive.

## Testing

- Unit tests for components via `vitest` + `@testing-library/react` (Phase 2)
- Server-side test via the existing in-memory MCP client: call the UI resource, assert the returned content is `text/html;profile=mcp-app` and the text starts with `<!DOCTYPE html>`
- Smoke test in Claude Desktop (manual, per phase) per `TRACKER.md` steps 1.1.7, 2.1.8, 4.1.2

## Tradeoffs

- **React 19 over Preact.** +30KB bundle; matches official examples + MCPJam template + team familiarity. Acceptable.
- **Single-file bundle over external CDN.** Faster load, simpler CSP, no cache-invalidation logic. Static Assets binding handles caching transparently.
- **No state management library.** Phase 2 is one-shot render. Phase 3b, if/when we add mutations, uses React Context -- not Redux / Zustand.
- **Vitest for React components.** Already in the project; adding `@testing-library/react` is the smallest delta.

## Open questions (verify during implementation)

- Does the current `server.tool(name, desc, schema, annotations, handler)` signature accept a 6th `{ _meta }` arg, or do we need to migrate that one tool to `server.registerTool(...)` for the `_meta.ui` field? Likely the latter -- check SDK types when Phase 2 starts.
- Is `@modelcontextprotocol/ext-apps` compatible with Cloudflare Workers runtime? It should be (MCPJam template uses it on Workers), but verify imports resolve clean on first build.
- What's the actual Workers Static Assets `Fetcher` type? Import from `@cloudflare/workers-types` during Phase 0.
