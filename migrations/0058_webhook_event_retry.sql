-- Durable retry state for Strava webhook events (services/strava/webhook.ts).
-- Existing rows were processed inline when they were recorded, so they
-- default to 'done'.
ALTER TABLE webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE webhook_events ADD COLUMN payload TEXT;
ALTER TABLE webhook_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_events ADD COLUMN next_attempt_at TEXT;
ALTER TABLE webhook_events ADD COLUMN last_error TEXT;
CREATE INDEX idx_webhook_events_pending
  ON webhook_events (event_source, status, next_attempt_at);
