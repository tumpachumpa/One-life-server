const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

// Without this, a dead idle client emits an unhandled 'error' event and crashes the process.
pool.on('error', (err) => {
  console.error('[pool] idle client error:', err.message);
});

module.exports = pool;
