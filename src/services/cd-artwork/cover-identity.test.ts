import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { verifiedCover } from './selection.js';
import type { ArtworkEnv } from './types.js';
import type { CatalogAlbum } from './sources.js';
import { checkListeningArtwork } from './discovery.js';

const runtime = env as typeof env & ArtworkEnv;
const album: CatalogAlbum = {
  name: 'Synthetic album',
  artist: 'Synthetic and Guest',
};
const collection = (
  id: number,
  name = 'Synthetic album',
  date = '1999-06-08'
) => ({
  wrapperType: 'collection',
  collectionId: id,
  collectionName: name,
  artistName: 'Synthetic & Guest',
  releaseDate: date,
  artworkUrl100: 'https://is1-ssl.mzstatic.com/synthetic/100x100bb.jpg',
});
type Collection = ReturnType<typeof collection>;
function catalog(
  candidates: Collection[],
  tracks: Record<number, string[]>,
  counts: Record<number, number> = {}
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    await runtime.DB.exec(
      'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1'
    );
    const u = new URL(String(url));
    if (u.hostname !== 'itunes.apple.com')
      throw new Error('Unexpected provider');
    if (u.pathname === '/search') return Response.json({ results: candidates });
    const id = Number(u.searchParams.get('id'));
    return Response.json({
      results: [
        {
          ...candidates.find((c) => c.collectionId === id),
          trackCount: counts[id] ?? tracks[id]?.length,
        },
        ...(tracks[id] ?? []).map((trackName) => ({
          wrapperType: 'track',
          collectionId: id,
          trackName,
        })),
      ].filter(Boolean),
    });
  });
}
beforeAll(async () => applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS));
beforeEach(async () => {
  await runtime.DB.exec(
    'DELETE FROM cd_artwork_events; DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
  await runtime.DB.exec(
    "UPDATE cd_artwork_control SET enabled=1,automatic_enabled=1,enroll_since='2000-01-01',provider_next_ms=0; INSERT INTO lastfm_artists(id,user_id,name,created_at,updated_at) VALUES(1,1,'Synthetic and Guest','2026-01-01','2026-01-01'); INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(1,1,1,'Synthetic album','2026-01-01','2026-01-01'); INSERT INTO lastfm_tracks(id,user_id,artist_id,album_id,name,created_at,updated_at) VALUES(1,1,1,1,'First song','2026-01-01','2026-01-01'),(2,1,1,1,'Second song','2026-01-01','2026-01-01'); INSERT INTO lastfm_scrobbles(user_id,track_id,album_id,album_recorded,scrobbled_at,created_at) VALUES(1,1,1,1,'2026-11-01','2026-11-01');"
  );
});
afterEach(() => vi.restoreAllMocks());

it('accepts a verified saved binding across conjunction typography and preserves diagnostics', async () => {
  const fetcher = catalog(
    [collection(123, 'Synthetic album (Deluxe Edition)')],
    { 123: ['First song'] }
  );
  const selected = await verifiedCover(runtime, 1, 1, {
    ...album,
    apple_music_id: 123,
  });
  expect(selected.discovery.identity_evidence).toMatchObject({
    selection_rule: 'verified_stored_catalog_binding',
    selected_id: '123',
    candidates: [
      {
        artist_verified: true,
        title_verified: true,
        observed_track_matches: 1,
        release_date: '1999-06-08',
      },
    ],
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('selects a representative standard/deluxe cover despite regional, promo or missing dates', async () => {
  catalog(
    [
      collection(124, 'Synthetic album (Deluxe Edition)', '2005-01-01'),
      collection(123, 'Synthetic album (Remastered)', ''),
    ],
    {
      123: ['First song', 'Second song'],
      124: ['First song', 'Second song', 'Bonus song'],
    }
  );
  const selected = await verifiedCover(runtime, 1, 1, album);
  expect(selected.identityType).toBe('reviewed_source');
  expect(selected.request.release_id).toBeNull();
  expect(selected.discovery).toMatchObject({
    collection_id: '123',
    cover_selection: 'representative_catalog_edition',
    identity_evidence: {
      selection_rule: 'equivalent_catalog_tracklists',
      date_policy: 'supporting_evidence_only',
    },
  });
});
it('holds different same-title albums sharing just one played song', async () => {
  catalog([collection(123), collection(124, 'Synthetic album', '2010-01-01')], {
    123: ['First song', 'Original song'],
    124: ['First song', 'Unrelated song'],
  });
  await expect(verifiedCover(runtime, 1, 1, album)).rejects.toMatchObject({
    code: 'cover_identity_ambiguous',
    identityEvidence: {
      reason: 'competing_tracklists',
      candidates: [
        { id: '123', observed_track_matches: 1 },
        { id: '124', observed_track_matches: 1 },
      ],
    },
  });
});
it('uses multiple distinct played songs to distinguish competing tracklists', async () => {
  await runtime.DB.exec(
    "INSERT INTO lastfm_scrobbles(user_id,track_id,album_id,album_recorded,scrobbled_at,created_at) VALUES(1,2,1,1,'2026-11-02','2026-11-02')"
  );
  catalog([collection(123), collection(124)], {
    123: ['First song', 'Second song'],
    124: ['First song', 'Other song'],
  });
  expect((await verifiedCover(runtime, 1, 1, album)).discovery).toMatchObject({
    collection_id: '123',
    identity_evidence: { selection_rule: 'observed_tracks_distinguish_album' },
  });
});
it('does not count repeated plays as independent track evidence', async () => {
  await runtime.DB.exec(
    "INSERT INTO lastfm_scrobbles(user_id,track_id,album_id,album_recorded,scrobbled_at,created_at) VALUES(1,1,1,1,'2026-11-02','2026-11-02')"
  );
  catalog([collection(123), collection(124)], {
    123: ['First song', 'Second song'],
    124: ['First song', 'Other song'],
  });
  await expect(verifiedCover(runtime, 1, 1, album)).rejects.toMatchObject({
    code: 'cover_identity_ambiguous',
  });
});
it('does not count spelling or article variants as distinct matched catalog songs', async () => {
  await runtime.DB.exec(
    "INSERT INTO lastfm_tracks(id,user_id,artist_id,album_id,name,created_at,updated_at) VALUES(3,1,1,1,'The First song','2026-01-01','2026-01-01'); INSERT INTO lastfm_scrobbles(user_id,track_id,album_id,album_recorded,scrobbled_at,created_at) VALUES(1,3,1,1,'2026-11-02','2026-11-02'),(1,2,1,1,'2026-11-03','2026-11-03')"
  );
  catalog([collection(123), collection(124)], {
    123: ['First song', 'Other song'],
    124: ['Second song', 'Different song'],
  });
  await expect(verifiedCover(runtime, 1, 1, album)).rejects.toMatchObject({
    code: 'cover_identity_ambiguous',
    identityEvidence: {
      candidates: [
        { observed_track_matches: 1 },
        { observed_track_matches: 1 },
      ],
    },
  });
});
it('does not equate a partial tracklist with a complete album', async () => {
  catalog(
    [collection(123), collection(124)],
    { 123: ['First song'], 124: ['First song', 'Other song'] },
    { 123: 12, 124: 2 }
  );
  await expect(verifiedCover(runtime, 1, 1, album)).rejects.toMatchObject({
    code: 'cover_identity_ambiguous',
    identityEvidence: { reason: 'incomplete_competing_tracklists' },
  });
});
it('keeps a same-title competitor with no returned tracks unresolved', async () => {
  catalog([collection(123), collection(124)], { 123: ['First song'] });
  await expect(verifiedCover(runtime, 1, 1, album)).rejects.toMatchObject({
    code: 'cover_identity_ambiguous',
    identityEvidence: { reason: 'incomplete_competing_tracklists' },
  });
});
it('does not equate paginated Apple tracklists even when the first pages match', async () => {
  const apple = (id: string) => ({
    id,
    attributes: {
      name: album.name,
      artistName: album.artist,
      trackCount: 1,
      artwork: { url: 'https://is1-ssl.mzstatic.com/synthetic/{w}x{h}bb.jpg' },
    },
    relationships: {
      tracks: {
        next: '/v1/catalog/us/albums/123/tracks?offset=1',
        data: [{ id: '1', attributes: { name: 'First song' } }],
      },
    },
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    await runtime.DB.exec('UPDATE cd_artwork_control SET provider_next_ms=0');
    const u = String(url);
    return Response.json(
      u.includes('/search?')
        ? { results: { albums: { data: [apple('123'), apple('124')] } } }
        : { data: [apple(u.includes('/123?') ? '123' : '124')] }
    );
  });
  await expect(
    verifiedCover(
      { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic' },
      1,
      1,
      album
    )
  ).rejects.toMatchObject({
    code: 'cover_identity_ambiguous',
    identityEvidence: { reason: 'incomplete_competing_tracklists' },
  });
});
it.each([
  'Synthetic album (Live)',
  'Synthetic album (Remix)',
  'Synthetic album (Artist’s Version)',
  'Different album',
])('preserves distinct album identity: %s', async (name) => {
  catalog([collection(123, name)], { 123: ['First song'] });
  await expect(
    verifiedCover(runtime, 1, 1, { ...album, apple_music_id: 123 })
  ).rejects.toMatchObject({
    code: 'cover_identity_unverified',
    identityEvidence: { reason: 'contradictory_stored_catalog_binding' },
  });
});
it('does not replace a contradictory saved catalog id with a convenient search hit', async () => {
  const fetcher = catalog([collection(123, 'Other album'), collection(124)], {
    123: ['First song'],
    124: ['First song'],
  });
  await expect(
    verifiedCover(runtime, 1, 1, { ...album, apple_music_id: 123 })
  ).rejects.toMatchObject({ code: 'cover_identity_unverified' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('persists bounded private rejection evidence and the catalog snapshot without creating a generation job', async () => {
  catalog([collection(123), collection(124)], {
    123: ['First song', 'Other song'],
    124: ['First song', 'Different song'],
  });
  const check = await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_checks WHERE completed_at IS NULL'
  ).first<{ id: number }>();
  expect((await checkListeningArtwork(runtime, check!.id)).outcome).toBe(
    'identity_required'
  );
  const stored = await runtime.DB.prepare(
    'SELECT discovery_evidence FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
  ).first<{ discovery_evidence: string }>();
  expect(JSON.parse(stored!.discovery_evidence)).toMatchObject({
    catalog_identity: {
      name: album.name,
      artist: album.artist,
      apple_music_id: null,
    },
    identity_evidence: { reason: 'competing_tracklists' },
  });
  expect(
    (await runtime.DB.prepare('SELECT COUNT(*) n FROM cd_artwork_jobs').first<{
      n: number;
    }>())!.n
  ).toBe(0);
});
