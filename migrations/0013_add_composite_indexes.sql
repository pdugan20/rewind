-- Composite index for watch_history dedup queries (movieId + watchedAt)
CREATE INDEX IF NOT EXISTS idx_watch_history_movie_watched ON watch_history (movie_id, watched_at);

-- Composite index for strava_splits bulk operations (userId + activityStravaId)
CREATE INDEX IF NOT EXISTS idx_strava_splits_user_activity ON strava_splits (user_id, activity_strava_id);

-- Composite index for plex_episodes timeline queries (userId + watchedAt)
CREATE INDEX IF NOT EXISTS idx_plex_episodes_timeline ON plex_episodes_watched (user_id, watched_at);
