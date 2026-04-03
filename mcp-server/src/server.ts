/**
 * Shared MCP server factory.
 * Used by both the stdio entry point (index.ts) and the remote Worker entry point (worker.ts).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RewindClient } from './client.js';
import { READ_ONLY_ANNOTATIONS } from './tools/helpers.js';
import { registerListeningTools } from './tools/listening.js';
import { registerRunningTools } from './tools/running.js';
import { registerWatchingTools } from './tools/watching.js';
import { registerCollectingTools } from './tools/collecting.js';
import { registerReadingTools } from './tools/reading.js';
import { registerCrossDomainTools } from './tools/cross-domain.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export function createServer(client: RewindClient): McpServer {
  const server = new McpServer({
    name: 'rewind',
    version: '0.1.0',
  });

  // System tool
  server.tool(
    'get_health',
    'Check the health and sync status of the Rewind API. Returns API status and last sync times for each data domain.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () => {
      try {
        const health = await client.get<{
          status: string;
          timestamp: string;
        }>('/health');

        const syncHealth = await client.get<{
          domains: Record<
            string,
            {
              status: string;
              last_sync: string | null;
              items_synced: number | null;
            }
          >;
        }>('/health/sync');

        const lines = [`API Status: ${health.status}`, ''];

        for (const [domain, info] of Object.entries(syncHealth.domains)) {
          const lastSync = info.last_sync
            ? new Date(info.last_sync).toLocaleString()
            : 'never';
          const items =
            info.items_synced !== null ? ` (${info.items_synced} items)` : '';
          lines.push(
            `${domain}: ${info.status} -- last sync: ${lastSync}${items}`
          );
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to check health: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register all domain tools
  registerListeningTools(server, client);
  registerRunningTools(server, client);
  registerWatchingTools(server, client);
  registerCollectingTools(server, client);
  registerReadingTools(server, client);
  registerCrossDomainTools(server, client);

  // Register resources and prompts
  registerResources(server, client);
  registerPrompts(server);

  return server;
}
