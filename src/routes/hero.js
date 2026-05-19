const pool = require('../db/pool');

// ESM game modules — loaded once, reused across requests
const heroLogicP = import('../game/logic/hero.js');
const inventoryLogicP = import('../game/logic/inventory.js');

const ESSENCE_PER_HOUR = 100;
const INV_COLS = 5; // mirrors client constants.js

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
  // POST /hero/create — atomically create a new character on the server and store it.
  // The hero is born on the server; client never writes unvalidated creation data.
  fastify.post('/hero/create', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id } = request.user;
    const { slot_id: slotId, name, heroClass, gender, weapon } = request.body || {};

    if (!VALID_SLOT_IDS.has(slotId)) return reply.status(400).send({ error: 'Invalid slot_id' });
    const trimmedName = String(name || '').trim().slice(0, 24);
    if (!trimmedName) return reply.status(400).send({ error: 'Name required' });

    // Refuse if the slot already has a live character
    const existing = await pool.query(
      'SELECT save_data FROM heroes WHERE user_id = $1 AND slot_id = $2',
      [id, slotId]
    );
    if (existing.rows[0]?.save_data?.hero?.characterCreated) {
      return reply.status(409).send({ error: 'slot_occupied' });
    }

    // Enforce global character name uniqueness (case-insensitive, across all users)
    const nameTaken = await pool.query(
      `SELECT 1 FROM heroes WHERE save_data->'hero'->>'name' ILIKE $1 AND save_data->'hero'->>'characterCreated' = 'true' LIMIT 1`,
      [trimmedName]
    );
    if (nameTaken.rows.length > 0) {
      return reply.status(409).send({ error: 'name_taken' });
    }

    const { initHero, calcStats } = await heroLogicP;
    const { migrateToGrid } = await inventoryLogicP;

    const rawHero = initHero(trimmedName, {
      heroClass: heroClass || 'fighter',
      gender: gender || 'male',
      characterCreated: true,
      weapon: weapon || null,
    });

    const invRows = Math.max(6, Math.ceil((calcStats(rawHero).inventorySlots || 30) / INV_COLS));
    const hero = { ...rawHero, inventory: migrateToGrid(rawHero.inventory, invRows) };

    const saveData = {
      hero,
      selectedAdventureId: 'dungeon_depths',
      selectedZoneId: 'dungeon',
      worldRegionId: 'eastern_wilds',
      worldLocationId: 'camp',
      worldView: 'tilemap',
      worldLayer: 'surface',
      playerTilePos: { col: 10, row: 120 },
      adventureProgress: {},
      zoneProgress: {},
      unlockedZones: [],
      pendingLoot: [],
      resources: { campfireCooks: 0 },
      jobs: { queue: [], pendingLoot: [] },
      skills: { gathering: { xp: 0 }, crafting: { xp: 0 }, survival: { xp: 0 } },
      bestiary: {},
      stash: [[], [], []],
      savedAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO heroes (user_id, slot_id, save_data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, slot_id) DO UPDATE SET save_data = $3, updated_at = NOW()`,
      [id, slotId, saveData]
    );

    return { ok: true, saveData };
  });

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
    let heroWasClamped = false;
    if (hero.hero) {
      if (existingResult.rows[0]) {
        const dbHero = existingResult.rows[0].save_data?.hero || {};
        const clientName = hero.hero.name;
        const dbName = dbHero.name;
        // Safety: if names differ and DB has a real character, refuse the save to prevent slot confusion
        if (dbName && clientName && dbName !== clientName && dbHero.characterCreated) {
          return reply.status(409).send({ error: 'slot_character_mismatch', dbName, clientName });
        }
        if (typeof dbHero.xp === 'number' && (hero.hero.xp ?? 0) < dbHero.xp) {
          hero.hero.xp = dbHero.xp;
          heroWasClamped = true;
        }
      } else {
        // First save for this slot — new heroes start at 0; clamp any inflated client values
        if ((hero.hero.xp ?? 0) > 0) { hero.hero.xp = 0; heroWasClamped = true; }
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
      // Return appliedHero whenever hero values were changed server-side so client stays in sync
      ...((removalsApplied || heroWasClamped) ? { appliedHero: hero.hero } : {}),
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
