require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { setupDuelWs } = require('./src/routes/duelWs');

fastify.register(require('@fastify/cors'), {
  origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',') : false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});

fastify.register(require('./src/plugins/auth'));
fastify.register(require('./src/routes/auth'));
fastify.register(require('./src/routes/hero'));
fastify.register(require('./src/routes/camps'));
fastify.register(require('./src/routes/fight'));
fastify.register(require('./src/routes/adventure'));
fastify.register(require('./src/routes/encounter'));
fastify.register(require('./src/routes/pvp'));
fastify.register(require('./src/routes/world'));
fastify.register(require('./src/routes/leaderboard'));
fastify.register(require('./src/routes/casualDuels'));

let dbReady = false;

fastify.get('/health', async () => ({ status: dbReady ? 'ok' : 'degraded', db: dbReady }));

async function waitForDb() {
  const pool = require('./src/db/pool');
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      dbReady = true;
      if (attempt > 1) fastify.log.info('DB ready after recovery.');
      return;
    } catch (err) {
      dbReady = false;
      const delayMs = Math.min(1000 * Math.pow(2, Math.min(attempt - 1, 5)), 30000);
      fastify.log.warn(`DB not ready (attempt ${attempt}): ${err.message} — retrying in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

const start = async () => {
  try {
    // Listen first so Railway health checks pass during DB recovery.
    await fastify.listen({ port: process.env.PORT || 3001, host: '0.0.0.0' });
    setupDuelWs(fastify.server);
    // Then wait for DB with exponential backoff to avoid log flooding.
    await waitForDb();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
