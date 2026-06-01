-- Phase 4: server-authoritative run HP.
-- Stores the authoritative current HP for the active run so fight-start HP,
-- between-node heals, and POST /hero are no longer client-trusted. Shape:
--   { "hp": <int>, "at": <ms-epoch of last update> }
-- The `at` timestamp lets the server credit passive hunger regen for elapsed
-- time. NULL on legacy/in-progress sessions (server falls back to saved hp).
ALTER TABLE adventure_sessions ADD COLUMN IF NOT EXISTS run_hp JSONB;

-- Phase 4: consumable heals during a server-authoritative run go through
-- POST /adventure/heal, which validates item possession then enqueues a
-- deferred removal here. POST /hero strips these from whatever inventory the
-- client saves, so a cheater cannot re-add a consumed campfire to heal again.
-- Same shape/mechanism as pvp_pending_removals, but with no pvp_records FK
-- (these aren't tied to a PvP fight).
CREATE TABLE IF NOT EXISTS adventure_pending_removals (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry      JSONB NOT NULL,
  applied    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adv_pending_removals_user
  ON adventure_pending_removals(user_id) WHERE applied = FALSE;
