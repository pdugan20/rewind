# MCP Apps -- Task Tracker

Legend: [ ] pending, [x] done, [~] in progress.

## Phase 0: Foundation -- COMPLETE

Land the shared build pipeline and Workers Static Assets wiring before any UI work.

- [x] **0.1.1** `mcp-server/web/` directory created
- [x] **0.1.2** Deps installed into `mcp-server/` (single `node_modules`): `react@19.2.5`, `react-dom@19.2.5`, `@modelcontextprotocol/ext-apps@1.7.0`, `@types/react@19.2.14`, `@types/react-dom@19.2.3`, `vite@8.0.9`, `@vitejs/plugin-react@6.0.1`, `vite-plugin-singlefile@2.3.3`
- [x] **0.1.3** `mcp-server/web/vite.config.ts` -- uses `INPUT` env var to select entry, `emptyOutDir: false` so sequential builds don't wipe each other
- [x] **0.1.4** `mcp-server/web/tsconfig.json` -- JSX + DOM lib, Bundler module resolution, separate from server tsconfig (server tsconfig already scopes to `src/**` so no collision)
- [x] **0.1.5** `wrangler.toml` has `[assets] directory = "./web/dist"` `binding = "ASSETS"`
- [x] **0.1.6** Added `build:web` script; `deploy` script now runs `build:web` before `wrangler deploy`. Left `build` as `tsc` only -- Phase 1 will add the first real UI entry and we'll chain then
- [x] **0.1.7** `.gitignore` already covers `dist/` which matches `web/dist/`. No update needed; single `node_modules` at `mcp-server/` root (already ignored)
- [x] **0.1.8** `ASSETS: Fetcher` added to `Env` interface in `src/worker.ts`
- [x] **0.1.9** `npm run build` clean; `npm test` 98/98 passing

## Phase 1: Hello-world UI resource (throwaway validation) -- COMPLETE

End-to-end test of the pipeline using a trivial React app invoked from a throwaway tool. Proves the iframe renders and the `useApp()` hook receives tool results before we invest in real UI.

- [x] **1.1.1** `web/hello.html` entry -- `<div id="root"></div>` + module script
- [x] **1.1.2** `web/hello.tsx` -- React app using `useApp()`, renders status + tool-result JSON
- [x] **1.1.3** `src/resources/ui.ts` -- `registerUiResource(server, assets, config)` helper that loads the bundle from the ASSETS binding and calls `registerAppResource` from `@modelcontextprotocol/ext-apps/server`. CSP-extension optional.
- [x] **1.1.4** Throwaway `_ui_hello` tool in `src/tools/debug.ts` using `registerAppTool` from the SDK. `_meta.ui.resourceUri` = `ui://rewind/hello.html`. Open question resolved: SDK provides `registerAppTool`/`registerAppResource` helpers that encapsulate the `_meta` shape; we use those, no need to extend the legacy `server.tool` signature.
- [x] **1.1.5** Resource registered at `ui://rewind/hello.html`. Registration happens only when `env.ASSETS` is present (Worker context); stdio binary skips it.
- [x] **1.1.6** `INPUT=hello.html npm run build:web` -> `web/dist/hello.html` (461 KB / 123 KB gzipped, all JS inlined). `wrangler deploy` pushed version `5b64e67d`. `env.ASSETS` binding confirmed active on the Worker.
- [x] **1.1.7** Smoke-tested in Claude Desktop: iframe renders inline with React app, tool-result JSON visible inside. Pipeline confirmed end-to-end.

**Learnings from Phase 1:**

