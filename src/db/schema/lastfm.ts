import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

export const lastfmArtists = sqliteTable(
  'lastfm_artists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    mbid: text('mbid'),
    name: text('name').notNull(),
    url: text('url'),
    playcount: integer('playcount').default(0),
    isFiltered: integer('is_filtered').default(0),
    imageKey: text('image_key'),
    tags: text('tags'), // JSON array of { name, count } after allowlist filtering
    genre: text('genre'), // Primary genre (top allowlisted tag)
    appleMusicId: integer('apple_music_id'),
    appleMusicUrl: text('apple_music_url'),
    itunesEnrichedAt: text('itunes_enriched_at'),
    // Last.fm artist.getInfo enrichment. bio_summary is the 1–2 sentence
    // summary (CDATA stripped, link removed); bio_content is the longer
    // body. bio_synced_at gates a 90-day refresh.
    bioSummary: text('bio_summary'),
    bioContent: text('bio_content'),
    bioSyncedAt: text('bio_synced_at'),
    // Last.fm artist.getSimilar response, intersected against this user's
    // own lastfm_artists at storage time so we only persist similar artists
    // the user has also listened to. JSON shape:
    //   Array<{ artist_id: number, name: string, mbid: string|null,
    //           similarity_score: number }>
    // Eager-synced for the top-200 artists by playcount via the daily cron.
    similarArtists: text('similar_artists'),
    similarSyncedAt: text('similar_synced_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_lastfm_artists_user_name').on(table.userId, table.name),
    index('idx_lastfm_artists_user_id').on(table.userId),
    index('idx_lastfm_artists_filtered').on(table.isFiltered),
    index('idx_lastfm_artists_genre').on(table.genre),
  ]
);

export const lastfmAlbums = sqliteTable(
  'lastfm_albums',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    mbid: text('mbid'),
    name: text('name').notNull(),
    artistId: integer('artist_id')
      .notNull()
      .references(() => lastfmArtists.id),
    url: text('url'),
    playcount: integer('playcount').default(0),
    isFiltered: integer('is_filtered').default(0),
    imageKey: text('image_key'),
    appleMusicId: integer('apple_music_id'),
    appleMusicUrl: text('apple_music_url'),
    itunesEnrichedAt: text('itunes_enriched_at'),
    // Apple Music catalog metadata (releaseDate + trackCount). Populated
    // by services/apple-music/album.ts via the catalog API; gates the
    // album-group depth signal on the artist card / top-tracks card
    // ("2023 · 12 of 13 tracks").
    releasedYear: integer('released_year'),
    totalTracks: integer('total_tracks'),
    appleMusicEnrichedAt: text('apple_music_enriched_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_lastfm_albums_unique').on(table.name, table.artistId),
    index('idx_lastfm_albums_artist_id').on(table.artistId),
    index('idx_lastfm_albums_user_id').on(table.userId),
    index('idx_lastfm_albums_filtered').on(table.isFiltered),
  ]
);

export const lastfmTracks = sqliteTable(
  'lastfm_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    mbid: text('mbid'),
    name: text('name').notNull(),
    artistId: integer('artist_id')
      .notNull()
      .references(() => lastfmArtists.id),
    albumId: integer('album_id').references(() => lastfmAlbums.id),
    url: text('url'),
    durationMs: integer('duration_ms'),
    isFiltered: integer('is_filtered').default(0),
    appleMusicId: integer('apple_music_id'),
    appleMusicUrl: text('apple_music_url'),
    previewUrl: text('preview_url'),
    itunesEnrichedAt: text('itunes_enriched_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_lastfm_tracks_unique').on(table.name, table.artistId),
    index('idx_lastfm_tracks_artist_id').on(table.artistId),
    index('idx_lastfm_tracks_album_id').on(table.albumId),
    index('idx_lastfm_tracks_user_id').on(table.userId),
    index('idx_lastfm_tracks_filtered').on(table.isFiltered),
  ]
);

export const lastfmScrobbles = sqliteTable(
  'lastfm_scrobbles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    trackId: integer('track_id')
      .notNull()
      .references(() => lastfmTracks.id),
    scrobbledAt: text('scrobbled_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_lastfm_scrobbles_track_id').on(table.trackId),
    index('idx_lastfm_scrobbles_scrobbled_at').on(table.scrobbledAt),
    index('idx_lastfm_scrobbles_user_id').on(table.userId),
    index('idx_lastfm_scrobbles_track_scrobbled').on(
      table.trackId,
      table.scrobbledAt
    ),
  ]
);

export const lastfmTopArtists = sqliteTable(
  'lastfm_top_artists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    period: text('period').notNull(),
    rank: integer('rank').notNull(),
    artistId: integer('artist_id')
      .notNull()
      .references(() => lastfmArtists.id),
    playcount: integer('playcount').notNull(),
    computedAt: text('computed_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_lastfm_top_artists_unique').on(
      table.period,
      table.artistId
    ),
    index('idx_lastfm_top_artists_period').on(table.period),
    index('idx_lastfm_top_artists_user_id').on(table.userId),
  ]
);

