# Artist Genre Tags -- Design

## Schema Changes

### `lastfm_artists` table -- new columns

| Column  | Type          | Description                                                                                     |
| ------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `tags`  | `text` (JSON) | Raw Last.fm top tags with weights: `[{"name":"grunge","count":100},{"name":"rock","count":49}]` |
| `genre` | `text`        | Primary genre after allowlist filtering, e.g. `"Grunge"`. Indexed for fast queries.             |

The `tags` column preserves the full API response for future flexibility (re-normalizing without re-fetching). The `genre` column is the workhorse for joins and grouping.

### Migration

```sql
ALTER TABLE lastfm_artists ADD COLUMN tags TEXT;
ALTER TABLE lastfm_artists ADD COLUMN genre TEXT;
CREATE INDEX idx_lastfm_artists_genre ON lastfm_artists(genre);
```

## Genre Allowlist and Synonym Map

A constant in `src/services/lastfm/genres.ts` that serves two purposes:

1. **Allowlist**: Only tags present in the map are considered valid genres
2. **Synonym normalization**: Multiple tag spellings map to a canonical name

```typescript
// Map of lowercase Last.fm tag -> canonical genre name
export const GENRE_MAP: Record<string, string> = {
  rock: 'Rock',
  'classic rock': 'Classic Rock',
  alternative: 'Alternative',
  'alternative rock': 'Alternative',
  indie: 'Indie',
  'indie rock': 'Indie',
  punk: 'Punk',
  'punk rock': 'Punk',
  'post-punk': 'Post-Punk',
  grunge: 'Grunge',
  metal: 'Metal',
  'heavy metal': 'Metal',
  pop: 'Pop',
  'pop rock': 'Pop Rock',
  'hip-hop': 'Hip-Hop',
  'hip hop': 'Hip-Hop',
  rap: 'Hip-Hop',
  electronic: 'Electronic',
  electronica: 'Electronic',
  dance: 'Electronic',
  house: 'House',
  techno: 'Techno',
  ambient: 'Ambient',
  jazz: 'Jazz',
  'jazz hop': 'Jazz Hop',
  'jazz rap': 'Jazz Hop',
  blues: 'Blues',
  soul: 'Soul',
  'r&b': 'R&B',
  rnb: 'R&B',
  funk: 'Funk',
  country: 'Country',
  folk: 'Folk',
  'folk rock': 'Folk Rock',
  'alt-country': 'Alt-Country',
  americana: 'Americana',
  reggae: 'Reggae',
  ska: 'Ska',
  latin: 'Latin',
  classical: 'Classical',
  'singer-songwriter': 'Singer-Songwriter',
  'new wave': 'New Wave',
  synthpop: 'Synthpop',
  'synth-pop': 'Synthpop',
  shoegaze: 'Shoegaze',
  'dream pop': 'Dream Pop',
  psychedelic: 'Psychedelic',
  'psychedelic rock': 'Psychedelic Rock',
  'garage rock': 'Garage Rock',
  'post-rock': 'Post-Rock',
  'math rock': 'Math Rock',
  emo: 'Emo',
  hardcore: 'Hardcore',
  'post-hardcore': 'Post-Hardcore',
  'lo-fi': 'Lo-Fi',
  'trip-hop': 'Trip-Hop',
  'trip hop': 'Trip-Hop',
  downtempo: 'Downtempo',
  experimental: 'Experimental',
  noise: 'Noise',
  industrial: 'Industrial',
  gospel: 'Gospel',
  world: 'World',
  afrobeat: 'Afrobeat',
  afrobeats: 'Afrobeats',
  'bossa nova': 'Bossa Nova',
  disco: 'Disco',
  'new age': 'New Age',
  soundtrack: 'Soundtrack',
  'k-pop': 'K-Pop',
  'j-pop': 'J-Pop',
  trap: 'Trap',
  drill: 'Drill',
  grime: 'Grime',
  'drum and bass': 'Drum and Bass',
  dnb: 'Drum and Bass',
  dub: 'Dub',
  dubstep: 'Dubstep',
  idm: 'IDM',
  breakbeat: 'Breakbeat',
  'progressive rock': 'Progressive Rock',
  'prog rock': 'Progressive Rock',
  'hard rock': 'Hard Rock',
  'soft rock': 'Soft Rock',
  'power pop': 'Power Pop',
  britpop: 'Britpop',
  'country pop': 'Country Pop',
  'underground hip-hop': 'Underground Hip-Hop',
  // ...extend as needed after reviewing backfill results
};
```

