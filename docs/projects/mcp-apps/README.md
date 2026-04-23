# Project: MCP Apps -- Poster Grid

Add an interactive UI app to the Rewind MCP server that renders a poster grid when users ask about their recent watches. Claude Desktop currently displays MCP `image` content blocks inside the collapsed tool-use accordion; MCP Apps (Anthropic's Jan 2026 extension) render inline in the chat body as a sandboxed iframe. This is Tier 3 from the mcp-richness project, previously parked while we validated the target client.

## Motivation

The mcp-richness project (v0.2.0 shipped) gives Claude rich information about watches: posters, Letterboxd links, structured metadata. In Claude Desktop, images render only when the user expands the tool-use block. For prominent visual display -- "what did I watch last month" returning an actual grid of posters in the chat body -- the officially supported path is MCP Apps.

## Scope

**Pilot: option 3a.** A single UI resource (`ui://rewind/recent-watches.html`) linked from `get_recent_watches` via `_meta.ui.resourceUri`. The existing tool response (text + structuredContent + image blocks) is unchanged; the UI resource consumes the `structuredContent` and renders a responsive grid of posters with thumbhash placeholders, dominant_color borders, and click-to-open Letterboxd links.

## Non-goals

- **Option 3b** (detail pages for album / movie / artist via app-only tool calls). Reconsider after 3a ships.
- **Option 3c** (year-in-review dashboard). Separate future project.
- **Option 3d** (running map, vinyl shelf, everything). Separate future project.
- **Claude iOS rendering.** Confirmed not in initial launch (Jan 2026); status as of April 2026 unclear. Users on iOS continue to get the existing rich-response fallback. Verify at deploy.
- **Server-side rendering.** All rendering happens in the sandboxed iframe.

## Architecture

### Current

```text
mcp.rewind.rest  ->  Cloudflare Worker (src/worker.ts)
                     -> Hono router
                     -> McpServer (tools / resources / prompts)
                     -> RewindClient -> api.rewind.rest
```

### Target

```text
mcp.rewind.rest  ->  Cloudflare Worker (src/worker.ts)
                     -> Hono router
                     -> McpServer (tools / resources / prompts)
                     -> RewindClient -> api.rewind.rest
                     -> env.ASSETS binding -> serves bundled HTML UI

mcp-server/web/  ->  Vite + React 19 + vite-plugin-singlefile
                     -> builds to mcp-server/web/dist/recent-watches.html
                     -> served via Workers Static Assets at request time
```

## Stack

| Component | Choice                                   | Reason                                                                                                    |
| --------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Framework | React 19                                 | Official ext-apps examples + [MCPJam template](https://github.com/MCPJam/mcp-app-workers-template) use it |
| Bundler   | Vite + `vite-plugin-singlefile`          | Only stack in official examples; produces one inlined HTML                                                |
| SDK       | `@modelcontextprotocol/ext-apps`         | Official; provides `useApp()` hook + `registerAppTool`/`registerAppResource` server helpers               |
| Hosting   | Cloudflare Workers Static Assets binding | Matches MCPJam reference template; no separate CDN / Pages site                                           |
| Styling   | Inline CSS (no framework)                | Keep bundle small                                                                                         |

## Reference implementation

[MCPJam/mcp-app-workers-template](https://github.com/MCPJam/mcp-app-workers-template) -- a working Cloudflare Workers template that serves both the MCP JSON-RPC endpoint and a UI bundle via Static Assets. Our architecture mirrors this exactly.

## Documents

| File                     | Purpose                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| [TRACKER.md](TRACKER.md) | Phased task checklist                                                                |
| [DESIGN.md](DESIGN.md)   | Canonical shapes: tool `_meta`, UI resource CSP, build pipeline, component contracts |

## Phase summary

| Phase | Focus                       | Scope                                                                                                    |
| ----- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| 0     | Foundation                  | `web/` dir, Vite + React + TS setup, SDK deps, Workers Static Assets binding, build pipeline             |
| 1     | Hello-world UI resource     | Throwaway React app rendered from a throwaway tool, end-to-end smoke test in Claude Desktop              |
| 2     | Poster grid integration     | Real `PosterGrid` component consuming `get_recent_watches` structuredContent                             |
| 3     | Visual polish               | Thumbhash placeholders, dominant_color borders, hover states, Letterboxd click handlers, host-theme vars |
| 4     | Smoke test, deploy, publish | Validate in Claude Desktop, deploy Worker, bump to 0.3.0, user-triggered npm publish                     |

## Sequencing notes

- **Phase 0 first, always.** The Workers Static Assets binding needs to be wired before any UI resource can be served.
- **Phase 1 is a throwaway verification.** If the hello-world renders in Claude Desktop, the whole pipeline works. Saves debugging time later.
- **Phase 2 integrates real data.** **Phase 3 makes it look good.** If you only had time for 0+1+2 you'd have working posters -- Phase 3 is polish.
- **Do not remove anything from the current tool response.** Clients that don't support MCP Apps ignore `_meta.ui.resourceUri` and fall back to the existing rich text + image + resource_link response. That fallback must keep working.

## Confidence

- **High** on everything protocol-related (spec L267-345, working MCPJam reference template)
- **High** on the stack decision (all official examples converge on Vite + singlefile + React)
- **Medium** on Claude iOS current state (not in initial launch; April 2026 status unclear; fallback exists either way so iOS users are never blocked)
- **Low** on launch-partner architectures (Box/Figma/Hex haven't published source) -- not needed to build this
