import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';
import { movies } from './watching.js';

export const traktTokens = sqliteTable(
  'trakt_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_trakt_tokens_user_id').on(table.userId)]
);

export const traktCollection = sqliteTable(
  'trakt_collection',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    movieId: integer('movie_id')
      .notNull()
      .references(() => movies.id),
    traktId: integer('trakt_id').notNull(),
    mediaType: text('media_type', {
      enum: ['bluray', 'uhd_bluray', 'hddvd', 'dvd', 'digital'],
    }).notNull(),
    resolution: text('resolution', {
      enum: ['uhd_4k', 'hd_1080p', 'hd_720p', 'sd_480p'],
    }),
    hdr: text('hdr', {
      enum: ['dolby_vision', 'hdr10', 'hdr10_plus', 'hlg'],
    }),
    audio: text('audio', {
      enum: ['dolby_atmos', 'dts_x', 'dolby_truehd', 'dts_hd_ma', 'lpcm'],
    }),
    audioChannels: text('audio_channels', {
      enum: ['7_1', '5_1', '2_0'],
    }),
    collectedAt: text('collected_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_trakt_collection_unique').on(
      table.userId,
      table.traktId,
      table.mediaType
    ),
    index('idx_trakt_collection_movie').on(table.movieId),
    index('idx_trakt_collection_media_type').on(table.mediaType),
    index('idx_trakt_collection_collected_at').on(table.collectedAt),
    index('idx_trakt_collection_user_id').on(table.userId),
  ]
);

export const traktCollectionStats = sqliteTable(
  'trakt_collection_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    totalItems: integer('total_items').notNull().default(0),
    byFormat: text('by_format'), // JSON: { bluray: N, uhd_bluray: N, hddvd: N, dvd: N, digital: N }
    byResolution: text('by_resolution'), // JSON: { uhd_4k: N, hd_1080p: N, ... }
    byHdr: text('by_hdr'), // JSON: { dolby_vision: N, hdr10: N, ... }
    byGenre: text('by_genre'), // JSON: { genre: count }
    byDecade: text('by_decade'), // JSON: { decade: count }
    addedThisYear: integer('added_this_year').notNull().default(0),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex('idx_trakt_collection_stats_user').on(table.userId)]
);
