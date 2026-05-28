-- Drop the is_compilation flag and its index.
--
-- The flag was added by migration 0018 to support a cross-artist
-- compilation fallback in the sync upsert path. The
-- album-attribution-repair project (Phase 1-3) removed both the
-- fallback and the data corruption it caused, and migrated all true
-- compilations to the canonical Various Artists artist row. The flag
-- has had no readers since Phase 6 shipped, and is_compilation = 1
-- now equates to "album.artist_id = <Various Artists id>" — derivable
-- from the join.
--
-- See docs/projects/album-attribution-repair/README.md.

DROP INDEX IF EXISTS idx_lastfm_albums_compilation;
ALTER TABLE lastfm_albums DROP COLUMN is_compilation;