### Resolving primary genre

```typescript
export function resolveGenre(tags: Array<{ name: string; count: number }>): {
  genre: string | null;
  normalizedTags: Array<{ name: string; count: number }>;
} {
  const normalizedTags: Array<{ name: string; count: number }> = [];

  for (const tag of tags) {
    const canonical = GENRE_MAP[tag.name.toLowerCase()];
    if (canonical && !normalizedTags.some((t) => t.name === canonical)) {
      normalizedTags.push({ name: canonical, count: tag.count });
    }
  }

  return {
    genre: normalizedTags[0]?.name ?? null,
    normalizedTags,
  };
}
```

The first matching tag (highest weight) becomes the primary `genre`. The full `normalizedTags` array is stored as `tags` JSON for multi-genre queries.

## Last.fm Client Addition

New method on `LastfmClient`:

```typescript
interface LastfmTag {
  name: string;
  count: number;
  url: string;
}

async getArtistTopTags(artist: string): Promise<{
  toptags: { tag: LastfmTag[]; '@attr': { artist: string } };
}> {
  return this.request({
    method: 'artist.getTopTags',
    artist,
  });
}
```

Note: `artist.getTopTags` does not use the `user` param, but the base `request()` method always sets it -- this is harmless (Last.fm ignores it for non-user methods).

## Backfill Script

`scripts/backfills/backfill-artist-tags.sh` -- follows the pattern of existing backfill scripts:

1. Query remote D1 for all non-filtered artists where `tags IS NULL`
2. For each artist, call the deployed API (a new admin endpoint `POST /v1/admin/sync` with `type: 'artist_tags'`, or a dedicated backfill endpoint)
3. Rate limit: `sleep 0.25` between requests (~4 req/sec)
4. Progress logging every 100 artists
5. Idempotent: skips artists that already have tags

Alternative approach: a TypeScript backfill function (like `backfillScrobbles`) that runs within the Worker, callable via `POST /v1/admin/sync { domain: "listening", type: "artist_tags" }`. This is cleaner because:

- Runs server-side, no local curl loop needed
- Uses the existing `LastfmClient` with built-in rate limiting
- Can be resumed (skips artists with existing tags)
- Logs progress via sync_runs table

**Recommended: TypeScript backfill function triggered via admin sync endpoint.**

### Backfill implementation

```typescript
export async function backfillArtistTags(
  db: Database,
  client: LastfmClient
): Promise<number> {
  const runId = await startSyncRun(db, 'artist_tags');
  let tagged = 0;

  try {
    // Fetch all non-filtered artists without tags, ordered by playcount desc
    const artists = await db
      .select({ id: lastfmArtists.id, name: lastfmArtists.name })
      .from(lastfmArtists)
      .where(
        and(eq(lastfmArtists.isFiltered, 0), sql`${lastfmArtists.tags} IS NULL`)
      )
      .orderBy(desc(lastfmArtists.playcount));

    for (const artist of artists) {
      try {
        const response = await client.getArtistTopTags(artist.name);
        const rawTags = response.toptags.tag.map((t) => ({
          name: t.name,
          count: t.count,
        }));
        const { genre, normalizedTags } = resolveGenre(rawTags);

        await db
          .update(lastfmArtists)
          .set({
            tags: JSON.stringify(normalizedTags),
            genre,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(lastfmArtists.id, artist.id));

        tagged++;

        if (tagged % 100 === 0) {
          console.log(`[SYNC] Tagged ${tagged}/${artists.length} artists`);
        }
      } catch (err) {
        // Log and continue -- don't fail the whole backfill for one artist
        console.log(`[ERROR] Failed to tag artist ${artist.name}: ${err}`);
      }
    }

    await completeSyncRun(db, runId, tagged);
    console.log(
      `[SYNC] Artist tag backfill complete: ${tagged} artists tagged`
    );
    return tagged;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSyncRun(db, runId, message);
    throw error;
  }
}
```

### Worker timeout consideration

Cloudflare Workers have a 30-second CPU time limit on the standard plan (though wall-clock time can be longer since API calls are I/O, not CPU). With 4,382 artists at ~250ms per request, total wall-clock time is ~18 minutes. This exceeds the Worker invocation limit.

