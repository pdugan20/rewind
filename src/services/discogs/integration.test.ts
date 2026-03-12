import { describe, it, expect, beforeAll } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  applyD1Migrations,
} from 'cloudflare:test';
import app from '../../index.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const testEnv = env as any;

// Helper to create an authenticated request
function authRequest(path: string, method = 'GET', body?: string): Request {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: 'Bearer rw_test_admin_key',
      'Content-Type': 'application/json',
    },
  };
  if (body) init.body = body;
  return new Request(`http://localhost${path}`, init);
}

async function fetchApp(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function dbRun(sql: string, ...params: unknown[]) {
  return testEnv.DB.prepare(sql)
    .bind(...params)
    .run();
}

describe('collecting integration', () => {
  beforeAll(async () => {
    const migrations = testEnv.TEST_MIGRATIONS;
    if (Array.isArray(migrations)) {
      await applyD1Migrations(testEnv.DB, migrations);
    }

    // Create test API key
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode('rw_test_admin_key')
    );
    const keyHash = [...new Uint8Array(hashBuffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    await dbRun(
      "INSERT OR IGNORE INTO api_keys (user_id, key_hash, key_prefix, key_hint, name, scope, created_at) VALUES (1, ?, 'rw_test', '****_key', 'test', 'admin', ?)",
      keyHash,
      new Date().toISOString()
    );

    // Seed releases
    await dbRun(
      'INSERT INTO discogs_releases (id, user_id, discogs_id, title, year, genres, styles, formats, format_details, labels, discogs_url, country, community_have, community_want, created_at, updated_at) VALUES (1, 1, 1001, \'OK Computer\', 1997, \'["Rock","Electronic"]\', \'["Alternative Rock"]\', \'["Vinyl"]\', \'["LP","Album"]\', \'[{"name":"Parlophone","catno":"7243"}]\', \'https://www.discogs.com/release/1001\', \'UK\', 5000, 3000, \'2024-01-01\', \'2024-01-01\')'
    );
    await dbRun(
      'INSERT INTO discogs_releases (id, user_id, discogs_id, title, year, genres, styles, formats, format_details, labels, discogs_url, country, community_have, community_want, created_at, updated_at) VALUES (2, 1, 1002, \'Abbey Road\', 1969, \'["Rock"]\', \'["Pop Rock"]\', \'["Vinyl"]\', \'["LP","Album","Reissue"]\', \'[{"name":"Apple Records","catno":"PCS 7088"}]\', \'https://www.discogs.com/release/1002\', \'UK\', 8000, 4000, \'2024-01-01\', \'2024-01-01\')'
    );
    await dbRun(
      "INSERT INTO discogs_releases (id, user_id, discogs_id, title, year, genres, styles, formats, format_details, labels, discogs_url, country, community_have, community_want, created_at, updated_at) VALUES (3, 1, 1003, 'Discovery', 2001, '[\"Electronic\"]', '[\"House\",\"Disco\"]', '[\"CD\"]', '[\"Album\"]', '[{\"name\":\"Virgin\",\"catno\":\"7243\"}]', 'https://www.discogs.com/release/1003', 'FR', 3000, 2000, '2024-01-01', '2024-01-01')"
    );

    // Seed artists
    await dbRun(
      "INSERT INTO discogs_artists (id, user_id, discogs_id, name, created_at) VALUES (1, 1, 2001, 'Radiohead', '2024-01-01')"
    );
    await dbRun(
      "INSERT INTO discogs_artists (id, user_id, discogs_id, name, created_at) VALUES (2, 1, 2002, 'The Beatles', '2024-01-01')"
    );
    await dbRun(
      "INSERT INTO discogs_artists (id, user_id, discogs_id, name, created_at) VALUES (3, 1, 2003, 'Daft Punk', '2024-01-01')"
    );

    // Seed release-artist links
    await dbRun(
      'INSERT INTO discogs_release_artists (release_id, artist_id) VALUES (1, 1)'
    );
    await dbRun(
      'INSERT INTO discogs_release_artists (release_id, artist_id) VALUES (2, 2)'
    );
    await dbRun(
      'INSERT INTO discogs_release_artists (release_id, artist_id) VALUES (3, 3)'
    );

    // Seed collection
    await dbRun(
      "INSERT INTO discogs_collection (id, user_id, release_id, instance_id, folder_id, rating, date_added, created_at) VALUES (1, 1, 1, 5001, 0, 5, '2023-06-15T00:00:00Z', '2023-06-15')"
    );
    await dbRun(
      "INSERT INTO discogs_collection (id, user_id, release_id, instance_id, folder_id, rating, date_added, created_at) VALUES (2, 1, 2, 5002, 0, 5, '2024-01-01T00:00:00Z', '2024-01-01')"
    );
    await dbRun(
      "INSERT INTO discogs_collection (id, user_id, release_id, instance_id, folder_id, rating, date_added, created_at) VALUES (3, 1, 3, 5003, 0, 4, '2024-03-20T00:00:00Z', '2024-03-20')"
    );

    // Seed wantlist
    await dbRun(
      "INSERT INTO discogs_wantlist (user_id, discogs_id, title, artists, year, formats, genres, date_added, created_at) VALUES (1, 9001, 'In Rainbows', '[\"Radiohead\"]', 2007, '[\"Vinyl\"]', '[\"Rock\"]', '2024-04-01T00:00:00Z', '2024-04-01')"
    );

    // Seed stats
    await dbRun(
      'INSERT INTO discogs_collection_stats (user_id, total_items, by_format, wantlist_count, unique_artists, top_genre, oldest_release_year, newest_release_year, most_collected_artist, added_this_year, by_genre, by_decade, updated_at) VALUES (1, 3, \'{"vinyl":2,"cd":1,"cassette":0,"other":0}\', 1, 3, \'Rock\', 1969, 2001, \'{"name":"Radiohead","count":1}\', 2, \'{"Rock":2,"Electronic":2}\', \'{"1960s":1,"1990s":1,"2000s":1}\', \'2024-01-01\')'
    );

    // Seed cross-reference
    await dbRun(
      "INSERT INTO collection_listening_xref (user_id, collection_id, release_id, lastfm_album_name, lastfm_artist_name, play_count, last_played, match_type, match_confidence, updated_at) VALUES (1, 1, 1, 'OK Computer', 'Radiohead', 150, '2024-01-15T10:00:00Z', 'exact', 1.0, '2024-01-01')"
    );
    await dbRun(
      "INSERT INTO collection_listening_xref (user_id, collection_id, release_id, lastfm_album_name, lastfm_artist_name, play_count, last_played, match_type, match_confidence, updated_at) VALUES (1, 2, 2, 'Abbey Road', 'The Beatles', 200, '2024-03-01T10:00:00Z', 'exact', 1.0, '2024-01-01')"
    );
    await dbRun(
      "INSERT INTO collection_listening_xref (user_id, collection_id, release_id, lastfm_album_name, lastfm_artist_name, play_count, last_played, match_type, match_confidence, updated_at) VALUES (1, 3, 3, NULL, NULL, 0, NULL, 'none', 0, '2024-01-01')"
    );
  });

  it('should return collection with correct data', async () => {
    const response = await fetchApp(authRequest('/v1/collecting/collection'));
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(3);
    expect(body.pagination.total).toBe(3);
  });

  it('should filter collection by format', async () => {
    const response = await fetchApp(
      authRequest('/v1/collecting/collection?format=Vinyl')
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(2);
  });

  it('should filter collection by genre', async () => {
    const response = await fetchApp(
      authRequest('/v1/collecting/collection?genre=Electronic')
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('should search collection by title', async () => {
    const response = await fetchApp(
      authRequest('/v1/collecting/collection?q=Computer')
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe('OK Computer');
  });

  it('should return collection stats', async () => {
    const response = await fetchApp(authRequest('/v1/collecting/stats'));
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data.total_items).toBe(3);
    expect(body.data.by_format.vinyl).toBe(2);
    expect(body.data.unique_artists).toBe(3);
  });

  it('should return recent items ordered by date_added desc', async () => {
    const response = await fetchApp(
      authRequest('/v1/collecting/recent?limit=2')
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(2);
    // Most recent first
    expect(body.data[0].title).toBe('Discovery');
    expect(body.data[1].title).toBe('Abbey Road');
  });

  it('should return single collection item detail', async () => {
    const response = await fetchApp(authRequest('/v1/collecting/collection/1'));
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.title).toBe('OK Computer');
    expect(body.country).toBe('UK');
    expect(body.community_have).toBe(5000);
  });

  it('should return wantlist', async () => {
    const response = await fetchApp(authRequest('/v1/collecting/wantlist'));
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe('In Rainbows');
  });

  it('should return format breakdown', async () => {
    const response = await fetchApp(authRequest('/v1/collecting/formats'));
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data.length).toBeGreaterThan(0);
    const vinyl = body.data.find((f: { name: string }) => f.name === 'Vinyl');
    expect(vinyl).toBeDefined();
    expect(vinyl.count).toBe(2);
  });

  it('should return genre breakdown', async () => {
    const response = await fetchApp(authRequest('/v1/collecting/genres'));
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('should return artist rankings', async () => {
    const response = await fetchApp(authRequest('/v1/collecting/artists'));
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data.length).toBe(3);
  });

  it('should return cross-reference data with summary', async () => {
    const response = await fetchApp(
      authRequest('/v1/collecting/cross-reference')
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(3);
    expect(body.summary.total_matches).toBe(2);
    expect(body.summary.unlistened_count).toBe(1);
    expect(body.summary.listen_rate).toBeCloseTo(2 / 3, 1);
  });

  it('should filter cross-reference to listened items', async () => {
    const response = await fetchApp(
      authRequest('/v1/collecting/cross-reference?filter=listened')
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(2);
    expect(
      body.data.every(
        (d: { listening: { play_count: number } }) => d.listening.play_count > 0
      )
    ).toBe(true);
  });

  it('should filter cross-reference to unlistened items', async () => {
    const response = await fetchApp(
      authRequest('/v1/collecting/cross-reference?filter=unlistened')
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(1);
  });
});
