-- Track which hero slot each adventure session belongs to.
-- Existing sessions default to slot_1 (safe: multi-slot support is new).
ALTER TABLE adventure_sessions ADD COLUMN IF NOT EXISTS slot_id TEXT NOT NULL DEFAULT 'slot_1';
