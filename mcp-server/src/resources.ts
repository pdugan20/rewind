import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from './client.js';
import { fmt } from './tools/helpers.js';

export function registerResources(
  server: McpServer,
  client: RewindClient
): void {
  // Sync status resource
  server.resource(
    'sync-status',
    'rewind://sync/status',
    {
      description:
        'Current sync health and last sync times for each data domain',
    },
    async (uri) => {
      const data = await client.get<{
        domains: Record<
          string,
          {
            status: string;
            last_sync: string | null;
            items_synced: number | null;
          }
        >;
      }>('/health/sync');

      const lines = ['Sync Status:'];
      for (const [domain, info] of Object.entries(data.domains)) {
        const lastSync = info.last_sync
          ? new Date(info.last_sync).toLocaleString()
          : 'never';
        const items =
          info.items_synced !== null
            ? ` (${fmt(info.items_synced)} items)`
            : '';
        lines.push(
          `${domain}: ${info.status} -- last sync: ${lastSync}${items}`
        );
      }

      return {
        contents: [
          { uri: uri.href, text: lines.join('\n'), mimeType: 'text/plain' },
        ],
      };
    }
  );

  // Listening year-in-review
  server.resource(
    'listening-year',
    new ResourceTemplate('rewind://listening/year/{year}', {
      list: undefined,
    }),
    {
      description: 'Listening year-in-review statistics for a given year',
    },
    async (uri, params) => {
      const year = params.year as string;
      const data = await client.get<Record<string, unknown>>(
        `/listening/year/${year}`
      );

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    }
  );

  // Running year-in-review
  server.resource(
    'running-year',
    new ResourceTemplate('rewind://running/year/{year}', {
      list: undefined,
    }),
    {
      description: 'Running year-in-review statistics for a given year',
    },
    async (uri, params) => {
      const year = params.year as string;
      const data = await client.get<Record<string, unknown>>(
        `/running/year/${year}`
      );

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    }
  );

  // Watching year-in-review
  server.resource(
    'watching-year',
    new ResourceTemplate('rewind://watching/year/{year}', {
      list: undefined,
    }),
    {
      description: 'Watching year-in-review statistics for a given year',
    },
    async (uri, params) => {
      const year = params.year as string;
      const data = await client.get<Record<string, unknown>>(
        `/watching/year/${year}`
      );

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    }
  );
}
