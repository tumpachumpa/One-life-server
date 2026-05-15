'use strict';
const pool = require('../db/pool');
const { createVerifier } = require('fast-jwt');

// ── constants ─────────────────────────────────────────────────────────────────
const TICK_MS                = 1000;
const AUTO_ATTACK_TICKS      = 3;
const MAX_FIGHT_TICKS        = 600;
const ABILITY_COOLDOWN_TICKS = 15;
const ABILITY_AUTO_TICKS     = 20;   // auto-fire ability if player hasn't acted
const CONNECT_TIMEOUT_MS     = 25000;
const LOOT_POOL_SIZE         = 5;
const PROTECT_MINUTES        = 5;

// ── in-memory state ───────────────────────────────────────────────────────────
const games = new Map();  // String(challengeId) → game object

// ── pure helpers ──────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

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

// Matches client's equipmentGenerator.js exactly
function getDiceAverage(dice) {
  if (!dice) return 0;
  const count = Math.max(1, Math.floor(Number(dice.count) || 1));
  const sides = Math.max(1, Math.floor(Number(dice.sides) || 1));
  return count * ((sides + 1) / 2) + (Number(dice.bonus) || 0);
}

function rollDice(dice, rng) {
  if (!dice) return 0;
  const count = Math.max(1, Math.floor(Number(dice.count) || 1));
  const sides = Math.max(1, Math.floor(Number(dice.sides) || 1));
  const bonus = Math.floor(Number(dice.bonus) || 0);
  let total = bonus;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(rng() * sides);
  return Math.max(1, total);
}

function makeCombatant(snap, side) {
  const s = snap || {};
  return {
    side,
    hp:                s.maxHp         ?? 100,
    maxHp:             s.maxHp         ?? 100,
    damage:            s.damage        ?? 10,
    armor:             s.armor         ?? 0,
    attackSpeed:       s.attackSpeed   ?? 1,
    critChance:        s.critChance    ?? 0,   // 0 is valid — don't treat as falsy
    critMult:          s.critMult      ?? 1.5,
    critResist:        s.critResist    ?? 0,
    weaponDamageDice:  s.weaponDamageDice  || null,
    weaponDamageMult:  s.weaponDamageMult  ?? 1,
    autoProgress:      0,
    abilities:         (s.equippedSkillIds || s.availableSkillIds || []).filter(Boolean),
    lastAbilityTick:   -(ABILITY_AUTO_TICKS + 1),
    pendingAbilityIdx: null,
  };
}

// Matches client's combatManager damage formula
function baseAttackDamage(attacker, rng) {
  const diceRoll    = attacker.weaponDamageDice ? rollDice(attacker.weaponDamageDice, rng) : null;
  const diceAverage = attacker.weaponDamageDice ? getDiceAverage(attacker.weaponDamageDice) : 0;
  const diceDelta   = diceRoll == null ? 0 : Math.round((diceRoll - diceAverage) * (attacker.weaponDamageMult ?? 1));
  return Math.max(0, (attacker.damage ?? 0) + diceDelta);
}

function calcHit(attacker, defender, rng) {
  const base          = baseAttackDamage(attacker, rng);
  const effectiveCrit = Math.max(0, (attacker.critChance ?? 0) - (defender.critResist ?? 0));
  const isCrit        = rng() * 100 < effectiveCrit;
  const rawDmg        = base * (isCrit ? (attacker.critMult ?? 1.5) : 1);
  const dmg           = Math.max(1, Math.floor(rawDmg * (100 / (100 + (defender.armor ?? 0)))));
  return { dmg, isCrit };
}

