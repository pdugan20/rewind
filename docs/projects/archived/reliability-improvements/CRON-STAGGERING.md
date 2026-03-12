# Cron Staggering -- Design Notes

## Problem

The daily `0 3 * * *` cron fires Last.fm, Strava, Plex, and (Sundays) Discogs + Trakt all in parallel via separate `ctx.waitUntil()` calls. D1 has a single-writer model -- concurrent writes serialize and can cause lock contention or timeouts.

## Current Schedule

```text
*/15 * * * *   Last.fm scrobbles (every 15 min)
0 3 * * *      Last.fm top lists + Strava + Plex + Discogs/Trakt (all at once)
0 */6 * * *    Letterboxd RSS (every 6 hours)
```

## Proposed Schedule

```text
*/15 * * * *   Last.fm scrobbles (unchanged)
0 3 * * *      Last.fm top lists + stats
15 3 * * *     Strava
30 3 * * *     Plex library scan
45 3 * * 0     Discogs + Trakt (Sundays only)
0 */6 * * *    Letterboxd RSS (unchanged)
```

## Implementation

Each cron expression gets its own `case` in the switch statement. The handler for each is simpler (single domain) and runs image processing inline after sync completes.

## Retry Logic

Add to each cron handler:

```text
before running scheduled sync:
  check last sync_run for this domain
  if status = 'failed' AND retryCount < 2:
    log "[SYNC] Retrying failed {domain} sync"
    run sync with retryCount + 1
  else:
    run normal scheduled sync
```

The `retryCount` column prevents infinite loops if a sync is persistently failing (e.g., API is down for days).
