import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from './types/env.js';
import { cors } from './lib/cors.js';
import { requireAuth } from './lib/auth.js';
import { createDb } from './db/client.js';
import { openAPIConfig, securitySchemes } from './lib/openapi.js';
import system from './routes/system.js';
import listening from './routes/listening.js';
import running from './routes/running.js';
import watching from './routes/watching.js';
import webhooks from './routes/webhooks.js';
import imagesRoute from './routes/images.js';
import collecting from './routes/collecting.js';
import feed from './routes/feed.js';
import reading from './routes/reading.js';
import search from './routes/search.js';
import exportRoute from './routes/export.js';
import keys from './routes/keys.js';
import adminSync from './routes/admin-sync.js';
import { LastfmClient } from './services/lastfm/client.js';
import { syncListening } from './services/lastfm/sync.js';
import { syncRunning } from './services/strava/sync.js';
import { syncWatching } from './services/plex/sync.js';
import { syncLetterboxd } from './services/letterboxd/sync.js';
import { syncCollecting } from './services/discogs/sync.js';
import { syncTraktCollection } from './services/trakt/sync.js';
import { syncReading } from './services/instapaper/sync.js';
import {
  processListeningImages,
  processWatchingImages,
  processCollectingImages,
} from './services/images/sync-images.js';
import { shouldRetry } from './lib/sync-retry.js';
import { shouldSkipWatchingImages } from './services/images/sync-images.js';

const app = new OpenAPIHono<{ Bindings: Env }>();

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
    path === '/v1/health/sync' ||
    path === '/v1/openapi.json'
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

const routes = app
  .basePath('/v1')
  .route('/', system)
  .route('/listening', listening)
  .route('/running', running)
  .route('/watching', watching)
  .route('/', webhooks)
  .route('/', imagesRoute)
  .route('/', collecting)
  .route('/reading', reading)
  .route('/feed', feed)
  .route('/search', search)
  .route('/admin/export', exportRoute)
  .route('/admin/keys', keys)
  .route('/', adminSync);

// Register OpenAPI security scheme
routes.openAPIRegistry.registerComponent(
  'securitySchemes',
  'bearerAuth',
  securitySchemes.bearerAuth
);

// OpenAPI spec endpoint
routes.use('/openapi.json', async (c, next) => {
  await next();
  c.header('Cache-Control', 'public, max-age=300, s-maxage=300');
});
routes.doc31('/openapi.json', openAPIConfig);

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
          syncListening(db, client, { type: 'scrobbles' })
            .then(() => processListeningImages(db, env))
            .catch((err) =>
              console.log(
                `[ERROR] Scrobble sync cron failed: ${err instanceof Error ? err.message : String(err)}`
              )
            )
        );
        break;
      }
      case '0 3 * * *': {
        const listeningRetry = await shouldRetry(db, 'listening');
        if (listeningRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed listening sync (${listeningRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Last.fm top lists + stats');
        const lastfmClient = new LastfmClient(
          env.LASTFM_API_KEY,
          env.LASTFM_USERNAME
        );
        ctx.waitUntil(
          (async () => {
            try {
              await syncListening(db, lastfmClient, { type: 'top_lists' });
              await syncListening(db, lastfmClient, { type: 'stats' });
              await processListeningImages(db, env);
            } catch (err) {
              console.log(
                `[ERROR] Last.fm daily sync failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          })()
        );
        break;
      }
      case '15 3 * * *': {
        const runningRetry = await shouldRetry(db, 'running');
        if (runningRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed running sync (${runningRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Strava activities');
        ctx.waitUntil(
          syncRunning(env, db).catch((e) =>
            console.log(`[ERROR] Strava cron sync failed: ${e}`)
          )
        );
        break;
      }
      case '30 3 * * *': {
        const watchingRetry = await shouldRetry(db, 'watching');
        if (watchingRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed watching sync (${watchingRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Plex library scan');
        ctx.waitUntil(
          (async () => {
            try {
              await syncWatching(db, env);
              await processWatchingImages(db, env);
            } catch (error) {
              console.log(
                `[ERROR] Plex sync failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          })()
        );
        break;
      }
      case '45 3 * * 0': {
        const collectingRetry = await shouldRetry(db, 'collecting');
        if (collectingRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed collecting sync (${collectingRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Discogs + Trakt collections (Sunday)');
        ctx.waitUntil(
          (async () => {
            try {
              await syncCollecting(env);
              await processCollectingImages(db, env);
            } catch (err) {
              console.log(`[ERROR] Discogs cron sync failed: ${err}`);
            }
          })()
        );
        ctx.waitUntil(
          syncTraktCollection(env).catch((err) =>
            console.log(`[ERROR] Trakt cron sync failed: ${err}`)
          )
        );
        break;
      }
      case '0 */6 * * *': {
        const letterboxdRetry = await shouldRetry(db, 'watching');
        if (letterboxdRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed watching sync (${letterboxdRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Letterboxd RSS sync');
        ctx.waitUntil(
          (async () => {
            try {
              await syncLetterboxd(db, env);
              const skip = await shouldSkipWatchingImages(db);
              if (skip) {
                console.log(
                  '[SYNC] Skipping watching image processing: Plex cron already ran it recently'
                );
              } else {
                await processWatchingImages(db, env);
              }
            } catch (error) {
              console.log(
                `[ERROR] Letterboxd sync failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          })()
        );

        // Reading sync (Instapaper)
        const readingRetry = await shouldRetry(db, 'reading');
        if (readingRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed reading sync (${readingRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Instapaper bookmarks');
        ctx.waitUntil(
          syncReading(db, env).catch((error) =>
            console.log(
              `[ERROR] Instapaper sync failed: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        );
        break;
      }
      default:
        console.log(`[SYNC] Unknown cron: ${event.cron}`);
    }
  },
};

// Export type for Hono RPC
export type AppType = typeof routes;