- Tool renamed `_ui_hello` -> `ui_hello_debug` because Claude Desktop's tool-list discovery hides `_`-prefixed names. Debug/internal tools should use plain snake_case names, not leading-underscore.
- Registering via the modern `server.registerTool(name, config, cb)` API directly (with `_meta.ui.resourceUri` + legacy `_meta["ui/resourceUri"]` for compat) is equivalent to using `registerAppTool` from `@modelcontextprotocol/ext-apps/server` and is one less dependency in the call path.
- Claude Desktop's "list every tool" prompt surfaces ~36 Rewind tools but does NOT always include debug-flavored ones; invoking by name still works. Do not trust "tool X missing from the listing" as evidence X is unregistered -- verify via direct invocation or `wrangler tail`.
- Debug tool registration is unconditional; UI resource registration requires `env.ASSETS`. Stdio context exposes the tool (text-only fallback) but has no iframe to render.

## Phase 2: Poster grid integration -- COMPLETE (Desktop stdio)

- [x] **2.1.1** Added `web/recent-watches.html` entry + `web/recent-watches.tsx` root component
- [x] **2.1.2** Built `web/components/PosterGrid.tsx` consuming `structuredContent.items` from `get_recent_watches`
- [x] **2.1.3** Built `web/components/PosterCard.tsx` with poster `<img>` from `cdn_url`, title, year, director, rating badge (`4.5★` scale, not `/10`), REWATCH flag
- [x] **2.1.4** `registerUiResource` uses inlined HTML bundle via `scripts/inline-bundles.mjs` (not `env.ASSETS` — see findings below)
- [x] **2.1.5** Migrated `get_recent_watches` to `server.registerTool` with `_meta.ui.resourceUri`; content + structuredContent shape unchanged; fallback intact for non-MCP-Apps clients
- [x] **2.1.6** Kept `ui_hello_debug` + `hello.html` as intentional A/B reference during capability debugging; harmless
- [x] **2.1.7** Built + deployed (local dist for Desktop stdio; Worker also deployed)
- [x] **2.1.8** Smoke test: poster grid renders inline in Claude Desktop via stdio. Remote path (claude.ai web / iOS) blocked on [anthropics/claude-ai-mcp#215](https://github.com/anthropics/claude-ai-mcp/issues/215)

## Phase 3: Visual polish -- IN PROGRESS

- [ ] **3.1.1** Install `thumbhash` npm package. Decode `image.thumbhash` -> data: URL placeholder shown before the `cdn_url` poster loads
- [x] **3.1.2** Replaced per-card `dominant_color` border with a uniform subtle border + shadow (`rgba(0,0,0,0.08)` + two-layer shadow). `dominant_color` was invisible on cards where it matched the chat background; uniform treatment is cleaner.
- [ ] **3.1.3** Hover state: slight scale + glow, no layout shift
- [x] **3.1.4** Click handler calls `app.openLink({ url })` when `review_url` present
- [x] **3.1.5** Empty state ("No watches in the selected window.")
- [ ] **3.1.6** Apply host theme via `useDocumentTheme` + `useHostStyleVariables` from `@modelcontextprotocol/ext-apps/react`
- [ ] **3.1.7** Responsive grid tuning (currently `auto-fill minmax(140px, 1fr)` -- functional, could be better)

## Phase 4: Smoke test, deploy, publish -- IN PROGRESS

- [x] **4.1.1** Final build complete. Worker redeploy pending once all Phase 3 polish has been verified end-to-end on Desktop stdio.
- [x] **4.1.2** Smoke-tested in Claude Desktop with "what did I watch last month" / "past week" / "past month" queries. Grid renders in both light and dark mode with theme-aware borders, hover states, thumbhash placeholders.
- [x] **4.1.3** Claude Code CLI fallback confirmed: text + resource_links still work; image blocks still delivered for model reasoning via tool-use accordion.
- [x] **4.1.4** `mcp-server/README.md` updated with new "Interactive UI (MCP Apps)" and "Prompts" sections.
- [x] **4.1.5** `package.json` bumped to `0.3.0`; `McpServer` info `version` bumped to match.
- [ ] **4.1.6** User runs `npm publish` when ready.
- [ ] **4.1.7** `mcp-richness` TRACKER already has the Tier-3 note referencing this project; no additional update needed there.
