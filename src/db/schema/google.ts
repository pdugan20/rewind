import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

// OAuth refresh-token storage for the personal Google account that backs
// the attending domain's Calendar + Gmail extractors. Mirrors trakt_tokens
// and strava_tokens. Worker only ever does refresh; one-shot
// scripts/tools/setup-google.ts seeds the row from a laptop browser flow.
//
// IMPORTANT: the OAuth consent screen must be in "In production" status
// before relying on the cron, otherwise refresh_token expires after 7 days.
// For personal-use apps under 100 users, "In production" is reachable
// without verification — Google shows an "unverified app" warning that
// the user clicks through during setup.
export const googleTokens = sqliteTable(
  'google_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    expiresAt: integer('expires_at').notNull(), // epoch seconds
    scopes: text('scopes').notNull(), // space-separated; verified on each refresh
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_google_tokens_user_id').on(table.userId)]
);
