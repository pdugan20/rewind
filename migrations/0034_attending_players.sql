-- Players + per-game appearances for the attending domain.
-- Modeled separately from `performers` (musical acts) because the
-- schema diverges meaningfully — players have positions, jersey
-- numbers, batting/pitching hands, debut dates.
--
-- Cross-source IDs:
--   mlb_stats_id — MLB Stats API roster + boxscore endpoints
--   espn_id      — ESPN game summary (resolved via name+jersey match)
--
-- Photos live in the shared `images` table, keyed on
-- (domain='attending', entity_type='player_silo'|'player_full',
-- entity_id=<players.id>). Both the MLB silo cutout and the ESPN
-- full-body PNG are stored when both sources resolve.
--
-- attended_event_players holds one row per (event, player) appearance
-- with batting/pitching/fielding lines as JSON. Capture-broadly bias —
-- store full per-game stat lines so future UIs (year-in-review, hero
-- stats, "best games I saw") can render whatever cut they need.

CREATE TABLE IF NOT EXISTS players (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  league text NOT NULL,
  mlb_stats_id integer,
  espn_id text,
  full_name text NOT NULL,
  first_name text,
  last_name text,
  primary_position text,
  primary_number text,
  birth_date text,
  birth_city text,
  birth_country text,
  bats text,
  throws text,
  primary_team_id integer,
  debut_date text,
  bio_data text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_players_league_mlb_stats_id
  ON players (league, mlb_stats_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_league_espn_id
  ON players (league, espn_id);
CREATE INDEX IF NOT EXISTS idx_players_team ON players (primary_team_id);
CREATE INDEX IF NOT EXISTS idx_players_last_name ON players (last_name);

CREATE TABLE IF NOT EXISTS attended_event_players (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  event_id integer NOT NULL REFERENCES attended_events(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES players(id),
  team_id integer,
  is_home integer DEFAULT 0 NOT NULL,
  batting_line text,
  pitching_line text,
  fielding_line text,
  decision text,
  notable integer DEFAULT 0 NOT NULL,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attended_event_players_unique
  ON attended_event_players (event_id, player_id);
CREATE INDEX IF NOT EXISTS idx_attended_event_players_event
  ON attended_event_players (event_id);
CREATE INDEX IF NOT EXISTS idx_attended_event_players_player
  ON attended_event_players (player_id);
CREATE INDEX IF NOT EXISTS idx_attended_event_players_decision
  ON attended_event_players (decision);
CREATE INDEX IF NOT EXISTS idx_attended_event_players_notable
  ON attended_event_players (notable);
