# rewind-mcp-server

MCP (Model Context Protocol) server for the [Rewind](https://rewind.rest) personal data API. Gives Claude natural language access to your listening, running, watching, collecting, and reading data.

## Features

- **26 tools** across 5 domains (listening, running, watching, collecting, reading) + cross-domain search and feed
- **4 resources** for sync status and year-in-review data
- **3 prompt templates** for weekly summaries, year-in-review, and period comparisons
- Works with Claude Desktop, Claude Code, Claude iOS, and claude.ai

## Installation

### Claude Desktop (Mac)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop after saving.

### Claude Code

```bash
claude mcp add rewind -- npx -y rewind-mcp-server
```

Or add `.mcp.json` to your project root:

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

### Claude iOS / claude.ai (Web)

These platforms connect to the hosted remote server. Go to Settings > Integrations and add:

- **URL:** `https://mcp.rewind.rest/mcp`
- **Authorization:** `Bearer rw_live_your_key_here`

## Environment Variables

| Variable         | Required | Default                   | Description                         |
| ---------------- | -------- | ------------------------- | ----------------------------------- |
| `REWIND_API_KEY` | Yes      | --                        | Your Rewind API key (`rw_live_...`) |
| `REWIND_API_URL` | No       | `https://api.rewind.rest` | API base URL                        |

## Available Tools

### Listening (Last.fm)

| Tool                    | Description                  |
| ----------------------- | ---------------------------- |
| `get_now_playing`       | Currently playing track      |
| `get_recent_listens`    | Recent scrobbles             |
| `get_listening_stats`   | Overall listening statistics |
| `get_top_artists`       | Top artists by period        |
| `get_top_albums`        | Top albums by period         |
| `get_top_tracks`        | Top tracks by period         |
| `get_listening_streaks` | Current and longest streaks  |
| `get_artist_details`    | Artist info by ID            |
| `get_album_details`     | Album info by ID             |

### Running (Strava)

| Tool                   | Description                 |
| ---------------------- | --------------------------- |
| `get_running_stats`    | Overall running statistics  |
| `get_recent_runs`      | Recent activities           |
| `get_personal_records` | PRs at standard distances   |
| `get_running_streaks`  | Current and longest streaks |
| `get_activity_details` | Single run details by ID    |

### Watching (Plex / Letterboxd)

| Tool                 | Description                 |
| -------------------- | --------------------------- |
| `get_recent_watches` | Recently watched movies/TV  |
| `get_movie_details`  | Movie info by ID            |
| `get_watching_stats` | Overall watching statistics |

### Collecting (Discogs)

| Tool                   | Description           |
| ---------------------- | --------------------- |
| `get_vinyl_collection` | Browse vinyl records  |
| `get_collecting_stats` | Collection statistics |

### Reading (Instapaper)

| Tool                     | Description             |
| ------------------------ | ----------------------- |
| `get_recent_reads`       | Recently saved articles |
| `get_reading_highlights` | Saved highlights        |
| `get_random_highlight`   | Random highlight        |
| `get_reading_stats`      | Reading statistics      |

### Cross-Domain

| Tool              | Description                         |
| ----------------- | ----------------------------------- |
| `search`          | Full-text search across all domains |
| `get_feed`        | Unified activity feed               |
| `get_on_this_day` | Historical "on this day" items      |
| `get_health`      | API and sync health status          |

## Development

```bash
cd mcp-server
npm install
npm run build
REWIND_API_KEY=rw_live_... npm start
```

## License

MIT
