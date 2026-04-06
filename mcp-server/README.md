# rewind-mcp-server

[![CI](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml)
[![npm version](https://img.shields.io/npm/v/rewind-mcp-server?logo=npm)](https://www.npmjs.com/package/rewind-mcp-server)
[![docs](https://img.shields.io/badge/docs-docs.rewind.rest-blue)](https://docs.rewind.rest/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/MIT)

MCP server for the [Rewind](https://rewind.rest) personal data API. Gives Claude access to your listening, running, watching, collecting, and reading data.

## Setup

### Desktop Apps

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

### Mobile & Web

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

| Domain           | Source           | Tools                                                                                              |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| **Listening**    | Last.fm          | Now playing, recent scrobbles, stats, top artists/albums/tracks, streaks, artist and album details |
| **Running**      | Strava           | Stats, recent runs, personal records, streaks, activity details, per-mile splits                   |
| **Watching**     | Plex, Letterboxd | Recent watches, movie details, browse by genre/decade/director, stats                              |
| **Collecting**   | Discogs, Trakt   | Vinyl collection, physical media (Blu-ray/4K UHD/HD DVD), collection and media stats               |
| **Reading**      | Instapaper       | Recent articles, highlights, random highlight, stats                                               |
| **Cross-domain** | All              | Full-text search, unified feed, on-this-day                                                        |

## Example Queries

- "What albums have I been listening to the most recently?"
- "Compare my mile splits from this month vs last month"
- "When was the last time I watched a film by Wes Anderson?"
- "What Beastie Boys records are missing from my vinyl collection?"
- "How many articles did I read last year and stack-rank the top 10 sources"
- "Can you give me a quick summary of everything I did last week?"
