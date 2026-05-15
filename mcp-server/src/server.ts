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
import { registerAttendingTools } from './tools/attending.js';
import { healthOutputSchema } from './tools/schemas/system.js';
import { registerResources } from './resources.js';
import { registerUiResource } from './resources/ui.js';
import { registerPrompts } from './prompts.js';
import { UI_BUNDLES } from './ui-bundles.js';
import {
  EXTENSION_ID as MCP_APPS_EXTENSION_ID,
  RESOURCE_MIME_TYPE as MCP_APPS_RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';

const SERVER_INSTRUCTIONS = [
  "Rewind is the user's personal data archive: listening (Last.fm + Apple Music),",
  'running (Strava), watching (Plex + Letterboxd), collecting (Discogs + physical',
  'media), and reading (Instapaper articles + highlights).',
  '',
  'WHEN TO USE: any time the user references their own history — things they read,',
  'listened to, watched, saved, bookmarked, ran, or collected. Prefer Rewind tools',
  'over web search or conversation history for "that article I saved", "what was I',
  'listening to", "the movie I watched", "find my highlight about X". Rewind owns',
  'this data; other sources do not.',
  '',
  'ANTI-HALLUCINATION — when answering from retrieved articles:',
  '1. Only assert facts that appear verbatim in the excerpt, description, or',
  "   structured fields. Do not infer biographical details (e.g. 'X was a writer",
  "   on SNL') to bridge a gap between the user's query and the retrieved article.",
  "2. If the top result doesn't clearly match the query, say so. Offer 2-3",
  '   candidates with one-line summaries from their excerpts and ask which one.',
  '3. For article specifics past the first ~3000 chars of excerpt, call the',
  '   `get_article` tool with the article id — it returns the full body',
  '   (typically 5-30 KB). Do NOT fall back to web search or web fetch for',
  '   article content; Rewind has the full text including for paywalled',
  '   sources (nytimes, wsj, atlantic, etc.).',
  '4. Quote a short phrase from the content or excerpt when citing a fact.',
  '',
  'LINKING — resource_link blocks are hidden in the tool-use accordion,',
  'not inline with your response. When listing items, render each title as',
  'a markdown link `[title](url)` in prose using the URL fields from',
  'structuredContent: `url`, `apple_music_url`, `letterboxd_url`,',
  '`strava_url`, or `instapaper_url` as appropriate. For reading, also',
  "mention `instapaper_app_url` or the user's Instapaper archive when",
  'useful. Images ship as image blocks; numbers live in structuredContent.',
].join('\n');

export function createServer(client: RewindClient): McpServer {
  const server = new McpServer(
    {
      name: 'rewind',
      title: 'Rewind',
      version: '0.5.0',
      websiteUrl: 'https://rewind.rest',
      icons: [
        {
          src: 'https://rewind.rest/favicon.svg',
          mimeType: 'image/svg+xml',
          sizes: ['any'],
        },
        {
          src: 'https://rewind.rest/apple-touch-icon.png',
          mimeType: 'image/png',
          sizes: ['180x180'],
        },
      ],
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      // Advertise MCP Apps support during the initialize handshake.
      // The ext-apps SDK helpers (registerAppResource/registerAppTool)
      // do NOT auto-advertise -- without this, Claude Desktop sees our
      // tools' _meta.ui.resourceUri but silently skips rendering the
      // iframe because capability negotiation failed.
      capabilities: {
        extensions: {
          [MCP_APPS_EXTENSION_ID]: {
            mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE],
          },
        },
      },
    }
  );

  // System tool
  server.registerTool(
    'get_health',
    {
      title: 'API health',
      description:
        'Check the health and sync status of the Rewind API. Returns API status and last sync times for each data domain.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: healthOutputSchema,
    },
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

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            api_status: health.status,
            timestamp: health.timestamp,
            domains: syncHealth.domains,
          },
        };
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
  registerAttendingTools(server, client);

  // Register resources and prompts
  registerResources(server, client);
  registerPrompts(server);

  // MCP Apps UI resources. HTML is inlined into the Worker bundle at build
  // time (see scripts/inline-bundles.mjs) so this registration works in
  // any host context without needing a Workers Static Assets binding.
  registerUiResource(server, {
    name: 'Rewind -- Recent Watches',
    uri: 'ui://rewind/recent-watches.html',
    html: UI_BUNDLES['recent-watches.html'],
    description:
      'Interactive poster grid for recently watched movies. Consumes get_recent_watches structuredContent.',
    csp: {
      // Allow poster <img> loads from the Rewind CDN. Without this the
      // default sandbox CSP (`img-src 'self' data:`) blocks external
      // images and the cards render as broken-image placeholders.
      resourceDomains: ['https://cdn.rewind.rest'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Recent Reads',
    uri: 'ui://rewind/recent-reads.html',
    html: UI_BUNDLES['recent-reads.html'],
    description:
      'Interactive article card list for recently saved reads. Consumes get_recent_reads structuredContent.',
    csp: {
      resourceDomains: ['https://cdn.rewind.rest'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Article',
    uri: 'ui://rewind/article.html',
    html: UI_BUNDLES['article.html'],
    description:
      'Interactive single-article card for a saved Instapaper read. Hero og:image, title + byline + domain, meta strip (read time, saved date, status, progress), description, top highlights, footer link to Instapaper. Consumes get_article structuredContent.',
    csp: {
      resourceDomains: ['https://cdn.rewind.rest'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Artist',
    uri: 'ui://rewind/artist.html',
    html: UI_BUNDLES['artist.html'],
    description:
      "Interactive single-artist card. Hero portrait + name + genre + 2-line bio, stat strip (total plays, listening since year, last played, all-time rank), yearly sparkline, top tracks, top albums grid, similar-artists chips (cross-referenced against the user's own listening), footer link to Apple Music. Consumes get_artist_details structuredContent.",
    csp: {
      resourceDomains: ['https://cdn.rewind.rest'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Top Tracks',
    uri: 'ui://rewind/top-tracks.html',
    html: UI_BUNDLES['top-tracks.html'],
    description:
      "Interactive top-tracks list. Subtitle scopes period (e.g. 'Top tracks · All time'). Toggle between flat list and album-grouped views. Each row carries album art + track name + plays; album-grouped view adds an album header with cover, year, depth signal, and a Listen on Apple Music CTA. Consumes get_top_tracks structuredContent.",
    csp: {
      resourceDomains: ['https://cdn.rewind.rest'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Top Albums',
    uri: 'ui://rewind/top-albums.html',
    html: UI_BUNDLES['top-albums.html'],
    description:
      'Interactive album cover grid for top listened-to albums. Consumes get_top_albums structuredContent.',
    csp: {
      resourceDomains: ['https://cdn.rewind.rest'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Top Artists',
    uri: 'ui://rewind/top-artists.html',
    html: UI_BUNDLES['top-artists.html'],
    description:
      'Interactive artist portrait grid for top listened-to artists. Consumes get_top_artists structuredContent.',
    csp: {
      resourceDomains: ['https://cdn.rewind.rest'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Attended Season',
    uri: 'ui://rewind/attended-season.html',
    html: UI_BUNDLES['attended-season.html'],
    description:
      "Interactive season grid for attended sports games. Each card shows date, score, attendance, weather, and a strip of the game's notable performers as silo headshots. Consumes get_attended_season structuredContent.",
    csp: {
      resourceDomains: ['https://cdn.rewind.rest'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Attended Event',
    uri: 'ui://rewind/attended-event.html',
    html: UI_BUNDLES['attended-event.html'],
    description:
      'Interactive game card for a single attended event. Hero block with date / matchup / final score; per-inning linescore for MLB; notable performers with silo headshots and stat-line summaries; ticket section / row / seat / vendor block. Consumes get_attended_event structuredContent.',
    csp: {
      // mlbstatic.com hosts the league SVG cap logos that <TeamLogo> hot-links;
      // without it the host's default `img-src 'self' data:` blocks the logos
      // and team slots render empty.
      resourceDomains: ['https://cdn.rewind.rest', 'https://www.mlbstatic.com'],
    },
  });

  registerUiResource(server, {
    name: 'Rewind -- Athlete',
    uri: 'ui://rewind/attended-player.html',
    html: UI_BUNDLES['attended-player.html'],
    description:
      'Interactive single-athlete card. Hero (headshot + team logo + name/#/position + bats/throws), two-column stats panel (live MLB Stats API season + your-attended summary), notable highlights aggregated across attended appearances, recent-appearances list. MLB-only for the live-stats panel. Consumes get_attended_player structuredContent.',
    csp: {
      resourceDomains: ['https://cdn.rewind.rest', 'https://www.mlbstatic.com'],
    },
  });

  return server;
}
