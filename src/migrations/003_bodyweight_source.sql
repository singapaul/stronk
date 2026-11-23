-- Where a bodyweight entry came from. Manual entries (the app, Claude, the API) always win over
-- synced readings; a synced entry is replaced only by a newer synced reading for the same day.
ALTER TABLE body_measurements ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'health_connect'));
-- When the synced reading was taken (ISO-8601 UTC). NULL for manual entries.
ALTER TABLE body_measurements ADD COLUMN measured_at TEXT;
