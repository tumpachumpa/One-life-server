const pool = require('../db/pool');

const ESSENCE_PER_HOUR = 100;

function reduceOrRemoveSlot(grid, idx, qty) {
  const slot = grid[idx];
  const current = slot?.qty || 1;
  if (current <= qty) {
    grid.splice(idx, 1);
  } else {
    grid[idx] = { ...slot, qty: current - qty };
  }
}

function removeItemFromSave(saveData, entry) {
  const hero = saveData?.hero || {};

  // When a UID is available, search all locations — the item may have moved since
  // the loot pool was recorded (e.g. defender unequipped it before the removal fired).
  if (entry.itemUid) {
    for (const [slot, item] of Object.entries(hero.equip || {})) {
      if (item && typeof item === 'object' && item.uid === entry.itemUid) {
        hero.equip[slot] = null;
        return;
      }
    }
    if (hero.inventory) {
      const idx = hero.inventory.findIndex(p => {
        const item = typeof p?.itemId === 'object' ? p.itemId : null;
        return item?.uid === entry.itemUid;
      });
      if (idx !== -1) { reduceOrRemoveSlot(hero.inventory, idx, entry.qty || 1); return; }
    }
    if (saveData.stash) {
      const idx = saveData.stash.findIndex(p => {
        const item = typeof p?.itemId === 'object' ? p.itemId : null;
        return item?.uid === entry.itemUid;
      });
      if (idx !== -1) { reduceOrRemoveSlot(saveData.stash, idx, entry.qty || 1); return; }
    }
    return;
  }

  // No UID — fall back to location-based removal
  if (entry.source === 'equip') {
    if (hero.equip) hero.equip[entry.slot] = null;
  } else if (entry.source === 'inventory') {
    if (!hero.inventory) return;
    let idx = hero.inventory.findIndex(p => {
      const id = typeof p?.itemId === 'object' ? p.itemId?.id : p?.itemId;
      return id === entry.itemId && p?.x === entry.x && p?.y === entry.y;
    });
    if (idx === -1) {
      idx = hero.inventory.findIndex(p => {
        const id = typeof p?.itemId === 'object' ? p.itemId?.id : p?.itemId;
        return id === entry.itemId;
      });
      console.log(`[PvP] inventory pos-match failed for ${entry.itemId}, fallback id-only idx=${idx}`);
    }
    if (idx !== -1) reduceOrRemoveSlot(hero.inventory, idx, entry.qty || 1);
  } else if (entry.source === 'stash') {
    if (!saveData.stash) return;
    let idx = saveData.stash.findIndex(p => {
      const id = typeof p?.itemId === 'object' ? p.itemId?.id : p?.itemId;
      return id === entry.itemId && p?.x === entry.x && p?.y === entry.y;
    });
    if (idx === -1) {
      idx = saveData.stash.findIndex(p => {
        const id = typeof p?.itemId === 'object' ? p.itemId?.id : p?.itemId;
        return id === entry.itemId;
      });
      console.log(`[PvP] stash pos-match failed for ${entry.itemId}, fallback id-only idx=${idx}`);
    }
    if (idx !== -1) reduceOrRemoveSlot(saveData.stash, idx, entry.qty || 1);
  }
}

// Apply any pending PvP item removals to saveData and mark them applied atomically.
// The UPDATE ... RETURNING pattern ensures concurrent POST /hero calls can't both claim the same rows.
async function applyPendingRemovals(saveData, userId) {
  const pending = await pool.query(
    `UPDATE pvp_pending_removals SET applied = TRUE WHERE user_id = $1 AND applied = FALSE RETURNING id, entry`,
    [userId]
  );
  if (!pending.rows.length) return false;

  for (const row of pending.rows) {
    removeItemFromSave(saveData, row.entry);
  }
  return true;
}

// Apply any pending PvP item grants to saveData and mark them applied atomically.
async function applyPendingLoot(saveData, userId) {
  const pending = await pool.query(
    `UPDATE pvp_pending_loot SET applied = TRUE WHERE user_id = $1 AND applied = FALSE RETURNING id, item`,
    [userId]
  );
  if (!pending.rows.length) return false;

  if (!saveData.pendingLoot) saveData.pendingLoot = [];
  for (const row of pending.rows) {
    saveData.pendingLoot.push(row.item);
  }
  return true;
}

const VALID_SLOT_IDS = new Set(['slot_1', 'slot_2', 'slot_3']);

