const pool = require('../db/pool');

const PROTECTION_SECONDS = 3600;       // 1 hour post-loss protection
const TARGET_COOLDOWN_SECONDS = 3600;  // 1 hour before you can re-attack the same player
const WEEKLY_ATTACK_LIMIT = 3;
const MAX_LEVEL_DIFF = 2;
const LOOT_POOL_SIZE = 5;

function xpToLevel(xp) {
  let lvl = 1, needed = 100, rest = xp || 0;
  while (rest >= needed) { rest -= needed; lvl++; needed = Math.floor(needed * 1.45); }
  return lvl;
}

function getWeekStartUTC() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysBack = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysBack);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getEquipStat(hero, stat) {
  let total = 0;
  for (const item of Object.values(hero.equip || {})) {
    if (!item || typeof item !== 'object') continue;
    total += item.baseStats?.[stat] || 0;
  }
  return total;
}

function calcCombatStats(saveData) {
  const hero = saveData?.hero || {};
  const base = hero.baseStats || {};
  const str = base.str || 0;
  const dex = base.dex || 0;
  const maxHp = Math.max(10, (base.maxHp || 50) + getEquipStat(hero, 'maxHp'));
  const damage = Math.max(1, str * 1.5 + (base.damage || 0) + getEquipStat(hero, 'damage'));
  const armor = (base.armor || 0) + getEquipStat(hero, 'armor');
  const hitChance = Math.min(95, 60 + Math.floor(dex / 5));
  return { maxHp, damage, armor, hitChance, name: hero.name || 'Fighter' };
}

function simulateCombat(atkSave, defSave) {
  const atk = calcCombatStats(atkSave);
  const def = calcCombatStats(defSave);
  let atkHp = atk.maxHp, defHp = def.maxHp;
  const log = [];

  for (let round = 1; round <= 30 && atkHp > 0 && defHp > 0; round++) {
    // Attacker swings
    if (Math.random() * 100 < atk.hitChance) {
      const raw = atk.damage * (0.8 + Math.random() * 0.4);
      const dmg = Math.max(1, Math.floor(raw * (100 / (100 + def.armor))));
      defHp -= dmg;
      log.push(`${atk.name} hits ${def.name} for ${dmg}. (${Math.max(0, defHp)}/${def.maxHp} HP)`);
    } else {
      log.push(`${atk.name} misses!`);
    }
    if (defHp <= 0) break;

    // Defender swings
    if (Math.random() * 100 < def.hitChance) {
      const raw = def.damage * (0.8 + Math.random() * 0.4);
      const dmg = Math.max(1, Math.floor(raw * (100 / (100 + atk.armor))));
      atkHp -= dmg;
      log.push(`${def.name} hits ${atk.name} for ${dmg}. (${Math.max(0, atkHp)}/${atk.maxHp} HP)`);
    } else {
      log.push(`${def.name} misses!`);
    }
  }

  const attackerWon = defHp <= 0 || (atkHp > 0 && atkHp >= defHp);
  return { attackerWon, log };
}

function collectAllItems(saveData) {
  const items = [];
  const hero = saveData?.hero || {};

  for (const [slot, item] of Object.entries(hero.equip || {})) {
    if (!item || typeof item !== 'object') continue;
    const itemId = item.id;
    if (!itemId) continue;
    items.push({ source: 'equip', slot, itemUid: item.uid || null, itemId, item, qty: 1 });
  }

  for (const placed of (hero.inventory || [])) {
    if (!placed) continue;
    const item = typeof placed.itemId === 'object' ? placed.itemId : null;
    const itemId = item ? item.id : placed.itemId;
    if (!itemId) continue;
    items.push({ source: 'inventory', itemUid: item?.uid || null, itemId, item: item || { id: itemId }, x: placed.x, y: placed.y, qty: 1 });
  }

  return items;
}

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
  const hero = saveData.hero || {};

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

  if (entry.source === 'equip') {
    if (hero.equip) hero.equip[entry.slot] = null;
  } else if (entry.source === 'inventory') {
    if (!hero.inventory) return;
    const idx = hero.inventory.findIndex(p => {
      const id = typeof p?.itemId === 'object' ? p.itemId?.id : p?.itemId;
      return id === entry.itemId && p?.x === entry.x && p?.y === entry.y;
    });
    if (idx !== -1) reduceOrRemoveSlot(hero.inventory, idx, entry.qty || 1);
  } else if (entry.source === 'stash') {
    if (!saveData.stash) return;
    const idx = saveData.stash.findIndex(p => {
      const id = typeof p?.itemId === 'object' ? p.itemId?.id : p?.itemId;
      return id === entry.itemId && p?.x === entry.x && p?.y === entry.y;
    });
    if (idx !== -1) reduceOrRemoveSlot(saveData.stash, idx, entry.qty || 1);
  }
}

