# MCP Tools -- Design & Schemas

## Tool Design Principles

1. **Descriptions are critical.** Claude selects tools based on their name + description. Every tool must have a clear, specific description that tells Claude when to use it.

2. **Concise responses.** Return formatted text summaries, not raw JSON. Claude works better with curated human-readable output. Include key data points, skip noise.

3. **Consistent parameter patterns.** Reuse the same parameter names and types across tools where applicable (e.g., `period`, `limit`, `date`, `from`, `to`).

4. **Fail gracefully.** Return `{ content: [...], isError: true }` on failures so Claude knows something went wrong without the server crashing.

## Common Parameters

| Parameter | Type                                                      | Used By                 | Description              |
| --------- | --------------------------------------------------------- | ----------------------- | ------------------------ |
| `period`  | `enum: 7day, 1month, 3month, 6month, 12month, overall`    | Listening top lists     | Time period for rankings |
| `limit`   | `number (1-50)`                                           | Most list endpoints     | Max items to return      |
| `page`    | `number`                                                  | Paginated endpoints     | Page number              |
| `date`    | `string (YYYY-MM-DD)`                                     | Calendar/date endpoints | Specific date filter     |
| `from`    | `string (ISO 8601)`                                       | Range endpoints         | Start of date range      |
| `to`      | `string (ISO 8601)`                                       | Range endpoints         | End of date range        |
| `year`    | `number`                                                  | Year endpoints          | Year for year-in-review  |
| `query`   | `string`                                                  | Search                  | Search query text        |
| `domain`  | `enum: listening, running, watching, collecting, reading` | Search, feed            | Domain filter            |

## Tool Definition Pattern

Every tool follows this structure:

```typescript
server.tool(
  'tool_name',
  'Clear description of what this tool does and when to use it',
  {
    // Zod schema for parameters
    param: z.string().describe('What this parameter controls'),
  },
  async ({ param }) => {
    const data = await client.get(`/v1/endpoint`, { param });

    // Format response as readable text, not JSON
    const text = formatResponse(data);

    return {
      content: [{ type: 'text', text }],
    };
  }
);
```

## Response Formatting Guidelines

### Listening

**`get_now_playing`** -- Single line:

```
Now playing: "Song Title" by Artist Name (from Album Name)
```

Or: `Nothing playing right now.`

**`get_recent_listens`** -- Numbered list:

```
Recent listens:
1. "Song Title" by Artist -- Album (2h ago)
2. "Song Title" by Artist -- Album (2h ago)
...
```

**`get_listening_stats`** -- Key stats block:

```
Listening Stats:
- Total scrobbles: 45,231
- Unique artists: 2,104
- Unique albums: 3,891
- Unique tracks: 12,453
- Average daily scrobbles: 12.4
```

**`get_top_artists`** -- Ranked list with play counts:

```
Top Artists (last 7 days):
1. Artist Name -- 45 plays
2. Artist Name -- 32 plays
...
```

### Running

**`get_running_stats`** -- Key metrics:

```
Running Stats:
- Total runs: 423
- Total distance: 1,892.4 mi
- Total time: 312h 45m
- Average pace: 8:32/mi
- Longest run: 26.2 mi
```

**`get_personal_records`** -- Categorized PRs:

```
Personal Records:
- Fastest mile: 6:12 (Jan 15, 2025)
- Fastest 5K: 21:45 (Mar 3, 2025)
- Longest run: 26.2 mi (Oct 12, 2024)
```

### General Rules

- Use natural units (miles, hours/minutes, dates as "Jan 15, 2025")
- Include counts and totals where available
- Keep lists to 10 items max unless the user asked for more
- Always include the time context (period, date range) in the response header
- For empty results, say so clearly: "No runs found for March 2025."

## HTTP Client Design

```typescript
class RewindClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) url.searchParams.set(k, v);
      });
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`Rewind API error: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<T>;
  }
}
```

## Logging

All logging goes to `stderr` (never `stdout` -- stdio transport uses stdout for JSON-RPC):

```typescript
const log = (...args: unknown[]) => console.error('[rewind-mcp]', ...args);
```
