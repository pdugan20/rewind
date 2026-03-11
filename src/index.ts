import { Hono } from 'hono';
import type { Env } from './types/env.js';
import { cors } from './lib/cors.js';
import { requireAuth } from './lib/auth.js';
import system from './routes/system.js';
import imagesRoute from './routes/images.js';

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', async (c, next) => {
  const corsMiddleware = cors(c.env);
  return corsMiddleware(c, next);
});

// Admin endpoints require auth
app.use('/v1/admin/*', requireAuth('admin'));

// Route registration
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used for AppType export
const routes = app.basePath('/v1').route('/', system).route('/', imagesRoute);

// Cron handler
export default {
  fetch: app.fetch,
  async scheduled(
    event: ScheduledEvent,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(`[SYNC] Cron triggered: ${event.cron}`);

    switch (event.cron) {
      case '*/15 * * * *':
        console.log('[SYNC] Last.fm scrobble sync');
        break;
      case '0 3 * * *':
        console.log(
          '[SYNC] Daily sync: Last.fm top lists, Strava, Plex, Discogs (Sunday)'
        );
        break;
      case '0 */6 * * *':
        console.log('[SYNC] Letterboxd RSS sync');
        break;
      default:
        console.log(`[SYNC] Unknown cron: ${event.cron}`);
    }
  },
};

// Export type for Hono RPC
export type AppType = typeof routes;
