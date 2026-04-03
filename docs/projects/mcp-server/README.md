# Project: MCP Server for Rewind

Build a Model Context Protocol (MCP) server that exposes the Rewind API as tools and resources for Claude. The server enables natural language interaction with personal data across all five domains (listening, running, watching, collecting, reading) from Claude Desktop, Claude Code, Claude iOS, and claude.ai.

## Motivation

The Rewind API has 80+ endpoints serving personal activity data. Today, interacting with this data requires knowing the API, writing curl commands, or building a custom UI. An MCP server lets Claude act as a natural language interface -- "What did I listen to last week?", "How's my running mileage compared to last year?", "Show me a random reading highlight" -- all answered from real data.

## Architecture

### Dual Transport Strategy

To maximize reach across all Claude surfaces, the server supports two transports:

```text
Claude Desktop / Claude Code
  └── stdio transport (local process, launched via npx)
        └── HTTP client -> api.rewind.rest

Claude iOS / claude.ai (web)
  └── Streamable HTTP transport (remote server)
        └── HTTP client -> api.rewind.rest
```

The core logic is shared -- only the transport layer differs.

### How It Fits Into Rewind

```text
api.rewind.rest (existing)
  ├── Hono REST API (unchanged)
  ├── /v1/openapi.json
  └── All existing consumers (site, docs, webhooks)

rewind-mcp-server (new, separate package)
  ├── Wraps REST API as MCP tools/resources
  ├── Authenticates with existing API key (rw_live_...)
  └── No direct DB access -- pure HTTP client
```

The MCP server is a **thin client** that calls the existing API. No business logic is duplicated. If the API changes, only tool definitions need updating.

### Hosting Options for Remote Transport

| Option                       | Pros                                      | Cons                        |
| ---------------------------- | ----------------------------------------- | --------------------------- |
| Cloudflare Worker (separate) | Same platform, low latency to API         | Another Worker to manage    |
| Fly.io / Railway             | Simple Node.js deploy, persistent process | Extra vendor                |
| Embedded in existing Worker  | Zero additional infra                     | Adds complexity to main API |

Recommendation: **Separate Cloudflare Worker** (`mcp.rewind.rest`). Keeps concerns isolated, same platform as the API, and can share the same Cloudflare account.

## MCP Primitives Mapping

### Tools (Actions -- things Claude can invoke)

Curated set of ~25 high-value tools across domains:

| Tool                     | API Endpoint                        | Description                       |
| ------------------------ | ----------------------------------- | --------------------------------- |
| `get_now_playing`        | `GET /v1/listening/now-playing`     | What's currently playing          |
| `get_recent_listens`     | `GET /v1/listening/recent`          | Recently scrobbled tracks         |
| `get_listening_stats`    | `GET /v1/listening/stats`           | Overall listening statistics      |
| `get_top_artists`        | `GET /v1/listening/top/artists`     | Top artists by period             |
| `get_top_albums`         | `GET /v1/listening/top/albums`      | Top albums by period              |
| `get_top_tracks`         | `GET /v1/listening/top/tracks`      | Top tracks by period              |
| `get_listening_streaks`  | `GET /v1/listening/streaks`         | Listening streak data             |
| `get_artist_details`     | `GET /v1/listening/artists/:id`     | Artist info and discography       |
| `get_album_details`      | `GET /v1/listening/albums/:id`      | Album details and metadata        |
| `get_running_stats`      | `GET /v1/running/stats`             | Overall running statistics        |
| `get_recent_runs`        | `GET /v1/running/recent`            | Recent running activities         |
| `get_personal_records`   | `GET /v1/running/prs`               | Fastest miles, longest runs, etc. |
| `get_running_streaks`    | `GET /v1/running/streaks`           | Consecutive activity streaks      |
| `get_activity_details`   | `GET /v1/running/activities/:id`    | Single run with splits            |
| `get_recent_watches`     | `GET /v1/watching/recent`           | Recently watched movies/TV        |
| `get_movie_details`      | `GET /v1/watching/movies/:id`       | Movie info, rating, review        |
| `get_watching_stats`     | `GET /v1/watching/stats`            | Total watch time, ratings         |
| `get_vinyl_collection`   | `GET /v1/collecting/vinyl`          | Browse vinyl records              |
| `get_collecting_stats`   | `GET /v1/collecting/stats`          | Collection statistics             |
| `get_recent_reads`       | `GET /v1/reading/recent`            | Recently saved articles           |
| `get_reading_highlights` | `GET /v1/reading/highlights`        | Extracted highlights              |
| `get_random_highlight`   | `GET /v1/reading/highlights/random` | Random reading highlight          |
| `get_reading_stats`      | `GET /v1/reading/stats`             | Reading statistics                |
| `search`                 | `GET /v1/search`                    | Cross-domain full-text search     |
| `get_feed`               | `GET /v1/feed`                      | Unified chronological feed        |
| `get_on_this_day`        | `GET /v1/feed/on-this-day`          | Historical "on this day" items    |

