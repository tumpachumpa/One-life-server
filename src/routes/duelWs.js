'use strict';

const { WebSocketServer } = require('ws');
const { createVerifier } = require('fast-jwt');

// The combat engine is ESM (src/game has { "type": "module" }); CommonJS loads it
// via dynamic import, the same pattern routes/adventure.js uses. Kick the load off
// at module init so it's resolved before the first duel ticks.
const combatModP = import('../game/logic/combat/combatManager.js');
const typesModP  = import('../game/logic/combat/types.js');
let _combat = null;
async function loadCombat() {
  if (_combat) return _combat;
  const [cm, types] = await Promise.all([combatModP, typesModP]);
  _combat = {
    initCombat:             cm.initCombat,
    processTick:            cm.processTick,
    processAutoAttackFrame: cm.processAutoAttackFrame,
    ACTION: types.ACTION,
    PHASE:  types.PHASE,
    TICK_MS: types.TICK_MS,
  };
  return _combat;
}

const SLOT_TO_ACTION = [
  'ability_0', 'ability_1', 'ability_2',
  'ability_3', 'ability_4', 'ability_5',
];
const ACTION_NONE = 'none';
const MAX_DUEL_TICKS = 1200; // 20 min at 1s/tick — hard cap against runaway fights
// Idle/abandoned sessions are reaped after this long. MUST exceed the max duel
// duration (MAX_DUEL_TICKS × 1s = 20 min) or pruneStale would delete a session
// mid-fight; pruneStale also refuses to touch an active combat as a second guard.
const SESSION_TTL_MS = 30 * 60 * 1000;

// sessionId → {
//   p1: { ws, userId, heroInitArgs } | null,
//   p2: { ... } | null,
//   createdAt,
//   combat: { state, timer, tickCount, logCursor, pendingP1, pendingP2, ended } | null,
// }
const sessions = new Map();

let _verify = null;
function verifyToken(token) {
  if (!_verify) _verify = createVerifier({ key: process.env.JWT_SECRET });
  return _verify(token);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(session, obj) {
  send(session.p1?.ws, obj);
  send(session.p2?.ws, obj);
}

// Compact auto-attack schedule so the client can render the autoattack charge bar
// (the client runs no sim of its own, so it can't derive these locally).
function autoSchedule(c) {
  if (!c) return null;
  return {
    rate: c.autoAttackRate ?? null,
    progressTicks: c.autoAttackProgressTicks ?? null,
    lastTick: c.lastAutoAttackTick ?? null,
    nextTick: c.nextAutoAttackTick ?? null,
    started: !!c.autoAttackStarted,
    // Offhand (dual-wield, e.g. Rogue) so the client can render the 2nd bar live.
    offhandRate: c.offhandAutoAttackRate ?? null,
    offhandProgressTicks: c.offhandAutoAttackProgressTicks ?? null,
    offhandLastTick: c.offhandLastAutoAttackTick ?? null,
    offhandNextTick: c.offhandNextAutoAttackTick ?? null,
    offhandStarted: !!c.offhandAutoAttackStarted,
  };
}

// Per-combatant display state the client can't derive without the sim: active
// buffs/debuffs (bleed, poison, stun, damage buffs, shields…), stun expiry, and
// whether the fighter is mid-cast. Drives the status chips and cast/auto bars.
function combatantDisplay(c) {
  if (!c) return null;
  return {
    activeEffects: Array.isArray(c.activeEffects) ? c.activeEffects : [],
    stunUntilTick: c.stunUntilTick ?? null,
    isCasting: !!c.isCasting,
    // Block Power changes every tick (consumed on block, regenerated) — sync it so the
    // client bar reflects it instead of freezing at the fight-start value.
    blockPower: c.blockPower ?? null,
    blockPowerMax: c.blockPowerMax ?? null,
  };
}

function pruneStale() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    // Never reap a duel that's still being fought — only idle/finished/abandoned
    // sessions. Previously a long fight (TTL 10 min < 20 min cap) was deleted mid-
    // tick with no duel_end, freezing both clients.
    if (s.combat && !s.combat.ended) continue;
    if (now - s.createdAt > SESSION_TTL_MS) {
      if (s.combat?.timer) clearInterval(s.combat.timer);
      sessions.delete(id);
    }
  }
}
setInterval(pruneStale, 60_000).unref();

// ── Authoritative simulation ───────────────────────────────────────────────────
// p1 = hero, p2 = opponent. One sim is the single source of truth; both clients
// render the DUEL_TICK / DUEL_END it broadcasts (no client-side simulation).

