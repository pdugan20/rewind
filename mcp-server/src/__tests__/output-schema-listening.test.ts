/**
 * Output-schema conformance — listening domain (issue #105, Phase 1).
 *
 * For every listening tool: run it end-to-end through the SDK against a
 * fixture and assert it resolves. The SDK's validateToolOutput throws if
 * `structuredContent` does not match the declared `outputSchema`, so a
 * resolved call IS the conformance proof. Also asserts each tool
 * advertises a clean JSON Schema (top-level object, no $ref, no
 * `additionalProperties: false`).
 *
 * This file is the template the other domains' conformance tests copy.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

// --- Fixtures (minimal valid API responses) -------------------------------

const scrobbleFixture = {
  track: {
    id: 1,
    name: 'Test Song',
    url: null,
    apple_music_url: null,
    preview_url: null,
  },
  artist: { id: 2, name: 'Test Artist' },
  album: { id: 3, name: 'Test Album', image: null },
  scrobbled_at: '2026-05-15T12:00:00Z',
};

const topItemFixture = {
  rank: 1,
  id: 1,
  name: 'Test Item',
  detail: 'Test detail',
  playcount: 10,
  image: null,
  url: 'https://last.fm/x',
  apple_music_url: null,
};

const artistDetailFixture = {
  id: 1,
  name: 'Test Artist',
  mbid: null,
  url: null,
  apple_music_url: null,
  playcount: 100,
  scrobble_count: 100,
  first_scrobbled_at: '2020-01-01',
  last_played_at: '2026-05-15',
  all_time_rank: 5,
  distinct_tracks: 20,
  distinct_albums: 4,
  genre: 'rock',
  tags: [{ name: 'rock', count: 50 }],
  bio_summary: 'A band.',
  bio_content: 'A longer bio.',
  bio_synced_at: null,
  image: null,
  sparkline: { granularity: 'month', points: [{ at: '2026-01', count: 10 }] },
  top_albums: [
    { id: 2, name: 'Album', playcount: 30, apple_music_url: null, image: null },
  ],
  top_tracks: [
    {
      id: 3,
      name: 'Track',
      album_id: 2,
      album_name: 'Album',
      scrobble_count: 15,
      apple_music_url: null,
      preview_url: null,
      image: null,
    },
  ],
  similar_artists: [
    {
      id: 4,
      name: 'Similar',
      your_scrobble_count: 8,
      similarity_score: 0.9,
      image: null,
    },
  ],
};

const albumDetailFixture = {
  id: 1,
  name: 'Album',
  mbid: null,
  url: null,
  apple_music_url: null,
  playcount: 50,
  image: null,
  artist: { id: 2, name: 'Artist' },
  tracks: [
    {
      id: 3,
      name: 'Track',
      scrobble_count: 10,
      apple_music_url: null,
      preview_url: null,
    },
  ],
};

const ROUTES: Record<string, unknown> = {
  '/listening/now-playing': {
    is_playing: true,
    track: {
      name: 'Test Song',
      artist: { id: 1, name: 'Test Artist', apple_music_url: null },
      album: { id: 2, name: 'Test Album', image: null },
      url: null,
      apple_music_url: null,
      preview_url: null,
    },
    scrobbled_at: '2026-05-15T12:00:00Z',
  },
  '/listening/recent': { data: [scrobbleFixture] },
  '/listening/stats': {
    total_scrobbles: 100,
    unique_artists: 10,
    unique_albums: 20,
    unique_tracks: 50,
    registered_date: '2010-01-01',
    years_tracking: 16,
    scrobbles_per_day: 1.5,
  },
  '/listening/top/artists': { period: '1month', data: [topItemFixture] },
  '/listening/top/albums': { period: '1month', data: [topItemFixture] },
  '/listening/top/tracks': {
    period: '1month',
    artist_id: null,
    data: [topItemFixture],
  },
  '/listening/streaks': {
    current: { days: 5, start_date: '2026-05-10', total_scrobbles: 50 },
    longest: {
      days: 30,
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      total_scrobbles: 300,
    },
  },
  '/listening/genres': {
    data: [{ period: '2026-05', genres: { rock: 10 }, total: 10 }],
  },
};

function resolveRoute(path: string): unknown {
  if (path.startsWith('/listening/artists/')) return artistDetailFixture;
  if (path.startsWith('/listening/albums/')) return albumDetailFixture;
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
  { name: 'get_now_playing', args: { include_images: false } },
  { name: 'get_recent_listens', args: { include_images: false } },
  { name: 'get_listening_stats', args: {} },
  {
    name: 'get_top_artists',
    args: { include_images: false, include_sparklines: false },
  },
  { name: 'get_top_albums', args: { include_images: false } },
  { name: 'get_top_tracks', args: {} },
  { name: 'get_listening_streaks', args: {} },
  { name: 'get_artist_details', args: { id: 1, include_images: false } },
  { name: 'get_album_details', args: { id: 1, include_images: false } },
  { name: 'get_listening_genres', args: {} },
];

describe('output-schema conformance — listening', () => {
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
      if (path === '/listening/now-playing')
        return { is_playing: false, track: null, scrobbled_at: null };
      if (path === '/listening/recent') return { data: [] };
      if (path === '/listening/top/artists')
        return { period: '1month', data: [] };
      if (path === '/listening/genres') return { data: [] };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    for (const [name, args] of [
      ['get_now_playing', { include_images: false }],
      ['get_recent_listens', { include_images: false }],
      ['get_top_artists', { include_images: false, include_sparklines: false }],
      ['get_listening_genres', {}],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
  });

  it('every listening tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const listening = tools.filter((t) => names.has(t.name));
    expect(listening).toHaveLength(CASES.length);

    for (const t of listening) {
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
