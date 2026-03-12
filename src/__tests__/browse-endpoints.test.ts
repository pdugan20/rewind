import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
  lastfmScrobbles,
} from '../db/schema/lastfm.js';
import {
  movies,
  genres,
  movieGenres,
  watchHistory,
} from '../db/schema/watching.js';
import { stravaActivities, stravaYearSummaries } from '../db/schema/strava.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

describe('Phase 6: Browse, Rating, Review, and Year-in-Review endpoints', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ scope: 'read', name: 'browse-test' });

    const db = createDb(env.DB);

    // Seed listening data
    const [artist1] = await db
      .insert(lastfmArtists)
      .values({
        name: 'Browse Artist Alpha',
        playcount: 200,
        isFiltered: 0,
      })
      .returning();

    const [artist2] = await db
      .insert(lastfmArtists)
      .values({
        name: 'Browse Artist Beta',
        playcount: 100,
        isFiltered: 0,
      })
      .returning();

    const [album1] = await db
      .insert(lastfmAlbums)
      .values({
        name: 'Album One',
        artistId: artist1.id,
        playcount: 50,
        isFiltered: 0,
      })
      .returning();

    const [_album2] = await db
      .insert(lastfmAlbums)
      .values({
        name: 'Album Two',
        artistId: artist2.id,
        playcount: 30,
        isFiltered: 0,
      })
      .returning();

    // Seed scrobbles for year-in-review
    const [track1] = await db
      .insert(lastfmTracks)
      .values({
        name: 'Track One',
        artistId: artist1.id,
        albumId: album1.id,
        isFiltered: 0,
      })
      .returning();

    await db.insert(lastfmScrobbles).values([
      { trackId: track1.id, scrobbledAt: '2024-03-15T10:00:00.000Z' },
      { trackId: track1.id, scrobbledAt: '2024-03-16T10:00:00.000Z' },
      { trackId: track1.id, scrobbledAt: '2024-06-01T10:00:00.000Z' },
    ]);

    // Seed watching data
    const [movie1] = await db
      .insert(movies)
      .values({ title: 'Rated Movie', year: 2024, tmdbId: 99901 })
      .returning();
    const [movie2] = await db
      .insert(movies)
      .values({ title: 'Reviewed Movie', year: 2023, tmdbId: 99902 })
      .returning();

    const [genre1] = await db
      .insert(genres)
      .values({ name: 'TestDrama' })
      .returning();
    await db
      .insert(movieGenres)
      .values({ movieId: movie1.id, genreId: genre1.id });

    await db.insert(watchHistory).values([
      {
        movieId: movie1.id,
        watchedAt: '2024-04-10T20:00:00Z',
        source: 'manual',
        userRating: 8.5,
      },
      {
        movieId: movie2.id,
        watchedAt: '2024-07-20T20:00:00Z',
        source: 'letterboxd',
        userRating: 7.0,
        review: 'Great film with strong performances.',
      },
    ]);

    // Seed running data for year-in-review
    await db.delete(stravaActivities);
    await db.delete(stravaYearSummaries);

    await db.insert(stravaActivities).values([
      {
        stravaId: 20001,
        name: 'Morning Run',
        sportType: 'Run',
        distanceMeters: 8046,
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
        elapsedTimeSeconds: 2500,
        totalElevationGainMeters: 30,
        totalElevationGainFeet: 98.4,
        startDate: '2024-03-15T12:00:00Z',
        startDateLocal: '2024-03-15T07:00:00',
        isRace: 0,
        isDeleted: 0,
      },
      {
        stravaId: 20002,
        name: 'Evening Run',
        sportType: 'Run',
        distanceMeters: 16093,
        distanceMiles: 10.0,
        movingTimeSeconds: 5000,
        elapsedTimeSeconds: 5200,
        totalElevationGainMeters: 60,
        totalElevationGainFeet: 196.8,
        startDate: '2024-06-20T20:00:00Z',
        startDateLocal: '2024-06-20T15:00:00',
        isRace: 0,
        isDeleted: 0,
      },
    ]);

    await db.insert(stravaYearSummaries).values({
      userId: 1,
      year: 2024,
      totalRuns: 2,
      totalDistanceMiles: 15.0,
      totalElevationFeet: 295.2,
      totalDurationSeconds: 7400,
      avgPaceFormatted: '8:13/mi',
      longestRunMiles: 10.0,
      raceCount: 0,
    });
  });

  describe('GET /v1/listening/artists (browse)', () => {
    it('returns paginated artists sorted by playcount', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/listening/artists?limit=10',
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: number; name: string; playcount: number }>;
        pagination: { total: number };
      };
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      expect(body.pagination.total).toBeGreaterThanOrEqual(2);
      // Default sort is playcount desc
      expect(body.data[0].playcount).toBeGreaterThanOrEqual(
        body.data[1].playcount
      );
    });

    it('filters artists by search', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/listening/artists?search=Alpha',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ name: string }>;
      };
      expect(body.data.length).toBe(1);
      expect(body.data[0].name).toBe('Browse Artist Alpha');
    });
  });

  describe('GET /v1/listening/albums (browse)', () => {
    it('returns paginated albums with artist info', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/listening/albums?limit=10',
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          id: number;
          name: string;
          artist: { id: number; name: string };
          playcount: number;
        }>;
        pagination: { total: number };
      };
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      expect(body.data[0].artist).toBeDefined();
      expect(body.data[0].artist.name).toBeTruthy();
    });

    it('filters albums by artist name', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/listening/albums?artist=Beta',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ name: string; artist: { name: string } }>;
      };
      expect(body.data.length).toBe(1);
      expect(body.data[0].artist.name).toBe('Browse Artist Beta');
    });
  });

  describe('GET /v1/watching/ratings', () => {
    it('returns movies with ratings', async () => {
      const res = await SELF.fetch('http://localhost/v1/watching/ratings', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          movie: { title: string };
          user_rating: number;
        }>;
        pagination: { total: number };
      };
      expect(body.data.length).toBe(2);
      // Default sort is rating desc
      expect(body.data[0].user_rating).toBeGreaterThanOrEqual(
        body.data[1].user_rating
      );
    });
  });

  describe('GET /v1/watching/reviews', () => {
    it('returns movies with review text', async () => {
      const res = await SELF.fetch('http://localhost/v1/watching/reviews', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          movie: { title: string };
          review: string;
          user_rating: number | null;
        }>;
        pagination: { total: number };
      };
      expect(body.data.length).toBe(1);
      expect(body.data[0].movie.title).toBe('Reviewed Movie');
      expect(body.data[0].review).toContain('Great film');
    });
  });

  describe('GET /v1/listening/year/:year', () => {
    it('returns year-in-review data', async () => {
      const res = await SELF.fetch('http://localhost/v1/listening/year/2024', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        year: number;
        total_scrobbles: number;
        unique_artists: number;
        top_artists: Array<{ name: string; scrobbles: number }>;
        top_albums: Array<{ name: string }>;
        top_tracks: Array<{ name: string }>;
        monthly: Array<{ month: string; scrobbles: number }>;
      };
      expect(body.year).toBe(2024);
      expect(body.total_scrobbles).toBe(3);
      expect(body.unique_artists).toBeGreaterThanOrEqual(1);
      expect(body.monthly.length).toBe(2); // March and June
    });

    it('rejects invalid year', async () => {
      const res = await SELF.fetch('http://localhost/v1/listening/year/abc', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/watching/year/:year', () => {
    it('returns year-in-review data', async () => {
      const res = await SELF.fetch('http://localhost/v1/watching/year/2024', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        year: number;
        total_movies: number;
        genres: Array<{ name: string; count: number }>;
        monthly: Array<{ month: string; count: number }>;
        top_rated: Array<{ movie: { title: string }; user_rating: number }>;
      };
      expect(body.year).toBe(2024);
      expect(body.total_movies).toBeGreaterThanOrEqual(1);
      expect(body.genres.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /v1/running/year/:year', () => {
    it('returns year-in-review with monthly breakdown', async () => {
      const res = await SELF.fetch('http://localhost/v1/running/year/2024', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        year: number;
        total_runs: number;
        total_distance_mi: number;
        monthly: Array<{ month: string; runs: number; distance_mi: number }>;
        top_runs: Array<{ id: number; distance_mi: number }>;
      };
      expect(body.year).toBe(2024);
      expect(body.total_runs).toBe(2);
      expect(body.total_distance_mi).toBe(15.0);
      expect(body.monthly.length).toBe(2); // March and June
      expect(body.top_runs.length).toBe(2);
    });

    it('returns 404 for year with no data', async () => {
      const res = await SELF.fetch('http://localhost/v1/running/year/2010', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });
});
