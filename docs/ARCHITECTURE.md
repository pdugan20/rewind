# Rewind -- Architecture

## System Overview

```text
+-------------------+     +-------------------+     +-------------------+     +-------------------+
|    Last.fm API    |     |    Strava API     |     |    Plex Server    |     |   Discogs API    |
+--------+----------+     +--------+----------+     +--------+----------+     +--------+----------+
         |                         |                         |                         |
         | Cron 15m / 3 AM        | Cron 4 AM               | Webhook /               | Cron Sun 6 AM
         |                        | + Webhook                | Cron 5 AM               |
         v                        v                          v                         v
+--------+----------+     +--------+----------+     +--------+----------+     +--------+----------+
| Listening Sync    |     | Running Sync      |     | Watching Sync     |     | Collecting Sync  |
| Worker            |     | Worker            |     | Worker            |     | Worker           |
+---------+---------+     +---------+---------+     +---------+---------+     +---------+---------+
          |                        |                         |                         |
          +----------+-------------+-----------+-------------+
                     |                         |
                     v                         v
              +------+------+          +-------+-------+
              |   D1        |          |   Images      |
              |  (SQLite)   |          |   Table       |
              +------+------+          +-------+-------+
                     |                         |
                     |                         |  Source Waterfall:
                     |                         |  Cover Art Archive -> iTunes ->
                     |                         |  Apple Music -> Fanart.tv -> TMDB
                     |                         |
                     |                         v
                     |                  +------+------+
                     |                  |   R2        |
                     |                  |  (Images)   |
                     |                  +------+------+
                     |                         |
          +----------+-----------+             |
          |                      |             |
          v                      v             v
   +------+------+       +------+------+------+------+
   | Hono Route  |       | Image Proxy |             |
   | Handlers    |       | Handler     |             |
   +------+------+       +------+------+             |
          |                      |                    |
          v                      v                    |
   +------+------+       +------+------+             |
   | api.rewind  |       | cdn.rewind  |             |
   |   .rest     |       |   .rest     |<------------+
   +------+------+       +-------------+
          |
          v
   +------+------+
   | pat-portfolio|
   | (Hono RPC   |
   |  client)    |
   +-------------+
```

## Authentication

All GET endpoints are public and require no authentication. This is a personal data aggregation service -- all data is intended to be read publicly.

Write endpoints (admin, sync, webhooks) require a Bearer token matching an active entry in the `api_keys` table. Tokens use the `rw_` prefix and are verified by SHA-256 hashing the provided key and looking up the hash in the database.

Middleware implementation:

```typescript
import { createMiddleware } from 'hono/factory';
import { eq, and } from 'drizzle-orm';
import type { Env } from '../types/env';
import { apiKeys } from '../db/schema/system';

export const requireAuth = (requiredScope: 'read' | 'admin' = 'read') =>
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer rw_')) {
      return c.json({ error: 'Unauthorized', status: 401 }, 401);
    }

    const token = header.slice(7); // strip "Bearer "
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(token)
    );
    const keyHash = [...new Uint8Array(hashBuffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const db = drizzle(c.env.DB);
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, 1)));

    if (!key) {
      return c.json({ error: 'Unauthorized', status: 401 }, 401);
    }

    if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
      return c.json({ error: 'Token expired', status: 401 }, 401);
    }

    if (requiredScope === 'admin' && key.scope !== 'admin') {
      return c.json({ error: 'Forbidden', status: 403 }, 403);
    }

    // Attach user context for downstream handlers
    c.set('userId', key.userId);
    c.set('keyScope', key.scope);

    // Update last_used_at and request_count asynchronously
    c.executionCtx.waitUntil(
      db
        .update(apiKeys)
        .set({
          lastUsedAt: new Date().toISOString(),
          requestCount: key.requestCount + 1,
        })
        .where(eq(apiKeys.id, key.id))
    );

    await next();
  });
```

Usage on route groups:

```typescript
const admin = new Hono<{ Bindings: Env }>();
admin.use('/*', requireAuth('admin'));
admin.post('/sync/listening', syncListeningHandler);
admin.post('/sync/running', syncRunningHandler);

const protectedReads = new Hono<{ Bindings: Env }>();
protectedReads.use('/*', requireAuth('read'));
protectedReads.get('/me/keys', listApiKeysHandler);
```

## CORS

Cross-origin requests are handled by Hono's built-in CORS middleware. Allowed origins are configured via the `ALLOWED_ORIGINS` environment variable (comma-separated), defaulting to `patdugan.me` and `localhost:3000`.

