import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import listening from '../routes/listening.js';

describe('listening endpoints (e2e shape)', () => {
  // Test the route module has all expected routes registered
  it('exports a Hono app with routes', () => {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/v1/listening', listening);
    expect(app).toBeDefined();
  });

  it('has expected route paths', () => {
    const routes = listening.routes;
    const paths = routes.map((r) => `${r.method} ${r.path}`);

    expect(paths).toContainEqual(expect.stringContaining('/now-playing'));
    expect(paths).toContainEqual(expect.stringContaining('/recent'));
    expect(paths).toContainEqual(expect.stringContaining('/top/artists'));
    expect(paths).toContainEqual(expect.stringContaining('/top/albums'));
    expect(paths).toContainEqual(expect.stringContaining('/top/tracks'));
    expect(paths).toContainEqual(expect.stringContaining('/stats'));
    expect(paths).toContainEqual(expect.stringContaining('/history'));
    expect(paths).toContainEqual(expect.stringContaining('/artists/:id'));
    expect(paths).toContainEqual(expect.stringContaining('/albums/:id'));
    expect(paths).toContainEqual(expect.stringContaining('/calendar'));
    expect(paths).toContainEqual(expect.stringContaining('/trends'));
    expect(paths).toContainEqual(expect.stringContaining('/streaks'));
    expect(paths).toContainEqual(expect.stringContaining('/admin/sync'));
  });
});
