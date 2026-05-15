/**
 * Spike: `outputSchema` on listening tools (issue #105).
 *
 * Verifies, end-to-end through the SDK, that declaring an `outputSchema`:
 *  1. round-trips without the SDK's validateToolOutput throwing,
 *  2. holds on both the populated and empty-state branches,
 *  3. leaves the curated `content` text summary intact,
 *  4. is advertised to clients as a JSON Schema with top-level
 *     `type: "object"` (a documented client requirement).
 *
 * Scoped to get_recent_listens (list shape) and get_listening_stats
 * (flat shape) -- the two dominant return-shape groups.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

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

const statsFixture = {
  total_scrobbles: 100,
  unique_artists: 10,
  unique_albums: 20,
  unique_tracks: 50,
  registered_date: '2010-01-01',
  years_tracking: 16,
  scrobbles_per_day: 1.5,
};

async function buildClient(recent: unknown): Promise<Client> {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) => {
    if (path === '/listening/recent') return recent;
    if (path === '/listening/stats') return statsFixture;
    return {};
  });

  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'output-schema-spike', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('output-schema spike', () => {
  it('get_recent_listens: structured content conforms (populated)', async () => {
    const client = await buildClient({ data: [scrobbleFixture] });
    // If structuredContent fails outputSchema validation the SDK throws
    // an McpError and this call rejects -- so resolving IS the proof.
    const res = await client.callTool({
      name: 'get_recent_listens',
      arguments: { include_images: false },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ items: [scrobbleFixture] });
    const content = res.content as Array<{ type: string }>;
    expect(content.some((b) => b.type === 'text')).toBe(true);
  });

  it('get_recent_listens: conforms on the empty-state branch', async () => {
    const client = await buildClient({ data: [] });
    const res = await client.callTool({
      name: 'get_recent_listens',
      arguments: { include_images: false },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ items: [] });
  });

  it('get_listening_stats: structured content conforms', async () => {
    const client = await buildClient({ data: [] });
    const res = await client.callTool({
      name: 'get_listening_stats',
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(statsFixture);
  });

  it('advertises outputSchema as JSON Schema (type: object, no $ref)', async () => {
    const client = await buildClient({ data: [] });
    const { tools } = await client.listTools();
    const recent = tools.find((t) => t.name === 'get_recent_listens');
    const stats = tools.find((t) => t.name === 'get_listening_stats');

    expect(recent?.outputSchema).toMatchObject({ type: 'object' });
    expect(stats?.outputSchema).toMatchObject({ type: 'object' });

    // Probe: shared imageSchema is imported across files. Confirm the
    // emitted JSON Schema inlines it rather than emitting $ref/$defs,
    // which older Claude Desktop builds failed to compile.
    const recentJson = JSON.stringify(recent?.outputSchema);
    console.log('[spike] get_recent_listens outputSchema:', recentJson);
    expect(recentJson).not.toContain('$ref');
    expect(recentJson).not.toContain('$defs');
    // `.passthrough()` => advertised schema stays forward-compatible:
    // a field the API adds later does not fail client-side validation.
    expect(recentJson).not.toContain('"additionalProperties":false');
  });
});
