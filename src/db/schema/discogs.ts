import {
  integer,
  sqliteTable,
  text,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const discogsReleases = sqliteTable(
  'discogs_releases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    discogsId: integer('discogs_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    coverUrl: text('cover_url'),
    thumbUrl: text('thumb_url'),
    discogsUrl: text('discogs_url'),
    genres: text('genres'), // JSON array
    styles: text('styles'), // JSON array
    formats: text('formats'), // JSON array
    formatDetails: text('format_details'), // JSON array of descriptions
    labels: text('labels'), // JSON array of { name, catno }
    tracklist: text('tracklist'), // JSON array
    country: text('country'),
    communityHave: integer('community_have'),
    communityWant: integer('community_want'),
    lowestPrice: real('lowest_price'),
    numForSale: integer('num_for_sale'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_discogs_releases_discogs_id').on(
      table.userId,
      table.discogsId
    ),
    index('idx_discogs_releases_year').on(table.year),
    index('idx_discogs_releases_user_id').on(table.userId),
  ]
);

export const discogsArtists = sqliteTable(
  'discogs_artists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    discogsId: integer('discogs_id').notNull(),
    name: text('name').notNull(),
    profileUrl: text('profile_url'),
    imageUrl: text('image_url'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_discogs_artists_discogs_id').on(
      table.userId,
      table.discogsId
    ),
    index('idx_discogs_artists_name').on(table.name),
    index('idx_discogs_artists_user_id').on(table.userId),
  ]
);

export const discogsCollection = sqliteTable(
  'discogs_collection',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    releaseId: integer('release_id')
      .notNull()
      .references(() => discogsReleases.id),
    instanceId: integer('instance_id').notNull(),
    folderId: integer('folder_id').notNull().default(0),
    rating: integer('rating').default(0),
    notes: text('notes'),
    dateAdded: text('date_added').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_discogs_collection_instance').on(
      table.userId,
      table.instanceId
    ),
    index('idx_discogs_collection_release').on(table.releaseId),
    index('idx_discogs_collection_date_added').on(table.dateAdded),
    index('idx_discogs_collection_user_id').on(table.userId),
  ]
);

export const discogsReleaseArtists = sqliteTable(
  'discogs_release_artists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    releaseId: integer('release_id')
      .notNull()
      .references(() => discogsReleases.id),
    artistId: integer('artist_id')
      .notNull()
      .references(() => discogsArtists.id),
  },
  (table) => [
    uniqueIndex('idx_discogs_release_artists_unique').on(
      table.releaseId,
      table.artistId
    ),
    index('idx_discogs_release_artists_artist').on(table.artistId),
  ]
);

export const discogsWantlist = sqliteTable(
  'discogs_wantlist',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    discogsId: integer('discogs_id').notNull(),
    title: text('title').notNull(),
    artists: text('artists'), // JSON array of artist names
    year: integer('year'),
    coverUrl: text('cover_url'),
    thumbUrl: text('thumb_url'),
    discogsUrl: text('discogs_url'),
    formats: text('formats'), // JSON array
    genres: text('genres'), // JSON array
    notes: text('notes'),
    rating: integer('rating').default(0),
    dateAdded: text('date_added').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_discogs_wantlist_discogs_id').on(
      table.userId,
      table.discogsId
    ),
    index('idx_discogs_wantlist_date_added').on(table.dateAdded),
    index('idx_discogs_wantlist_user_id').on(table.userId),
  ]
);

export const discogsCollectionStats = sqliteTable(
  'discogs_collection_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    totalItems: integer('total_items').notNull().default(0),
    byFormat: text('by_format'), // JSON: { vinyl, cd, cassette, other }
    wantlistCount: integer('wantlist_count').notNull().default(0),
    uniqueArtists: integer('unique_artists').notNull().default(0),
    estimatedValue: real('estimated_value'),
    topGenre: text('top_genre'),
    oldestReleaseYear: integer('oldest_release_year'),
    newestReleaseYear: integer('newest_release_year'),
    mostCollectedArtist: text('most_collected_artist'), // JSON: { name, count }
    addedThisYear: integer('added_this_year').notNull().default(0),
    byGenre: text('by_genre'), // JSON: { genre: count }
    byDecade: text('by_decade'), // JSON: { decade: count }
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex('idx_discogs_collection_stats_user').on(table.userId)]
);

export const collectionListeningXref = sqliteTable(
  'collection_listening_xref',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => discogsCollection.id),
    releaseId: integer('release_id')
      .notNull()
      .references(() => discogsReleases.id),
    lastfmAlbumName: text('lastfm_album_name'),
    lastfmArtistName: text('lastfm_artist_name'),
    playCount: integer('play_count').notNull().default(0),
    lastPlayed: text('last_played'),
    matchType: text('match_type', {
      enum: ['exact', 'fuzzy', 'artist_only', 'none'],
    })
      .notNull()
      .default('none'),
    matchConfidence: real('match_confidence').notNull().default(0),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_collection_listening_xref_unique').on(
      table.userId,
      table.collectionId
    ),
    index('idx_collection_listening_xref_release').on(table.releaseId),
    index('idx_collection_listening_xref_play_count').on(table.playCount),
    index('idx_collection_listening_xref_user_id').on(table.userId),
  ]
);
