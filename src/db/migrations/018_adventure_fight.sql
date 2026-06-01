-- Server-authoritative adventure combat (Phase 1).
-- Stores the latest server-run fight result so /adventure/complete-node can
-- trust the server's own outcome instead of the client's claim.
ALTER TABLE adventure_sessions ADD COLUMN IF NOT EXISTS last_fight JSONB;
