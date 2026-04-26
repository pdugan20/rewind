-- OAuth refresh-token storage for the personal Google account backing
-- the attending domain's Calendar + Gmail extractors. Same shape as
-- trakt_tokens / strava_tokens. Seeded by scripts/tools/setup-google.ts.

CREATE TABLE IF NOT EXISTS google_tokens (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at integer NOT NULL,
  scopes text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_google_tokens_user_id ON google_tokens (user_id);
