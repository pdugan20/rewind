import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { syncRuns } from '../../db/schema/system.js';

// syncToken persistence for Calendar incremental pulls. We piggy-back on
// the existing `sync_runs` table — write a row with domain='attending'
// and sync_type='calendar_sync_token', metadata = JSON.stringify({ token }).
//
// Reading: latest such row, by startedAt desc.
// Writing: insert a new row each refresh; we never UPDATE so the history
// is preserved (cheap + helps debug "when did the token last rotate").

const DOMAIN = 'attending';
const SYNC_TYPE = 'calendar_sync_token';

export async function readCalendarSyncToken(
  db: Database
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.domain, DOMAIN), eq(syncRuns.syncType, SYNC_TYPE)))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  if (!row?.metadata) return null;
  try {
    const parsed = JSON.parse(row.metadata) as { token?: string };
    return parsed.token ?? null;
  } catch {
    return null;
  }
}

export async function writeCalendarSyncToken(
  db: Database,
  token: string
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(syncRuns).values({
    userId: 1,
    domain: DOMAIN,
    syncType: SYNC_TYPE,
    status: 'completed',
    startedAt: now,
    completedAt: now,
    itemsSynced: 0,
    metadata: JSON.stringify({ token }),
  });
}
