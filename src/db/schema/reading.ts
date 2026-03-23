import {
  integer,
  real,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const readingItems = sqliteTable(
  'reading_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    itemType: text('item_type').notNull().default('article'),
    source: text('source').notNull().default('instapaper'),
    sourceId: text('source_id').notNull(),

    // Core metadata
    url: text('url'),
    title: text('title').notNull(),
    author: text('author'),
    description: text('description'),

    // Article-specific
    domain: text('domain'),
    siteName: text('site_name'),
    content: text('content'),
    wordCount: integer('word_count'),
    estimatedReadMin: integer('estimated_read_min'),

    // Book-specific (future)
    isbn: text('isbn'),
    pageCount: integer('page_count'),
    publisher: text('publisher'),
    publishedYear: integer('published_year'),

    // Status & progress
    status: text('status').notNull().default('unread'),
    progress: real('progress').notNull().default(0.0),
    progressUpdatedAt: text('progress_updated_at'),
    starred: integer('starred').notNull().default(0),
    rating: integer('rating'),

    // Organization
    folder: text('folder'),
    tags: text('tags'),

    // Timestamps
    savedAt: text('saved_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_reading_items_source_unique').on(
      table.source,
      table.sourceId,
      table.userId
    ),
    index('idx_reading_items_user_status').on(table.userId, table.status),
    index('idx_reading_items_user_type').on(table.userId, table.itemType),
    index('idx_reading_items_saved_at').on(table.savedAt),
    index('idx_reading_items_finished_at').on(table.finishedAt),
    index('idx_reading_items_domain').on(table.domain),
    index('idx_reading_items_source').on(table.source, table.sourceId),
  ]
);

export const readingHighlights = sqliteTable(
  'reading_highlights',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    itemId: integer('item_id')
      .notNull()
      .references(() => readingItems.id, { onDelete: 'cascade' }),
    sourceId: text('source_id'),
    text: text('text').notNull(),
    note: text('note'),
    position: integer('position').default(0),
    chapter: text('chapter'),
    page: integer('page'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_reading_highlights_source_unique').on(
      table.sourceId,
      table.userId
    ),
    index('idx_reading_highlights_item').on(table.itemId),
    index('idx_reading_highlights_user').on(table.userId),
    index('idx_reading_highlights_created').on(table.createdAt),
  ]
);
