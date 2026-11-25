-- Running activities can now arrive from Apple Health (the Pulso iPhone app)
-- as well as Strava. source_id keeps the HealthKit uuid for those runs
-- (services/apple-health/ingest.ts).
ALTER TABLE strava_activities ADD COLUMN source TEXT NOT NULL DEFAULT 'strava';
ALTER TABLE strava_activities ADD COLUMN source_id TEXT;
CREATE INDEX idx_strava_activities_source_id ON strava_activities (source, source_id);