export const lastfmTopAlbums = sqliteTable(
  'lastfm_top_albums',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    period: text('period').notNull(),
    rank: integer('rank').notNull(),
    albumId: integer('album_id')
      .notNull()
      .references(() => lastfmAlbums.id),
    playcount: integer('playcount').notNull(),
    computedAt: text('computed_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_lastfm_top_albums_unique').on(table.period, table.albumId),
    index('idx_lastfm_top_albums_period').on(table.period),
    index('idx_lastfm_top_albums_user_id').on(table.userId),
  ]
);

export const lastfmTopTracks = sqliteTable(
  'lastfm_top_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    period: text('period').notNull(),
    rank: integer('rank').notNull(),
    trackId: integer('track_id')
      .notNull()
      .references(() => lastfmTracks.id),
    playcount: integer('playcount').notNull(),
    computedAt: text('computed_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_lastfm_top_tracks_unique').on(table.period, table.trackId),
    index('idx_lastfm_top_tracks_period').on(table.period),
    index('idx_lastfm_top_tracks_user_id').on(table.userId),
  ]
);

export const lastfmFilters = sqliteTable(
  'lastfm_filters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    filterType: text('filter_type').notNull(),
    pattern: text('pattern').notNull(),
    scope: text('scope'),
    reason: text('reason'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_lastfm_filters_type').on(table.filterType),
    index('idx_lastfm_filters_user_id').on(table.userId),
  ]
);

export const lastfmUserStats = sqliteTable(
  'lastfm_user_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    totalScrobbles: integer('total_scrobbles').notNull().default(0),
    uniqueArtists: integer('unique_artists').notNull().default(0),
    uniqueAlbums: integer('unique_albums').notNull().default(0),
    uniqueTracks: integer('unique_tracks').notNull().default(0),
    registeredDate: text('registered_date'),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_lastfm_user_stats_user_id').on(table.userId)]
);

// Precomputed per-month listening stats. Powers the bars on the listening
// page year view; refreshed during the daily 0 3 cron alongside top-lists
// sync. Same is_filtered=0 scope as the live aggregate the year endpoint
// used to compute, so values are identical.
export const lastfmMonthlyStats = sqliteTable(
  'lastfm_monthly_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    yearMonth: text('year_month').notNull(), // YYYY-MM
    scrobbles: integer('scrobbles').notNull().default(0),
    uniqueArtists: integer('unique_artists').notNull().default(0),
    uniqueAlbums: integer('unique_albums').notNull().default(0),
    computedAt: text('computed_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_lastfm_monthly_stats_unique').on(
      table.userId,
      table.yearMonth
    ),
    index('idx_lastfm_monthly_stats_user_id').on(table.userId),
  ]
);

// Audit log for the album-attribution-repair Phase 3 run. Every action
// (KEEP_AS_VA, COLLAPSE_TO_PRIMARY, SPLIT_PER_ARTIST) inserts a row so
// the migration is reviewable and reversible. See
// docs/projects/album-attribution-repair/.
export const lastfmAlbumAttributionAudit = sqliteTable(
  'lastfm_album_attribution_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    originalAlbumId: integer('original_album_id').notNull(),
    originalAlbumName: text('original_album_name').notNull(),
    originalArtistId: integer('original_artist_id'),
    action: text('action').notNull(),
    newAlbumId: integer('new_album_id'),
    newArtistId: integer('new_artist_id'),
    tracksMoved: integer('tracks_moved').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_album_attribution_audit_original').on(table.originalAlbumId),
    index('idx_album_attribution_audit_action').on(table.action),
    index('idx_album_attribution_audit_created').on(table.createdAt),
  ]
);

// Precomputed per-year listening stats. Powers GET /v1/listening/years —
// the year-picker summary used by the portfolio's listening page. Unique
// counts can't be derived by summing the monthly precompute (an artist
// listened to in Jan + Feb is one unique artist for the year, not two),
// so this table holds them at year granularity. Refreshed alongside the
// monthly precompute on the daily 0 3 cron.
export const lastfmYearlyStats = sqliteTable(
  'lastfm_yearly_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    year: integer('year').notNull(),
    scrobbles: integer('scrobbles').notNull().default(0),
    uniqueArtists: integer('unique_artists').notNull().default(0),
    uniqueAlbums: integer('unique_albums').notNull().default(0),
    uniqueTracks: integer('unique_tracks').notNull().default(0),
    topArtistId: integer('top_artist_id').references(() => lastfmArtists.id, {
      onDelete: 'set null',
    }),
    computedAt: text('computed_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_lastfm_yearly_stats_unique').on(table.userId, table.year),
    index('idx_lastfm_yearly_stats_user_id').on(table.userId),
  ]
);
