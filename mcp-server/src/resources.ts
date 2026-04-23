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

  // Movie entity
  server.resource(
    'movie',
    new ResourceTemplate('rewind://movie/{id}', { list: undefined }),
    {
      description:
        'Full detail for a single movie by internal Rewind id: metadata, watch history, ratings, and Letterboxd review URLs.',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/watching/movies/${id}`
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

  // Show entity
  server.resource(
    'show',
    new ResourceTemplate('rewind://show/{id}', { list: undefined }),
    {
      description:
        'Full detail for a single TV show by internal Rewind id: metadata, seasons, and watched-episode counts.',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/watching/shows/${id}`
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

  // Album entity
  server.resource(
    'album',
    new ResourceTemplate('rewind://album/{id}', { list: undefined }),
    {
      description:
        'Full detail for a single album by internal Rewind id: artist, play count, track listing, cover art metadata, and Apple Music URL.',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/listening/albums/${id}`
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

  // Artist entity
  server.resource(
    'artist',
    new ResourceTemplate('rewind://artist/{id}', { list: undefined }),
    {
      description:
        'Full detail for a single artist by internal Rewind id: play count, genre, top albums, top tracks, image metadata, and Apple Music URL.',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/listening/artists/${id}`
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

  // Vinyl record entity
  server.resource(
    'vinyl',
    new ResourceTemplate('rewind://vinyl/{id}', { list: undefined }),
    {
      description:
        'Full detail for a single vinyl record (or other Discogs collection item) by internal Rewind id: title, artists, formats, genres, cover art, Discogs URL, community stats.',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/collecting/vinyl/${id}`
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

  // Physical media entity
  server.resource(
    'physical-media',
    new ResourceTemplate('rewind://physical-media/{id}', { list: undefined }),
    {
      description:
        'Full detail for a single physical media item (Blu-ray / 4K UHD / HD DVD) by internal Rewind id: title, year, format, resolution, HDR, audio, watch history.',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/collecting/media/${id}`
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

  // Article entity
  server.resource(
    'article',
    new ResourceTemplate('rewind://article/{id}', { list: undefined }),
    {
      description:
        'Full detail for a saved Instapaper article: title, author, domain, word count, read progress, tags, source URL, Instapaper URLs, embedded highlights, AND the full article body. The `content` field is the complete plain-text body (HTML-stripped, typically 5-30 KB); `excerpt` is the first ~3000 chars. Fetch this resource whenever the user asks about article specifics past the excerpt — do NOT fall back to web search or try to fetch the source URL (often paywalled). The `content` field has the full article text including for paywalled sources.',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/reading/articles/${id}`
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

  // Activity entity
  server.resource(
    'activity',
    new ResourceTemplate('rewind://activity/{id}', { list: undefined }),
    {
      description:
        'Full detail for a single running activity by internal Rewind id: distance, pace, elevation, HR, cadence, calories, location, and Strava URL.',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/running/activities/${id}`
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

  // Highlight entity
  server.resource(
    'highlight',
    new ResourceTemplate('rewind://highlight/{id}', { list: undefined }),
    {
      description:
        'Full detail for a single Instapaper highlight by internal Rewind id: highlighted text, optional note, and nested parent-article context (title, author, domain, source URL).',
    },
    async (uri, params) => {
      const id = params.id as string;
      const data = await client.get<Record<string, unknown>>(
        `/reading/highlights/${id}`
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
