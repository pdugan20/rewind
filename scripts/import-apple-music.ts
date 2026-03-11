/**
 * Apple Music Historical Import Script
 *
 * One-time script to import Apple Music listening history (from Apple's
 * privacy data export CSV) into the remote D1 database. Inserts into the
 * existing lastfm_* tables so all listening data lives in one place.
 *
 * Handles the full artist->album->track->scrobble foreign key chain,
 * applies Apple-specific filters (media type, source, duration, previews),
 * then holiday/audiobook filters, and deduplicates against existing scrobbles.
 *
 * Prerequisites:
 *   1. .dev.vars exists (not used for secrets, but required by convention)
 *   2. Ensure wrangler is authenticated (`npx wrangler login`)
 *   3. Apple Music CSV exported via https://privacy.apple.com
 *
 * Usage:
 *   npx tsx scripts/import-apple-music.ts <path-to-csv>
 *   npx tsx scripts/import-apple-music.ts <path-to-csv> --dry-run
 *   npx tsx scripts/import-apple-music.ts <path-to-csv> --resume
 *   npx tsx scripts/import-apple-music.ts <path-to-csv> --limit 100
 *   npx tsx scripts/import-apple-music.ts <path-to-csv> --min-play-pct 60
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const CF_ACCOUNT_ID = '46bcea726724fbab7d60f236f151f3d3';
const CF_DATABASE_ID = '35a4edf8-0d4f-4cbe-9a6e-6f1525716774';
const D1_API_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;
const CHECKPOINT_FILE = resolve(
  import.meta.dirname ?? '.',
  '.apple-music-checkpoint.json'
);
const BATCH_SIZE = 200;
const DEFAULT_MIN_PLAY_PCT = 50;
const DEFAULT_MIN_DURATION_MS = 30000;

// --- Filter patterns (mirrored from src/services/lastfm/filters.ts) ---

const HOLIDAY_ALBUM_PATTERNS = [
  'charlie brown christmas', 'merry christmas', 'white christmas',
  'christmas album', 'holiday', 'christmas songs',
];

const HOLIDAY_TRACK_PATTERNS = [
  'jingle bell', 'silent night', 'santa claus', 'deck the hall',
  'rudolph', 'frosty the snowman', 'winter wonderland', 'o holy night',
  'little drummer boy', 'away in a manger', 'hark the herald',
  'o come all ye faithful', 'we wish you a merry', 'sleigh ride',
  'silver bells', 'blue christmas', 'last christmas', 'christmas time',
  'holly jolly', 'joy to the world',
];

const HOLIDAY_ARTIST_TRACKS = [
  { artist: 'vince guaraldi', track: 'skating' },
  { artist: 'vince guaraldi', track: 'greensleeves' },
  { artist: 'vince guaraldi', track: 'linus and lucy' },
];

const AUDIOBOOK_ARTISTS = [
  'stephen king', 'thomas pynchon', 'hunter s. thompson', 'andy weir',
];

const AUDIOBOOK_TRACK_PATTERNS = ['libby--open-'];
const AUDIOBOOK_TRACK_REGEXES = [
  /- Part \d+/i, /- Track \d+/i, /- \d{2,3}$/, / \(\d+\)$/,
];

function checkFiltered(artistName: string, albumName: string, trackName: string): boolean {
  const artistLower = artistName.toLowerCase();
  const albumLower = albumName.toLowerCase();
  const trackLower = trackName.toLowerCase();

  for (const p of HOLIDAY_ALBUM_PATTERNS) { if (albumLower.includes(p)) return true; }
  for (const p of HOLIDAY_TRACK_PATTERNS) { if (trackLower.includes(p)) return true; }
  for (const entry of HOLIDAY_ARTIST_TRACKS) {
    if (artistLower.includes(entry.artist) && trackLower === entry.track) return true;
  }
  for (const a of AUDIOBOOK_ARTISTS) { if (artistLower === a) return true; }
  for (const p of AUDIOBOOK_TRACK_PATTERNS) { if (trackLower.includes(p)) return true; }
  for (const regex of AUDIOBOOK_TRACK_REGEXES) { if (regex.test(trackName)) return true; }
  return false;
}

// --- Types ---

interface CsvRow {
  [key: string]: string;
}

interface ApplePlay {
  trackName: string;
  artistName: string;
  albumName: string;
  timestamp: string; // ISO 8601
  durationMs: number;
  mediaDurationMs: number;
  mediaType: string;
  sourceType: string;
  contentType: string;
  featureName: string;
  eventType: string;
}

interface FilterResult {
  pass: boolean;
  reason?: string;
}

interface ParsedPlay {
  trackName: string;
  artistName: string;
  albumName: string;
  scrobbledAt: string;
  filtered: boolean;
}

interface Checkpoint {
  totalPlays: number;
  processedIndex: number;
  totalInserted: number;
  csvHash: string;
}

// In-memory caches (loaded from DB)
const artistCache: Map<string, number> = new Map(); // lowercase name -> id
const albumCache: Map<string, number> = new Map();  // "name_lower|artistId" -> id
const trackCache: Map<string, number> = new Map();  // "name_lower|artistId" -> id

// --- Env ---

function loadDevVars(): Record<string, string> {
  const varsPath = resolve(import.meta.dirname ?? '.', '..', '.dev.vars');
  if (!existsSync(varsPath)) {
    console.error('[ERROR] .dev.vars not found');
    process.exit(1);
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(varsPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      vars[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
    }
  }
  return vars;
}

function loadCfToken(): string {
  const cfgPath = resolve(
    process.env.HOME ?? '~',
    'Library/Preferences/.wrangler/config/default.toml'
  );
  if (!existsSync(cfgPath)) {
    console.error('[ERROR] Wrangler config not found. Run `npx wrangler login` first.');
    process.exit(1);
  }
  const content = readFileSync(cfgPath, 'utf-8');
  const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match) {
    console.error('[ERROR] Could not parse oauth_token from wrangler config');
    process.exit(1);
  }
  return match[1];
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeSQL(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

async function d1Query(sql: string, cfToken: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(D1_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`D1 API error (${response.status}): ${errText}`);
  }

  const data = await response.json() as {
    success: boolean;
    errors?: Array<{ message: string }>;
    result: Array<{ results: Array<Record<string, unknown>> }>;
  };

  if (!data.success) {
    const errMsg = data.errors?.map(e => e.message).join(', ') ?? 'Unknown error';
    throw new Error(`D1 query failed: ${errMsg}`);
  }

  return data.result?.[0]?.results ?? [];
}

async function executeSQL(sql: string, cfToken: string): Promise<void> {
  await d1Query(sql, cfToken);
}

async function queryRows(sql: string, cfToken: string): Promise<Array<Record<string, unknown>>> {
  try {
    return await d1Query(sql, cfToken);
  } catch (err) {
    console.error(`[ERROR] queryRows failed: ${err}`);
    return [];
  }
}

// --- CSV parsing ---

/**
 * Column name mapping: Apple has changed CSV column names over time.
 * Map known variants to canonical names.
 */
