# Single-Entity Cards — Design

Source-of-truth shapes and conventions for the three new cards plus the per-artist top-tracks query.

## `structuredContent` shape conventions

These rules apply to all four phases:

1. **Data only.** No prose, no HTML, no rendered markdown. Numbers, IDs, URLs, timestamps, structured objects.
2. **Superset of the card.** Fields the card hides but that help the model write a richer paragraph belong here.
3. **Stable shape per tool.** No optional top-level keys. Use `null` instead of omission when a sub-field doesn't apply, except for variant-discriminated unions (`hitter` vs `pitcher`).
4. **Image fields are objects, not strings.** Always `{ cdn_url, url, thumbhash, dominant_color, accent_color }` to match the existing image attachment convention.
5. **No full bodies.** Article body, full bio paragraphs, full appearance lists are accessible via the same tool but kept out of the default response. The exception is small-N collections (e.g. ≤ 5 highlights) where the data is presentation-relevant.

## Phase 1 — `get_article` shape

**Tool input.** `id: number` (existing).

**`structuredContent`:**

```ts
{
  article: {
    id: number;
    title: string;
    author: string | null;
    url: string;
    instapaper_url: string;
    instapaper_app_url: string;
    domain: string;
    description: string | null; // og_description
    word_count: number | null;
    estimated_read_min: number | null;
    status: 'unread' | 'read' | 'archived' | 'starred';
    progress: number | null; // 0.0–1.0
    saved_at: string; // ISO 8601
    image: ImageAttachment | null;
  }
  highlights: Array<{
    id: number;
    text: string;
    note: string | null;
    created_at: string; // ISO 8601
  }>; // capped at 5; full list via separate query
  highlight_count: number; // total across all highlights, even if response capped
}
```

**Removed from current response:** `content` (full article body, 5–30 KB). Available via the existing `get_article` tool; just not bundled into `structuredContent`.

**`_meta.ui.resourceUri`:** `ui://rewind/article.html`.

**Card sections:**

- Hero: full-width og:image (if present), 16:9 aspect, dominant_color background fallback.
- Title (2-line clamp), byline, domain favicon.
- Meta strip: read time · saved date · status badge · progress bar (if 0 < progress < 1).
- Description (3-line clamp).
- Highlights panel: top 3 by date (most recent first), each with text + optional note.
- Footer: "Open in Instapaper" link (uses `instapaper_app_url` on iOS, `instapaper_url` elsewhere).

## Phase 2 — `get_artist_details` shape

**Tool input.** `artist_id: number` (existing) or `name: string` (existing).

**`structuredContent`:**

```ts
{
  artist: {
    id: number;
    name: string;
    mbid: string | null;
    url: string;                         // Last.fm URL
    apple_music_url: string | null;
    apple_music_id: number | null;
    genre: string | null;                // primary tag
    tags: string[];                      // up to 5
    bio_summary: string | null;          // 1–2 sentences
    bio_content: string | null;          // full bio paragraphs (kept for model context)
    image: ImageAttachment | null;
  };
  listening_stats: {
    total_scrobbles: number;
    first_scrobble_at: string | null;    // ISO 8601
    last_played_at: string | null;       // ISO 8601
    all_time_rank: number | null;        // 1-indexed; null if outside top-200
    distinct_tracks: number;
    distinct_albums: number;
  };
  sparkline: {
    granularity: 'day' | 'week' | 'month';
    points: Array<{ at: string; count: number }>;  // ISO 8601 + scrobble count per bucket
  };
  top_tracks: Array<{
    rank: number;
    id: number;
    name: string;
    album_id: number | null;
    album_name: string | null;
    scrobble_count: number;
    apple_music_url: string | null;
    preview_url: string | null;
    image: ImageAttachment | null;
  }>;                                    // capped at 10
  top_albums: Array<{
    rank: number;
    id: number;
    name: string;
    playcount: number;
    apple_music_url: string | null;
    image: ImageAttachment | null;
  }>;                                    // capped at 5
  similar_artists: Array<{
    id: number;                          // local lastfm_artists.id
    name: string;
    your_scrobble_count: number;         // your playcount; >0 by definition (intersection-only)
    similarity_score: number;            // 0–1 from Last.fm
    image: ImageAttachment | null;
  }>;                                    // capped at 5; empty array if no intersection
}
```

