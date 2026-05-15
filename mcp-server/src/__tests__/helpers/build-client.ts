/**
 * Shared test helper: build an MCP Client wired to a fresh Rewind server
 * over an in-memory transport.
 *
 * `routes` maps an API path to its mocked response (default: everything
 * returns `{}`). The per-domain output-schema conformance tests and the
 * manifest snapshot all need this same setup.
 */
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';
import { RewindClient } from '../../client.js';

export async function buildTestClient(
  routes: (path: string) => unknown = () => ({})
): Promise<Client> {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) =>
    routes(path)
  );
  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rewind-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
