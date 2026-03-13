# Date Filtering -- Design

## Shared Utilities

### `src/lib/date-filters.ts`

A small shared module to avoid duplicating date param parsing across 10+ endpoints.

```typescript
// Zod schema fragment for route definitions
export const DateFilterQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({
      description: 'Single day (YYYY-MM-DD). Overrides from/to.',
      example: '2025-02-17',
    }),
  from: z
    .string()
    .optional()
    .openapi({
      description: 'Range start, inclusive (ISO 8601)',
      example: '2025-02-01T00:00:00Z',
    }),
  to: z
    .string()
    .optional()
    .openapi({
      description: 'Range end, inclusive (ISO 8601)',
      example: '2025-02-28T23:59:59Z',
    }),
});

// Builds a Drizzle condition from date query params
export function buildDateCondition(
  column: SQLiteColumn,
  params: { date?: string; from?: string; to?: string }
): SQL | undefined;
```

When `date` is provided, it expands to a range covering that full day (00:00:00Z to next day 00:00:00Z). When `from`/`to` are provided, standard `gte`/`lte` conditions are built. Returns `undefined` when no date params are present, so existing behavior is preserved.

## Per-Endpoint Implementation Notes

### Phase 1: Recent Endpoints

All `/recent` endpoints follow the same pattern:

1. Merge `DateFilterQuery` into route schema's `request.query`
2. Call `buildDateCondition(timestampColumn, c.req.query())` in handler
3. Add condition to where clause (combine with existing conditions via `and()`)

Timestamp columns by endpoint:

| Endpoint                   | Table               | Column        |
| -------------------------- | ------------------- | ------------- |
| `/listening/recent`        | `lastfmScrobbles`   | `scrobbledAt` |
| `/running/recent`          | `stravaActivities`  | `startDate`   |
| `/watching/recent`         | `watchHistory`      | `watchedAt`   |
| `/collecting/recent`       | `discogsCollection` | `dateAdded`   |
| `/collecting/media/recent` | `traktCollection`   | `collectedAt` |

### Phase 1: `/watching/movies` Year Bug

The `moviesRoute` schema already declares a `year` query param. The handler at ~line 298 needs to:

1. Read `year` from `c.req.query('year')`
2. If present, add `gte`/`lte` conditions on `watchHistory.watchedAt` scoped to that year
3. This requires joining `watchHistory` if not already joined

### Phase 2: Feed Date Filtering

The feed endpoints use cursor-based pagination (cursor is an `activity_feed.id`). Date filtering works alongside cursors:

- `from`/`to` narrows the result set
- Cursor still works within that narrowed set
- Order remains `desc(id)` (chronological since IDs are auto-increment)

The `activity_feed` table has an `occurred_at` column for date filtering.

### Phase 2: Collecting Calendar

New endpoint following the established calendar pattern:

```typescript
// Response shape matches /listening/calendar, /running/calendar, /watching/calendar
{
  year: 2025,
  days: [{ date: '2025-01-15', count: 2 }, ...],
  total: 47,
  max_day: { date: '2025-03-01', count: 5 }
}
```

Query groups `discogsCollection.dateAdded` by date within the requested year. Media (Trakt) additions should be included in the same calendar to give a unified collecting heatmap.

### Phase 3: Date-Scoped Stats

Stats endpoints compute derived values that assume lifetime data. When scoped to a date range, denominators must change:

| Stat                | Lifetime denominator     | Scoped denominator                             |
| ------------------- | ------------------------ | ---------------------------------------------- |
| `scrobbles_per_day` | Days since registration  | Days in range                                  |
| `years_tracking`    | Years since registration | Not applicable (omit or set to range duration) |
| `movies_per_month`  | Months since first watch | Months in range                                |

When date params are provided, the response should include `period` metadata:

```json
{
  "period": { "from": "2024-01-01", "to": "2024-12-31" },
  "total_scrobbles": 12450,
  "scrobbles_per_day": 34.1,
  ...
}
```

When no date params are provided, `period` is omitted and behavior is unchanged (backwards compatible).

### Phase 4: On This Day

New endpoint: `GET /v1/feed/on-this-day?month=03&day=13`

Response grouped by year, each year contains domain summaries:

```json
{
  "month": 3,
  "day": 13,
  "years": [
    {
      "year": 2024,
      "listening": { "scrobble_count": 47, "top_artist": "Radiohead" },
      "running": { "activities": [{ "name": "Morning Run", "distance": 8.2 }] },
      "watching": { "movies": ["Dune: Part Two"] },
      "collecting": { "items_added": 1 }
    },
    {
      "year": 2023,
      "listening": { "scrobble_count": 31, "top_artist": "LCD Soundsystem" },
      "running": null,
      "watching": null,
      "collecting": null
    }
  ]
}
```

This requires querying 4+ tables with a `strftime('%m-%d', timestamp) = '03-13'` condition. Only years with at least one activity are included.

### Phase 4: First-Seen Dates

Each detail endpoint gets an additional query:

```sql
-- /listening/artists/:id
SELECT MIN(s.scrobbled_at) as first_scrobbled_at
FROM lastfm_scrobbles s
JOIN lastfm_tracks t ON s.track_id = t.id
WHERE t.artist_id = :id AND t.is_filtered = 0

-- /watching/movies/:id
SELECT MIN(wh.watched_at) as first_watched_at
FROM watch_history wh
WHERE wh.movie_id = :id
```

These are added as single fields on the existing response. The OpenAPI response schemas must be updated to include the new fields.

## Testing Strategy

Each phase includes endpoint-level tests covering:

- **No date params**: Behavior unchanged (backwards compatible)
- **Single `date` param**: Returns only items from that day
- **`from` only**: Returns items from that point forward
- **`to` only**: Returns items up to that point
- **`from` + `to` range**: Returns items within range
- **`date` overrides `from`/`to`**: When all three provided, `date` wins
- **Empty results**: Valid date range with no data returns empty array (not 404)
- **Invalid date format**: Returns 400 with descriptive error

## Backwards Compatibility

All changes are additive. No existing params are removed or renamed. Endpoints without date params continue to work identically. The `year` param on running activities and watching movies is preserved; `from`/`to` takes precedence when both are provided.
