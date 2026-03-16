/**
 * Apple Music Historical Import Script
 *
 * One-time script to import Apple Music listening history from Apple's
 * "Play History Daily Tracks" CSV (privacy data export) into the remote
 * D1 database. Uses the Apple Music Track Identifiers in the CSV to do
 * deterministic batch lookups via the iTunes API, resolving full metadata
 * (artist, album, URLs, duration, preview) in ~21 API calls.
 *
 * Inserts into the existing lastfm_* tables so all listening data lives
 * in one place. Fully enriches artists, albums, and tracks with Apple
 * Music IDs/URLs on insert — no separate backfill step needed.
 *
 * Prerequisites:
 *   1. .dev.vars exists (not used for secrets, but required by convention)
 *   2. Ensure wrangler is authenticated (`npx wrangler login`)
 *   3. Apple Music CSV exported via https://privacy.apple.com
 *      File: "Apple Music - Play History Daily Tracks.csv"
 *
 * Usage:
 *   npx tsx scripts/import-apple-music.ts <path-to-csv>
 *   npx tsx scripts/import-apple-music.ts <path-to-csv> --dry-run
 *   npx tsx scripts/import-apple-music.ts <path-to-csv> --resume
 *   npx tsx scripts/import-apple-music.ts <path-to-csv> --limit 100
 *   npx tsx scripts/import-apple-music.ts <path-to-csv> --include-skips
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
const DB_BATCH_SIZE = 200;
const ITUNES_LOOKUP_BATCH_SIZE = 200;
const DEFAULT_MIN_DURATION_MS = 30_000;

// End reasons that represent actual listens (not skips/errors)
const LISTEN_END_REASONS = new Set([
  'NATURAL_END_OF_TRACK',
  'PLAYBACK_MANUALLY_PAUSED',
  'MANUALLY_SELECTED_PLAYBACK_OF_A_DIFF_ITEM',
  'PLAYBACK_SUSPENDED',
  'OTHER',
  'EXITED_APPLICATION',
]);

const SKIP_END_REASONS = new Set([
  'TRACK_SKIPPED_FORWARDS',
  'TRACK_SKIPPED_BACKWARDS',
  'SCRUB_BEGIN',
  'FAILED_TO_LOAD',
]);

// --- Filter patterns (mirrored from src/services/lastfm/filters.ts) ---

const HOLIDAY_ALBUM_PATTERNS = [
  'charlie brown christmas',
  'merry christmas',
  'white christmas',
  'christmas album',
  'holiday',
  'christmas songs',
];

const HOLIDAY_TRACK_PATTERNS = [
  'jingle bell',
  'silent night',
  'santa claus',
  'deck the hall',
  'rudolph',
  'frosty the snowman',
  'winter wonderland',
  'o holy night',
  'little drummer boy',
  'away in a manger',
  'hark the herald',
  'o come all ye faithful',
  'we wish you a merry',
  'sleigh ride',
  'silver bells',
  'blue christmas',
  'last christmas',
  'christmas time',
  'holly jolly',
  'joy to the world',
];

const HOLIDAY_ARTIST_TRACKS = [
  { artist: 'vince guaraldi', track: 'skating' },
  { artist: 'vince guaraldi', track: 'greensleeves' },
  { artist: 'vince guaraldi', track: 'linus and lucy' },
];

const AUDIOBOOK_ARTISTS = [
  'stephen king',
  'thomas pynchon',
  'hunter s. thompson',
  'andy weir',
];

const AUDIOBOOK_TRACK_PATTERNS = ['libby--open-'];
const AUDIOBOOK_TRACK_REGEXES = [
  /- Part \d+/i,
  /- Track \d+/i,
  /- \d{2,3}$/,
  / \(\d+\)$/,
];

function checkFiltered(
  artistName: string,
  albumName: string,
  trackName: string
): boolean {
  const artistLower = artistName.toLowerCase();
  const albumLower = albumName.toLowerCase();
  const trackLower = trackName.toLowerCase();

  for (const p of HOLIDAY_ALBUM_PATTERNS) {
    if (albumLower.includes(p)) return true;
  }
  for (const p of HOLIDAY_TRACK_PATTERNS) {
    if (trackLower.includes(p)) return true;
  }
  for (const entry of HOLIDAY_ARTIST_TRACKS) {
    if (artistLower.includes(entry.artist) && trackLower === entry.track)
      return true;
  }
  for (const a of AUDIOBOOK_ARTISTS) {
    if (artistLower === a) return true;
  }
  for (const p of AUDIOBOOK_TRACK_PATTERNS) {
    if (trackLower.includes(p)) return true;
  }
  for (const regex of AUDIOBOOK_TRACK_REGEXES) {
    if (regex.test(trackName)) return true;
  }
  return false;
}

// --- Types ---

interface CsvRow {
  Country: string;
  'Track Identifier': string;
  'Media type': string;
  'Date Played': string; // YYYYMMDD
  Hours: string; // e.g. "15" or "15, 21"
  'Play Duration Milliseconds': string;
  'End Reason Type': string;
  'Source Type': string;
  'Play Count': string;
  'Skip Count': string;
  'Ignore For Recommendations': string;
  'Track Reference': string;
  'Track Description': string; // "Artist - Track" or just track name
}

interface iTunesTrackResult {
  trackId: number;
  trackName: string;
  artistName: string;
  artistId: number;
  collectionName?: string;
  collectionId?: number;
  trackViewUrl: string;
  artistViewUrl: string;
  collectionViewUrl?: string;
  previewUrl?: string;
  trackTimeMillis: number;
  artworkUrl100?: string;
  wrapperType: string;
}

interface ResolvedTrack {
  appleTrackId: number;
  trackName: string;
  artistName: string;
  artistId: number;
  albumName: string;
  albumId: number | null;
  trackViewUrl: string;
  artistViewUrl: string;
  albumViewUrl: string;
  previewUrl: string;
  durationMs: number;
}

interface ParsedPlay {
  trackName: string;
  artistName: string;
  albumName: string;
  scrobbledAt: string;
  filtered: boolean;
  appleTrackId: number;
  appleArtistId: number;
  appleAlbumId: number | null;
  trackViewUrl: string;
  artistViewUrl: string;
  albumViewUrl: string;
  previewUrl: string;
  durationMs: number;
}

interface Checkpoint {
  totalPlays: number;
  processedIndex: number;
  totalInserted: number;
  csvHash: string;
}

// In-memory caches (loaded from DB)
const artistCache: Map<string, number> = new Map(); // lowercase name -> db id
const albumCache: Map<string, number> = new Map(); // "name_lower|artistId" -> db id
const trackCache: Map<string, number> = new Map(); // "name_lower|artistId" -> db id

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
    console.error(
      '[ERROR] Wrangler config not found. Run `npx wrangler login` first.'
    );
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

async function d1Query(
  sql: string,
  cfToken: string
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(D1_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`D1 API error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    errors?: Array<{ message: string }>;
    result: Array<{ results: Array<Record<string, unknown>> }>;
  };

  if (!data.success) {
    const errMsg =
      data.errors?.map((e) => e.message).join(', ') ?? 'Unknown error';
    throw new Error(`D1 query failed: ${errMsg}`);
  }

  return data.result?.[0]?.results ?? [];
}

async function executeSQL(sql: string, cfToken: string): Promise<void> {
  await d1Query(sql, cfToken);
}

async function queryRows(
  sql: string,
  cfToken: string
): Promise<Array<Record<string, unknown>>> {
  try {
    return await d1Query(sql, cfToken);
  } catch (err) {
    console.error(`[ERROR] queryRows failed: ${err}`);
    return [];
  }
}

// --- CSV parsing ---

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

function parseDailyTracksCsv(content: string): CsvRow[] {
  if (content.charCodeAt(0) === 0xfeff) {
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
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = fields[j] ?? '';
    }
    rows.push(row as unknown as CsvRow);
  }

  return rows;
}

// --- iTunes batch lookup ---

/**
 * Resolve track metadata via iTunes Lookup API.
 * Batches up to 200 IDs per request. Returns a map of trackId -> result.
 */
