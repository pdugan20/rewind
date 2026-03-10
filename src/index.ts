import { Hono } from 'hono';
import type { Env } from './types/env.js';
import { cors } from './lib/cors.js';
import { requireAuth } from './lib/auth.js';
import { createDb } from './db/client.js';
import system from './routes/system.js';
import listening from './routes/listening.js';
import running from './routes/running.js';
import watching from './routes/watching.js';
import webhooks from './routes/webhooks.js';
import { LastfmClient } from './services/lastfm/client.js';
import { syncListening } from './services/lastfm/sync.js';
import { syncRunning } from './services/strava/sync.js';
import { syncWatching } from './services/plex/sync.js';
import { syncLetterboxd } from './services/letterboxd/sync.js';

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', async (c, next) => {
  const corsMiddleware = cors(c.env);
  return corsMiddleware(c, next);
});

// Auth for GET endpoints under /v1/ (read key required)
app.use('/v1/*', async (c, next) => {
  // Skip auth for webhook endpoints and health
  const path = c.req.path;
  if (
    path.startsWith('/v1/webhooks/') ||
    path === '/v1/health' ||
    path === '/v1/health/sync'
  ) {
    return next();
  }

  // Admin endpoints require admin auth
  if (path.startsWith('/v1/admin/')) {
    const authMiddleware = requireAuth('admin');
    return authMiddleware(c, next);
  }

  // All other endpoints require read auth
  const authMiddleware = requireAuth('read');
  return authMiddleware(c, next);
});

// Route registration
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used for AppType export
const routes = app
  .basePath('/v1')
  .route('/', system)
  .route('/listening', listening)
  .route('/running', running)
  .route('/watching', watching)
  .route('/', webhooks);

// Cron handler
export default {
  fetch: app.fetch,
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    console.log(`[SYNC] Cron triggered: ${event.cron}`);
    const db = createDb(env.DB);

    switch (event.cron) {
      case '*/15 * * * *': {
        console.log('[SYNC] Last.fm scrobble sync');
        const client = new LastfmClient(
          env.LASTFM_API_KEY,
          env.LASTFM_USERNAME
        );
        ctx.waitUntil(
          syncListening(db, client, { type: 'scrobbles' }).catch((err) =>
            console.log(
              `[ERROR] Scrobble sync cron failed: ${err instanceof Error ? err.message : String(err)}`
            )
          )
        );
        break;
      }
      case '0 3 * * *': {
        console.log(
          '[SYNC] Daily sync: Last.fm top lists, Strava, Plex, Discogs (Sunday)'
        );
        const lastfmClient = new LastfmClient(
          env.LASTFM_API_KEY,
          env.LASTFM_USERNAME
        );
        // Last.fm top lists + stats
        ctx.waitUntil(
          (async () => {
            try {
              await syncListening(db, lastfmClient, { type: 'top_lists' });
              await syncListening(db, lastfmClient, { type: 'stats' });
            } catch (err) {
              console.log(
                `[ERROR] Last.fm daily sync failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          })()
        );
        // Strava sync
        ctx.waitUntil(
          syncRunning(env, db).catch((e) =>
            console.log(`[ERROR] Strava cron sync failed: ${e}`)
          )
        );
        // Plex library sync
        ctx.waitUntil(
          syncWatching(db, env).catch((error) => {
            console.log(
              `[ERROR] Plex sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
          })
        );
        break;
      }
      case '0 */6 * * *':
        console.log('[SYNC] Letterboxd RSS sync');
        ctx.waitUntil(
          syncLetterboxd(db, env).catch((error) => {
            console.log(
              `[ERROR] Letterboxd sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
          })
        );
        break;
      default:
        console.log(`[SYNC] Unknown cron: ${event.cron}`);
    }
  },
};

// Export type for Hono RPC
export type AppType = typeof routes;
