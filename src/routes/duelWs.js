const { WebSocketServer } = require('ws');
const { createVerifier } = require('fast-jwt');

const SLOT_TO_ACTION = [
  'ability_0', 'ability_1', 'ability_2',
  'ability_3', 'ability_4', 'ability_5',
];
const ACTION_NONE = 'none';
const SESSION_TTL_MS = 10 * 60 * 1000;
const TICK_RESOLVE_TIMEOUT_MS = 1800; // wait up to 1.8s for both inputs before defaulting

// sessionId → { p1: { ws, userId } | null, p2: { ws, userId } | null, createdAt, tickInputs }
// tickInputs: Map of tick → { p1: string|null, p2: string|null, timer: TimeoutId }
const sessions = new Map();

let _verify = null;
function verifyToken(token) {
  if (!_verify) _verify = createVerifier({ key: process.env.JWT_SECRET });
  return _verify(token);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function pruneStale() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
setInterval(pruneStale, 60_000).unref();

function setupDuelWs(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/ws-duel') { socket.destroy(); return; }
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

        pruneStale();
        let session = sessions.get(sessionId);
        if (!session) {
          session = { p1: null, p2: null, createdAt: Date.now() };
          sessions.set(sessionId, session);
        }

        if (!session.p1) {
          session.p1 = { ws, userId };
          role = 'p1';
          send(ws, { type: 'duel_state', sessionId, ready: false });
        } else if (!session.p2 && session.p1.userId !== userId) {
          session.p2 = { ws, userId };
          role = 'p2';
          const readyMsg = { type: 'duel_state', sessionId, ready: true };
          send(session.p1.ws, readyMsg);
          send(session.p2.ws, readyMsg);
        } else {
          send(ws, { type: 'error', code: 'SESSION_FULL', message: 'Session full or already joined' });
          ws.close();
        }
        return;
      }

      if (msg.type === 'duel_action') {
        if (!sessionId || !role) return;
        const session = sessions.get(sessionId);
        if (!session) return;

        const slot = typeof msg.abilitySlot === 'number' ? msg.abilitySlot : -1;
        const action = slot >= 0 && slot <= 5 ? SLOT_TO_ACTION[slot] : ACTION_NONE;

        if (role === 'p1') {
          send(session.p2?.ws, { type: 'duel_tick', p1Action: action, p2Action: ACTION_NONE });
        } else {
          send(session.p1?.ws, { type: 'duel_tick', p1Action: ACTION_NONE, p2Action: action });
        }
      }

      // Lockstep tick input: client submits their intended action for a given tick.
      // When both players have submitted (or timeout), broadcast the resolved tick to both.
      if (msg.type === 'duel_tick_input') {
        if (!sessionId || !role) return;
        const session = sessions.get(sessionId);
        if (!session || !session.p1 || !session.p2) return;

        const tick = typeof msg.tick === 'number' ? msg.tick : -1;
        if (tick < 0 || tick > 10000) return; // sanity check
        const rawAction = typeof msg.action === 'string' ? msg.action : ACTION_NONE;
        // Normalise: only allow known action strings
        const VALID_ACTIONS = new Set([ACTION_NONE, 'basic_attack',
          'ability_0', 'ability_1', 'ability_2', 'ability_3', 'ability_4', 'ability_5']);
        const action = VALID_ACTIONS.has(rawAction) ? rawAction : ACTION_NONE;

        if (!session.tickInputs) session.tickInputs = new Map();

        const resolveAndBroadcast = (td, resolvedTick) => {
          clearTimeout(td.timer);
          const p1 = td.p1 ?? ACTION_NONE;
          const p2 = td.p2 ?? ACTION_NONE;
          session.tickInputs.delete(resolvedTick);
          const msg = { type: 'duel_tick_resolved', tick: resolvedTick, p1Action: p1, p2Action: p2 };
          send(session.p1?.ws, msg);
          send(session.p2?.ws, msg);
        };

        if (!session.tickInputs.has(tick)) {
          const td = { p1: null, p2: null, timer: null };
          td.timer = setTimeout(() => resolveAndBroadcast(td, tick), TICK_RESOLVE_TIMEOUT_MS);
          session.tickInputs.set(tick, td);
        }

        const td = session.tickInputs.get(tick);
        if (td[role] === null) td[role] = action; // first submission wins

        if (td.p1 !== null && td.p2 !== null) {
          resolveAndBroadcast(td, tick);
        }
      }
    });

    ws.on('close', () => {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      if (role === 'p1') session.p1 = null;
      else if (role === 'p2') session.p2 = null;
    });
  });
}

module.exports = { setupDuelWs };
