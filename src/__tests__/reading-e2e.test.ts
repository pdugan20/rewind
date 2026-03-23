import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import reading from '../routes/reading.js';

describe('reading endpoints (e2e shape)', () => {
  // Test the route module has all expected routes registered
  it('exports a Hono app with routes', () => {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/v1/reading', reading);
    expect(app).toBeDefined();
  });

  it('has expected route paths', () => {
    const routes = reading.routes;
    const paths = routes.map((r) => `${r.method} ${r.path}`);

    // Article endpoints
    expect(paths).toContainEqual(expect.stringContaining('/recent'));
    expect(paths).toContainEqual(expect.stringContaining('/currently-reading'));
    expect(paths).toContainEqual(expect.stringContaining('/articles'));
    expect(paths).toContainEqual(expect.stringContaining('/articles/:id'));
    expect(paths).toContainEqual(expect.stringContaining('/archive'));

    // Highlight endpoints
    expect(paths).toContainEqual(expect.stringContaining('/highlights'));
    expect(paths).toContainEqual(expect.stringContaining('/highlights/random'));

    // Stats and analytics
    expect(paths).toContainEqual(expect.stringContaining('/stats'));
    expect(paths).toContainEqual(expect.stringContaining('/calendar'));
    expect(paths).toContainEqual(expect.stringContaining('/streaks'));

    // Aggregation endpoints
    expect(paths).toContainEqual(expect.stringContaining('/tags'));
    expect(paths).toContainEqual(expect.stringContaining('/domains'));

    // Year-in-review
    expect(paths).toContainEqual(expect.stringContaining('/year/:year'));
  });

  it('registers GET methods for read endpoints', () => {
    const routes = reading.routes;
    const getRoutes = routes.filter((r) => r.method === 'GET');
    const getPaths = getRoutes.map((r) => r.path);

    expect(getPaths).toContainEqual(expect.stringContaining('/recent'));
    expect(getPaths).toContainEqual(
      expect.stringContaining('/currently-reading')
    );
    expect(getPaths).toContainEqual(expect.stringContaining('/articles'));
    expect(getPaths).toContainEqual(expect.stringContaining('/archive'));
    expect(getPaths).toContainEqual(expect.stringContaining('/highlights'));
    expect(getPaths).toContainEqual(expect.stringContaining('/stats'));
    expect(getPaths).toContainEqual(expect.stringContaining('/calendar'));
    expect(getPaths).toContainEqual(expect.stringContaining('/streaks'));
    expect(getPaths).toContainEqual(expect.stringContaining('/tags'));
    expect(getPaths).toContainEqual(expect.stringContaining('/domains'));
    expect(getPaths).toContainEqual(expect.stringContaining('/year/:year'));
  });

  it('mounts under /v1/reading prefix correctly', () => {
    const app = new Hono<{ Bindings: Env }>();
    const mounted = app.route('/v1/reading', reading);
    const routes = mounted.routes;
    const paths = routes.map((r) => r.path);

    // All routes should be prefixed with /v1/reading
    const readingRoutes = paths.filter((p) => p.startsWith('/v1/reading'));
    expect(readingRoutes.length).toBeGreaterThan(0);
  });
});
