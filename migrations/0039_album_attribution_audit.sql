-- Audit log for the album-attribution-repair Phase 3 split/collapse run.
--
-- Every action the repair script takes (KEEP_AS_VA, COLLAPSE_TO_PRIMARY,
-- SPLIT_PER_ARTIST) writes a row here so we can reason about, spot-check,
-- and reverse changes if needed. Kept in prod for at least 30 days
-- post-run.
--
-- See docs/projects/album-attribution-repair/README.md.

CREATE TABLE IF NOT EXISTS lastfm_album_attribution_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_album_id INTEGER NOT NULL,
  original_album_name TEXT NOT NULL,
  original_artist_id INTEGER,
  action TEXT NOT NULL,
  new_album_id INTEGER,
  new_artist_id INTEGER,
  tracks_moved INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_album_attribution_audit_original
  ON lastfm_album_attribution_audit(original_album_id);
CREATE INDEX IF NOT EXISTS idx_album_attribution_audit_action
  ON lastfm_album_attribution_audit(action);
CREATE INDEX IF NOT EXISTS idx_album_attribution_audit_created
  ON lastfm_album_attribution_audit(created_at);
