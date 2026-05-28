/**
 * One-shot patch: re-roll affixes on all existing Stonewall items.
 *
 * Usage (from onelife-server root):
 *   DATABASE_URL=<your-railway-url> node scripts/patch_stonewall.js
 *
 * Safe to run multiple times — only writes rows that actually need patching.
 * Close the game tab first so the next auto-save doesn't overwrite the patch.
 */

require('dotenv').config();
const pool = require('../src/db/pool');

const STONEWALL_ID = 'stonewall';

const STALE_AFFIX_TYPES = new Set([
  'max_hp', 'armor', 'armor_pct', 'counter_chance', 'crit_resist', 'magic_defense',
]);

function needsPatch(itemRef) {
  if (!itemRef || typeof itemRef !== 'object') return false;
  const id = itemRef.id || itemRef.baseId;
  if (id !== STONEWALL_ID) return false;
  const nonBase = (itemRef.effects || []).filter(e => !e._base);
  // Patch if: no affixes at all, or contains any of the old hardcoded ones
  return nonBase.length === 0 || nonBase.some(e => STALE_AFFIX_TYPES.has(e.type));
}

async function run() {
  // Dynamic import for ESM game logic
  const { applyItemRarity, ITEM_RARITIES } = await import('../src/game/logic/loot.js');
  const { getItem } = await import('../src/game/logic/content.js');

  const ARTIFACT_RARITY = ITEM_RARITIES.artifact;
  const template = getItem(STONEWALL_ID);
  if (!template) throw new Error('Stonewall not found in items.json');

  function reroll(itemRef) {
    const baseItem = {
      ...template,
      uid: itemRef.uid,
      baseId: itemRef.baseId || STONEWALL_ID,
      effects: (template.effects || []).filter(e => e._base),
      ...(itemRef.runemarks  ? { runemarks:   itemRef.runemarks  } : {}),
      ...(itemRef.enchantment ? { enchantment: itemRef.enchantment } : {}),
    };
    return applyItemRarity(baseItem, ARTIFACT_RARITY);
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT user_id, slot_id, save_data FROM heroes WHERE save_data IS NOT NULL'
    );

    let patchedCount = 0;

    for (const row of rows) {
      const hero = row.save_data?.hero;
      if (!hero) continue;

      let changed = false;

      // --- equip slots ---
      const equip = { ...(hero.equip || {}) };
      for (const [slot, itemRef] of Object.entries(equip)) {
        if (needsPatch(itemRef)) {
          console.log(`  [equip:${slot}] user=${row.user_id} slot=${row.slot_id}`);
          equip[slot] = reroll(itemRef);
          changed = true;
        }
      }

      // --- inventory ---
      const inventory = (hero.inventory || []).map(placed => {
        if (!needsPatch(placed?.itemId)) return placed;
        console.log(`  [inventory] user=${row.user_id} slot=${row.slot_id}`);
        changed = true;
        return { ...placed, itemId: reroll(placed.itemId) };
      });

      // --- stash (top-level on save_data, not under hero) ---
      const stash = (row.save_data.stash || []).map(placed => {
        if (!needsPatch(placed?.itemId)) return placed;
        console.log(`  [stash] user=${row.user_id} slot=${row.slot_id}`);
        changed = true;
        return { ...placed, itemId: reroll(placed.itemId) };
      });

      if (!changed) continue;

      await client.query(
        'UPDATE heroes SET save_data = $1, updated_at = NOW() WHERE user_id = $2 AND slot_id = $3',
        [{ ...row.save_data, stash, hero: { ...hero, equip, inventory } }, row.user_id, row.slot_id]
      );

      patchedCount++;
      console.log(`✓ Saved user=${row.user_id} slot=${row.slot_id}`);
    }

    console.log(`\nDone. Patched ${patchedCount} hero save(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Patch failed:', err);
  process.exit(1);
});