const COLUMN_VARIANTS: Record<string, string[]> = {
  trackName: ['Song Name', 'Title', 'Original Title'],
  artistName: ['Artist Name'],
  albumName: ['Content Name', 'Album Name'],
  timestamp: ['Event Start Timestamp', 'Activity date time'],
  durationMs: ['Play Duration Milliseconds'],
  mediaDurationMs: ['Media Duration In Milliseconds'],
  mediaType: ['Media Type'],
  sourceType: ['Source Type'],
  contentType: ['Content Specific Type'],
  featureName: ['Feature Name'],
  eventType: ['Event Type'],
};

function buildColumnMap(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const [canonical, variants] of Object.entries(COLUMN_VARIANTS)) {
    for (const variant of variants) {
      const idx = headers.findIndex(h => h.toLowerCase() === variant.toLowerCase());
      if (idx !== -1) {
        map.set(canonical, idx);
        break;
      }
    }
  }
  return map;
}

/**
 * Simple CSV parser that handles quoted fields with embedded commas, newlines,
 * and doubled quotes. No external dependencies.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsv(content: string): CsvRow[] {
  // Strip UTF-8 BOM
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCsvLine(line);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = fields[j] ?? '';
    }
    rows.push(row);
  }

  return rows;
}

function csvRowToApplePlay(row: CsvRow, columnMap: Map<string, number>, headers: string[]): ApplePlay | null {
  const get = (canonical: string): string => {
    const idx = columnMap.get(canonical);
    if (idx === undefined) return '';
    return row[headers[idx]] ?? '';
  };

  const timestamp = get('timestamp');
  if (!timestamp) return null;

  return {
    trackName: get('trackName'),
    artistName: get('artistName'),
    albumName: get('albumName'),
    timestamp,
    durationMs: parseInt(get('durationMs'), 10) || 0,
    mediaDurationMs: parseInt(get('mediaDurationMs'), 10) || 0,
    mediaType: get('mediaType'),
    sourceType: get('sourceType'),
    contentType: get('contentType'),
    featureName: get('featureName'),
    eventType: get('eventType'),
  };
}

// --- Apple-specific filters ---

function filterMediaType(play: ApplePlay): FilterResult {
  if (play.mediaType.toUpperCase() !== 'AUDIO') {
    return { pass: false, reason: 'media_type_not_audio' };
  }
  return { pass: true };
}

function filterRadioSource(play: ApplePlay): FilterResult {
  const source = play.sourceType.toUpperCase();
  if (source.includes('RADIO') || source.includes('BEATS_1')) {
    return { pass: false, reason: 'radio_source' };
  }
  return { pass: true };
}

function filterContentType(play: ApplePlay): FilterResult {
  const ct = play.contentType.toUpperCase();
  if (ct === 'PODCAST' || ct === 'AUDIOBOOK') {
    return { pass: false, reason: 'podcast_or_audiobook_content' };
  }
  return { pass: true };
}

function filterPreview(play: ApplePlay): FilterResult {
  const feature = play.featureName.toLowerCase();
  if (feature === 'auto_play_preview' || feature === 'preview') {
    return { pass: false, reason: 'preview_play' };
  }
  return { pass: true };
}

function filterPlayDuration(play: ApplePlay, minPlayPct: number): FilterResult {
  if (play.mediaDurationMs > 0) {
    const pct = (play.durationMs / play.mediaDurationMs) * 100;
    if (pct < minPlayPct) {
      return { pass: false, reason: 'insufficient_play_duration' };
    }
  } else {
    if (play.durationMs < DEFAULT_MIN_DURATION_MS) {
      return { pass: false, reason: 'insufficient_play_duration' };
    }
  }
  return { pass: true };
}

function filterMissingFields(play: ApplePlay): FilterResult {
  if (!play.artistName || !play.trackName) {
    return { pass: false, reason: 'missing_artist_or_track' };
  }
  return { pass: true };
}

function filterHolidayAudiobook(play: ApplePlay): FilterResult {
  if (checkFiltered(play.artistName, play.albumName, play.trackName)) {
    return { pass: false, reason: 'holiday_or_audiobook' };
  }
  return { pass: true };
}

type FilterFn = (play: ApplePlay, minPlayPct: number) => FilterResult;

const FILTER_PIPELINE: Array<{ name: string; fn: FilterFn }> = [
  { name: 'media_type_not_audio', fn: (p) => filterMediaType(p) },
  { name: 'radio_source', fn: (p) => filterRadioSource(p) },
  { name: 'podcast_or_audiobook_content', fn: (p) => filterContentType(p) },
  { name: 'preview_play', fn: (p) => filterPreview(p) },
  { name: 'insufficient_play_duration', fn: (p, pct) => filterPlayDuration(p, pct) },
  { name: 'missing_artist_or_track', fn: (p) => filterMissingFields(p) },
  { name: 'holiday_or_audiobook', fn: (p) => filterHolidayAudiobook(p) },
];

function applyFilters(play: ApplePlay, minPlayPct: number): FilterResult {
  for (const filter of FILTER_PIPELINE) {
    const result = filter.fn(play, minPlayPct);
    if (!result.pass) return result;
  }
  return { pass: true };
}

// --- Deduplication ---

/**
 * Deduplicate Apple events for the same play.
 * Group by artist+track+minute timestamp; keep only one per group.
 */