function calcAbilityHit(attacker, defender, rng, abilityIdx) {
  const base          = baseAttackDamage(attacker, rng);
  const mult          = 1.5 + (abilityIdx || 0) * 0.3;
  const effectiveCrit = Math.max(0, (attacker.critChance ?? 0) - (defender.critResist ?? 0));
  const isCrit        = rng() * 100 < effectiveCrit;
  const rawDmg        = base * mult * (isCrit ? (attacker.critMult ?? 1.5) : 1);
  const dmg           = Math.max(1, Math.floor(rawDmg * (100 / (100 + (defender.armor ?? 0)))));
  return { dmg, isCrit };
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sendSSE(reply, data) {
  try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}

function broadcast(game, data) {
  for (const c of game.clients.values()) sendSSE(c.reply, data);
}

function snapState(c, currentTick) {
  return {
    hp:               c.hp,
    maxHp:            c.maxHp,
    autoProgress:     c.autoProgress,
    ticksSinceAbility: currentTick - c.lastAbilityTick,
    abilities:        c.abilities,
  };
}

// ── tick logic ────────────────────────────────────────────────────────────────
function runTick(game) {
  if (game.finished) return;
  game.tick++;
  const events = [];

  const atk = game.challenger;
  const def = game.defender;

  // auto-attacks
  atk.autoProgress += atk.attackSpeed;
  def.autoProgress += def.attackSpeed;

  while (atk.autoProgress >= AUTO_ATTACK_TICKS) {
    atk.autoProgress -= AUTO_ATTACK_TICKS;
    const { dmg, isCrit } = calcHit(atk, def, game.atkRng);
    def.hp = Math.max(0, def.hp - dmg);
    events.push({ type: 'auto_attack', attacker: 'challenger', dmg, isCrit });
  }

  while (def.autoProgress >= AUTO_ATTACK_TICKS) {
    def.autoProgress -= AUTO_ATTACK_TICKS;
    const { dmg, isCrit } = calcHit(def, atk, game.defRng);
    atk.hp = Math.max(0, atk.hp - dmg);
    events.push({ type: 'auto_attack', attacker: 'defender', dmg, isCrit });
  }

  // abilities for each side
  for (const [side, combatant, opponent, rng] of [
    ['challenger', atk, def, game.atkRng],
    ['defender',   def, atk, game.defRng],
  ]) {
    const ticksSince   = game.tick - combatant.lastAbilityTick;
    const cooldownOk   = ticksSince >= ABILITY_COOLDOWN_TICKS;
    const hasPending   = combatant.pendingAbilityIdx !== null;
    const shouldAuto   = ticksSince >= ABILITY_AUTO_TICKS && combatant.abilities.length > 0;

    if ((hasPending && cooldownOk) || shouldAuto) {
      const abilityCount = Math.max(1, combatant.abilities.length);
      const idx = hasPending
        ? combatant.pendingAbilityIdx
        : Math.floor(game.tick / ABILITY_AUTO_TICKS) % abilityCount;

      combatant.pendingAbilityIdx = null;
      combatant.lastAbilityTick   = game.tick;

      const { dmg, isCrit } = calcAbilityHit(combatant, opponent, rng, idx);
      opponent.hp = Math.max(0, opponent.hp - dmg);
      events.push({
        type:      'ability',
        attacker:  side,
        abilityIdx: idx,
        abilityId: combatant.abilities[idx] || null,
        dmg,
        isCrit,
      });
    }
  }

  // broadcast this tick
  broadcast(game, {
    type:       'tick',
    tick:       game.tick,
    challenger: snapState(atk, game.tick),
    defender:   snapState(def, game.tick),
    events,
  });

  // check end conditions
  if (atk.hp <= 0 || def.hp <= 0 || game.tick >= MAX_FIGHT_TICKS) {
    finishGame(game);
  }
}

async function finishGame(game) {
  if (game.finished) return;
  game.finished = true;
  clearInterval(game.timer);
  clearTimeout(game.startTimer);

  const challengerId = game.challengerId;
  const defenderId   = game.defenderId;
  const attackerWon  = game.challenger.hp > 0 && game.defender.hp <= 0
    ? true
    : game.defender.hp > 0 && game.challenger.hp <= 0
    ? false
    : (game.challenger.hp / game.challenger.maxHp) >= (game.defender.hp / game.defender.maxHp);
  const winnerId = attackerWon ? challengerId : defenderId;
  const loserId  = attackerWon ? defenderId   : challengerId;

  try {
    const [atkSaveRes, defSaveRes] = await Promise.all([
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [challengerId]),
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1', [defenderId]),
    ]);
    const atkSave    = atkSaveRes.rows[0]?.save_data;
    const defSave    = defSaveRes.rows[0]?.save_data;
    const loserSave  = attackerWon ? defSave : atkSave;
    const lootPool   = shuffle(collectAllItems(loserSave)).slice(0, LOOT_POOL_SIZE);
    const atkLevel   = xpToLevel(atkSave?.hero?.xp);
    const defLevel   = xpToLevel(defSave?.hero?.xp);
    const protectedUntil = new Date(Date.now() + PROTECT_MINUTES * 60 * 1000);

    const record = await pool.query(
      `INSERT INTO pvp_records (challenge_id, attacker_id, defender_id, winner_id, loot_pool, attacker_level, defender_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (challenge_id) DO NOTHING
       RETURNING id`,
      [game.challengeId, challengerId, defenderId, winnerId, JSON.stringify(lootPool), atkLevel, defLevel],
    );

    let recordId = record.rows[0]?.id;
    if (!recordId) {
      const existing = await pool.query('SELECT id FROM pvp_records WHERE challenge_id = $1', [game.challengeId]);
      recordId = existing.rows[0]?.id;
    }

    await Promise.all([
      pool.query(`UPDATE pvp_challenges SET status = 'done', winner_id = $1 WHERE id = $2`, [winnerId, game.challengeId]),
      pool.query(`UPDATE camps SET protected_until = $1 WHERE user_id = $2`, [protectedUntil, loserId]),
    ]);

    broadcast(game, {
      type:      'end',
      winnerId:  String(winnerId),
      recordId,
      lootPool:  attackerWon ? lootPool : [],
    });
  } catch (err) {
    console.error('[fight] finishGame error:', err);
    broadcast(game, { type: 'end', winnerId: String(winnerId), recordId: null, lootPool: [] });
  }

  for (const c of game.clients.values()) {
    try { c.reply.raw.end(); } catch {}
  }
  games.delete(String(game.challengeId));
}

