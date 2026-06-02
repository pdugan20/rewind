#!/usr/bin/env node
/**
 * MDX cross-check: fails CI if any registered MCP tool, prompt, resource
 * URI, or resource template URI template is missing from the Mintlify
 * docs. Companion to the manifest-snapshot vitest — snapshot catches
 * shape changes in PR review; this script guarantees the MDX is kept in
 * sync.
 *
 * Run: npm run check:docs
 *
 * Failure mode: prints every missing identifier and exits 1. Expected
 * fix: tools live in the generated reference/mcp-tools/*.mdx pages;
 * prompts and resource URIs live in mcp/resources-and-prompts.mdx. Add
 * the identifier there (or mark it intentionally UNDOCUMENTED via the
 * allowlist below).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Must be built first (import from dist).
const { createServer } = await import('../dist/server.js');
const { RewindClient } = await import('../dist/client.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs-mintlify');

// Intentionally-internal identifiers we do not document publicly.
// Add with a justification; drop when a tool goes public.
const UNDOCUMENTED_ALLOWLIST = new Set([
  'ui_hello_debug', // Phase-1 MCP Apps diagnostic tool; not end-user-facing
  'ui://rewind/recent-watches.html', // MCP Apps UI asset, referenced in docs by its owning tool
  'ui://rewind/recent-reads.html', // MCP Apps UI asset for get_recent_reads (documented)
  'ui://rewind/top-albums.html', // MCP Apps UI asset for get_top_albums (documented)
  'ui://rewind/top-artists.html', // MCP Apps UI asset for get_top_artists (documented)
  'ui://rewind/top-tracks.html', // MCP Apps UI asset for get_top_tracks (documented)
  'ui://rewind/article.html', // MCP Apps UI asset for get_article (documented)
  'ui://rewind/artist.html', // MCP Apps UI asset for get_artist_details (documented)
  'ui://rewind/attended-season.html', // MCP Apps UI asset for get_attended_season (documented)
  'ui://rewind/attended-event.html', // MCP Apps UI asset for get_attended_event (documented)
  'ui://rewind/attended-player.html', // MCP Apps UI asset for get_attended_player_stats (documented)
  'ui://rewind/hello.html', // MCP Apps debug UI
]);

// MDX files we consider the public surface for cross-checking.
// Tools are documented in the generated per-domain tool reference;
// prompts and resource URIs in mcp/resources-and-prompts.mdx.
const MDX_FILES = [
  'mcp/overview.mdx',
  'mcp/connect-local.mdx',
  'mcp/connect-remote.mdx',
  'mcp/rich-responses.mdx',
  'mcp/resources-and-prompts.mdx',
  'reference/mcp-tools/listening.mdx',
  'reference/mcp-tools/running.mdx',
  'reference/mcp-tools/watching.mdx',
  'reference/mcp-tools/reading.mdx',
  'reference/mcp-tools/collecting.mdx',
  'reference/mcp-tools/attending.mdx',
  'reference/mcp-tools/cross-domain.mdx',
  'domains/listening.mdx',
  'domains/running.mdx',
  'domains/watching.mdx',
  'domains/collecting.mdx',
  'domains/reading.mdx',
  'domains/attending.mdx',
  'domains/images.mdx',
  'changelog.mdx',
];

async function buildClient() {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'check-docs',
    version: '1.0.0',
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function loadMdxCorpus() {
  const parts = [];
  for (const file of MDX_FILES) {
    const path = join(DOCS_DIR, file);
    if (!existsSync(path)) {
      console.error(`[check-docs] WARN: expected docs file missing: ${file}`);
      continue;
    }
    parts.push(readFileSync(path, 'utf8'));
  }
  return parts.join('\n');
}

function isIdentifierMentioned(corpus, id) {
  // Require backticked mention to avoid false positives on substrings
  // (e.g. "search" appearing in prose). MCP tool / prompt names are
  // always referenced as inline code in the docs.
  return corpus.includes(`\`${id}\``);
}

function isUriMentioned(corpus, uri) {
  // Match verbatim, OR the generic `{domain}` form used in docs
  // (e.g. `rewind://listening/year/{year}` → `rewind://{domain}/year/{year}`).
  if (corpus.includes(`\`${uri}\``)) return true;
  const generic = uri.replace(
    /^rewind:\/\/(listening|running|watching|collecting|reading)\//,
    'rewind://{domain}/'
  );
  if (generic !== uri && corpus.includes(`\`${generic}\``)) return true;
  return false;
}

async function main() {
  const client = await buildClient();

  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts();
  const { resources } = await client.listResources();
  const { resourceTemplates } = await client.listResourceTemplates();

  const corpus = loadMdxCorpus();

  const missing = [];

  for (const t of tools) {
    if (UNDOCUMENTED_ALLOWLIST.has(t.name)) continue;
    if (!isIdentifierMentioned(corpus, t.name)) {
      missing.push({ kind: 'tool', id: t.name });
    }
  }

  for (const p of prompts) {
    if (UNDOCUMENTED_ALLOWLIST.has(p.name)) continue;
    if (!isIdentifierMentioned(corpus, p.name)) {
      missing.push({ kind: 'prompt', id: p.name });
    }
  }

  for (const r of resources) {
    if (UNDOCUMENTED_ALLOWLIST.has(r.uri)) continue;
    if (!isUriMentioned(corpus, r.uri)) {
      missing.push({ kind: 'resource', id: r.uri });
    }
  }

  for (const rt of resourceTemplates) {
    if (UNDOCUMENTED_ALLOWLIST.has(rt.uriTemplate)) continue;
    if (!isUriMentioned(corpus, rt.uriTemplate)) {
      missing.push({ kind: 'resource-template', id: rt.uriTemplate });
    }
  }

  await client.close();

  if (missing.length === 0) {
    const n =
      tools.length +
      prompts.length +
      resources.length +
      resourceTemplates.length;
    console.log(
      `[check-docs] OK — ${n} registered identifiers documented across ${MDX_FILES.length} MDX files.`
    );
    process.exit(0);
  }

  console.error('[check-docs] FAIL — undocumented identifiers:');
  for (const m of missing) {
    console.error(`  - ${m.kind.padEnd(20)} ${m.id}`);
  }
  console.error('');
  console.error(
    'Either add the identifier to the appropriate table in docs-mintlify/,'
  );
  console.error(
    'or add it to UNDOCUMENTED_ALLOWLIST in scripts/check-docs.mjs with a justification.'
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('[check-docs] ERROR:', err);
  process.exit(2);
});
