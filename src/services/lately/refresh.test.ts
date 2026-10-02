import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { env } from 'cloudflare:test';
import { createDb } from '../../db/client.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
  lastfmFilters,
} from '../../db/schema/lastfm.js';
import {
  directors,
  movieDirectors,
  movies,
  watchHistory,
} from '../../db/schema/watching.js';
import { images } from '../../db/schema/system.js';
import { latelySnapshots } from '../../db/schema/lately.js';
import type { Env } from '../../types/env.js';
import { refreshLately } from './refresh.js';
import { LatelySnapshot, type Snapshot } from './schema.js';
import { LEASE_MS, movieExclusions } from './policy.js';

const db = createDb(env.DB);
const testEnv = {
  ...env,
  LASTFM_API_KEY: 'test-key',
  LASTFM_USERNAME: 'test-user',
  LATELY_EXCLUDED_MOVIE_IDS: '',
} as unknown as Env;
const base = Date.parse('2026-09-01T12:00:00.000Z');
let now: number;

function response(
  name = 'First Song',
  artist = 'Test Artist',
  album = 'Test Album',
  time = now - 10_000
) {
  return {
    recenttracks: {
      track: [
        {
          name,
          artist: { '#text': artist },
          album: { '#text': album },
          date: { uts: String(Math.floor(time / 1000)) },
        },
      ],
    },
  };
}

async function snapshot(): Promise<Snapshot> {
  const row = await env.DB.prepare(
    'SELECT snapshot FROM lately_snapshots WHERE user_id = 1'
  ).first<{ snapshot: string }>();
  return LatelySnapshot.parse(JSON.parse(row!.snapshot));
}

async function seedMusic(name = 'First Song', artwork = true, userId = 1) {
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: `Test Artist${userId === 1 ? '' : userId}`, userId })
    .returning();
  const [album] = await db
    .insert(lastfmAlbums)
    .values({ name: 'Test Album', artistId: artist.id, userId })
    .returning();
  const [track] = await db
    .insert(lastfmTracks)
    .values({ name, artistId: artist.id, albumId: album.id, userId })
    .returning();
  await db.insert(lastfmScrobbles).values({
    trackId: track.id,
    scrobbledAt: new Date(base - 60_000).toISOString(),
    userId,
  });
  if (artwork) await seedImage('listening', 'albums', album.id, userId);
  return { artist, album, track };
}

async function seedImage(domain: string, type: string, id: number, userId = 1) {
  await db.insert(images).values({
    domain,
    entityType: type,
    entityId: String(id),
    r2Key: `${domain}/${type}/${id}/original.jpg`,
    source: 'manual',
    imageVersion: 2,
    userId,
  });
}

async function seedMovie(artwork = true, userId = 1) {
  const [movie] = await db
    .insert(movies)
    .values({
      title: 'Test Movie',
      year: 2025,
      runtime: 110,
      contentRating: 'PG',
      userId,
    })
    .returning();
  const [watch] = await db
    .insert(watchHistory)
    .values({
      movieId: movie.id,
      watchedAt: new Date(now).toISOString(),
      userRating: 4.5,
      userId,
    })
    .returning();
  if (artwork) await seedImage('watching', 'movies', movie.id, userId);
  return { movie, watch };
}