async function pvpRoutes(fastify) {

  fastify.post('/pvp/attack', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: attackerId } = request.user;
    const { defenderUserId } = request.body;
    if (!defenderUserId) return reply.status(400).send({ error: 'Missing defenderUserId' });
    if (defenderUserId === attackerId) return reply.status(400).send({ error: 'Cannot attack yourself' });

    const [atkResult, defResult] = await Promise.all([
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [attackerId]),
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [defenderUserId]),
    ]);
    if (!atkResult.rows[0]) return reply.status(400).send({ error: 'Attacker has no hero' });
    if (!defResult.rows[0]) return reply.status(400).send({ error: 'Defender has no hero' });

    const atkSave = atkResult.rows[0].save_data;
    const defSave = defResult.rows[0].save_data;
    const atkLevel = xpToLevel(atkSave?.hero?.xp);
    const defLevel = xpToLevel(defSave?.hero?.xp);

    if (Math.abs(atkLevel - defLevel) > MAX_LEVEL_DIFF) {
      return reply.status(403).send({ error: 'LEVEL_DIFF', message: `Target is out of your level range (±${MAX_LEVEL_DIFF})` });
    }

    const claimResult = await pool.query(
      `SELECT protected_until FROM tile_claims WHERE user_id = $1 AND last_active > NOW() - INTERVAL '5 days'`,
      [defenderUserId]
    );
    if (!claimResult.rows[0]) {
      return reply.status(403).send({ error: 'NO_TILE', message: 'This player must have an active tile claim to be attacked' });
    }

    const claim = claimResult.rows[0];
    if (claim.protected_until && new Date(claim.protected_until) > new Date()) {
      return reply.status(403).send({ error: 'PROTECTED', message: 'This player is protected from attacks', protectedUntil: claim.protected_until });
    }

    // Weekly attack cap
    const weekStart = getWeekStartUTC();
    const weeklyCount = await pool.query(
      `SELECT COUNT(*) FROM pvp_records WHERE attacker_id = $1 AND created_at >= $2`,
      [attackerId, weekStart]
    );
    if (parseInt(weeklyCount.rows[0].count) >= WEEKLY_ATTACK_LIMIT) {
      return reply.status(403).send({ error: 'WEEKLY_LIMIT', message: 'Weekly attack limit reached. Resets each Monday.' });
    }

    const cooldownResult = await pool.query(
      `SELECT created_at FROM pvp_records
       WHERE attacker_id = $1 AND defender_id = $2
       AND created_at > NOW() - ($3 * INTERVAL '1 second')
       ORDER BY created_at DESC LIMIT 1`,
      [attackerId, defenderUserId, TARGET_COOLDOWN_SECONDS]
    );
    if (cooldownResult.rows[0]) {
      const cooldownEnds = new Date(cooldownResult.rows[0].created_at);
      cooldownEnds.setSeconds(cooldownEnds.getSeconds() + TARGET_COOLDOWN_SECONDS);
      return reply.status(403).send({ error: 'COOLDOWN_TARGET', message: 'You must wait before attacking this player again', cooldownEnds });
    }

    // Simulate combat with log
    const { attackerWon, log } = simulateCombat(atkSave, defSave);
    const winnerId = attackerWon ? attackerId : defenderUserId;
    const loserSave = attackerWon ? defSave : atkSave;

    const allItems = collectAllItems(loserSave);
    const pool_entries = shuffle(allItems).slice(0, LOOT_POOL_SIZE);

    const record = await pool.query(
      `INSERT INTO pvp_records (attacker_id, defender_id, winner_id, loot_pool, attacker_level, defender_level)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [attackerId, defenderUserId, winnerId, JSON.stringify(pool_entries), atkLevel, defLevel]
    );
    const recordId = record.rows[0].id;

    const defenderUsername = defSave?.hero?.name || `Player ${defenderUserId}`;
    const attackerUsername = atkSave?.hero?.name || `Player ${attackerId}`;

    if (!attackerWon) {
      const protectedUntil = new Date(Date.now() + PROTECTION_SECONDS * 1000);

      if (pool_entries.length > 0) {
        const autoPick = pool_entries[0];
        await Promise.all([
          pool.query('INSERT INTO pvp_pending_removals (user_id, entry, record_id) VALUES ($1, $2, $3)',
            [attackerId, JSON.stringify(autoPick), recordId]),
          pool.query('INSERT INTO pvp_pending_loot (user_id, item, record_id) VALUES ($1, $2, $3)',
            [defenderUserId, JSON.stringify(autoPick.item), recordId]),
          pool.query('UPDATE pvp_records SET loot_picked = $1, loot_claimed = TRUE WHERE id = $2', [JSON.stringify(autoPick), recordId]),
          pool.query('INSERT INTO pvp_ears (owner_id, defeated_user_id, defeated_username, record_id) VALUES ($1, $2, $3, $4)',
            [defenderUserId, attackerId, attackerUsername, recordId]),
          pool.query('UPDATE tile_claims SET protected_until = $1 WHERE user_id = $2', [protectedUntil, attackerId]),
        ]);
        return { won: false, recordId, defenderUsername, log, autoLostEntry: autoPick };
      } else {
        // Attacker had nothing to lose — defender still gets the ear and attacker gets protection
        await Promise.all([
          pool.query('UPDATE pvp_records SET loot_claimed = TRUE WHERE id = $1', [recordId]),
          pool.query('INSERT INTO pvp_ears (owner_id, defeated_user_id, defeated_username, record_id) VALUES ($1, $2, $3, $4)',
            [defenderUserId, attackerId, attackerUsername, recordId]),
          pool.query('UPDATE tile_claims SET protected_until = $1 WHERE user_id = $2', [protectedUntil, attackerId]),
        ]);
        return { won: false, recordId, defenderUsername, log };
      }
    }

    return { won: true, recordId, defenderUsername, log, pool: pool_entries, defenderLevel: defLevel, attackerLevel: atkLevel };
  });

  fastify.post('/pvp/loot', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: attackerId } = request.user;
    const { recordId, pickedUid } = request.body;
    if (!recordId) return reply.status(400).send({ error: 'Missing recordId' });

    const recResult = await pool.query('SELECT * FROM pvp_records WHERE id = $1', [recordId]);
    if (!recResult.rows[0]) return reply.status(404).send({ error: 'Record not found' });
    const rec = recResult.rows[0];

    if (String(rec.winner_id) !== String(attackerId)) return reply.status(403).send({ error: 'Not the winner' });

    // Atomically mark claimed — prevents double-claim from concurrent requests
    const claimResult = await pool.query(
      'UPDATE pvp_records SET loot_claimed = TRUE WHERE id = $1 AND loot_claimed = FALSE RETURNING id',
      [recordId]
    );
    if (!claimResult.rows[0]) return reply.status(409).send({ error: 'Loot already claimed' });

    const defenderUserId = rec.defender_id;
    const lootPool = rec.loot_pool || [];

    const defResult = await pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [defenderUserId]);
    const defSave = defResult.rows[0]?.save_data;
    if (!defSave) return reply.status(400).send({ error: 'Defender save not found' });

    const defenderUsername = defSave?.hero?.name || `Player ${defenderUserId}`;

    if (lootPool.length === 0 || !pickedUid) {
      await Promise.all([
        pool.query('UPDATE pvp_records SET loot_claimed = TRUE WHERE id = $1', [recordId]),
        pool.query('INSERT INTO pvp_ears (owner_id, defeated_user_id, defeated_username, record_id) VALUES ($1, $2, $3, $4)',
          [attackerId, defenderUserId, defenderUsername, recordId]),
      ]);
      return { ok: true, ear: { defeatedUsername: defenderUsername } };
    }

    const entry = lootPool.find(e =>
      (e.itemUid && e.itemUid === pickedUid) ||
      (e.item?.uid && e.item.uid === pickedUid) ||
      e.itemId === pickedUid
    );
    if (!entry) return reply.status(400).send({ error: 'Invalid item pick' });

    const protectedUntil = new Date(Date.now() + PROTECTION_SECONDS * 1000);

    // Both sides use deferred tables so concurrent auto-saves can't undo the transfer.
    await Promise.all([
      pool.query('INSERT INTO pvp_pending_loot (user_id, item, record_id) VALUES ($1, $2, $3)',
        [attackerId, JSON.stringify(entry.item), recordId]),
      pool.query('INSERT INTO pvp_pending_removals (user_id, entry, record_id) VALUES ($1, $2, $3)', [defenderUserId, JSON.stringify(entry), recordId]),
      pool.query('UPDATE pvp_records SET loot_picked = $1, loot_claimed = TRUE WHERE id = $2', [JSON.stringify(entry), recordId]),
      pool.query('UPDATE tile_claims SET protected_until = $1 WHERE user_id = $2', [protectedUntil, defenderUserId]),
      pool.query('INSERT INTO pvp_ears (owner_id, defeated_user_id, defeated_username, record_id) VALUES ($1, $2, $3, $4)',
        [attackerId, defenderUserId, defenderUsername, recordId]),
    ]);

    return { ok: true, ear: { defeatedUsername: defenderUsername, defeatedAt: new Date() } };
  });

  fastify.get('/pvp/profile', { preHandler: fastify.authenticate }, async (request) => {
    const { id } = request.user;
    const [earsResult, winsResult, lossesResult] = await Promise.all([
      pool.query(`SELECT defeated_username, created_at FROM pvp_ears WHERE owner_id = $1 ORDER BY created_at DESC`, [id]),
      pool.query(`SELECT COUNT(*) FROM pvp_records WHERE winner_id = $1`, [id]),
      pool.query(`SELECT COUNT(*) FROM pvp_records WHERE (attacker_id = $1 OR defender_id = $1) AND winner_id != $1`, [id]),
    ]);
    const wins = parseInt(winsResult.rows[0].count);
    const losses = parseInt(lossesResult.rows[0].count);
    return {
      ears: earsResult.rows,
      wins,
      losses,
      ratio: wins + losses === 0 ? 0 : Math.round((wins / (wins + losses)) * 100),
    };
  });
}

module.exports = pvpRoutes;