async function startCombat(session) {
  if (session.combat || !session.p1 || !session.p2) return;
  const C = await loadCombat();
  // A player may have dropped while the engine module was loading.
  if (!session.p1 || !session.p2) return;

  // p1's heroInitArgs already contains its own enemyObj (its snapshot of p2); we
  // override enemyProcNodes with p2's real proc nodes so both sides' procs fire.
  const initArgs = {
    ...session.p1.heroInitArgs,
    enemyProcNodes: session.p2.heroInitArgs?.heroProcNodes || [],
  };
  const state = C.initCombat(initArgs);
  session.combat = {
    state,
    tickCount: 0,
    logCursor: (state.log || []).length,
    pendingP1: null,
    pendingP2: null,
    ended: false,
    timer: null,
  };
  session.combat.timer = setInterval(() => runDuelTick(session, C), C.TICK_MS);
}

function runDuelTick(session, C) {
  const cm = session.combat;
  if (!cm || cm.ended) return;

  cm.tickCount++;
  if (cm.tickCount > MAX_DUEL_TICKS) {
    endDuel(session, null, null); // timeout / draw — no winner
    return;
  }

  // Snapshot the inputs before stepDuelTick consumes (nulls) them, so the crash log
  // can show which action triggered a throw.
  const actionP1 = cm.pendingP1;
  const actionP2 = cm.pendingP2;
  try {
    stepDuelTick(session, C, cm);
  } catch (err) {
    // A combat-engine edge case must NOT throw out of the interval callback — an
    // unhandled throw here would crash the whole server process (every session).
    // End this duel gracefully instead. Log full context (session, tick, both player
    // ids, full stack) so the offending state is diagnosable from prod logs — the
    // throw is otherwise invisible because it's swallowed here.
    console.error('[duel] tick error — ending duel', {
      sessionId: session?.id || null,
      tick: cm?.tickCount,
      p1: session?.p1?.userId || null,
      p2: session?.p2?.userId || null,
      heroClass: cm?.state?.combatants?.hero?.heroClass || null,
      enemyClass: cm?.state?.combatants?.enemy?.heroClass || null,
      lastP1Action: actionP1 || null,
      lastP2Action: actionP2 || null,
      error: err?.stack || err?.message || String(err),
    });
    endDuel(session, null, null);
  }
}

function stepDuelTick(session, C, cm) {
  const p1Action = cm.pendingP1 ?? C.ACTION.NONE;
  const p2Action = cm.pendingP2 ?? C.ACTION.NONE;
  cm.pendingP1 = null;
  cm.pendingP2 = null;

  // Advance auto-attacks by exactly one tick (fixed TICK_MS, never wall-clock —
  // a wall-clock delta would burst on an event-loop stall). Then resolve the tick
  // with p1 as hero and p2 as the manual enemy input.
  let state = C.processAutoAttackFrame(cm.state, C.TICK_MS, Math.random);
  state = C.processTick(state, p1Action, Math.random, {
    disableEnemyAi: true,
    enemyActions: { enemy: { action: p2Action, targetId: null } },
  });
  cm.state = state;

  const newLogEntries = (state.log || []).slice(cm.logCursor);
  cm.logCursor = (state.log || []).length;

  const heroHp = Math.max(0, Math.floor(state.combatants.hero?.hp ?? 0));
  const enemyC = state.combatants.enemy || (state.combatants.enemies || [])[0];
  const opponentHp = Math.max(0, Math.floor(enemyC?.hp ?? 0));

  broadcast(session, {
    type: 'duel_tick',
    tick: state.tick,
    phase: state.phase,
    p1Hp: heroHp,
    p2Hp: opponentHp,
    p1Auto: autoSchedule(state.combatants.hero),
    p2Auto: autoSchedule(enemyC),
    p1Display: combatantDisplay(state.combatants.hero),
    p2Display: combatantDisplay(enemyC),
    // Ability cooldowns ({abilityId: readyTick}) + one-shot used flags for BOTH
    // sides; each client adopts its own (normalizeServerDuelTick maps by side).
    // Without this the client (which runs no sim) shows every ability ready and
    // cooldown presses are dropped server-side.
    p1Cooldowns: state.combatants.hero?.abilityCooldowns || {},
    p2Cooldowns: enemyC?.abilityCooldowns || {},
    p1UsedAbilities: state.combatants.hero?.usedAbilityIds || {},
    p2UsedAbilities: enemyC?.usedAbilityIds || {},
    newLogEntries,
  });

  if (state.phase !== C.PHASE.FIGHTING) {
    const p1Won = state.phase === C.PHASE.WON;
    endDuel(
      session,
      p1Won ? session.p1?.userId : session.p2?.userId,
      p1Won ? session.p2?.userId : session.p1?.userId,
    );
  }
}

