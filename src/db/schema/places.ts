import {
  integer,
  real,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Foursquare/Swarm check-ins. The unique foursquare_id makes the
 * oldest-first offset walk idempotent: an interrupted batch resumes from
 * COUNT(checkins) and any overlap deduplicates on conflict.
 */
export const checkins = sqliteTable(
  'checkins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    foursquareId: text('foursquare_id').notNull(),
    venueId: text('venue_id'),
    venueName: text('venue_name').notNull(),
    venueCategory: text('venue_category'),
    venueCity: text('venue_city'),
    venueState: text('venue_state'),
    venueCountry: text('venue_country'),
    lat: real('lat'),
    lng: real('lng'),
    checkedInAt: text('checked_in_at').notNull(),
    shout: text('shout'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_checkins_foursquare_id').on(table.foursquareId),
    index('idx_checkins_user_id').on(table.userId),
    index('idx_checkins_checked_in_at').on(table.checkedInAt),
    index('idx_checkins_timeline').on(table.userId, table.checkedInAt),
    index('idx_checkins_venue_id').on(table.venueId),
  ]
);
