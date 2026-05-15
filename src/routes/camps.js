const pool = require('../db/pool');

const DUNGEON_DURATION_MINUTES = 30;
const PREP_DURATION_SECONDS    = 60;
const CANCEL_COOLDOWN_MINUTES  = 10;
const POST_FIGHT_PROTECTION_MINUTES = 5;
const MAX_LEVEL_DIFF           = 2;
const LOOT_POOL_SIZE           = 5;

function xpToLevel(xp) {
  let lvl = 1, needed = 100, rest = xp || 0;
  while (rest >= needed) { rest -= needed; lvl++; needed = Math.floor(needed * 1.45); }
  return lvl;
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
  const str  = base.str || 0;
  const dex  = base.dex || 0;
  const maxHp    = Math.max(10, (base.maxHp || 50) + getEquipStat(hero, 'maxHp'));
  const damage   = Math.max(1,  str * 1.5 + (base.damage || 0) + getEquipStat(hero, 'damage'));
  const armor    = (base.armor || 0) + getEquipStat(hero, 'armor');
  const hitChance = Math.min(95, 60 + Math.floor(dex / 5));
  return { maxHp, damage, armor, hitChance, name: hero.name || 'Adventurer' };
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const DUEL_AUTO_ATTACK_TICKS = 3;
const DUEL_MAX_TICKS = 600;

function simulateDuel(challengerSnap, defenderSnap, fightSeed) {
  const seed = (fightSeed != null ? Number(fightSeed) : 0) >>> 0;
  const atkRng = mulberry32((seed ^ 0x10001) >>> 0);
  const defRng = mulberry32((seed ^ 0x10002) >>> 0);

  function statsFromSnap(snap) {
    return {
      hp:          (snap?.maxHp       || 100),
      maxHp:       (snap?.maxHp       || 100),
      damage:      (snap?.damage      || 10),
      armor:       (snap?.armor       || 0),
      attackSpeed: (snap?.attackSpeed || 1),
      critChance:  (snap?.critChance  || 5),
      critMult:    (snap?.critMult    || 1.5),
      critResist:  (snap?.critResist  || 0),
      progress:    0,
    };
  }

  const atk = statsFromSnap(challengerSnap);
  const def = statsFromSnap(defenderSnap);

  for (let tick = 1; tick <= DUEL_MAX_TICKS; tick++) {
    atk.progress += atk.attackSpeed;
    def.progress += def.attackSpeed;

    while (atk.progress >= DUEL_AUTO_ATTACK_TICKS) {
      atk.progress -= DUEL_AUTO_ATTACK_TICKS;
      const effectiveCrit = Math.max(0, atk.critChance - def.critResist);
      const isCrit = atkRng() * 100 < effectiveCrit;
      const rawDmg = atk.damage * (isCrit ? atk.critMult : 1);
      def.hp -= Math.max(1, Math.floor(rawDmg * (100 / (100 + def.armor))));
    }
    if (def.hp <= 0) return { attackerWon: true };

    while (def.progress >= DUEL_AUTO_ATTACK_TICKS) {
      def.progress -= DUEL_AUTO_ATTACK_TICKS;
      const effectiveCrit = Math.max(0, def.critChance - atk.critResist);
      const isCrit = defRng() * 100 < effectiveCrit;
      const rawDmg = def.damage * (isCrit ? def.critMult : 1);
      atk.hp -= Math.max(1, Math.floor(rawDmg * (100 / (100 + atk.armor))));
    }
    if (atk.hp <= 0) return { attackerWon: false };
  }

  return { attackerWon: (atk.hp / atk.maxHp) >= (def.hp / def.maxHp) };
}

function simulateCombat(atkSave, defSave) {
  const atk = calcCombatStats(atkSave);
  const def = calcCombatStats(defSave);
  let atkHp = atk.maxHp, defHp = def.maxHp;
  const log = [];
  for (let round = 1; round <= 30 && atkHp > 0 && defHp > 0; round++) {
    if (Math.random() * 100 < atk.hitChance) {
      const dmg = Math.max(1, Math.floor(atk.damage * (0.8 + Math.random() * 0.4) * (100 / (100 + def.armor))));
      defHp -= dmg;
      log.push(`${atk.name} hits ${def.name} for ${dmg} (${Math.max(0, defHp)}/${def.maxHp})`);
    } else {
      log.push(`${atk.name} misses`);
    }
    if (defHp <= 0) break;
    if (Math.random() * 100 < def.hitChance) {
      const dmg = Math.max(1, Math.floor(def.damage * (0.8 + Math.random() * 0.4) * (100 / (100 + atk.armor))));
      atkHp -= dmg;
      log.push(`${def.name} hits ${atk.name} for ${dmg} (${Math.max(0, atkHp)}/${atk.maxHp})`);
    } else {
      log.push(`${def.name} misses`);
    }
  }
  const attackerWon = defHp <= 0 || (atkHp > 0 && atkHp >= defHp);
  return { attackerWon, log };
}

function collectAllItems(saveData) {
  const items = [];
  const hero = saveData?.hero || {};
  for (const [slot, item] of Object.entries(hero.equip || {})) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    items.push({ source: 'equip', slot, itemUid: item.uid || null, itemId: item.id, item, qty: 1 });
  }
  for (const placed of (hero.inventory || [])) {
    if (!placed) continue;
    const item   = typeof placed.itemId === 'object' ? placed.itemId : null;
    const itemId = item ? item.id : placed.itemId;
    if (!itemId) continue;
    items.push({ source: 'inventory', itemUid: item?.uid || null, itemId, item: item || { id: itemId }, x: placed.x, y: placed.y, qty: 1 });
  }
  return items;
}

