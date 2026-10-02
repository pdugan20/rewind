import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// One atomically published pair per owner. The lease fences overlapping cron
// invocations; pending artwork and source data never enter the HTTP response.
export const latelySnapshots = sqliteTable('lately_snapshots', {
  userId: integer('user_id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  snapshot: text('snapshot'),
  pending: text('pending'),
  policy: text('policy').notNull().default(''),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
  lastStartedAt: integer('last_started_at').notNull().default(0),
});
