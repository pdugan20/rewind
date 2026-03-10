import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import watching from '../routes/watching.js';

describe('watching endpoints (e2e shape)', () => {
  // Test the route module has all expected routes registered
  it('exports a Hono app with routes', () => {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/v1/watching', watching);
    expect(app).toBeDefined();
  });

  it('has expected route paths', () => {
    const routes = watching.routes;
    const paths = routes.map((r) => `${r.method} ${r.path}`);

    // Movie endpoints
    expect(paths).toContainEqual(expect.stringContaining('/recent'));
    expect(paths).toContainEqual(expect.stringContaining('/movies'));
    expect(paths).toContainEqual(expect.stringContaining('/movies/:id'));

    // Stats endpoints
    expect(paths).toContainEqual(expect.stringContaining('/stats'));
    expect(paths).toContainEqual(expect.stringContaining('/stats/genres'));
    expect(paths).toContainEqual(expect.stringContaining('/stats/decades'));
    expect(paths).toContainEqual(expect.stringContaining('/stats/directors'));

    // Calendar and trends
    expect(paths).toContainEqual(expect.stringContaining('/calendar'));
    expect(paths).toContainEqual(expect.stringContaining('/trends'));

    // TV show endpoints
    expect(paths).toContainEqual(expect.stringContaining('/shows'));
    expect(paths).toContainEqual(expect.stringContaining('/shows/:id'));
    expect(paths).toContainEqual(
      expect.stringContaining('/shows/:id/seasons/:season')
    );

    // Admin endpoints
    expect(paths).toContainEqual(
      expect.stringContaining('/admin/sync/watching')
    );
    expect(paths).toContainEqual(
      expect.stringContaining('/admin/watching/movies')
    );
    expect(paths).toContainEqual(
      expect.stringContaining('/admin/watching/movies/:id')
    );
  });

  it('registers GET methods for read endpoints', () => {
    const routes = watching.routes;
    const getRoutes = routes.filter((r) => r.method === 'GET');
    const getPaths = getRoutes.map((r) => r.path);

    expect(getPaths).toContainEqual(expect.stringContaining('/recent'));
    expect(getPaths).toContainEqual(expect.stringContaining('/movies'));
    expect(getPaths).toContainEqual(expect.stringContaining('/stats'));
    expect(getPaths).toContainEqual(expect.stringContaining('/shows'));
    expect(getPaths).toContainEqual(expect.stringContaining('/calendar'));
    expect(getPaths).toContainEqual(expect.stringContaining('/trends'));
  });

  it('registers POST methods for admin endpoints', () => {
    const routes = watching.routes;
    const postRoutes = routes.filter((r) => r.method === 'POST');
    const postPaths = postRoutes.map((r) => r.path);

    expect(postPaths).toContainEqual(
      expect.stringContaining('/admin/sync/watching')
    );
    expect(postPaths).toContainEqual(
      expect.stringContaining('/admin/watching/movies')
    );
  });

  it('registers PUT method for edit endpoint', () => {
    const routes = watching.routes;
    const putRoutes = routes.filter((r) => r.method === 'PUT');
    const putPaths = putRoutes.map((r) => r.path);

    expect(putPaths).toContainEqual(
      expect.stringContaining('/admin/watching/movies/:id')
    );
  });

  it('registers DELETE method for delete endpoint', () => {
    const routes = watching.routes;
    const deleteRoutes = routes.filter((r) => r.method === 'DELETE');
    const deletePaths = deleteRoutes.map((r) => r.path);

    expect(deletePaths).toContainEqual(
      expect.stringContaining('/admin/watching/movies/:id')
    );
  });

  it('mounts under /v1/watching prefix correctly', () => {
    const app = new Hono<{ Bindings: Env }>();
    const mounted = app.route('/v1/watching', watching);
    const routes = mounted.routes;
    const paths = routes.map((r) => r.path);

    // All routes should be prefixed with /v1/watching
    const watchingRoutes = paths.filter((p) => p.startsWith('/v1/watching'));
    expect(watchingRoutes.length).toBeGreaterThan(0);
  });
});
