-- Player bio enrichment columns.
--
-- The boxscore endpoint we ingest from (MLB Stats /game/{pk}/boxscore)
-- only carries `person.fullName` reliably; bat side, throw hand, debut
-- date, birth city/state/country, height, weight, college all live on
-- /api/v1/people/{id}. Until now we relied on the boxscore alone, so
-- those columns were null in practice (see enrich-boxscore upserts —
-- they expect the data but nothing populates it).
--
-- Adding height (text, "6' 2\""), weight (integer lbs), birth state/
-- province, college name, and an awards JSON blob lets the athlete
-- card render the ESPN-style bio strip + career highlights without
-- a second round-trip per player. `awards` is opaque JSON to keep
-- the rate of schema churn down — the API normalizes it on read.

ALTER TABLE players ADD COLUMN height text;--> statement-breakpoint
ALTER TABLE players ADD COLUMN weight integer;--> statement-breakpoint
ALTER TABLE players ADD COLUMN birth_state_province text;--> statement-breakpoint
ALTER TABLE players ADD COLUMN college_name text;--> statement-breakpoint
ALTER TABLE players ADD COLUMN awards text;
