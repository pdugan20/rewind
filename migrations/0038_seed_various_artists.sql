-- Seed the canonical "Various Artists" artist row.
--
-- Used by the album-attribution-repair project (Phase 2) to give real
-- compilations a stable home. Real compilation albums (movie/TV
-- soundtracks, tribute records, NOW-style comps) point their artist_id
-- at this row. Per-artist albums never resolve here.
--
-- MBID source: MusicBrainz canonical Various Artists entity
-- (89ad4ac3-39f7-470e-963a-56509c546377). Last.fm uses the same id.
--
-- INSERT OR IGNORE so re-running is safe; the unique (user_id, name)
-- index on lastfm_artists prevents duplicates.

INSERT OR IGNORE INTO lastfm_artists (user_id, mbid, name, is_filtered, created_at, updated_at) VALUES
  (1, '89ad4ac3-39f7-470e-963a-56509c546377', 'Various Artists', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