function deduplicateAppleEvents(plays: ApplePlay[]): { deduped: ApplePlay[]; duplicateCount: number } {
  const seen = new Set<string>();
  const deduped: ApplePlay[] = [];
  let duplicateCount = 0;

  for (const play of plays) {
    const minuteTs = play.timestamp.slice(0, 16); // YYYY-MM-DDTHH:MM
    const key = `${play.artistName.toLowerCase()}|${play.trackName.toLowerCase()}|${minuteTs}`;
    if (seen.has(key)) {
      duplicateCount++;
      continue;
    }
    seen.add(key);
    deduped.push(play);
  }

  return { deduped, duplicateCount };
}

/**
 * Build dedup set from existing scrobbles. Uses a 3-minute window for
 * timestamp comparison (minute-1, minute, minute+1).
 */
function truncateToMinute(isoStr: string): number {
  const d = new Date(isoStr);
  d.setSeconds(0, 0);
  return d.getTime();
}

function buildScrobbleDedupSet(
  scrobbles: Array<{ track_name: string; artist_name: string; scrobbled_at: string }>
): Set<string> {
  const dedupSet = new Set<string>();
  for (const s of scrobbles) {
    const artistLower = (s.artist_name || '').toLowerCase();
    const trackLower = (s.track_name || '').toLowerCase();
    const minuteTs = truncateToMinute(s.scrobbled_at);
    dedupSet.add(`${artistLower}|${trackLower}|${minuteTs}`);
  }
  return dedupSet;
}