async function heroRoutes(fastify) {
  // GET /hero — return all saved slots for this user as { slots: { slot_1: {...}, ... } }
  fastify.get('/hero', { preHandler: fastify.authenticate }, async (request) => {
    const { id } = request.user;
    const result = await pool.query(
      'SELECT slot_id, save_data, updated_at FROM heroes WHERE user_id = $1',
      [id]
    );
    if (!result.rows.length) return { slots: {} };

    const slots = {};
    let dirtySlotId = null;

    // Apply passive essence income from tile claim (applied to most-recently-updated slot)
    const claimResult = await pool.query(
      `SELECT last_income_at FROM tile_claims WHERE user_id = $1 AND last_active > NOW() - INTERVAL '5 days'`,
      [id]
    );
    let earnedGold = 0;
    if (claimResult.rows[0]) {
      const lastIncome = new Date(claimResult.rows[0].last_income_at);
      const hoursElapsed = Math.floor((Date.now() - lastIncome.getTime()) / (1000 * 60 * 60));
      if (hoursElapsed > 0) {
        earnedGold = hoursElapsed * ESSENCE_PER_HOUR;
        await pool.query(
          `UPDATE tile_claims SET last_income_at = last_income_at + ($1 * INTERVAL '1 hour') WHERE user_id = $2`,
          [hoursElapsed, id]
        );
      }
    }

    // Sort by updated_at descending so the most-recent slot gets the gold
    const sorted = [...result.rows].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    for (const row of sorted) {
      const data = row.save_data;
      if (earnedGold > 0 && !dirtySlotId) {
        data.hero = data.hero || {};
        data.hero.gold = (data.hero.gold || 0) + earnedGold;
        dirtySlotId = row.slot_id;
      }
      slots[row.slot_id] = data;
    }

    if (dirtySlotId) {
      await pool.query(
        'UPDATE heroes SET save_data = $1, updated_at = NOW() WHERE user_id = $2 AND slot_id = $3',
        [slots[dirtySlotId], id, dirtySlotId]
      );
    }

    return { slots };
  });

  // POST /hero — save a single slot, applying any pending PvP changes before persisting.
  fastify.post('/hero', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id } = request.user;
    const { hero, slot_id: slotId = 'slot_1' } = request.body;
    if (!hero) return reply.status(400).send({ error: 'Missing hero data' });
    if (!VALID_SLOT_IDS.has(slotId)) return reply.status(400).send({ error: 'Invalid slot_id' });

    // encounterCharges is server-managed — strip so old clients can't overwrite
    if (hero.hero) delete hero.hero.encounterCharges;

    // XP and gold are server-authoritative — clamp to DB values so clients can't inflate them
    const existingResult = await pool.query(
      'SELECT save_data FROM heroes WHERE user_id = $1 AND slot_id = $2',
      [id, slotId]
    );
    if (hero.hero) {
      if (existingResult.rows[0]) {
        const dbHero = existingResult.rows[0].save_data?.hero || {};
        if (typeof dbHero.xp === 'number' && (hero.hero.xp ?? 0) > dbHero.xp) {
          hero.hero.xp = dbHero.xp;
        }
        if (typeof dbHero.gold === 'number' && (hero.hero.gold ?? 0) > dbHero.gold) {
          hero.hero.gold = dbHero.gold;
        }
      } else {
        // First save — new heroes start at 0; clamp any inflated client values
        if ((hero.hero.xp ?? 0) > 0) hero.hero.xp = 0;
        if ((hero.hero.gold ?? 0) > 0) hero.hero.gold = 0;
      }
    }

    const removalsApplied = await applyPendingRemovals(hero, id);
    const lootApplied = await applyPendingLoot(hero, id);

    await pool.query(
      `INSERT INTO heroes (user_id, slot_id, save_data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, slot_id) DO UPDATE SET save_data = $3, updated_at = NOW()`,
      [id, slotId, hero]
    );
    return {
      ok: true,
      ...(removalsApplied ? { appliedHero: hero.hero } : {}),
      ...(lootApplied ? { appliedPendingLoot: hero.pendingLoot || [] } : {}),
    };
  });

  // DELETE /hero/:slotId — remove a specific save slot
  fastify.delete('/hero/:slotId', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id } = request.user;
    const { slotId } = request.params;
    if (!VALID_SLOT_IDS.has(slotId)) return reply.status(400).send({ error: 'Invalid slot_id' });
    await pool.query('DELETE FROM heroes WHERE user_id = $1 AND slot_id = $2', [id, slotId]);
    return { ok: true };
  });
}

module.exports = heroRoutes;