**Lazy-fill behavior.** If `bio_content IS NULL` at request time, the route handler synchronously calls Last.fm `artist.getInfo`, persists `bio_summary` + `bio_content`, then returns. Adds ~200ms latency on first call per artist; instant thereafter. Same pattern as `services/itunes/enrich.ts`.

**Eager sync.** `similar_artists` populates via the daily 3:00 AM Last.fm cron for the user's top-200 artists by playcount. Long-tail artists skipped — their `similar_artists` field is `null` until they enter the top-200.

**`_meta.ui.resourceUri`:** `ui://rewind/artist.html`.

**Card sections:**

- Hero row: portrait (140×140 circle) + name (h1) + genre tag + 2-line bio_summary clamp.
- Stat strip: `total_scrobbles` · `first_scrobble_at` (formatted "since YYYY") · `last_played_at` (relative) · `all_time_rank` (#N).
- Sparkline strip: 100% width, ~60px tall, dominant_color stroke.
- Top tracks list: 5 rows (rank | mini track-art | name + album | scrobble_count + preview-play button).
- Top albums grid: 3 tiles in a row.
- Similar artists chips: up to 5 horizontal chips (mini portrait + name + your_scrobble_count). Hidden if `similar_artists.length === 0`.
- Footer: Apple Music link.

## Phase 2 — `get_top_tracks` shape with artist filter

**Tool input.** Existing params plus:

- `artist_id?: number` — if present, filter to that artist's tracks.
- `artist_name?: string` — substring resolver; if `artist_id` not provided, looks up the best-match artist by name and uses their id. Returns 400 if both are provided.

**Response:** existing top-tracks shape, just filtered. No new fields.

**Both candidate UI layouts consume the same `structuredContent`.**

### `ui://rewind/top-tracks-grid.html`

Square album-art tiles in a grid (`top-albums.html` styling).

- 3 columns at ≥720px, 2 columns at <720px.
- Tile: track-art square + rank badge top-left + track name (2-line clamp) + scrobble count under name.
- Album name shown on hover/tap.

### `ui://rewind/top-tracks-list.html`

Dense ranked rows (`recent-reads.html` styling).

- 1 column always.
- Row: rank (large, left) | mini track-art (40×40) | track name (1-line clamp) + album name (1-line clamp, dimmer) | scrobble count + tiny sparkline (right).
- Optional preview-play button on hover.

**Decision:** Phase 4 picks one. Loser gets removed (not kept "for later").

## Phase 3 — `get_attended_player` shape (extended)

**Tool input.** `id: number` (existing).

**`structuredContent`:**

```ts
{
  player: {
    id: number;
    mlb_stats_id: number | null;
    full_name: string;
    primary_position: string;            // "C", "RHP", "OF", etc.
    primary_number: string | null;       // "29"
    bats: 'L' | 'R' | 'S' | null;
    throws: 'L' | 'R' | null;
    debut_date: string | null;           // ISO 8601 date
    birth_country: string | null;
    photo_silo: ImageAttachment | null;  // small headshot
    photo_full: ImageAttachment | null;  // larger headshot
    league: 'mlb' | 'nfl' | 'nba' | 'wnba' | 'ncaaf' | 'ncaab' | 'mls' | string;
    team: {
      id: number;
      name: string;                      // "Seattle Mariners"
      abbreviation: string;              // "SEA"
      league: 'mlb';
      primary_color: string | null;      // hex "#0C2C56"
      logo: ImageAttachment | null;
    } | null;
  };
  supported: boolean;                    // true for MLB, false otherwise
  season_stats: {                        // null when supported=false
    season: number;
    fetched_at: string;                  // ISO 8601 (when MLB Stats API was hit)
    cache_hit: boolean;                  // diagnostic
    hitter: {
      games_played: number;
      pa: number; ab: number;
      r: number; h: number; doubles: number; triples: number; hr: number; rbi: number;
      bb: number; k: number; sb: number;
      avg: string; obp: string; slg: string; ops: string;
    } | null;
    pitcher: {
      games_played: number;
      games_started: number;
      ip: string;                        // "182.1" — outs-math format
      bf: number;
      h: number; r: number; er: number; bb: number; k: number; hr: number;
      era: string; whip: string;
      decisions: { w: number; l: number; sv: number; hld: number; bs: number };
    } | null;
  } | null;
  attended_summary: {                    // always present (even non-MLB)
    games_attended: number;
    games_with_box_score: number;
    wins: number; losses: number;
    hitter: {
      pa: number; ab: number;
      h: number; hr: number; rbi: number; bb: number; k: number;
      avg: string; slg: string;
      notable_count: number;             // games with notable=1
    } | null;
    pitcher: {
      ip: string; bf: number;
      h: number; r: number; er: number; bb: number; k: number;
      era: string; whip: string;
      decisions: { w: number; l: number; sv: number; hld: number; bs: number };
      notable_count: number;
    } | null;
  };
  attended_appearances: Array<{
    event_id: number;
    event_date: string;                  // ISO 8601
    venue_name: string | null;
    home_team: string;
    away_team: string;
    final_score: string;                 // "5-3"
    my_team_won: boolean | null;
    is_home: boolean;
    batting_line: { summary: string; pa: number; h: number; hr: number } | null;
    pitching_line: { summary: string; ip: string; k: number } | null;
    decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
    notable: boolean;
    notable_reasons: string[];           // ["multi-hit", "HR", "complete-game"]
  }>;                                    // capped at 10 most recent
  attended_appearance_count: number;     // total across all appearances
}
```

**Non-MLB short-circuit:**

```ts
{
  player: { ...; league: 'nfl' | ...; team: null },
  supported: false,
  season_stats: null,
  attended_summary: { games_attended, games_with_box_score, wins, losses, hitter: null, pitcher: null },
  attended_appearances: [...],           // appearance summaries only
  attended_appearance_count: number
}
```

**`_meta.ui.resourceUri`:** `ui://rewind/attended-player.html`.

**Card sections:**

- Hero row: photo_full (left, 120×120 with thumbhash fade-in) + name (h1) + team logo + position/# pill + bats/throws line.
- Stats two-column row:
  - Left: "This season" — slash line for hitters, ERA/W-L/K for pitchers. `season_stats.cache_hit` rendered as a tiny dot indicator.
  - Right: "In games you attended" — your personal stat line for this player. Uses `attended_summary.hitter` or `.pitcher`.
- Notable highlights strip: bullet list of `notable_reasons` aggregated across `attended_appearances`. ("3 HRs · 1 multi-hit · 1 walkoff" etc.)
- Recent attended-appearances list: 5 rows by default, "show all" expands. Each row: date · venue · opponent · stat line · decision badge · notable badge.
- Error state: if `season_stats === null && supported === true`, render the live-stats column as "Season stats unavailable" with retry button (Phase 5 follow-up).

## KV cache key conventions

All keys live in the single `REWIND_CACHE` namespace:

| Pattern                          | Value                                             | TTL | Used by                                  |
| -------------------------------- | ------------------------------------------------- | --- | ---------------------------------------- |
| `mlb_stats:player:{id}:{season}` | `season_stats.hitter` or `.pitcher` JSON          | 1h  | `services/mlb-stats/client.ts` (Phase 3) |
| `mlb_stats:teams:{season}`       | List of `mlb_teams` rows (id, name, abbr, colors) | 30d | `services/mlb-stats/teams.ts` (Phase 3)  |

Keys are versioned implicitly by season. If we ever need to invalidate broadly, prefix with `v2:` and run a cleanup pass.

## Last.fm enrichment shapes

### `artist.getInfo` response (mapped fields)

| Last.fm field             | Stored as                                                   |
| ------------------------- | ----------------------------------------------------------- |
| `artist.bio.summary`      | `lastfm_artists.bio_summary` (CDATA stripped, link removed) |
| `artist.bio.content`      | `lastfm_artists.bio_content` (CDATA stripped)               |
| `artist.tags.tag[]`       | already stored via existing `getTopTags` call — no change   |
| `artist.similar.artist[]` | not used here — separate `getSimilar` call                  |

### `artist.getSimilar` response (mapped fields)

| Last.fm field                   | Stored as                                                  |
| ------------------------------- | ---------------------------------------------------------- |
| `similarartists.artist[].name`  | matched against `lastfm_artists.name` (case-insensitive)   |
| `similarartists.artist[].mbid`  | preferred match key when present                           |
| `similarartists.artist[].match` | `similar_artists[i].similarity_score` (already 0–1 string) |

Stored as JSON in `lastfm_artists.similar_artists`:

```ts
Array<{
  artist_id: number; // resolved local id; rows where no local match are dropped
  name: string;
  mbid: string | null;
  similarity_score: number;
}>;
```

The cross-reference filter (similar ∩ my-listened) is the join in the storage step itself — entries whose `name` doesn't resolve to a `lastfm_artists` row are discarded, keeping the column small. The route handler joins on those `artist_id`s when building the response.

## Schema changes

### `lastfm_artists` (Phase 2)

```sql
ALTER TABLE lastfm_artists ADD COLUMN bio_summary TEXT;
ALTER TABLE lastfm_artists ADD COLUMN bio_content TEXT;
ALTER TABLE lastfm_artists ADD COLUMN bio_synced_at INTEGER;
ALTER TABLE lastfm_artists ADD COLUMN similar_artists TEXT;     -- JSON
ALTER TABLE lastfm_artists ADD COLUMN similar_synced_at INTEGER;
```

`bio_synced_at` is for cache-staleness detection (we'll re-fetch after 90d). `similar_synced_at` matches.

### `mlb_teams` (Phase 3, new)

```sql
CREATE TABLE mlb_teams (
  id INTEGER PRIMARY KEY,                -- MLB Stats API team id
  name TEXT NOT NULL,                    -- "Seattle Mariners"
  abbreviation TEXT NOT NULL,            -- "SEA"
  league TEXT NOT NULL DEFAULT 'mlb',
  team_code TEXT,                        -- MLB internal code "sea"
  primary_color TEXT,                    -- hex
  secondary_color TEXT,                  -- hex
  logo_image_key TEXT,                   -- → images.r2_key for thumbhash + colors
  active INTEGER NOT NULL DEFAULT 1,
  synced_at INTEGER NOT NULL
);
CREATE INDEX idx_mlb_teams_abbr ON mlb_teams(abbreviation);
```

Logos pulled from MLB Stats API team endpoint and run through the existing image pipeline (`services/images/`) so they get thumbhash + dominant/accent colors automatically. The `primary_color` / `secondary_color` in `mlb_teams` are the _team's_ official brand colors; the image's `dominant_color` / `accent_color` are derived from the logo image and may differ. UI uses team brand colors for badges and image-derived colors for backgrounds.

## MLB Stats API response (mapped fields)

`GET https://statsapi.mlb.com/api/v1/people/{id}/stats?stats=season&group=hitting,pitching&season={N}`

Returns `stats[].splits[0].stat` for the active season. We map:

| MLB field                                                                                         | Mapped to                          |
| ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `stats[group=hitting].splits[0].stat.gamesPlayed`                                                 | `season_stats.hitter.games_played` |
| `…stat.plateAppearances`                                                                          | `season_stats.hitter.pa`           |
| `…stat.atBats`                                                                                    | `season_stats.hitter.ab`           |
| `…stat.runs / hits / doubles / triples / homeRuns / rbi / baseOnBalls / strikeOuts / stolenBases` | corresponding hitter fields        |
| `…stat.avg / obp / slg / ops`                                                                     | direct copy (already strings)      |
| `stats[group=pitching].splits[0].stat.inningsPitched`                                             | `season_stats.pitcher.ip`          |
| `…stat.battersFaced`                                                                              | `season_stats.pitcher.bf`          |
| `…stat.wins / losses / saves / holds / blownSaves`                                                | `season_stats.pitcher.decisions.*` |
| `…stat.era / whip`                                                                                | direct copy                        |

Both groups checked. If either group has data, that side of `season_stats` is populated. If both, both populate (rare — Ohtani-class).

## CSP allowlists per resource

Each `ui://` HTML resource declares its `resourceDomains` for image loading. Inherit from the existing pattern in `mcp-server/src/server.ts`:

| Resource                           | Domains           |
| ---------------------------------- | ----------------- |
| `ui://rewind/article.html`         | `cdn.rewind.rest` |
| `ui://rewind/artist.html`          | `cdn.rewind.rest` |
| `ui://rewind/top-tracks-grid.html` | `cdn.rewind.rest` |
| `ui://rewind/top-tracks-list.html` | `cdn.rewind.rest` |
| `ui://rewind/attended-player.html` | `cdn.rewind.rest` |

Similar-artist mini-portraits come from the user's own image pipeline (CDN-backed), not directly from Last.fm — no third-party host needed.
