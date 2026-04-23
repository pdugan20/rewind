# reading-music-cards

MCP Apps interactive card UIs for reading (`get_recent_reads`) and music (`get_top_albums`, `get_top_artists`), plus a universal prose-link fallback for clients without MCP Apps support (Claude iOS).

## Problem

Rewind tools emit URLs as `resource_link` content blocks and images as `image` content blocks. Claude Desktop renders both inside the tool-use accordion, not inline with the assistant's message. Result: users see a plain list of titles in prose with no clickable source URLs and no artwork. The article list "feels" less capable than what Instapaper / Apple Music already ship natively, despite all the data already being available.

## Goals

1. **Phase 0 — `description` field mapping fix.** API returns `null` for `description` on every article despite `og_description` being populated. ~3-line route change in `src/routes/reading.ts`.
2. **Phase 1 — SERVER_INSTRUCTIONS prose-link rule.** Tell Claude to render article/album titles as markdown links `[title](url)` from `structuredContent`. Works everywhere, including iOS.
3. **Phase 2 — Reading card UI.** Interactive Instapaper-style card list for `get_recent_reads` on MCP Apps-capable clients. Text + resource_links path stays unchanged for non-capable clients.
4. **Phase 3 — Music card UIs.** Album cover grid for `get_top_albums`, artist portrait row for `get_top_artists`. Reuses the Phase 2 scaffold.

## Non-goals

- Redesigning the plain-text tool response shape — non-MCP-Apps clients keep exactly what they have today.
- Publishing to npm mid-iteration — we use the `rewind-local` MCP Desktop entry (memory: `feedback_mcp_dev_workflow.md`). Only bump npm version after user green-lights the final design.
- Editorial `description` field — Phase 0 serves `og_description` through the existing `description` response key. Real editorial descriptions are not in scope.
- Search / semantic_search / find_similar_articles / browse_movies UIs — possible Phase 4 stretch, not committed.

## Success criteria

- Sampled `/reading/recent?limit=50` returns non-null `description` on ~54% of items (matches existing og_image coverage).
- `get_recent_reads` in Claude Desktop renders an interactive card grid matching the agreed-upon design; each card has click-throughs to source URL, Instapaper web, Instapaper iOS app.
- `get_top_albums` renders a clickable album cover grid with Apple Music links.
- Claude iOS (no MCP Apps) shows markdown-linked article and album titles in assistant prose.
- Bundle size per UI stays ≤600KB (50% of 1MB Claude Desktop per-resource cap).
- Existing `get_recent_watches` UI continues to render — no regression.

## References

- MCP Apps spec: https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- Existing reference implementation: `mcp-server/web/recent-watches.tsx` + `mcp-server/web/components/PosterCard.tsx`
- Prior project docs: `docs/projects/mcp-apps/`, `docs/projects/mcp-richness/`
- Related: `docs/projects/reading-search/` (shipped v0.4.3, supplied the data backing this UI)

## Iteration protocol

- UI design is done live: user sends screenshots + verbal feedback, I edit TSX, rebuild, user reloads Claude Desktop (local entry).
- Per user instruction: if a phase hits an unexpected blocker (Claude Desktop rendering issue, spec disagreement, tool wiring that doesn't fire), **stop and escalate** rather than shipping a partial fix.
