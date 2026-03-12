import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: text('key_prefix').notNull(),
    keyHint: text('key_hint').notNull(),
    name: text('name').notNull(),
    scope: text('scope', { enum: ['read', 'admin'] })
      .notNull()
      .default('read'),
    rateLimitRpm: integer('rate_limit_rpm').notNull().default(60),
    lastUsedAt: text('last_used_at'),
    requestCount: integer('request_count').notNull().default(0),
    expiresAt: text('expires_at'),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_api_keys_key_hash').on(table.keyHash),
    index('idx_api_keys_user_id').on(table.userId),
  ]
);

export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    domain: text('domain').notNull(),
    syncType: text('sync_type').notNull(),
    status: text('status', {
      enum: ['running', 'completed', 'failed'],
    }).notNull(),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    itemsSynced: integer('items_synced').default(0),
    error: text('error'),
    metadata: text('metadata'),
  },
  (table) => [
    index('idx_sync_runs_domain').on(table.domain),
    index('idx_sync_runs_started_at').on(table.startedAt),
    index('idx_sync_runs_user_id').on(table.userId),
  ]
);

export const activityFeed = sqliteTable(
  'activity_feed',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    domain: text('domain').notNull(),
    eventType: text('event_type').notNull(),
    occurredAt: text('occurred_at').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    imageKey: text('image_key'),
    sourceId: text('source_id').notNull(),
    metadata: text('metadata'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_activity_feed_domain').on(table.domain),
    index('idx_activity_feed_occurred_at').on(table.occurredAt),
    index('idx_activity_feed_event_type').on(table.eventType),
    index('idx_activity_feed_user_id').on(table.userId),
  ]
);

export const images = sqliteTable(
  'images',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    domain: text('domain').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    r2Key: text('r2_key').notNull(),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    width: integer('width'),
    height: integer('height'),
    thumbhash: text('thumbhash'),
    dominantColor: text('dominant_color'),
    accentColor: text('accent_color'),
    isOverride: integer('is_override').notNull().default(0),
    overrideAt: text('override_at'),
    imageVersion: integer('image_version').notNull().default(1),
    searchHints: text('search_hints'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_images_unique').on(
      table.domain,
      table.entityType,
      table.entityId
    ),
    index('idx_images_domain').on(table.domain),
    index('idx_images_entity').on(table.entityType, table.entityId),
    index('idx_images_user_id').on(table.userId),
  ]
);

export const webhookEvents = sqliteTable(
  'webhook_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    eventSource: text('event_source').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type'),
    processedAt: text('processed_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_webhook_events_unique').on(
      table.eventSource,
      table.eventId
    ),
    index('idx_webhook_events_source').on(table.eventSource),
    index('idx_webhook_events_user_id').on(table.userId),
  ]
);

export const revalidationHooks = sqliteTable(
  'revalidation_hooks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    url: text('url').notNull(),
    domain: text('domain').notNull(),
    secret: text('secret').notNull(),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_revalidation_hooks_user_id').on(table.userId)]
);
