# rewind-mcp-server

[![CI](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml)
[![npm version](https://img.shields.io/npm/v/rewind-mcp-server?logo=npm)](https://www.npmjs.com/package/rewind-mcp-server)
[![docs](https://img.shields.io/badge/docs-docs.rewind.rest-blue)](https://docs.rewind.rest/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/MIT)

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
| **Collecting** (Discogs/Trakt) | Browse vinyl collection, physical media (Blu-ray/4K/HD DVD), collection stats                      |
| **Reading** (Instapaper)       | Recent articles, highlights, random highlight, stats                                               |
| **Cross-domain**               | Full-text search, unified feed, on-this-day, health check                                          |

## Example Queries

- "What albums have I been listening to the most recently?"
- "Compare my mile splits from this month vs last month"
- "When was the last time I watched a film by Wes Anderson?"
- "What Beastie Boys records are missing from my vinyl collection?"
- "How many articles did I read last year and stack-rank the top 10 sources"
- "Can you give me a quick summary of everything I did last week?"
