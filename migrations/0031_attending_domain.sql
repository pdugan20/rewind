-- Attending domain: live events you bought tickets for (sports games,
-- concerts, theater, comedy). Polymorphic core in attended_events,
-- type-specific data in event_data JSON. Performers (concerts) cross-link
-- to lastfm_artists; sports teams stay in event_data JSON for now.
-- Provenance trail in attended_event_sources lets the gcal/gmail backfill
-- be re-parsed without losing context.

CREATE TABLE IF NOT EXISTS venues (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  name text NOT NULL,
  aliases text,
  city text,
  state text,
  country text,
  latitude real,
  longitude real,
  capacity integer,
  external_ids text,
  image_key text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_venues_user_name ON venues (user_id, name);
CREATE INDEX IF NOT EXISTS idx_venues_city ON venues (city);

CREATE TABLE IF NOT EXISTS performers (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  name text NOT NULL,
  performer_type text DEFAULT 'musical_artist' NOT NULL,
  mbid text,
  lastfm_artist_id integer REFERENCES lastfm_artists(id),
  external_ids text,
  image_key text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_performers_user_name_type
  ON performers (user_id, name, performer_type);
CREATE INDEX IF NOT EXISTS idx_performers_mbid ON performers (mbid);
CREATE INDEX IF NOT EXISTS idx_performers_lastfm_artist
  ON performers (lastfm_artist_id);

CREATE TABLE IF NOT EXISTS attended_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  category text NOT NULL,
  event_type text NOT NULL,
  event_date text NOT NULL,
  event_datetime text,
  venue_id integer REFERENCES venues(id),
  title text NOT NULL,
  subtitle text,
  series_id text,
  external_id text,
  external_source text,
  event_data text,
  notes text,
  attended integer DEFAULT 1 NOT NULL,
  image_key text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attended_events_external
  ON attended_events (external_source, external_id);
CREATE INDEX IF NOT EXISTS idx_attended_events_user_date
  ON attended_events (user_id, event_date);
CREATE INDEX IF NOT EXISTS idx_attended_events_type_date
  ON attended_events (event_type, event_date);
CREATE INDEX IF NOT EXISTS idx_attended_events_category
  ON attended_events (category);
CREATE INDEX IF NOT EXISTS idx_attended_events_venue
  ON attended_events (venue_id);
CREATE INDEX IF NOT EXISTS idx_attended_events_series
  ON attended_events (series_id);

CREATE TABLE IF NOT EXISTS attended_event_performers (
  event_id integer NOT NULL REFERENCES attended_events(id) ON DELETE CASCADE,
  performer_id integer NOT NULL REFERENCES performers(id),
  role text DEFAULT 'headliner' NOT NULL,
  billing_order integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (event_id, performer_id)
);

CREATE INDEX IF NOT EXISTS idx_attended_event_performers_performer
  ON attended_event_performers (performer_id);

CREATE TABLE IF NOT EXISTS attended_event_tickets (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  event_id integer NOT NULL REFERENCES attended_events(id) ON DELETE CASCADE,
  vendor text NOT NULL,
  order_id text,
  section text,
  row text,
  seat text,
  quantity integer DEFAULT 1 NOT NULL,
  total_price_cents integer,
  currency text DEFAULT 'USD' NOT NULL,
  purchased_at text,
  source_type text DEFAULT 'manual' NOT NULL,
  source_ref text,
  raw_data text,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attended_event_tickets_event
  ON attended_event_tickets (event_id);
CREATE INDEX IF NOT EXISTS idx_attended_event_tickets_vendor
  ON attended_event_tickets (vendor);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attended_event_tickets_vendor_order
  ON attended_event_tickets (vendor, order_id);

CREATE TABLE IF NOT EXISTS attended_event_sources (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  event_id integer REFERENCES attended_events(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_ref text NOT NULL,
  raw_data text,
  match_confidence real,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attended_event_sources_unique
  ON attended_event_sources (source_type, source_ref);
CREATE INDEX IF NOT EXISTS idx_attended_event_sources_event
  ON attended_event_sources (event_id);
