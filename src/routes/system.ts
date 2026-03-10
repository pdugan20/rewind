import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import { setCache } from '../lib/cache.js';

const system = new Hono<{ Bindings: Env }>();

system.get('/health', (c) => {
  setCache(c, 'realtime');
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

system.get('/health/sync', async (c) => {
  setCache(c, 'short');
  // TODO: Query sync_runs table for last sync status per domain
  return c.json({
    status: 'ok',
    domains: {},
  });
});

export default system;