async function batchLookupTracks(
  trackIds: number[]
): Promise<Map<number, iTunesTrackResult>> {
  const results = new Map<number, iTunesTrackResult>();
  const batches: number[][] = [];

  for (let i = 0; i < trackIds.length; i += ITUNES_LOOKUP_BATCH_SIZE) {
    batches.push(trackIds.slice(i, i + ITUNES_LOOKUP_BATCH_SIZE));
  }

  console.log(
    `[INFO] Resolving ${trackIds.length} unique tracks via iTunes API (${batches.length} batches)`
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const url = `https://itunes.apple.com/lookup?id=${batch.join(',')}&entity=song`;

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'RewindAPI/1.0' },
      });

      if (response.status === 403) {
        console.log(`[WARN] Rate limited on batch ${i + 1}, waiting 60s...`);
        await sleep(60_000);
        i--; // Retry this batch
        continue;
      }

      if (!response.ok) {
        console.error(
          `[ERROR] iTunes API returned ${response.status} on batch ${i + 1}`
        );
        continue;
      }

      const data = (await response.json()) as {
        resultCount: number;
        results: iTunesTrackResult[];
      };

      for (const track of data.results) {
        if (track.wrapperType === 'track' && track.trackId) {
          results.set(track.trackId, track);
        }
      }

      const resolved = data.results.filter(
        (r) => r.wrapperType === 'track'
      ).length;
      console.log(
        `[INFO] Batch ${i + 1}/${batches.length}: resolved ${resolved}/${batch.length} tracks`
      );
    } catch (err) {
      console.error(`[ERROR] iTunes API batch ${i + 1} failed: ${err}`);
    }

    // Brief pause between batches to be polite
    if (i < batches.length - 1) {
      await sleep(1_000);
    }
  }

  return results;
}

