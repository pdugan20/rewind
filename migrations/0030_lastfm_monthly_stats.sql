-- Per-month listening stats precompute. Powers the bar chart on the
-- listening page year view. Populated by syncMonthlyStats during the
-- daily 0 3 cron; replaces a 4-aggregate live GROUP BY over scrobbles
-- in the /v1/listening/year/{year} handler.
CREATE TABLE IF NOT EXISTS lastfm_monthly_stats (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  year_month text NOT NULL,
  scrobbles integer DEFAULT 0 NOT NULL,
  unique_artists integer DEFAULT 0 NOT NULL,
  unique_albums integer DEFAULT 0 NOT NULL,
  computed_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lastfm_monthly_stats_unique
  ON lastfm_monthly_stats (user_id, year_month);

CREATE INDEX IF NOT EXISTS idx_lastfm_monthly_stats_user_id
  ON lastfm_monthly_stats (user_id);
