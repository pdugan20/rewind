import { desc, eq, and } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { syncRuns } from '../db/schema/system.js';

const MAX_RETRIES = 2;

interface RetryResult {
  shouldRetry: boolean;
  consecutiveFailures: number;
}

/**
 * Check if the most recent sync run for a domain failed and should be retried.
 * Counts consecutive failures to prevent infinite retry loops (max 2 retries).
 * Returns shouldRetry=true only if consecutive failures <= MAX_RETRIES.
 */
export async function shouldRetry(
  db: Database,
  domain: string
): Promise<RetryResult> {
  const recentRuns = await db
    .select({
      status: syncRuns.status,
    })
    .from(syncRuns)
    .where(and(eq(syncRuns.domain, domain), eq(syncRuns.userId, 1)))
    .orderBy(desc(syncRuns.startedAt))
    .limit(MAX_RETRIES + 1);

  if (recentRuns.length === 0 || recentRuns[0].status !== 'failed') {
    return { shouldRetry: false, consecutiveFailures: 0 };
  }

  let consecutiveFailures = 0;
  for (const run of recentRuns) {
    if (run.status === 'failed') {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  return {
    shouldRetry: consecutiveFailures <= MAX_RETRIES,
    consecutiveFailures,
  };
}