```typescript
import { cors } from 'hono/cors';

app.use(
  '/*',
  cors({
    origin: (origin) => {
      const allowed = (
        c.env.ALLOWED_ORIGINS ?? 'https://patdugan.me,http://localhost:3000'
      )
        .split(',')
        .map((o: string) => o.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);
```

## API Versioning

All routes are prefixed with `/v1/`. This allows non-breaking evolution of the API while preserving the ability to introduce breaking changes under `/v2/` in the future.

## Database Schema

All tables use D1 (SQLite). Dates are stored as ISO 8601 text strings. Foreign keys are enforced. All user-specific tables include a `user_id` column (defaulting to `1`) to structurally prepare for multi-user support.

### System Tables

```sql
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  last_used_at TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  domain TEXT NOT NULL,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  items_synced INTEGER DEFAULT 0,
  error TEXT,
  metadata TEXT
);

CREATE TABLE activity_feed (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  domain TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  image_key TEXT,
  source_id TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE images (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  domain TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  width INTEGER,
  height INTEGER,
  thumbhash TEXT,
  dominant_color TEXT,
  accent_color TEXT,
  is_override INTEGER NOT NULL DEFAULT 0,
  override_at TEXT,
  image_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, entity_type, entity_id)
);

CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  event_source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_source, event_id)
);

CREATE TABLE revalidation_hooks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  secret TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

System indexes:

```sql
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_sync_runs_domain ON sync_runs(domain);
CREATE INDEX idx_sync_runs_started_at ON sync_runs(started_at);
CREATE INDEX idx_sync_runs_user_id ON sync_runs(user_id);
CREATE INDEX idx_activity_feed_domain ON activity_feed(domain);
CREATE INDEX idx_activity_feed_occurred_at ON activity_feed(occurred_at);
CREATE INDEX idx_activity_feed_event_type ON activity_feed(event_type);
CREATE INDEX idx_activity_feed_user_id ON activity_feed(user_id);
CREATE INDEX idx_images_domain ON images(domain);
CREATE INDEX idx_images_entity ON images(entity_type, entity_id);
CREATE INDEX idx_images_user_id ON images(user_id);
CREATE INDEX idx_webhook_events_source ON webhook_events(event_source);
CREATE INDEX idx_webhook_events_user_id ON webhook_events(user_id);
CREATE INDEX idx_revalidation_hooks_user_id ON revalidation_hooks(user_id);
```

### Last.fm Tables

```sql
CREATE TABLE lastfm_artists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  mbid TEXT,
  name TEXT NOT NULL UNIQUE,
  url TEXT,
  playcount INTEGER DEFAULT 0,
  is_filtered INTEGER DEFAULT 0,
  image_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lastfm_albums (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  mbid TEXT,
  name TEXT NOT NULL,
  artist_id INTEGER NOT NULL REFERENCES lastfm_artists(id),
  url TEXT,
  playcount INTEGER DEFAULT 0,
  is_filtered INTEGER DEFAULT 0,
  image_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, artist_id)
);

CREATE TABLE lastfm_tracks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  mbid TEXT,
  name TEXT NOT NULL,
  artist_id INTEGER NOT NULL REFERENCES lastfm_artists(id),
  album_id INTEGER REFERENCES lastfm_albums(id),
  url TEXT,
  duration_ms INTEGER,
  is_filtered INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, artist_id)
);

CREATE TABLE lastfm_scrobbles (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  track_id INTEGER NOT NULL REFERENCES lastfm_tracks(id),
  scrobbled_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lastfm_top_artists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  period TEXT NOT NULL,
  rank INTEGER NOT NULL,
  artist_id INTEGER NOT NULL REFERENCES lastfm_artists(id),
  playcount INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period, artist_id)
);

CREATE TABLE lastfm_top_albums (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  period TEXT NOT NULL,
  rank INTEGER NOT NULL,
  album_id INTEGER NOT NULL REFERENCES lastfm_albums(id),
  playcount INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period, album_id)
);

CREATE TABLE lastfm_top_tracks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  period TEXT NOT NULL,
  rank INTEGER NOT NULL,
  track_id INTEGER NOT NULL REFERENCES lastfm_tracks(id),
  playcount INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period, track_id)
);