function isDuplicateScrobble(
  dedupSet: Set<string>,
  artistName: string,
  trackName: string,
  timestamp: string
): boolean {
  const artistLower = artistName.toLowerCase();
  const trackLower = trackName.toLowerCase();
  const minuteTs = truncateToMinute(timestamp);

  // Check 3-minute window: minute-1, minute, minute+1
  for (let offset = -60000; offset <= 60000; offset += 60000) {
    if (dedupSet.has(`${artistLower}|${trackLower}|${minuteTs + offset}`)) {
      return true;
    }
  }
  return false;
}

// --- Cache loading from DB ---

async function loadEntities(
  table: string,
  cache: Map<string, number>,
  keyFn: (row: Record<string, unknown>) => string | null,
  cfToken: string,
  minId = 0
): Promise<void> {
  const whereClause = minId > 0 ? ` WHERE id > ${minId}` : '';
  const cols = table === 'lastfm_artists' ? 'id, name' : 'id, name, artist_id';
  const rows = await queryRows(`SELECT ${cols} FROM ${table}${whereClause};`, cfToken);
  if (minId === 0) cache.clear();
  for (const row of rows) {
    const key = keyFn(row);
    if (key) cache.set(key, row.id as number);
  }
}

function getMaxCacheId(cache: Map<string, number>): number {
  let max = 0;
  for (const id of cache.values()) {
    if (id > max) max = id;
  }
  return max;
}

async function loadAllArtists(cfToken: string, incremental = false): Promise<void> {
  const minId = incremental ? getMaxCacheId(artistCache) : 0;
  await loadEntities('lastfm_artists', artistCache, (row) =>
    row.name ? (row.name as string).toLowerCase() : null, cfToken, minId);
}

