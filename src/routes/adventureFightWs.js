'use strict';

// Server-authoritative PvE adventure combat (Phase 1).
//
// Mirrors routes/duelWs.js, but:
//   - there is ONE human (the hero) and the enemy is AI-driven by the combat
//     engine (we do NOT pass `disableEnemyAi`, so processTick runs aiDecide for
//     the enemy — the engine's native adventure behaviour),
//   - the fighter is built SERVER-SIDE from the authoritative DB hero via
//     buildCombatInitArgs (the client never supplies stats — this is the whole
//     anti-cheat point), and the enemy is resolved server-side from the node.
//
// The client renders the broadcast `adventure_tick` exactly like a duel tick
// (InteractiveCombat's applyServerDuelTicks path); it sends ability presses up
// via `adventure_fight_action`.
//
// Combat engine + helpers are ESM (src/game has {"type":"module"}); CommonJS
// loads them via dynamic import, same as duelWs.js / adventure.js.

const { WebSocketServer } = require('ws');
const { createVerifier } = require('fast-jwt');
const pool = require('../db/pool');
const { serverRunHp } = require('../lib/runHp');

const combatModP    = import('../game/logic/combat/combatManager.js');
const typesModP     = import('../game/logic/combat/types.js');
const builderModP   = import('../game/logic/combat/buildInitArgs.js');
const adventureModP = import('../game/logic/adventure.js');
const contentModP   = import('../game/logic/content.js');
const heroModP      = import('../game/logic/hero.js');
const survivalModP  = import('../game/logic/survival.js');

let _mods = null;
async function loadMods() {
  if (_mods) return _mods;
  const [cm, types, builder, adv, content, heroL, surv] = await Promise.all([combatModP, typesModP, builderModP, adventureModP, contentModP, heroModP, survivalModP]);
  _mods = {
    getItem:                content.getItem,
    initCombat:             cm.initCombat,
    processTick:            cm.processTick,
    processAutoAttackFrame: cm.processAutoAttackFrame,
    ACTION:  types.ACTION,
    PHASE:   types.PHASE,
    TICK_MS: types.TICK_MS,
    buildCombatInitArgs:  builder.buildCombatInitArgs,
    getAdventure:         adv.getAdventure,
    getNode:              adv.getNode,
    resolveAdventureNode: adv.resolveAdventureNode,
    getNodeEncounterPool:         adv.getNodeEncounterPool,
    getActiveAdventureDifficulty: adv.getActiveAdventureDifficulty,
    getAdventureRunDifficulty:    adv.getAdventureRunDifficulty,
    calcStats:                  heroL.calcStats,
    getPassiveRegenFromHunger:  surv.getPassiveRegenFromHunger,
  };
  return _mods;
}