CREATE TABLE lastfm_filters (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  filter_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  scope TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lastfm_user_stats (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  total_scrobbles INTEGER NOT NULL DEFAULT 0,
  unique_artists INTEGER NOT NULL DEFAULT 0,
  unique_albums INTEGER NOT NULL DEFAULT 0,
  unique_tracks INTEGER NOT NULL DEFAULT 0,
  registered_date TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Last.fm indexes:

```sql
CREATE INDEX idx_lastfm_artists_user_id ON lastfm_artists(user_id);
CREATE INDEX idx_lastfm_albums_artist_id ON lastfm_albums(artist_id);
CREATE INDEX idx_lastfm_albums_user_id ON lastfm_albums(user_id);
CREATE INDEX idx_lastfm_tracks_artist_id ON lastfm_tracks(artist_id);
CREATE INDEX idx_lastfm_tracks_album_id ON lastfm_tracks(album_id);
CREATE INDEX idx_lastfm_tracks_user_id ON lastfm_tracks(user_id);
CREATE INDEX idx_lastfm_scrobbles_track_id ON lastfm_scrobbles(track_id);
CREATE INDEX idx_lastfm_scrobbles_scrobbled_at ON lastfm_scrobbles(scrobbled_at);
CREATE INDEX idx_lastfm_scrobbles_user_id ON lastfm_scrobbles(user_id);
CREATE INDEX idx_lastfm_top_artists_period ON lastfm_top_artists(period);
CREATE INDEX idx_lastfm_top_artists_user_id ON lastfm_top_artists(user_id);
CREATE INDEX idx_lastfm_top_albums_period ON lastfm_top_albums(period);
CREATE INDEX idx_lastfm_top_albums_user_id ON lastfm_top_albums(user_id);
CREATE INDEX idx_lastfm_top_tracks_period ON lastfm_top_tracks(period);
CREATE INDEX idx_lastfm_top_tracks_user_id ON lastfm_top_tracks(user_id);
CREATE INDEX idx_lastfm_artists_filtered ON lastfm_artists(is_filtered);
CREATE INDEX idx_lastfm_albums_filtered ON lastfm_albums(is_filtered);
CREATE INDEX idx_lastfm_tracks_filtered ON lastfm_tracks(is_filtered);
CREATE INDEX idx_lastfm_filters_type ON lastfm_filters(filter_type);
CREATE INDEX idx_lastfm_filters_user_id ON lastfm_filters(user_id);
CREATE INDEX idx_lastfm_user_stats_user_id ON lastfm_user_stats(user_id);
```

### Strava Tables

```sql
CREATE TABLE strava_activities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  strava_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  sport_type TEXT,
  start_date TEXT NOT NULL,
  start_date_local TEXT NOT NULL,
  timezone TEXT,
  elapsed_time_s INTEGER NOT NULL,
  moving_time_s INTEGER NOT NULL,
  distance_m REAL NOT NULL,
  total_elevation_m REAL,
  average_speed_mps REAL,
  max_speed_mps REAL,
  average_heartrate REAL,
  max_heartrate REAL,
  suffer_score INTEGER,
  calories REAL,
  average_cadence REAL,
  gear_id TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  start_lat REAL,
  start_lng REAL,
  summary_polyline TEXT,
  description TEXT,
  workout_type INTEGER,
  is_race INTEGER DEFAULT 0,
  achievement_count INTEGER DEFAULT 0,
  pr_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE strava_gear (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  strava_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  gear_type TEXT,
  distance_m REAL NOT NULL DEFAULT 0,
  is_retired INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE strava_personal_records (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  distance_label TEXT NOT NULL,
  distance_m REAL NOT NULL,
  time_s INTEGER NOT NULL,
  pace_per_mile_s INTEGER NOT NULL,
  activity_id INTEGER NOT NULL REFERENCES strava_activities(id),
  achieved_at TEXT NOT NULL,
  is_current INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(distance_label, activity_id)
);

CREATE TABLE strava_year_summaries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  year INTEGER NOT NULL UNIQUE,
  total_runs INTEGER NOT NULL DEFAULT 0,
  total_distance_m REAL NOT NULL DEFAULT 0,
  total_elevation_m REAL NOT NULL DEFAULT 0,
  total_duration_s INTEGER NOT NULL DEFAULT 0,
  avg_pace_per_mile_s INTEGER,
  longest_run_m REAL,
  race_count INTEGER DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE strava_lifetime_stats (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  total_runs INTEGER NOT NULL DEFAULT 0,
  total_distance_m REAL NOT NULL DEFAULT 0,
  total_elevation_m REAL NOT NULL DEFAULT 0,
  total_duration_s INTEGER NOT NULL DEFAULT 0,
  avg_pace_per_mile_s INTEGER,
  years_active INTEGER,
  first_run_date TEXT,
  eddington_number INTEGER,
  current_streak_days INTEGER DEFAULT 0,
  longest_streak_days INTEGER DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE strava_splits (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  activity_id INTEGER NOT NULL REFERENCES strava_activities(id),
  split_number INTEGER NOT NULL,
  distance_m REAL NOT NULL,
  elapsed_time_s INTEGER NOT NULL,
  moving_time_s INTEGER NOT NULL,
  elevation_diff REAL,
  average_speed REAL,
  average_heartrate REAL,
  pace_zone INTEGER,
  UNIQUE(activity_id, split_number)
);

CREATE TABLE strava_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Strava indexes:

```sql
CREATE INDEX idx_strava_activities_start_date ON strava_activities(start_date);
CREATE INDEX idx_strava_activities_start_date_local ON strava_activities(start_date_local);
CREATE INDEX idx_strava_activities_activity_type ON strava_activities(activity_type);
CREATE INDEX idx_strava_activities_is_race ON strava_activities(is_race);
CREATE INDEX idx_strava_activities_gear_id ON strava_activities(gear_id);
CREATE INDEX idx_strava_activities_user_id ON strava_activities(user_id);
CREATE INDEX idx_strava_gear_user_id ON strava_gear(user_id);
CREATE INDEX idx_strava_splits_activity_id ON strava_splits(activity_id);
CREATE INDEX idx_strava_splits_user_id ON strava_splits(user_id);
CREATE INDEX idx_strava_personal_records_activity_id ON strava_personal_records(activity_id);
CREATE INDEX idx_strava_personal_records_is_current ON strava_personal_records(is_current);
CREATE INDEX idx_strava_personal_records_achieved_at ON strava_personal_records(achieved_at);
CREATE INDEX idx_strava_personal_records_user_id ON strava_personal_records(user_id);
CREATE INDEX idx_strava_year_summaries_user_id ON strava_year_summaries(user_id);
CREATE INDEX idx_strava_lifetime_stats_user_id ON strava_lifetime_stats(user_id);
CREATE INDEX idx_strava_tokens_user_id ON strava_tokens(user_id);
```

### Watching Tables

Movie and watch history tables are source-agnostic. Movies can be ingested from Plex, Letterboxd, or manual entry. All share the same TMDB enrichment pipeline. TV show tables remain Plex-specific (Plex is the only TV source).

```sql
CREATE TABLE movies (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  plex_rating_key TEXT UNIQUE,
  title TEXT NOT NULL,
  year INTEGER,
  tmdb_id INTEGER UNIQUE,
  imdb_id TEXT UNIQUE,
  tagline TEXT,
  summary TEXT,
  rating REAL,
  audience_rating REAL,
  content_rating TEXT,
  duration_ms INTEGER,
  studio TEXT,
  image_key TEXT,
  backdrop_key TEXT,
  added_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE genres (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE movie_genres (
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  genre_id INTEGER NOT NULL REFERENCES genres(id),
  PRIMARY KEY (movie_id, genre_id)
);

CREATE TABLE directors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE movie_directors (
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  director_id INTEGER NOT NULL REFERENCES directors(id),
  PRIMARY KEY (movie_id, director_id)
);

CREATE TABLE watch_history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  watched_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'plex',
  user_rating REAL,
  percent_complete REAL,
  rewatch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE watch_stats (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  total_movies INTEGER NOT NULL DEFAULT 0,
  total_watch_time_s INTEGER NOT NULL DEFAULT 0,
  movies_this_year INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE plex_shows (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  plex_rating_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  year INTEGER,
  tmdb_id INTEGER,
  summary TEXT,
  image_key TEXT,
  total_seasons INTEGER,
  total_episodes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE plex_episodes_watched (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  show_id INTEGER NOT NULL REFERENCES plex_shows(id),
  season_number INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  title TEXT,
  watched_at TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Watch history `source` values: `plex`, `letterboxd`, `manual`.

Watch history deduplication: same `movie_id` + same calendar date (UTC) = same watch event. Source priority when duplicates are detected: Plex > Letterboxd > Manual (Plex has richest metadata). Rewatches on different dates are always stored as separate events.

Watching indexes:

```sql
CREATE INDEX idx_movies_year ON movies(year);
CREATE INDEX idx_movies_tmdb_id ON movies(tmdb_id);
CREATE INDEX idx_movies_user_id ON movies(user_id);
CREATE INDEX idx_movie_genres_genre_id ON movie_genres(genre_id);
CREATE INDEX idx_movie_directors_director_id ON movie_directors(director_id);
CREATE INDEX idx_watch_history_movie_id ON watch_history(movie_id);
CREATE INDEX idx_watch_history_watched_at ON watch_history(watched_at);
CREATE INDEX idx_watch_history_user_id ON watch_history(user_id);
CREATE INDEX idx_watch_history_source ON watch_history(source);
CREATE INDEX idx_watch_stats_user_id ON watch_stats(user_id);
CREATE INDEX idx_plex_shows_user_id ON plex_shows(user_id);
CREATE INDEX idx_plex_episodes_watched_show_id ON plex_episodes_watched(show_id);
CREATE INDEX idx_plex_episodes_watched_watched_at ON plex_episodes_watched(watched_at);
CREATE INDEX idx_plex_episodes_watched_user_id ON plex_episodes_watched(user_id);
```

### Discogs Tables

```sql
CREATE TABLE discogs_releases (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  discogs_id INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  year INTEGER,
  format TEXT,
  format_detail TEXT,
  label TEXT,
  catalog_number TEXT,
  country TEXT,
  genres TEXT,
  styles TEXT,
  image_key TEXT,
  discogs_url TEXT,
  lowest_price REAL,
  num_for_sale INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE discogs_release_artists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  release_id INTEGER NOT NULL REFERENCES discogs_releases(id),
  artist_name TEXT NOT NULL,
  discogs_artist_id INTEGER,
  role TEXT DEFAULT 'main'
);

CREATE TABLE discogs_collection (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  release_id INTEGER NOT NULL REFERENCES discogs_releases(id),
  instance_id INTEGER NOT NULL,
  folder_id INTEGER DEFAULT 0,
  folder_name TEXT,
  rating INTEGER,
  notes TEXT,
  date_added TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(release_id, instance_id)
);

CREATE TABLE discogs_wantlist (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  release_id INTEGER NOT NULL REFERENCES discogs_releases(id),
  notes TEXT,
  rating INTEGER,
  date_added TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(release_id)
);

CREATE TABLE discogs_collection_stats (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  total_items INTEGER NOT NULL DEFAULT 0,
  total_vinyl INTEGER NOT NULL DEFAULT 0,
  total_cd INTEGER NOT NULL DEFAULT 0,
  total_other INTEGER NOT NULL DEFAULT 0,
  wantlist_count INTEGER NOT NULL DEFAULT 0,
  unique_artists INTEGER NOT NULL DEFAULT 0,
  estimated_value REAL,
  genre_breakdown TEXT,
  decade_breakdown TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE collection_listening_xref (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  release_id INTEGER NOT NULL REFERENCES discogs_releases(id),
  lastfm_album_id INTEGER REFERENCES lastfm_albums(id),
  match_type TEXT NOT NULL,
  match_confidence REAL,
  play_count INTEGER DEFAULT 0,
  last_played TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(release_id, lastfm_album_id)
);
```

Discogs indexes:

```sql
CREATE INDEX idx_discogs_releases_year ON discogs_releases(year);
CREATE INDEX idx_discogs_releases_format ON discogs_releases(format);
CREATE INDEX idx_discogs_releases_user_id ON discogs_releases(user_id);
CREATE INDEX idx_discogs_release_artists_release_id ON discogs_release_artists(release_id);
CREATE INDEX idx_discogs_release_artists_artist_name ON discogs_release_artists(artist_name);
CREATE INDEX idx_discogs_release_artists_user_id ON discogs_release_artists(user_id);
CREATE INDEX idx_discogs_collection_release_id ON discogs_collection(release_id);
CREATE INDEX idx_discogs_collection_date_added ON discogs_collection(date_added);
CREATE INDEX idx_discogs_collection_user_id ON discogs_collection(user_id);
CREATE INDEX idx_discogs_wantlist_release_id ON discogs_wantlist(release_id);
CREATE INDEX idx_discogs_wantlist_user_id ON discogs_wantlist(user_id);
CREATE INDEX idx_discogs_collection_stats_user_id ON discogs_collection_stats(user_id);
CREATE INDEX idx_collection_listening_xref_release_id ON collection_listening_xref(release_id);
CREATE INDEX idx_collection_listening_xref_lastfm_album_id ON collection_listening_xref(lastfm_album_id);
CREATE INDEX idx_collection_listening_xref_user_id ON collection_listening_xref(user_id);
```

## Drizzle Schema Pattern

Each SQL table maps to a Drizzle `sqliteTable` definition in the corresponding schema file. Example mapping for `lastfm_artists`:

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const lastfmArtists = sqliteTable('lastfm_artists', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull().default(1),
  mbid: text('mbid'),
  name: text('name').notNull().unique(),
  url: text('url'),
  playcount: integer('playcount').default(0),
  isFiltered: integer('is_filtered').default(0),
  imageKey: text('image_key'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
```

Schema changes are made in the Drizzle schema files, then `npm run db:generate` produces the SQL migration. Column names use snake_case in SQL and camelCase in TypeScript via Drizzle's column name mapping.

## Caching Strategy

| Endpoint Pattern                     | Cache-Control                         | Rationale                                        |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------ |
| `/v1/listening/now-playing`          | `no-store`                            | Real-time, always fresh                          |
| `/v1/listening/recent/*`             | `public, max-age=60`                  | Updates frequently with new scrobbles            |
| `/v1/listening/stats/*`              | `public, max-age=3600`                | Computed aggregates, hourly refresh sufficient   |
| `/v1/listening/top/*`                | `public, max-age=3600`                | Top lists recomputed daily, hourly cache is fine |
| `/v1/running/recent/*`               | `public, max-age=60`                  | New activities appear in real-time via webhook   |
| `/v1/running/stats/*`                | `public, max-age=3600`                | Computed summaries                               |
| `/v1/running/calendar/{currentYear}` | `public, max-age=3600`                | Current year still accumulating data             |
| `/v1/running/calendar/{pastYear}`    | `public, max-age=86400, immutable`    | Historical data does not change                  |
| `/v1/watching/recent/*`              | `public, max-age=60`                  | Webhook-driven updates                           |
| `/v1/watching/stats/*`               | `public, max-age=3600`                | Computed aggregates                              |
| `/v1/collecting/collection/*`        | `public, max-age=86400`               | Collection changes infrequently                  |
| `/v1/collecting/stats/*`             | `public, max-age=86400`               | Weekly sync only                                 |
| `/v1/images/*`                       | `public, max-age=31536000, immutable` | Images in R2 are content-addressed, never change |
| `/v1/feed`                           | `public, max-age=300`                 | Cross-domain feed, 5-minute freshness            |
| `/v1/health`                         | `no-store`                            | Diagnostic, always fresh                         |
| `/v1/health/sync`                    | `no-store`                            | Diagnostic, always fresh                         |
| `/v1/admin/*`                        | `no-store`                            | Admin operations, never cached                   |

## Sync Strategy

| Domain               | Trigger        | Schedule                                                          | Strategy                                                           | Rate Limit                  |
| -------------------- | -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| Listening (Last.fm)  | Cron           | Every 15 min (scrobbles), daily 3 AM (top lists, stats)           | Incremental from last scrobble timestamp                           | 5 req/sec                   |
| Running (Strava)     | Cron + Webhook | Daily 4 AM catch-up + real-time webhook on activity create/update | Incremental since last synced activity                             | 200 req/15min, 2000 req/day |
| Watching (Plex)      | Webhook + Cron | Real-time scrobble webhook + daily 5 AM library scan              | Webhook-driven for watch events, cron catch-up for library changes | ~50 req/sec (TMDB)          |
| Collecting (Discogs) | Cron           | Weekly, Sunday 6 AM                                               | Full collection sync (replace all)                                 | 60 req/min                  |

Each sync run is recorded in the `sync_runs` table with status (`running`, `completed`, `failed`), item count, duration, and any error message. The `/v1/health/sync` endpoint exposes the most recent sync run per domain for monitoring.

## Image Pipeline

The image pipeline resolves artwork for entities across all domains. The flow:

```text
1. Entity needs image (e.g., album art, movie poster)
       |
2. Check `images` table for existing entry
       |
   [exists] --> Return cdn.rewind.rest/{r2_key}?v={image_version}
       |
   [not found]
       |
3. Run source waterfall (domain-specific):
   - Albums:  Cover Art Archive -> iTunes Search -> Apple Music API
   - Artists: Apple Music API -> Fanart.tv
   - Movies:  TMDB (poster + backdrop)
   - Releases: Discogs release images
       |
4. Fetch image from resolved source URL
       |
5. Upload to R2 bucket
       |
6. Generate ThumbHash (compact image placeholder)
       |
7. Extract dominant and accent colors
       |
8. Store metadata in `images` table
       |
9. Return CDN URL
```

R2 key format: `{domain}/{entity_type}/{entity_id}/original.{ext}`

Examples:

- `listening/album/42/original.jpg`
- `watching/movie/550/original.jpg`
- `collecting/release/1234/original.jpg`

CDN URL: `https://cdn.rewind.rest/{r2_key}`

ThumbHash is a compact (28-byte) image placeholder encoding that allows the frontend to render a blurred preview before the full image loads. It is stored as a base64 string in the `images` table.

The `dominant_color` and `accent_color` fields store hex color values (e.g., `#1a2b3c`) extracted from the image during pipeline processing. These can be used for UI theming, placeholder backgrounds, and color-coordinated layouts.

### Image Overrides

Images can be manually overridden via admin endpoints. Override columns on the `images` table:

- `is_override` -- 1 if the image was manually set, 0 for automatic pipeline
- `override_at` -- timestamp when the override was applied
- `image_version` -- incremented on each override, appended to CDN URLs as `?v={image_version}` for cache busting

During automatic sync/pipeline runs, images with `is_override = 1` are skipped. This ensures manual selections persist through all future syncs. An override can be reverted, which clears the flag and re-runs the automatic pipeline.

## Environment Variables

| Variable                      | Domain     | Description                                                                                         |
| ----------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`             | System     | Comma-separated list of allowed CORS origins (default: `https://patdugan.me,http://localhost:3000`) |
| `LASTFM_API_KEY`              | Listening  | Last.fm API key for fetching scrobbles, top charts, and user info                                   |
| `LASTFM_USERNAME`             | Listening  | Last.fm account username (`pdugan20`) to query scrobble history for                                 |
| `STRAVA_CLIENT_ID`            | Running    | Strava OAuth2 application client ID for token exchange                                              |
| `STRAVA_CLIENT_SECRET`        | Running    | Strava OAuth2 application client secret for token exchange                                          |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | Running    | Token used to validate Strava webhook subscription verification requests                            |
| `PLEX_URL`                    | Watching   | Base URL of the Plex Media Server (e.g., `http://192.168.1.x:32400`)                                |
| `PLEX_TOKEN`                  | Watching   | Plex authentication token for server API access                                                     |
| `PLEX_WEBHOOK_SECRET`         | Watching   | Shared secret to verify incoming Plex webhook payloads                                              |
| `TMDB_API_KEY`                | Watching   | TMDB (The Movie Database) API read access token for movie metadata and images                       |
| `LETTERBOXD_USERNAME`         | Watching   | Letterboxd username for RSS feed sync                                                               |
| `DISCOGS_PERSONAL_TOKEN`      | Collecting | Discogs personal access token for collection and wantlist access                                    |
| `DISCOGS_USERNAME`            | Collecting | Discogs account username (`patdugan`) to query collection for                                       |
| `APPLE_MUSIC_DEVELOPER_TOKEN` | Images     | Apple Music API JWT for artist and album artwork lookups                                            |
| `FANART_TV_API_KEY`           | Images     | Fanart.tv project API key for high-quality artist images                                            |

Cloudflare bindings (not environment variables -- configured in `wrangler.toml`):

| Binding  | Type | Purpose                                                       |
| -------- | ---- | ------------------------------------------------------------- |
| `DB`     | D1   | Primary SQLite database for all structured data               |
| `IMAGES` | R2   | Object storage bucket for images served via `cdn.rewind.rest` |

## Error Handling

All error responses follow a consistent shape:

```json
{
  "error": "Not found",
  "status": 404
}
```

HTTP status codes used:

| Status | Meaning               | When Used                                                                   |
| ------ | --------------------- | --------------------------------------------------------------------------- |
| 200    | OK                    | Successful GET or POST                                                      |
| 400    | Bad Request           | Invalid query parameters, malformed request body                            |
| 401    | Unauthorized          | Missing or invalid Bearer token on protected endpoints                      |
| 403    | Forbidden             | Valid token but insufficient scope (e.g., `read` token on `admin` endpoint) |
| 404    | Not Found             | Resource does not exist (activity, artist, movie, etc.)                     |
| 429    | Too Many Requests     | Rate limit exceeded (forwarded from upstream API)                           |
| 500    | Internal Server Error | Unhandled exception, database error, upstream failure                       |

External API error handling:

- **429 / 5xx responses**: Retry with exponential backoff (up to 3 attempts), then fail the item
- **4xx responses** (except 429): Log the error, skip the item, continue processing remaining items

Sync error handling:

- Each item is processed in a try/catch block so a single failure does not abort the entire sync
- Failed items are counted and logged
- The `sync_runs` record captures the final status (`completed` or `failed`), total items synced, and any error summary
- Partial syncs (some items failed) are recorded as `completed` with error details in the `metadata` field

## Hono RPC

Hono's RPC feature provides end-to-end type safety between the API and consuming clients. The Rewind API exports its route types, and the portfolio frontend uses `hc<AppType>()` to create a fully typed HTTP client.

Server-side (Rewind API):

```typescript
// src/index.ts
const app = new Hono<{ Bindings: Env }>()
  .route('/v1/listening', listeningRoutes)
  .route('/v1/running', runningRoutes)
  .route('/v1/watching', watchingRoutes)
  .route('/v1/collecting', collectingRoutes)
  .route('/v1/feed', feedRoutes);

export type AppType = typeof app;
```

Client-side (pat-portfolio):

```typescript
import { hc } from 'hono/client';
import type { AppType } from 'rewind';

const client = hc<AppType>('https://api.rewind.rest');

// Fully typed -- IDE autocomplete on routes, params, and response shapes
const res = await client.v1.listening.top.artists.$get({
  query: { period: '7day', limit: '10' },
});
const data = await res.json();
// data is typed as the exact response shape from the route handler
```

This eliminates the need for manual API type definitions in the frontend. Route changes in Rewind are immediately reflected as type errors in the consuming client.

## Deployment

The deployment pipeline runs via GitHub Actions:

```text
Push to main
    |
    v
[Lint] --> [Test] --> [Migrate] --> [Deploy]
  ESLint    Vitest    wrangler d1    wrangler deploy
  Prettier            migrations
                      apply
```

Steps:

1. **Lint**: ESLint and Prettier check all source files
2. **Test**: Vitest runs with `@cloudflare/vitest-pool-workers` for Workers-compatible tests
3. **Migrate**: `wrangler d1 migrations apply DB --remote` applies any pending D1 migrations
4. **Deploy**: `wrangler deploy` publishes the Worker to Cloudflare

Migrations must run before the code deploy because the new code may reference columns or tables that the migration creates. Running them in reverse order would cause runtime errors.

Preview environments use a separate D1 preview database. Pull request deployments get their own isolated Worker URL for testing before merge.

## Monitoring

- **Cloudflare Workers Analytics**: Request count, CPU time, error rate, and latency percentiles available in the Cloudflare dashboard
- **Health endpoints**:
  - `GET /v1/health` -- returns `{ "status": "ok" }` to confirm the Worker is responding
  - `GET /v1/health/sync` -- returns the most recent `sync_runs` entry per domain with status, timestamp, and item count
- **Workers Logs**: `console.error()` calls are captured in Cloudflare Workers real-time logs and can be tailed with `wrangler tail`
- **Future**: Sentry free tier integration for structured error tracking and alerting

## Known Issues

- **Multi-user support**: Multi-user support is structurally prepared (`user_id` on all tables, `api_keys` with user scoping) but not yet exposed via user management endpoints.
- **D1 is SQLite**: No PostGIS for geospatial queries (polylines are stored as encoded strings, decoded client-side). No `generate_series` -- calendar/streak queries require workarounds with recursive CTEs or application-level iteration.
- **D1 limits**: 500 MB per database on the free tier, maximum 10 databases per account. Schema must stay efficient to fit all four domains in a single database.
- **R2 free tier**: 10 GB storage, 10 million Class B requests/month, 1 million Class A requests/month. Sufficient for a personal project with cached images.
- **Workers free tier**: 100,000 requests/day, 10 ms CPU time per invocation. Paid plan removes these limits.
- **Cron triggers**: Maximum 3 cron triggers per Worker on the free plan, minimum 1-minute interval. Multiple sync schedules must be multiplexed through a single cron handler that dispatches based on the current time.
- **Strava refresh token rotation**: Strava OAuth2 rotates the refresh token on every access token exchange. The new refresh token must be persisted in the `strava_tokens` table to avoid invalidating the auth flow.
- **Plex webhooks require Plex Pass**: Only Plex Pass subscribers receive webhook events. Without it, the watching domain falls back to cron-only polling of the Plex API.
- **TMDB attribution requirement**: TMDB requires visible attribution ("This product uses the TMDB API but is not endorsed or certified by TMDB") on any application using their data or images.
- **ThumbHash generation in Workers**: Workers have no native image decoding (no `sharp`, no `canvas`). ThumbHash generation requires a WASM-based image decoder (e.g., `image-rs` compiled to WASM) to extract pixel data before encoding.
- **Last.fm artist images deprecated**: Last.fm removed artist image URLs from their API in 2020. Artist images must be sourced from Apple Music API or Fanart.tv instead.
