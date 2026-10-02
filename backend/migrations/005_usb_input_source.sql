-- Allow the 5-channel flex sensor PCB connected over USB (Web Serial) as a session source.
-- Existing rows keep their source; nothing is reclassified. Apply after 004 on PostgreSQL.
BEGIN;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS ck_sessions_input_source;
ALTER TABLE sessions ADD CONSTRAINT ck_sessions_input_source
  CHECK (input_source IN ('ble','usb','websocket','simulation','unknown'));

COMMIT;
