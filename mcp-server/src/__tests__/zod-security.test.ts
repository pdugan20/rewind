import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';
import { collectingStatsOutputSchema } from '../tools/schemas/collecting.js';
import { healthOutputSchema } from '../tools/schemas/system.js';

describe('patched Zod and MCP contracts', () => {
  it('bounds issues for an oversized invalid collection', () => {
    const schema = z.array(z.string()).max(1);
    expect(schema.safeParse(['valid']).success).toBe(true);
    const result = schema.safeParse(Array.from({ length: 10_000 }, () => 0));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].code).toBe('too_big');
    }
  });

  it('keeps dynamic health records typed and forward-compatible', () => {
    const health = {
      api_status: 'ok',
      timestamp: '2026-10-23T00:00:00Z',
      extra: true,
      domains: {
        future_domain: {
          status: 'ok',
          last_sync: null,
          items_synced: null,
          extra: true,
        },
      },
    };
    expect(healthOutputSchema.parse(health)).toEqual(health);
    expect(
      healthOutputSchema.safeParse({
        ...health,
        domains: { future_domain: { status: 7 } },
      }).success
    ).toBe(false);
  });

  it('preserves the optional open-shaped collecting field', () => {
    const stats = {
      total_items: 1,
      by_format: { vinyl: 1, future_format: 0 },
      wantlist_count: null,
      unique_artists: null,
      estimated_value: null,
      top_genre: null,
      oldest_release_year: null,
      newest_release_year: null,
      added_this_year: null,
    };
    expect(collectingStatsOutputSchema.safeParse(stats).success).toBe(true);
    for (const most_collected_artist of [null, { name: 'Artist' }]) {
      expect(
        collectingStatsOutputSchema.safeParse({
          ...stats,
          most_collected_artist,
        }).success
      ).toBe(true);
    }
    expect(
      collectingStatsOutputSchema.safeParse({
        ...stats,
        by_format: { vinyl: 'invalid' },
      }).success
    ).toBe(false);
  });

  it('keeps closed advertised inputs and rejects invalid args before HTTP', async () => {
    const api = new RewindClient('https://api.test', 'rw_test');
    const get = vi.spyOn(api, 'get').mockResolvedValue({});
    const server = createServer(api);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'zod-contract', version: '1.0.0' });
    try {
      await server.connect(st);
      await client.connect(ct);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(40);
      for (const tool of tools)
        expect(tool.inputSchema.additionalProperties).toBe(false);
      const result = await client.callTool({
        name: 'get_article',
        arguments: { id: 'invalid' },
      });
      expect(result.isError).toBe(true);
      expect(get).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
