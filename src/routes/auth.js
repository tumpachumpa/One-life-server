const pool = require('../db/pool');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');

const authAttempts = new Map();
const MAX_AUTH_ATTEMPTS = 10;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkAuthRateLimit(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= MAX_AUTH_ATTEMPTS) return false;
    entry.count++;
  } else {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  }
  return true;
}

async function authRoutes(fastify) {
  // POST /auth/register
  fastify.post('/auth/register', async (request, reply) => {
    if (!checkAuthRateLimit(request.ip)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
    }
    const { username, password } = request.body;
    if (!username || !password) {
      return reply.status(400).send({ error: 'Username and password required' });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      const result = await pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
        [username.trim().toLowerCase(), hash]
      );
      const user = result.rows[0];
      const nonce = randomUUID();
      await pool.query('UPDATE users SET session_nonce = $1 WHERE id = $2', [nonce, user.id]);
      const token = fastify.jwt.sign({ id: user.id, username: user.username, nonce });
      return { token, user: { id: user.id, username: user.username } };
    } catch (err) {
      if (err.code === '23505') {
        return reply.status(409).send({ error: 'Username already taken' });
      }
      throw err;
    }
  });

  // POST /auth/login
  fastify.post('/auth/login', async (request, reply) => {
    if (!checkAuthRateLimit(request.ip)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
    }
    const { username, password } = request.body;
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username.trim().toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' });
    const nonce = randomUUID();
    await pool.query('UPDATE users SET session_nonce = $1 WHERE id = $2', [nonce, user.id]);
    const token = fastify.jwt.sign({ id: user.id, username: user.username, nonce });
    return { token, user: { id: user.id, username: user.username } };
  });

  // GET /auth/ping — verifies the session nonce is still valid.
  // Returns 401 SESSION_KICKED when another device has logged in since this token was issued.
  // Tokens without a nonce (issued before this feature) are treated as valid.
  fastify.get('/auth/ping', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id, nonce } = request.user;
    if (!nonce) return { ok: true };
    const result = await pool.query('SELECT session_nonce FROM users WHERE id = $1', [id]);
    const user = result.rows[0];
    if (!user || user.session_nonce !== nonce) {
      return reply.status(401).send({ error: 'SESSION_KICKED' });
    }
    return { ok: true };
  });
}

module.exports = authRoutes;
