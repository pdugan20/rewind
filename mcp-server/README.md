# rewind-mcp-server

[![CI](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml)
[![npm version](https://img.shields.io/npm/v/rewind-mcp-server?logo=npm)](https://www.npmjs.com/package/rewind-mcp-server)
[![docs](https://img.shields.io/badge/docs-docs.rewind.rest-blue)](https://docs.rewind.rest/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/MIT)

MCP server for the [Rewind](https://rewind.rest) personal data API. Gives AI assistants access to your listening, running, watching, collecting, reading, and event-attendance data.

Full reference: [docs.rewind.rest/mcp-server](https://docs.rewind.rest/mcp-server).

## Setup

### Desktop apps

Add to your MCP client config (Claude Desktop, ChatGPT, Gemini, etc.):

```json
{
  "mcpServers": {
    "rewind": {
      "command": "npx",
      "args": ["-y", "rewind-mcp-server"],
      "env": {
        "REWIND_API_KEY": "rw_live_your_key_here"
      }
    }
  }
}
```

### Mobile and web

Add as a remote integration in your client's settings:

- **URL**: `https://mcp.rewind.rest/mcp`
- **Authorization**: `Bearer rw_live_your_key_here`

<details>
<summary>Claude Code</summary>

```bash
claude mcp add rewind -- npx -y rewind-mcp-server
```

</details>

Requires a [Rewind API key](https://docs.rewind.rest/authentication). `REWIND_API_URL` defaults to `https://api.rewind.rest`.

## Tools

| Domain           | Source           | Tools                                                                                                                               |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Listening**    | Last.fm          | Now playing, recent scrobbles, stats, top artists/albums/tracks, streaks, artist and album details, genre breakdown over time       |
| **Running**      | Strava           | Stats, recent runs, personal records, streaks, activity details, per-mile splits, per-year summaries                                |
| **Watching**     | Plex, Letterboxd | Recent watches, movie details, browse by genre/decade/director, stats, genre/decade/director breakdowns                             |
| **Collecting**   | Discogs, Trakt   | Vinyl collection, physical media, collection and media stats                                                                        |
| **Reading**      | Instapaper       | Recent articles, highlights, random highlight, stats, semantic similar-article recall via `find_similar_articles`                   |
| **Attending**    | Calendar, Gmail  | Attended events with filters, single event with player stat lines, sports season W/L, player photos and appearances, year-in-review |
| **Cross-domain** | All              | Full-text search with keyword/semantic/hybrid modes, dedicated `semantic_search` for reading, unified feed, on-this-day, health     |

Tool responses include images, click-through resource links, and structured JSON. Pass `include_images: false` to keep responses compact.

On clients that support [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) (Claude Desktop, Claude web, VS Code Copilot, Goose), `get_recent_watches`, `get_recent_reads`, `get_top_albums`, and `get_top_artists` render interactive grids inline; other clients see the standard text + image response.

## Example queries

- "What albums have I been listening to the most recently?"
- "Compare my mile splits from this month vs last month"
- "When was the last time I watched a film by Wes Anderson?"
- "What Beastie Boys records are missing from my vinyl collection?"
- "How many articles did I read last year and stack-rank the top 10 sources"
- "Can you give me a quick summary of everything I did last week?"

## Prompts

Slash-command prompts that orchestrate multiple tools: `weekly-summary`, `year-in-review`, `compare-periods`, `letterboxd-review-draft`, `training-report`, `film-diet`, `find-article`. See the [docs](https://docs.rewind.rest/mcp-server) for argument shapes.

## Authentication

Desktop apps use the `REWIND_API_KEY` env var passed to the server process; the server uses it as a Bearer token to the Rewind API.

Mobile and web clients connect to `mcp.rewind.rest` and authenticate via OAuth 2.1 with GitHub as the identity provider (1h access tokens, 90d refresh, PKCE S256).

The server is **read-only**. No write or admin operations are exposed.

## Privacy and support

- [Privacy policy](https://rewind.rest/privacy)
- [Documentation](https://docs.rewind.rest/mcp-server)
- [Report an issue](https://github.com/pdugan20/rewind/issues)

Album details optionally include accepted `cd_artwork` metadata and a transparent CD image. `include_images: false` retains the metadata without image content. Retail restorations and cover compositions are identified separately; missing or unavailable CD artwork preserves the existing album response.