**Solution**: The backfill function processes artists in batches (e.g., 500 per invocation) and returns a cursor. The admin endpoint can be called repeatedly:

```
POST /v1/admin/sync { domain: "listening", type: "artist_tags" }
// Response: { tagged: 500, remaining: 3882 }
// Call again until remaining: 0
```

Or use a shell script that calls the admin endpoint in a loop:

```bash
while true; do
  RESULT=$(curl -s -X POST "$API/v1/admin/sync" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d '{"domain":"listening","type":"artist_tags"}')
  REMAINING=$(echo "$RESULT" | jq '.remaining // 0')
  echo "[INFO] Remaining: $REMAINING"
  if [ "$REMAINING" -eq 0 ]; then break; fi
  sleep 2
done
```

## Sync Integration

In `syncRecentScrobbles`, after `upsertArtist` creates a new artist:

```typescript
if (artist.isNew) {
  try {
    const tagResponse = await client.getArtistTopTags(track.artistName);
    const rawTags = tagResponse.toptags.tag.map((t) => ({
      name: t.name,
      count: t.count,
    }));
    const { genre, normalizedTags } = resolveGenre(rawTags);

    await db
      .update(lastfmArtists)
      .set({
        tags: JSON.stringify(normalizedTags),
        genre,
      })
      .where(eq(lastfmArtists.id, artist.id));
  } catch {
    // Non-fatal -- artist still gets created, tags can be backfilled later
  }
}
```

One extra API call per new artist. Most syncs discover 0-5 new artists, so this adds negligible overhead.

## API Endpoints

### `GET /v1/listening/genres`

Genre breakdown over time. Primary endpoint for the stacked bar chart.

**Query params:**

| Param      | Type                      | Default | Description                                    |
| ---------- | ------------------------- | ------- | ---------------------------------------------- |
| `from`     | ISO 8601                  | none    | Range start                                    |
| `to`       | ISO 8601                  | none    | Range end                                      |
| `date`     | YYYY-MM-DD                | none    | Single day (overrides from/to)                 |
| `group_by` | `week` / `month` / `year` | `month` | Aggregation period                             |
| `limit`    | integer                   | `10`    | Max genres to return (rest grouped as "Other") |

**Response:**

```json
{
  "data": [
    {
      "period": "2025-01",
      "genres": {
        "Rock": 245,
        "Hip-Hop": 112,
        "Electronic": 87,
        "Indie": 63,
        "Folk": 41,
        "Other": 89
      },
      "total": 637
    },
    {
      "period": "2025-02",
      "genres": {
        "Rock": 198,
        "Hip-Hop": 134,
        "Electronic": 95,
        "Indie": 78,
        "Country": 32,
        "Other": 67
      },
      "total": 604
    }
  ]
}
```

**Query logic:**

```sql
SELECT
  strftime('%Y-%m', s.scrobbled_at) as period,
  a.genre,
  COUNT(*) as count
FROM lastfm_scrobbles s
JOIN lastfm_tracks t ON s.track_id = t.id
JOIN lastfm_artists a ON t.artist_id = a.id
WHERE t.is_filtered = 0
  AND a.genre IS NOT NULL
  AND s.scrobbled_at >= :from
  AND s.scrobbled_at <= :to
GROUP BY period, a.genre
ORDER BY period, count DESC
```

Then in the handler: for each period, take the top N genres, sum the rest as "Other".

### Genre data on existing artist responses

Add `genre` and `tags` to artist detail responses (e.g., `/listening/artists/:id`, `/listening/browse/artists`). The `genre` field is a simple string. The `tags` field is the normalized tag array.

### `GET /v1/listening/genres/summary`

Optional -- aggregate genre stats (top genres all-time, genre count, etc.) for dashboard use. Can be deferred.

## Testing Strategy

- **Allowlist/normalization**: Unit tests for `resolveGenre()` covering synonym mapping, junk tag filtering, empty input, single-tag artists
- **Client method**: Unit test for `getArtistTopTags()` with mocked response
- **Backfill**: Integration test verifying artists get tags/genre populated
- **Sync integration**: Integration test verifying new artists get tagged inline
- **Genre endpoint**: Integration test with seeded scrobble + artist data, verifying correct grouping and "Other" rollup
- **Existing endpoints**: Verify artist detail responses include genre/tags fields