function endDuel(session, winnerId, loserId) {
  const cm = session.combat;
  if (cm) {
    if (cm.ended) return;
    cm.ended = true;
    clearInterval(cm.timer);
  }
  broadcast(session, { type: 'duel_end', winnerId: winnerId || null, loserId: loserId || null });
}

function setupDuelWs(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    // Cooperative: another noServer WSS (the adventure-fight route) shares this
    // server's 'upgrade' event, so ignore paths we don't own rather than
    // destroying the socket out from under it.
    if (path !== '/ws-duel') return;
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', ws => {
    let sessionId = null;
    let userId = null;
    let role = null; // 'p1' | 'p2'

    ws.on('message', rawData => {
      let msg;
      try { msg = JSON.parse(rawData); } catch { return; }

      if (msg.type === 'casual_duel_ready') {
        let payload;
        try { payload = verifyToken(msg.token); } catch {
          send(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Invalid token' });
          ws.close();
          return;
        }

        userId = String(payload.id);
        sessionId = String(msg.sessionId || '');
        if (!sessionId) {
          send(ws, { type: 'error', code: 'BAD_REQUEST', message: 'sessionId required' });
          ws.close();
          return;
        }
        if (!msg.heroInitArgs || typeof msg.heroInitArgs !== 'object') {
          send(ws, { type: 'error', code: 'BAD_REQUEST', message: 'heroInitArgs required' });
          ws.close();
          return;
        }

        pruneStale();
        let session = sessions.get(sessionId);
        if (!session) {
          session = { id: sessionId, p1: null, p2: null, createdAt: Date.now(), combat: null };
          sessions.set(sessionId, session);
        }

        if (!session.p1) {
          session.p1 = { ws, userId, heroInitArgs: msg.heroInitArgs };
          role = 'p1';
          // `side` lets the client map p1Hp/p2Hp onto me/opponent (casual assigns
          // p1/p2 by connection order, not challenger/defender).
          send(ws, { type: 'duel_state', sessionId, ready: false, side: 'p1' });
        } else if (!session.p2 && session.p1.userId !== userId) {
          session.p2 = { ws, userId, heroInitArgs: msg.heroInitArgs };
          role = 'p2';
          send(ws, { type: 'duel_state', sessionId, ready: false, side: 'p2' });
          broadcast(session, { type: 'duel_state', sessionId, ready: true });
          startCombat(session).catch(err => {
            console.error('[duel] startCombat failed', err);
            broadcast(session, { type: 'error', code: 'DUEL_INIT_FAILED', message: 'Could not start duel' });
          });
        } else {
          send(ws, { type: 'error', code: 'SESSION_FULL', message: 'Session full or already joined' });
          ws.close();
        }
        return;
      }

      if (msg.type === 'duel_action') {
        if (!sessionId || !role) return;
        const session = sessions.get(sessionId);
        if (!session || !session.combat || session.combat.ended) return;

        const slot = typeof msg.abilitySlot === 'number' ? msg.abilitySlot : -1;
        const action = slot >= 0 && slot <= 5 ? SLOT_TO_ACTION[slot] : ACTION_NONE;
        if (role === 'p1') session.combat.pendingP1 = action;
        else                session.combat.pendingP2 = action;
      }
    });

    ws.on('close', () => {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      const opponentWs = role === 'p1' ? session.p2?.ws : session.p1?.ws;
      const opponentId = role === 'p1' ? session.p2?.userId : session.p1?.userId;
      const leaverId   = role === 'p1' ? session.p1?.userId : session.p2?.userId;

      if (session.combat && !session.combat.ended) {
        // Mid-fight drop — opponent wins by forfeit.
        endDuel(session, opponentId || null, leaverId || null);
      } else if (!session.combat) {
        // Dropped before the fight started — tell the opponent.
        send(opponentWs, { type: 'error', code: 'OPPONENT_DISCONNECTED', message: 'Opponent disconnected' });
      }
      if (role === 'p1') session.p1 = null;
      else if (role === 'p2') session.p2 = null;
    });
  });
}

module.exports = { setupDuelWs };
