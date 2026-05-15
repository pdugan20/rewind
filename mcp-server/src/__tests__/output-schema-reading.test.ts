/**
 * Output-schema conformance — reading domain (issue #105).
 *
 * For every reading tool: run it end-to-end through the SDK against a
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

const articleFixture = {
  id: 1,
  title: 'Test Article',
  author: 'Test Author',
  url: 'https://example.com/article',
  instapaper_url: 'https://instapaper.com/read/1',
  instapaper_app_url: null,
  domain: 'example.com',
  description: 'A test article description.',
  estimated_read_min: 5,
  status: 'unread',
  progress: 0,
  image: null,
  saved_at: '2026-05-15T12:00:00Z',
};

const highlightFixture = {
  text: 'A highlighted passage.',
  note: 'My note.',
  created_at: '2026-05-15T12:00:00Z',
  article: {
    id: 1,
    title: 'Test Article',
    author: 'Test Author',
    domain: 'example.com',
    url: 'https://example.com/article',
    instapaper_url: 'https://instapaper.com/read/1',
    instapaper_app_url: null,
  },
};

const articleDetailFixture = {
  id: 1,
  title: 'Test Article',
  author: 'Test Author',
  url: 'https://example.com/article',
  instapaper_url: 'https://instapaper.com/read/1',
  instapaper_app_url: null,
  domain: 'example.com',
  description: 'A test article description.',
  content: 'The full article body text.',
  excerpt: 'An excerpt.',
  word_count: 1200,
  estimated_read_min: 5,
  status: 'unread',
  progress: 0,
  saved_at: '2026-05-15T12:00:00Z',
  image: null,
  highlights: [
    {
      id: 10,
      text: 'A highlighted passage.',
      note: 'My note.',
      created_at: '2026-05-15T12:00:00Z',
    },
  ],
};

const relatedFixture = {
  id: 2,
  title: 'Related Article',
  author: 'Other Author',
  url: 'https://example.com/related',
  instapaper_url: 'https://instapaper.com/read/2',
  instapaper_app_url: null,
  domain: 'example.com',
  description: 'A related article.',
  score: 0.87,
};

const ROUTES: Record<string, unknown> = {
  '/reading/recent': { data: [articleFixture] },
  '/reading/highlights': {
    data: [highlightFixture],
    pagination: { page: 1, limit: 10, total: 1, total_pages: 1 },
  },
  '/reading/highlights/random': highlightFixture,
  '/reading/stats': {
    total_articles: 100,
    finished_count: 40,
    currently_reading_count: 3,
    total_highlights: 250,
    total_word_count: 500000,
    avg_estimated_read_min: 6,
  },
};

function resolveRoute(path: string): unknown {
  if (/^\/reading\/articles\/\d+\/related$/.test(path))
    return { data: [relatedFixture] };
  if (/^\/reading\/articles\/\d+$/.test(path)) return articleDetailFixture;
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
  { name: 'get_article', args: { id: 1 } },
  { name: 'get_recent_reads', args: { include_images: false } },
  { name: 'get_reading_highlights', args: {} },
  { name: 'get_random_highlight', args: {} },
  { name: 'get_reading_stats', args: {} },
  { name: 'find_similar_articles', args: { article_id: 1 } },
];

describe('output-schema conformance — reading', () => {
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
      if (path === '/reading/recent') return { data: [] };
      if (path === '/reading/highlights')
        return {
          data: [],
          pagination: { page: 1, limit: 10, total: 0, total_pages: 0 },
        };
      if (/^\/reading\/articles\/\d+\/related$/.test(path)) return { data: [] };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    for (const [name, args] of [
      ['get_recent_reads', { include_images: false }],
      ['get_reading_highlights', {}],
      ['find_similar_articles', { article_id: 1 }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
  });

  it('every reading tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const reading = tools.filter((t) => names.has(t.name));
    expect(reading).toHaveLength(CASES.length);

    for (const t of reading) {
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
