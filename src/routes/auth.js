const pool = require('../db/pool');
const bcrypt = require('bcryptjs');

async function authRoutes(fastify) {
  // POST /auth/register
  fastify.post('/auth/register', async (request, reply) => {
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
      const token = fastify.jwt.sign({ id: user.id, username: user.username });
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
    const { username, password } = request.body;
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username.trim().toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' });
    const token = fastify.jwt.sign({ id: user.id, username: user.username });
    return { token, user: { id: user.id, username: user.username } };
  });
}

module.exports = authRoutes;
