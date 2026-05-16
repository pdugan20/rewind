/**
 * Live output-schema audit (issue #110).
 *
 * Drives every MCP tool against the REAL Rewind API and lets the SDK's
 * validateToolOutput check the returned structuredContent against each
 * tool's declared outputSchema. A schema that does not match real data
 * makes callTool reject -- this surfaces every such mismatch at once.
 *
 * Unlike the per-domain conformance tests (hand-authored fixtures, which
 * can be circular), this checks against ground truth.
 *
 * Run:
 *   REWIND_MCP_KEY=rw_... npx tsx src/__tests__/output-schema.live.ts
 *   (REWIND_API_URL overrides the default https://api.rewind.rest)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

const API_URL = process.env.REWIND_API_URL ?? 'https://api.rewind.rest';
const KEY = process.env.REWIND_MCP_KEY;

if (!KEY) {
  console.error('REWIND_MCP_KEY not set -- skipping live audit.');
  process.exit(0);
}

type Status = 'ok' | 'FAIL' | 'skip';
interface Outcome {
  tool: string;
  status: Status;
  note?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resultText(res: any): string {
  const block = (res?.content ?? []).find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b: any) => b?.type === 'text'
  );
  return String(block?.text ?? '');
}

async function main(): Promise<void> {
  const rewind = new RewindClient(API_URL, KEY as string);
  const server = createServer(rewind);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'output-schema-live', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const results: Outcome[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captured: Record<string, any> = {};

  // Pace calls -- the API rate-limits on a 60s sliding window, and the
  // audit makes ~50 calls. ~1.2s between keeps a run comfortably under.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function audit(
    tool: string,
    args: Record<string, unknown>
  ): Promise<void> {
    await sleep(1200);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await client.callTool({ name: tool, arguments: args });
      if (res.isError) {
        // A failed outputSchema validation comes back as an isError result
        // with "Output validation error" in the text -- that is a schema
        // FAIL. Any other isError is a handler/API error (skip).
        const txt = resultText(res);
        if (txt.includes('Output validation error')) {
          results.push({ tool, status: 'FAIL', note: txt });
        } else {
          results.push({
            tool,
            status: 'skip',
            note: `handler error: ${txt.slice(0, 160)}`,
          });
        }
        return;
      }
      captured[tool] = res.structuredContent;
      results.push({ tool, status: 'ok' });
    } catch (e) {
      // A failed outputSchema validation rejects callTool -- caught here.
      results.push({
        tool,
        status: 'FAIL',
        note: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Phase 1 -- discovery: tools callable with no chained id.
  const noImg = { include_images: false };
  const discovery: Array<[string, Record<string, unknown>]> = [
    ['get_health', {}],
    ['get_now_playing', noImg],
    ['get_recent_listens', noImg],
    ['get_listening_stats', {}],
    ['get_top_artists', noImg],
    ['get_top_albums', noImg],
    ['get_top_tracks', {}],
    ['get_listening_streaks', {}],
    ['get_listening_genres', {}],
    ['get_running_stats', {}],
    ['get_recent_runs', {}],
    ['get_personal_records', {}],
    ['get_running_streaks', {}],
    ['get_running_years', {}],
    ['get_watching_stats', {}],
    ['browse_movies', noImg],
    ['get_watching_genres', {}],
    ['get_watching_decades', {}],
    ['get_watching_directors', {}],
    ['get_recent_watches', noImg],
    ['get_reading_highlights', {}],
    ['get_random_highlight', {}],
    ['get_reading_stats', {}],
    ['get_recent_reads', {}],
    ['get_attended_events', {}],
    ['get_attended_players', {}],
    ['get_attending_stats', {}],
    ['get_attending_year_in_review', { year: 2024 }],
    ['get_vinyl_collection', {}],
    ['get_collecting_stats', {}],
    ['get_physical_media', {}],
    ['get_physical_media_stats', {}],
    ['search', { query: 'the' }],
    ['semantic_search', { query: 'technology' }],
    ['get_feed', {}],
    ['get_on_this_day', {}],
  ];
  for (const [tool, args] of discovery) await audit(tool, args);

  // Phase 2 -- detail tools, ids chained from discovery results.
  const idFrom = (tool: string, path: string): unknown => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let v: any = captured[tool];
    for (const key of path.split('.')) {
      if (v == null) return undefined;
      v = /^\d+$/.test(key) ? v[Number(key)] : v[key];
    }
    return v;
  };
  async function detail(
    tool: string,
    idArg: string,
    id: unknown,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    if (id == null) {
      results.push({ tool, status: 'skip', note: 'no source id in archive' });
      return;
    }
    await audit(tool, { [idArg]: id, ...extra });
  }

  await detail(
    'get_artist_details',
    'id',
    idFrom('get_top_artists', 'data.0.id'),
    noImg
  );
  await detail(
    'get_album_details',
    'id',
    idFrom('get_top_albums', 'data.0.id'),
    noImg
  );
  await detail(
    'get_movie_details',
    'id',
    idFrom('browse_movies', 'items.0.id'),
    noImg
  );
  await detail(
    'get_activity_details',
    'id',
    idFrom('get_recent_runs', 'items.0.id')
  );
  await detail(
    'get_activity_splits',
    'id',
    idFrom('get_recent_runs', 'items.0.id')
  );
  await detail('get_article', 'id', idFrom('get_recent_reads', 'items.0.id'));
  await detail(
    'find_similar_articles',
    'article_id',
    idFrom('get_recent_reads', 'items.0.id')
  );
  await detail(
    'get_attended_event',
    'id',
    idFrom('get_attended_events', 'data.0.id')
  );
  await detail(
    'get_attended_player',
    'id',
    idFrom('get_attended_players', 'data.0.id'),
    noImg
  );
  await detail(
    'get_attended_player_stats',
    'id',
    idFrom('get_attended_players', 'data.0.id')
  );
  const league = idFrom('get_attended_players', 'data.0.league');
  if (league != null)
    await audit('get_attended_season', { league, season: 2024 });
  else
    results.push({
      tool: 'get_attended_season',
      status: 'skip',
      note: 'no league in archive',
    });

  // Report.
  const fails = results.filter((r) => r.status === 'FAIL');
  const skips = results.filter((r) => r.status === 'skip');
  const oks = results.filter((r) => r.status === 'ok');
  console.log('\n=== Live output-schema audit ===');
  console.log(`API: ${API_URL}`);
  console.log(
    `OK ${oks.length}  /  FAIL ${fails.length}  /  skip ${skips.length}  (of ${results.length})\n`
  );
  for (const r of skips) console.log(`  skip  ${r.tool}  --  ${r.note}`);
  if (skips.length) console.log('');
  for (const r of fails) console.log(`  FAIL  ${r.tool}\n        ${r.note}\n`);
  if (!fails.length)
    console.log('All audited tools conform to their outputSchema.');

  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
