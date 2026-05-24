// DB patch: update existing Fang of the Red Viper saves with rolled affixes.
// Run: node patch-fang-affixes.js [--apply]
// Without --apply it dry-runs and shows what it would change.
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const DRY_RUN = !process.argv.includes('--apply');

// Fixed seeded result from createLootItem (seed 42) — same affixes every time.
const PATCHED_FANG = {
  id: "fang_of_the_red_viper",
  baseId: "fang_of_the_red_viper",
  uid: "fang_of_the_red_viper_artifact_patch_v1",
  name: "Artifact Fang of the Red Viper",
  rarity: "artifact",
  rarityColor: "#ff6b35",
  type: "gear",
  slot: "weapon",
  family: "spear",
  weaponType: "spear",
  hands: 2,
  attackSpeed: 0.9,
  baseStats: { damage: 11 },
  effects: [
    { name: "Viper's Benediction", type: "poison_on_hit", chance: 100, duration: 4, damagePct: 0.85 },
    { name: "Crimson Covenant",     type: "bleed_on_hit",  chance: 100, duration: 4, damagePct: 0.95 },
    { type: "attack_speed", value: 14 },
    { type: "crit_chance",  value: 5  },
    { type: "lifesteal",    value: 5  },
    { type: "stat_bonus", stat: "str", value: 6 },
    { type: "crit_damage",  value: 10 },
  ],
  tags: ["spear", "weapon", "melee", "two_handed", "artifact"],
  icon: "/assets/items/generated/hunter_spear.png",
};

function isFang(itemId) {
  if (!itemId) return false;
  if (itemId === "fang_of_the_red_viper") return true;
  if (typeof itemId === "object") {
    return itemId.id === "fang_of_the_red_viper" || itemId.baseId === "fang_of_the_red_viper";
  }
  return false;
}

function patchHero(hero) {
  let patched = false;
  const next = JSON.parse(JSON.stringify(hero));

  // Check equip slots
  for (const [slot, itemId] of Object.entries(next.equip || {})) {
    if (isFang(itemId)) {
      console.log(`  Found in equip.${slot}:`, JSON.stringify(itemId).slice(0, 80));
      next.equip[slot] = PATCHED_FANG;
      patched = true;
    }
  }

  // Check inventory
  for (const placed of next.inventory || []) {
    if (placed && isFang(placed.itemId)) {
      console.log(`  Found in inventory [x:${placed.x} y:${placed.y}]:`, JSON.stringify(placed.itemId).slice(0, 80));
      placed.itemId = PATCHED_FANG;
      patched = true;
    }
  }

  // Check stash tabs
  for (const tab of next.stash || []) {
    for (const placed of tab || []) {
      if (placed && isFang(placed.itemId)) {
        console.log(`  Found in stash:`, JSON.stringify(placed.itemId).slice(0, 80));
        placed.itemId = PATCHED_FANG;
        patched = true;
      }
    }
  }

  return { patched, next };
}

async function run() {
  console.log(DRY_RUN ? '--- DRY RUN (pass --apply to write) ---' : '--- APPLYING PATCH ---');

  const rows = await pool.query('SELECT id, slot_id, save_data FROM heroes');
  let found = 0;

  for (const row of rows.rows) {
    const hero = row.save_data?.hero;
    if (!hero) continue;

    const { patched, next } = patchHero(hero);
    if (!patched) continue;

    found++;
    console.log(`\nRow id=${row.id} slot=${row.slot_id} hero="${hero.name}":`);

    if (!DRY_RUN) {
      const newSaveData = { ...row.save_data, hero: next };
      await pool.query(
        'UPDATE heroes SET save_data = $1, updated_at = NOW() WHERE id = $2',
        [newSaveData, row.id]
      );
      console.log('  → Updated.');
    }
  }

  if (found === 0) console.log('\nNo Fangs found in any save slot.');
  else if (DRY_RUN) console.log(`\n${found} row(s) would be patched. Run with --apply to write.`);
  else console.log(`\n${found} row(s) patched.`);
}

run()
  .catch(err => { console.error('Fatal:', err.message); process.exit(1); })
  .finally(() => pool.end().catch(() => null).then(() => process.exit(0)));
