/**
 * Output-schema conformance — watching domain (issue #105, Phase 2).
 *
 * For every watching tool: run it end-to-end through the SDK against a
 * fixture and assert it resolves. The SDK's validateToolOutput throws if
 * `structuredContent` does not match the declared `outputSchema`, so a
 * resolved call IS the conformance proof. Also asserts each tool
 * advertises a clean JSON Schema (top-level object, no $ref, no
 * `additionalProperties: false`).
 *
 * Copied from the output-schema-listening.test.ts template.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

// --- Fixtures (minimal valid API responses) -------------------------------

const recentWatchFixture = {
  movie: {
    id: 1,
    title: 'Test Movie',
    year: 2024,
    director: 'Test Director',
    tmdb_id: 100,
    summary: 'A test movie.',
    tagline: 'A test tagline.',
    image: null,
  },
  watched_at: '2026-05-15T12:00:00Z',
  user_rating: 4,
  rewatch: false,
  source: 'plex',
  review: null,
  review_url: null,
};

const movieDetailFixture = {
  id: 1,
  title: 'Test Movie',
  year: 2024,
  director: 'Test Director',
  directors: ['Test Director'],
  genres: ['Drama'],
  duration_min: 120,
  rating: 'PG-13',
  tmdb_id: 100,
  tmdb_rating: 7.5,
  tagline: 'A test tagline.',
  summary: 'A test movie.',
  imdb_id: 'tt1234567',
  image: null,
  watch_history: [
    {
      watched_at: '2026-05-15T12:00:00Z',
      user_rating: 4,
      rewatch: false,
      review: null,
      review_url: null,
      source: 'plex',
    },
  ],
};

const browseMovieFixture = {
  id: 1,
  title: 'Test Movie',
  year: 2024,
  director: 'Test Director',
  genres: ['Drama'],
  duration_min: 120,
  tmdb_id: 100,
  tmdb_rating: 7.5,
  image: null,
};

const paginationFixture = {
  page: 1,
  limit: 10,
  total: 1,
  total_pages: 1,
};

const ROUTES: Record<string, unknown> = {
  '/watching/recent': { data: [recentWatchFixture] },
  '/watching/stats': {
    data: {
      total_movies: 100,
      total_watch_time_hours: 200,
      movies_this_year: 12,
      avg_per_month: 8.3,
      top_genre: 'Drama',
      top_decade: 2010,
      top_director: 'Test Director',
      total_shows: 5,
      total_episodes_watched: 60,
      episodes_this_year: 20,
    },
  },
  '/watching/movies': {
    data: [browseMovieFixture],
    pagination: paginationFixture,
  },
  '/watching/stats/genres': {
    data: [{ name: 'Drama', count: 40, percentage: 40 }],
  },
  '/watching/stats/decades': { data: [{ decade: 2010, count: 30 }] },
  '/watching/stats/directors': {
    data: [{ name: 'Test Director', count: 8 }],
  },
};

function resolveRoute(path: string): unknown {
  if (path.startsWith('/watching/movies/')) return movieDetailFixture;
  return ROUTES[path] ?? {};
}

async function buildClient(): Promise<Client> {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) =>
    resolveRoute(path)
  );
  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'output-schema-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const CASES: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'get_recent_watches', args: { include_images: false } },
  { name: 'get_movie_details', args: { id: 1, include_images: false } },
  { name: 'get_watching_stats', args: {} },
  { name: 'browse_movies', args: { include_images: false } },
  { name: 'get_watching_genres', args: {} },
  { name: 'get_watching_decades', args: {} },
  { name: 'get_watching_directors', args: {} },
];

describe('output-schema conformance — watching', () => {
  for (const c of CASES) {
    it(`${c.name}: structuredContent conforms to outputSchema`, async () => {
      const client = await buildClient();
      // A schema mismatch makes the SDK's validateToolOutput throw and this
      // call reject -- resolving without error IS the conformance check.
      const res = await client.callTool({ name: c.name, arguments: c.args });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toBeDefined();
    });
  }

  it('empty-state branches still conform', async () => {
    const rewindClient = new RewindClient('https://api.test', 'rw_test');
    vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) => {
      if (path === '/watching/recent') return { data: [] };
      if (path === '/watching/movies')
        return { data: [], pagination: paginationFixture };
      if (path === '/watching/stats/genres') return { data: [] };
      if (path === '/watching/stats/decades') return { data: [] };
      if (path === '/watching/stats/directors') return { data: [] };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    for (const [name, args] of [
      ['get_recent_watches', { include_images: false }],
      ['browse_movies', { include_images: false }],
      ['get_watching_genres', {}],
      ['get_watching_decades', {}],
      ['get_watching_directors', {}],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
  });

  it('every watching tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const watching = tools.filter((t) => names.has(t.name));
    expect(watching).toHaveLength(CASES.length);

    for (const t of watching) {
      expect(t.outputSchema, t.name).toMatchObject({ type: 'object' });
      const json = JSON.stringify(t.outputSchema);
      // No $ref/$defs: older Claude Desktop builds failed to compile them.
      expect(json, `${t.name} $ref`).not.toContain('$ref');
      // .passthrough() keeps the advertised schema forward-compatible.
      expect(json, `${t.name} additionalProperties`).not.toContain(
        '"additionalProperties":false'
      );
    }
  });
});
