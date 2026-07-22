import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import {
  lastfmAlbums,
  lastfmArtists,
  lastfmTopArtists,
  lastfmTracks,
  lastfmScrobbles,
  lastfmYearlyStats,
} from '../db/schema/lastfm.js';
import { images } from '../db/schema/system.js';

describe('listening routes', () => {
  it('module can be imported', async () => {
    const mod = await import('./listening.js');
    expect(mod.default).toBeDefined();
  });

  describe('GET /v1/listening/top/artists?include_sparklines=true', () => {
    let token: string;

    beforeAll(async () => {
      await setupTestDb();
      token = await createTestApiKey({
        name: 'top-artists-sparklines-test',
        scope: 'read',
      });
    });

    beforeEach(async () => {
      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTopArtists);
      await db.delete(lastfmTracks);
      await db.delete(lastfmArtists);
    });

    async function seedArtistWithScrobbles(opts: {
      name: string;
      period: '12month' | '7day' | 'overall';
      rank: number;
      scrobbleAt: string;
      scrobbleCount: number;
    }) {
      const db = drizzle(env.DB);
      const [artist] = await db
        .insert(lastfmArtists)
        .values({
          userId: 1,
          name: opts.name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
      await db.insert(lastfmTopArtists).values({
        userId: 1,
        period: opts.period,
        rank: opts.rank,
        artistId: artist.id,
        playcount: opts.scrobbleCount,
        computedAt: new Date().toISOString(),
      });
      const [track] = await db
        .insert(lastfmTracks)
        .values({
          userId: 1,
          name: `${opts.name} Track`,
          artistId: artist.id,
          isFiltered: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
      const scrobbles = Array.from({ length: opts.scrobbleCount }, () => ({
        userId: 1,
        trackId: track.id,
        scrobbledAt: opts.scrobbleAt,
        createdAt: new Date().toISOString(),
      }));
      await db.insert(lastfmScrobbles).values(scrobbles);
      return artist.id;
    }

    it('attaches sparkline to each item when flag is on and period is supported', async () => {
      // 2 days ago — comfortably inside the 12-month window and the most
      // recent weekly bucket (which spans the current Monday onward).
      const recentScrobble = new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000
      ).toISOString();
      await seedArtistWithScrobbles({
        name: 'Sparkline Artist',
        period: '12month',
        rank: 1,
        scrobbleAt: recentScrobble,
        scrobbleCount: 5,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/listening/top/artists?period=12month&include_sparklines=true&limit=5',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      const item = body.data[0];
      expect(item.sparkline).toBeDefined();
      expect(item.sparkline.granularity).toBe('week');
      expect(item.sparkline.points).toHaveLength(52);
      // The 5 scrobbles should sum to 5 across all buckets.
      const total = item.sparkline.points.reduce(
        (a: number, b: number) => a + b,
        0
      );
      expect(total).toBe(5);
    });

    it('returns 7 daily buckets for period=7day', async () => {
      const recentScrobble = new Date(
        Date.now() - 60 * 60 * 1000
      ).toISOString();

      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTopArtists);
      await db.delete(lastfmTracks);
      await db.delete(lastfmArtists);

      await seedArtistWithScrobbles({
        name: '7day Artist',
        period: '7day',
        rank: 1,
        scrobbleAt: recentScrobble,
        scrobbleCount: 3,
      });

      const res = await SELF.fetch(
        `http://localhost/v1/listening/top/artists?period=7day&include_sparklines=true&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      const item = body.data[0];
      expect(item.sparkline).toBeDefined();
      expect(item.sparkline.granularity).toBe('day');
      expect(item.sparkline.points).toHaveLength(7);
      const total = item.sparkline.points.reduce(
        (a: number, b: number) => a + b,
        0
      );
      expect(total).toBe(3);
    });

    it('returns yearly buckets for period=overall', async () => {
      const recentScrobble = new Date(
        Date.now() - 60 * 60 * 1000
      ).toISOString();

      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTopArtists);
      await db.delete(lastfmTracks);
      await db.delete(lastfmArtists);

      await seedArtistWithScrobbles({
        name: 'Overall Test',
        period: 'overall',
        rank: 1,
        scrobbleAt: recentScrobble,
        scrobbleCount: 3,
      });

      const res = await SELF.fetch(
        `http://localhost/v1/listening/top/artists?period=overall&include_sparklines=true&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      const item = body.data[0];
      expect(item.sparkline).toBeDefined();
      expect(item.sparkline.granularity).toBe('year');
      // At least one bucket exists, all 3 scrobbles land in the current year.
      expect(item.sparkline.points.length).toBeGreaterThanOrEqual(1);
      const total = item.sparkline.points.reduce(
        (a: number, b: number) => a + b,
        0
      );
      expect(total).toBe(3);
    });

    it('omits sparkline when the flag is not passed', async () => {
      const recentScrobble = new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000
      ).toISOString();
      await seedArtistWithScrobbles({
        name: 'No Flag',
        period: '12month',
        rank: 1,
        scrobbleAt: recentScrobble,
        scrobbleCount: 4,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/listening/top/artists?period=12month&limit=5',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect('sparkline' in body.data[0]).toBe(false);
    });
  });

  describe('GET /v1/listening/years', () => {
    let token: string;

    beforeAll(async () => {
      await setupTestDb();
      token = await createTestApiKey({
        name: 'listening-years-test',
        scope: 'read',
      });
    });

    beforeEach(async () => {
      const db = drizzle(env.DB);
      await db.delete(lastfmYearlyStats);
      await db.delete(lastfmArtists);
    });

    it('returns one entry per year, newest first, with top_artist joined', async () => {
      const db = drizzle(env.DB);
      const [taylor] = await db
        .insert(lastfmArtists)
        .values({
          userId: 1,
          name: 'Taylor Swift',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();

      await db.insert(lastfmYearlyStats).values([
        {
          userId: 1,
          year: 2024,
          scrobbles: 5000,
          uniqueArtists: 200,
          uniqueAlbums: 400,
          uniqueTracks: 1500,
          topArtistId: null,
          computedAt: new Date().toISOString(),
        },
        {
          userId: 1,
          year: 2025,
          scrobbles: 8500,
          uniqueArtists: 300,
          uniqueAlbums: 600,
          uniqueTracks: 2400,
          topArtistId: taylor.id,
          computedAt: new Date().toISOString(),
        },
      ]);

      const res = await SELF.fetch('http://localhost/v1/listening/years', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
      expect(body.data[0].year).toBe(2025);
      expect(body.data[0].total_scrobbles).toBe(8500);
      expect(body.data[0].unique_artists).toBe(300);
      expect(body.data[0].unique_albums).toBe(600);
      expect(body.data[0].unique_tracks).toBe(2400);
      expect(body.data[0].top_artist).toEqual({
        id: taylor.id,
        name: 'Taylor Swift',
      });
      expect(body.data[1].year).toBe(2024);
      expect(body.data[1].top_artist).toBeNull();
    });

    it('returns empty data when no yearly stats exist', async () => {
      const res = await SELF.fetch('http://localhost/v1/listening/years', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
    });
  });

  describe('GET /v1/listening/genres?compare_to=previous_year', () => {
    let token: string;

    beforeAll(async () => {
      await setupTestDb();
      token = await createTestApiKey({
        name: 'genres-compare-test',
        scope: 'read',
      });
    });

    beforeEach(async () => {
      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTracks);
      await db.delete(lastfmArtists);
    });

    async function seedScrobbles(opts: {
      genre: string;
      scrobbledAt: string;
      count: number;
    }) {
      const db = drizzle(env.DB);
      const [artist] = await db
        .insert(lastfmArtists)
        .values({
          userId: 1,
          name: `${opts.genre} Artist ${opts.scrobbledAt}`,
          genre: opts.genre,
          isFiltered: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
      const [track] = await db
        .insert(lastfmTracks)
        .values({
          userId: 1,
          name: 'T',
          artistId: artist.id,
          isFiltered: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
      const rows = Array.from({ length: opts.count }, () => ({
        userId: 1,
        trackId: track.id,
        scrobbledAt: opts.scrobbledAt,
        createdAt: new Date().toISOString(),
      }));
      await db.insert(lastfmScrobbles).values(rows);
    }

    it('returns compare array with the prior-year window', async () => {
      // Current window: 2025-01-15 — 1 Rock scrobble
      await seedScrobbles({
        genre: 'Rock',
        scrobbledAt: '2025-01-15T12:00:00Z',
        count: 1,
      });
      // Prior window: 2024-01-15 — 3 Pop scrobbles
      await seedScrobbles({
        genre: 'Pop',
        scrobbledAt: '2024-01-15T12:00:00Z',
        count: 3,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/listening/genres?from=2025-01-01&to=2025-12-31&group_by=year&compare_to=previous_year',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.data).toHaveLength(1);
      expect(body.data[0].period).toBe('2025');
      expect(body.data[0].genres.Rock).toBe(1);
      expect(body.data[0].total).toBe(1);

      expect(body.compare).toBeDefined();
      expect(body.compare).toHaveLength(1);
      expect(body.compare[0].period).toBe('2024');
      expect(body.compare[0].genres.Pop).toBe(3);
      expect(body.compare[0].total).toBe(3);
    });

    it('omits compare key when flag is not set (backward-compatible)', async () => {
      await seedScrobbles({
        genre: 'Rock',
        scrobbledAt: '2025-06-15T12:00:00Z',
        count: 2,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/listening/genres?from=2025-01-01&to=2025-12-31',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeDefined();
      expect('compare' in body).toBe(false);
    });
  });

  describe('GET /v1/listening/recent/albums', () => {
    let token: string;
    let sequence = 0;

    beforeAll(async () => {
      await setupTestDb();
      token = await createTestApiKey({ name: 'recent-albums', scope: 'read' });
    });

    beforeEach(async () => {
      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTracks);
      await db.delete(lastfmAlbums);
      await db.delete(lastfmArtists);
      await db.delete(images);
      sequence = 0;
    });

    async function seedActivity(options: {
      artist: string;
      album?: string;
      albumFiltered?: boolean;
      trackFiltered?: boolean;
      albumUrl?: string | null;
      appleMusicUrl?: string | null;
      withImage?: boolean;
      plays: Array<{ track: string; at: string }>;
    }) {
      const db = drizzle(env.DB);
      const stamp = '2026-07-21T00:00:00.000Z';
      const [artist] = await db
        .insert(lastfmArtists)
        .values({
          userId: 1,
          name: `${options.artist}-${sequence++}`,
          isFiltered: 0,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .returning();
      const album = options.album
        ? (
            await db
              .insert(lastfmAlbums)
              .values({
                userId: 1,
                name: options.album,
                artistId: artist.id,
                url:
                  options.albumUrl === undefined
                    ? `https://last.fm/${encodeURIComponent(options.album)}`
                    : options.albumUrl,
                appleMusicUrl: options.appleMusicUrl ?? null,
                isFiltered: options.albumFiltered ? 1 : 0,
                createdAt: stamp,
                updatedAt: stamp,
              })
              .returning()
          )[0]
        : null;
      const trackIds = new Map<string, number>();
      for (const play of options.plays) {
        if (trackIds.has(play.track)) continue;
        const [track] = await db
          .insert(lastfmTracks)
          .values({
            userId: 1,
            name: play.track,
            artistId: artist.id,
            albumId: album?.id ?? null,
            isFiltered: options.trackFiltered ? 1 : 0,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .returning();
        trackIds.set(play.track, track.id);
      }
      for (let start = 0; start < options.plays.length; start += 20) {
        await db.insert(lastfmScrobbles).values(
          options.plays.slice(start, start + 20).map((play) => ({
            userId: 1,
            trackId: trackIds.get(play.track)!,
            scrobbledAt: play.at,
            createdAt: stamp,
          }))
        );
      }
      if (album && options.withImage) {
        await db.insert(images).values({
          userId: 1,
          domain: 'listening',
          entityType: 'albums',
          entityId: String(album.id),
          r2Key: `listening/albums/${album.id}/original.jpg`,
          source: 'test',
          thumbhash: 'AQID',
          dominantColor: '#111111',
          accentColor: '#eeeeee',
          imageVersion: 1,
          createdAt: stamp,
        });
      }
      return album;
    }

    function authFetch(path: string) {
      return SELF.fetch(`http://localhost${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    it('deduplicates an album and orders by newest scrobble', async () => {
      await seedActivity({
        artist: 'Mudhoney',
        album: 'Superfuzz Bigmuff',
        appleMusicUrl: 'https://music.apple.com/us/album/superfuzz/1',
        withImage: true,
        plays: [
          { track: 'Touch Me I’m Sick', at: '2026-07-21T00:08:56.000Z' },
          { track: 'Sweet Young Thing', at: '2026-07-21T00:29:34.000Z' },
        ],
      });
      await seedActivity({
        artist: 'Taylor Swift',
        album: 'Midnights',
        albumUrl: null,
        plays: [{ track: 'Glitch', at: '2026-07-21T00:20:13.000Z' }],
      });
      const response = await authFetch('/v1/listening/recent/albums?limit=10');
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe(
        'public, max-age=30, s-maxage=30'
      );
      const body = (await response.json()) as any;
      expect(body.data.map((item: any) => item.album.name)).toEqual([
        'Superfuzz Bigmuff',
        'Midnights',
      ]);
      expect(body.data[0].last_scrobbled_at).toBe('2026-07-21T00:29:34.000Z');
      expect(body.data[0].album.image.cdn_url).toContain('original.jpg');
      expect(body.data[1].album.url).toBeNull();
      expect(body.data[1].album.apple_music_url).toBeNull();
      expect(body.data[1].album.image).toBeNull();
    });

    it('uses descending scrobble id for timestamp ties', async () => {
      await seedActivity({
        artist: 'First',
        album: 'First Album',
        plays: [{ track: 'One', at: '2026-07-21T00:00:00.000Z' }],
      });
      await seedActivity({
        artist: 'Second',
        album: 'Second Album',
        plays: [{ track: 'Two', at: '2026-07-21T00:00:00.000Z' }],
      });
      const body = (await (
        await authFetch('/v1/listening/recent/albums')
      ).json()) as any;
      expect(body.data.map((item: any) => item.album.name)).toEqual([
        'Second Album',
        'First Album',
      ]);
    });

    it('excludes filtered and album-less activity', async () => {
      await seedActivity({
        artist: 'Valid',
        album: 'Visible',
        plays: [{ track: 'Visible', at: '2026-07-21T00:01:00.000Z' }],
      });
      await seedActivity({
        artist: 'Filtered Track',
        album: 'Hidden Track',
        trackFiltered: true,
        plays: [{ track: 'Hidden T', at: '2026-07-21T00:04:00.000Z' }],
      });
      await seedActivity({
        artist: 'Filtered Album',
        album: 'Hidden Album',
        albumFiltered: true,
        plays: [{ track: 'Hidden A', at: '2026-07-21T00:03:00.000Z' }],
      });
      await seedActivity({
        artist: 'No Album',
        plays: [{ track: 'Loose', at: '2026-07-21T00:02:00.000Z' }],
      });
      const body = (await (
        await authFetch('/v1/listening/recent/albums')
      ).json()) as any;
      expect(body.data.map((item: any) => item.album.name)).toEqual([
        'Visible',
      ]);
    });

    it('stops at 200 raw rows and validates limit', async () => {
      await seedActivity({
        artist: 'No Album',
        plays: Array.from({ length: 200 }, (_, index) => ({
          track: 'Albumless Stream',
          at: new Date(
            Date.parse('2026-07-21T01:00:00.000Z') - index * 1000
          ).toISOString(),
        })),
      });
      await seedActivity({
        artist: 'Older',
        album: 'Outside Window',
        plays: [{ track: 'Older', at: '2026-07-20T00:00:00.000Z' }],
      });
      const capped = await authFetch('/v1/listening/recent/albums');
      expect(((await capped.json()) as any).data).toEqual([]);
      expect(
        (await authFetch('/v1/listening/recent/albums?limit=0')).status
      ).toBe(400);
      expect(
        (await authFetch('/v1/listening/recent/albums?limit=21')).status
      ).toBe(400);
    });

    it('returns only the requested number of unique albums', async () => {
      for (let index = 0; index < 4; index += 1) {
        await seedActivity({
          artist: `Artist ${index}`,
          album: `Album ${index}`,
          plays: [
            {
              track: `Track ${index}`,
              at: new Date(
                Date.parse('2026-07-21T02:00:00.000Z') - index * 1000
              ).toISOString(),
            },
          ],
        });
      }
      const response = await authFetch('/v1/listening/recent/albums?limit=2');
      expect(((await response.json()) as any).data).toHaveLength(2);
    });
  });
});