async function loadAllAlbums(cfToken: string, incremental = false): Promise<void> {
  const minId = incremental ? getMaxCacheId(albumCache) : 0;
  await loadEntities('lastfm_albums', albumCache, (row) =>
    row.name ? `${(row.name as string).toLowerCase()}|${row.artist_id}` : null, cfToken, minId);
}

async function loadAllTracks(cfToken: string, incremental = false): Promise<void> {
  const minId = incremental ? getMaxCacheId(trackCache) : 0;
  await loadEntities('lastfm_tracks', trackCache, (row) =>
    row.name ? `${(row.name as string).toLowerCase()}|${row.artist_id}` : null, cfToken, minId);
}

async function preloadCaches(cfToken: string): Promise<void> {
  console.log('[INFO] Preloading entity caches from DB...');
  await loadAllArtists(cfToken);
  console.log(`[INFO] Preloaded ${artistCache.size} artists`);
  await loadAllAlbums(cfToken);
  console.log(`[INFO] Preloaded ${albumCache.size} albums`);
  await loadAllTracks(cfToken);
  console.log(`[INFO] Preloaded ${trackCache.size} tracks`);
}

async function loadExistingScrobbles(cfToken: string): Promise<Set<string>> {
  console.log('[INFO] Loading existing scrobbles for dedup...');
  const rows = await queryRows(
    `SELECT t.name as track_name, a.name as artist_name, s.scrobbled_at
     FROM lastfm_scrobbles s
     JOIN lastfm_tracks t ON s.track_id = t.id
     JOIN lastfm_artists a ON t.artist_id = a.id;`,
    cfToken
  );
  console.log(`[INFO] Loaded ${rows.length} existing scrobbles`);
  return buildScrobbleDedupSet(
    rows as Array<{ track_name: string; artist_name: string; scrobbled_at: string }>
  );
}

// --- Batch upsert operations ---

async function batchUpsertArtists(plays: ParsedPlay[], cfToken: string): Promise<void> {
  const newArtists = new Map<string, ParsedPlay>();
  for (const p of plays) {
    const key = p.artistName.toLowerCase();
    if (!artistCache.has(key) && !newArtists.has(key)) {
      newArtists.set(key, p);
    }
  }
  if (newArtists.size === 0) return;

  const now = new Date().toISOString();
  const values = [...newArtists.values()].map(p =>
    `(1, ${escapeSQL(p.artistName)}, NULL, '', 0, ${p.filtered ? 1 : 0}, ${escapeSQL(now)}, ${escapeSQL(now)})`
  ).join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_artists (user_id, name, mbid, url, playcount, is_filtered, created_at, updated_at) VALUES\n${values};`,
      cfToken
    );
  } catch (err) {
    console.error(`[ERROR] Artist batch insert failed: ${err}`);
    return;
  }

  await loadAllArtists(cfToken, true);
}

async function batchUpsertAlbums(plays: ParsedPlay[], cfToken: string): Promise<void> {
  const newAlbums = new Map<string, { p: ParsedPlay; artistId: number }>();
  for (const p of plays) {
    if (!p.albumName) continue;
    const artistId = artistCache.get(p.artistName.toLowerCase());
    if (!artistId) continue;
    const key = `${p.albumName.toLowerCase()}|${artistId}`;
    if (!albumCache.has(key) && !newAlbums.has(key)) {
      newAlbums.set(key, { p, artistId });
    }
  }
  if (newAlbums.size === 0) return;

  const now = new Date().toISOString();
  const values = [...newAlbums.values()].map(({ p, artistId }) =>
    `(1, ${escapeSQL(p.albumName)}, NULL, ${artistId}, '', 0, ${p.filtered ? 1 : 0}, ${escapeSQL(now)}, ${escapeSQL(now)})`
  ).join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_albums (user_id, name, mbid, artist_id, url, playcount, is_filtered, created_at, updated_at) VALUES\n${values};`,
      cfToken
    );
  } catch (err) {
    console.error(`[ERROR] Album batch insert failed: ${err}`);
    return;
  }

  await loadAllAlbums(cfToken, true);
}