describe('prepared Lately refresh', () => {
  beforeAll(setupTestDb);
  beforeEach(async () => {
    now = base;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await db.delete(latelySnapshots);
    await db.delete(images);
    await db.delete(watchHistory);
    await db.delete(movieDirectors);
    await db.delete(movies);
    await db.delete(directors);
    await db.delete(lastfmScrobbles);
    await db.delete(lastfmTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);
    await db.delete(lastfmFilters);
  });
  afterEach(() => vi.restoreAllMocks());

  it('bounds and validates exclusion configuration before querying', () => {
    expect(movieExclusions('2, 1,2')).toEqual([1, 2]);
    expect(() => movieExclusions('2,not-an-id')).toThrow();
    expect(() =>
      movieExclusions(Array.from({ length: 51 }, (_, i) => i + 1).join(','))
    ).toThrow();
  });

  it('rebuilds corrupt saved state without resetting its publication revision', async () => {
    await db.insert(latelySnapshots).values({
      userId: 1,
      revision: 9,
      snapshot: '{invalid',
      pending: '{invalid',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(response())
    );
    expect(await refreshLately(testEnv)).toBe(true);
    expect(await snapshot()).toMatchObject({
      version: 10,
      music: { name: 'First Song' },
    });
    await env.DB.prepare(
      'UPDATE lately_snapshots SET pending = ? WHERE user_id = 1'
    )
      .bind('{invalid')
      .run();
    now += 60_000;
    expect(await refreshLately(testEnv)).toBe(true);
    expect((await snapshot()).version).toBe(11);
  });

  it('rechecks movie artwork after ingestion and clears a removed watch', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(response())
    );
    const { movie } = await seedMovie(false);
    await refreshLately(testEnv);
    const first = await snapshot();
    expect(first.movie?.image).toBeNull();
    await seedImage('watching', 'movies', movie.id);
    now += 60_000;
    await refreshLately(testEnv);
    expect((await snapshot()).movie?.image).not.toBeNull();
    expect((await snapshot()).movie?.event_id).toBe(first.movie?.event_id);
    await db.delete(watchHistory);
    now += 60_000;
    await refreshLately(testEnv);
    expect((await snapshot()).movie).toBeNull();
  });

  it('publishes one pair with canonical attribution, direct small images, and distinct rating fields', async () => {
    await seedMusic();
    const { movie } = await seedMovie();
    const [director] = await db
      .insert(directors)
      .values({ name: 'Test Director' })
      .returning();
    await db
      .insert(movieDirectors)
      .values({ movieId: movie.id, directorId: director.id });
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(response()));
    expect(await refreshLately(testEnv)).toBe(true);
    const result = await snapshot();
    expect(result).toMatchObject({
      schema_version: 1,
      version: 1,
      as_of: new Date(base).toISOString(),
      music: {
        name: 'First Song',
        album: 'Test Album',
        image: { width: 150, height: 150 },
      },
      movie: {
        title: 'Test Movie',
        directors: ['Test Director'],
        content_rating: 'PG',
        runtime_minutes: 110,
        user_rating: 4.5,
        image: { width: 150, height: 225 },
      },
    });
    expect(result.music?.image?.cdn_url).toContain('v=2');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('ignores current playback and chooses the latest completed scrobble', async () => {
    await seedMusic();
    const body = response();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        recenttracks: {
          track: [
            {
              name: 'Live Song',
              artist: { '#text': 'Test Artist' },
              album: { '#text': 'Test Album' },
              '@attr': { nowplaying: 'true' },
            },
            ...body.recenttracks.track,
          ],
        },
      })
    );
    await refreshLately(testEnv);
    expect((await snapshot()).music?.name).toBe('First Song');
  });

  it('keeps the last music through upstream failure while publishing new movie data', async () => {
    await seedMusic();
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(response()));
    await refreshLately(testEnv);
    const initial = await snapshot();
    now += 60_000;
    await seedMovie();
    fetcher.mockRejectedValue(new Error('upstream unavailable'));
    await refreshLately(testEnv);
    const result = await snapshot();
    expect(result.music).toEqual(initial.music);
    expect(result.music_checked_at).toBe(initial.music_checked_at);
    expect(result.movie?.title).toBe('Test Movie');
    expect(result.movie_checked_at).toBe(new Date(now).toISOString());
  });

  it('bootstraps from stored music on malformed provider response without claiming a successful check', async () => {
    await seedMusic();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 6, message: 'invalid data' })
    );
    await refreshLately(testEnv);
    expect(await snapshot()).toMatchObject({
      music_checked_at: null,
      music: { name: 'First Song' },
    });
  });

  it('bounds the artwork wait across consecutive songs and detects artwork ready on a later tick', async () => {
    await seedMusic();
    let body = response();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(body)
    );
    await refreshLately(testEnv);
    // A corrupt/future pending timestamp cannot extend the bounded hold.
    await env.DB.prepare(
      'UPDATE lately_snapshots SET pending = ? WHERE user_id = 1'
    )
      .bind(JSON.stringify({ music: now + 365 * 86_400_000, movie: null }))
      .run();
    now += 60_000;
    body = response('New Song');
    await refreshLately(testEnv);
    expect((await snapshot()).music?.name).toBe('First Song');
    now += 60_000;
    body = response('Another Song');
    await refreshLately(testEnv);
    expect((await snapshot()).music?.name).toBe('First Song');
    now += 60_000;
    body = response('Another Song');
    await refreshLately(testEnv);
    expect((await snapshot()).music).toMatchObject({
      name: 'Another Song',
      image: null,
    });
    const [artist] = await db.select().from(lastfmArtists);
    const [album] = await db.select().from(lastfmAlbums);
    await db
      .insert(lastfmTracks)
      .values({ name: 'Another Song', artistId: artist.id, albumId: album.id });
    now += 60_000;
    await refreshLately(testEnv);
    expect((await snapshot()).music?.image?.cdn_url).toContain('v=2');
  });

  it('does not make an older replica response replace a newer scrobble', async () => {
    await seedMusic();
    const first = response();
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(first));
    await refreshLately(testEnv);
    const previous = (await snapshot()).music;
    now += 60_000;
    fetcher.mockResolvedValue(
      Response.json(
        response('Older Song', 'Test Artist', 'Test Album', base - 100_000)
      )
    );
    await refreshLately(testEnv);
    expect((await snapshot()).music).toEqual(previous);
  });

  it('reapplies exclusions and filters during provider errors', async () => {
    await seedMusic();
    const { movie } = await seedMovie();
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(response()));
    await refreshLately(testEnv);
    await db.insert(lastfmFilters).values({
      userId: 1,
      filterType: 'audiobook',
      pattern: 'test artist',
      scope: 'artist',
    });
    now += 60_000;
    fetcher.mockRejectedValue(new Error('offline'));
    await refreshLately({
      ...testEnv,
      LATELY_EXCLUDED_MOVIE_IDS: String(movie.id),
    });
    expect(await snapshot()).toMatchObject({ music: null, movie: null });
  });

  it('skips audiobook filename signatures and isolated user data', async () => {
    await seedMusic();
    await seedMusic('Private Song', true, 2);
    await seedMovie(true, 2);
    const book = response(
      '(1 of 20) - Example Book Title',
      'Test Artist',
      'Example Book Title'
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(book));
    await refreshLately(testEnv);
    expect(await snapshot()).toMatchObject({
      music: { name: 'First Song' },
      movie: null,
    });
  });

  it('rejects duplicate and out-of-order cron ticks without another provider request', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(response()));
    expect(await refreshLately(testEnv)).toBe(true);
    expect(await refreshLately(testEnv)).toBe(false);
    expect(await refreshLately(testEnv, now - 60_000)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fences a slow writer after its lease expires and a newer pair is published', async () => {
    let resolveFirst!: (response: Response) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => {
        started();
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockImplementationOnce(async () => Response.json(response('New Song')));
    const slow = refreshLately(testEnv);
    await began;
    expect(await refreshLately(testEnv, now + 60_000)).toBe(false);
    now += LEASE_MS + 60_000;
    expect(await refreshLately(testEnv)).toBe(true);
    const fresh = await snapshot();
    resolveFirst(
      Response.json(
        response('Old Song', 'Test Artist', 'Test Album', base - 60_000)
      )
    );
    expect(await slow).toBe(false);
    expect(await snapshot()).toEqual(fresh);
  });
});
