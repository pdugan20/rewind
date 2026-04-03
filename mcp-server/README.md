# rewind-mcp-server

[![npm version](https://img.shields.io/npm/v/rewind-mcp-server)](https://www.npmjs.com/package/rewind-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/rewind-mcp-server)](https://www.npmjs.com/package/rewind-mcp-server)
[![CI](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml)

MCP server for the [Rewind](https://rewind.rest) personal data API. Gives Claude access to your listening, running, watching, collecting, and reading data.

## Setup

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

Or with Claude Code:

```bash
claude mcp add rewind -- npx -y rewind-mcp-server
```

Requires a [Rewind API key](https://docs.rewind.rest/authentication). `REWIND_API_URL` defaults to `https://api.rewind.rest`.

## Tools

| Domain                         | Tools                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| **Listening** (Last.fm)        | Now playing, recent scrobbles, stats, top artists/albums/tracks, streaks, artist and album details |
| **Running** (Strava)           | Stats, recent runs, personal records, streaks, activity details, per-mile splits                   |
| **Watching** (Plex/Letterboxd) | Recent watches, movie details, browse movies by genre/decade/director, stats                       |
| **Collecting** (Discogs)       | Browse vinyl collection, collection stats                                                          |
| **Reading** (Instapaper)       | Recent articles, highlights, random highlight, stats                                               |
| **Cross-domain**               | Full-text search, unified feed, on-this-day, health check                                          |

29 tools, 4 resources, 3 prompt templates. All read-only. [Full documentation](https://docs.rewind.rest/mcp-server)

## Example Queries

- "What have I been listening to this week?"
- "Show me my mile splits from my last run"
- "What horror movies have I watched?"
- "Give me a random reading highlight"
- "What happened on this day in previous years?"
