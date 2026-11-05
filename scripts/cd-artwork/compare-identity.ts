/** Read-only identity evaluation. Input is a privately stored, owner-scoped D1
 * SELECT export. This process has no D1 client, artwork storage or dispatcher.
 * Both versions see the same cached provider responses. No image generation,
 * source downloads or remote writes are available through this harness. */
import { createHash } from 'node:crypto';
import { readFile, mkdir, open, chmod, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifiedCover } from '../../src/services/cd-artwork/selection.js';
import type { ArtworkEnv } from '../../src/services/cd-artwork/types.js';
import type { CatalogAlbum } from '../../src/services/cd-artwork/sources.js';

interface SnapshotAlbum extends CatalogAlbum {
  id: number;
  cohort: 'held' | 'accepted';
  recorded_tracks: string[];
  legacy_tracks: string[];
  stored_code: string | null;
  release_id: string | null;
}
interface CachedResponse {
  status: number;
  body: string;
  retryAfter: string | null;
}

/** Apply privacy to existing files too, and refuse symlink destinations. */
export async function writePrivate(path: string, data: string) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(data);
  } finally {
    await file.close();
  }
}

/** Only the two query shapes used by verifiedCover are supported. The shared
 * provider throttle's reservation is simulated locally, never sent to D1. */
export function snapshotDatabase(
  album: Pick<SnapshotAlbum, 'recorded_tracks' | 'legacy_tracks'>
) {
  return {
    prepare(sql: string) {
      const query = sql.trim();
      if (query.startsWith('UPDATE cd_artwork_control SET provider_next_ms='))
        return {
          bind() {
            return this;
          },
          async first() {
            return { provider_next_ms: 0 };
          },
        };
      if (
        !query.startsWith('SELECT t.name FROM lastfm_') ||
        !query.includes('s.album_recorded=')
      )
        throw new Error('comparison_database_operation_denied');
      const tracks = query.includes('s.album_recorded=1')
        ? album.recorded_tracks
        : album.legacy_tracks;
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: tracks.slice(0, 8).map((name) => ({ name })) };
        },
      };
    },
  } as unknown as D1Database;
}

export function assertCatalogRead(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  const url = new URL(String(input));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (init?.method ?? 'GET').toUpperCase() !== 'GET' ||
    init?.body != null ||
    !(
      (url.hostname === 'api.music.apple.com' &&
        /^\/v1\/catalog\/us\/(?:albums\/\d+|search)$/.test(url.pathname)) ||
      (url.hostname === 'itunes.apple.com' &&
        ['/lookup', '/search'].includes(url.pathname)) ||
      (url.hostname === 'musicbrainz.org' &&
        /^\/ws\/2\/(?:release|release-group|artist)\/[a-f0-9-]+$/.test(
          url.pathname
        ))
    )
  )
    throw new Error('comparison_network_operation_denied');
  return url;
}

