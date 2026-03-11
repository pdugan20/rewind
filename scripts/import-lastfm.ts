/**
 * Last.fm Historical Import Script
 *
 * One-time script to import full Last.fm scrobble history into the remote D1
 * database. Handles the full artist->album->track->scrobble foreign key chain,
 * applies holiday/audiobook filters, and supports checkpoint/resume.
 *
 * Uses batched SQL operations (one wrangler call per entity type per page)
 * instead of individual calls per scrobble, for ~200x throughput improvement.
 *
 * Prerequisites:
 *   1. .dev.vars contains LASTFM_API_KEY and LASTFM_USERNAME
 *   2. Ensure wrangler is authenticated (`npx wrangler login`).
 *
 * Usage:
 *   npx tsx scripts/import-lastfm.ts
 *
 * Resume from checkpoint:
 *   npx tsx scripts/import-lastfm.ts --resume
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CF_ACCOUNT_ID = '46bcea726724fbab7d60f236f151f3d3';
const CF_DATABASE_ID = '35a4edf8-0d4f-4cbe-9a6e-6f1525716774';
const D1_API_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;
const LASTFM_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const CHECKPOINT_FILE = resolve(
  import.meta.dirname ?? '.',
  '.lastfm-checkpoint.json'
);
const RATE_LIMIT_MS = 200; // 5 req/sec
const BATCH_SIZE = 200; // Max per page from Last.fm API

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

interface LastfmRecentTrack {
  artist: { mbid: string; '#text': string };
  name: string;
  mbid: string;
  album: { mbid: string; '#text': string };
  url: string;
  date?: { uts: string; '#text': string };
  '@attr'?: { nowplaying: string };
}

interface Checkpoint {
  totalPages: number;
  completedPages: number[];
  totalScrobbles: number;
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

const devVars = loadDevVars();
const apiKey = devVars.LASTFM_API_KEY;
const username = devVars.LASTFM_USERNAME;

if (!apiKey || !username) {
  console.error('[ERROR] LASTFM_API_KEY and LASTFM_USERNAME required in .dev.vars');
  process.exit(1);
}

// Load Cloudflare OAuth token from wrangler config
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

const cfToken = loadCfToken();

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeSQL(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

async function d1Query(sql: string): Promise<Array<Record<string, unknown>>> {
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

async function executeSQL(sql: string): Promise<void> {
  await d1Query(sql);
}

async function queryRows(sql: string): Promise<Array<Record<string, unknown>>> {
  try {
    return await d1Query(sql);
  } catch (err) {
    console.error(`[ERROR] queryRows failed: ${err}`);
    return [];
  }
}

// --- Cache loading from DB ---

async function loadEntities(
  table: string,
  cache: Map<string, number>,
  keyFn: (row: Record<string, unknown>) => string | null,
  minId = 0
): Promise<void> {
  const whereClause = minId > 0 ? ` WHERE id > ${minId}` : '';
  const cols = table === 'lastfm_artists' ? 'id, name' : 'id, name, artist_id';
  const rows = await queryRows(`SELECT ${cols} FROM ${table}${whereClause};`);
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

async function loadAllArtists(incremental = false): Promise<void> {
  const minId = incremental ? getMaxCacheId(artistCache) : 0;
  await loadEntities('lastfm_artists', artistCache, (row) =>
    row.name ? (row.name as string).toLowerCase() : null, minId);
}

async function loadAllAlbums(incremental = false): Promise<void> {
  const minId = incremental ? getMaxCacheId(albumCache) : 0;
  await loadEntities('lastfm_albums', albumCache, (row) =>
    row.name ? `${(row.name as string).toLowerCase()}|${row.artist_id}` : null, minId);
}

async function loadAllTracks(incremental = false): Promise<void> {
  const minId = incremental ? getMaxCacheId(trackCache) : 0;
  await loadEntities('lastfm_tracks', trackCache, (row) =>
    row.name ? `${(row.name as string).toLowerCase()}|${row.artist_id}` : null, minId);
}

async function preloadCaches(): Promise<void> {
  console.log('[INFO] Preloading entity caches from DB...');
  await loadAllArtists();
  console.log(`[INFO] Preloaded ${artistCache.size} artists`);
  await loadAllAlbums();
  console.log(`[INFO] Preloaded ${albumCache.size} albums`);
  await loadAllTracks();
  console.log(`[INFO] Preloaded ${trackCache.size} tracks`);
}

// --- Last.fm API ---

async function fetchRecentTracks(
  page: number,
  limit: number = BATCH_SIZE
): Promise<{ tracks: LastfmRecentTrack[]; totalPages: number; total: number }> {
  const params = new URLSearchParams({
    method: 'user.getrecenttracks',
    user: username,
    api_key: apiKey,
    format: 'json',
    limit: String(limit),
    page: String(page),
  });

  const response = await fetch(`${LASTFM_BASE_URL}?${params}`);

  if (response.status === 429) {
    console.log('[RATE] Last.fm rate limited. Waiting 60 seconds...');
    await sleep(60_000);
    return fetchRecentTracks(page, limit);
  }

  if (!response.ok) {
    throw new Error(`Last.fm API error (${response.status}): ${await response.text()}`);
  }

  const data = await response.json() as {
    recenttracks: {
      track: LastfmRecentTrack[];
      '@attr': { totalPages: string; total: string };
    };
  };

  return {
    tracks: data.recenttracks.track,
    totalPages: parseInt(data.recenttracks['@attr'].totalPages, 10),
    total: parseInt(data.recenttracks['@attr'].total, 10),
  };
}

// --- Batch page processing ---

interface ParsedScrobble {
  artistName: string;
  artistMbid: string | null;
  artistUrl: string;
  albumName: string;
  albumMbid: string | null;
  trackName: string;
  trackMbid: string | null;
  trackUrl: string;
  scrobbledAt: string;
  filtered: boolean;
}

function parsePageTracks(tracks: LastfmRecentTrack[]): ParsedScrobble[] {
  const parsed: ParsedScrobble[] = [];
  for (const track of tracks) {
    if (track['@attr']?.nowplaying === 'true') continue;
    if (!track.date?.uts) continue;

    const artistName = track.artist['#text'];
    const trackName = track.name;
    if (!artistName || !trackName) continue;

    const albumName = track.album['#text'] || '';
    const scrobbledAt = new Date(parseInt(track.date.uts, 10) * 1000).toISOString();
    const artistUrl = track.url ? track.url.split('/').slice(0, -2).join('/') : '';

    parsed.push({
      artistName,
      artistMbid: track.artist.mbid || null,
      artistUrl,
      albumName,
      albumMbid: track.album.mbid || null,
      trackName,
      trackMbid: track.mbid || null,
      trackUrl: track.url || '',
      scrobbledAt,
      filtered: checkFiltered(artistName, albumName, trackName),
    });
  }
  return parsed;
}

async function batchUpsertArtists(scrobbles: ParsedScrobble[]): Promise<void> {
  const newArtists = new Map<string, ParsedScrobble>();
  for (const s of scrobbles) {
    const key = s.artistName.toLowerCase();
    if (!artistCache.has(key) && !newArtists.has(key)) {
      newArtists.set(key, s);
    }
  }
  if (newArtists.size === 0) return;

  const now = new Date().toISOString();
  const values = [...newArtists.values()].map(s =>
    `(1, ${escapeSQL(s.artistName)}, ${escapeSQL(s.artistMbid)}, ${escapeSQL(s.artistUrl)}, 0, ${s.filtered ? 1 : 0}, ${escapeSQL(now)}, ${escapeSQL(now)})`
  ).join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_artists (user_id, name, mbid, url, playcount, is_filtered, created_at, updated_at) VALUES\n${values};`
    );
  } catch (err) {
    console.error(`[ERROR] Artist batch insert failed: ${err}`);
    return;
  }

  await loadAllArtists(true);
}

async function batchUpsertAlbums(scrobbles: ParsedScrobble[]): Promise<void> {
  const newAlbums = new Map<string, { s: ParsedScrobble; artistId: number }>();
  for (const s of scrobbles) {
    if (!s.albumName) continue;
    const artistId = artistCache.get(s.artistName.toLowerCase());
    if (!artistId) continue;
    const key = `${s.albumName.toLowerCase()}|${artistId}`;
    if (!albumCache.has(key) && !newAlbums.has(key)) {
      newAlbums.set(key, { s, artistId });
    }
  }
  if (newAlbums.size === 0) return;

  const now = new Date().toISOString();
  const values = [...newAlbums.values()].map(({ s, artistId }) =>
    `(1, ${escapeSQL(s.albumName)}, ${escapeSQL(s.albumMbid)}, ${artistId}, '', 0, ${s.filtered ? 1 : 0}, ${escapeSQL(now)}, ${escapeSQL(now)})`
  ).join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_albums (user_id, name, mbid, artist_id, url, playcount, is_filtered, created_at, updated_at) VALUES\n${values};`
    );
  } catch (err) {
    console.error(`[ERROR] Album batch insert failed: ${err}`);
    return;
  }

  await loadAllAlbums(true);
}

async function batchUpsertTracks(scrobbles: ParsedScrobble[]): Promise<void> {
  const newTracks = new Map<string, { s: ParsedScrobble; artistId: number; albumId: number | null }>();
  for (const s of scrobbles) {
    const artistId = artistCache.get(s.artistName.toLowerCase());
    if (!artistId) continue;
    const key = `${s.trackName.toLowerCase()}|${artistId}`;
    if (trackCache.has(key) || newTracks.has(key)) continue;

    const albumId = s.albumName
      ? albumCache.get(`${s.albumName.toLowerCase()}|${artistId}`) ?? null
      : null;

    newTracks.set(key, { s, artistId, albumId });
  }
  if (newTracks.size === 0) return;

  const now = new Date().toISOString();
  const values = [...newTracks.values()].map(({ s, artistId, albumId }) =>
    `(1, ${escapeSQL(s.trackName)}, ${escapeSQL(s.trackMbid)}, ${artistId}, ${albumId ?? 'NULL'}, ${escapeSQL(s.trackUrl)}, ${s.filtered ? 1 : 0}, ${escapeSQL(now)}, ${escapeSQL(now)})`
  ).join(',\n');

  try {
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_tracks (user_id, name, mbid, artist_id, album_id, url, is_filtered, created_at, updated_at) VALUES\n${values};`
    );
  } catch (err) {
    console.error(`[ERROR] Track batch insert failed: ${err}`);
    return;
  }

  await loadAllTracks(true);
}

async function batchInsertScrobbles(scrobbles: ParsedScrobble[]): Promise<number> {
  const now = new Date().toISOString();
  const values: string[] = [];

  for (const s of scrobbles) {
    const artistId = artistCache.get(s.artistName.toLowerCase());
    if (!artistId) continue;
    const trackId = trackCache.get(`${s.trackName.toLowerCase()}|${artistId}`);
    if (!trackId) continue;

    values.push(
      `(1, ${trackId}, ${escapeSQL(s.scrobbledAt)}, ${escapeSQL(now)})`
    );
  }

  if (values.length === 0) return 0;

  // Split into chunks of 100 to avoid SQL size limits
  const chunkSize = 100;
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    await executeSQL(
      `INSERT OR IGNORE INTO lastfm_scrobbles (user_id, track_id, scrobbled_at, created_at) VALUES\n${chunk.join(',\n')};`
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

// --- Main ---

async function main() {
  const isResume = process.argv.includes('--resume');
  let checkpoint: Checkpoint | null = isResume ? loadCheckpoint() : null;

  console.log('[INFO] Last.fm historical import starting');

  // Preload caches from DB (handles resume + partial data from prior attempts)
  await preloadCaches();

  // First request to get total pages
  const initial = await fetchRecentTracks(1);
  const totalPages = initial.totalPages;
  console.log(`[INFO] Total scrobbles: ${initial.total}, pages: ${totalPages}`);

  if (!checkpoint) {
    checkpoint = {
      totalPages,
      completedPages: [],
      totalScrobbles: 0,
    };
  } else {
    console.log(
      `[INFO] Resuming: ${checkpoint.completedPages.length}/${totalPages} pages done, ${checkpoint.totalScrobbles} scrobbles imported`
    );
  }

  const completedSet = new Set(checkpoint.completedPages);
  let pagesProcessed = completedSet.size;

  for (let page = 1; page <= totalPages; page++) {
    if (completedSet.has(page)) continue;

    try {
      const { tracks } = page === 1 ? initial : await fetchRecentTracks(page);
      await sleep(RATE_LIMIT_MS);

      const scrobbles = parsePageTracks(tracks);

      if (scrobbles.length === 0) {
        completedSet.add(page);
        checkpoint.completedPages = [...completedSet];
        pagesProcessed++;
        continue;
      }

      // Batch upsert in foreign key order: artists -> albums -> tracks -> scrobbles
      await batchUpsertArtists(scrobbles);
      await batchUpsertAlbums(scrobbles);
      await batchUpsertTracks(scrobbles);
      const pageCount = await batchInsertScrobbles(scrobbles);

      checkpoint.totalScrobbles += pageCount;
      completedSet.add(page);
      checkpoint.completedPages = [...completedSet];
      pagesProcessed++;

      // Save checkpoint every 10 pages
      if (pagesProcessed % 10 === 0) {
        saveCheckpoint(checkpoint);
      }

      console.log(
        `[INFO] Page ${page}/${totalPages} (${pageCount} scrobbles). Total: ${checkpoint.totalScrobbles}. Progress: ${pagesProcessed}/${totalPages}`
      );
    } catch (err) {
      console.error(`[ERROR] Failed on page ${page}: ${err}`);
      checkpoint.completedPages = [...completedSet];
      saveCheckpoint(checkpoint);
    }
  }

  // Final save
  saveCheckpoint(checkpoint);

  console.log('[SUCCESS] Last.fm historical import completed');
  console.log(
    `[INFO] Total scrobbles: ${checkpoint.totalScrobbles}, Pages: ${pagesProcessed}/${totalPages}`
  );
  console.log(
    `[INFO] Cached entities: ${artistCache.size} artists, ${albumCache.size} albums, ${trackCache.size} tracks`
  );
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
