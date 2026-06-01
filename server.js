require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { setupDuelWs } = require('./src/routes/duelWs');
const { setupAdventureFightWs } = require('./src/routes/adventureFightWs');

// Identifies the running build. Changes on every deploy (Railway injects the
// commit SHA), so clients can detect when the server has been updated mid-session
// and prompt a refresh — important now that combat is server-authoritative and an
// old client can be protocol-incompatible. Falls back to the package version (a
// stable value, so a plain restart does NOT look like a new version).
const APP_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA
  || process.env.APP_VERSION
  || (() => { try { return require('./package.json').version; } catch { return null; } })()
  || String(Date.now());

fastify.register(require('@fastify/cors'), {
  origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',') : false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-App-Version'],
  credentials: true,
});

// Stamp the running build version on every response so the client can notice a
// deploy and force a refresh before an outdated build does something unsafe.
fastify.addHook('onSend', (request, reply, payload, done) => {
  reply.header('X-App-Version', APP_VERSION);
  done(null, payload);
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

fastify.get('/health', async () => ({ status: dbReady ? 'ok' : 'degraded', db: dbReady, version: APP_VERSION }));

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
    setupAdventureFightWs(fastify.server);
    // Then wait for DB with exponential backoff to avoid log flooding.
    await waitForDb();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