// --- Timestamp construction ---

/**
 * Build an ISO 8601 timestamp from the Daily Tracks CSV row.
 * Date is YYYYMMDD, Hours is the hour of day (or comma-separated list).
 * We use the first (earliest) hour listed. Minute/second set to :00:00.
 */
function buildTimestamp(datePlayed: string, hours: string): string {
  const year = datePlayed.slice(0, 4);
  const month = datePlayed.slice(4, 6);
  const day = datePlayed.slice(6, 8);

  // Parse hours - could be "15" or "15, 21" (multi-hour listening)
  // Use the first (earliest) hour for the scrobble timestamp
  const hourParts = hours
    .split(',')
    .map((h) => parseInt(h.trim(), 10))
    .filter((h) => !isNaN(h));
  const hour = hourParts.length > 0 ? Math.min(...hourParts) : 12;
  const hourStr = hour.toString().padStart(2, '0');

  return `${year}-${month}-${day}T${hourStr}:00:00.000Z`;
}

// --- Deduplication ---

function truncateToMinute(isoStr: string): number {
  const d = new Date(isoStr);
  d.setSeconds(0, 0);
  return d.getTime();
}

function buildScrobbleDedupSet(
  scrobbles: Array<{
    track_name: string;
    artist_name: string;
    scrobbled_at: string;
  }>
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

/**
 * Check for duplicate with existing scrobbles.
 * Since Daily Tracks timestamps are hour-level (XX:00:00), we check
 * a wider window: the entire hour (60 minutes around the timestamp).
 */
function isDuplicateScrobble(
  dedupSet: Set<string>,
  artistName: string,
  trackName: string,
  timestamp: string
): boolean {
  const artistLower = artistName.toLowerCase();
  const trackLower = trackName.toLowerCase();
  const baseTs = truncateToMinute(timestamp);

  // Check 60-minute window (30 minutes before/after the hour mark)
  for (let offset = -30 * 60_000; offset <= 30 * 60_000; offset += 60_000) {
    if (dedupSet.has(`${artistLower}|${trackLower}|${baseTs + offset}`)) {
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
  const rows = await queryRows(
    `SELECT ${cols} FROM ${table}${whereClause};`,
    cfToken
  );
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

async function loadAllArtists(
  cfToken: string,
  incremental = false
): Promise<void> {
  const minId = incremental ? getMaxCacheId(artistCache) : 0;
  await loadEntities(
    'lastfm_artists',
    artistCache,
    (row) => (row.name ? (row.name as string).toLowerCase() : null),
    cfToken,
    minId
  );
}

async function loadAllAlbums(
  cfToken: string,
  incremental = false
): Promise<void> {
  const minId = incremental ? getMaxCacheId(albumCache) : 0;
  await loadEntities(
    'lastfm_albums',
    albumCache,
    (row) =>
      row.name
        ? `${(row.name as string).toLowerCase()}|${row.artist_id}`
        : null,
    cfToken,
    minId
  );
}

async function loadAllTracks(
  cfToken: string,
  incremental = false
): Promise<void> {
  const minId = incremental ? getMaxCacheId(trackCache) : 0;
  await loadEntities(
    'lastfm_tracks',
    trackCache,
    (row) =>
      row.name
        ? `${(row.name as string).toLowerCase()}|${row.artist_id}`
        : null,
    cfToken,
    minId
  );
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
    rows as Array<{
      track_name: string;
      artist_name: string;
      scrobbled_at: string;
    }>
  );
}

// --- Batch upsert operations ---

/**
 * Insert new artists with full Apple Music enrichment data.
 */
async function batchUpsertArtists(
  plays: ParsedPlay[],
  cfToken: string
): Promise<void> {
  const newArtists = new Map<string, ParsedPlay>();
  for (const p of plays) {
    const key = p.artistName.toLowerCase();
    if (!artistCache.has(key) && !newArtists.has(key)) {
      newArtists.set(key, p);
    }
  }
  if (newArtists.size === 0) return;

  const now = new Date().toISOString();
  const values = [...newArtists.values()]
    .map(
      (p) =>
        `(1, ${escapeSQL(p.artistName)}, NULL, '', 0, ${p.filtered ? 1 : 0}, ` +
        `${p.appleArtistId || 'NULL'}, ${escapeSQL(p.artistViewUrl || null)}, ${escapeSQL(now)}, ` +
        `${escapeSQL(now)}, ${escapeSQL(now)})`
    )
    .join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_artists (user_id, name, mbid, url, playcount, is_filtered, apple_music_id, apple_music_url, itunes_enriched_at, created_at, updated_at) VALUES\n${values};`,
      cfToken
    );
  } catch (err) {
    console.error(`[ERROR] Artist batch insert failed: ${err}`);
    return;
  }

  // Also update existing artists that lack Apple Music enrichment
  for (const p of newArtists.values()) {
    if (p.appleArtistId && artistCache.has(p.artistName.toLowerCase())) {
      const dbId = artistCache.get(p.artistName.toLowerCase());
      try {
        await executeSQL(
          `UPDATE lastfm_artists SET apple_music_id = ${p.appleArtistId}, ` +
            `apple_music_url = ${escapeSQL(p.artistViewUrl || null)}, ` +
            `itunes_enriched_at = ${escapeSQL(now)} ` +
            `WHERE id = ${dbId} AND apple_music_id IS NULL;`,
          cfToken
        );
      } catch {
        // Non-critical, continue
      }
    }
  }

  await loadAllArtists(cfToken, true);
}

/**
 * Insert new albums with full Apple Music enrichment data.
 */
async function batchUpsertAlbums(
  plays: ParsedPlay[],
  cfToken: string
): Promise<void> {
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
  const values = [...newAlbums.values()]
    .map(
      ({ p, artistId }) =>
        `(1, ${escapeSQL(p.albumName)}, NULL, ${artistId}, '', 0, ${p.filtered ? 1 : 0}, ` +
        `${p.appleAlbumId || 'NULL'}, ${escapeSQL(p.albumViewUrl || null)}, ${escapeSQL(now)}, ` +
        `${escapeSQL(now)}, ${escapeSQL(now)})`
    )
    .join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_albums (user_id, name, mbid, artist_id, url, playcount, is_filtered, apple_music_id, apple_music_url, itunes_enriched_at, created_at, updated_at) VALUES\n${values};`,
      cfToken
    );
  } catch (err) {
    console.error(`[ERROR] Album batch insert failed: ${err}`);
    return;
  }

  // Update existing albums that lack Apple Music enrichment
  for (const { p, artistId } of newAlbums.values()) {
    const key = `${p.albumName.toLowerCase()}|${artistId}`;
    if (p.appleAlbumId && albumCache.has(key)) {
      const dbId = albumCache.get(key);
      try {
        await executeSQL(
          `UPDATE lastfm_albums SET apple_music_id = ${p.appleAlbumId}, ` +
            `apple_music_url = ${escapeSQL(p.albumViewUrl || null)}, ` +
            `itunes_enriched_at = ${escapeSQL(now)} ` +
            `WHERE id = ${dbId} AND apple_music_id IS NULL;`,
          cfToken
        );
      } catch {
        // Non-critical, continue
      }
    }
  }

  await loadAllAlbums(cfToken, true);
}

/**
 * Insert new tracks with full Apple Music enrichment data (including
 * duration_ms, apple_music_id, apple_music_url, preview_url).
 */
async function batchUpsertTracks(
  plays: ParsedPlay[],
  cfToken: string
): Promise<void> {
  const newTracks = new Map<
    string,
    { p: ParsedPlay; artistId: number; albumId: number | null }
  >();
  for (const p of plays) {
    const artistId = artistCache.get(p.artistName.toLowerCase());
    if (!artistId) continue;
    const key = `${p.trackName.toLowerCase()}|${artistId}`;
    if (trackCache.has(key) || newTracks.has(key)) continue;

    const albumId = p.albumName
      ? (albumCache.get(`${p.albumName.toLowerCase()}|${artistId}`) ?? null)
      : null;

    newTracks.set(key, { p, artistId, albumId });
  }
  if (newTracks.size === 0) return;

  const now = new Date().toISOString();
  const values = [...newTracks.values()]
    .map(
      ({ p, artistId, albumId }) =>
        `(1, ${escapeSQL(p.trackName)}, NULL, ${artistId}, ${albumId ?? 'NULL'}, '', ` +
        `${p.durationMs || 'NULL'}, ${p.filtered ? 1 : 0}, ` +
        `${p.appleTrackId || 'NULL'}, ${escapeSQL(p.trackViewUrl || null)}, ${escapeSQL(p.previewUrl || null)}, ` +
        `${escapeSQL(now)}, ${escapeSQL(now)}, ${escapeSQL(now)})`
    )
    .join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_tracks (user_id, name, mbid, artist_id, album_id, url, duration_ms, is_filtered, apple_music_id, apple_music_url, preview_url, itunes_enriched_at, created_at, updated_at) VALUES\n${values};`,
      cfToken
    );
  } catch (err) {
    console.error(`[ERROR] Track batch insert failed: ${err}`);
    return;
  }

  // Update existing tracks that lack Apple Music enrichment or duration
  for (const { p, artistId } of newTracks.values()) {
    const key = `${p.trackName.toLowerCase()}|${artistId}`;
    if (p.appleTrackId && trackCache.has(key)) {
      const dbId = trackCache.get(key);
      const updates: string[] = [];
      if (p.appleTrackId) updates.push(`apple_music_id = ${p.appleTrackId}`);
      if (p.trackViewUrl)
        updates.push(`apple_music_url = ${escapeSQL(p.trackViewUrl)}`);
      if (p.previewUrl)
        updates.push(`preview_url = ${escapeSQL(p.previewUrl)}`);
      if (p.durationMs)
        updates.push(`duration_ms = COALESCE(duration_ms, ${p.durationMs})`);
      updates.push(`itunes_enriched_at = ${escapeSQL(now)}`);

      try {
        await executeSQL(
          `UPDATE lastfm_tracks SET ${updates.join(', ')} ` +
            `WHERE id = ${dbId} AND apple_music_id IS NULL;`,
          cfToken
        );
      } catch {
        // Non-critical, continue
      }
    }
  }

  await loadAllTracks(cfToken, true);
}

async function batchInsertScrobbles(
  plays: ParsedPlay[],
  cfToken: string
): Promise<number> {
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
  includeSkips: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter(
    (a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--limit'
  );

  if (positional.length === 0) {
    console.error(
      '[ERROR] Usage: npx tsx scripts/import-apple-music.ts <path-to-csv> [--dry-run] [--resume] [--limit N] [--include-skips]'
    );
    process.exit(1);
  }

  let limit: number | null = null;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10);
  }

  return {
    csvPath: resolve(positional[0]),
    dryRun: flags.has('--dry-run'),
    resume: flags.has('--resume'),
    limit,
    includeSkips: flags.has('--include-skips'),
  };
}

// --- Main ---

async function main() {
  const cliArgs = parseArgs();

  if (!existsSync(cliArgs.csvPath)) {
    console.error(`[ERROR] CSV file not found: ${cliArgs.csvPath}`);
    process.exit(1);
  }

  loadDevVars();
  const cfToken = loadCfToken();

  console.log('[INFO] Apple Music import starting');
  console.log(`[INFO] CSV: ${cliArgs.csvPath}`);
  console.log(`[INFO] Mode: ${cliArgs.dryRun ? 'DRY RUN' : 'PRODUCTION'}`);
  console.log(
    `[INFO] Skip handling: ${cliArgs.includeSkips ? 'including skipped tracks' : 'excluding skipped tracks'}`
  );
  if (cliArgs.limit) console.log(`[INFO] Limit: ${cliArgs.limit} plays`);

  // --- Phase 1: Parse CSV ---
  const csvContent = readFileSync(cliArgs.csvPath, 'utf-8');
  const csvHash = computeCsvHash(csvContent);
  const rawRows = parseDailyTracksCsv(csvContent);
  console.log(`[INFO] Parsed ${rawRows.length} CSV rows`);

  if (rawRows.length === 0) {
    console.error('[ERROR] No rows found in CSV');
    process.exit(1);
  }

  // --- Phase 2: Filter rows ---
  const filterStats: Record<string, number> = {};
  const validRows: CsvRow[] = [];

  for (const row of rawRows) {
    // Must be audio
    if (row['Media type']?.toUpperCase() !== 'AUDIO') {
      filterStats['media_type_not_audio'] =
        (filterStats['media_type_not_audio'] ?? 0) + 1;
      continue;
    }

    // Filter by end reason
    const endReason = row['End Reason Type'] || '';
    if (!cliArgs.includeSkips && SKIP_END_REASONS.has(endReason)) {
      filterStats['skipped_track'] = (filterStats['skipped_track'] ?? 0) + 1;
      continue;
    }

    if (
      !LISTEN_END_REASONS.has(endReason) &&
      !SKIP_END_REASONS.has(endReason)
    ) {
      filterStats[`unknown_end_reason_${endReason}`] =
        (filterStats[`unknown_end_reason_${endReason}`] ?? 0) + 1;
      continue;
    }

    // Filter zero-duration plays (immediate skips with 0ms listen time)
    const playDurationMs = parseInt(row['Play Duration Milliseconds'], 10) || 0;
    if (playDurationMs < DEFAULT_MIN_DURATION_MS) {
      filterStats['insufficient_play_duration'] =
        (filterStats['insufficient_play_duration'] ?? 0) + 1;
      continue;
    }

    // Must have a track identifier for lookup
    if (!row['Track Identifier']) {
      filterStats['missing_track_identifier'] =
        (filterStats['missing_track_identifier'] ?? 0) + 1;
      continue;
    }

    validRows.push(row);
  }

  console.log(`[INFO] Passed filters: ${validRows.length}`);
  if (Object.keys(filterStats).length > 0) {
    console.log('[INFO] Filtered out:');
    for (const [reason, count] of Object.entries(filterStats).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  // --- Phase 3: Collect unique track IDs and batch lookup ---
  const uniqueTrackIds = new Set<number>();
  for (const row of validRows) {
    uniqueTrackIds.add(parseInt(row['Track Identifier'], 10));
  }

  console.log(
    `[INFO] ${uniqueTrackIds.size} unique Apple Music track IDs to resolve`
  );

  const itunesResults = await batchLookupTracks([...uniqueTrackIds]);
  console.log(
    `[INFO] iTunes resolved ${itunesResults.size}/${uniqueTrackIds.size} tracks`
  );

  // Report unresolved tracks (removed from catalog, region-locked, etc.)
  const unresolvedIds = [...uniqueTrackIds].filter(
    (id) => !itunesResults.has(id)
  );
  if (unresolvedIds.length > 0) {
    console.log(
      `[WARN] ${unresolvedIds.length} tracks not found in iTunes catalog`
    );
    // Try to show what they are from the CSV descriptions
    const unresolvedSet = new Set(unresolvedIds);
    const unresolvedDescriptions = new Map<number, string>();
    for (const row of validRows) {
      const id = parseInt(row['Track Identifier'], 10);
      if (unresolvedSet.has(id) && !unresolvedDescriptions.has(id)) {
        unresolvedDescriptions.set(
          id,
          row['Track Description'] || '(no description)'
        );
      }
    }
    for (const [id, desc] of unresolvedDescriptions) {
      console.log(`  [WARN] Unresolved: ${id} - ${desc}`);
    }
  }

  // --- Phase 4: Build resolved plays ---
  const resolvedPlays: ParsedPlay[] = [];
  let unresolvedSkipCount = 0;

  for (const row of validRows) {
    const trackId = parseInt(row['Track Identifier'], 10);
    const itunes = itunesResults.get(trackId);

    if (!itunes) {
      // Track not in iTunes catalog — try fallback from Track Description
      const desc = row['Track Description'] || '';
      const dashIdx = desc.indexOf(' - ');
      if (dashIdx === -1) {
        unresolvedSkipCount++;
        continue;
      }
      const artistName = desc.slice(0, dashIdx);
      const trackName = desc.slice(dashIdx + 3);
      if (!artistName || !trackName) {
        unresolvedSkipCount++;
        continue;
      }

      const timestamp = buildTimestamp(row['Date Played'], row['Hours']);
      const filtered = checkFiltered(artistName, '', trackName);

      resolvedPlays.push({
        trackName,
        artistName,
        albumName: '',
        scrobbledAt: timestamp,
        filtered,
        appleTrackId: trackId,
        appleArtistId: 0,
        appleAlbumId: null,
        trackViewUrl: '',
        artistViewUrl: '',
        albumViewUrl: '',
        previewUrl: '',
        durationMs: 0,
      });
      continue;
    }

    const timestamp = buildTimestamp(row['Date Played'], row['Hours']);
    const albumName = itunes.collectionName ?? '';
    const filtered = checkFiltered(
      itunes.artistName,
      albumName,
      itunes.trackName
    );

    resolvedPlays.push({
      trackName: itunes.trackName,
      artistName: itunes.artistName,
      albumName,
      scrobbledAt: timestamp,
      filtered,
      appleTrackId: itunes.trackId,
      appleArtistId: itunes.artistId,
      appleAlbumId: itunes.collectionId ?? null,
      trackViewUrl: itunes.trackViewUrl ?? '',
      artistViewUrl: itunes.artistViewUrl ?? '',
      albumViewUrl: itunes.collectionViewUrl ?? '',
      previewUrl: itunes.previewUrl ?? '',
      durationMs: itunes.trackTimeMillis ?? 0,
    });
  }

  if (unresolvedSkipCount > 0) {
    console.log(
      `[WARN] Skipped ${unresolvedSkipCount} plays (unresolved + no parseable description)`
    );
  }
  console.log(`[INFO] Resolved plays: ${resolvedPlays.length}`);

  // --- Phase 5: Deduplicate ---

  // Dedup Apple events (same artist+track+hour)
  const seen = new Set<string>();
  const dedupedPlays: ParsedPlay[] = [];
  let appleDedupeCount = 0;

  for (const play of resolvedPlays) {
    const key = `${play.artistName.toLowerCase()}|${play.trackName.toLowerCase()}|${play.scrobbledAt}`;
    if (seen.has(key)) {
      appleDedupeCount++;
      continue;
    }
    seen.add(key);
    dedupedPlays.push(play);
  }

  if (appleDedupeCount > 0) {
    console.log(`[INFO] Removed ${appleDedupeCount} duplicate Apple events`);
  }

  // Apply limit
  let playsToProcess = dedupedPlays;
  if (cliArgs.limit && cliArgs.limit < playsToProcess.length) {
    playsToProcess = playsToProcess.slice(0, cliArgs.limit);
    console.log(`[INFO] Limited to ${cliArgs.limit} plays`);
  }

  // Sort by timestamp ascending
  playsToProcess.sort((a, b) => a.scrobbledAt.localeCompare(b.scrobbledAt));

  // Dedup against existing scrobbles
  const scrobbleDedupSet = await loadExistingScrobbles(cfToken);
  let existingDupeCount = 0;
  const newPlays: ParsedPlay[] = [];

  for (const play of playsToProcess) {
    if (
      isDuplicateScrobble(
        scrobbleDedupSet,
        play.artistName,
        play.trackName,
        play.scrobbledAt
      )
    ) {
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
    console.log(`Passed filters: ${validRows.length}`);
    console.log(
      `iTunes resolved: ${itunesResults.size}/${uniqueTrackIds.size}`
    );
    console.log(`Resolved plays: ${resolvedPlays.length}`);
    console.log(`Apple event duplicates removed: ${appleDedupeCount}`);
    console.log(`Duplicates with existing scrobbles: ${existingDupeCount}`);
    console.log(`Net new plays to import: ${newPlays.length}`);

    if (newPlays.length > 0) {
      console.log(
        `\nDate range: ${newPlays[0].scrobbledAt} to ${newPlays[newPlays.length - 1].scrobbledAt}`
      );

      // Unique artists/albums/tracks counts
      const uniqueArtists = new Set(
        newPlays.map((p) => p.artistName.toLowerCase())
      );
      const uniqueAlbums = new Set(
        newPlays
          .filter((p) => p.albumName)
          .map(
            (p) => `${p.albumName.toLowerCase()}|${p.artistName.toLowerCase()}`
          )
      );
      const uniqueTracks = new Set(
        newPlays.map(
          (p) => `${p.trackName.toLowerCase()}|${p.artistName.toLowerCase()}`
        )
      );
      console.log(
        `\nUnique entities: ${uniqueArtists.size} artists, ${uniqueAlbums.size} albums, ${uniqueTracks.size} tracks`
      );

      // Enrichment stats
      const withAppleId = newPlays.filter((p) => p.appleTrackId > 0).length;
      const withPreview = newPlays.filter((p) => p.previewUrl).length;
      const withDuration = newPlays.filter((p) => p.durationMs > 0).length;
      const withAlbumUrl = newPlays.filter((p) => p.albumViewUrl).length;
      console.log(
        `\nEnrichment coverage: ${withAppleId} apple_music_id, ${withPreview} preview_url, ${withDuration} duration_ms, ${withAlbumUrl} album_url`
      );

      // Top 20 artists by play count
      const artistCounts = new Map<string, number>();
      for (const play of newPlays) {
        artistCounts.set(
          play.artistName,
          (artistCounts.get(play.artistName) ?? 0) + 1
        );
      }
      const topArtists = [...artistCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

      console.log('\nTop 20 artists by new play count:');
      for (const [artist, count] of topArtists) {
        console.log(`  ${count} plays - ${artist}`);
      }

      // Sample plays
      console.log('\nSample plays:');
      const sample = newPlays.slice(0, 10);
      for (const play of sample) {
        console.log(
          `  ${play.scrobbledAt} | ${play.artistName} - ${play.trackName} (${play.albumName || 'no album'}) [AM:${play.appleTrackId}, dur:${play.durationMs}ms]`
        );
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

  await preloadCaches(cfToken);

  // Check for resume
  let startIndex = 0;
  if (cliArgs.resume) {
    const checkpoint = loadCheckpoint();
    if (checkpoint && checkpoint.csvHash === csvHash) {
      startIndex = checkpoint.processedIndex;
      console.log(
        `[INFO] Resuming from index ${startIndex} (${checkpoint.totalInserted} previously inserted)`
      );
    } else if (checkpoint) {
      console.log(
        '[INFO] CSV file changed since last checkpoint. Starting from beginning.'
      );
    }
  }

  let totalInserted = 0;
  let batchCount = 0;

  for (let i = startIndex; i < newPlays.length; i += DB_BATCH_SIZE) {
    const batch = newPlays.slice(i, i + DB_BATCH_SIZE);

    // Batch upsert in foreign key order
    await batchUpsertArtists(batch, cfToken);
    await batchUpsertAlbums(batch, cfToken);
    await batchUpsertTracks(batch, cfToken);
    const inserted = await batchInsertScrobbles(batch, cfToken);
    totalInserted += inserted;
    batchCount++;

    const progress = Math.min(i + DB_BATCH_SIZE, newPlays.length);
    console.log(
      `[INFO] Batch ${batchCount}: ${inserted} scrobbles. Progress: ${progress}/${newPlays.length}. Total inserted: ${totalInserted}`
    );

    // Save checkpoint every 10 batches
    if (batchCount % 10 === 0) {
      saveCheckpoint({
        totalPlays: newPlays.length,
        processedIndex: progress,
        totalInserted,
        csvHash,
      });
    }

    await sleep(100);
  }

  // Final checkpoint
  saveCheckpoint({
    totalPlays: newPlays.length,
    processedIndex: newPlays.length,
    totalInserted,
    csvHash,
  });

  console.log('[SUCCESS] Apple Music import completed');
  console.log(`[INFO] Total inserted: ${totalInserted} scrobbles`);
  console.log(
    `[INFO] Cached entities: ${artistCache.size} artists, ${albumCache.size} albums, ${trackCache.size} tracks`
  );
  console.log('');
  console.log('[INFO] Next steps:');
  console.log(
    '  1. Trigger a listening sync to update search index and activity feed:'
  );
  console.log(
    '     curl -X POST -H "Authorization: Bearer $API_KEY" https://api.rewind.rest/v1/admin/sync/listening'
  );
  console.log(
    '  2. If Apple Music-only artists need indexing, run search backfill:'
  );
  console.log(
    "     npx wrangler d1 execute rewind-db --remote --command \"INSERT OR IGNORE INTO search_index (domain, entity_type, entity_id, title) SELECT 'listening', 'artist', CAST(id AS TEXT), name FROM lastfm_artists WHERE id NOT IN (SELECT CAST(entity_id AS INTEGER) FROM search_index WHERE domain = 'listening' AND entity_type = 'artist')\""
  );
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
