'use strict';

const pool = require('../db/pool');

const contentModP = import('../game/logic/content.js');

// Lazily built Map of nodeId → { max, rechargeSeconds } covering both
// single-encounter regions and adventure nodes that define charges.
let chargeConfigCache = null;

async function getChargeConfigs() {
  if (chargeConfigCache) return chargeConfigCache;
  const { regionById, adventureById } = await contentModP;
  const map = new Map();
  for (const region of Object.values(regionById || {})) {
    if (region?.charges) map.set(region.id, region.charges);
  }
  for (const adventure of Object.values(adventureById || {})) {
    for (const route of adventure.routes || []) {
      for (const node of route.nodes || []) {
        if (node?.charges) map.set(node.id, node.charges);
      }
    }
  }
  chargeConfigCache = map;
  return map;
}

// Charge keys are `${nodeId}@d${difficulty}` (per-difficulty pools). The config is
// keyed by the bare node/region id, so strip the suffix to look it up. Bare keys
// (no suffix, e.g. non-difficulty-scoped regions) pass through unchanged.
function chargeBaseId(key) {
  const s = String(key || '');
  const i = s.indexOf('@d');
  return i >= 0 ? s.slice(0, i) : s;
}

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
  // regionId can be a single-encounter region id OR an adventure node id.
  fastify.post('/encounter/consume-charge', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;
    const { regionId } = request.body;
    if (!regionId) return reply.status(400).send({ error: 'Missing regionId' });

    const chargeConfigs = await getChargeConfigs();
    const chargeConfig = chargeConfigs.get(chargeBaseId(regionId));
    if (!chargeConfig) {
      return reply.status(404).send({ error: 'Node not found or not chargeable' });
    }

    const { max, rechargeSeconds } = chargeConfig;
    const rechargeMs = rechargeSeconds * 1000;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Initialize row at full charges if it doesn't exist yet, then lock it.
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
