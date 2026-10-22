import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  lastfmAlbums,
  lastfmArtists,
  lastfmTracks,
  lastfmScrobbles,
} from '../../db/schema/lastfm.js';
import { resolveOwnedCatalogAlbum } from './resolve-owned-album.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  fileUnderCatalogArtist,
  hasVerifiedAlbumAttribution,
} from './album-attribution.js';
const db = createDb(env.DB);
const catalog = {
  id: 700,
  name: 'Collected Sessions',
  artistName: 'Album Ensemble',
  url: 'https://music.apple.com/us/album/collected/700',
};
beforeAll(setupTestDb);
beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM lastfm_album_attribution_audit; DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_album_tracks; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
  await env.DB.exec(
    "UPDATE cd_artwork_control SET enabled=1,automatic_enabled=1,enroll_since='2099-01-01' WHERE id=1"
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function seed() {
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: 'Recording Ensemble' })
    .returning();
  const [source] = await db
    .insert(lastfmAlbums)
    .values({ artistId: artist.id, name: catalog.name })
    .returning();
  const [other] = await db
    .insert(lastfmAlbums)
    .values({ artistId: artist.id, name: 'Original Recording' })
    .returning();
  const [track] = await db
    .insert(lastfmTracks)
    .values({ artistId: artist.id, name: 'Distant Horizon', albumId: other.id })
    .returning();
  await db.insert(lastfmScrobbles).values([
    {
      trackId: track.id,
      albumId: source.id,
      albumRecorded: 1,
      scrobbledAt: '2026-01-01T00:00:00Z',
    },
    {
      trackId: track.id,
      albumId: other.id,
      albumRecorded: 1,
      scrobbledAt: '2026-01-01T00:01:00Z',
    },
  ]);
  return { artist, source, track, other };
}
it('files a verified album credit while preserving recording artists and other album plays', async () => {
  const s = await seed();
  const preview = await fileUnderCatalogArtist(
    db,
    1,
    s.source.id,
    catalog,
    true,
    true
  );
  expect(preview).toEqual({ albumId: null, changed: true });
  expect(await db.select().from(lastfmAlbums)).toHaveLength(2);
  const result = await fileUnderCatalogArtist(
    db,
    1,
    s.source.id,
    catalog,
    true
  );
  expect(result?.changed).toBe(true);
  const albums = await db
    .select()
    .from(lastfmAlbums)
    .where(eq(lastfmAlbums.id, result!.albumId!));
  expect(albums[0]).toMatchObject({ appleMusicId: 700, name: catalog.name });
  expect(
    (await db.select().from(lastfmScrobbles)).map((s) => s.albumId)
  ).toEqual([result!.albumId, s.other.id]);
  expect((await db.select().from(lastfmTracks))[0]).toMatchObject({
    artistId: s.artist.id,
    albumId: s.other.id,
  });
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM cd_artwork_checks').first('n')
  ).toBe(0);
  await fileUnderCatalogArtist(db, 1, s.source.id, catalog, true);
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) n FROM lastfm_album_attribution_audit'
    ).first('n')
  ).toBe(1);
});
it('requires track-credit evidence before filing an album credited to somebody else', async () => {
  const s = await seed();
  expect(
    await fileUnderCatalogArtist(db, 1, s.source.id, catalog, false)
  ).toBeNull();
  expect((await db.select().from(lastfmScrobbles))[0].albumId).toBe(
    s.source.id
  );
  expect(
    await fileUnderCatalogArtist(db, 2, s.source.id, catalog, true)
  ).toBeNull();
});
it.each(['apple_music_pinned', 'is_filtered', 'identity_conflict'])(
  'respects album protection %s',
  async (flag) => {
    const s = await seed();
    await env.DB.prepare(`UPDATE lastfm_albums SET ${flag}=1 WHERE id=?`)
      .bind(s.source.id)
      .run();
    expect(
      await fileUnderCatalogArtist(db, 1, s.source.id, catalog, true)
    ).toBeNull();
  }
);
it.each(['pinned', 'review_hold'])(
  'respects artwork protection %s before creating an alias',
  async (flag) => {
    const s = await seed();
    await env.DB.prepare(
      `INSERT INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,${flag}) VALUES(1,?,'',1,'2099-01-01',1)`
    )
      .bind(s.source.id)
      .run();
    expect(
      await fileUnderCatalogArtist(db, 1, s.source.id, catalog, true)
    ).toBeNull();
  }
);
it('does not reuse a same-title target with a contradictory catalog identity', async () => {
  const s = await seed();
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: catalog.artistName })
    .returning();
  await db
    .insert(lastfmAlbums)
    .values({ name: catalog.name, artistId: artist.id, appleMusicId: 999 });
  expect(
    await fileUnderCatalogArtist(db, 1, s.source.id, catalog, true)
  ).toBeNull();
  expect((await db.select().from(lastfmScrobbles))[0].albumId).toBe(
    s.source.id
  );
});
it('rechecks protections inside the filing transaction', async () => {
  const s = await seed();
  const batch = db.$client.batch.bind(db.$client);
  vi.spyOn(db.$client, 'batch').mockImplementationOnce(async (statements) => {
    await env.DB.prepare(
      'UPDATE lastfm_albums SET apple_music_pinned=1 WHERE id=?'
    )
      .bind(s.source.id)
      .run();
    return batch(statements);
  });
  expect(
    await fileUnderCatalogArtist(db, 1, s.source.id, catalog, true)
  ).toBeNull();
  expect((await db.select().from(lastfmScrobbles))[0].albumId).toBe(
    s.source.id
  );
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) n FROM lastfm_album_attribution_audit'
    ).first('n')
  ).toBe(0);
});

