require('dotenv').config();
const fastify = require('fastify')({ logger: true });

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

fastify.get('/health', async () => ({ status: 'ok' }));

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3001, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
