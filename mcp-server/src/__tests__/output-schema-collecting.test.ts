/**
 * Output-schema conformance — collecting domain (issue #105).
 *
 * For every collecting tool: run it end-to-end through the SDK against a
 * fixture and assert it resolves. The SDK's validateToolOutput throws if
 * `structuredContent` does not match the declared `outputSchema`, so a
 * resolved call IS the conformance proof. Also asserts each tool
 * advertises a clean JSON Schema (top-level object, no $ref, no
 * `additionalProperties: false`).
 *
 * Structure mirrors output-schema-listening.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

// --- Fixtures (minimal valid API responses) -------------------------------

const paginationFixture = {
  page: 1,
  limit: 10,
  total: 1,
  total_pages: 1,
};

const vinylItemFixture = {
  id: 1,
  discogs_id: 12345,
  title: 'Test Album',
  artists: ['Test Artist'],
  year: 1999,
  format: 'Vinyl',
  format_detail: 'LP, Album',
  label: 'Test Label',
  genres: ['Rock'],
  styles: ['Indie Rock'],
  image: null,
  date_added: '2026-05-01T00:00:00Z',
  rating: 5,
  discogs_url: 'https://discogs.com/release/12345',
};

const mediaItemFixture = {
  id: 1,
  title: 'Test Movie',
  year: 2001,
  tmdb_id: 678,
  imdb_id: 'tt0000001',
  image: null,
  runtime: 120,
  tmdb_rating: 8.1,
  media_type: 'bluray',
  resolution: '1080p',
  hdr: null,
  audio: 'DTS-HD MA',
  audio_channels: '5.1',
  collected_at: '2026-05-01T00:00:00Z',
};

const ROUTES: Record<string, unknown> = {
  '/collecting/vinyl': {
    data: [vinylItemFixture],
    pagination: paginationFixture,
  },
  '/collecting/stats': {
    data: {
      total_items: 100,
      by_format: { Vinyl: 80, CD: 20 },
      wantlist_count: 5,
      unique_artists: 40,
      estimated_value: 1500,
      top_genre: 'Rock',
      oldest_release_year: 1965,
      newest_release_year: 2026,
      most_collected_artist: { name: 'Test Artist', count: 8 },
      added_this_year: 12,
    },
  },
  '/collecting/media': {
    data: [mediaItemFixture],
    pagination: paginationFixture,
  },
  '/collecting/media/formats': {
    data: [
      { name: 'bluray', count: 30 },
      { name: 'uhd_bluray', count: 12 },
    ],
  },
};

function resolveRoute(path: string): unknown {
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
  { name: 'get_vinyl_collection', args: { include_images: false } },
  { name: 'get_collecting_stats', args: {} },
  { name: 'get_physical_media', args: { include_images: false } },
  { name: 'get_physical_media_stats', args: {} },
];

describe('output-schema conformance — collecting', () => {
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
      if (path === '/collecting/vinyl')
        return { data: [], pagination: paginationFixture };
      if (path === '/collecting/media')
        return { data: [], pagination: paginationFixture };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    for (const [name, args] of [
      ['get_vinyl_collection', { include_images: false }],
      ['get_physical_media', { include_images: false }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
  });

  it('every collecting tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const collecting = tools.filter((t) => names.has(t.name));
    expect(collecting).toHaveLength(CASES.length);

    for (const t of collecting) {
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
