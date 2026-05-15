/**
 * Output-schema conformance — cross-domain (issue #105).
 *
 * For every cross-domain tool: run it end-to-end through the SDK against
 * a fixture and assert it resolves. The SDK's validateToolOutput throws if
 * `structuredContent` does not match the declared `outputSchema`, so a
 * resolved call IS the conformance proof. Also asserts each tool
 * advertises a clean JSON Schema (top-level object, no $ref, no
 * `additionalProperties: false`).
 *
 * Mirrors the structure of output-schema-listening.test.ts.
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

const searchResultFixture = {
  domain: 'reading',
  entity_type: 'article',
  entity_id: '42',
  title: 'Test Article',
  subtitle: 'A subtitle',
  image: null,
  url: 'https://example.com/article',
  instapaper_url: 'https://instapaper.com/read/42',
  instapaper_app_url: 'instapaper://read/42',
  author: 'Test Author',
  score: 0.87,
};

const feedItemFixture = {
  domain: 'listening',
  event_type: 'scrobble',
  occurred_at: '2026-05-15T12:00:00Z',
  title: 'Test Song',
  subtitle: 'Test Artist',
};

const onThisDayFixture = {
  month: 5,
  day: 15,
  years: [
    {
      year: 2024,
      items: [
        {
          domain: 'watching',
          event_type: 'watch',
          title: 'Test Movie',
          subtitle: 'A film',
        },
      ],
    },
  ],
};

const ROUTES: Record<string, unknown> = {
  '/search': { data: [searchResultFixture], pagination: paginationFixture },
  '/feed': { data: [feedItemFixture], pagination: { has_more: false } },
  '/feed/on-this-day': onThisDayFixture,
};

function resolveRoute(path: string): unknown {
  if (path.startsWith('/feed/domain/')) {
    return { data: [feedItemFixture], pagination: { has_more: false } };
  }
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
  { name: 'search', args: { query: 'test' } },
  { name: 'semantic_search', args: { query: 'test' } },
  { name: 'get_feed', args: {} },
  { name: 'get_on_this_day', args: {} },
];

describe('output-schema conformance — cross-domain', () => {
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
      if (path === '/search')
        return { data: [], pagination: paginationFixture };
      if (path === '/feed')
        return { data: [], pagination: { has_more: false } };
      if (path === '/feed/on-this-day') return { month: 5, day: 15, years: [] };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    for (const [name, args] of [
      ['search', { query: 'nothing' }],
      ['semantic_search', { query: 'nothing' }],
      ['get_feed', {}],
      ['get_on_this_day', {}],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
  });

  it('every cross-domain tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const crossDomain = tools.filter((t) => names.has(t.name));
    expect(crossDomain).toHaveLength(CASES.length);

    for (const t of crossDomain) {
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