it.each([
  ['album name', "UPDATE lastfm_albums SET name='Changed release' WHERE id=?"],
  [
    'album identity',
    "UPDATE lastfm_albums SET mbid='changed-identity' WHERE id=?",
  ],
  ['album pin', 'UPDATE lastfm_albums SET apple_music_pinned=1 WHERE id=?'],
  ['album exclusion', 'UPDATE lastfm_albums SET is_filtered=1 WHERE id=?'],
  ['album conflict', 'UPDATE lastfm_albums SET identity_conflict=1 WHERE id=?'],
  ['artist name', "UPDATE lastfm_artists SET name='Changed credit' WHERE id=?"],
  [
    'artist identity',
    "UPDATE lastfm_artists SET mbid='changed-identity' WHERE id=?",
  ],
  ['artist exclusion', 'UPDATE lastfm_artists SET is_filtered=1 WHERE id=?'],
  [
    'artist conflict',
    'UPDATE lastfm_artists SET identity_conflict=1 WHERE id=?',
  ],
])(
  'rejects an unbound destination after a concurrent %s change',
  async (_, mutation) => {
    const s = await seed();
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: catalog.artistName })
      .returning();
    const [target] = await db
      .insert(lastfmAlbums)
      .values({ name: catalog.name, artistId: artist.id })
      .returning();
    const prepare = db.$client.prepare.bind(db.$client);
    let injected = false;
    vi.spyOn(db.$client, 'prepare').mockImplementation((query) => {
      const statement = prepare(query);
      if (query.startsWith('update "lastfm_albums" set "apple_music_id"')) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, 'bind').mockImplementation((...params) => {
          const bound = bind(...params);
          const raw = bound.raw.bind(bound);
          vi.spyOn(bound, 'raw').mockImplementation(async (...args) => {
            injected = true;
            await prepare(mutation)
              .bind(mutation.includes('lastfm_artists') ? artist.id : target.id)
              .run();
            return raw(...args);
          });
          return bound;
        });
      }
      return statement;
    });
    expect(
      await fileUnderCatalogArtist(db, 1, s.source.id, catalog, true)
    ).toBeNull();
    expect(injected).toBe(true);
    expect(
      (
        await db
          .select()
          .from(lastfmAlbums)
          .where(eq(lastfmAlbums.id, target.id))
      )[0].appleMusicId
    ).toBeNull();
    expect((await db.select().from(lastfmScrobbles))[0].albumId).toBe(
      s.source.id
    );
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) n FROM lastfm_album_attribution_audit'
      ).first('n')
    ).toBe(0);
  }
);

it('binds and reuses an unchanged destination shell', async () => {
  const s = await seed();
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: catalog.artistName })
    .returning();
  const [target] = await db
    .insert(lastfmAlbums)
    .values({ name: catalog.name, artistId: artist.id })
    .returning();
  expect(
    await fileUnderCatalogArtist(db, 1, s.source.id, catalog, true)
  ).toEqual({ albumId: target.id, changed: true });
  expect((await db.select().from(lastfmScrobbles))[0].albumId).toBe(target.id);
});

