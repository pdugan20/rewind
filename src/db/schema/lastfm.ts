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