function startFight(game) {
  if (game.started || game.finished) return;
  game.started = true;
  clearTimeout(game.startTimer);
  game.startTimer = null;
  broadcast(game, { type: 'start', tick: 0 });
  game.timer = setInterval(() => runTick(game), TICK_MS);
}

// ── route registration ────────────────────────────────────────────────────────
async function fightRoutes(fastify) {
  const verifyToken = createVerifier({ key: async () => process.env.JWT_SECRET });

  // GET /fight/:id/stream?token=JWT
  // SSE — both challenger and defender connect here to watch the live fight.
  fastify.get('/fight/:id/stream', async (request, reply) => {
    const { id: challengeId } = request.params;
    const { token }           = request.query;

    let user;
    try {
      user = await verifyToken(token);
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const userId = String(user.id);

    // Verify the user is part of this challenge
    const chRes = await pool.query(`
      SELECT ch.*,
        COALESCE(ch.defender_snap, dc.combat_snap) AS resolved_defender_snap
      FROM pvp_challenges ch
      LEFT JOIN camps dc ON dc.user_id = ch.defender_id
      WHERE ch.id = $1
        AND (ch.challenger_id = $2 OR ch.defender_id = $2)
        AND ch.status = 'prep'
    `, [challengeId, userId]);

    if (!chRes.rows[0]) return reply.status(404).send({ error: 'Challenge not found or not in prep' });
    const ch = chRes.rows[0];

    // SSE setup — CORS headers must be set manually here because we bypass
    // Fastify's normal response pipeline by writing directly to reply.raw.
    const origin = request.headers.origin || '*';
    reply.raw.setHeader('Access-Control-Allow-Origin',      origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Content-Type',      'text/event-stream');
    reply.raw.setHeader('Cache-Control',     'no-cache');
    reply.raw.setHeader('Connection',        'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    const key  = String(challengeId);
    let   game = games.get(key);

    if (!game) {
      const seed = (Number(ch.fight_seed) || 0) >>> 0;
      game = {
        challengeId:  Number(challengeId),
        challengerId: String(ch.challenger_id),
        defenderId:   String(ch.defender_id),
        challenger:   makeCombatant(ch.challenger_snap,          'challenger'),
        defender:     makeCombatant(ch.resolved_defender_snap,   'defender'),
        atkRng:       mulberry32((seed ^ 0x10001) >>> 0),
        defRng:       mulberry32((seed ^ 0x10002) >>> 0),
        tick:         0,
        clients:      new Map(),
        started:      false,
        finished:     false,
        timer:        null,
        startTimer:   null,
      };
      games.set(key, game);
    }

    game.clients.set(userId, { reply, userId });

    // If fight already started, send current state so late-joiner can sync
    if (game.started) {
      sendSSE(reply, {
        type:       'state',
        tick:       game.tick,
        challenger: snapState(game.challenger, game.tick),
        defender:   snapState(game.defender,   game.tick),
      });
    }

    // Start fight when both players connected, or after timeout
    if (!game.started && game.clients.size >= 2) {
      clearTimeout(game.startTimer);
      startFight(game);
    } else if (!game.started && !game.startTimer) {
      game.startTimer = setTimeout(() => startFight(game), CONNECT_TIMEOUT_MS);
    }

    // Keep-alive ping every 20s (prevents Railway / proxy from closing idle SSE)
    const ping = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch {}
    }, 20000);

    // Resolve when client disconnects
    return new Promise((resolve) => {
      request.raw.on('close', () => {
        clearInterval(ping);
        game.clients.delete(userId);
        resolve();
      });
    });
  });

  // POST /fight/:id/action
  // Player submits an ability choice. Server queues it for the next tick.
  fastify.post('/fight/:id/action', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: challengeId } = request.params;
    const { id: userId }      = request.user;
    const { abilityIdx }      = request.body;

    const game = games.get(String(challengeId));
    if (!game || game.finished) return reply.status(404).send({ error: 'No active fight' });

    const isChallenger = String(userId) === game.challengerId;
    const isDefender   = String(userId) === game.defenderId;
    if (!isChallenger && !isDefender) return reply.status(403).send({ error: 'Not in this fight' });

    const combatant  = isChallenger ? game.challenger : game.defender;
    const ticksSince = game.tick - combatant.lastAbilityTick;

    if (ticksSince < ABILITY_COOLDOWN_TICKS) {
      return reply.status(429).send({ error: 'Ability on cooldown', readyInTicks: ABILITY_COOLDOWN_TICKS - ticksSince });
    }

    const maxIdx = Math.max(0, combatant.abilities.length - 1);
    combatant.pendingAbilityIdx = Math.max(0, Math.min(Number(abilityIdx) || 0, maxIdx));

    return { ok: true };
  });

  // GET /fight/:id/state  (for reconnect / polling fallback)
  fastify.get('/fight/:id/state', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: challengeId } = request.params;
    const { id: userId }      = request.user;

    const game = games.get(String(challengeId));
    if (!game) return reply.status(404).send({ error: 'No active fight' });

    const isParticipant = String(userId) === game.challengerId || String(userId) === game.defenderId;
    if (!isParticipant) return reply.status(403).send({ error: 'Not in this fight' });

    return {
      tick:       game.tick,
      started:    game.started,
      challenger: snapState(game.challenger, game.tick),
      defender:   snapState(game.defender,   game.tick),
    };
  });
}

module.exports = fightRoutes;