export function catalogReader(
  cacheDirectory: string,
  token: string,
  fetcher: typeof fetch = globalThis.fetch
) {
  const cache = new Map<string, CachedResponse>();
  const stats = { networkReads: 0 };
  let nextRequest = 0;
  const reader: typeof fetch = async (input, init) => {
    const url = assertCatalogRead(input, init);
    const key = createHash('sha256').update(url.href).digest('hex');
    let entry = cache.get(key);
    if (!entry) {
      try {
        entry = JSON.parse(
          await readFile(resolve(cacheDirectory, `${key}.json`), 'utf8')
        );
      } catch {
        /* Cache miss. */
      }
      if (!entry) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, nextRequest - Date.now()))
        );
        const spacing =
          url.hostname === 'itunes.apple.com'
            ? 3100
            : url.hostname === 'musicbrainz.org'
              ? 1100
              : 400;
        nextRequest = Date.now() + spacing;
        // Only the fixed allowlist receives a request. Redirects cannot forward
        // credentials or escape that allowlist; no request body is forwarded.
        stats.networkReads++;
        try {
          const response = await fetcher(url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(20000),
            headers: {
              Accept: 'application/json',
              'User-Agent':
                'Rewind-Identity-Comparison/1.0 (https://rewind.rest)',
              ...(url.hostname === 'api.music.apple.com'
                ? { Authorization: `Bearer ${token}` }
                : {}),
            },
          });
          entry = {
            status: response.status,
            body: await response.text(),
            retryAfter: response.headers.get('retry-after'),
          };
        } catch {
          // Replay the same symbolic transport failure to both versions.
          entry = { status: 503, body: '{}', retryAfter: null };
        }
        if ((entry.status >= 200 && entry.status < 300) || entry.status === 404)
          await writePrivate(
            resolve(cacheDirectory, `${key}.json`),
            JSON.stringify(entry)
          );
      }
      cache.set(key, entry!);
    }
    return new Response(entry!.body, {
      status: entry!.status,
      headers: {
        'content-type': 'application/json',
        ...(entry!.retryAfter ? { 'retry-after': entry!.retryAfter } : {}),
      },
    });
  };
  return { fetch: reader, stats };
}

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      baseline: { type: 'string' },
      output: { type: 'string' },
      cache: { type: 'string' },
      'env-file': { type: 'string' },
    },
  });
  if (!values.snapshot || !values.baseline || !values.output || !values.cache)
    throw new Error(
      'Required: --snapshot --baseline --output --cache; optional --env-file'
    );
  if (values['env-file']) process.loadEnvFile(values['env-file']);
  const token = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  if (!token) throw new Error('comparison_apple_token_missing');
  const snapshot = JSON.parse(await readFile(values.snapshot, 'utf8')) as {
    albums: SnapshotAlbum[];
  };
  const baseline = await import(pathToFileURL(resolve(values.baseline)).href);
  await mkdir(values.cache, { recursive: true, mode: 0o700 });
  if (!(await lstat(values.cache)).isDirectory())
    throw new Error('comparison_cache_directory_required');
  await chmod(values.cache, 0o700);
  const liveFetch = globalThis.fetch;
  const reader = catalogReader(values.cache, token, liveFetch);
  globalThis.fetch = reader.fetch;
  const evaluate = async (
    verify: typeof verifiedCover,
    album: SnapshotAlbum
  ) => {
    const runtime = {
      DB: snapshotDatabase(album),
      APPLE_MUSIC_DEVELOPER_TOKEN: token,
    } as ArtworkEnv;
    try {
      const selected = await verify(
        runtime,
        album.id,
        1,
        album,
        false,
        album.release_id || undefined
      );
      return {
        status: 'verified',
        catalog_id: selected.discovery.collection_id,
        evidence: selected.discovery.identity_evidence ?? null,
      };
    } catch (error) {
      const e = error as {
        code?: string;
        status?: number;
        identityEvidence?: Record<string, unknown>;
      };
      // Provider messages, URLs, stack traces and credentials are excluded.
      return {
        status:
          e.status === 503 || e.status === 429 || !e.code
            ? 'provider_error'
            : 'held',
        code: e.code ?? 'comparison_error',
        evidence: e.identityEvidence ?? null,
      };
    }
  };
  const results = [];
  try {
    for (const album of snapshot.albums) {
      const before = await evaluate(baseline.verifiedCover, album);
      const after = await evaluate(verifiedCover, album);
      results.push({
        album_id: album.id,
        cohort: album.cohort,
        stored_code: album.stored_code,
        before,
        after,
      });
      // Aggregate progress only: never print listening metadata or credentials.
      if (results.length % 10 === 0)
        console.log(`Compared ${results.length}/${snapshot.albums.length}`);
      await writePrivate(
        values.output,
        JSON.stringify({ completed: results.length, results }, null, 2)
      );
    }
  } finally {
    globalThis.fetch = liveFetch;
  }
  const summarize = (cohort: string) => {
    const rows = results.filter((row) => row.cohort === cohort);
    return {
      total: rows.length,
      baseline_verified: rows.filter((r) => r.before.status === 'verified')
        .length,
      candidate_verified: rows.filter((r) => r.after.status === 'verified')
        .length,
      newly_verified: rows.filter(
        (r) => r.before.status === 'held' && r.after.status === 'verified'
      ).length,
      regressions: rows.filter(
        (r) => r.before.status === 'verified' && r.after.status !== 'verified'
      ).length,
      changed_selection: rows.filter(
        (r) =>
          r.before.status === 'verified' &&
          r.after.status === 'verified' &&
          r.before.catalog_id !== r.after.catalog_id
      ).length,
      provider_errors: rows.filter(
        (r) =>
          r.before.status === 'provider_error' ||
          r.after.status === 'provider_error'
      ).length,
      remaining_codes: rows
        .filter((r) => r.after.status === 'held')
        .reduce<Record<string, number>>((counts, r) => {
          const code = 'code' in r.after ? r.after.code : 'unknown';
          counts[code ?? 'unknown'] = (counts[code ?? 'unknown'] ?? 0) + 1;
          return counts;
        }, {}),
    };
  };
  const summary = {
    captured_at: new Date().toISOString(),
    scope:
      'catalog cover identity only; no retail source, image quality or generation evaluation',
    baseline_sha256: createHash('sha256')
      .update(await readFile(values.baseline))
      .digest('hex'),
    snapshot_sha256: createHash('sha256')
      .update(await readFile(values.snapshot))
      .digest('hex'),
    held: summarize('held'),
    accepted: summarize('accepted'),
    network_reads: reader.stats.networkReads,
    remote_writes: 0,
    generation_requests: 0,
  };
  await writePrivate(
    values.output,
    JSON.stringify({ summary, results }, null, 2)
  );
  console.log(JSON.stringify(summary, null, 2));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error instanceof Error && error.message.startsWith('Required:')
        ? error.message
        : 'comparison_failed; inspect private inputs and provider status'
    );
    process.exitCode = 1;
  });