async function campRoutes(fastify) {

  // ── GET /camps ────────────────────────────────────────────────────────────
  // All active camps (not done/expired). Used by TileMap to show who is camping.
  fastify.get('/camps', async () => {
    const result = await pool.query(`
      SELECT c.user_id, c.hero_name, c.hero_level, c.adventure_id,
             c.col, c.row, c.started_at, c.expires_at, c.protected_until, c.status,
             c.combat_snap, c.in_adventure
      FROM camps c
      WHERE c.status != 'done'
        AND c.expires_at > NOW()
    `);
    return { camps: result.rows };
  });

  // ── POST /camps ───────────────────────────────────────────────────────────
  // Called when the player enters an adventure. Creates/replaces the camp.
  fastify.post('/camps', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id } = request.user;
    const { adventureId, col, row, combatSnap } = request.body;
    if (!adventureId || col == null || row == null)
      return reply.status(400).send({ error: 'Missing adventureId, col or row' });

    const heroResult = await pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [id]);
    const save = heroResult.rows[0]?.save_data;
    if (!save) return reply.status(400).send({ error: 'No hero found' });

    const heroName  = save?.hero?.name || 'Adventurer';
    const heroLevel = xpToLevel(save?.hero?.xp);
    const expiresAt = new Date(Date.now() + DUNGEON_DURATION_MINUTES * 60 * 1000);
    const snapJson  = combatSnap ? JSON.stringify(combatSnap) : null;

    await pool.query(`
      INSERT INTO camps (user_id, hero_name, hero_level, adventure_id, col, row, expires_at, status, combat_snap, in_adventure)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, false)
      ON CONFLICT (user_id) DO UPDATE SET
        hero_name    = EXCLUDED.hero_name,
        hero_level   = EXCLUDED.hero_level,
        adventure_id = EXCLUDED.adventure_id,
        col          = EXCLUDED.col,
        row          = EXCLUDED.row,
        started_at   = NOW(),
        expires_at   = EXCLUDED.expires_at,
        status       = 'active',
        combat_snap  = EXCLUDED.combat_snap,
        in_adventure = false
    `, [id, heroName, heroLevel, adventureId, col, row, expiresAt, snapJson]);

    return { ok: true, expiresAt };
  });

  // ── POST /camps/enter ────────────────────────────────────────────────────
  // Player stepped into the adventure. Marks in_adventure = true.
  fastify.post('/camps/enter', { preHandler: fastify.authenticate }, async (request) => {
    const { id } = request.user;
    await pool.query(`UPDATE camps SET in_adventure = true WHERE user_id = $1 AND status = 'active'`, [id]);
    return { ok: true };
  });

  // ── POST /camps/exit ──────────────────────────────────────────────────────
  // Player exited the adventure but has not released the camp yet.
  fastify.post('/camps/exit', { preHandler: fastify.authenticate }, async (request) => {
    const { id } = request.user;
    await pool.query(`UPDATE camps SET in_adventure = false WHERE user_id = $1 AND status = 'active'`, [id]);
    return { ok: true };
  });

  // ── DELETE /camps ─────────────────────────────────────────────────────────
  // Player left the adventure (completed or abandoned). Marks camp as done.
  // Also starts the prep countdown for any challenger who was waiting.
  fastify.delete('/camps', { preHandler: fastify.authenticate }, async (request) => {
    const { id } = request.user;
    await pool.query(`UPDATE camps SET status = 'done' WHERE user_id = $1`, [id]);
    await pool.query(`
      UPDATE pvp_challenges SET status = 'prep', prep_started_at = NOW(),
        fight_seed = FLOOR(RANDOM() * 4294967296)::BIGINT
      WHERE defender_id = $1 AND status = 'pending'
    `, [id]);
    return { ok: true };
  });

  // ── GET /camps/my-status ──────────────────────────────────────────────────
  // Polled every 5 s while the player is inside a dungeon.
  // Returns the player's own camp + any pending/prep challenge against them.
  fastify.get('/camps/my-status', { preHandler: fastify.authenticate }, async (request) => {
    const { id } = request.user;

    // Auto-transition pending challenges to prep when the defender is no longer
    // actively inside the adventure (in_adventure=false, expired, or camp gone).
    await pool.query(`
      UPDATE pvp_challenges
      SET status = 'prep', prep_started_at = NOW(),
          fight_seed = FLOOR(RANDOM() * 4294967296)::BIGINT
      WHERE status = 'pending'
        AND (defender_id = $1 OR challenger_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM camps
          WHERE user_id = pvp_challenges.defender_id
            AND status = 'active'
            AND expires_at > NOW()
            AND in_adventure = true
        )
    `, [id]);

    const [campResult, challengeResult] = await Promise.all([
      pool.query(`SELECT * FROM camps WHERE user_id = $1`, [id]),
      pool.query(`
        SELECT ch.id, ch.challenger_id, ch.defender_id, ch.adventure_id, ch.status,
               ch.queued_at, ch.prep_started_at, ch.winner_id, ch.challenger_snap, ch.fight_seed,
               cu.username AS challenger_username,
               COALESCE(chero.save_data->'hero'->>'name', cu.username) AS challenger_name,
               du.username AS defender_username,
               COALESCE(dhero.save_data->'hero'->>'name', du.username) AS defender_name,
               dc.combat_snap AS defender_snap,
               dc.started_at AS adventure_entered_at
        FROM pvp_challenges ch
        JOIN users cu ON cu.id = ch.challenger_id
        LEFT JOIN heroes chero ON chero.user_id = ch.challenger_id
        JOIN users du ON du.id = ch.defender_id
        LEFT JOIN heroes dhero ON dhero.user_id = ch.defender_id
        LEFT JOIN camps dc ON dc.user_id = ch.defender_id
        WHERE (ch.defender_id = $1 OR ch.challenger_id = $1)
          AND (
            (ch.status = 'prep' AND ch.prep_started_at > NOW() - INTERVAL '5 minutes')
            OR (ch.status = 'pending' AND ch.queued_at > NOW() - INTERVAL '35 minutes')
            OR (ch.status = 'done' AND ch.queued_at > NOW() - INTERVAL '60 seconds')
            OR (ch.status = 'cancelled' AND ch.queued_at > NOW() - INTERVAL '35 minutes')
          )
        ORDER BY
          CASE WHEN ch.status IN ('pending', 'prep') THEN 0 ELSE 1 END,
          ch.queued_at ASC
        LIMIT 1
      `, [id]),
    ]);

    return {
      camp:      campResult.rows[0] || null,
      challenge: challengeResult.rows[0] || null,
    };
  });

  // ── POST /camps/challenge ─────────────────────────────────────────────────
  // Queue a challenge against a player who is currently in a dungeon.
  fastify.post('/camps/challenge', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: challengerId } = request.user;
    const { defenderUserId, challengerSnap } = request.body;
    if (!defenderUserId)               return reply.status(400).send({ error: 'Missing defenderUserId' });
    if (defenderUserId === challengerId) return reply.status(400).send({ error: 'Cannot challenge yourself' });

    // Load both saves for level check
    const [atkResult, defResult] = await Promise.all([
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [challengerId]),
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [defenderUserId]),
    ]);
    if (!atkResult.rows[0]) return reply.status(400).send({ error: 'No hero found' });
    if (!defResult.rows[0]) return reply.status(400).send({ error: 'Defender has no hero' });

    const atkLevel = xpToLevel(atkResult.rows[0].save_data?.hero?.xp);
    const defLevel = xpToLevel(defResult.rows[0].save_data?.hero?.xp);
    if (Math.abs(atkLevel - defLevel) > MAX_LEVEL_DIFF)
      return reply.status(403).send({ error: 'LEVEL_DIFF', message: `Target is outside your level range (±${MAX_LEVEL_DIFF})` });

    // Challenger must have an active camp
    const challengerCampResult = await pool.query(
      `SELECT * FROM camps WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()`,
      [challengerId]
    );
    if (!challengerCampResult.rows[0]) return reply.status(403).send({ error: 'NO_CHALLENGER_CAMP', message: 'You must have an active camp to challenge' });

    // Check defender has an active camp
    const campResult = await pool.query(
      `SELECT * FROM camps WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()`,
      [defenderUserId]
    );
    if (!campResult.rows[0]) return reply.status(403).send({ error: 'NO_CAMP', message: 'That player is not in a dungeon' });

    const camp = campResult.rows[0];

    // Check protection (disabled for testing)
    // if (camp.protected_until && new Date(camp.protected_until) > new Date())
    //   return reply.status(403).send({ error: 'PROTECTED', message: 'That player is protected', protectedUntil: camp.protected_until });

    // Overwrite check — if B already has a pending challenge from player A, C intercepts it.
    // A vs C fight starts immediately (prep); B is freed; C vs B challenge is not created.
    const snapJson = challengerSnap ? JSON.stringify(challengerSnap) : null;
    const overwroteResult = await pool.query(
      `SELECT ch.id, ch.challenger_id,
              COALESCE(h.save_data->'hero'->>'name', u.username) AS challenger_name
       FROM pvp_challenges ch
       JOIN users u ON u.id = ch.challenger_id
       LEFT JOIN heroes h ON h.user_id = ch.challenger_id
       WHERE ch.defender_id = $1 AND ch.status = 'pending'
       LIMIT 1`,
      [defenderUserId]
    );
    if (overwroteResult.rows[0]) {
      const prior = overwroteResult.rows[0];
      if (String(prior.challenger_id) !== String(challengerId)) {
        // Cancel A's pending challenge — B is freed
        await pool.query(`UPDATE pvp_challenges SET status = 'cancelled' WHERE id = $1`, [prior.id]);
        // Cancel any other stale challenges C has open
        await pool.query(
          `UPDATE pvp_challenges SET status = 'cancelled' WHERE challenger_id = $1 AND status IN ('pending','prep')`,
          [challengerId]
        );
        // Create A vs C fight in prep state (C challenges A)
        const fightInsert = await pool.query(`
          INSERT INTO pvp_challenges (challenger_id, defender_id, adventure_id, status, prep_started_at, challenger_snap, fight_seed)
          VALUES ($1, $2, $3, 'prep', NOW(), $4, FLOOR(RANDOM() * 4294967296)::BIGINT)
          RETURNING id, prep_started_at, fight_seed
        `, [challengerId, prior.challenger_id, camp.adventure_id, snapJson]);
        return {
          ok: true,
          overwrite: true,
          fightChallengeId: fightInsert.rows[0].id,
          prepStartedAt: fightInsert.rows[0].prep_started_at,
          fightSeed: fightInsert.rows[0].fight_seed != null ? Number(fightInsert.rows[0].fight_seed) : null,
          cancelledChallengerId: String(prior.challenger_id),
          cancelledChallengerName: prior.challenger_name,
        };
      }
    }

    // Reverse overwrite: the defender (A) is currently waiting on someone else (A→B pending).
    // C challenged A directly — intercept by cancelling A→B and starting C vs A fight immediately.
    const defenderOutgoingResult = await pool.query(
      `SELECT ch.id FROM pvp_challenges ch
       WHERE ch.challenger_id = $1 AND ch.status = 'pending'
       LIMIT 1`,
      [defenderUserId]
    );
    if (defenderOutgoingResult.rows[0]) {
      // Cancel A's outgoing pending challenge — B is freed
      await pool.query(`UPDATE pvp_challenges SET status = 'cancelled' WHERE id = $1`, [defenderOutgoingResult.rows[0].id]);
      // Cancel any other stale challenges C has open
      await pool.query(
        `UPDATE pvp_challenges SET status = 'cancelled' WHERE challenger_id = $1 AND status IN ('pending','prep')`,
        [challengerId]
      );
      // Create C vs A fight in prep state
      const fightInsert = await pool.query(`
        INSERT INTO pvp_challenges (challenger_id, defender_id, adventure_id, status, prep_started_at, challenger_snap, fight_seed)
        VALUES ($1, $2, $3, 'prep', NOW(), $4, FLOOR(RANDOM() * 4294967296)::BIGINT)
        RETURNING id, prep_started_at, fight_seed
      `, [challengerId, defenderUserId, camp.adventure_id, snapJson]);
      return {
        ok: true,
        overwrite: true,
        fightChallengeId: fightInsert.rows[0].id,
        prepStartedAt: fightInsert.rows[0].prep_started_at,
        fightSeed: fightInsert.rows[0].fight_seed != null ? Number(fightInsert.rows[0].fight_seed) : null,
        cancelledChallengerId: String(defenderUserId),
        cancelledChallengerName: camp.hero_name || null,
      };
    }

    // If an active challenge for this exact pair already exists, return it (idempotent)
    const reciprocalResult = await pool.query(
      `SELECT id FROM pvp_challenges
       WHERE challenger_id = $2 AND defender_id = $1
         AND status IN ('pending','prep')
         AND queued_at > NOW() - INTERVAL '5 minutes'`,
      [challengerId, defenderUserId]
    );
    if (reciprocalResult.rows[0]) {
      return reply.status(409).send({
        error: 'ACTIVE_RECIPROCAL_CHALLENGE',
        message: 'This player already challenged you. Finish that challenge first.',
      });
    }

    const existingResult = await pool.query(
      `SELECT id, status, prep_started_at, fight_seed FROM pvp_challenges
       WHERE challenger_id = $1 AND defender_id = $2
         AND status IN ('pending','prep')
         AND queued_at > NOW() - INTERVAL '35 minutes'`,
      [challengerId, defenderUserId]
    );
    if (existingResult.rows[0]) {
      const ch = existingResult.rows[0];
      return {
        ok: true,
        challengeId: ch.id,
        status: ch.status,
        ...(ch.prep_started_at ? { prepStartedAt: ch.prep_started_at } : {}),
        ...(ch.fight_seed != null ? { fight_seed: Number(ch.fight_seed) } : {}),
      };
    }

    // Cancel any other stale active challenges this challenger has open
    await pool.query(
      `UPDATE pvp_challenges SET status = 'cancelled'
       WHERE challenger_id = $1 AND status IN ('pending','prep')`,
      [challengerId]
    );

    // Create challenge as pending — prep countdown starts only when the defender exits the adventure
    const insert = await pool.query(`
      INSERT INTO pvp_challenges (challenger_id, defender_id, adventure_id, status, challenger_snap)
      VALUES ($1, $2, $3, 'pending', $4)
      RETURNING id
    `, [challengerId, defenderUserId, camp.adventure_id, snapJson]);

    return { ok: true, challengeId: insert.rows[0].id, status: 'pending' };
  });

  // ── DELETE /camps/challenge/:id ───────────────────────────────────────────
  // Attacker cancels their own challenge. Applies cooldown against that defender.
  fastify.delete('/camps/challenge/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: challengerId } = request.user;
    const { id: challengeId }  = request.params;

    const result = await pool.query(
      `UPDATE pvp_challenges SET status = 'cancelled' WHERE id = $1 AND challenger_id = $2 AND status IN ('pending','prep') RETURNING defender_id`,
      [challengeId, challengerId]
    );
    if (!result.rows[0]) return reply.status(404).send({ error: 'Challenge not found or already resolved' });

    const defenderUserId = result.rows[0].defender_id;
    const cooldownUntil  = new Date(Date.now() + CANCEL_COOLDOWN_MINUTES * 60 * 1000);

    await pool.query(`
      INSERT INTO pvp_cooldowns (challenger_id, defender_id, cooldown_until)
      VALUES ($1, $2, $3)
      ON CONFLICT (challenger_id, defender_id) DO UPDATE SET cooldown_until = EXCLUDED.cooldown_until
    `, [challengerId, defenderUserId, cooldownUntil]);

    return { ok: true, cooldownUntil };
  });

  // ── POST /camps/fight ─────────────────────────────────────────────────────
  // Called by either party after the DuelArena combat ends.
  // Server runs its own deterministic simulation using fight_seed + stored snaps.
  // Client does not report attackerWon — server is authoritative.
  fastify.post('/camps/fight', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId }  = request.user;
    const { challengeId } = request.body;
    if (!challengeId) return reply.status(400).send({ error: 'Missing challengeId' });

    // If already resolved, return the existing record (idempotent)
    const doneResult = await pool.query(`
      SELECT c.*, pr.id as record_id, pr.loot_pool
      FROM pvp_challenges c
      LEFT JOIN pvp_records pr ON pr.challenge_id = c.id
      WHERE c.id = $1 AND c.status = 'done'
    `, [challengeId]);
    if (doneResult.rows[0]) {
      const ch = doneResult.rows[0];
      return {
        attackerWon: String(ch.winner_id) === String(ch.challenger_id),
        winnerId: ch.winner_id,
        recordId: ch.record_id,
        log: [],
        lootPool: ch.loot_pool || [],
      };
    }

    // Allow either challenger or defender to record the result
    const chResult = await pool.query(`
      SELECT ch.*, dc.combat_snap AS defender_snap
      FROM pvp_challenges ch
      LEFT JOIN camps dc ON dc.user_id = ch.defender_id
      WHERE ch.id = $1 AND (ch.challenger_id = $2 OR ch.defender_id = $2) AND ch.status = 'prep'
    `, [challengeId, userId]);
    if (!chResult.rows[0]) return reply.status(404).send({ error: 'Challenge not found or not in prep' });

    const challenge    = chResult.rows[0];
    const challengerId = challenge.challenger_id;
    const defenderId   = challenge.defender_id;

    // Server determines winner via deterministic simulation (fight_seed + stored snaps)
    const { attackerWon } = simulateDuel(
      challenge.challenger_snap,
      challenge.defender_snap,
      challenge.fight_seed,
    );
    const winnerId  = attackerWon ? challengerId : defenderId;
    const loserId   = attackerWon ? defenderId   : challengerId;

    const [atkSaveResult, defSaveResult] = await Promise.all([
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [challengerId]),
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [defenderId]),
    ]);
    const atkSave = atkSaveResult.rows[0]?.save_data;
    const defSave = defSaveResult.rows[0]?.save_data;

    const loserSave = attackerWon ? defSave : atkSave;
    const allItems  = collectAllItems(loserSave);
    const lootPool  = shuffle(allItems).slice(0, LOOT_POOL_SIZE);

    const protectedUntil = new Date(Date.now() + POST_FIGHT_PROTECTION_MINUTES * 60 * 1000);

    const atkLevel = xpToLevel(atkSave?.hero?.xp);
    const defLevel = xpToLevel(defSave?.hero?.xp);
    const record   = await pool.query(
      `INSERT INTO pvp_records (challenge_id, attacker_id, defender_id, winner_id, loot_pool, attacker_level, defender_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (challenge_id) DO NOTHING
       RETURNING id`,
      [challengeId, challengerId, defenderId, winnerId, JSON.stringify(lootPool), atkLevel, defLevel]
    );
    if (!record.rows[0]) {
      // Lost the concurrent-insert race: wait for the winner to commit then read its result.
      await new Promise(r => setTimeout(r, 250));
      const existing = await pool.query(`
        SELECT c.challenger_id, c.defender_id, pr.id AS record_id, pr.winner_id, pr.loot_pool
        FROM pvp_records pr
        JOIN pvp_challenges c ON c.id = pr.challenge_id
        WHERE pr.challenge_id = $1
      `, [challengeId]);
      const row = existing.rows[0];
      if (!row) return reply.status(409).send({ error: 'Fight result already being recorded' });
      return {
        attackerWon: String(row.winner_id) === String(row.challenger_id),
        winnerId: row.winner_id,
        recordId: row.record_id,
        log: [],
        lootPool: row.loot_pool || [],
      };
    }
    const recordId = record.rows[0].id;

    await Promise.all([
      pool.query(`UPDATE pvp_challenges SET status = 'done', winner_id = $1 WHERE id = $2`, [winnerId, challengeId]),
      pool.query(`UPDATE camps SET protected_until = $1 WHERE user_id = $2`, [protectedUntil, loserId]),
    ]);

    const defenderName   = defSave?.hero?.name   || 'Adventurer';
    const challengerName = atkSave?.hero?.name   || 'Adventurer';

    return {
      attackerWon,
      winnerId,
      loserId,
      recordId,
      log: [],
      lootPool,
      defenderName,
      challengerName,
    };
  });

  // ── POST /camps/loot ──────────────────────────────────────────────────────
  // Winner picks one item from the loot pool after fight resolves.
  // Reuses pvp_records / pvp_pending_* deferred transfer system.
  fastify.post('/camps/loot', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: winnerId } = request.user;
    const { recordId, pickedUid } = request.body;
    if (!recordId) return reply.status(400).send({ error: 'Missing recordId' });

    const recResult = await pool.query('SELECT * FROM pvp_records WHERE id = $1', [recordId]);
    if (!recResult.rows[0])             return reply.status(404).send({ error: 'Record not found' });
    const rec         = recResult.rows[0];
    if (String(rec.winner_id) !== String(winnerId)) return reply.status(403).send({ error: 'Not the winner' });

    const loserId     = String(rec.winner_id) === String(rec.attacker_id) ? rec.defender_id : rec.attacker_id;
    const lootPool    = rec.loot_pool || [];

    const loserResult = await pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [loserId]);
    const loserSave   = loserResult.rows[0]?.save_data;
    const loserName   = loserSave?.hero?.name || 'Adventurer';

    if (!lootPool.length || !pickedUid) {
      const claimed = await pool.query(
        `UPDATE pvp_records SET loot_claimed = TRUE WHERE id = $1 AND loot_claimed = FALSE RETURNING id`,
        [recordId]
      );
      if (!claimed.rows[0]) return reply.status(409).send({ error: 'Loot already claimed' });
      await pool.query(
        `INSERT INTO pvp_ears (owner_id, defeated_user_id, defeated_username, record_id) VALUES ($1, $2, $3, $4)`,
        [winnerId, loserId, loserName, recordId]
      );
      return { ok: true, ear: { defeatedUsername: loserName } };
    }

    const entry = lootPool.find(e =>
      (e.itemUid && e.itemUid === pickedUid) ||
      (e.item?.uid && e.item.uid === pickedUid) ||
      e.itemId === pickedUid
    );
    if (!entry) return reply.status(400).send({ error: 'Invalid item pick' });

    const claimed = await pool.query(
      `UPDATE pvp_records SET loot_claimed = TRUE WHERE id = $1 AND loot_claimed = FALSE RETURNING id`,
      [recordId]
    );
    if (!claimed.rows[0]) return reply.status(409).send({ error: 'Loot already claimed' });

    await Promise.all([
      pool.query(`INSERT INTO pvp_pending_loot (user_id, item, record_id) VALUES ($1, $2, $3)`,
        [winnerId, JSON.stringify(entry.item), recordId]),
      pool.query(`INSERT INTO pvp_pending_removals (user_id, entry, record_id) VALUES ($1, $2, $3)`,
        [loserId, JSON.stringify(entry), recordId]),
      pool.query(`UPDATE pvp_records SET loot_picked = $1 WHERE id = $2`, [JSON.stringify(entry), recordId]),
      pool.query(`INSERT INTO pvp_ears (owner_id, defeated_user_id, defeated_username, record_id) VALUES ($1, $2, $3, $4)`,
        [winnerId, loserId, loserName, recordId]),
    ]);

    return { ok: true, ear: { defeatedUsername: loserName } };
  });
}

module.exports = campRoutes;
