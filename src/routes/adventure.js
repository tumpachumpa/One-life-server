'use strict';

const pool = require('../db/pool');

// Start loading ESM game modules immediately (loaded once, reused)
const adventureModP = import('../game/logic/adventure.js');
const lootModP      = import('../game/logic/loot.js');
const heroModP      = import('../game/logic/hero.js');

async function getActiveSession(userId) {
  const r = await pool.query(
    `SELECT * FROM adventure_sessions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function adventureRoutes(fastify) {

  // POST /adventure/start — begin a new run for the given adventureId
  fastify.post('/adventure/start', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;
    const { adventureId, difficultyStars, slot_id: slotId = 'slot_1' } = request.body;
    if (!adventureId) return reply.status(400).send({ error: 'Missing adventureId' });

    const {
      getAdventure,
      createInitialAdventureProgress,
      normalizeAdventureProgress,
      startAdventureProgress,
      getAdventureChoiceNodes,
      getAdventureStatus,
    } = await adventureModP;

    const adventure = getAdventure(adventureId);
    if (!adventure) return reply.status(404).send({ error: 'Adventure not found' });

    // Abandon any lingering active session for this user
    await pool.query(
      `UPDATE adventure_sessions SET status = 'abandoned', updated_at = NOW()
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );

    // Load the hero's saved adventure progress
    const heroResult = await pool.query('SELECT save_data FROM heroes WHERE user_id = $1 AND slot_id = $2', [userId, slotId]);
    const saveData = heroResult.rows[0]?.save_data || {};
    const adventureProgress = saveData.adventureProgress || {};
    const existing = adventureProgress[adventureId] || null;

    const base = normalizeAdventureProgress(
      adventure,
      existing || createInitialAdventureProgress(adventure)
    );
    const started = startAdventureProgress(
      adventure,
      base,
      difficultyStars != null ? difficultyStars : null
    );

    const choices = getAdventureChoiceNodes(adventure, started);
    const status  = getAdventureStatus(adventure, started);

    const sessionResult = await pool.query(
      `INSERT INTO adventure_sessions
         (user_id, adventure_id, slot_id, status, progress, hero_snap, run_loot, run_xp, run_gold)
       VALUES ($1, $2, $3, 'active', $4, $5, '[]', 0, 0)
       RETURNING id`,
      [userId, adventureId, slotId, JSON.stringify(started), JSON.stringify(saveData.hero || null)]
    );
    const sessionId = sessionResult.rows[0].id;

    return {
      sessionId,
      adventureId,
      progress: started,
      choices,
      status,
      adventure: { id: adventure.id, name: adventure.name, zoneId: adventure.zoneId },
    };
  });

  // GET /adventure/current — reconnect to the active session
  fastify.get('/adventure/current', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;
    const session = await getActiveSession(userId);
    if (!session) return reply.status(404).send({ error: 'No active adventure' });

    const { getAdventure, getAdventureChoiceNodes, getAdventureStatus } = await adventureModP;

    const adventure = getAdventure(session.adventure_id);
    if (!adventure) return reply.status(404).send({ error: 'Adventure not found' });

    const progress = session.progress;
    return {
      sessionId: session.id,
      adventureId: session.adventure_id,
      progress,
      choices:  getAdventureChoiceNodes(adventure, progress),
      status:   getAdventureStatus(adventure, progress),
      runLoot:  session.run_loot  || [],
      runXp:    session.run_xp    || 0,
      runGold:  session.run_gold  || 0,
    };
  });

  // POST /adventure/select-node — player taps a node to navigate to
  fastify.post('/adventure/select-node', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;
    const { nodeId } = request.body;
    if (!nodeId) return reply.status(400).send({ error: 'Missing nodeId' });

    const session = await getActiveSession(userId);
    if (!session) return reply.status(404).send({ error: 'No active adventure' });

    const {
      getAdventure,
      getNode,
      selectNode,
      resolveAdventureNode,
      getAdventureChoiceNodes,
    } = await adventureModP;

    const adventure = getAdventure(session.adventure_id);
    if (!adventure) return reply.status(404).send({ error: 'Adventure not found' });

    const progress    = session.progress;
    const newProgress = selectNode(adventure, progress, nodeId);
    const { node }    = getNode(adventure, nodeId, newProgress);

    const totalCombats = (progress.completedNodes || []).length;
    const encounter = node
      ? resolveAdventureNode({ ...adventure, __progress: newProgress }, node, totalCombats)
      : null;

    await pool.query(
      `UPDATE adventure_sessions SET progress = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(newProgress), session.id]
    );

    return {
      progress: newProgress,
      encounter,
      choices: getAdventureChoiceNodes(adventure, newProgress),
    };
  });

  // POST /adventure/complete-node — node finished (combat won or event resolved)
  fastify.post('/adventure/complete-node', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;
    const { nodeId } = request.body;
    if (!nodeId) return reply.status(400).send({ error: 'Missing nodeId' });

    const session = await getActiveSession(userId);
    if (!session) return reply.status(404).send({ error: 'No active adventure' });

    // Phase 2: when a server-authoritative fight ran for THIS node, trust its
    // recorded outcome over the client's implicit "I completed it" claim. Only
    // engages for the dark-launched server-combat path, which is the only thing
    // that writes adventure_sessions.last_fight; flag-off players have none, so
    // they fall through to the unchanged legacy path below. nodeId + freshness
    // guard so a stale/other-node result can't be replayed.
    const lf = session.last_fight;
    const serverFight = (lf && lf.nodeId === nodeId && Number.isFinite(lf.at)
      && (Date.now() - lf.at) < 10 * 60 * 1000) ? lf : null;
    if (serverFight && serverFight.result !== 'won') {
      return reply.status(409).send({
        error: 'Server fight not won', code: 'FIGHT_NOT_WON', result: serverFight.result,
      });
    }

    const [
      {
        getAdventure,
        completeNode,
        getAdventureChoiceNodes,
        getAdventureStatus,
        getNode,
        resolveAdventureNode,
      },
      { rollCombatLoot },
      { getHungerLevel, getOverlevelXpMult, xpToLevel },
    ] = await Promise.all([adventureModP, lootModP, heroModP]);

    const adventure = getAdventure(session.adventure_id);
    if (!adventure) return reply.status(404).send({ error: 'Adventure not found' });

    const progress = session.progress;

    // Resolve the node & encounter to determine authoritative rewards
    const { node }   = getNode(adventure, nodeId, progress);
    const totalCombats = (progress.completedNodes || []).length;
    const encounter  = node
      ? resolveAdventureNode({ ...adventure, __progress: progress }, node, totalCombats)
      : null;
    const enemy = encounter?.enemy || null;

    // Load hero for hunger / overlevel XP multipliers (use session's slot_id)
    const heroResult = await pool.query('SELECT save_data FROM heroes WHERE user_id = $1 AND slot_id = $2', [userId, session.slot_id || 'slot_1']);
    const hero = heroResult.rows[0]?.save_data?.hero || {};

    let xpGained   = 0;
    let goldGained = 0;
    let lootItems  = [];

    if (enemy?.rewards) {
      const suppressRewards = !!(node?.noRewards || adventure?.noRewards);
      const suppressLoot    = suppressRewards || !!(node?.noLoot || adventure?.noLoot);

      if (!suppressRewards) {
        const heroLevel    = xpToLevel(hero.xp || 0).lvl;
        const hungerLevel  = getHungerLevel(hero.hunger ?? 100);
        const diffStars    = progress.activeDifficultyStars ?? 0;
        const enemyTier    = (enemy.tier || 1) + diffStars / 5;
        const overlevelMult = getOverlevelXpMult(heroLevel, enemyTier, enemy.rarity?.id, hero.energy);

        xpGained   = Math.floor((enemy.rewards.xp   || 0) * (hungerLevel.xpMult ?? 1) * overlevelMult * 0.56);
        goldGained = enemy.rewards.gold || 0;
      }
      if (!suppressLoot) {
        lootItems = rollCombatLoot(enemy, Math.random, { adventure, node }).filter(Boolean);
      }
    }

    const newProgress = completeNode(adventure, progress, nodeId);

    const runLoot  = [...(session.run_loot || []), ...lootItems];
    const runXp    = (session.run_xp  || 0) + xpGained;
    const runGold  = (session.run_gold || 0) + goldGained;
    const complete  = !!newProgress.bossCompleted;
    const newStatus = complete ? 'completed' : 'active';

    // NOTE: last_fight is intentionally NOT cleared here. HP carry between nodes is
    // done server-side in adventureFightWs.startFight, which reads the prior fight's
    // heroHpLeft off the session — the client save can't be trusted for hp (it round-
    // trips back to full, which also clobbered an earlier save_data.hero.hp approach).
    // Leaving it set is safe: each fight overwrites it, the win-gate above re-checks
    // the nodeId, and completeNode is idempotent for an already-completed node.
    await pool.query(
      `UPDATE adventure_sessions
       SET progress = $1, run_loot = $2, run_xp = $3, run_gold = $4, status = $5, updated_at = NOW()
       WHERE id = $6`,
      [JSON.stringify(newProgress), JSON.stringify(runLoot), runXp, runGold, newStatus, session.id]
    );

    return {
      progress: newProgress,
      choices:  complete ? [] : getAdventureChoiceNodes(adventure, newProgress),
      status:   getAdventureStatus(adventure, newProgress),
      runLoot,
      runXp,
      runGold,
      complete,
      xpGained,
      goldGained,
      lootItems,
      heroHpLeft: serverFight ? serverFight.heroHpLeft : null,
    };
  });

  // POST /adventure/fail-node — player died, abandon the run
  fastify.post('/adventure/fail-node', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;

    const session = await getActiveSession(userId);
    if (!session) return reply.status(404).send({ error: 'No active adventure' });

    const { getAdventure, revertAdventureOnDeath } = await adventureModP;

    const adventure = getAdventure(session.adventure_id);
    const progress  = session.progress;
    const reverted  = adventure ? revertAdventureOnDeath(adventure, progress) : progress;

    await pool.query(
      `UPDATE adventure_sessions
       SET progress = $1, status = 'abandoned', updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(reverted), session.id]
    );

    return { progress: reverted, abandoned: true };
  });

  // POST /adventure/complete — apply run rewards to the hero atomically
  fastify.post('/adventure/complete', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;

    const r = await pool.query(
      `SELECT * FROM adventure_sessions
       WHERE user_id = $1 AND status IN ('active', 'completed')
       ORDER BY updated_at DESC LIMIT 1`,
      [userId]
    );
    const session = r.rows[0];
    if (!session) return reply.status(404).send({ error: 'No session to finalize' });

    const { getAdventure, finishAdventureRunProgress, getLinkedAdventureDifficultyIds } = await adventureModP;

    const adventure = getAdventure(session.adventure_id);
    if (!adventure) return reply.status(404).send({ error: 'Adventure not found' });

    const heroResult = await pool.query('SELECT save_data FROM heroes WHERE user_id = $1 AND slot_id = $2', [userId, session.slot_id || 'slot_1']);
    const saveData   = heroResult.rows[0]?.save_data || {};

    const advProgress    = saveData.adventureProgress || {};
    const prevUnlockedStars = advProgress[session.adventure_id]?.unlockedDifficultyStars ?? 1;
    const newAdvProgress = finishAdventureRunProgress(
      { ...advProgress, [session.adventure_id]: session.progress },
      adventure,
      { completedDifficultyStars: session.progress?.activeDifficultyStars ?? 0 }
    );
    const newUnlockedStars = newAdvProgress[session.adventure_id]?.unlockedDifficultyStars ?? 1;

    // When a new difficulty tier is unlocked, reset encounter charges for all charge-bearing
    // nodes across the adventure and any linked adventures (e.g. all Rootspire floors).
    if (newUnlockedStars > prevUnlockedStars) {
      const linkedIds = getLinkedAdventureDifficultyIds(adventure);
      const chargeNodeIds = [];
      for (const advId of linkedIds) {
        const adv = getAdventure(advId);
        if (!adv) continue;
        for (const route of adv.routes || []) {
          for (const node of route.nodes || []) {
            if (node.charges) chargeNodeIds.push(node.id);
          }
        }
      }
      if (chargeNodeIds.length > 0) {
        await pool.query(
          `DELETE FROM encounter_charges WHERE user_id = $1 AND region_id = ANY($2)`,
          [userId, chargeNodeIds]
        );
      }
    }

    // Apply XP and gold server-side. Subtract what was already applied via intermediate hero saves
    // (saves are no longer clamped downward, so XP/gold may already be partially reflected in the DB).
    if (saveData.hero) {
      const startXp     = session.hero_snap?.xp   || 0;
      const startGold   = session.hero_snap?.gold || 0;
      const appliedXp   = Math.max(0, (saveData.hero.xp   || 0) - startXp);
      const appliedGold = Math.max(0, (saveData.hero.gold || 0) - startGold);
      const pendingXp   = Math.max(0, (session.run_xp   || 0) - appliedXp);
      const pendingGold = Math.max(0, (session.run_gold || 0) - appliedGold);
      saveData.hero.xp   = (saveData.hero.xp   || 0) + pendingXp;
      saveData.hero.gold = (saveData.hero.gold || 0) + pendingGold;
    }

    // Queue loot items for client to place on next GET /hero
    if (session.run_loot && session.run_loot.length > 0) {
      saveData.pendingLoot = [...(saveData.pendingLoot || []), ...session.run_loot];
    }

    saveData.adventureProgress = newAdvProgress;

    await pool.query(
      `UPDATE heroes SET save_data = $1, updated_at = NOW() WHERE user_id = $2 AND slot_id = $3`,
      [saveData, userId, session.slot_id || 'slot_1']
    );
    await pool.query(
      `UPDATE adventure_sessions SET status = 'finalized', updated_at = NOW() WHERE id = $1`,
      [session.id]
    );

    return {
      ok: true,
      runXp:    session.run_xp   || 0,
      runGold:  session.run_gold || 0,
      loot:     session.run_loot || [],
      adventureProgress: newAdvProgress,
    };
  });

  // DELETE /adventure/current — abandon the active session
  fastify.delete('/adventure/current', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: userId } = request.user;
    await pool.query(
      `UPDATE adventure_sessions SET status = 'abandoned', updated_at = NOW()
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    return { ok: true };
  });
}

module.exports = adventureRoutes;
