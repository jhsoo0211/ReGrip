-- Session provenance only. Historical measurements remain source=unknown;
-- do not infer hardware from force values, dates, or old calibration records.
-- Apply after 001, corrected 002, and 003 on PostgreSQL.
BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS input_source varchar(16) NOT NULL DEFAULT 'unknown';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS calibration_snapshot jsonb;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS ck_sessions_input_source;
ALTER TABLE sessions ADD CONSTRAINT ck_sessions_input_source
  CHECK (input_source IN ('ble','websocket','simulation','unknown'));

COMMIT;