### Resources (Read-only data Claude can reference)

| Resource         | URI                              | Description                    |
| ---------------- | -------------------------------- | ------------------------------ |
| `sync-status`    | `rewind://sync/status`           | Current sync health per domain |
| `listening-year` | `rewind://listening/year/{year}` | Year-in-review for listening   |
| `running-year`   | `rewind://running/year/{year}`   | Year-in-review for running     |
| `watching-year`  | `rewind://watching/year/{year}`  | Year-in-review for watching    |

### Prompts (Reusable templates)

| Prompt            | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `weekly-summary`  | Summarize activity across all domains for the past week |
| `year-in-review`  | Generate a year-in-review for a given year              |
| `compare-periods` | Compare two time periods across a domain                |

## Installation & Distribution

### Claude Desktop (Mac)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rewind": {
      "command": "npx",
      "args": ["-y", "rewind-mcp-server"],
      "env": {
        "REWIND_API_KEY": "rw_live_...",
        "REWIND_API_URL": "https://api.rewind.rest"
      }
    }
  }
}
```

Claude Desktop launches the server as a child process, communicates over stdin/stdout via JSON-RPC. Requires quit + relaunch to pick up config changes. The Developer section in Settings shows connected servers and available tools.

### Claude Code

Option A -- project-level `.mcp.json`:

```json
{
  "mcpServers": {
    "rewind": {
      "command": "npx",
      "args": ["-y", "rewind-mcp-server"],
      "env": {
        "REWIND_API_KEY": "rw_live_...",
        "REWIND_API_URL": "https://api.rewind.rest"
      }
    }
  }
}
```

Option B -- CLI:

```bash
claude mcp add rewind -- npx -y rewind-mcp-server
```

### Claude iOS & claude.ai (Web) -- Remote Server

These platforms cannot launch local processes, so they connect to a hosted remote MCP server via Streamable HTTP.

**User setup:** Add the remote server URL in Claude.ai Settings > Integrations (syncs to iOS automatically):

```
URL: https://mcp.rewind.rest/mcp
Authorization: Bearer rw_live_...
```

**How it works:**

- Claude.ai and iOS support "Integrations" -- remote MCP servers configured by URL
- Uses Streamable HTTP transport (replaced SSE in 2025)
- OAuth 2.0 or Bearer token auth via headers
- Integrations sync across web and mobile on the same account
- Remote servers must handle their own lifecycle and multi-tenancy

### npm Distribution

Published as `rewind-mcp-server` on npm. Users install via `npx` (zero pre-install). The package includes:

- `#!/usr/bin/env node` shebang for direct execution
- `bin` field in package.json pointing to the built entry

### Discovery

- List on [mcp.so](https://mcp.so) (community MCP server directory)
- List on [smithery.ai](https://smithery.ai) (MCP registry with one-click configs)
- Tag GitHub repo with `mcp-server` topic

## Documents

| File                               | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| [TRACKER.md](TRACKER.md)           | Task tracker with phases and discrete tasks                   |
| [TOOLS.md](TOOLS.md)               | Tool definitions, input schemas, response formatting          |
| [INSTALLATION.md](INSTALLATION.md) | Detailed setup instructions for all platforms                 |
| [DEFERRED.md](DEFERRED.md)         | Items deferred during implementation -- revisit after Phase 5 |

## Phase Summary

| Phase | Focus                           | Scope                                                                                           |
| ----- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1     | Scaffold & transport validation | npm package, SDK setup, stdio + remote transport spike, HTTP client, dedicated MCP API key      |
| 2     | Core tools                      | Implement ~25 tools covering all five domains with formatted responses and error handling       |
| 3     | Resources & prompts             | Year-in-review resources, prompt templates, sync status resource                                |
| 4     | Remote transport & deployment   | Dual transport, Cloudflare Worker deployment, DNS, OAuth investigation, iOS/web/Desktop testing |
| 5     | Publish & distribution          | npm publish, registry listings, docs site section, GitHub topic, .mcp.json for this repo        |

## Key Design Decisions

- **Remote transport validated early** (Phase 1 spike) to catch Workers runtime incompatibilities before building all tools
- **Dedicated MCP API key** with higher rate limit (120+ RPM) to handle Claude's multi-tool-call patterns
- **Default limit of 10** on all list endpoints to keep responses concise for Claude's context window
- **Text formatting, not JSON** -- tools return human-readable summaries, not raw API responses
- **`isError: true`** on all error paths so Claude knows when a tool call failed
- **Deferred items tracked** in DEFERRED.md for post-launch revisit rather than dropped silently
