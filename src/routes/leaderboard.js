'use strict';

const pool = require('../db/pool');
const { isOnline } = require('../lib/online');

const heroModP = import('../game/logic/hero.js');

const DEV_ITEM_IDS = new Set(['test_bow_50', 'dev_normal_bow', 'test_sword_50', 'test_armor_500']);

function hasDevItem(equip = {}) {
  return Object.values(equip).some(ref => {
    if (!ref) return false;
    const id = typeof ref === 'string' ? ref : (ref.id || ref.itemId || ref.baseId || null);
    return DEV_ITEM_IDS.has(id);
  });
}

async function leaderboardRoutes(fastify) {
  fastify.get('/leaderboard', { preHandler: fastify.authenticate }, async (request) => {
    const { xpToLevel } = await heroModP;

    const result = await pool.query(`
      SELECT DISTINCT ON (user_id)
        user_id, save_data
      FROM heroes
      WHERE save_data->'hero'->>'characterCreated' = 'true'
        AND save_data->'hero'->>'name' IS NOT NULL
      ORDER BY user_id, updated_at DESC
    `);

    const rows = [];
    for (const row of result.rows) {
      const hero = row.save_data?.hero || {};
      if (!hero.name) continue;
      if (hero.devCharacter || hero.isDevCharacter || hero.devArcherLoadoutVersion != null) continue;
      if (hasDevItem(hero.equip || {})) continue;

      const { lvl: level } = xpToLevel(hero.xp || 0);
      rows.push({
        user_id:        String(row.user_id),
        name:           hero.name,
        xp:             hero.xp || 0,
        level,
        online:         isOnline(row.user_id),
        character_data: { equipment: hero.equip || {}, heroClass: hero.heroClass || null },
      });
    }

    rows.sort((a, b) => b.xp - a.xp);
    return rows.slice(0, 20);
  });
}

module.exports = leaderboardRoutes;
