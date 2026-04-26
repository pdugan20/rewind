/**
 * Manual-attending import wrapper.
 *
 * Reads a JSON file of `ManualEntry` records (per-game or season-
 * shorthand) and POSTs to the admin-import endpoint. Use for the UW
 * football 2007–2010 backfill and the recent season-tickets bulk-load.
 *
 * Prerequisites:
 *   - `npm run dev` running locally (or use --remote against prod)
 *   - An admin API key in REWIND_ADMIN_KEY env var
 *
 * Usage:
 *   REWIND_ADMIN_KEY=rw_admin_... npx tsx scripts/tools/import-manual-attending.ts \
 *     scripts/data/manual-attending-uw-2007-2010.json
 *
 *   REWIND_ADMIN_KEY=rw_admin_... npx tsx scripts/tools/import-manual-attending.ts \
 *     scripts/data/manual-attending-uw-recent.json --remote
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCAL_BASE = 'http://localhost:8787';
const REMOTE_BASE = 'https://api.rewind.rest';

interface ImportResponse {
  status: 'completed';
  loaded: number;
  inserted: number;
  updated: number;
  skipped_attended_zero: number;
  unmatched: Array<{ entry: unknown; reason: string }>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const remote = args.includes('--remote');
  const fileArg = args.find((a) => !a.startsWith('--'));
  if (!fileArg) {
    console.error('Usage: import-manual-attending.ts <file.json> [--remote]');
    process.exit(1);
  }

  const apiKey = process.env.REWIND_ADMIN_KEY;
  if (!apiKey) {
    console.error('Missing REWIND_ADMIN_KEY env var');
    process.exit(1);
  }

  const filepath = resolve(process.cwd(), fileArg);
  const raw = readFileSync(filepath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  // Accept either a bare array of entries OR a wrapper object
  // `{ events: [...], _notes?: {...} }`. The wrapper form lets the
  // file carry inline documentation alongside the data.
  const events = Array.isArray(parsed)
    ? parsed
    : ((parsed as { events?: unknown[] }).events ?? []);

  const base = remote ? REMOTE_BASE : LOCAL_BASE;
  console.log(`[INFO] Importing ${events.length} entries to ${base}...`);

  const res = await fetch(`${base}/v1/admin/sync/attending/manual-import`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ events }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[ERROR] Import failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const data = (await res.json()) as ImportResponse;
  console.log(
    `[SUCCESS] loaded=${data.loaded} (inserted=${data.inserted}, updated=${data.updated}), skipped (attended=0)=${data.skipped_attended_zero}, unmatched=${data.unmatched.length}`
  );

  if (data.unmatched.length > 0) {
    console.log('[WARN] Unmatched entries:');
    for (const u of data.unmatched) {
      console.log(`  - ${JSON.stringify(u.entry).slice(0, 100)}: ${u.reason}`);
    }
  }
}

main().catch((err) => {
  console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
