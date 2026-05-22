const { randomUUID } = require('crypto');

const casualChallenges = new Map();
const CASUAL_TTL_MS = 5 * 60 * 1000;

function prune() {
  const now = Date.now();
  for (const [id, c] of casualChallenges) {
    if (now - c.createdAt > CASUAL_TTL_MS) casualChallenges.delete(id);
  }
}

async function casualDuelsRoutes(fastify) {
  const { authenticate } = fastify;

  // POST /casual-challenge — challenger initiates
  fastify.post('/casual-challenge', { preHandler: [authenticate] }, async (req, reply) => {
    prune();
    const challengerId = String(req.user.id);
    const { defenderUserId, challengerSnap, challengerName } = req.body || {};
    if (!defenderUserId) return reply.status(400).send({ message: 'Missing defenderUserId' });
    if (String(defenderUserId) === challengerId) return reply.status(400).send({ message: 'Cannot challenge yourself' });

    for (const [id, c] of casualChallenges) {
      if (c.challengerId === challengerId) casualChallenges.delete(id);
    }

    const id = randomUUID();
    const sessionId = `casual:${id}`;
    const fightSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
    casualChallenges.set(id, {
      id, challengerId,
      challengerName: challengerName || req.user.username || 'Challenger',
      challengerSnap: challengerSnap || null,
      defenderId: String(defenderUserId),
      sessionId, fightSeed,
      status: 'pending', defenderSnap: null,
      createdAt: Date.now(),
    });
    return { id, sessionId, fightSeed };
  });

  // GET /casual-challenge/incoming — defender polls
  fastify.get('/casual-challenge/incoming', { preHandler: [authenticate] }, async (req, reply) => {
    prune();
    const userId = String(req.user.id);
    const challenges = [];
    for (const c of casualChallenges.values()) {
      if (c.defenderId === userId && c.status === 'pending')
        challenges.push({ id: c.id, challengerId: c.challengerId, challengerName: c.challengerName, sessionId: c.sessionId });
    }
    return { challenges };
  });

  // GET /casual-challenge/outgoing — challenger polls for acceptance
  fastify.get('/casual-challenge/outgoing', { preHandler: [authenticate] }, async (req, reply) => {
    prune();
    const userId = String(req.user.id);
    for (const c of casualChallenges.values()) {
      if (c.challengerId === userId) {
        return {
          id: c.id, status: c.status, sessionId: c.sessionId, fightSeed: c.fightSeed,
          defenderSnap: c.status === 'accepted' ? c.defenderSnap : null,
        };
      }
    }
    return { id: null, status: null };
  });

  // POST /casual-challenge/:id/accept
  fastify.post('/casual-challenge/:id/accept', { preHandler: [authenticate] }, async (req, reply) => {
    prune();
    const userId = String(req.user.id);
    const c = casualChallenges.get(req.params.id);
    if (!c) return reply.status(404).send({ message: 'Challenge not found' });
    if (c.defenderId !== userId) return reply.status(403).send({ message: 'Not your challenge' });
    if (c.status !== 'pending') return reply.status(400).send({ message: 'Challenge already resolved' });
    const { defenderSnap } = req.body || {};
    c.status = 'accepted';
    c.defenderSnap = defenderSnap || null;
    return { sessionId: c.sessionId, fightSeed: c.fightSeed, challengerSnap: c.challengerSnap, challengerName: c.challengerName };
  });

  // DELETE /casual-challenge/:id — cancel/decline
  fastify.delete('/casual-challenge/:id', { preHandler: [authenticate] }, async (req, reply) => {
    prune();
    const userId = String(req.user.id);
    const c = casualChallenges.get(req.params.id);
    if (c && (c.challengerId === userId || c.defenderId === userId)) casualChallenges.delete(req.params.id);
    return { ok: true };
  });
}

module.exports = casualDuelsRoutes;