async function batchUpsertTracks(plays: ParsedPlay[], cfToken: string): Promise<void> {
  const newTracks = new Map<string, { p: ParsedPlay; artistId: number; albumId: number | null }>();
  for (const p of plays) {
    const artistId = artistCache.get(p.artistName.toLowerCase());
    if (!artistId) continue;
    const key = `${p.trackName.toLowerCase()}|${artistId}`;
    if (trackCache.has(key) || newTracks.has(key)) continue;

    const albumId = p.albumName
      ? albumCache.get(`${p.albumName.toLowerCase()}|${artistId}`) ?? null
      : null;

    newTracks.set(key, { p, artistId, albumId });
  }
  if (newTracks.size === 0) return;

  const now = new Date().toISOString();
  const values = [...newTracks.values()].map(({ p, artistId, albumId }) =>
    `(1, ${escapeSQL(p.trackName)}, NULL, ${artistId}, ${albumId ?? 'NULL'}, '', ${p.filtered ? 1 : 0}, ${escapeSQL(now)}, ${escapeSQL(now)})`
  ).join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_tracks (user_id, name, mbid, artist_id, album_id, url, is_filtered, created_at, updated_at) VALUES\n${values};`,
      cfToken
    );
  } catch (err) {
    console.error(`[ERROR] Track batch insert failed: ${err}`);
    return;
  }

  await loadAllTracks(cfToken, true);
}

async function batchInsertScrobbles(plays: ParsedPlay[], cfToken: string): Promise<number> {
  const now = new Date().toISOString();
  const values: string[] = [];

  for (const p of plays) {
    const artistId = artistCache.get(p.artistName.toLowerCase());
    if (!artistId) continue;
    const trackId = trackCache.get(`${p.trackName.toLowerCase()}|${artistId}`);
    if (!trackId) continue;

    values.push(
      `(1, ${trackId}, ${escapeSQL(p.scrobbledAt)}, ${escapeSQL(now)})`
    );
  }

  if (values.length === 0) return 0;

  // Split into chunks of 100 to avoid SQL size limits
  const chunkSize = 100;
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    await executeSQL(
      `INSERT INTO lastfm_scrobbles (user_id, track_id, scrobbled_at, created_at) VALUES\n${chunk.join(',\n')};`,
      cfToken
    );
  }

  return values.length;
}

// --- Checkpoint ---

function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8')) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

function computeCsvHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// --- CLI argument parsing ---

interface CliArgs {
  csvPath: string;
  dryRun: boolean;
  resume: boolean;
  limit: number | null;
  minPlayPct: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const positional = args.filter(a => !a.startsWith('--'));

  if (positional.length === 0) {
    console.error('[ERROR] Usage: npx tsx scripts/import-apple-music.ts <path-to-csv> [--dry-run] [--resume] [--limit N] [--min-play-pct N]');
    process.exit(1);
  }

  let limit: number | null = null;
  let minPlayPct = DEFAULT_MIN_PLAY_PCT;

  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10);
  }

  const pctIdx = args.indexOf('--min-play-pct');
  if (pctIdx !== -1 && args[pctIdx + 1]) {
    minPlayPct = parseInt(args[pctIdx + 1], 10);
  }

  return {
    csvPath: resolve(positional[0]),
    dryRun: flags.has('--dry-run'),
    resume: flags.has('--resume'),
    limit,
    minPlayPct,
  };
}

// --- Main ---

async function main() {
  const cliArgs = parseArgs();

  if (!existsSync(cliArgs.csvPath)) {
    console.error(`[ERROR] CSV file not found: ${cliArgs.csvPath}`);
    process.exit(1);
  }

  // Load env (validates .dev.vars exists)
  loadDevVars();
  const cfToken = loadCfToken();

  console.log('[INFO] Apple Music import starting');
  console.log(`[INFO] CSV: ${cliArgs.csvPath}`);
  console.log(`[INFO] Mode: ${cliArgs.dryRun ? 'DRY RUN' : 'PRODUCTION'}`);
  console.log(`[INFO] Min play percentage: ${cliArgs.minPlayPct}%`);
  if (cliArgs.limit) console.log(`[INFO] Limit: ${cliArgs.limit} plays`);

  // Read and parse CSV
  const csvContent = readFileSync(cliArgs.csvPath, 'utf-8');
  const csvHash = computeCsvHash(csvContent);
  const rawRows = parseCsv(csvContent);
  console.log(`[INFO] Parsed ${rawRows.length} CSV rows`);

  if (rawRows.length === 0) {
    console.error('[ERROR] No rows found in CSV');
    process.exit(1);
  }

  // Build column map from headers
  const firstRowContent = readFileSync(cliArgs.csvPath, 'utf-8');
  const headerLine = (firstRowContent.charCodeAt(0) === 0xFEFF ? firstRowContent.slice(1) : firstRowContent)
    .split(/\r?\n/)[0];
  const headers = parseCsvLine(headerLine);
  const columnMap = buildColumnMap(headers);

  console.log(`[INFO] Mapped columns: ${[...columnMap.keys()].join(', ')}`);

  // Parse all rows to ApplePlay objects
  const allPlays: ApplePlay[] = [];
  for (const row of rawRows) {
    const play = csvRowToApplePlay(row, columnMap, headers);
    if (play) allPlays.push(play);
  }
  console.log(`[INFO] Valid rows with timestamps: ${allPlays.length}`);

  // Apply filters and track rejection reasons
  const filterStats: Record<string, number> = {};
  const passedPlays: ApplePlay[] = [];

  for (const play of allPlays) {
    const result = applyFilters(play, cliArgs.minPlayPct);
    if (result.pass) {
      passedPlays.push(play);
    } else {
      const reason = result.reason ?? 'unknown';
      filterStats[reason] = (filterStats[reason] ?? 0) + 1;
    }
  }

  console.log(`[INFO] Passed filters: ${passedPlays.length}`);

  // Deduplicate Apple events (same artist+track+minute)
  const { deduped: dedupedPlays, duplicateCount: appleDedupeCount } =
    deduplicateAppleEvents(passedPlays);

  if (appleDedupeCount > 0) {
    console.log(`[INFO] Removed ${appleDedupeCount} duplicate Apple events`);
  }

  // Apply limit if specified
  let playsToProcess = dedupedPlays;
  if (cliArgs.limit && cliArgs.limit < playsToProcess.length) {
    playsToProcess = playsToProcess.slice(0, cliArgs.limit);
    console.log(`[INFO] Limited to ${cliArgs.limit} plays`);
  }

  // Sort by timestamp ascending (oldest first)
  playsToProcess.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Load existing scrobbles for dedup
  const scrobbleDedupSet = await loadExistingScrobbles(cfToken);

  // Check for duplicates against existing Last.fm scrobbles
  let existingDupeCount = 0;
  const newPlays: ApplePlay[] = [];
  for (const play of playsToProcess) {
    if (isDuplicateScrobble(scrobbleDedupSet, play.artistName, play.trackName, play.timestamp)) {
      existingDupeCount++;
    } else {
      newPlays.push(play);
    }
  }

  console.log(`[INFO] Duplicate with existing scrobbles: ${existingDupeCount}`);
  console.log(`[INFO] Net new plays to import: ${newPlays.length}`);

  // --- Dry run report ---
  if (cliArgs.dryRun) {
    console.log('\n--- DRY RUN REPORT ---');
    console.log(`Total CSV rows: ${rawRows.length}`);
    console.log(`Valid rows with timestamps: ${allPlays.length}`);
    console.log('\nRows rejected by filter:');
    for (const [reason, count] of Object.entries(filterStats).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count}`);
    }
    console.log(`\nApple event duplicates removed: ${appleDedupeCount}`);
    console.log(`Duplicates with existing Last.fm scrobbles: ${existingDupeCount}`);
    console.log(`Net new plays to import: ${newPlays.length}`);

    if (newPlays.length > 0) {
      const dates = newPlays.map(p => p.timestamp);
      console.log(`\nDate range: ${dates[0]} to ${dates[dates.length - 1]}`);

      // Top 20 artists by play count
      const artistCounts = new Map<string, number>();
      for (const play of newPlays) {
        artistCounts.set(play.artistName, (artistCounts.get(play.artistName) ?? 0) + 1);
      }
      const topArtists = [...artistCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

      console.log('\nTop 20 artists by new play count:');
      for (const [artist, count] of topArtists) {
        console.log(`  ${count} plays - ${artist}`);
      }

      // Sample of 10 plays
      console.log('\nSample of plays that would be inserted:');
      const sample = newPlays.slice(0, 10);
      for (const play of sample) {
        console.log(`  ${play.timestamp} | ${play.artistName} - ${play.trackName} (${play.albumName || 'no album'})`);
      }
    }

    console.log('\n--- END DRY RUN ---');
    return;
  }

  // --- Production mode ---
  if (newPlays.length === 0) {
    console.log('[INFO] No new plays to import. Done.');
    return;
  }

  // Preload entity caches
  await preloadCaches(cfToken);

  // Check for resume
  let startIndex = 0;
  if (cliArgs.resume) {
    const checkpoint = loadCheckpoint();
    if (checkpoint && checkpoint.csvHash === csvHash) {
      startIndex = checkpoint.processedIndex;
      console.log(`[INFO] Resuming from index ${startIndex} (${checkpoint.totalInserted} previously inserted)`);
    } else if (checkpoint) {
      console.log('[INFO] CSV file changed since last checkpoint. Starting from beginning.');
    }
  }

  // Convert to ParsedPlay objects
  const parsedPlays: ParsedPlay[] = newPlays.map(play => ({
    trackName: play.trackName,
    artistName: play.artistName,
    albumName: play.albumName,
    scrobbledAt: new Date(play.timestamp).toISOString(),
    filtered: checkFiltered(play.artistName, play.albumName, play.trackName),
  }));

  let totalInserted = 0;
  let batchCount = 0;

  for (let i = startIndex; i < parsedPlays.length; i += BATCH_SIZE) {
    const batch = parsedPlays.slice(i, i + BATCH_SIZE);

    // Batch upsert in foreign key order
    await batchUpsertArtists(batch, cfToken);
    await batchUpsertAlbums(batch, cfToken);
    await batchUpsertTracks(batch, cfToken);
    const inserted = await batchInsertScrobbles(batch, cfToken);
    totalInserted += inserted;
    batchCount++;

    const progress = Math.min(i + BATCH_SIZE, parsedPlays.length);
    console.log(
      `[INFO] Batch ${batchCount}: ${inserted} scrobbles. Progress: ${progress}/${parsedPlays.length}. Total inserted: ${totalInserted}`
    );

    // Save checkpoint every 10 batches
    if (batchCount % 10 === 0) {
      saveCheckpoint({
        totalPlays: parsedPlays.length,
        processedIndex: progress,
        totalInserted,
        csvHash,
      });
    }

    // Brief pause between batches to avoid rate limits
    await sleep(100);
  }

  // Final checkpoint save
  saveCheckpoint({
    totalPlays: parsedPlays.length,
    processedIndex: parsedPlays.length,
    totalInserted,
    csvHash,
  });

  console.log('[SUCCESS] Apple Music import completed');
  console.log(`[INFO] Total inserted: ${totalInserted} scrobbles`);
  console.log(
    `[INFO] Cached entities: ${artistCache.size} artists, ${albumCache.size} albums, ${trackCache.size} tracks`
  );
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