it.each(['Another Album Ensemble', 'Various Artists'])(
  'claims one canonical destination even when a competing credit is %s',
  async (competingArtist) => {
    const s = await seed();
    const first = await fileUnderCatalogArtist(
      db,
      1,
      s.source.id,
      catalog,
      true
    );
    expect(first?.changed).toBe(true);
    const second = await fileUnderCatalogArtist(
      db,
      1,
      s.source.id,
      {
        ...catalog,
        id: 701,
        artistName: competingArtist,
        url: 'https://music.apple.com/us/album/other/701',
      },
      true
    );
    expect(second).toBeNull();
    expect((await db.select().from(lastfmScrobbles))[0].albumId).toBe(
      first!.albumId
    );
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) n FROM lastfm_album_attribution_audit WHERE original_album_id=?'
      )
        .bind(s.source.id)
        .first('n')
    ).toBe(1);
  }
);

it('excludes audited recording credits from integrity alarms without hiding unrelated corruption', async () => {
  const s = await seed();
  await db
    .update(lastfmTracks)
    .set({ albumId: s.source.id })
    .where(eq(lastfmTracks.id, s.track.id));
  const filed = await fileUnderCatalogArtist(db, 1, s.source.id, catalog, true);
  const count = async () =>
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(lastfmTracks)
        .innerJoin(lastfmAlbums, eq(lastfmAlbums.id, lastfmTracks.albumId))
        .where(
          sql`${lastfmTracks.artistId}<>${lastfmAlbums.artistId} AND NOT ${hasVerifiedAlbumAttribution()}`
        )
    )[0].n;
  expect(await count()).toBe(0);
  const [foreignCredit] = await db
    .insert(lastfmArtists)
    .values({ name: 'Unverified Recording Artist' })
    .returning();
  await db.insert(lastfmTracks).values({
    artistId: foreignCredit.id,
    name: 'Unrelated song',
    albumId: filed!.albumId,
  });
  expect(await count()).toBe(1);
});

it('confirms an existing edition before trusting search ranking or a recording-credit alias', async () => {
  const s = await seed();
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: catalog.artistName })
    .returning();
  await db.insert(lastfmAlbums).values({
    artistId: artist.id,
    name: 'Collected Sessions (Deluxe Edition)',
    appleMusicId: 700,
  });
  const fetch = vi.fn(async (input: string) =>
    new URL(input).pathname.endsWith('/albums/700')
      ? Response.json({
          data: [
            {
              id: '700',
              type: 'albums',
              attributes: {
                name: 'Collected Sessions (Deluxe Edition)',
                artistName: catalog.artistName,
                url: catalog.url,
              },
              relationships: {
                tracks: {
                  data: [
                    {
                      attributes: {
                        name: 'Distant Horizon (feat. Guest)',
                        artistName: s.artist.name,
                      },
                    },
                  ],
                },
              },
            },
          ],
        })
      : Response.json({ results: {} })
  );
  vi.stubGlobal('fetch', fetch);
  const result = await resolveOwnedCatalogAlbum(db, 'token', 1, s.source.id, {
    album: catalog.name,
    track: s.track.name,
    artist: s.artist.name,
  });
  expect(result).toMatchObject({
    status: 'found',
    album: { id: 700 },
    trackArtistVerified: true,
  });
  expect(fetch).toHaveBeenCalledOnce();
});
it('does not reuse an owner edition whose recording credit or release title fails confirmation', async () => {
  const s = await seed();
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: catalog.artistName })
    .returning();
  await db
    .insert(lastfmAlbums)
    .values({ artistId: artist.id, name: catalog.name, appleMusicId: 700 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      new URL(input).pathname.endsWith('/albums/700')
        ? Response.json({
            data: [
              {
                id: '700',
                type: 'albums',
                attributes: {
                  name: catalog.name,
                  artistName: catalog.artistName,
                  url: catalog.url,
                },
                relationships: {
                  tracks: {
                    data: [
                      {
                        attributes: {
                          name: s.track.name,
                          artistName: 'Unrelated artist',
                        },
                      },
                    ],
                  },
                },
              },
            ],
          })
        : Response.json({ results: {} })
    )
  );
  expect(
    await resolveOwnedCatalogAlbum(db, 'token', 1, s.source.id, {
      album: catalog.name,
      track: s.track.name,
      artist: s.artist.name,
    })
  ).toEqual({ status: 'no_match' });
});
