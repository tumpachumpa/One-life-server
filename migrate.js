require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
  max: 1,
});

const MIGRATIONS = [
  'src/db/migrations/001_base.sql',
  'src/db/migrations/002_tile_claims.sql',
  'src/db/migrations/003_player_world_state.sql',
  'src/db/migrations/004_camps.sql',
  'src/db/migrations/005_camp_snaps.sql',
  'src/db/migrations/006_pvp_records.sql',
  'src/db/migrations/007_pvp_record_challenge_id.sql',
  'src/db/migrations/008_camp_in_adventure.sql',
  'src/db/migrations/009_fix_pending_loot_column.sql',
  'src/db/migrations/010_fight_seed.sql',
  'src/db/migrations/011_defender_snap.sql',
  'src/db/migrations/012_adventure_sessions.sql',
  'src/db/migrations/013_pvp_normalized_pair.sql',
  'src/db/migrations/014_encounter_charges.sql',
  'src/db/migrations/015_hero_slots.sql',
  'src/db/migrations/016_session_nonce.sql',
];

async function run() {
  // Fast connectivity check — if DB is unreachable, skip all migrations so
  // server.js can still start within Railway's healthcheck window.
  try {
    await pool.query('SELECT 1');
  } catch {
    console.log('DB unreachable at startup, skipping migrations.');
    return;
  }
  for (const file of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    try {
      await pool.query(sql);
      console.log(`${file} applied successfully.`);
    } catch (err) {
      console.error(`${file} failed:`, err.message);
    }
  }
}

run()
  .catch(err => console.error('Migration fatal:', err.message))
  .finally(() => pool.end().catch(() => null).then(() => process.exit(0)));
