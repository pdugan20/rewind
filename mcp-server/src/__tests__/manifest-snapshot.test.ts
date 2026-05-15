/**
 * MCP Manifest Snapshot.
 *
 * Snapshots the full set of tools, prompts, resources, and resource
 * templates registered by the server, plus each entry's description +
 * input-schema shape. If a tool is added / removed / renamed, or a
 * description changes, this test fails and the reviewer sees the diff
 * in the PR — same pattern as `src/__tests__/openapi-snapshot.test.ts`
 * on the API side.
 *
 * The snapshot is NOT a complete API contract — it's a drift detector.
 * The intent is: when you genuinely mean to change the public shape,
 * run `npm run mcp:update` to accept the new snapshot, and update the
 * Mintlify docs in the same commit.
 */

import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

async function buildClient() {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  // No method invocations in this test, so mocking HTTP isn't strictly
  // required — but keep it defensive in case a list call ever side-effects.
  vi.spyOn(rewindClient, 'get').mockResolvedValue({});

  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({
    name: 'manifest-snapshot',
    version: '1.0.0',
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

interface ManifestPrompt {
  name: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

interface ManifestResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface ManifestResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
}

interface Manifest {
  tools: ManifestTool[];
  prompts: ManifestPrompt[];
  resources: ManifestResource[];
  resourceTemplates: ManifestResourceTemplate[];
}

describe('MCP manifest snapshot', () => {
  it('matches snapshot', async () => {
    const client = await buildClient();

    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();

    const manifest: Manifest = {
      tools: tools
        .map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      prompts: prompts
        .map((p) => ({
          name: p.name,
          description: p.description ?? '',
          arguments: (p.arguments ?? []).map((a) => ({
            name: a.name,
            description: a.description,
            required: a.required,
          })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      resources: resources
        .map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }))
        .sort((a, b) => a.uri.localeCompare(b.uri)),
      resourceTemplates: resourceTemplates
        .map((rt) => ({
          uriTemplate: rt.uriTemplate,
          name: rt.name,
          description: rt.description,
        }))
        .sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate)),
    };

    const json = JSON.stringify(manifest, null, 2) + '\n';
    await expect(json).toMatchFileSnapshot('../../mcp-manifest.snapshot.json');

    await client.close();
  });
});
