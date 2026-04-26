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
import { registerDebugTools } from './tools/debug.js';
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

  // Debug-only: reinstated alongside Phase 2 to A/B test whether Claude
  // Desktop's "Failed to set up MCP app" is specific to the new resource
  // or symptomatic of the whole rewind MCP server's sandbox state.
  registerUiResource(server, {
    name: 'Rewind -- Hello (debug)',
    uri: 'ui://rewind/hello.html',
    html: UI_BUNDLES['hello.html'],
    description:
      'Minimal diagnostic UI. Mirror of the Phase-1 app that rendered cleanly earlier today.',
  });
  registerDebugTools(server);

  return server;
}