// Reproduce the client's seeded encounter RNG so the server rolls the SAME
// encounter (group size, rarity) the player saw on the node card. Pre-migration
// the client used one seeded RNG for both preview and fight (App.jsx
// createEncounterPreviewRng); the server must match it or the card lies (e.g.
// card shows 2× wolf, server rolls 1). Hash + RNG are byte-identical to App.jsx.
function hashStableString(value = '') {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function createStableRng(seed) {
  // Byte-identical to App.jsx createStableRng (xorshift32) — NOT mulberry32. Must
  // match exactly or the server's seeded roll diverges from the client's preview.
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
// Mirrors createEncounterPreviewRng(App.jsx): same seed fields in the same order.
// nodeDiscards is a client-only UX counter (reroll discards) not in server
// progress — defaults to 0, which matches the common case (no discards).
function buildEncounterRng(M, adventure, node, progress, discards = 0) {
  const pool = M.getNodeEncounterPool(progress, node?.id);
  const seed = [
    adventure?.id,
    node?.id,
    progress?.runSeed,
    progress?.choiceRun?.seed,
    progress?.level,
    M.getActiveAdventureDifficulty(progress),
    pool.total,
    pool.cap,
    discards,
  ].join(':');
  return createStableRng(hashStableString(seed));
}

const SLOT_TO_ACTION = ['ability_0', 'ability_1', 'ability_2', 'ability_3', 'ability_4', 'ability_5'];
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_TICKS = 1800; // safety cap against a runaway fight

// key = userId (one active adventure fight per player). value = {
//   ws, userId, nodeId, slotId, sessionRowId,
//   state, timer, tickCount, logCursor, pending, ended, createdAt
// }
const fights = new Map();

let _verify = null;
function verifyToken(token) {
  if (!_verify) _verify = createVerifier({ key: process.env.JWT_SECRET });
  return _verify(token);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Same compact schedule/display shapes the duel client already knows how to read.
function autoSchedule(c) {
  if (!c) return null;
  return {
    rate:          c.autoAttackRate ?? null,
    progressTicks: c.autoAttackProgressTicks ?? null,
    lastTick:      c.lastAutoAttackTick ?? null,
    nextTick:      c.nextAutoAttackTick ?? null,
    started:       !!c.autoAttackStarted,
  };
}

function combatantDisplay(c) {
  if (!c) return null;
  return {
    activeEffects: Array.isArray(c.activeEffects) ? c.activeEffects : [],
    stunUntilTick: c.stunUntilTick ?? null,
    isCasting:     !!c.isCasting,
  };
}

// Escape-item flee bonus from the hero's inventory — mirrors the client's
// getBestEscapeItem/buildFleeContext (items tagged "escape", max fleeBonus). The
// engine's attemptFlee uses only fleeContext.itemBonus; base 30% chance is built in.
function fleeItemBonusFor(hero, getItem) {
  let best = 0;
  for (const entry of (hero?.inventory || [])) {
    const ref = entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'itemId') ? entry.itemId : entry;
    const item = getItem ? getItem(ref) : null;
    if (item && (item.tags || []).includes('escape')) {
      best = Math.max(best, Math.max(0, Math.floor(Number(item.fleeBonus || 0))));
    }
  }
  return best;
}

// In-flight cast/ability queue entries for one actor, in the shape the client's
// getActiveCast(actionQueue, actorId, tick) expects (actorId + ability + cast/impact
// ticks). Only still-active entries are sent (castEnd/impact beyond the current tick).
function castEntriesFor(state, actorId) {
  const tick = state.tick || 0;
  return (state.actionQueue || [])
    .filter(a => a.actorId === actorId && a.ability && (a.castEndTick ?? a.impactTick ?? 0) > tick)
    .map(a => ({
      actorId: a.actorId,
      type: a.type,
      ability: a.ability,
      startTick: a.startTick,
      castEndTick: a.castEndTick ?? null,
      impactTick: a.impactTick ?? null,
      spellId: a.spellId ?? null,
      spellName: a.spellName ?? null,
    }));
}

function cleanup(f) {
  if (f?.timer) clearInterval(f.timer);
  if (f) fights.delete(f.userId);
}

function pruneStale() {
  const now = Date.now();
  for (const [, f] of fights) {
    if (now - f.createdAt > SESSION_TTL_MS) cleanup(f);
  }
}
setInterval(pruneStale, 60_000).unref();

async function getActiveSession(userId) {
  const r = await pool.query(
    `SELECT * FROM adventure_sessions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return r.rows[0] || null;
}

// ── start the authoritative sim ────────────────────────────────────────────────
async function startFight(f) {
  const M = await loadMods();
  if (f.ended) return;

  const session = await getActiveSession(f.userId);
  if (!session) { send(f.ws, { type: 'error', code: 'NO_SESSION', message: 'No active adventure' }); cleanup(f); return; }
  f.sessionRowId = session.id;
  f.slotId = session.slot_id || 'slot_1';

  const adventure = M.getAdventure(session.adventure_id);
  if (!adventure) { send(f.ws, { type: 'error', code: 'NO_ADVENTURE' }); cleanup(f); return; }

  // Resolve the enemy server-side from the node the player claims to be fighting.
  const progress = session.progress;
  const { node } = M.getNode(adventure, f.nodeId, progress);
  if (!node) { send(f.ws, { type: 'error', code: 'BAD_NODE', message: 'Unknown node' }); cleanup(f); return; }

  // Authoritative hero from the DB save (NOT from the client). Loaded before the
  // encounter roll because the roll's day/night uses hero.combatsWon (same basis as
  // the client card — see below), so enemy stats on the card and in the fight match.
  const heroRes = await pool.query(
    'SELECT save_data FROM heroes WHERE user_id = $1 AND slot_id = $2',
    [f.userId, f.slotId],
  );
  const hero = heroRes.rows[0]?.save_data?.hero;
  if (!hero) { send(f.ws, { type: 'error', code: 'NO_HERO' }); cleanup(f); return; }

  // Phase 4 HP carry: HP is now server-authoritative within a run. Seed this
  // fight from the session's authoritative run_hp (carried from the prior fight's
  // heroHpLeft + server-credited passive regen + server-validated item heals via
  // POST /adventure/heal), NOT from the client-saved hero.hp — which a cheater
  // could set to full to start every fight at max. serverRunHp caps at maxHp and
  // credits passive hunger regen for elapsed wall-clock time. Legacy/in-progress
  // sessions (no run_hp; e.g. started before this deploy) fall back to saved hp.
  if (session.run_hp) {
    const maxHp = M.calcStats(hero).maxHp;
    const seeded = serverRunHp(session.run_hp, maxHp, hero.hunger, Date.now(), M.getPassiveRegenFromHunger);
    if (Number.isFinite(seeded)) hero.hp = seeded;
  }

  // Match the client's resolveAdventureNode args exactly (App.jsx fight/room):
  //   totalCombats   = hero.combatsWon          (drives day/night → enemy stats)
  //   difficultyStars = getAdventureRunDifficulty (drives rarity weights)
  // Seeded RNG reproduces the client's node-card preview roll (same encounter),
  // including the player's reroll-discard count for this node.
  const totalCombats = hero.combatsWon || 0;
  const difficultyStars = M.getAdventureRunDifficulty(adventure, progress);
  const encounterRng = buildEncounterRng(M, adventure, node, progress, f.encounterDiscards || 0);
  const encounter = M.resolveAdventureNode({ ...adventure, __progress: progress }, node, totalCombats, encounterRng, { difficultyStars });
  // VERIFY: encounter.enemies (packs) vs encounter.enemy (single). Mirror client.
  const enemyObjs = (Array.isArray(encounter?.enemies) && encounter.enemies.length)
    ? encounter.enemies
    : (encounter?.enemy ? [encounter.enemy] : []);
  if (!enemyObjs.length) { send(f.ws, { type: 'error', code: 'NO_ENEMY', message: 'Node has no enemy' }); cleanup(f); return; }

  const initArgs = M.buildCombatInitArgs(hero, enemyObjs, {
    bossEnemyId:            encounter?.bossEnemyId ?? null,
    bossDeathEndsFight:     encounter?.bossDeathEndsFight ?? true,
    addsDespawnOnBossDeath: encounter?.addsDespawnOnBossDeath ?? true,
  });
  const state = M.initCombat(initArgs);

  f.state = state;
  f.tickCount = 0;
  f.logCursor = (state.log || []).length;
  f.pending = null;
  f.maxHeroHp = state.combatants.hero?.maxHp ?? hero.hp ?? 1;
  // Precompute the hero's escape-item flee bonus once; fed to processTick on flee.
  f.fleeItemBonus = fleeItemBonusFor(hero, M.getItem);

  // Remember what the start handshake needs so a reconnecting client can be
  // re-sent the SAME encounter (server re-rolls rarity/group from the node, so
  // the client must not roll its own or sprites/names would mismatch).
  f.enemies = enemyObjs;
  f.bossDeathEndsFight = encounter?.bossDeathEndsFight ?? true;
  f.addsDespawnOnBossDeath = encounter?.addsDespawnOnBossDeath ?? true;

  sendStart(f);
  f.timer = setInterval(() => runTick(f, M), M.TICK_MS);
}

function sendStart(f) {
  send(f.ws, {
    type: 'adventure_fight_start',
    nodeId: f.nodeId,
    enemies: f.enemies,
    bossDeathEndsFight: f.bossDeathEndsFight,
    addsDespawnOnBossDeath: f.addsDespawnOnBossDeath,
  });
}

// Re-attach a dropped client to an in-flight fight: re-send the start handshake
// and a FULL snapshot tick (entire log, current HP/queues) so the client can
// rebuild the fight view, then let the running sim resume streaming. The sim
// itself never paused — it kept ticking authoritatively while disconnected, so
// a player cannot dodge a loss by pulling the cable.
function resumeFight(f) {
  if (!f || f.ended || !f.state) return;
  sendStart(f);
  send(f.ws, buildTick(f, f.state, f.state.log || []));
}

// A reconnecting client whose fight already finished while it was away: replay
// the authoritative outcome from the session's last_fight so the client can
// resolve the node. `replayed:true` tells the client this is a cold result (no
// preceding ticks) so it synthesises the combat-end instead of waiting for a
// final tick that will never come.
async function replayEndedFight(ws, userId, nodeId) {
  const session = await getActiveSession(userId);
  const lf = session?.last_fight;
  const fresh = lf && lf.nodeId === nodeId && Number.isFinite(lf.at) && (Date.now() - lf.at) < SESSION_TTL_MS;
  if (fresh) {
    send(ws, { type: 'adventure_fight_end', nodeId, result: lf.result, heroHpLeft: lf.heroHpLeft, replayed: true });
  } else {
    send(ws, { type: 'error', code: 'NO_FIGHT', message: 'No fight to resume' });
  }
}

function runTick(f, M) {
  if (f.ended) return;
  f.tickCount++;
  if (f.tickCount > MAX_TICKS) { endFight(f, M, 'lost').catch(() => {}); return; }
  try {
    stepTick(f, M);
  } catch (err) {
    // An engine edge case must never throw out of the interval (would crash the
    // process for every player). End this fight gracefully instead.
    console.error('[adv-fight] tick error — ending fight', err);
    endFight(f, M, 'lost').catch(() => {});
  }
}

function stepTick(f, M) {
  const action = f.pending ?? M.ACTION.NONE;
  f.pending = null;

  // Advance auto-attacks by exactly ONE tick via processAutoAttackFrame, then
  // resolve the tick with disableAutoAttacks so processTick does NOT run autos a
  // second time (that double-rate bug made every mob auto-attack each tick). This
  // mirrors the solo client: frame loop owns autos, the 1s tick passes
  // disableAutoAttacks:true. Enemy AI still runs (we do NOT pass disableEnemyAi).
  let state = M.processAutoAttackFrame(f.state, M.TICK_MS, Math.random);
  state = M.processTick(state, action, Math.random, {
    disableAutoAttacks: true,
    // Only consumed when action === FLEE; provides the escape-item bonus so the
    // server's flee roll matches what the client-side flee would have used.
    fleeContext: { itemBonus: f.fleeItemBonus || 0 },
  });
  f.state = state;

  const newLogEntries = (state.log || []).slice(f.logCursor);
  f.logCursor = (state.log || []).length;

  send(f.ws, buildTick(f, state, newLogEntries));

  if (state.phase !== M.PHASE.FIGHTING) {
    const result = state.phase === M.PHASE.WON ? 'won'
      : state.phase === M.PHASE.FLED ? 'fled'
      : 'lost';
    endFight(f, M, result).catch(err => console.error('[adv-fight] endFight error', err));
  }
}

// Build the adventure_tick payload from a combat state. Extracted so a
// reconnecting client can be sent a full snapshot (entire log) via resumeFight.
function buildTick(f, state, newLogEntries) {
  const hero = state.combatants.hero;
  const allEnemies = state.combatants.enemies || (state.combatants.enemy ? [state.combatants.enemy] : []);
  const enemy = state.combatants.enemy || allEnemies[0];

  return {
    type:  'adventure_tick',
    tick:  state.tick,
    phase: state.phase,
    // p1/p2 names reused so the client's normalizeServerDuelTick maps cleanly
    // (hero = me, enemy = opponent; PvE never swaps perspective).
    p1Hp: Math.max(0, Math.floor(hero?.hp ?? 0)),
    p2Hp: Math.max(0, Math.floor(enemy?.hp ?? 0)),
    p1Auto: autoSchedule(hero),
    p2Auto: autoSchedule(enemy),
    p1Display: combatantDisplay(hero),
    p2Display: combatantDisplay(enemy),
    // Hero resources (rage/energy/ki) each tick. The client runs no sim so without
    // this its resource view stays frozen at 0 → ability buttons that cost rage stay
    // permanently disabled (you can't press Whirlwind etc). Drives gating + the bar.
    p1Resources: state.heroResources || null,
    // In-flight cast/ability queue entries for the hero. The client runs no sim so
    // its own actionQueue is always empty → getActiveCast finds nothing → cast-time
    // abilities (Whirlwind etc) show "You begin..." in the log but the cast BAR and
    // the queued/casting button state never render, and impact looks like it never
    // happens. Forwarding the queue lets the client render the cast exactly.
    p1Queue: castEntriesFor(state, 'hero'),
    // Ability cooldowns ({abilityId: readyTick}) + one-shot used flags. The client
    // runs no sim, so without these its hero.abilityCooldowns stays empty → every
    // ability shows permanently ready and presses made during cooldown are silently
    // dropped server-side. readyTick is in this sim's tick space; the client renders
    // off the same synced tick, so the countdown lines up.
    p1Cooldowns: hero?.abilityCooldowns || {},
    p1UsedAbilities: hero?.usedAbilityIds || {},
    // So the client disables the flee button after the one allowed attempt.
    p1FleeAttempted: !!state.fleeAttempted,
    // Which combatant is in front (hero vs companion). Swap (ACTION.SWAP_FRONT)
    // changes this server-side; the client renders isFront off it, so without
    // syncing, a pet swap would resolve on the server but not show on screen.
    p1FrontId: state.frontId ?? null,
    p1EnemyFrontId: state.enemyFrontId ?? null,
    // Post-fight result inputs (buildCombatResult reads these off the client's
    // combatState, which runs no sim → without syncing, the end result uses stale
    // start-of-fight values: wrong pet HP, missed Deep Cut wounds, wrong bleed/
    // momentum/rage carry between nodes). Also drives the live pet HP bar.
    p1ProcState: state.procState ? {
      bleedCarry: state.procState.bleedCarry || 0,
      momentumCarry: state.procState.momentumCarry || 0,
      hasTakenDamageThisFight: !!state.procState.hasTakenDamageThisFight,
      rage: state.procState.rage || 0,
      // LIVE proc-stack counts so the hero's buff chips render (momentum/blade/scar/
      // frenzy + threshold talents). Field names MUST match what the client reads in
      // getActiveCombatantStatuses (procState.momentumStacks/bladeStacks/scarStacks/
      // frenzyStacks/activeThresholdIds/juggernaut). Client runs no sim, so without
      // these the chips stay at their fight-start value (0). (Bloodrush chip is driven
      // by activeEffects source:'bloodrush', already synced via p1Display.)
      momentumStacks: state.procState.momentumStacks || 0,
      bladeStacks: state.procState.bladeStacks || 0,
      scarStacks: state.procState.scarStacks || 0,
      frenzyStacks: state.procState.frenzyStacks || 0,
      activeThresholdIds: Array.isArray(state.procState.activeThresholdIds) ? state.procState.activeThresholdIds : [],
      juggernaut: !!state.procState.juggernaut,
    } : null,
    p1Wounds: state.heroWounds || null,
    p1Conditions: state.heroConditions || null,
    p1Allies: (state.combatants.allies || []).map(a => ({
      id: a.id,
      sourceId: a.sourceId || a.id,
      hp: Math.max(0, Math.floor(a.hp ?? 0)),
      maxHp: Math.max(1, Math.floor(a.maxHp ?? 1)),
      auto: autoSchedule(a),
      display: combatantDisplay(a),
    })),
    // Full per-enemy state so multi-enemy packs render each member by id (the
    // p2* fields above only carry the primary enemy — back-compat with duels).
    // Includes render identity + lifecycle so the client can show MID-FIGHT SUMMONS
    // (boss Oath Pillars, hazards, revived adds) that aren't in the initial encounter,
    // and hide a boss (phasedOut/combatHidden) while it stands behind them. The client
    // builds a render combatant for any id it doesn't already have.
    enemies: allEnemies.map(foe => ({
      id:   foe.id,
      sourceId: foe.sourceId || foe.id,
      name: foe.name || null,
      hp:   Math.max(0, Math.floor(foe?.hp ?? 0)),
      maxHp: Math.max(1, Math.floor(foe?.maxHp ?? 1)),
      auto: autoSchedule(foe),
      display: combatantDisplay(foe),
      queue: castEntriesFor(state, foe.id),
      sprite: foe.sprite || null,
      visual: foe.visual || null,
      combatVisual: foe.combatVisual || null,
      stateSprites: foe.stateSprites || null,
      colorState: foe.colorState ?? null,
      pillarState: foe.pillarState ?? null,
      family: foe.family || null,
      isPillar: !!foe.isPillar,
      isHazard: !!foe.isHazard,
      isSummon: !!foe.isSummon,
      spawnTick: foe.spawnTick ?? null,
      explodeTick: foe.explodeTick ?? null,
      reviveAtTick: foe.reviveAtTick ?? null,
      phasedOut: !!foe.phasedOut,
      combatHidden: !!foe.combatHidden,
      untargetable: !!foe.untargetable,
    })),
    newLogEntries,
  };
}

async function endFight(f, M, result) {
  if (f.ended) return;
  f.ended = true;
  if (f.timer) clearInterval(f.timer);

  const heroHpLeft = Math.max(0, Math.floor(f.state?.combatants?.hero?.hp ?? 0));

  // Persist the authoritative result on the session. Phase 2 wires
  // /adventure/complete-node to trust last_fight instead of the client's claim.
  // Phase 4: also write run_hp so the NEXT fight carries this fight's remaining
  // HP server-side (startFight seeds from it; POST /hero clamps to it). `at`
  // stamps the regen clock so passive healing accrues between nodes.
  try {
    if (f.sessionRowId) {
      const now = Date.now();
      await pool.query(
        `UPDATE adventure_sessions
         SET last_fight = $1, run_hp = $2, updated_at = NOW()
         WHERE id = $3`,
        [
          JSON.stringify({ nodeId: f.nodeId, result, heroHpLeft, at: now }),
          JSON.stringify({ hp: heroHpLeft, at: now }),
          f.sessionRowId,
        ],
      );
    }
  } catch (err) {
    console.error('[adv-fight] persist result failed', err);
  }

  send(f.ws, { type: 'adventure_fight_end', nodeId: f.nodeId, result, heroHpLeft });
  fights.delete(f.userId);
}

// ── socket wiring ───────────────────────────────────────────────────────────────
function setupAdventureFightWs(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/ws-adventure-fight') return; // let other upgrade handlers (duel) take it
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', ws => {
    let userId = null;

    ws.on('message', rawData => {
      let msg;
      try { msg = JSON.parse(rawData); } catch { return; }

      if (msg.type === 'adventure_fight_ready') {
        let payload;
        try { payload = verifyToken(msg.token); } catch {
          send(ws, { type: 'error', code: 'UNAUTHORIZED' }); ws.close(); return;
        }
        userId = String(payload.id);
        if (!msg.nodeId) { send(ws, { type: 'error', code: 'BAD_REQUEST', message: 'nodeId required' }); ws.close(); return; }
        const reqNodeId = String(msg.nodeId);

        // Reconnect/resume: if an in-flight fight for this player is still running
        // for the SAME node (e.g. the client dropped and re-opened the socket),
        // re-attach this socket to it and re-send a full snapshot instead of
        // starting a fresh fight (which would re-roll the enemy + reset HP). The
        // sim kept ticking authoritatively while disconnected.
        const existing = fights.get(userId);
        if (existing && !existing.ended && existing.state) {
          // A live fight is still running for this player (the sim keeps going
          // across disconnects). Same node → reconnect/resume into it.
          if (existing.nodeId === reqNodeId) {
            existing.ws = ws;
            resumeFight(existing);
            return;
          }
          // DIFFERENT node while a fight is unresolved: refuse to start a new
          // one (which would silently discard the running fight — an F5-to-dodge
          // -a-loss escape hatch). Tell the client to resume the live fight.
          send(ws, { type: 'error', code: 'FIGHT_IN_PROGRESS', nodeId: existing.nodeId });
          return;
        }
        // No live fight. A reconnect (resume:true) means the sim ended while the
        // client was away — replay the authoritative result so the client
        // resolves the node instead of dangling / re-rolling a fresh fight.
        if (msg.resume) {
          replayEndedFight(ws, userId, reqNodeId).catch(err => {
            console.error('[adv-fight] replay failed', err);
            send(ws, { type: 'error', code: 'NO_FIGHT' });
          });
          return;
        }
        // No live fight, fresh start.
        const f = {
          ws, userId,
          nodeId: String(msg.nodeId),
          // Client-supplied reroll-discard count for this node — feeds the encounter
          // seed so the server rolls the same card the player rerolled to. Anti-cheat:
          // this only changes WHICH encounter is faced; rewards are still server-rolled
          // for the actual enemy at /adventure/complete-node, so a forged count just
          // changes the fight the player gets (rerolls are a normal game action).
          encounterDiscards: Number.isFinite(msg.encounterDiscards) ? Math.max(0, Math.floor(msg.encounterDiscards)) : 0,
          slotId: null, sessionRowId: null,
          state: null, timer: null, tickCount: 0, logCursor: 0,
          pending: null, ended: false, createdAt: Date.now(),
        };
        fights.set(userId, f);
        startFight(f).catch(err => {
          console.error('[adv-fight] startFight failed', err);
          send(ws, { type: 'error', code: 'FIGHT_INIT_FAILED' });
          cleanup(f);
        });
        return;
      }

      if (msg.type === 'adventure_fight_action') {
        if (!userId) return;
        const f = fights.get(userId);
        if (!f || f.ended || !f.state) return;
        const slot = typeof msg.abilitySlot === 'number' ? msg.abilitySlot : -1;
        f.pending = (slot >= 0 && slot <= 5) ? SLOT_TO_ACTION[slot] : 'none';
      }

      if (msg.type === 'adventure_fight_flee') {
        if (!userId) return;
        const f = fights.get(userId);
        if (!f || f.ended || !f.state) return;
        f.pending = 'flee'; // ACTION.FLEE — resolved next tick with fleeContext
      }

      if (msg.type === 'adventure_fight_swap') {
        if (!userId) return;
        const f = fights.get(userId);
        if (!f || f.ended || !f.state) return;
        f.pending = 'swap_front'; // ACTION.SWAP_FRONT — engine swaps hero/companion front
      }

      if (msg.type === 'adventure_fight_target') {
        if (!userId) return;
        const f = fights.get(userId);
        if (!f || f.ended || !f.state) return;
        // Multi-enemy focus switch. The engine reads state.selectedTargetId to pick
        // the hero's auto-attack + ability target (combatManager processAutoAttackFrame
        // / processTick), and re-resolves it each tick (falling back when the target
        // dies). Setting it here retargets from the next tick. Only honor a currently
        // living enemy id; the engine ignores untargetable ones anyway.
        const enemies = f.state.combatants?.enemies
          || (f.state.combatants?.enemy ? [f.state.combatants.enemy] : []);
        if (enemies.some(e => e && e.id === msg.targetId && (e.hp ?? 0) > 0)) {
          f.state.selectedTargetId = msg.targetId;
        }
      }
    });

    ws.on('close', () => {
      if (!userId) return;
      const f = fights.get(userId);
      if (!f) return;
      // Only detach the socket that is actually the one closing — a reconnect may
      // already have swapped f.ws to a newer socket; closing the OLD one must not
      // tear down the live fight.
      if (f.ws !== ws) return;
      if (f.ended || !f.state) {
        // No live sim to preserve → clean up immediately.
        cleanup(f);
        return;
      }
      // Mid-fight disconnect: DO NOT abandon. Detach the socket and let the
      // authoritative sim keep running to its real conclusion (send() no-ops on a
      // null socket). The result persists via endFight → last_fight/run_hp, so a
      // player can't escape a loss by disconnecting, and a reconnect (same nodeId)
      // can re-attach and resume. A never-reconnecting fight self-cleans when it
      // ends; pruneStale reaps anything stuck past SESSION_TTL_MS.
      f.ws = null;
    });
  });
}

// The nodeId of the live (still-running) fight for this user, or null. Lets the
// REST layer (GET /adventure/fight-status) tell a freshly-loaded client to
// auto-resume an in-progress fight after a reload.
function getActiveFightNodeId(userId) {
  const f = fights.get(String(userId));
  return (f && !f.ended && f.state) ? f.nodeId : null;
}

module.exports = { setupAdventureFightWs, getActiveFightNodeId };
