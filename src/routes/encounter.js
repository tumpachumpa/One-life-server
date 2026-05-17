'use strict';

const pool = require('../db/pool');

const contentModP = import('../game/logic/content.js');

// Mirrors src/logic/encounterCharges.js — kept inline so no shared ESM dependency
function getAvailable(max, rechargeMs, current, lastRechargeAt, nowMs) {
  return Math.min(max, current + Math.floor((nowMs - lastRechargeAt) / rechargeMs));
}

function consume(max, rechargeMs, current, lastRechargeAt, nowMs) {
  const elapsed = nowMs - lastRechargeAt;
  const recharges = Math.floor(elapsed / rechargeMs);
  return {
    current: Math.min(max, current + recharges) - 1,
    lastRechargeAt: lastRechargeAt + recharges * rechargeMs,
  };
}

async function encounterRoutes(fastify) {

  // GET /encounter/charges — return all charge states for this user
  fastify.get('/encounter/charges', { preHandler: fastify.authenticate }, async (request) => {
    const { id: userId } = request.user;
    const result = await pool.query(
      'SELECT region_id, current_charges, last_recharge_at FROM encounter_charges WHERE user_id = $1',
      [userId]
    );
    const charges = {};
    for (const row of result.rows) {
      charges[row.region_id] = {
        current: row.current_charges,
        lastRechargeAt: new Date(row.last_recharge_at).getTime(),
      };
    }
    return { charges };
  });

  // POST /encounter/consume-charge — validate and consume 1 charge
  fastify.post('/encounter/consume-charge', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;
    const { regionId } = request.body;
    if (!regionId) return reply.status(400).send({ error: 'Missing regionId' });

    const { regionById } = await contentModP;
    const region = regionById?.[regionId];
    if (!region?.singleEncounter || !region?.charges) {
      return reply.status(404).send({ error: 'Region not found or not a single encounter' });
    }

    const { max, rechargeSeconds } = region.charges;
    const rechargeMs = rechargeSeconds * 1000;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Initialize row at full charges if it doesn't exist yet, then lock it.
      // The two-step (INSERT ON CONFLICT DO NOTHING + SELECT FOR UPDATE) prevents
      // concurrent first-use requests from both seeing an empty row and double-consuming.
      await client.query(
        `INSERT INTO encounter_charges (user_id, region_id, current_charges, last_recharge_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, region_id) DO NOTHING`,
        [userId, regionId, max]
      );

      const existing = await client.query(
        `SELECT current_charges, last_recharge_at
         FROM encounter_charges
         WHERE user_id = $1 AND region_id = $2
         FOR UPDATE`,
        [userId, regionId]
      );

      const current = existing.rows[0].current_charges;
      const lastRechargeAt = new Date(existing.rows[0].last_recharge_at).getTime();
      const nowMs = Date.now();

      const available = getAvailable(max, rechargeMs, current, lastRechargeAt, nowMs);
      if (available <= 0) {
        await client.query('ROLLBACK');
        return reply.status(403).send({ error: 'No charges available' });
      }

      const next = consume(max, rechargeMs, current, lastRechargeAt, nowMs);

      await client.query(
        `UPDATE encounter_charges
         SET current_charges = $1, last_recharge_at = $2
         WHERE user_id = $3 AND region_id = $4`,
        [next.current, new Date(next.lastRechargeAt), userId, regionId]
      );

      await client.query('COMMIT');
      return { regionId, current: next.current, lastRechargeAt: next.lastRechargeAt };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
}

module.exports = encounterRoutes;
