const fp = require('fastify-plugin');
const online = require('../lib/online');

async function authPlugin(fastify) {
  fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET,
  });

  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
      online.touch(request.user.id);
    } catch (err) {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  });
}

module.exports = fp(authPlugin);
