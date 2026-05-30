import { PHASE, ACTION, BLOCK_DODGE_COOLDOWN, ATTACK_ACTIONS, ABILITY_ACTIONS, ABILITY_SLOT_INDEX, TICK_MS, AUTO_ATTACK_TICKS, MOMENTUM_ATTACK_SPEED_PCT_PER_STACK } from './types.js';
import { getActiveRelics, getActiveRelicByType } from '../relics.js';
import { absorbDamageShield, applyCombatantDamage, createCombatant, canBlock, canDodge, getAbilityEnergyCost, getAbilityUseFailureReason, getActiveEffectTotal, getEffectiveArmor, getEffectiveCritChance, getPassiveArmorPenPct, getCritResistPct, getTargetBleedStacks, hasCombatTrigger, isAllyTargetAbility, isBleedImmune, isPoisonImmune, isStunned, resolveElementalDamage } from './combatant.js';
import {
  createActionQueue,
  enqueueAction,
  enqueueAbility,
  getImpactsAtTick,
  removePastActions,
  isCasting,
} from './actionQueue.js';
import { resolveImpact } from './actionResolver.js';
import { resolveAbilityImpact } from './abilities.js';
import { aiDecide } from './aiSystem.js';
import { applyArmor } from '../hero.js';
import { getEnemy } from '../content.js';
import { getBossPhase, scaleMonsterAbilities, scaleMonsterArmor, scaleMonsterAttack } from '../enemies.js';
import { getDiceAverage, rollDice } from '../equipmentGenerator.js';

const TESTING_DISABLE_WOUNDS = true;
const HERO_RAGE_MAX = 100;
const HERO_RAGE_DECAY_PER_IDLE_TICK = 3;
const HERO_RAGE_INACTIVITY_GRACE_TICKS = 4;
const HERO_ENERGY_MAX = 100;
const HERO_ENERGY_PER_TICK = 5;
export const ENERGY_CLASSES = new Set(['rogue']);
const PLAYER_BLEED_REFRESH_TICKS = 4;
const SCAR_STACK_MAX = 15;
const JUGGERNAUT_DAMAGE_TAKEN_REDUCTION_PCT = 30;
const JUGGERNAUT_DAMAGE_DEALT_PCT = -20;
const MOMENTUM_BASE_MAX = 10;
const SUMMON_DEATH_BOSS_STUN_TICKS = 3;
const SUMMON_DEATH_BOSS_VULNERABLE_TICKS = 4;
const SUMMON_DEATH_BOSS_DAMAGE_TAKEN_PCT = 20;
const FRONT_SWAP_CAST_TICKS = 1.5;
const FRONT_SWAP_COOLDOWN_SECONDS = 4;
const BACK_ROW_MELEE_DAMAGE_MULT = 0.75;
const OFF_FRONT_TARGET_DAMAGE_MULT = 0.75;
const PET_ALIVE_DAMAGE_REDUCTION_SOURCE = 'pet_alive_damage_reduction';
const GROUP_REVIVE_EFFECT = 'revive_if_group_alive';
const FRONT_SWAP_ABILITY = Object.freeze({
  id: 'front_swap',
  name: 'Swap',
  type: 'front_swap',
  castTicks: FRONT_SWAP_CAST_TICKS,
  cooldownSeconds: FRONT_SWAP_COOLDOWN_SECONDS,
  target: 'self',
});
const DAMAGE_TAKEN_BONUS_EFFECT = 'damage_taken_bonus_pct';
const NON_PASSIVE_PHASE_EFFECTS = new Set([
  'summon_add',
  'delayed_summon_add',
  'delayed_hazard_summon',
  'timed_spell',
  'casted_spell',
  'boss_shield',
  'pillar_intermission',
  'double_attack',
  'attack_mult',
]);
const MELEE_ABILITY_TYPES = new Set([
  'multi_hit',
  'stun',
  'empowered_attack',
  'whirlwind',
  'riposte',
  'crushing_blow',
  'execute',
  'weak_strike',
  'armor_shatter',
  'stunblow',
  'pummel_strike',
  'pressure_strike',
  'thunderstrike',
  'burnout',
  'grudge_release',
  'open_vein',
  'cleaving_order',
]);
const RANGED_ABILITY_TYPES = new Set([
  'hunter_mark',
  'bear_trap',
  'barbed_trap',
  'stagger_shot',
  'power_shot',
  'aimed_shot',
  'hemorrhaging_shot',
  'covering_fire',
  'headshot',
]);

function resolveSideRngs(rng = Math.random, options = {}) {
  const fallback = typeof rng === 'function' ? rng : Math.random;
  const bySide = options.rngBySide || {};
  return {
    fallback,
    player: typeof bySide.player === 'function' ? bySide.player : fallback,
    enemy: typeof bySide.enemy === 'function' ? bySide.enemy : fallback,
  };
}

function rngForCombatant(combatant, sideRngs) {
  return combatant?.team === 'enemy' ? sideRngs.enemy : sideRngs.player;
}

function getHeroCombatResources(rage = 0, heroClass = null) {
  if (ENERGY_CLASSES.has(heroClass)) {
    return {
      energy: {
        key: 'energy',
        label: 'Energy',
        value: 0,
        max: HERO_ENERGY_MAX,
      },
    };
  }
  return {
    rage: {
      key: 'rage',
      label: 'Rage',
      value: Math.max(0, Math.min(HERO_RAGE_MAX, Math.floor(rage || 0))),
      max: HERO_RAGE_MAX,
    },
  };
}

function syncHeroCombatResources(heroResources, procState) {
  if (!heroResources || !procState) return heroResources;
  if ('energy' in heroResources) {
    heroResources.energy = {
      ...(heroResources.energy || { key: 'energy', label: 'Energy', max: HERO_ENERGY_MAX }),
      key: 'energy',
      label: 'Energy',
      max: HERO_ENERGY_MAX,
      value: Math.max(0, Math.min(HERO_ENERGY_MAX, Math.floor(procState.energy || 0))),
    };
  } else {
    delete heroResources.energy;
    heroResources.rage = {
      ...(heroResources.rage || { key: 'rage', label: 'Rage', max: HERO_RAGE_MAX }),
      key: 'rage',
      label: 'Rage',
      max: HERO_RAGE_MAX,
      value: Math.max(0, Math.min(HERO_RAGE_MAX, Math.floor(procState.rage || 0))),
    };
  }
  return heroResources;
}

function markRageActivity(procState, tick) {
  if (!procState) return;
  procState.lastRageActivityTick = Math.max(procState.lastRageActivityTick ?? 0, tick || 0);
}

function getMomentumMax(heroProcNodes = [], hero = null) {
  const passiveCap = (hero?.passiveEffects || []).reduce((max, effect) => (
    effect.type === 'momentum_max_cap' ? Math.max(max, effect.value || effect.max || 0) : max
  ), 0);
  const nodeCap = (heroProcNodes || []).reduce((max, node) => (
    node?.momentumMaxCap ? Math.max(max, node.momentumMaxCap) : max
  ), 0);
  return Math.max(MOMENTUM_BASE_MAX, passiveCap, nodeCap);
}

function extractEnchantPassiveValues(enchEffects) {
  let enemyAttackSpeedSlowPct = 0;
  let physicalDmgReductionPct = 0;
  for (const e of enchEffects || []) {
    if (e?.enemyAttackSpeedSlow) enemyAttackSpeedSlowPct += Number(e.enemyAttackSpeedSlow) || 0;
    if (e?.physicalDamageReductionPct) physicalDmgReductionPct += Number(e.physicalDamageReductionPct) || 0;
  }
  return { enemyAttackSpeedSlowPct, physicalDmgReductionPct };
}

function applyScarStackArmor(hero, procState) {
  if (!hero?.isPlayer || !procState) return;
  const scarArmor = Math.max(0, Math.floor(procState.scarStacks || 0));
  hero.armor = (hero.baseArmor ?? hero.armor ?? 0) + scarArmor;
}

function cloneCombatant(combatant) {
  return {
    ...combatant,
    activeEffects: [...(combatant.activeEffects || [])],
    passiveEffects: [...(combatant.passiveEffects || [])],
    basePassiveEffects: [...(combatant.basePassiveEffects || combatant.passiveEffects || [])],
    phaseEffects: [...(combatant.phaseEffects || [])],
    phases: [...(combatant.phases || [])],
    summonCounts: { ...(combatant.summonCounts || {}) },
    bossTimers: { ...(combatant.bossTimers || {}) },
    abilityCooldowns: { ...(combatant.abilityCooldowns || {}) },
    usedAbilityIds: { ...(combatant.usedAbilityIds || {}) },
    completedDodgePhaseIds: { ...(combatant.completedDodgePhaseIds || {}) },
    combatTriggers: { ...(combatant.combatTriggers || {}) },
  };
}

function createEnemyCombatant(enemyObj, id = 'enemy') {
  const enemyRarityId = enemyObj.rarity?.id || (enemyObj.phases ? 'boss' : 'normal');
  const basePassiveEffects = enemyObj.effects || [];
  const enemyRarityCritChance = enemyRarityId === 'legendario' ? 12 : enemyRarityId === 'epico' ? 7 : 0;
  const enemyPassiveCritChance = basePassiveEffects
    .filter(effect => effect.type === 'crit_chance')
    .reduce((sum, effect) => sum + (effect.value || effect.chance || 0), 0);
  const enemyCritChance = enemyRarityCritChance + enemyPassiveCritChance + (enemyObj.stats?.critChance || 0);
  const enemyAbilities = scaleMonsterAbilities(enemyObj.abilities || []);
  const enemySpellDamage = enemyObj.stats?.spellDamage ?? enemyObj.baseStats?.spellDamage ?? enemyObj.spellDamage ?? 0;
  const disableAutoAttack = !!(enemyObj.disableAutoAttack || enemyObj.stats?.disableAutoAttack);
  const baseDisableAutoAttack = disableAutoAttack;
  const enemyAttackSpeed = disableAutoAttack
    ? 0
    : enemyObj.stats?.attackSpeed ?? enemyObj.baseStats?.attackSpeed ?? enemyObj.attackSpeed ?? 1;
  const combatant = createCombatant(
    id,
    false,
    enemyObj.hp ?? enemyObj.stats.maxHp,
    enemyObj.stats.maxHp,
    enemyObj.stats.attack,
    enemyObj.stats.armor ?? 0,
    enemyObj.name,
    enemyAbilities,
    {
      passiveEffects: basePassiveEffects,
      autoAttackRate: enemyAttackSpeed,
      rarityId: enemyRarityId,
      isBoss: !!enemyObj.phases,
      critChance: enemyCritChance,
      critResist: enemyObj.stats?.critResist || enemyObj.stats?.critResistance || 0,
      critMult: enemyObj.critMult ?? enemyObj.stats?.critMult ?? 1.5,
      blockChance: enemyObj.stats.blockChance || 0,
      blockPowerMax: enemyObj.stats.blockPower || 0,
      blockPower: enemyObj.stats.blockPower || 0,
      blockPowerRegen: enemyObj.stats.blockPowerRegen || 0,
      magicDefense: enemyObj.stats.magicDefense || enemyObj.stats.magicResistance || 0,
      fireResist: enemyObj.stats.fireResist || 0,
      coldResist: enemyObj.stats.coldResist || 0,
      lightningResist: enemyObj.stats.lightningResist || 0,
      shadowResist: enemyObj.stats.shadowResist || 0,
      poisonResist: enemyObj.stats.poisonResist || 0,
      spellDamageBonus: (enemyObj.effects || [])
        .filter(effect => effect.type === 'spell_damage')
        .reduce((sum, effect) => sum + (effect.value || 0), 0),
      family: enemyObj.family || null,
      tags: enemyObj.tags || [],
      weaponFamily: enemyObj.weaponFamily || enemyObj.stats.weaponFamily || null,
      attackType: enemyObj.attackType || enemyObj.stats.attackType || null,
      weaponTags: enemyObj.weaponTags || enemyObj.stats.weaponTags || [],
      weaponDamageDice: enemyObj.stats?.weaponDamageDice || null,
      weaponDamageMult: enemyObj.stats?.weaponDamageMult || 1,
      hitChanceBonus: enemyObj.stats?.hitChanceBonus || 0,
    },
  );
  return {
    ...combatant,
    sourceId: enemyObj.id || null,
    sourceCompanionId: enemyObj.sourceCompanionId || null,
    duelTargetId: enemyObj.duelTargetId || null,
    family: enemyObj.family || combatant.family || null,
    baseDamage: enemyObj.stats.attack,
    baseArmor: enemyObj.stats.armor ?? 0,
    baseAutoAttackRate: enemyAttackSpeed,
    spellDamage: enemySpellDamage,
    baseSpellDamage: enemySpellDamage,
    disableAutoAttack,
    basePassiveEffects: [...basePassiveEffects],
    phases: enemyObj.phases || [],
    phaseEffects: [],
    summonCounts: {},
    bossTimers: {},
    aura: enemyObj.aura || null,
    sprite: enemyObj.sprite || null,
    visual: enemyObj.visual || null,
    combatVisual: enemyObj.combatVisual || null,
    isDuelPlayer: enemyObj.isDuelPlayer || false,
    isDuelCompanion: enemyObj.isDuelCompanion || false,
    dodgePhaseConfig: enemyObj.dodgePhaseConfig || null,
    _baseDisableAutoAttack: baseDisableAutoAttack,
    hasCocoonTransform: enemyObj.hasCocoonTransform || false,
    hasTransformed: false,
    cocoonDurationTicks: enemyObj.cocoonDurationTicks ?? 4,
    cocoonMaxHp: enemyObj.cocoonMaxHp ?? null,
    cocoonSprite: enemyObj.cocoonSprite || null,
    phase2MaxHp: enemyObj.phase2MaxHp ?? null,
    phase2Attack: enemyObj.phase2Attack ?? null,
    phase2Armor: enemyObj.phase2Armor ?? null,
    phase2AttackSpeed: enemyObj.phase2AttackSpeed ?? null,
    phase2SpellDamage: enemyObj.phase2SpellDamage ?? null,
    phase2Abilities: enemyObj.phase2Abilities ?? null,
    activeEffects: basePassiveEffects.some(e => e.type === 'last_breath_once')
      ? [...combatant.activeEffects, { type: 'last_breath' }]
      : combatant.activeEffects,
  };
}

function createAllyCombatant(allyObj, index = 0) {
  const id = allyObj.id || `ally_${index + 1}`;
  const combatant = createEnemyCombatant(allyObj, id);
  return {
    ...combatant,
    id,
    isAlly: true,
    team: 'player',
  };
}

function getStateEnemies(combatants = {}) {
  const enemies = Array.isArray(combatants.enemies) ? combatants.enemies : [];
  if (combatants.enemy) return [combatants.enemy, ...enemies.slice(1)];
  return enemies;
}

function getStateAllies(combatants = {}) {
  return Array.isArray(combatants.allies) ? combatants.allies : [];
}

function getCombatantById(hero, enemies, id, allies = []) {
  if (id === 'hero') return hero;
  const ally = allies.find(entry => entry.id === id);
  if (ally) return ally;
  return enemies.find(enemy => enemy.id === id) || null;
}

function isEnemyUntargetable(enemy) {
  return !!(enemy?.combatHidden || enemy?.phasedOut || enemy?.untargetable);
}

function isTargetableEnemy(enemy) {
  return !!enemy && enemy.hp > 0 && !isEnemyUntargetable(enemy);
}

function getLivingEnemy(enemies, preferredId = null) {
  const preferred = preferredId ? enemies.find(enemy => enemy.id === preferredId && isTargetableEnemy(enemy)) : null;
  return preferred || enemies.find(isTargetableEnemy) || null;
}

function getEnemyFrontId(enemies = [], preferredFrontId = null) {
  const preferred = preferredFrontId
    ? enemies.find(enemy => enemy.id === preferredFrontId && isTargetableEnemy(enemy))
    : null;
  if (preferred) return preferred.id;
  const companionFront = enemies.find(enemy => enemy.isDuelCompanion && isTargetableEnemy(enemy));
  if (companionFront) return companionFront.id;
  return getLivingEnemy(enemies)?.id || null;
}

function getEnemySwapTarget(enemies = [], currentEnemyFrontId = null) {
  const living = enemies.filter(isTargetableEnemy);
  const primary = living.find(enemy => enemy.id === 'enemy') || living[0] || null;
  const companion = living.find(enemy => enemy.id !== primary?.id && enemy.isDuelCompanion)
    || living.find(enemy => enemy.id !== primary?.id);
  if (!primary || !companion) return null;
  return currentEnemyFrontId === primary.id ? companion : primary;
}

function getFrontId(hero, allies = [], preferredFrontId = null) {
  if (preferredFrontId && preferredFrontId !== 'hero') {
    const preferred = allies.find(ally => ally.id === preferredFrontId && ally.hp > 0);
    if (preferred) return preferred.id;
  }
  if (preferredFrontId === 'hero') return 'hero';
  const firstLivingAlly = allies.find(ally => ally.hp > 0);
  return firstLivingAlly?.id || 'hero';
}

function getFrontCombatant(hero, allies = [], frontId = 'hero') {
  if (frontId && frontId !== 'hero') {
    const ally = allies.find(entry => entry.id === frontId && entry.hp > 0);
    if (ally) return ally;
  }
  return hero;
}

function getLivingSwapAlly(allies = [], preferredId = null) {
  if (preferredId && preferredId !== 'hero') {
    const preferred = allies.find(ally => ally.id === preferredId && ally.hp > 0);
    if (preferred) return preferred;
  }
  return allies.find(ally => ally.hp > 0) || null;
}

function getAbilityTarget(combatant, ability, defaultTarget = null, opts = {}) {
  if (isAllyTargetAbility(ability)) {
    const sideAllies = isPlayerSideCombatant(combatant)
      ? (opts.allies || [])
      : (opts.enemyAllies || []);
    const livingAllies = sideAllies.filter(ally => ally.hp > 0);
    if (!livingAllies.length) return null;
    return livingAllies.find(ally => ally.hp < ally.maxHp) || livingAllies[0];
  }
  if (ability?.target === 'self') return combatant;
  return defaultTarget;
}

function hasActiveFrontSwapCast(queue = [], tick) {
  return queue.some(action =>
    action.actorId === 'hero'
    && action.ability?.type === 'front_swap'
    && (action.castEndTick ?? action.impactTick) > tick - 1);
}

function removePendingBasicAttacksForPlayerSide(queue, allies = []) {
  const playerSideIds = new Set(['hero', ...allies.map(ally => ally.id)]);
  return queue.filter(action => !(playerSideIds.has(action.actorId) && action.type === ACTION.BASIC_ATTACK));
}

function startFrontSwapCast(hero, allies = [], currentFrontId = 'hero', tick, log, queue = []) {
  const livingAlly = getLivingSwapAlly(allies, currentFrontId === 'hero' ? null : currentFrontId);
  if (!livingAlly) {
    log.push(makeEntry(tick, 'hero', 'front_swap_fail', 'No companion is able to swap positions.', 0, hero.hp, null));
    return queue;
  }
  if (isStunned(hero, tick)) {
    log.push(makeEntry(tick, 'hero', 'front_swap_fail', 'You are stunned and cannot swap positions.', 0, hero.hp, null));
    return queue;
  }
  if (hasActiveCastAtTick(queue, 'hero', tick) || hasActiveFrontSwapCast(queue, tick)) {
    log.push(makeEntry(tick, 'hero', 'front_swap_fail', 'You are already casting and cannot swap positions.', 0, hero.hp, null));
    return queue;
  }
  const cooldown = Math.max(0, (hero.abilityCooldowns?.[FRONT_SWAP_ABILITY.id] || 0) - tick);
  if (cooldown > 0) {
    log.push(makeEntry(tick, 'hero', 'front_swap_fail', `Swap is on cooldown (${cooldown} second${cooldown !== 1 ? 's' : ''} left).`, 0, hero.hp, null));
    return queue;
  }

  const nextFrontId = currentFrontId === 'hero' ? livingAlly.id : 'hero';
  const partner = currentFrontId === 'hero' ? livingAlly : hero;
  log.push(makeEntry(tick, 'hero', 'cast_start', `You prepare to swap positions with ${partner.name}.`, 0, hero.hp, null, {
    abilityId: FRONT_SWAP_ABILITY.id,
    abilityType: FRONT_SWAP_ABILITY.type,
    targetId: nextFrontId,
    frontId: currentFrontId,
    nextFrontId,
  }));
  return enqueueAbility(removePendingBasicAttacksForPlayerSide(queue, allies), 'hero', ACTION.SWAP_FRONT, FRONT_SWAP_CAST_TICKS, tick, 0, FRONT_SWAP_ABILITY, {
    targetId: nextFrontId,
    previousFrontId: currentFrontId,
    nextFrontId,
  });
}

function completeFrontSwap(hero, allies = [], currentFrontId = 'hero', nextFrontId = null, tick, log) {
  const livingAlly = allies.find(ally => ally.hp > 0);
  if (!livingAlly) {
    log.push(makeEntry(tick, 'hero', 'front_swap_fail', 'No companion is able to swap positions.', 0, hero.hp, null));
    return currentFrontId;
  }

  const resolvedFrontId = nextFrontId === 'hero' ? 'hero' : getLivingSwapAlly(allies, nextFrontId)?.id || livingAlly.id;
  const text = resolvedFrontId === 'hero'
    ? `${getFrontCombatant(hero, allies, currentFrontId)?.name || livingAlly.name} falls back. You take the front.`
    : `You send ${getLivingSwapAlly(allies, resolvedFrontId)?.name || livingAlly.name} to the front.`;
  log.push(makeEntry(tick, 'hero', 'front_swap', text, 0, hero.hp, null, {
    previousFrontId: currentFrontId,
    frontId: resolvedFrontId,
    targetId: resolvedFrontId,
  }));
  return resolvedFrontId;
}

function startEnemyFrontSwapCast(actor, enemies = [], currentEnemyFrontId = 'enemy', tick, log, queue = []) {
  const nextFront = getEnemySwapTarget(enemies, currentEnemyFrontId);
  if (!actor || !nextFront) {
    if (actor) log.push(makeEntry(tick, actor.id, 'front_swap_fail', `${actor.name} has no companion able to swap positions.`, 0, null, actor?.hp));
    return queue;
  }
  if (isStunned(actor, tick)) {
    log.push(makeEntry(tick, actor.id, 'front_swap_fail', `${actor.name} is stunned and cannot swap positions.`, 0, null, actor.hp));
    return queue;
  }
  if (hasActiveCastAtTick(queue, actor.id, tick)) {
    log.push(makeEntry(tick, actor.id, 'front_swap_fail', `${actor.name} is already casting and cannot swap positions.`, 0, null, actor.hp));
    return queue;
  }
  const cooldown = Math.max(0, (actor.abilityCooldowns?.[FRONT_SWAP_ABILITY.id] || 0) - tick);
  if (cooldown > 0) {
    log.push(makeEntry(tick, actor.id, 'front_swap_fail', `${actor.name}'s swap is on cooldown.`, 0, null, actor.hp));
    return queue;
  }

  log.push(makeEntry(tick, actor.id, 'cast_start', `${actor.name} prepares to change the front.`, 0, null, actor.hp, {
    abilityId: FRONT_SWAP_ABILITY.id,
    abilityType: FRONT_SWAP_ABILITY.type,
    targetId: nextFront.id,
    enemyFrontId: currentEnemyFrontId,
    nextEnemyFrontId: nextFront.id,
  }));
  return enqueueAbility(removePendingBasicAttacksForActor(queue, actor.id), actor.id, ACTION.SWAP_FRONT, FRONT_SWAP_CAST_TICKS, tick, 0, FRONT_SWAP_ABILITY, {
    targetId: nextFront.id,
    previousEnemyFrontId: currentEnemyFrontId,
    nextEnemyFrontId: nextFront.id,
    enemyFrontSwap: true,
  });
}

function completeEnemyFrontSwap(enemies = [], currentEnemyFrontId = 'enemy', nextEnemyFrontId = null, tick, log) {
  const resolvedEnemyFrontId = getEnemyFrontId(enemies, nextEnemyFrontId) || getEnemyFrontId(enemies, currentEnemyFrontId);
  if (!resolvedEnemyFrontId) return currentEnemyFrontId;
  const front = enemies.find(enemy => enemy.id === resolvedEnemyFrontId);
  const previousFront = enemies.find(enemy => enemy.id === currentEnemyFrontId);
  const text = resolvedEnemyFrontId === 'enemy'
    ? `${front?.name || 'Opponent'} takes the front.`
    : `${front?.name || 'Opponent companion'} moves to the front.`;
  log.push(makeEntry(tick, 'enemy', 'front_swap', text, 0, null, front?.hp, {
    previousEnemyFrontId: previousFront?.id || currentEnemyFrontId,
    enemyFrontId: resolvedEnemyFrontId,
    targetId: resolvedEnemyFrontId,
  }));
  return resolvedEnemyFrontId;
}

function buildCombatants(hero, enemies, allies = []) {
  const primaryEnemy = enemies[0] || null;
  return { hero, enemy: primaryEnemy, enemies, allies };
}

export function resolveFrontSwapCast(state, actionId = null) {
  if (!state || state.phase !== PHASE.FIGHTING) return state;
  const queuedAction = (state.actionQueue || []).find(action =>
    action.ability?.type === 'front_swap'
    && (actionId == null || action.id === actionId));
  if (!queuedAction) return state;

  const tick = queuedAction.castEndTick ?? queuedAction.impactTick;
  const hero = cloneCombatant(state.combatants.hero);
  const enemies = getStateEnemies(state.combatants).map(cloneCombatant);
  const allies = getStateAllies(state.combatants).map(cloneCombatant);
  let frontId = getFrontId(hero, allies, state.frontId);
  const log = [...state.log];

  startAbilityCooldown(hero, queuedAction.ability, tick);
  frontId = completeFrontSwap(hero, allies, frontId, queuedAction.nextFrontId || queuedAction.targetId, tick, log);

  let queue = (state.actionQueue || []).filter(action => action.id !== queuedAction.id);
  queue = removePendingBasicAttacksForPlayerSide(queue, allies);

  hero.isCasting = isCasting(queue, 'hero', tick);
  for (const ally of allies) {
    ally.isCasting = isCasting(queue, ally.id, tick);
  }
  for (const foe of enemies) {
    foe.isCasting = isCasting(queue, foe.id, tick);
  }

  return {
    ...state,
    tick,
    combatants: buildCombatants(hero, enemies, allies),
    frontId,
    actionQueue: queue,
    log,
  };
}

function getPhaseAttackMult(phase) {
  return (phase?.effects || []).reduce((mult, effect) => (
    effect.type === 'attack_mult' ? mult * (effect.value || 1) : mult
  ), 1);
}

function applyPhaseBarriers(combatant, phase, tick, log, heroHp) {
  for (const effect of phase?.effects || []) {
    if (effect.type !== 'boss_shield') continue;
    if (!isPhaseEffectHpReady(effect, combatant)) continue;

    const shieldHp = Math.max(0, Math.floor(effect.shieldHp ?? effect.value ?? effect.amount ?? 0));
    if (shieldHp <= 0) continue;

    const key = `boss_shield:${effect.id || phase.id}`;
    combatant.bossTimers = { ...(combatant.bossTimers || {}) };
    if (effect.once !== false && combatant.bossTimers[key]) continue;

    combatant.activeEffects = (combatant.activeEffects || [])
      .filter(active => !(active.type === 'damage_shield' && active.sourceAbilityId === (effect.id || key)));
    combatant.activeEffects.push({
      type: 'damage_shield',
      shieldHp,
      value: shieldHp,
      maxShieldHp: shieldHp,
      remainingTicks: effect.durationTicks ?? null,
      sourceAbilityId: effect.id || key,
      label: effect.name || 'Barrier',
    });
    if (effect.once !== false) combatant.bossTimers[key] = tick;

    log.push(makeEntry(tick, combatant.id, 'shield', `${combatant.name} gains ${effect.name || 'a barrier'} (${shieldHp} shield).`, 0, heroHp, combatant.hp, {
      abilityId: effect.id || key,
      abilityType: effect.type,
      targetId: combatant.id,
      shieldHp,
    }));
  }
}

function logDamageShieldAbsorb(defender, applied, tick, log, hero, enemy, targetMeta = {}) {
  if (!applied?.absorbed) return;
  const shields = applied.shields?.length ? applied.shields : [{ absorbed: applied.absorbed, label: 'Barrier', sourceAbilityId: null }];
  for (const shield of shields) {
    const absorbed = Math.max(0, shield.absorbed || 0);
    if (absorbed <= 0) continue;
    const text = defender.isPlayer
      ? `${shield.label || 'Barrier'} absorbs ${absorbed} damage.`
      : `${defender.name}'s ${shield.label || 'Barrier'} absorbs ${absorbed} damage.`;
    log.push(makeEntry(tick, defender.id, 'shield', text, 0, hero?.hp ?? null, enemy?.hp ?? null, {
      ...targetMeta,
      targetId: defender.id,
      abilityId: shield.sourceAbilityId || targetMeta.abilityId || null,
      absorbed,
    }));
  }
}

function getDamageShieldHp(combatant) {
  return (combatant?.activeEffects || [])
    .filter(effect => effect.type === 'damage_shield')
    .reduce((total, effect) => total + Math.max(0, Math.floor(effect.shieldHp ?? effect.value ?? 0)), 0);
}

function applyBossPhaseState(combatant, tick, log, heroHp) {
  if (!combatant?.phases?.length || combatant.hp <= 0) return;
  const hpPct = combatant.maxHp > 0 ? combatant.hp / combatant.maxHp : 1;
  const phase = getBossPhase(combatant, hpPct);
  const baseDamage = combatant.baseDamage ?? combatant.damage ?? 0;
  const baseArmor = combatant.baseArmor ?? combatant.armor ?? 0;
  const baseAttackRate = combatant.baseAutoAttackRate ?? combatant.autoAttackRate ?? 1;
  const baseSpellDamage = combatant.baseSpellDamage ?? combatant.spellDamage ?? baseDamage;
  const baseEffects = combatant.basePassiveEffects || combatant.passiveEffects || [];
  if (!phase) {
    combatant.damage = baseDamage;
    combatant.armor = baseArmor;
    combatant.autoAttackRate = baseAttackRate;
    combatant.spellDamage = baseSpellDamage;
    combatant.phaseEffects = [];
    combatant.passiveEffects = [...baseEffects];
    return;
  }
  if (combatant.activePhaseId !== phase.id) {
    combatant.activePhaseId = phase.id;
    log.push(makeEntry(tick, combatant.id, 'phase_change', `${combatant.name}: ${phase.label || phase.id}.`, 0, heroHp, combatant.hp, {
      phase: phase.id,
      targetId: combatant.id,
    }));
  }
  const phaseAttack = phase.stats?.attack != null ? scaleMonsterAttack(phase.stats.attack) : baseDamage;
  combatant.damage = Math.max(0, Math.round(phaseAttack * getPhaseAttackMult(phase)));
  combatant.armor = phase.stats?.armor != null ? scaleMonsterArmor(phase.stats.armor) : baseArmor;
  const phaseAttackSpeed = phase.stats?.attackSpeed ?? phase.attackSpeed ?? 1;
  combatant.autoAttackRate = combatant.disableAutoAttack ? 0 : Math.max(0.01, baseAttackRate * phaseAttackSpeed);
  combatant.spellDamage = phase.stats?.spellDamage ?? baseSpellDamage;
  combatant.phaseEffects = [...(phase.effects || [])];
  combatant.passiveEffects = [
    ...baseEffects,
    ...combatant.phaseEffects.filter(effect => !NON_PASSIVE_PHASE_EFFECTS.has(effect.type)),
  ];
  applyPhaseBarriers(combatant, phase, tick, log, heroHp);
}

function summonAdd(summoner, effect, enemies, tick, log, hero) {
  const summonKey = effect.id || effect.enemyId || 'summon';
  const maxAdds = effect.maxAdds || 1;
  const maxSummons = effect.maxSummons || 3;
  const livingAdds = enemies.filter(enemy => enemy.hp > 0 && enemy.summonedBy === summoner.id && enemy.summonKey === summonKey);
  if (livingAdds.length >= maxAdds) return enemies;
  const summonCounts = summoner.summonCounts || {};
  const usedSummons = summonCounts[summonKey] || 0;
  if (usedSummons >= maxSummons) return enemies;
  const def = getEnemy(effect.enemyId);
  if (!def?.baseStats) return enemies;
  const nextCount = usedSummons + 1;
  const summonId = `${summoner.id}_${summonKey}_${nextCount}`;
  const summonStats = {
    ...def.baseStats,
    attack: scaleMonsterAttack(def.baseStats.attack),
    armor: scaleMonsterArmor(def.baseStats.armor),
  };
  const summon = createEnemyCombatant({
    ...def,
    stats: summonStats,
    hp: summonStats.maxHp,
    sprite: effect.addSprite || def.sprite,
  }, summonId);
  summon.summonedBy = summoner.id;
  summon.summonKey = summonKey;
  summon.isSummon = true;
  if (effect.devourAfterTicks != null) {
    summon.devourAtTick = tick + effect.devourAfterTicks;
    summon.devourHealPct = effect.devourHealPct || 7;
    summon.devourBossId = summoner.id;
  }
  summoner.summonCounts = { ...summonCounts, [summonKey]: nextCount };
  log.push(makeEntry(tick, summoner.id, 'summon', `${summoner.name} summons ${summon.name} (${nextCount}/${maxSummons}).`, 0, hero.hp, summoner.hp, {
    targetId: summon.id,
    addId: summon.id,
    addSourceId: summon.sourceId,
    addFamily: summon.family,
    addSprite: summon.sprite,
    addHp: summon.hp,
    addMaxHp: summon.maxHp,
    pauseMs: effect.pauseMs || 1200,
    abilityId: effect.id || null,
    abilityType: effect.type || 'summon_add',
  }));
  return [...enemies, summon];
}

function getEnemySideAllies(enemies = [], attacker = null) {
  return enemies.filter(entry =>
    entry
    && entry.hp > 0
    && entry.id !== attacker?.id
    && entry.team !== 'player'
    && !entry.isAlly);
}

function appendAbilityEntries(log, entries, tick, attacker, defender, hero, logEnemy, ability, extraMeta = {}) {
  for (const entry of entries) {
    log.push(makeEntry(tick, attacker.id, entry.type, entry.text, entry.damage, hero.hp, logEnemy?.hp, {
      abilityId: ability?.id || null,
      abilityType: ability?.type || null,
      element: entry.element || ability?.element || null,
      isCrit: !!entry.isCrit,
      absorbed: entry.absorbed || 0,
      targetId: entry.targetId || defender?.id || attacker.id,
      ...extraMeta,
    }));
  }
}

function clearSummonAuraEffects(combatant) {
  if (!combatant) return;
  combatant.activeEffects = (combatant.activeEffects || []).filter(effect => effect.source !== 'summon_aura');
}

function applySummonAuras(enemies) {
  for (const foe of enemies) clearSummonAuraEffects(foe);
  for (const summon of enemies) {
    if (summon.hp <= 0 || !summon.aura || !summon.summonedBy) continue;
    const owner = enemies.find(foe => foe.id === summon.summonedBy && foe.hp > 0);
    if (!owner) continue;
    const sourceMeta = {
      source: 'summon_aura',
      sourceSummonId: summon.id,
      sourceAbilityId: summon.summonKey || summon.sourceId || summon.id,
      remainingTicks: 2,
    };
    if ((summon.aura.blockChanceBonus || 0) > 0) {
      owner.activeEffects.push({
        type: 'block_chance_buff',
        value: summon.aura.blockChanceBonus,
        ...sourceMeta,
      });
    }
    if ((summon.aura.damageBonusPct || 0) > 0) {
      owner.activeEffects.push({
        type: 'damage_bonus_pct_buff',
        value: summon.aura.damageBonusPct,
        ...sourceMeta,
      });
    }
  }
}

function isPhaseEffectHpReady(effect, combatant) {
  const hpPct = getHpPct(combatant);
  if (effect.triggerHpPct != null && hpPct > effect.triggerHpPct) return false;
  if (effect.minTriggerHpPct != null && hpPct < effect.minTriggerHpPct) return false;
  return true;
}

function applyPhaseSummons(combatant, enemies, tick, log, rng, hero) {
  if (!combatant?.phaseEffects?.length || combatant.hp <= 0) return enemies;
  let nextEnemies = enemies;
  for (const effect of combatant.phaseEffects.filter(entry => entry.type === 'summon_add')) {
    if (!isPhaseEffectHpReady(effect, combatant)) continue;
    if (rng() * 100 >= (effect.chance ?? 100)) continue;
    nextEnemies = summonAdd(combatant, effect, nextEnemies, tick, log, hero);
    if (nextEnemies !== enemies) break;
  }
  return nextEnemies;
}

function getStateCycleStates(cycle = null) {
  return Array.isArray(cycle?.states) ? cycle.states.filter(state => state?.id) : [];
}

function getStateCycleDuration(states = []) {
  return states.reduce((total, state) => total + Math.max(1, Math.ceil(state.durationTicks || 1)), 0);
}

function getStateCycleSpriteMap(states = []) {
  return Object.fromEntries(states
    .filter(state => state?.id && state?.sprite)
    .map(state => [state.id, state.sprite]));
}

function resolveCombatantCycleState(combatant, tick) {
  const cycle = combatant?.stateCycle;
  const states = getStateCycleStates(cycle);
  if (!states.length) return null;
  const totalDuration = getStateCycleDuration(states);
  if (totalDuration <= 0) return states[0];

  const startTick = combatant.stateCycleStartTick ?? combatant.spawnTick ?? 0;
  const offset = combatant.stateCycleOffsetTicks || 0;
  let elapsed = Math.max(0, Math.floor((tick || 0) - startTick + offset)) % totalDuration;
  for (const state of states) {
    const duration = Math.max(1, Math.ceil(state.durationTicks || 1));
    if (elapsed < duration) return state;
    elapsed -= duration;
  }
  return states[0];
}

function applyCombatantStateCycle(combatant, tick) {
  const state = resolveCombatantCycleState(combatant, tick);
  if (!state) return combatant;
  const stateKey = combatant.stateCycle?.stateKey || 'colorState';
  combatant[stateKey] = state.id;
  combatant.colorState = state.id;
  combatant.colorStateLabel = state.label || state.id;
  combatant.stateSprites = {
    ...(combatant.stateSprites || {}),
    ...getStateCycleSpriteMap(getStateCycleStates(combatant.stateCycle)),
  };
  if (state.sprite) combatant.sprite = state.sprite;
  return combatant;
}

function applyCombatantStateCycles(enemies, tick) {
  for (const foe of enemies) applyCombatantStateCycle(foe, tick);
}

function setBossPillarIntermissionState(boss, effect, active, tick) {
  if (!boss) return;
  const source = effect.id || 'pillar_intermission';
  boss.combatHidden = !!active;
  boss.phasedOut = !!active;
  boss.untargetable = !!active;
  boss.pillarIntermissionId = active ? source : null;
  boss.activeEffects = (boss.activeEffects || []).filter(entry => entry.source !== source);
  if (active) {
    boss.autoAttackRate = 0;
    boss.activeEffects.push({
      type: 'phased_out',
      source,
      label: effect.name || 'Oath Intermission',
      remainingTicks: 2,
    });
  } else {
    boss.stateReturnedTick = tick;
  }
}

function getIntermissionPillars(enemies, boss, effect, livingOnly = false) {
  const intermissionId = effect.id || 'pillar_intermission';
  return enemies.filter(enemy =>
    enemy
    && enemy.summonedBy === boss.id
    && enemy.pillarIntermissionId === intermissionId
    && (!livingOnly || enemy.hp > 0));
}

function createPillarCombatant(boss, effect, index, tick) {
  const def = getEnemy(effect.enemyId);
  if (!def?.baseStats) return null;
  const states = getStateCycleStates(effect.stateCycle || def.stateCycle);
  const firstState = states[0] || null;
  const firstStateDuration = Math.max(1, Math.ceil(firstState?.durationTicks || 1));
  const summonStats = {
    ...def.baseStats,
    attack: scaleMonsterAttack(def.baseStats.attack),
    armor: scaleMonsterArmor(def.baseStats.armor),
  };
  const pillar = createEnemyCombatant({
    ...def,
    stats: summonStats,
    hp: summonStats.maxHp,
    sprite: firstState?.sprite || def.sprite,
  }, `${boss.id}_${effect.id || effect.enemyId || 'pillar'}_${index + 1}`);
  pillar.summonedBy = boss.id;
  pillar.summonKey = effect.id || effect.enemyId || 'pillar_intermission';
  pillar.pillarIntermissionId = effect.id || 'pillar_intermission';
  pillar.isPillar = true;
  pillar.spawnTick = tick;
  pillar.stateCycle = effect.stateCycle || def.stateCycle || null;
  pillar.stateCycleStartTick = tick;
  pillar.stateCycleOffsetTicks = effect.alternateStarts && index % 2 === 1 ? firstStateDuration : 0;
  pillar.stateSprites = getStateCycleSpriteMap(states);
  applyCombatantStateCycle(pillar, tick);
  return pillar;
}

function applyPillarIntermissions(enemies, queue, tick, log, hero) {
  let nextEnemies = enemies;
  let nextQueue = queue;
  for (const boss of nextEnemies) {
    if (!boss?.phaseEffects?.length || boss.hp <= 0) continue;
    for (const effect of boss.phaseEffects.filter(entry => entry.type === 'pillar_intermission')) {
      if (!isPhaseEffectHpReady(effect, boss)) continue;
      const key = `pillar_intermission:${effect.id || effect.enemyId || 'pillars'}`;
      const startedKey = `${key}:started`;
      const completedKey = `${key}:completed`;
      boss.bossTimers = { ...(boss.bossTimers || {}) };
      const started = !!boss.bossTimers[startedKey];
      const completed = !!boss.bossTimers[completedKey];
      if (completed) {
        setBossPillarIntermissionState(boss, effect, false, tick);
        continue;
      }

      if (!started) {
        const count = Math.max(1, Math.floor(effect.count || 4));
        const pillars = [];
        for (let index = 0; index < count; index += 1) {
          const pillar = createPillarCombatant(boss, effect, index, tick);
          if (pillar) pillars.push(pillar);
        }
        if (!pillars.length) continue;
        boss.bossTimers[startedKey] = tick;
        setBossPillarIntermissionState(boss, effect, true, tick);
        nextQueue = removePendingBasicAttacksForActor(removePendingAbilityCastsForActor(nextQueue, boss.id), boss.id);
        nextEnemies = [...nextEnemies, ...pillars];
        log.push(makeEntry(tick, boss.id, 'phase_change', effect.phaseOutText || `${boss.name} vanishes behind oathbound pillars.`, 0, hero.hp, boss.hp, {
          abilityId: effect.id || null,
          abilityType: effect.type,
          targetId: boss.id,
          addCount: pillars.length,
        }));
        continue;
      }

      const livingPillars = getIntermissionPillars(nextEnemies, boss, effect, true);
      if (livingPillars.length > 0) {
        setBossPillarIntermissionState(boss, effect, true, tick);
        continue;
      }

      boss.bossTimers[completedKey] = tick;
      setBossPillarIntermissionState(boss, effect, false, tick);
      log.push(makeEntry(tick, boss.id, 'phase_change', effect.returnText || `${boss.name} returns as the pillars fall.`, 0, hero.hp, boss.hp, {
        abilityId: effect.id || null,
        abilityType: effect.type,
        targetId: boss.id,
      }));
    }
  }
  applyCombatantStateCycles(nextEnemies, tick);
  return { enemies: nextEnemies, queue: nextQueue };
}

function getCombatantStateHitReaction(combatant) {
  const cycle = combatant?.stateCycle;
  const stateKey = cycle?.stateKey || 'colorState';
  const stateId = combatant?.[stateKey] || combatant?.colorState;
  if (!stateId) return null;
  return cycle?.hitReactions?.[stateId] || null;
}

function applyStackingStateDot(target, reaction, source, fallbackDamage, fallbackElement = 'shadow') {
  const dot = reaction?.dot || null;
  if (!target || !dot) return null;
  const type = dot.type || reaction.dotType || 'shadow_burn';
  const durationTicks = Math.max(1, Math.ceil(dot.durationTicks ?? reaction.dotDurationTicks ?? 3));
  const damageFlat = Math.max(1, Math.floor(dot.damageFlat ?? reaction.dotDamage ?? fallbackDamage ?? 1));
  const element = dot.element || reaction.element || fallbackElement;
  const maxStacks = Math.max(1, Math.floor(dot.maxStacks ?? reaction.dotMaxStacks ?? 3));
  const label = dot.label || reaction.dotLabel || 'Umbral Burn';
  target.activeEffects = target.activeEffects || [];
  const existing = target.activeEffects.find(effect => effect.type === type && effect.source === source);
  if (existing) {
    existing.stacks = Math.min(maxStacks, Math.max(1, existing.stacks || 1) + 1);
    existing.remainingTicks = durationTicks;
    existing.damageFlat = damageFlat;
    existing.element = element;
    existing.maxStacks = maxStacks;
    existing.label = label;
    return existing;
  }
  const applied = {
    type,
    remainingTicks: durationTicks,
    damageFlat,
    element,
    stacks: 1,
    maxStacks,
    source,
    label,
  };
  target.activeEffects.push(applied);
  return applied;
}

function applyCombatantStateHitReaction(attacker, defender, tick, log, hero, logEnemy, procState = null) {
  if (!attacker || !defender || !isPlayerSideCombatant(attacker)) return;
  const reaction = getCombatantStateHitReaction(defender);
  if (!reaction) return;
  const stateId = defender.colorState || defender.pillarState || 'state';
  const source = `state_hit:${defender.id}:${stateId}`;

  if (reaction.type === 'expose_self') {
    const damageTakenPct = Math.max(0, Math.floor(reaction.damageTakenPct || reaction.value || 0));
    if (damageTakenPct <= 0) return;
    defender.activeEffects = (defender.activeEffects || []).filter(effect => effect.source !== source);
    defender.activeEffects.push({
      type: DAMAGE_TAKEN_BONUS_EFFECT,
      value: damageTakenPct,
      remainingTicks: Math.max(1, Math.ceil(reaction.durationTicks || 2)),
      source,
      label: reaction.label || 'Oath Fracture',
    });
    log.push(makeEntry(tick, defender.id, 'weaken', reaction.logText || `${defender.name} is exposed.`, 0, hero.hp, logEnemy?.hp ?? defender.hp, {
      targetId: defender.id,
      abilityType: 'state_hit_reaction',
      state: stateId,
      damageTakenPct,
    }));
    return;
  }

  if (reaction.type === 'shadow_backlash') {
    const rawDamage = Math.max(1, Math.floor(reaction.damage || reaction.value || 1));
    const element = reaction.element || 'shadow';
    const target = attacker.isAlly ? attacker : hero;
    const damage = resolveElementalDamage(rawDamage, element, target);
    target.hp = Math.max(0, target.hp - damage);
    if (target.id === 'hero') gainRageOnTakingHit(procState, damage, tick);
    const dotEffect = target.hp > 0
      ? applyStackingStateDot(target, reaction, `${source}:dot`, rawDamage, element)
      : null;
    if ((reaction.dazeTicks || 0) > 0) {
      target.activeEffects = (target.activeEffects || []).filter(effect => effect.type !== 'daze');
      target.activeEffects.push({
        type: 'daze',
        remainingTicks: Math.max(1, Math.ceil(reaction.dazeTicks)),
        missSpellChance: reaction.missSpellChance || 50,
      });
    }
    const targetText = target.id === 'hero' ? 'you' : target.name;
    const dazeText = (reaction.dazeTicks || 0) > 0 ? ' and dazes the target' : '';
    const text = reaction.logText
      ? `${reaction.logText} ${targetText} takes ${damage} ${element} damage${dazeText}.`
      : `${defender.name}'s ${stateId} state lashes ${targetText} for ${damage} ${element} damage${dazeText}.`;
    log.push(makeEntry(tick, defender.id, 'ability', text, damage, hero.hp, logEnemy?.hp ?? defender.hp, {
      targetId: target.id,
      abilityType: 'state_hit_reaction',
      state: stateId,
      element,
      dotType: dotEffect?.type || null,
      dotStacks: dotEffect?.stacks || 0,
      dotMaxStacks: dotEffect?.maxStacks || 0,
    }));
    if (dotEffect) {
      const stackText = dotEffect.maxStacks > 1 ? ` (${dotEffect.stacks}/${dotEffect.maxStacks} stacks)` : '';
      const dotTarget = target.id === 'hero' ? 'you' : target.name;
      log.push(makeEntry(tick, defender.id, dotEffect.type, `${dotEffect.label || 'Umbral Burn'} clings to ${dotTarget}${stackText}.`, 0, hero.hp, logEnemy?.hp ?? defender.hp, {
        targetId: target.id,
        abilityType: 'state_hit_reaction',
        state: stateId,
        element: dotEffect.element || element,
        stacks: dotEffect.stacks || 1,
        maxStacks: dotEffect.maxStacks || 1,
      }));
    }
  }
}

function hasActiveCastAtTick(queue, actorId, tick) {
  return queue.some(queuedAction => queuedAction.actorId === actorId && (queuedAction.castEndTick ?? queuedAction.impactTick) > tick - 1);
}

function getSummonKey(effect) {
  return effect.id || effect.enemyId || effect.hazardId || 'summon';
}

function getPhaseAbilityId(effect, type) {
  return effect.id || `${type}_${effect.enemyId || effect.hazardId || 'effect'}`;
}

function canStartPhaseAbilityCooldown(combatant, effect, type, tick) {
  const readyTick = (combatant.abilityCooldowns || {})[getPhaseAbilityId(effect, type)] || 0;
  return tick >= readyTick;
}

function canStartSummonCast(summoner, effect, enemies) {
  const summonKey = getSummonKey(effect);
  const maxAdds = effect.maxAdds || 1;
  const maxSummons = effect.maxSummons || 3;
  const livingAdds = enemies.filter(enemy => enemy.hp > 0 && enemy.summonedBy === summoner.id && enemy.summonKey === summonKey);
  if (livingAdds.length >= maxAdds) return false;
  const usedSummons = (summoner.summonCounts || {})[summonKey] || 0;
  return usedSummons < maxSummons;
}

function canStartHazardCast(summoner, effect, enemies) {
  const hazardKey = getSummonKey(effect);
  const maxAdds = effect.maxAdds || 1;
  const maxSummons = effect.maxSummons || 99;
  const livingHazards = enemies.filter(enemy => enemy.hp > 0 && enemy.summonedBy === summoner.id && enemy.hazardKey === hazardKey);
  if (livingHazards.length >= maxAdds) return false;
  const usedSummons = (summoner.summonCounts || {})[hazardKey] || 0;
  return usedSummons < maxSummons;
}

function getPhaseCastTicks(effect) {
  return Math.max(0, Math.ceil(effect.castTicks ?? effect.castSeconds ?? 1));
}

function getPhaseIntervalTicks(effect, fallback = 3) {
  const interval = effect.intervalTicks ?? effect.cooldownTicks ?? ((effect.intervalSeconds * 1000) / TICK_MS);
  return Math.max(1, Math.ceil(Number(interval) || fallback));
}

function canStartCastedSpell(caster, effect, tick) {
  const key = `casted_spell:${effect.id || effect.name || 'spell'}:ready`;
  const readyTick = (caster.bossTimers || {})[key] ?? tick;
  return tick >= readyTick;
}

function markCastedSpellStarted(caster, effect, tick, castTicks) {
  const key = `casted_spell:${effect.id || effect.name || 'spell'}:ready`;
  const interval = getPhaseIntervalTicks(effect);
  caster.bossTimers = { ...(caster.bossTimers || {}), [key]: tick + castTicks + interval };
}

function phaseCastAbility(effect, type) {
  const ability = {
    id: getPhaseAbilityId(effect, type),
    name: effect.name || (type === 'summon_hazard' ? 'Summon Hazard' : 'Summon Ally'),
    type,
    castTicks: getPhaseCastTicks(effect),
    cooldown: effect.cooldown ?? 0,
    cooldownTicks: effect.cooldownTicks,
    cooldownSeconds: effect.cooldownSeconds,
    phaseEffect: effect,
    summonEffect: effect,
  };

  if (type === 'spell_attack') {
    return {
      ...ability,
      damage: effect.damage ?? effect.spellDamage,
      damageMult: effect.damageMult,
      element: effect.element || effect.damageElement || 'magic',
      burning: effect.burning || effect.burn,
      burnDurationTicks: effect.burnDurationTicks,
      burnDamageFlat: effect.burnDamageFlat,
      burnDamagePct: effect.burnDamagePct,
      burnElement: effect.burnElement,
    };
  }

  return ability;
}

function applyPhaseCasts(combatant, enemies, queue, tick, log, rng, hero, target = hero) {
  if (!combatant?.phaseEffects?.length || combatant.hp <= 0 || isStunned(combatant, tick)) return queue;
  if (hasActiveCastAtTick(queue, combatant.id, tick)) return queue;

  for (const effect of combatant.phaseEffects) {
    if (effect.type !== 'delayed_summon_add' && effect.type !== 'delayed_hazard_summon' && effect.type !== 'casted_spell') continue;
    if (!isPhaseEffectHpReady(effect, combatant)) continue;
    const canStart = effect.type === 'casted_spell'
      ? target.hp > 0 && canStartCastedSpell(combatant, effect, tick)
      : effect.type === 'delayed_hazard_summon'
        ? canStartHazardCast(combatant, effect, enemies)
        : canStartSummonCast(combatant, effect, enemies);
    if (!canStart) continue;

    const abilityType = effect.type === 'casted_spell'
      ? 'spell_attack'
      : effect.type === 'delayed_hazard_summon'
        ? 'summon_hazard'
        : 'summon_add';
    if (!canStartPhaseAbilityCooldown(combatant, effect, abilityType, tick)) continue;
    if (rng() * 100 >= (effect.chance ?? 100)) continue;

    const ability = phaseCastAbility(effect, abilityType);
    if (effect.type === 'casted_spell') markCastedSpellStarted(combatant, effect, tick, ability.castTicks);
    log.push(makeEntry(tick, combatant.id, 'cast_start', `${combatant.name} begins ${ability.name}...`, 0, hero.hp, combatant.hp, {
      abilityId: ability.id,
      abilityType,
      targetId: target.id,
      element: ability.element || null,
    }));
    return enqueueAbility(queue, combatant.id, ACTION.ABILITY_0, ability.castTicks, tick, 0, ability, {
      targetId: target.id,
    });
  }

  return queue;
}

function summonHazard(summoner, effect, enemies, tick, log, hero) {
  const hazardKey = getSummonKey(effect);
  const maxAdds = effect.maxAdds || 1;
  const maxSummons = effect.maxSummons || 99;
  const livingHazards = enemies.filter(enemy => enemy.hp > 0 && enemy.summonedBy === summoner.id && enemy.hazardKey === hazardKey);
  if (livingHazards.length >= maxAdds) return enemies;
  const summonCounts = summoner.summonCounts || {};
  const usedSummons = summonCounts[hazardKey] || 0;
  if (usedSummons >= maxSummons) return enemies;

  const nextCount = usedSummons + 1;
  const hazardId = `${summoner.id}_${hazardKey}_${nextCount}`;
  const durationTicks = Math.max(1, Math.ceil(effect.durationTicks || 4));
  const hazardHp = Math.max(1, Math.floor(effect.hazardHp ?? effect.hp ?? 1));
  const hazard = createCombatant(
    hazardId,
    false,
    hazardHp,
    hazardHp,
    0,
    0,
    effect.hazardName || 'Pile of Bones',
    [],
    {
      autoAttackRate: 0,
      family: 'hazard',
      tags: ['hazard'],
    },
  );
  hazard.sourceId = effect.hazardId || 'pile_of_bones';
  hazard.hazardKey = hazardKey;
  hazard.summonedBy = summoner.id;
  hazard.isHazard = true;
  hazard.disableAutoAttack = true;
  hazard.spawnTick = tick;
  hazard.explodeTick = tick + durationTicks;
  hazard.explosionDamage = Math.max(0, Math.floor(effect.explosionDamage || 30));
  hazard.sprite = effect.hazardSprite || '/assets/items/generated/bone.png';
  hazard.activeEffects = [{ type: 'unstable_bones', remainingTicks: durationTicks }];
  summoner.summonCounts = { ...summonCounts, [hazardKey]: nextCount };
  log.push(makeEntry(tick, summoner.id, 'summon', `${summoner.name} summons ${hazard.name}. Destroy it before it detonates.`, 0, hero.hp, summoner.hp, {
    targetId: hazard.id,
    addId: hazard.id,
    addSourceId: hazard.sourceId,
    addSprite: hazard.sprite,
    addHp: hazard.hp,
    addMaxHp: hazard.maxHp,
    explodeTick: hazard.explodeTick,
    abilityId: effect.id || null,
    abilityType: effect.type || 'delayed_hazard_summon',
  }));
  return [...enemies, hazard];
}

function applyTimedBossSpells(combatant, tick, log, hero, target = hero) {
  if (!combatant?.phaseEffects?.length || combatant.hp <= 0 || target.hp <= 0 || isStunned(combatant, tick)) return;
  for (const effect of combatant.phaseEffects.filter(entry => entry.type === 'timed_spell')) {
    if (!isPhaseEffectHpReady(effect, combatant)) continue;
    const interval = Math.max(1, Number(effect.intervalTicks ?? ((effect.intervalSeconds * 1000) / TICK_MS)) || 1);
    const key = effect.id || effect.name || effect.element || 'timed_spell';
    const elapsedKey = `timed:${key}:elapsed`;
    combatant.bossTimers = { ...(combatant.bossTimers || {}) };
    const elapsed = (combatant.bossTimers[elapsedKey] || 0) + 1;
    if (elapsed < interval) {
      combatant.bossTimers[elapsedKey] = elapsed;
      continue;
    }
    combatant.bossTimers[elapsedKey] = elapsed - interval;
    const rawDamage = Math.max(1, Math.floor(effect.damage ?? combatant.spellDamage ?? combatant.damage ?? 1));
    const element = effect.element || effect.damageElement || 'magic';
    const damage = resolveElementalDamage(rawDamage, element, target);
    target.hp = Math.max(0, target.hp - damage);
    const elementLabel = element !== 'magic' ? ` ${element}` : '';
    log.push(makeEntry(tick, combatant.id, 'ability', `${combatant.name} casts ${effect.name || 'Spell'} for ${damage}${elementLabel} damage.`, damage, hero.hp, combatant.hp, {
      abilityId: effect.id || null,
      abilityType: 'spell_attack',
      element,
      targetId: target.id,
    }));
    break;
  }
}

function applyHazardExplosions(enemies, hero, target, tick, log) {
  for (const hazard of enemies) {
    if (!hazard?.isHazard || hazard.hp <= 0 || tick < (hazard.explodeTick || Infinity)) continue;
    const damage = Math.max(0, Math.floor(hazard.explosionDamage || 30));
    target.hp = Math.max(0, target.hp - damage);
    hazard.hp = 0;
    hazard.exploded = true;
    hazard.activeEffects = [];
    log.push(makeEntry(tick, hazard.id, 'hazard_explosion', `${hazard.name} explodes for ${damage} damage!`, damage, hero.hp, hazard.hp, {
      targetId: target.id,
      addId: hazard.id,
      addSourceId: hazard.sourceId || null,
    }));
  }
}

function applySummonDeathBossPunishments(enemies, livingSummonIds, bossEnemyId, tick, log, hero) {
  const stunnedBossIds = new Set();
  for (const defeated of enemies) {
    if (!defeated?.isSummon || defeated.hp > 0 || defeated.summonKillPunished) continue;
    if (!livingSummonIds.has(defeated.id)) continue;
    const boss = enemies.find(foe => foe.hp > 0 && foe.id === defeated.summonedBy)
      || enemies.find(foe => foe.hp > 0 && foe.id === bossEnemyId);
    defeated.summonKillPunished = true;
    if (!boss || boss.hp <= 0) continue;

    applyStunToCombatant(boss, tick, SUMMON_DEATH_BOSS_STUN_TICKS);
    boss.activeEffects = (boss.activeEffects || [])
      .filter(effect => !(effect.type === DAMAGE_TAKEN_BONUS_EFFECT && effect.source === 'summon_death'));
    boss.activeEffects.push({
      type: DAMAGE_TAKEN_BONUS_EFFECT,
      source: 'summon_death',
      value: SUMMON_DEATH_BOSS_DAMAGE_TAKEN_PCT,
      remainingTicks: SUMMON_DEATH_BOSS_VULNERABLE_TICKS,
    });
    stunnedBossIds.add(boss.id);
    log.push(makeEntry(tick, 'hero', 'add_kill', `${defeated.name} falls. ${boss.name} is stunned and exposed to +${SUMMON_DEATH_BOSS_DAMAGE_TAKEN_PCT}% damage for ${SUMMON_DEATH_BOSS_VULNERABLE_TICKS} seconds.`, 0, hero.hp, boss.hp, {
      targetId: boss.id,
      addId: defeated.id,
      addSourceId: defeated.sourceId || null,
      stunTicks: SUMMON_DEATH_BOSS_STUN_TICKS,
      damageTakenPct: SUMMON_DEATH_BOSS_DAMAGE_TAKEN_PCT,
      durationTicks: SUMMON_DEATH_BOSS_VULNERABLE_TICKS,
    }));
  }
  return stunnedBossIds;
}

function getImpactPriority(action) {
  if (action.ability) return 0;
  if (action.type === ACTION.BASIC_ATTACK) return 1;
  return 2;
}

function removePendingBasicAttacksForActor(queue, actorId) {
  return queue.filter(action => !(action.actorId === actorId && action.type === ACTION.BASIC_ATTACK));
}

function removePendingAbilityCastsForActor(queue, actorId) {
  return queue.filter(action => !(action.actorId === actorId && action.ability));
}

function getEffectDurationTicks(effect, fallbackTicks = 1) {
  const explicitTicks = effect?.durationTicks ?? effect?.stunTicks ?? effect?.ticks;
  if (explicitTicks != null) {
    return Math.max(1, Math.ceil(Number(explicitTicks) || fallbackTicks));
  }
  const seconds = effect?.durationSeconds ?? effect?.stunSeconds;
  if (seconds != null) {
    return Math.max(1, Math.ceil(((Number(seconds) || fallbackTicks) * 1000) / TICK_MS));
  }
  return Math.max(1, Math.ceil(Number(effect?.duration ?? fallbackTicks) || fallbackTicks));
}

function applyStunToCombatant(combatant, tick, durationTicks = 1) {
  if (!combatant) return;
  const stunTicks = Math.max(1, Math.ceil(Number(durationTicks) || 1));
  combatant.stunUntilTick = Math.max(combatant.stunUntilTick ?? -1, tick + stunTicks);
  resetAutoAttackCycle(combatant, tick);
}

function getGroupReviveEffect(combatant) {
  return [
    ...(combatant?.passiveEffects || []),
    ...(combatant?.basePassiveEffects || []),
  ]
    .find(effect => effect?.type === GROUP_REVIVE_EFFECT) || null;
}

function getGroupReviveId(combatant, effect = null) {
  return effect?.group || combatant?.sourceId || combatant?.family || combatant?.id || null;
}

function getGroupReviveDelayTicks(effect) {
  if (effect?.delayTicks != null) return Math.max(1, Math.ceil(Number(effect.delayTicks) || 1));
  if (effect?.delaySeconds != null) return Math.max(1, Math.ceil(((Number(effect.delaySeconds) || 1) * 1000) / TICK_MS));
  return 10;
}

function hasLivingReviveGroupMate(enemies, defeated, effect) {
  const group = getGroupReviveId(defeated, effect);
  if (!group) return false;
  return enemies.some(foe => {
    if (!foe || foe.id === defeated.id || foe.hp <= 0) return false;
    const otherEffect = getGroupReviveEffect(foe);
    return !!otherEffect && getGroupReviveId(foe, otherEffect) === group;
  });
}

function processGroupRevives(enemies, tick, log, hero) {
  for (const foe of enemies) {
    if (!foe || foe.hp > 0 || foe.reviveAtTick == null || foe.reviveAtTick > tick) continue;
    const effect = getGroupReviveEffect(foe);
    if (!effect || !hasLivingReviveGroupMate(enemies, foe, effect)) {
      foe.reviveAtTick = null;
      foe.reviveStartedAtTick = null;
      foe.reviveDelayTicks = null;
      continue;
    }
    const revivePct = Math.max(1, Math.min(100, Number(effect.reviveHpPct ?? 45) || 45));
    const revivedHp = Math.max(1, Math.ceil((foe.maxHp || 1) * revivePct / 100));
    foe.hp = Math.min(foe.maxHp || revivedHp, revivedHp);
    foe.activeEffects = [];
    foe.stunUntilTick = -1;
    foe.reviveAtTick = null;
    foe.reviveStartedAtTick = null;
    foe.reviveDelayTicks = null;
    foe.reviveCount = (foe.reviveCount || 0) + 1;
    clearAutoAttackSchedule(foe);
    log.push(makeEntry(tick, foe.id, 'revive', `${foe.name} reassembles while the pack still stands.`, 0, hero.hp, foe.hp, {
      targetId: foe.id,
      reviveHp: foe.hp,
      reviveGroup: getGroupReviveId(foe, effect),
    }));
  }

  for (const foe of enemies) {
    if (!foe || foe.hp > 0 || foe.reviveAtTick != null) continue;
    const effect = getGroupReviveEffect(foe);
    if (!effect || !hasLivingReviveGroupMate(enemies, foe, effect)) continue;
    const delayTicks = getGroupReviveDelayTicks(effect);
    foe.reviveAtTick = tick + delayTicks;
    foe.reviveStartedAtTick = tick;
    foe.reviveDelayTicks = delayTicks;
    log.push(makeEntry(tick, foe.id, 'revive_pending', `${foe.name}'s bones twitch. Destroy the remaining skeletons within ${delayTicks} seconds or it will rise again.`, 0, hero.hp, foe.hp, {
      targetId: foe.id,
      reviveAtTick: foe.reviveAtTick,
      reviveDelayTicks: delayTicks,
      reviveGroup: getGroupReviveId(foe, effect),
    }));
  }
}

function resetAutoAttackAfterNewStun(combatant, tick, previousStunUntil = -1) {
  if (!combatant || !isStunned(combatant, tick)) return false;
  if ((combatant.stunUntilTick ?? -1) <= previousStunUntil) return false;
  resetAutoAttackCycle(combatant, tick);
  return true;
}

export function initCombat({
  heroName, heroSprite, heroHp, heroMaxHp, heroDamage, heroArmor, enemyObj, enemyObjs = null,
  allies = [],
  heroAbilities = [], heroEffects = [], heroAttackRate = 1, ultimateChargePct = 0,
  heroBlockChance = 0, heroBlockPower = 0, heroBlockPowerRegen = 0, heroCritChance = 0, heroCritMult = 1.75,
  heroCritResist = 0,
  heroHitChanceBonus = 0, heroMagicDefense = 0,
  heroFireResist = 0, heroColdResist = 0, heroLightningResist = 0, heroShadowResist = 0, heroPoisonResist = 0,
  heroWeaponDamageDice = null, heroWeaponDamageMult = 1,
  heroWeaponFamily = null, heroWeaponTags = [], heroAttackType = null, heroOffhandFamily = null,
  heroOffhandRate = 0, heroOffhandDamageMult = 0.5,
  heroInitialRage = 0,
  heroClass = null,
  enemyFrontId = null,
  bossEnemyId = null, bossDeathEndsFight = true, addsDespawnOnBossDeath = true,
  heroProcNodes = [], heroProcOpts = {},
  enemyProcNodes = [], enemyProcOpts = {},
  preferredFrontId = null,
  debugPreventHeroDeath = false,
}) {
  const enemyDefinitions = (Array.isArray(enemyObjs) && enemyObjs.length ? enemyObjs : [enemyObj]).filter(Boolean);
  const enemies = enemyDefinitions.map((entry, index) => createEnemyCombatant(entry, entry.combatantId || (index === 0 ? 'enemy' : `enemy_${index}`)));
  const enemy = enemies[0];
  const allyCombatants = (Array.isArray(allies) ? allies : []).filter(Boolean).map(createAllyCombatant);
  const resolvedEnemyFrontId = getEnemyFrontId(enemies, enemyFrontId) || enemy?.id || null;
  const normalizedHeroWeaponTags = [...(heroWeaponTags || [])];
  const procState = createInitialProcState(heroHp, { ...heroProcOpts, initialRage: heroInitialRage, heroEffects });
  const duelEnemyEffects = enemy?.isDuelPlayer ? (enemy?.passiveEffects || []) : [];
  const opponentHasStonewall = duelEnemyEffects.some(e => e.type === 'first_incoming_guaranteed_block');
  const duelOpponentNeedsProcState = enemy?.isDuelPlayer && (
    (enemyProcOpts?.enchantmentEffects?.length > 0) ||
    (enemyProcOpts?.activeRelics?.length > 0)
  );
  const enemyProcState = ((enemyProcNodes && enemyProcNodes.length) || opponentHasStonewall || duelOpponentNeedsProcState)
    ? createInitialProcState(enemy?.hp || 100, enemy?.isDuelPlayer ? { ...enemyProcOpts, heroEffects: duelEnemyEffects } : enemyProcOpts)
    : null;
  const state = {
    tick: 0,
    phase: PHASE.FIGHTING,
    combatants: {
      hero: createCombatant('hero', true, heroHp, heroMaxHp, heroDamage, heroArmor, heroName, heroAbilities, {
        autoAttackRate: heroAttackRate,
        passiveEffects: heroEffects,
        spellDamageBonus: heroEffects
          .filter(effect => effect.type === 'spell_damage')
          .reduce((sum, effect) => sum + (effect.value || 0), 0),
        spellCooldownReductionOnCast: heroEffects
          .filter(effect => effect.type === 'spell_cooldown_reduction_on_cast')
          .reduce((sum, effect) => sum + (effect.value || 0), 0),
        blockChance: heroBlockChance,
        blockPowerMax: heroBlockPower,
        blockPower: heroBlockPower,
        blockPowerRegen: heroBlockPowerRegen,
        hitChanceBonus: heroHitChanceBonus,
        critChance: heroCritChance,
        critResist: heroCritResist,
        critMult: heroCritMult,
        weaponDamageDice: heroWeaponDamageDice,
        weaponDamageMult: heroWeaponDamageMult,
        magicDefense: heroMagicDefense,
        fireResist: heroFireResist,
        coldResist: heroColdResist,
        lightningResist: heroLightningResist,
        shadowResist: heroShadowResist,
        poisonResist: heroPoisonResist,
        weaponFamily: heroWeaponFamily,
        weaponTags: normalizedHeroWeaponTags,
        attackType: heroAttackType || (normalizedHeroWeaponTags.includes('ranged') ? 'ranged' : null),
        offhandFamily: heroOffhandFamily,
        offhandAutoAttackRate: heroOffhandRate,
        offhandAutoAttackProgressTicks: 0,
        offhandAutoAttackStarted: false,
        offhandLastAutoAttackTick: null,
        offhandNextAutoAttackTick: null,
        offhandDamageMult: heroOffhandDamageMult,
        rageGainFlat: heroEffects
          .filter(effect => effect.type === 'rage_gain_flat')
          .reduce((sum, effect) => sum + (effect.value || 0), 0),
      }),
      enemy,
      enemies,
      allies: allyCombatants,
    },
    // preferredFrontId === 'hero' makes the hero start in front; otherwise the first ally (pet) leads.
    frontId: getFrontId(null, allyCombatants, preferredFrontId === 'hero' ? 'hero' : (allyCombatants[0]?.id || 'hero')),
    enemyFrontId: resolvedEnemyFrontId,
    selectedTargetId: resolvedEnemyFrontId || enemy.id,
    bossEnemyId: bossEnemyId || enemy.id,
    bossDeathEndsFight,
    addsDespawnOnBossDeath,
    actionQueue: createActionQueue(),
    log: [],
    heroConditions: { bleeding: null, poison: null },
    heroWounds: { deepCut: 0 },
    heroResources: getHeroCombatResources(procState.rage, heroClass),
    ultimateChargePct: Math.max(0, Math.min(100, ultimateChargePct || 0)),
    heroProcNodes,
    procState,
    enemyProcNodes,
    enemyProcState,
    heroClass: heroClass || null,
    fleeAttempted: false,
    debugPreventHeroDeath: !!debugPreventHeroDeath,
  };
  applyScarStackArmor(state.combatants.hero, procState);
  applyThresholdEffects(heroProcNodes, procState, state.combatants.hero, enemy, allyCombatants);
  if (enemyProcState) applyThresholdEffects(enemyProcNodes, enemyProcState, state.combatants.enemy, state.combatants.hero, []);
  // Apply enchantment passives that modify combatant stats at fight start (Frost/Earth Ancestral)
  const heroEnch = extractEnchantPassiveValues(procState.enchantmentEffects);
  if (heroEnch.enemyAttackSpeedSlowPct > 0 && enemy) {
    enemy.autoAttackRate = Math.max(0.01, enemy.autoAttackRate * (1 - heroEnch.enemyAttackSpeedSlowPct / 100));
  }
  if (heroEnch.physicalDmgReductionPct > 0) {
    state.combatants.hero.physicalDmgReductionPct = heroEnch.physicalDmgReductionPct;
  }
  if (enemyProcState) {
    const enemyEnch = extractEnchantPassiveValues(enemyProcState.enchantmentEffects);
    if (enemyEnch.enemyAttackSpeedSlowPct > 0) {
      state.combatants.hero.autoAttackRate = Math.max(0.01, state.combatants.hero.autoAttackRate * (1 - enemyEnch.enemyAttackSpeedSlowPct / 100));
    }
    if (enemyEnch.physicalDmgReductionPct > 0) {
      enemy.physicalDmgReductionPct = enemyEnch.physicalDmgReductionPct;
    }
  }
  return state;
}

export function processTick(state, playerAction = ACTION.NONE, rng = Math.random, options = {}) {
  const tick = Math.floor(state.tick || 0) + 1;
  let effectivePlayerAction = playerAction;
  const disableAutoAttacks = !!options.disableAutoAttacks;
  const enemyActions = options.enemyActions || {};
  const sideRngs = resolveSideRngs(rng, options);
  const playerRng = sideRngs.player;
  const enemyRng = sideRngs.enemy;
  const getManualEnemyAction = foe => {
    if (!foe) return undefined;
    if (Object.prototype.hasOwnProperty.call(enemyActions, foe.id)) return enemyActions[foe.id];
    if (foe.id === 'enemy' && Object.prototype.hasOwnProperty.call(enemyActions, 'enemy')) return enemyActions.enemy;
    return undefined;
  };

  const hero = cloneCombatant(state.combatants.hero);
  const heroHpAtTickStart = hero.hp;
  let enemies = getStateEnemies(state.combatants).map(cloneCombatant);
  let allies = getStateAllies(state.combatants).map(cloneCombatant);
  let frontId = getFrontId(hero, allies, state.frontId);
  let frontTarget = getFrontCombatant(hero, allies, frontId);
  let enemyFrontId = getEnemyFrontId(enemies, state.enemyFrontId);
  const livingSummonIdsAtTickStart = new Set(enemies
    .filter(foe => foe.isSummon && foe.hp > 0 && !foe.summonKillPunished)
    .map(foe => foe.id));
  let enemy = getLivingEnemy(enemies, state.selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
  let selectedTargetId = enemy?.id || state.selectedTargetId || null;
  const heroConditions = {
    bleeding: state.heroConditions?.bleeding ? { ...state.heroConditions.bleeding } : null,
    poison: state.heroConditions?.poison ? { ...state.heroConditions.poison } : null,
  };
  const heroWounds = {
    deepCut: state.heroWounds?.deepCut || 0,
  };
  const heroResources = Object.fromEntries(
    Object.entries(state.heroResources || {}).map(([key, resource]) => [key, { ...resource }]),
  );
  const heroProcNodes = state.heroProcNodes || [];
  const procState = state.procState ? { ...state.procState, onceFiredIds: [...(state.procState.onceFiredIds || [])] } : createInitialProcState(hero.hp);
  const enemyProcNodes = state.enemyProcNodes || [];
  const enemyProcState = state.enemyProcState ? { ...state.enemyProcState, onceFiredIds: [...(state.enemyProcState.onceFiredIds || [])] } : null;
  // In duel mode a separate proc RNG is provided so proc chance-rolls don't
  // consume from the shared combat RNG (which must stay in sync on both screens).
  const procRngBySide = options.procRngBySide || {};
  if (typeof procRngBySide.player === 'function' && !procState.procRng) {
    procState.procRng = procRngBySide.player;
  }
  if (typeof procRngBySide.enemy === 'function' && enemyProcState && !enemyProcState.procRng) {
    enemyProcState.procRng = procRngBySide.enemy;
  }
  // Capture the enemy proc RNG even when enemyProcState is null (opponent has no proc nodes).
  // Without this, resolveBasicAttackImpact falls back to hero's procRng for enemy on-hit rolls,
  // causing divergence between the two clients because each client's "hero" uses a different seed.
  const rawEnemyProcRng = typeof procRngBySide.enemy === 'function' ? procRngBySide.enemy : null;
  syncHeroCombatResources(heroResources, procState);
  procState.parryCountThisTick = 0;
  procState.heroAttackedThisTick = false;
  let queue = [...state.actionQueue];
  const log = [...state.log];
  const punishDeadSummons = () => {
    const stunnedBossIds = applySummonDeathBossPunishments(enemies, livingSummonIdsAtTickStart, state.bossEnemyId || 'enemy', tick, log, hero);
    for (const actorId of stunnedBossIds) {
      queue = removePendingBasicAttacksForActor(queue, actorId);
      queue = removePendingAbilityCastsForActor(queue, actorId);
    }
  };

  let fleeAttempted = !!state.fleeAttempted;
  if (effectivePlayerAction === ACTION.FLEE) {
    if (fleeAttempted) {
      log.push(makeEntry(tick, 'hero', 'flee', 'Already attempted to flee.', 0, hero.hp, enemy?.hp));
      effectivePlayerAction = ACTION.NONE;
    } else {
      fleeAttempted = true;
      const fleeContext = options.fleeContext || {};
      const itemName = fleeContext.itemName || null;
      const finalChance = Math.max(0, Math.min(100, Math.floor(Number(fleeContext.chancePct ?? 30))));
      const escaped = playerRng() * 100 < finalChance;
      if (itemName) {
        log.push(makeEntry(tick, 'hero', 'item', `${itemName} consumed. Inventory updated.`, 0, hero.hp, enemy?.hp, {
          itemId: fleeContext.itemId || null,
          fleeChance: finalChance,
        }));
      }
      log.push(makeEntry(
        tick,
        'hero',
        'flee',
        escaped
          ? (itemName ? `You threw a ${itemName} and escaped under cover!` : 'You slipped away and escaped!')
          : (itemName ? `You threw a ${itemName} — but the enemy pushed through! Flee failed.` : `You failed to escape! (${finalChance}% chance)`),
        0,
        hero.hp,
        enemy?.hp,
        {
          itemId: fleeContext.itemId || null,
          itemName,
          fleeChance: finalChance,
          fleeSuccess: escaped,
        },
      ));
      if (escaped) {
        return {
          ...state,
          tick,
          phase: PHASE.FLED,
          combatants: buildCombatants(hero, enemies, allies),
          frontId,
          enemyFrontId,
          selectedTargetId,
          actionQueue: [],
          log,
          heroConditions,
          heroWounds,
          heroResources: syncHeroCombatResources(heroResources, procState),
          ultimateChargePct: Math.max(0, Math.min(100, state.ultimateChargePct || 0)),
          fleeAttempted,
        };
      }
      effectivePlayerAction = ACTION.NONE;
    }
  }

  applyScarStackArmor(hero, procState);
  if ('energy' in heroResources) {
    procState.energy = Math.min(HERO_ENERGY_MAX, (procState.energy || 0) + HERO_ENERGY_PER_TICK);
  } else {
    const rageIdleTicks = tick - (procState.lastRageActivityTick ?? 0);
    const heroIsCasting = isCasting(queue, 'hero', tick);
    const heroAutoProgressing = isAutoAttackBarProgressing(hero, tick);
    const canDecayRage = effectivePlayerAction === ACTION.NONE
      && procState.rage > 0
      && !heroIsCasting
      && !heroAutoProgressing
      && rageIdleTicks > HERO_RAGE_INACTIVITY_GRACE_TICKS;
    if (canDecayRage) {
      procState.rage = Math.max(0, procState.rage - HERO_RAGE_DECAY_PER_IDLE_TICK);
    }
  }
  // Tick flow state duration
  if ((procState.flowStateTicks || 0) > 0) {
    procState.flowStateTicks -= 1;
    if (procState.flowStateTicks === 0) {
      // Flow State expired — splash hit
      if (enemy && enemy.hp > 0 && hero.hp > 0) {
        const splashRaw = Math.max(1, Math.floor((hero.damage || 0) * 1.5));
        const splashDmg = applyArmor(splashRaw, getEffectiveArmor(enemy), 0);
        enemy.hp = Math.max(0, enemy.hp - splashDmg);
        log.push(makeEntry(tick, 'hero', 'hit', `Flow State expires — final slash: ${splashDmg}!`, splashDmg, hero.hp, enemy.hp, {}));
      }
    }
  }
  if (tick === 1 && (procState.momentumCarry || 0) > 0) {
    procState.momentumStacks = Math.min(getMomentumMax(heroProcNodes, hero), Math.max(procState.momentumStacks || 0, procState.momentumCarry));
    procState.momentumCarry = 0;
  }
  updateMomentumMaxHeld(heroProcNodes, procState, hero, enemy, tick, log, playerRng);
  // Apply threshold-based passive effects to hero
  applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
  // Apply threshold-based passive effects to duel enemy
  if (enemyProcState && enemy?.isDuelPlayer) {
    applyThresholdEffects(enemyProcNodes, enemyProcState, enemy, hero, []);
  }
  // Fire on_combat_start on tick 1
  if (tick === 1) {
    fireProcTrigger('on_combat_start', {}, procState, heroProcNodes, hero, enemy, tick, log, playerRng);
    if (enemyProcState && enemy?.isDuelPlayer) {
      fireProcTrigger('on_combat_start', {}, enemyProcState, enemyProcNodes, enemy, hero, tick, log, enemyRng);
    }
    // Apply bleed carry from last fight
    if ((procState.bleedCarry || 0) > 0 && enemy && enemy.hp > 0) {
      for (let i = 0; i < procState.bleedCarry; i++) applyEnemyBleed(enemy, tick, log, hero, procState);
      log.push(makeEntry(tick, 'hero', 'bleed', `Relentless Wounds: ${procState.bleedCarry} Bleed carried in.`, 0, hero.hp, enemy.hp, {}));
      procState.bleedCarry = 0;
    }
    // Apply shadow mark carry (Mark Mastery talent)
    const shadowMarkCarryVal = (hero.passiveEffects || []).reduce((sum, e) => e.type === 'carry_shadow_marks' ? sum + (e.value || 0) : sum, 0);
    if (shadowMarkCarryVal > 0 && enemy && enemy.hp > 0) {
      applyProcEffect({ type: 'apply_shadow_mark', stacks: shadowMarkCarryVal, maxStacks: 5 }, { trigger: 'combat_start' }, procState, heroProcNodes, hero, enemy, tick, log, playerRng);
    }
  }
  tickActiveEffects(hero, tick, log, { procState, heroProcNodes, hero, allies, enemy, rng: playerRng });
  for (const ally of allies) tickActiveEffects(ally, tick, log);
  for (const foe of enemies) tickActiveEffects(foe, tick, log, { procState, heroProcNodes, hero: hero, allies, enemy: foe, rng: enemyRng });
  applyPetDeathSaves(hero, allies, procState, tick, log);
  applyPetLowHpGuards(hero, allies, procState, tick, log);
  const rpWasActive = !!(procState.relentlessPressureActive);
  applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
  const rpIsNowActive = (hero.passiveEffects || []).some(e => e.source === RELENTLESS_PRESSURE_SOURCE);
  procState.relentlessPressureActive = rpIsNowActive;
  if (rpIsNowActive && !rpWasActive) {
    const rpDef = (hero.basePassiveEffects || hero.passiveEffects || []).find(e => e.type === 'relentless_pressure');
    const spd = rpDef?.heroAttackSpeedPct || rpDef?.value || 0;
    log.push(makeEntry(tick, 'hero', 'proc', `Relentless Pressure: +${spd}% attack speed (enemy bleeding/poisoned).`, 0, hero.hp, enemy?.hp ?? null, { source: RELENTLESS_PRESSURE_SOURCE }));
  } else if (!rpIsNowActive && rpWasActive) {
    log.push(makeEntry(tick, 'hero', 'proc', `Relentless Pressure fades.`, 0, hero.hp, enemy?.hp ?? null, { source: RELENTLESS_PRESSURE_SOURCE }));
  }
  regenerateBlockPower(hero);
  for (const ally of allies) regenerateBlockPower(ally);
  for (const foe of enemies) regenerateBlockPower(foe);
  applyPassiveTickEffects(hero, tick, log);
  for (const ally of allies) applyPassiveTickEffects(ally, tick, log);
  for (const foe of enemies) applyPassiveTickEffects(foe, tick, log);
  // Apply relic per-tick effects (hp_regen_in_combat etc.)
  applyRelicTickEffectsForHeroTick(hero, allies, procState, tick, log);
  // Shadow mark tick damage (Deep Marks talent)
  const markTickPct = (hero.passiveEffects || []).reduce((sum, e) => e.type === 'shadow_mark_tick_damage_pct' ? sum + (e.valuePerMark || 0) : sum, 0);
  if (markTickPct > 0) {
    for (const foe of enemies) {
      if (foe.hp <= 0) continue;
      const markEff = (foe.activeEffects || []).find(e => e.type === 'shadow_mark');
      const markStacks = markEff?.stacks || 0;
      if (markStacks <= 0) continue;
      const dmg = Math.max(1, Math.floor(hero.damage * markTickPct * markStacks / 100));
      foe.hp = Math.max(0, foe.hp - dmg);
      log.push(makeEntry(tick, 'hero', 'proc', `Deep Marks: ${dmg} shadow damage (${markStacks} mark${markStacks !== 1 ? 's' : ''}).`, dmg, hero.hp, foe.hp, { targetId: foe.id }));
    }
  }
  processGroupRevives(enemies, tick, log, hero);
  applyPetRageAttackSpeed(hero, allies, procState, tick, log);
  applySummonAuras(enemies);
  frontId = getFrontId(hero, allies, frontId);
  if (effectivePlayerAction === ACTION.SWAP_FRONT) {
    queue = startFrontSwapCast(hero, allies, frontId, tick, log, queue);
  }
  frontTarget = getFrontCombatant(hero, allies, frontId);
  const playerSideSwapCasting = hasActiveFrontSwapCast(queue, tick);
  punishDeadSummons();
  for (const foe of enemies) applyBossPhaseState(foe, tick, log, hero.hp);
  ({ enemies, queue } = applyPillarIntermissions(enemies, queue, tick, log, hero));
  for (const foe of enemies) {
    if (isEnemyUntargetable(foe)) continue;
    applyTimedBossSpells(foe, tick, log, hero, frontTarget);
  }
  applyPetDeathSaves(hero, allies, procState, tick, log);
  applyPetLowHpGuards(hero, allies, procState, tick, log);
  applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
  frontId = getFrontId(hero, allies, frontId);
  frontTarget = getFrontCombatant(hero, allies, frontId);
  for (const foe of [...enemies]) {
    if (isEnemyUntargetable(foe)) continue;
    enemies = applyPhaseSummons(foe, enemies, tick, log, enemyRng, hero);
  }
  for (const foe of [...enemies]) {
    if (isEnemyUntargetable(foe)) continue;
    queue = applyPhaseCasts(foe, enemies, queue, tick, log, enemyRng, hero, frontTarget);
  }
  ({ enemies, queue } = applyPillarIntermissions(enemies, queue, tick, log, hero));
  applySummonAuras(enemies);
  enemyFrontId = getEnemyFrontId(enemies, enemyFrontId);
  enemy = getLivingEnemy(enemies, selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
  selectedTargetId = enemy?.id || selectedTargetId;

  const heroAction = effectivePlayerAction === ACTION.SWAP_FRONT ? ACTION.NONE : resolveCombatAction(hero, effectivePlayerAction, tick);
  queue = applyAction(hero, heroAction, tick, queue, log, playerRng, heroResources, enemy, procState, { frontId, enemyFrontId, allies, hero, disableAutoAttacks, enemyProcNodes, enemyProcState });

  for (const foe of enemies) {
    if (foe.hp <= 0) continue;
    if (isEnemyUntargetable(foe)) continue;
    const manualAction = getManualEnemyAction(foe);
    const manualActionPayload = manualAction && typeof manualAction === 'object'
      ? manualAction
      : (manualAction !== undefined ? { action: manualAction } : null);
    const requestedAction = manualActionPayload
      ? manualActionPayload.action
      : (options.disableEnemyAi && foe.isDuelPlayer ? ACTION.NONE : aiDecide(foe, tick, enemyRng));
    if (requestedAction === ACTION.SWAP_FRONT && foe.id === 'enemy') {
      queue = startEnemyFrontSwapCast(foe, enemies, enemyFrontId, tick, log, queue);
      continue;
    }
    const enemyAction = resolveCombatAction(foe, requestedAction, tick);
    const manualTarget = manualActionPayload?.targetId
      ? getCombatantById(hero, enemies, manualActionPayload.targetId, allies)
      : null;
    const defenderForAction = manualTarget?.hp > 0 ? manualTarget : frontTarget;
    const enemyAllies = enemies.filter(entry => entry.id !== foe.id && entry.isDuelCompanion);
    const foeProcState = foe.isDuelPlayer ? enemyProcState : null;
    queue = applyAction(foe, enemyAction, tick, queue, log, enemyRng, heroResources, defenderForAction, foeProcState, { frontId, enemyFrontId, allies, hero, enemyAllies, disableAutoAttacks, enemyProcNodes: foe.isDuelPlayer ? enemyProcNodes : [], enemyProcState: foeProcState });
  }

  for (const ally of allies) {
    if (ally.hp <= 0) continue;
    if (playerSideSwapCasting) continue;
    const allyTarget = getLivingEnemy(enemies, selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
    if (!allyTarget || allyTarget.hp <= 0) continue;
    const allyAction = resolveCombatAction(ally, aiDecide(ally, tick, playerRng), tick);
    queue = applyAction(ally, allyAction, tick, queue, log, playerRng, {}, allyTarget, null, { frontId, enemyFrontId, allies, hero, disableAutoAttacks });
  }

  for (const action of queue) {
    if (!action.ability || !action.projectileTravelTicks || action.projectileLaunchTick !== tick || action.impactTick <= tick) continue;
    const caster = getCombatantById(hero, enemies, action.actorId, allies);
    if (!caster) continue;
    const target = getCombatantById(hero, enemies, action.targetId, allies) || (caster.team === 'player' ? enemy : frontTarget);
    const logEnemy = caster.team === 'player' ? target : caster;
    const text = action.actorId === 'hero'
      ? `${action.ability.name} launches toward ${target?.name || 'the enemy'}.`
      : `${caster.name}'s ${action.ability.name} launches.`;
    log.push(makeEntry(tick, caster.id, 'ability_projectile', text, 0, hero.hp, logEnemy?.hp, {
      abilityId: action.ability?.id || null,
      abilityType: action.ability?.type || null,
      targetId: target?.id || null,
    }));
  }

  const impactActions = getImpactsAtTick(queue, tick)
    .slice()
    .sort((a, b) => getImpactPriority(a) - getImpactPriority(b));
  for (const action of impactActions) {
    if (!queue.some(queuedAction => queuedAction.id === action.id)) continue;
    const attacker = getCombatantById(hero, enemies, action.actorId, allies);
    const actionRng = rngForCombatant(attacker, sideRngs);
    const attackerIsPlayerSide = attacker?.team === 'player' || action.actorId === 'hero';
    const actionTarget = getCombatantById(hero, enemies, action.targetId, allies);
    const defender = !attackerIsPlayerSide && action.type === ACTION.BASIC_ATTACK
      ? (actionTarget?.hp > 0 ? actionTarget : frontTarget)
      : actionTarget || (attackerIsPlayerSide ? enemy : frontTarget);
    const logEnemy = attackerIsPlayerSide ? defender : attacker;

    if (!attacker || !defender) continue;
    // Duel players commit their attack at tick start (lockstep); allow it to land
    // even if they were killed by the opponent's earlier action this same tick.
    if (attacker.hp <= 0 && !attacker.isDuelPlayer) continue;
    // Same symmetry for the defender: a dead duel player can still receive a
    // committed hit from this tick so both clients compute the same damage totals.
    if (!defender.isPlayer && !defender.isDuelPlayer && defender.hp <= 0) continue;
    if (!defender.isPlayer && isEnemyUntargetable(defender)) continue;

    if (isStunned(attacker, tick)) continue;

    if (action.ability) {
      startAbilityCooldown(attacker, action.ability, tick);
      if (action.ability.type === 'front_swap') {
        if (action.enemyFrontSwap) {
          const previousEnemyFrontId = enemyFrontId;
          enemyFrontId = completeEnemyFrontSwap(enemies, enemyFrontId, action.nextEnemyFrontId || action.targetId, tick, log);
          if (!selectedTargetId || selectedTargetId === previousEnemyFrontId) selectedTargetId = enemyFrontId;
          enemy = getLivingEnemy(enemies, selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
          queue = removePendingBasicAttacksForActor(queue, attacker.id);
        } else {
          frontId = completeFrontSwap(hero, allies, frontId, action.nextFrontId || action.targetId, tick, log);
          frontTarget = getFrontCombatant(hero, allies, frontId);
          queue = removePendingBasicAttacksForPlayerSide(queue, allies);
        }
        continue;
      }
      const missSpellChance = getActiveEffectTotal(attacker, 'daze', 'missSpellChance');
      if (missSpellChance > 0 && actionRng() * 100 < missSpellChance) {
        const text = action.actorId === 'hero'
          ? `${action.ability.name} fizzles - you are dazed.`
          : `${attacker.name} loses ${action.ability.name} while dazed.`;
        log.push(makeEntry(tick, attacker.id, 'daze', text, 0, hero.hp, logEnemy?.hp, {
          abilityId: action.ability?.id || null,
          abilityType: action.ability?.type || null,
          targetId: defender.id,
        }));
        continue;
      }
      if (tryMissHitChanceAbility(action, attacker, defender, tick, log, actionRng, hero, logEnemy, procState, heroProcNodes, { allies })) {
        continue;
      }
      if (attacker.id === 'hero' && procState && !isAllyTargetAbility(action.ability) && action.ability?.target !== 'self') {
        procState.heroAttackedThisTick = true;
        procState.sniperPatiencePct = 0;
      }

      if (action.ability?.type === 'summon_add') {
        const summonEffect = action.ability.summonEffect || action.ability.phaseEffect || action.ability;
        const existingEnemyIds = new Set(enemies.map(entry => entry.id));
        enemies = summonAdd(attacker, summonEffect, enemies, tick, log, hero);
        const summoned = enemies.filter(entry => !existingEnemyIds.has(entry.id));
        if (summoned.length > 0 && summonEffect.followupAbility) {
          const enemySideAllies = getEnemySideAllies(enemies, attacker);
          const followupEntries = resolveAbilityImpact(
            { ability: summonEffect.followupAbility },
            attacker,
            attacker,
            tick,
            actionRng,
            {
              heroConditions,
              allies: enemySideAllies,
              playerAllies: allies,
              enemyAllies: enemySideAllies,
              procState,
              heroProcNodes,
              hero,
              enemy: attacker,
            }
          );
          appendAbilityEntries(log, followupEntries, tick, attacker, attacker, hero, attacker, summonEffect.followupAbility);
        }
        enemyFrontId = getEnemyFrontId(enemies, enemyFrontId);
        enemy = getLivingEnemy(enemies, selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
        continue;
      }

      if (action.ability?.type === 'summon_hazard') {
        enemies = summonHazard(attacker, action.ability.summonEffect || action.ability.phaseEffect || action.ability, enemies, tick, log, hero);
        enemyFrontId = getEnemyFrontId(enemies, enemyFrontId);
        enemy = getLivingEnemy(enemies, selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
        continue;
      }

      const defenderHpBeforeAbility = defender.hp;
      const defenderShieldBeforeAbility = getDamageShieldHp(defender);
      const targetFrontDamageMult = action.ability?.ignoreTargetFrontPenalty
        ? 1
        : action.targetFrontDamageMult ?? getTargetFrontDamageMult(attacker, defender, { frontId, enemyFrontId });
      const originalDamage = attacker.damage;
      const originalBaseDamage = attacker.baseDamage;
      const originalSpellDamage = attacker.spellDamage;
      if (targetFrontDamageMult < 1) {
        attacker.damage = Math.max(0, Math.floor((attacker.damage || 0) * targetFrontDamageMult));
        if (Number.isFinite(attacker.baseDamage)) attacker.baseDamage = Math.max(0, Math.floor(attacker.baseDamage * targetFrontDamageMult));
        if (Number.isFinite(attacker.spellDamage)) attacker.spellDamage = Math.max(0, Math.floor(attacker.spellDamage * targetFrontDamageMult));
      }
      const enemySideAllies = getEnemySideAllies(enemies, attacker);
      const abilityAllies = attackerIsPlayerSide
        ? allies
        : enemySideAllies;
      let entries = [];
      try {
        entries = resolveAbilityImpact(action, attacker, defender, tick, actionRng, {
          heroConditions,
          allies: abilityAllies,
          playerAllies: allies,
          enemyAllies: enemySideAllies,
          procState,
          heroProcNodes,
          hero,
          enemy: logEnemy,
        });
      } finally {
        attacker.damage = originalDamage;
        attacker.baseDamage = originalBaseDamage;
        attacker.spellDamage = originalSpellDamage;
      }
      const defenderShieldAfterAbility = getDamageShieldHp(defender);
      const shieldHandledByAbility = defenderShieldAfterAbility < defenderShieldBeforeAbility;
      let abilityDamageDealt = Math.max(0, defenderHpBeforeAbility - defender.hp);
      if (!shieldHandledByAbility && abilityDamageDealt > 0) {
        const shielded = absorbDamageShield(defender, abilityDamageDealt);
        if (shielded.absorbed > 0) {
          defender.hp = Math.min(defenderHpBeforeAbility, defender.hp + shielded.absorbed);
          abilityDamageDealt = Math.max(0, defenderHpBeforeAbility - defender.hp);
          logDamageShieldAbsorb(defender, shielded, tick, log, hero, logEnemy, {
            abilityId: action.ability?.id || null,
            abilityType: action.ability?.type || null,
          });
        }
      }
      for (const e of entries) {
        appendAbilityEntries(log, [e], tick, attacker, defender, hero, logEnemy, action.ability, {
          targetFrontPenalty: targetFrontDamageMult < 1,
          targetFrontDamageMult,
        });
        if (attacker.id === 'hero' && e.isCrit) grantCombatTrigger(hero, 'after_crit');
        if (attacker.id === 'hero') recordHeroCritLanded(procState, e, e.damage || 0);
        if (e.type === 'blocked') grantCombatTrigger(defender, 'after_block');
      }
      if (abilityDamageDealt > 0) {
        applyCombatantStateHitReaction(attacker, defender, tick, log, hero, logEnemy, procState);
        trackPetFlankingHit(attacker, hero, procState, tick, log, logEnemy);
        grantHeroCritFromAllyAbility(action, attacker, hero, tick, log, logEnemy, abilityDamageDealt);
        grantHeroCritFromPetHit(attacker, hero, tick, log, logEnemy, abilityDamageDealt);
        grantHeroRageFromPetHit(attacker, hero, procState, abilityDamageDealt, true);
      }
      if (abilityDamageDealt > 0 && defender.isPlayer && !attackerIsPlayerSide && procState) {
        const abilityCrit = entries.some(entry => entry.isCrit);
        procState.hasTakenDamageThisFight = true;
        procState.consecutiveBlocks = 0;
        gainRageOnTakingHit(procState, abilityDamageDealt, tick);
        fireProcTrigger('on_take_damage', { damage: abilityDamageDealt, isCrit: abilityCrit, attacker }, procState, heroProcNodes, hero, enemy, tick, log, actionRng);
        if (abilityCrit) {
          fireProcTrigger('on_take_crit', { damage: abilityDamageDealt, attacker }, procState, heroProcNodes, hero, enemy, tick, log, actionRng);
        }
        maybeFireHpCrossBelowProcs(defenderHpBeforeAbility, hero, procState, heroProcNodes, enemy, tick, log, actionRng);
        preventDeathWithLastBreath(hero, tick, log, enemy, procState);
        syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, allies);
      }
      const abilityDamageTakenBonus = getDamageTakenBonusPct(defender, attacker);
      if (abilityDamageTakenBonus > 0 && abilityDamageDealt > 0 && defender.hp > 0) {
        const exposedDamage = Math.max(1, Math.floor(abilityDamageDealt * abilityDamageTakenBonus / 100));
        defender.hp = Math.max(0, defender.hp - exposedDamage);
        log.push(makeEntry(tick, attacker.id, 'hit', `Exposed: ${defender.name} takes ${exposedDamage} bonus damage.`, exposedDamage, hero.hp, logEnemy?.hp, {
          targetId: defender.id,
          exposedBonus: true,
          damageTakenPct: abilityDamageTakenBonus,
        }));
      }
      if (entries.some(e => e.type === 'stun') && isStunned(defender, tick)) {
        resetAutoAttackCycle(defender, tick);
        queue = removePendingBasicAttacksForActor(queue, defender.id);
        queue = removePendingAbilityCastsForActor(queue, defender.id);
      }
      if (action.ability?.type === 'serrated_strikes' && attacker.hp > 0 && defender.hp > 0) {
        attacker.autoAttackStarted = true;
        const immediateAttack = createBasicAttackImpact(attacker, defender, tick, actionRng, ACTION.BASIC_ATTACK, { frontId, enemyFrontId, procState });
        if (resolveBasicAttackImpact(immediateAttack, attacker, defender, tick, log, actionRng, hero, logEnemy, heroResources, heroConditions, heroWounds, procState, heroProcNodes, { frontId, enemyFrontId, allies, enemyProcNodes, enemyProcState, enemyProcRng: rawEnemyProcRng })) {
          queue = removePendingBasicAttacksForActor(queue, defender.id);
        }
        attacker.autoAttackProgressTicks = Math.min(
          AUTO_ATTACK_TICKS - 1,
          (attacker.autoAttackProgressTicks || 0) + Math.max(0, action.ability?.castTicks || 0),
        );
        attacker.lastAutoAttackTick = tick;
        const remainingAutoProgress = Math.max(0, AUTO_ATTACK_TICKS - (attacker.autoAttackProgressTicks || 0));
        attacker.nextAutoAttackTick = tick + getAutoAttackDelayTicks(remainingAutoProgress, getEffectiveAutoAttackRate(attacker));
      }
      if (['sword_stance', 'heavy_strikes', 'berserker_stance', 'mace_mastery', 'rapid_fire'].includes(action.ability?.type) && attacker.hp > 0 && defender.hp > 0) {
        const attackCount = getReadyAutoAttackCount(attacker, tick);
        for (let attackIndex = 0; attackIndex < attackCount; attackIndex += 1) {
          const immediateAttack = createBasicAttackImpact(attacker, defender, tick, actionRng, ACTION.BASIC_ATTACK, { frontId, enemyFrontId, procState });
          if (resolveBasicAttackImpact(immediateAttack, attacker, defender, tick, log, actionRng, hero, logEnemy, heroResources, heroConditions, heroWounds, procState, heroProcNodes, { frontId, enemyFrontId, allies, enemyProcNodes, enemyProcState, enemyProcRng: rawEnemyProcRng })) {
            queue = removePendingBasicAttacksForActor(queue, defender.id);
          }
          if (defender.hp <= 0) break;
        }
      }
    } else {
      if (resolveBasicAttackImpact(action, attacker, defender, tick, log, actionRng, hero, logEnemy, heroResources, heroConditions, heroWounds, procState, heroProcNodes, { frontId, enemyFrontId, allies, enemyProcNodes, enemyProcState, enemyProcRng: rawEnemyProcRng })) {
        queue = removePendingBasicAttacksForActor(queue, defender.id);
      }
    }
    applyPetDeathSaves(hero, allies, procState, tick, log);
    applyPetLowHpGuards(hero, allies, procState, tick, log);
    applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
    if (enemyProcState && enemy?.isDuelPlayer) applyThresholdEffects(enemyProcNodes, enemyProcState, enemy, hero, []);
    frontId = getFrontId(hero, allies, frontId);
    frontTarget = getFrontCombatant(hero, allies, frontId);
    punishDeadSummons();
  }

  frontId = getFrontId(hero, allies, frontId);
  frontTarget = getFrontCombatant(hero, allies, frontId);
  enemyFrontId = getEnemyFrontId(enemies, enemyFrontId);
  applyHazardExplosions(enemies, hero, frontTarget, tick, log);
  processGroupRevives(enemies, tick, log, hero);
  ({ enemies, queue } = applyPillarIntermissions(enemies, queue, tick, log, hero));
  applyPetDeathSaves(hero, allies, procState, tick, log);
  applyPetLowHpGuards(hero, allies, procState, tick, log);
  applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
  frontId = getFrontId(hero, allies, frontId);
  enemyFrontId = getEnemyFrontId(enemies, enemyFrontId);

  queue = removePastActions(queue, tick);

  hero.isCasting = isCasting(queue, 'hero', tick);
  for (const ally of allies) {
    ally.isCasting = isCasting(queue, ally.id, tick);
  }
  for (const foe of enemies) {
    foe.isCasting = isCasting(queue, foe.id, tick);
  }

  // Cocoon transformation: intercept first death for bosses with hasCocoonTransform
  for (const foe of enemies) {
    if (foe.hp <= 0 && foe.hasCocoonTransform && !foe.hasTransformed) {
      const cocoonHp = foe.phase2MaxHp || foe.cocoonMaxHp || 400;
      foe.hp = cocoonHp;
      foe.maxHp = cocoonHp;
      foe.inCocoon = true;
      foe.hasTransformed = true;
      foe.cocoonStartTick = tick;
      foe.cocoonDamageTaken = 0;
      foe.disableAutoAttack = true;
      if (foe.cocoonSprite) {
        foe._originalSprite = foe.sprite;
        foe.sprite = foe.cocoonSprite;
      }
      log.push(makeEntry(tick, foe.id, 'phase_change',
        `${foe.name} seals herself in a hardened cocoon! (${cocoonHp} HP — 90% damage resistance)`,
        0, hero.hp, cocoonHp, { phase: 'cocoon', targetId: foe.id }));
    }
    // Guard HP during cocoon: prevent premature boss death (applyCombatantDamage handles 95% resistance)
    if (foe.inCocoon && foe.hp < 1) {
      foe.hp = 1;
    }
    // Stun during cocoon delays emergence by pushing the start tick forward
    if (foe.inCocoon && isStunned(foe, tick)) {
      foe.cocoonStartTick = (foe.cocoonStartTick || 0) + 1;
    }
    // Cocoon exit after duration — boss emerges with current cocoon HP (damage dealt carries over)
    if (foe.inCocoon && tick >= (foe.cocoonStartTick || 0) + (foe.cocoonDurationTicks || 4)) {
      const p2MaxHp = foe.phase2MaxHp || foe.maxHp;
      foe.maxHp = p2MaxHp;
      if (foe.phase2Attack != null) {
        foe.damage = scaleMonsterAttack(foe.phase2Attack);
        foe.baseDamage = foe.damage;
      }
      if (foe.phase2Armor != null) {
        foe.armor = scaleMonsterArmor(foe.phase2Armor);
        foe.baseArmor = foe.armor;
      }
      if (foe.phase2AttackSpeed != null) {
        foe.autoAttackRate = foe.phase2AttackSpeed;
        foe.baseAutoAttackRate = foe.autoAttackRate;
      }
      if (foe.phase2SpellDamage != null) {
        foe.spellDamage = foe.phase2SpellDamage;
        foe.baseSpellDamage = foe.spellDamage;
      }
      if (Array.isArray(foe.phase2Abilities)) {
        foe.abilities = scaleMonsterAbilities(foe.phase2Abilities);
      }
      foe.inCocoon = false;
      foe.disableAutoAttack = !!foe._baseDisableAutoAttack;
      foe.activePhaseId = 'phase2';
      if (foe._originalSprite) {
        foe.sprite = foe._originalSprite;
        foe._originalSprite = null;
      }
      log.push(makeEntry(tick, foe.id, 'phase_change',
        `The cocoon shatters! ${foe.name} emerges reborn — Phase 2! (${foe.hp}/${p2MaxHp} HP)`,
        0, hero.hp, foe.hp, { phase: 'phase2', targetId: foe.id }));
    }
  }
  // Brood Devour: surviving tagged summons heal their boss after devourAtTick
  for (const summon of enemies) {
    if (!summon.isSummon || !summon.devourAtTick || summon.hp <= 0) continue;
    if (tick < summon.devourAtTick) continue;
    const bossForDevour = enemies.find(b => b.id === summon.devourBossId && b.hp > 0);
    const healPct = summon.devourHealPct || 7;
    if (bossForDevour) {
      const healAmt = Math.floor(bossForDevour.maxHp * healPct / 100);
      bossForDevour.hp = Math.min(bossForDevour.maxHp, bossForDevour.hp + healAmt);
      log.push(makeEntry(tick, bossForDevour.id, 'heal',
        `${bossForDevour.name} devours ${summon.name}, recovering ${healAmt} HP!`,
        0, hero.hp, bossForDevour.hp, { targetId: bossForDevour.id }));
    }
    summon.hp = 0;
    summon.devourAtTick = null;
    log.push(makeEntry(tick, summon.id, 'death',
      `${summon.name} is devoured by ${bossForDevour?.name || 'the Broodmother'}!`,
      0, hero.hp, bossForDevour?.hp ?? 0));
  }

  let phase = state.phase;
  const boss = enemies.find(foe => foe.id === (state.bossEnemyId || 'enemy')) || enemies[0] || null;
  for (const fallen of enemies) {
    if (fallen.hp > 0 || fallen._bondTriggered || !fallen.bond) continue;
    fallen._bondTriggered = true;
    for (const survivor of enemies) {
      if (survivor.hp <= 0 || survivor.id === fallen.id || survivor.bond !== fallen.bond) continue;
      survivor.activeEffects = survivor.activeEffects || [];
      survivor.activeEffects.push({
        type: 'damage_bonus_pct_buff',
        value: 50,
        remainingTicks: 99999,
        source: 'bond_survivor',
      });
      log.push(makeEntry(tick, survivor.id, 'ability',
        `${survivor.name} is enraged by a fallen ally! +50% damage!`,
        0, hero.hp, survivor.hp, { abilityType: 'bond' }));
    }
  }
  for (const foe of enemies) {
    if (foe.hp <= 0 && !foe.despawned) preventDeathWithLastBreath(foe, tick, log, hero);
  }
  const bossDead = !!boss && state.bossDeathEndsFight !== false && boss.hp <= 0;
  const allEnemiesDead = enemies.length > 0 && enemies.every(foe => foe.hp <= 0);
  if (state.debugPreventHeroDeath && hero.hp <= 0 && !bossDead && !allEnemiesDead) {
    hero.hp = 1;
    log.push(makeEntry(tick, 'hero', 'death_save', 'Testing safeguard keeps you at 1 HP.', 0, hero.hp, enemy?.hp, {
      debugPreventHeroDeath: true,
    }));
  }
  if (bossDead && state.addsDespawnOnBossDeath !== false) {
    enemies = enemies.map(foe => foe.id === boss.id ? foe : { ...foe, hp: 0, despawned: true });
  }
  enemy = getLivingEnemy(enemies, selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
  selectedTargetId = enemy?.id || selectedTargetId;

  // Catch damage paths (boss timed spells, hazard explosions, etc.) that bypass the
  // per-hit maybeFireHpCrossBelowProcs / preventDeathWithLastBreath calls.
  if (hero.hp <= 0 && !bossDead && !allEnemiesDead && procState) {
    maybeFireHpCrossBelowProcs(heroHpAtTickStart, hero, procState, heroProcNodes, enemy, tick, log, playerRng);
    preventDeathWithLastBreath(hero, tick, log, enemy, procState);
  }

  if (hero.hp <= 0 || bossDead || allEnemiesDead) {
    if (bossDead || allEnemiesDead) {
      phase = PHASE.WON;
      const defeated = bossDead ? boss : enemies.find(foe => foe.hp <= 0) || boss;
      log.push(makeEntry(tick, 'hero', 'kill', `${defeated?.name || 'Enemy'} has been defeated!`, 0, hero.hp, 0, {
        targetId: defeated?.id || null,
      }));
      const targetHadBleed = (defeated?.activeEffects || []).some(e => e.type === 'bleed');
      fireProcTrigger('on_kill', { targetHadBleed }, procState, heroProcNodes, hero, defeated || enemy, tick, log, playerRng);
      procState.carriedRage = procState.rage;
    } else {
      phase = PHASE.LOST;
      log.push(makeEntry(tick, enemy?.id || 'enemy', 'death', 'You have fallen.', 0, 0, enemy?.hp));
    }
  }

  const ultimateChargePct = Math.min(100, (state.ultimateChargePct || 0) + 3);
  if (phase === PHASE.FIGHTING) updateSniperPatience(hero, procState);

  // Sync auto-attack schedules after all casts, impacts, and procs resolve so UI
  // timers never point at a past tick and ready bars always line up with attacks.
  if (hero.autoAttackStarted && procState) {
    applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
  }
  applyPetRageAttackSpeed(hero, allies, procState, tick, log);
  syncCombatantAutoAttackSchedule(hero, tick);
  for (const ally of allies) syncCombatantAutoAttackSchedule(ally, tick);
  for (const foe of enemies) syncCombatantAutoAttackSchedule(foe, tick);

  return { ...state, tick, phase, combatants: buildCombatants(hero, enemies, allies), frontId, enemyFrontId, selectedTargetId, actionQueue: queue, log, heroConditions, heroWounds, heroResources: syncHeroCombatResources(heroResources, procState), ultimateChargePct, procState, heroProcNodes, enemyProcNodes, enemyProcState, fleeAttempted };
}

export function processAutoAttackFrame(state, elapsedMs = 0, rng = Math.random, options = {}) {
  if (!state || state.phase !== PHASE.FIGHTING) return state;
  const elapsedTicks = Math.max(0, Number(elapsedMs || 0) / TICK_MS);
  if (elapsedTicks <= 0) return state;
  const sideRngs = resolveSideRngs(rng, options);
  const playerRng = sideRngs.player;

  const tick = state.tick || 0;
  const hero = cloneCombatant(state.combatants.hero);
  let enemies = getStateEnemies(state.combatants).map(cloneCombatant);
  let allies = getStateAllies(state.combatants).map(cloneCombatant);
  let frontId = getFrontId(hero, allies, state.frontId);
  let frontTarget = getFrontCombatant(hero, allies, frontId);
  let enemyFrontId = getEnemyFrontId(enemies, state.enemyFrontId);
  let enemy = getLivingEnemy(enemies, state.selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
  let selectedTargetId = enemy?.id || state.selectedTargetId || null;
  const heroConditions = {
    bleeding: state.heroConditions?.bleeding ? { ...state.heroConditions.bleeding } : null,
    poison: state.heroConditions?.poison ? { ...state.heroConditions.poison } : null,
  };
  const heroWounds = {
    deepCut: state.heroWounds?.deepCut || 0,
  };
  const heroResources = Object.fromEntries(
    Object.entries(state.heroResources || {}).map(([key, resource]) => [key, { ...resource }]),
  );
  const heroProcNodes = state.heroProcNodes || [];
  const procState = state.procState ? { ...state.procState, onceFiredIds: [...(state.procState.onceFiredIds || [])] } : createInitialProcState(hero.hp);
  const enemyProcNodes = state.enemyProcNodes || [];
  const enemyProcState = state.enemyProcState ? { ...state.enemyProcState, onceFiredIds: [...(state.enemyProcState.onceFiredIds || [])] } : null;
  const rawEnemyProcRng = typeof options.procRngBySide?.enemy === 'function' ? options.procRngBySide.enemy : null;
  let queue = [...(state.actionQueue || [])];
  const log = [...state.log];

  applyScarStackArmor(hero, procState);
  applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
  if (enemyProcState && enemy?.isDuelPlayer) applyThresholdEffects(enemyProcNodes, enemyProcState, enemy, hero, []);
  applyPetRageAttackSpeed(hero, allies, procState, tick, log);

  const processCombatantAuto = (combatant, defender, procForActor = null, actorOpts = {}) => {
    if (!combatant || !defender || combatant.hp <= 0 || defender.hp <= 0) return;
    if (combatant.disableAutoAttack || isStunned(combatant, tick) || isCasting(queue, combatant.id, tick)) return;
    if (actorOpts.skipAuto) return;
    const attackCount = getReadyAutoAttackCountForElapsed(combatant, elapsedTicks);
    if (attackCount <= 0) return;

    triggerBarbedTrapOnAutoAttack(combatant, tick, log);
    if (triggerBearTrapOnAutoAttack(combatant, tick, log)) {
      queue = removePendingBasicAttacksForActor(queue, combatant.id);
      return;
    }

    for (let attackIndex = 0; attackIndex < attackCount; attackIndex += 1) {
      if (combatant.hp <= 0 || defender.hp <= 0) break;
      const actorRng = rngForCombatant(combatant, sideRngs);
      const logEnemy = combatant.team === 'player' || combatant.id === 'hero' ? defender : combatant;
      const procForImpact = procForActor || (defender?.isPlayer ? procState : null);
      const attack = createBasicAttackImpact(combatant, defender, tick, actorRng, ACTION.BASIC_ATTACK, { frontId, enemyFrontId, procState: procForImpact });
      if (combatant.isPlayer) attack.isMainHand = true;
      const defenderHadLastBreath = !!(defender.activeEffects || []).find(
        e => e.type === 'last_breath' && (e.remainingTicks == null || e.remainingTicks > 0));
      const prevRelicDeathCheatFired = procState ? !!procState.relicDeathCheatFired : false;
      if (resolveBasicAttackImpact(attack, combatant, defender, tick, log, actorRng, hero, logEnemy, heroResources, heroConditions, heroWounds, procForImpact, heroProcNodes, { frontId, enemyFrontId, allies, enemyProcNodes, enemyProcState, enemyProcRng: rawEnemyProcRng })) {
        queue = removePendingBasicAttacksForActor(queue, defender.id);
      }
      // Stop multi-hit catch-up if a death save fired — a second hit would bypass the save.
      const defenderLostLastBreath = defenderHadLastBreath && !(defender.activeEffects || []).some(
        e => e.type === 'last_breath' && (e.remainingTicks == null || e.remainingTicks > 0));
      const defenderRelicSaved = !prevRelicDeathCheatFired && procState && !!procState.relicDeathCheatFired;
      if ((defenderLostLastBreath || defenderRelicSaved) && defender.hp > 0) break;
      if (combatant.id === 'hero') {
        applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
      }
      if (combatant.isDuelPlayer && enemyProcState) {
        applyThresholdEffects(enemyProcNodes, enemyProcState, combatant, hero, []);
      }
    }
  };

  processCombatantAuto(hero, enemy, procState, { skipAuto: !!options.skipHeroAuto });

  if (!options.skipHeroAuto && hero.offhandAutoAttackRate > 0 && hero.hp > 0 && enemy.hp > 0 && !hero.disableAutoAttack && !isStunned(hero, tick) && !isCasting(queue, hero.id, tick)) {
    const offhandProxy = {
      autoAttackRate: hero.offhandAutoAttackRate,
      autoAttackProgressTicks: hero.offhandAutoAttackProgressTicks ?? 0,
      autoAttackStarted: hero.offhandAutoAttackStarted ?? false,
      lastAutoAttackTick: hero.offhandLastAutoAttackTick,
      nextAutoAttackTick: hero.offhandNextAutoAttackTick,
    };
    const offhandAttackCount = getReadyAutoAttackCountForElapsed(offhandProxy, elapsedTicks);
    hero.offhandAutoAttackProgressTicks = offhandProxy.autoAttackProgressTicks;
    hero.offhandAutoAttackStarted = offhandProxy.autoAttackStarted;
    hero.offhandLastAutoAttackTick = offhandProxy.lastAutoAttackTick;
    // Re-anchor schedule to actual game tick so the UI bar stays in sync
    // (getReadyAutoAttackCountForElapsed uses tick=0 internally, which drifts from currentTick)
    {
      const offhandRemaining = Math.max(0, AUTO_ATTACK_TICKS - (hero.offhandAutoAttackProgressTicks ?? 0));
      hero.offhandNextAutoAttackTick = tick + Math.max(1, Math.ceil(offhandRemaining / Math.max(0.01, hero.offhandAutoAttackRate)));
    }
    for (let i = 0; i < offhandAttackCount; i++) {
      if (hero.hp <= 0 || enemy.hp <= 0) break;
      const attack = createBasicAttackImpact(hero, enemy, tick, playerRng, ACTION.BASIC_ATTACK, { frontId, enemyFrontId, procState });
      const preReductionDamage = attack.damage;
      attack.damage = Math.max(1, Math.floor(preReductionDamage * hero.offhandDamageMult));
      attack.isOffhand = true;
      attack.preReductionDamage = preReductionDamage;
      attack.offhandDamageMult = hero.offhandDamageMult;
      resolveBasicAttackImpact(attack, hero, enemy, tick, log, playerRng, hero, enemy, heroResources, heroConditions, heroWounds, procState, heroProcNodes, { frontId, enemyFrontId, allies, enemyProcNodes, enemyProcState, enemyProcRng: rawEnemyProcRng });
    }
  }

  applyPetRageAttackSpeed(hero, allies, procState, tick, log);

  for (const ally of allies) {
    const allyTarget = getLivingEnemy(enemies, selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
    if (!allyTarget || allyTarget.hp <= 0) break;
    processCombatantAuto(ally, allyTarget, null, { skipAuto: !!options.skipAllyAutos });
  }

  frontId = getFrontId(hero, allies, frontId);
  frontTarget = getFrontCombatant(hero, allies, frontId);
  for (const foe of enemies) {
    if (foe.hp <= 0) continue;
    frontTarget = getFrontCombatant(hero, allies, frontId);
    if (!frontTarget || frontTarget.hp <= 0) break;
    processCombatantAuto(foe, frontTarget, foe.isDuelPlayer ? enemyProcState : null, { skipAuto: !!options.skipEnemyAutos });
  }

  applyPetDeathSaves(hero, allies, procState, tick, log);
  applyPetLowHpGuards(hero, allies, procState, tick, log);
  applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
  if (enemyProcState && enemy?.isDuelPlayer) applyThresholdEffects(enemyProcNodes, enemyProcState, enemy, hero, []);
  frontId = getFrontId(hero, allies, frontId);
  frontTarget = getFrontCombatant(hero, allies, frontId);
  enemyFrontId = getEnemyFrontId(enemies, enemyFrontId);
  enemy = getLivingEnemy(enemies, selectedTargetId) || getLivingEnemy(enemies, enemyFrontId) || enemies[0];
  selectedTargetId = enemy?.id || selectedTargetId;

  // Cocoon transformation: intercept first death and guard HP during cocoon phase
  for (const foe of enemies) {
    if (foe.hp <= 0 && foe.hasCocoonTransform && !foe.hasTransformed) {
      const cocoonHp = foe.phase2MaxHp || foe.cocoonMaxHp || 400;
      foe.hp = cocoonHp;
      foe.maxHp = cocoonHp;
      foe.inCocoon = true;
      foe.hasTransformed = true;
      foe.cocoonStartTick = tick;
      foe.cocoonDamageTaken = 0;
      foe.disableAutoAttack = true;
      if (foe.cocoonSprite) {
        foe._originalSprite = foe.sprite;
        foe.sprite = foe.cocoonSprite;
      }
      log.push(makeEntry(tick, foe.id, 'phase_change',
        `${foe.name} seals herself in a hardened cocoon! (${cocoonHp} HP — 90% damage resistance)`,
        0, hero.hp, cocoonHp, { phase: 'cocoon', targetId: foe.id }));
    }
    if (foe.inCocoon && foe.hp < 1) {
      foe.hp = 1;
    }
  }

  let phase = state.phase;
  const boss = enemies.find(foe => foe.id === (state.bossEnemyId || 'enemy')) || enemies[0] || null;
  for (const foe of enemies) {
    if (foe.hp <= 0 && !foe.despawned) preventDeathWithLastBreath(foe, tick, log, hero);
  }
  const bossDead = !!boss && state.bossDeathEndsFight !== false && boss.hp <= 0;
  const allEnemiesDead = enemies.length > 0 && enemies.every(foe => foe.hp <= 0);
  if (bossDead && state.addsDespawnOnBossDeath !== false) {
    enemies = enemies.map(foe => foe.id === boss.id ? foe : { ...foe, hp: 0, despawned: true });
  }
  if (hero.hp <= 0 || bossDead || allEnemiesDead) {
    if (bossDead || allEnemiesDead) {
      phase = PHASE.WON;
      const defeated = bossDead ? boss : enemies.find(foe => foe.hp <= 0) || boss;
      if (!log.some(entry => entry.type === 'kill' && entry.targetId === defeated?.id)) {
        log.push(makeEntry(tick, 'hero', 'kill', `${defeated?.name || 'Enemy'} has been defeated!`, 0, hero.hp, 0, {
          targetId: defeated?.id || null,
        }));
      }
      const targetHadBleed = (defeated?.activeEffects || []).some(e => e.type === 'bleed');
      fireProcTrigger('on_kill', { targetHadBleed }, procState, heroProcNodes, hero, defeated || enemy, tick, log, playerRng);
      // Apply relic kill effects (kill_heal_pct)
      applyRelicKillEffects(hero, procState, tick, log);
      procState.carriedRage = procState.rage;
    } else {
      phase = PHASE.LOST;
      if (!log.some(entry => entry.type === 'death' && entry.actorId === (enemy?.id || 'enemy'))) {
        log.push(makeEntry(tick, enemy?.id || 'enemy', 'death', 'You have fallen.', 0, 0, enemy?.hp));
      }
    }
  }

  return {
    ...state,
    phase,
    combatants: buildCombatants(hero, enemies, allies),
    frontId,
    enemyFrontId,
    selectedTargetId,
    actionQueue: queue,
    log,
    heroConditions,
    heroWounds,
    heroResources: syncHeroCombatResources(heroResources, procState),
    procState,
    heroProcNodes,
    enemyProcNodes,
    enemyProcState,
  };
}

function getChanneledDamageTarget(effect, combatant, procParams = null) {
  const targets = [
    procParams?.hero,
    ...(procParams?.allies || []),
  ].filter(Boolean);
  if (effect.targetId) {
    return targets.find(target => target.id === effect.targetId) || null;
  }
  if (combatant?.team === 'enemy') return procParams?.hero || null;
  return procParams?.enemy || null;
}

function tickActiveEffects(combatant, tick, log, procParams = null) {
  combatant.counterChanceBonus = (combatant.passiveEffects || [])
    .filter(effect => effect.type === 'counter_chance')
    .reduce((sum, effect) => sum + (effect.value || 0), 0);
  if (!combatant.activeEffects.length) return;

  combatant.counterChanceBonus += combatant.activeEffects
    .filter(effect => effect.type === 'counter_chance_buff' && effect.remainingTicks > 0)
    .reduce((sum, effect) => sum + effect.bonus, 0);

  const activeEffectsAtStart = combatant.activeEffects;
  const remaining = [];
  const followups = [];
  for (const effect of activeEffectsAtStart) {
    if (effect.remainingTicks == null) {
      remaining.push(effect);
      continue;
    }
    if (effect.type === 'channeled_damage' && effect.remainingTicks > 0) {
      if (isStunned(combatant, tick)) {
        log.push(makeEntry(tick, combatant.id, 'interrupt', `${effect.sourceAbilityName || 'Channel'} is interrupted.`, 0, procParams?.hero?.hp ?? null, combatant.hp, {
          abilityId: effect.sourceAbilityId || null,
          abilityType: 'channeled_spell',
          interrupted: true,
        }));
        continue;
      }
      const target = getChanneledDamageTarget(effect, combatant, procParams);
      if (target?.hp > 0) {
        const element = effect.element || 'fire';
        const raw = effect.damageFlat != null
          ? effect.damageFlat
          : Math.max(1, Math.floor((target.maxHp || target.hp) * (effect.damagePctPerTick || 2) / 100));
        const damage = resolveElementalDamage(raw, element, target);
      const targetHpBefore = target.hp;
      const applied = applyCombatantDamage(target, damage);
      const text = target.isPlayer
        ? `${effect.sourceAbilityName || 'Channel'} burns you for ${applied.damage} ${element} damage.`
        : `${effect.sourceAbilityName || 'Channel'} burns ${target.name} for ${applied.damage} ${element} damage.`;
      log.push(makeEntry(tick, combatant.id, 'ability', text, applied.damage, procParams?.hero?.hp ?? null, combatant.hp, {
        abilityId: effect.sourceAbilityId || null,
          abilityType: 'channeled_spell',
          element,
          targetId: target.id,
          absorbed: applied.absorbed || 0,
        }));
        logDamageShieldAbsorb(target, applied, tick, log, procParams?.hero || target, combatant, {
          abilityId: effect.sourceAbilityId || null,
          abilityType: 'channeled_spell',
          targetId: target.id,
        });
        if (target.isPlayer && applied.damage > 0 && procParams?.procState) {
        const { procState, heroProcNodes, hero, rng } = procParams;
        procState.hasTakenDamageThisFight = true;
        procState.consecutiveBlocks = 0;
        gainRageOnTakingHit(procState, applied.damage, tick);
        fireProcTrigger('on_take_damage', { damage: applied.damage, isCrit: false, attacker: combatant }, procState, heroProcNodes, hero, combatant, tick, log, rng);
        maybeFireHpCrossBelowProcs(targetHpBefore, hero, procState, heroProcNodes, combatant, tick, log, rng);
        preventDeathWithLastBreath(hero, tick, log, combatant, procState);
      }
    }
    }
    if (effect.type === 'heal_over_time' && effect.remainingTicks > 0) {
      const healed = Math.min(effect.healPerTick, combatant.maxHp - combatant.hp);
      if (healed > 0) {
        combatant.hp = Math.min(combatant.maxHp, combatant.hp + healed);
        const label = effect.sourceAbilityName || (combatant.isPlayer ? 'Meditation' : 'Regeneration');
        const text = combatant.isPlayer
          ? `${label} restores ${healed} HP. (${effect.remainingTicks} tick${effect.remainingTicks !== 1 ? 's' : ''} left)`
          : `${label}: ${combatant.name} restores ${healed} HP.`;
        log.push(makeEntry(tick, combatant.id, 'heal', text, 0, null, null));
      }
    }
    if (effect.type === 'channeled_heal' && effect.remainingTicks > 0) {
      const healAmt = Math.floor((combatant.maxHp || combatant.hp) * (effect.healPctPerTick || 5) / 100);
      if (healAmt > 0 && combatant.hp < combatant.maxHp) {
        combatant.hp = Math.min(combatant.maxHp, combatant.hp + healAmt);
        const healText = combatant.isPlayer
          ? `${effect.sourceAbilityName || 'Healing Seal'} restores ${healAmt} HP.`
          : `${combatant.name} channels ${effect.sourceAbilityName || 'Healing Seal'}: +${healAmt} HP.`;
        log.push(makeEntry(tick, combatant.id, 'heal', healText, 0, null, null));
      }
    }
    if ((effect.type === 'bleed' || effect.type === 'hemorrhage') && isBleedImmune(combatant)) {
      continue;
    }
    if ((effect.type === 'bleed' || effect.type === 'hemorrhage') && combatant.isPlayer && procParams?.procState) {
      const immuneTick = getRelicDotImmunityTick(procParams.procState);
      if (immuneTick > 0 && tick <= immuneTick) {
        const newRem2 = effect.remainingTicks - 1;
        if (newRem2 > 0) remaining.push({ ...effect, remainingTicks: newRem2 });
        continue;
      }
    }
    if ((effect.type === 'bleed' || effect.type === 'hemorrhage') && effect.remainingTicks > 0) {
      const stacks = effect.type === 'bleed' ? Math.max(1, effect.stacks || 1) : 1;
      const bleedVsMarkedBonusPct = (!combatant.isPlayer && effect.type === 'bleed' && procParams?.hero)
        ? (procParams.hero.passiveEffects || []).reduce((sum, e) => e.type === 'bleed_damage_pct_vs_marked' ? sum + (e.value || 0) : sum, 0)
        : 0;
      const hasMarks = bleedVsMarkedBonusPct > 0 && (combatant.activeEffects || []).some(e => e.type === 'shadow_mark' && (e.stacks || 0) > 0);
      const bleedVsMarkedMult = hasMarks ? (1 + bleedVsMarkedBonusPct / 100) : 1;
      const dmg = Math.max(1, Math.floor((combatant.maxHp || combatant.hp) * (effect.damagePctPerTick || 2) * stacks / 100 * bleedVsMarkedMult));
      const hpBeforeDot = combatant.hp;
      combatant.hp = Math.max(0, combatant.hp - dmg);
      const label = effect.type === 'hemorrhage' ? 'Hemorrhage' : 'Bleeding';
      const stackText = effect.type === 'bleed' && stacks > 1 ? ` (${stacks} stacks)` : '';
      const text = combatant.isPlayer
        ? `${label}${stackText} deals ${dmg} damage. (${effect.remainingTicks} tick${effect.remainingTicks !== 1 ? 's' : ''} left)`
        : `${label}${stackText}: ${combatant.name} takes ${dmg} damage. (${effect.remainingTicks - 1} tick${effect.remainingTicks - 1 !== 1 ? 's' : ''} left)`;
      log.push(makeEntry(tick, combatant.id, effect.type === 'hemorrhage' ? 'hemorrhage' : 'bleed', text, dmg, null, null));
      if (procParams?.procState && !combatant.isPlayer && effect.type === 'bleed') {
        const { procState, heroProcNodes, hero, rng } = procParams;
        procState.lastBleedDamage = dmg;
        fireProcTrigger('on_bleed_tick', { bleedDamage: dmg, bleedStacks: stacks }, procState, heroProcNodes, hero, combatant, tick, log, rng);
        const markChancePct = (hero.passiveEffects || []).reduce((sum, e) => e.type === 'bleed_tick_mark_chance' ? sum + (e.value || 0) : sum, 0);
        if (markChancePct > 0 && rng() * 100 < markChancePct && combatant.hp > 0) {
          applyProcEffect({ type: 'apply_shadow_mark', stacks: 1, maxStacks: 5 }, { trigger: 'bleed_tick' }, procState, heroProcNodes, hero, combatant, tick, log, rng);
        }
      }
      if (combatant.isPlayer && procParams?.procState) {
        const { procState, heroProcNodes, hero, enemy, rng } = procParams;
        maybeFireHpCrossBelowProcs(hpBeforeDot, hero, procState, heroProcNodes, enemy, tick, log, rng);
        preventDeathWithLastBreath(hero, tick, log, enemy, procState);
      }
    }
    if ((effect.type === 'burning' || effect.type === 'shadow_burn') && effect.remainingTicks > 0) {
      const hpBeforeBurning = combatant.hp;
      const stacks = Math.max(1, effect.stacks || 1);
      const rawPerStack = effect.damageFlat != null
        ? effect.damageFlat
        : Math.max(1, Math.floor((combatant.maxHp || combatant.hp) * (effect.damagePctPerTick || 2) / 100));
      const raw = Math.max(1, Math.floor(rawPerStack * stacks));
      const element = effect.element || 'fire';
      const dmg = resolveElementalDamage(raw, element, combatant);
      const applied = applyCombatantDamage(combatant, dmg);
      const label = effect.type === 'shadow_burn' ? (effect.label || 'Umbral Burn') : 'Burning';
      const stackText = stacks > 1 ? ` (${stacks} stacks)` : '';
      const text = combatant.isPlayer
        ? `${label}${stackText} deals ${applied.damage} ${element} damage. (${effect.remainingTicks} tick${effect.remainingTicks !== 1 ? 's' : ''} left)`
        : `${label}${stackText}: ${combatant.name} takes ${applied.damage} ${element} damage. (${effect.remainingTicks - 1} tick${effect.remainingTicks - 1 !== 1 ? 's' : ''} left)`;
      log.push(makeEntry(tick, combatant.id, effect.type, text, applied.damage, null, null, {
        element,
        absorbed: applied.absorbed || 0,
        stacks,
      }));
      logDamageShieldAbsorb(combatant, applied, tick, log, combatant.isPlayer ? combatant : null, combatant.isPlayer ? null : combatant);
      if (combatant.isPlayer && procParams?.procState) {
        const { procState, heroProcNodes, hero, enemy, rng } = procParams;
        maybeFireHpCrossBelowProcs(hpBeforeBurning, hero, procState, heroProcNodes, enemy, tick, log, rng);
        preventDeathWithLastBreath(hero, tick, log, enemy, procState);
      }
    }
    if (effect.type === 'poison' && effect.remainingTicks > 0) {
      if (isPoisonImmune(combatant)) continue;
      if (combatant.isPlayer && procParams?.procState) {
        const immuneTick = getRelicDotImmunityTick(procParams.procState);
        if (immuneTick > 0 && tick <= immuneTick) {
          const newRem2 = effect.remainingTicks - 1;
          if (newRem2 > 0) remaining.push({ ...effect, remainingTicks: newRem2 });
          continue;
        }
      }
      const hpBeforePoison = combatant.hp;
      const stacks = Math.max(1, effect.stacks || 1);
      const raw = Math.max(1, Math.floor((combatant.maxHp || combatant.hp) * (effect.damagePctPerTick || 1.4) * stacks / 100));
      const dmg = resolveElementalDamage(raw, 'poison', combatant);
      combatant.hp = Math.max(0, combatant.hp - dmg);
      const text = combatant.isPlayer
        ? `Poison deals ${dmg} poison damage. (${effect.remainingTicks} tick${effect.remainingTicks !== 1 ? 's' : ''} left)`
        : `Poison: ${combatant.name} takes ${dmg} poison damage. (${effect.remainingTicks - 1} tick${effect.remainingTicks - 1 !== 1 ? 's' : ''} left)`;
      log.push(makeEntry(tick, combatant.id, 'poison', text, dmg, null, null, {
        element: 'poison',
      }));
      if (combatant.isPlayer && procParams?.procState) {
        const { procState, heroProcNodes, hero, enemy, rng } = procParams;
        maybeFireHpCrossBelowProcs(hpBeforePoison, hero, procState, heroProcNodes, enemy, tick, log, rng);
        preventDeathWithLastBreath(hero, tick, log, enemy, procState);
      }
    }
    if (effect.type === 'brood_venom' && effect.remainingTicks > 0) {
      if (isPoisonImmune(combatant)) continue;
      const hpBeforeVenom = combatant.hp;
      const stacks = Math.max(1, Math.min(5, effect.stacks || 1));
      const raw = Math.max(1, Math.floor((combatant.maxHp || combatant.hp) * (effect.damagePctPerTick || 0.65) * stacks / 100));
      const dmg = resolveElementalDamage(raw, 'poison', combatant);
      combatant.hp = Math.max(0, combatant.hp - dmg);
      const stackText = stacks > 1 ? ` (${stacks} stacks)` : '';
      const text = combatant.isPlayer
        ? `Brood Venom${stackText} deals ${dmg} poison damage. (${effect.remainingTicks} tick${effect.remainingTicks !== 1 ? 's' : ''} left)`
        : `Brood Venom${stackText}: ${combatant.name} takes ${dmg} poison damage.`;
      log.push(makeEntry(tick, combatant.id, 'poison', text, dmg, null, null, { element: 'poison' }));
      if (stacks >= 5) {
        const shockRaw = Math.max(1, Math.floor((combatant.maxHp || combatant.hp) * 6.5 / 100));
        const shockDmg = resolveElementalDamage(shockRaw, 'poison', combatant);
        combatant.hp = Math.max(0, combatant.hp - shockDmg);
        log.push(makeEntry(tick, combatant.id, 'poison',
          combatant.isPlayer
            ? `Venom Shock! ${shockDmg} burst poison damage. Stacks reduced by 2.`
            : `Venom Shock: ${combatant.name} takes ${shockDmg} burst poison damage!`,
          shockDmg, null, null, { element: 'poison' }));
        effect.stacks = Math.max(1, stacks - 2);
      }
      if (combatant.isPlayer && procParams?.procState) {
        const { procState, heroProcNodes, hero, enemy, rng } = procParams;
        maybeFireHpCrossBelowProcs(hpBeforeVenom, hero, procState, heroProcNodes, enemy, tick, log, rng);
        preventDeathWithLastBreath(hero, tick, log, enemy, procState);
      }
    }
    const newRem = effect.remainingTicks - 1;
    const clearedMidTick = combatant.activeEffects !== activeEffectsAtStart && !combatant.activeEffects.includes(effect);
    if (newRem > 0 && !clearedMidTick) {
      remaining.push({ ...effect, remainingTicks: newRem });
    } else if (effect.type === 'blind' && (effect.attacksRemaining || 0) > 0) {
      remaining.push({ ...effect, remainingTicks: 0 });
    } else if (effect.type === 'stagger' && (effect.attacksRemaining || 0) > 0) {
      // Preserve stagger until its attacks-remaining charge is consumed (like blind)
      remaining.push({ ...effect, remainingTicks: 0 });
    } else if (effect.type === 'pet_unleash' && (effect.recoveryTicks || 0) > 0) {
      followups.push({
        type: 'cannot_auto_attack',
        remainingTicks: Math.max(1, effect.recoveryTicks || 3),
        sourceAbilityId: effect.sourceAbilityId || 'unleash',
        sourceAbilityName: effect.sourceAbilityName || 'Unleash',
      });
    }
  }
  const addedEffects = (combatant.activeEffects || []).filter(effect => !activeEffectsAtStart.includes(effect));
  combatant.activeEffects = [...remaining, ...followups, ...addedEffects];
}

function getActiveBlockPowerRegenBonus(combatant) {
  return (combatant.activeEffects || [])
    .filter(effect => effect.type === 'block_chance_buff' && effect.remainingTicks > 0)
    .reduce((sum, effect) => sum + (effect.blockPowerRegenBonus || 0), 0);
}

function regenerateBlockPower(combatant) {
  if (!combatant || (combatant.blockPowerMax || 0) <= 0) return;
  const regen = (combatant.blockPowerRegen || 0) + getActiveBlockPowerRegenBonus(combatant);
  if (regen <= 0 || (combatant.blockPower || 0) >= combatant.blockPowerMax) return;
  combatant.blockPower = Math.min(combatant.blockPowerMax, (combatant.blockPower || 0) + regen);
}

function applyPassiveTickEffects(combatant, tick, log) {
  if (combatant.hp <= 0 || tick % 2 !== 0) return;
  for (const effect of combatant.passiveEffects || []) {
    if (effect.type !== 'regen_each_round') continue;
    const healed = Math.min(effect.value || 0, combatant.maxHp - combatant.hp);
    if (healed <= 0) continue;
    combatant.hp = Math.min(combatant.maxHp, combatant.hp + healed);
    const text = combatant.isPlayer
      ? `You regenerate ${healed} HP.`
      : `${combatant.name} regenerates ${healed} HP.`;
    log.push(makeEntry(tick, combatant.id, 'heal', text, 0, null, null));
  }
}

function getHpPct(combatant) {
  return combatant.maxHp > 0 ? (combatant.hp / combatant.maxHp) * 100 : 100;
}

function getActiveLastBreathEffect(combatant) {
  return (combatant?.activeEffects || []).find(effect =>
    effect.type === 'last_breath'
    && (effect.remainingTicks == null || effect.remainingTicks > 0));
}

function preventDeathWithLastBreath(combatant, tick, log, enemy = null, procState = null) {
  if (combatant.hp > 0) return false;
  // Check relic death_cheat_once
  if (combatant.isPlayer && procState && !procState.relicDeathCheatFired) {
    const relics = procState.activeRelics || [];
    const deathCheatRelic = relics.find(r => r?.relicPassive?.type === 'death_cheat_once');
    if (deathCheatRelic) {
      procState.relicDeathCheatFired = true;
      combatant.hp = 1;
      log.push(makeEntry(tick, combatant.id, 'proc', 'Spectral Echo: you survive at 1 HP!', 0, 1, enemy?.hp ?? null, { preventedDeath: true }));
      return true;
    }
  }
  const lastBreath = getActiveLastBreathEffect(combatant);
  if (!lastBreath) return false;
  // Consume the last_breath effect — it fires once and is gone
  combatant.activeEffects = (combatant.activeEffects || []).filter(e => e !== lastBreath);
  combatant.hp = 1;
  const lastBreathText = combatant.isPlayer
    ? 'Last Breath keeps you standing at 1 HP.'
    : `${combatant.name}'s Last Breath — survives at 1 HP!`;
  log.push(makeEntry(tick, combatant.id, 'proc', lastBreathText, 0, combatant.hp, enemy?.hp ?? null, {
    statusType: 'last_breath',
    preventedDeath: true,
  }));
  return true;
}

function maybeFireHpCrossBelowProcs(previousHp, hero, procState, heroProcNodes, enemy, tick, log, rng) {
  if (!hero?.isPlayer || !procState || previousHp == null || previousHp <= hero.hp) return;
  const hpPctBefore = hero.maxHp > 0 ? (previousHp / hero.maxHp) * 100 : 100;
  const hpPctAfter = getHpPct(hero);
  fireProcTrigger('on_hp_cross_below', {
    hpPctBefore,
    hpPctAfter,
    damage: Math.max(0, previousHp - hero.hp),
  }, procState, heroProcNodes, hero, enemy, tick, log, rng);
}

function getOutgoingDamageMult(combatant) {
  let mult = 1;
  for (const effect of combatant.activeEffects || []) {
    if (effect.remainingTicks <= 0) continue;
    if (effect.type === 'weaken') mult *= effect.damageMult || 0.8;
    if (effect.type === 'damage_bonus_pct_buff') mult *= 1 + (effect.value || 0) / 100;
  }
  for (const effect of combatant.passiveEffects || []) {
    if (effect.type === 'rage_below_hp' && getHpPct(combatant) <= (effect.thresholdPct || 35)) mult *= effect.attackMult || 1.25;
    if (effect.type === 'threshold_dmg_pct') mult *= 1 + (effect.value || 0) / 100;
  }
  return mult;
}

function getCritDamageBonusPct(combatant) {
  const passiveBonus = (combatant.passiveEffects || []).reduce((total, effect) => {
    if (effect.type === 'crit_damage' || effect.type === 'crit_damage_pct' || effect.type === 'crit_damage_bonus_pct') {
      return total + (effect.value || 0);
    }
    return total;
  }, 0);
  const activeBonus = (combatant.activeEffects || []).reduce((total, effect) => {
    if ((effect.type === 'crit_damage' || effect.type === 'crit_damage_pct' || effect.type === 'crit_damage_bonus_pct') && isEffectActive(effect)) {
      return total + (effect.value || 0);
    }
    return total;
  }, 0);
  return Math.max(0, passiveBonus + activeBonus);
}

function hasArmorDebuff(combatant) {
  return (combatant?.activeEffects || []).some(effect => {
    const hasTime = effect.remainingTicks == null || effect.remainingTicks > 0;
    const hasCharges = effect.attacksRemaining == null || effect.attacksRemaining > 0;
    if (!hasTime || !hasCharges) return false;
    return effect.type === 'armor_shred'
      || effect.type === 'armor_reduction'
      || effect.type === 'armor_reduction_debuff'
      || effect.type === 'power_shot_armor_break';
  });
}

function hasArmorReductionImmunity(combatant) {
  return [
    ...(combatant?.passiveEffects || []),
    ...(combatant?.activeEffects || []),
  ].some(effect => effect.type === 'juggernaut_active' || effect.type === 'armor_reduction_immune');
}

function getCritDamageVsArmorDebuffPct(combatant) {
  return (combatant?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'crit_damage_vs_armor_debuff_pct' ? total + (effect.value || 0) : total, 0);
}

// Predator's Focus: crit damage scales by the number of Shadow Marks on the defender.
// Returns perMarkPct × markStacks (0 if the attacker lacks the passive or the target is unmarked).
function getCritDamagePerMarkBonusPct(attacker, defender) {
  const perMark = (attacker?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'crit_damage_pct_per_mark' ? total + (effect.value || 0) : total, 0);
  if (perMark <= 0) return 0;
  const marks = (defender?.activeEffects || []).find(e => e.type === 'shadow_mark')?.stacks || 0;
  return perMark * marks;
}

function getDamageTakenBonusPct(defender, attacker) {
  if (!attacker?.isPlayer || !defender) return 0;
  return (defender.activeEffects || []).reduce((total, effect) => {
    if (effect.type !== DAMAGE_TAKEN_BONUS_EFFECT || !isEffectActive(effect)) return total;
    return total + (effect.value || effect.damageTakenPct || 0);
  }, 0);
}

function toLowerList(values = []) {
  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map(value => String(value).toLowerCase());
}

function effectMatchesTargetClassifier(effect, target) {
  if (!effect || !target) return false;
  const targetFamily = String(target.family || '').toLowerCase();
  const targetTags = new Set(toLowerList(target.tags || []));
  const families = toLowerList(effect.family || effect.families || effect.targetFamily || effect.targetFamilies);
  const tags = toLowerList(effect.tag || effect.tags || effect.targetTag || effect.targetTags);
  return families.includes(targetFamily) || tags.some(tag => targetTags.has(tag));
}

function getDamageVsTargetPct(attacker, defender) {
  return (attacker?.passiveEffects || []).reduce((total, effect) => {
    if (effect.type !== 'damage_vs_tag' && effect.type !== 'damage_vs_family') return total;
    return effectMatchesTargetClassifier(effect, defender)
      ? total + (effect.value || effect.damagePct || 0)
      : total;
  }, 0);
}

function getMissingHpAttackSpeedBonusPct(combatant) {
  const missingHpPct = Math.max(0, Math.min(100, 100 - getHpPct(combatant)));
  return (combatant.passiveEffects || []).reduce((total, effect) => {
    if (effect.type !== 'attack_speed_by_missing_hp') return total;
    const maxBonus = effect.maxBonusPct || effect.value || 50;
    return total + (maxBonus * missingHpPct / 100);
  }, 0);
}

function getHitChance(attacker) {
  const passiveBonus = (attacker.passiveEffects || [])
    .filter(effect => effect.type === 'enemy_hit_chance' || effect.type === 'hit_chance')
    .reduce((sum, effect) => sum + (effect.value || 0), 0);
  const statBonus = attacker.hitChanceBonus || 0;
  const blindPenalty = (attacker.activeEffects || [])
    .filter(effect => effect.type === 'blind' && ((effect.remainingTicks || 0) > 0 || (effect.attacksRemaining || 0) > 0))
    .reduce((sum, effect) => sum + (effect.hitPenalty || 15), 0);
  const staggerPenalty = (attacker.activeEffects || [])
    .filter(effect => effect.type === 'stagger' && effect.attacksRemaining > 0)
    .reduce((sum, effect) => sum + (effect.missPenalty || 35), 0);
  return Math.max(5, Math.min(100, 90 + statBonus + passiveBonus - blindPenalty - staggerPenalty));
}

function listAbilityTags(ability = {}) {
  return [
    ability.requiresWeaponTag,
    ...(ability.requiresWeaponTags || []),
    ...(ability.weaponTags || []),
    ...(ability.tags || []),
  ].filter(Boolean);
}

function isMeleeAbility(ability = {}) {
  if (!ability || ability.missUsesHitChance === false) return false;
  if (ability.melee || ability.attackType === 'melee') return true;
  if (listAbilityTags(ability).includes('melee')) return true;
  return MELEE_ABILITY_TYPES.has(ability.type);
}

function isRangedAbility(ability = {}) {
  if (!ability || ability.missUsesHitChance === false) return false;
  if (ability.ranged || ability.attackType === 'ranged') return true;
  if (listAbilityTags(ability).includes('ranged')) return true;
  return RANGED_ABILITY_TYPES.has(ability.type);
}

function abilityUsesHitChance(ability = {}) {
  if (!ability || ability.missUsesHitChance === false) return false;
  if (ability.target === 'self' || isAllyTargetAbility(ability)) return false;
  return isMeleeAbility(ability) || isRangedAbility(ability);
}

function getParryChancePct(defender) {
  if (hasActiveEnGarde(defender)) return 100;
  const passiveChance = (defender.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'parry_chance' ? total + (effect.value || effect.chance || 0) : total, 0);
  const activeChance = (defender.activeEffects || []).reduce((total, effect) => {
    if (effect.type === 'parry_guard' && (effect.attacksRemaining || 0) > 0)
      return total + (effect.parryChanceBonus || effect.value || 0);
    if (effect.type === 'parry_chance' && isEffectActive(effect))
      return total + (effect.value || 0);
    return total;
  }, 0);
  return passiveChance + activeChance;
}

function hasActiveEnGarde(combatant) {
  return (combatant?.activeEffects || []).some(effect =>
    effect.type === 'en_garde' && (effect.remainingTicks == null || effect.remainingTicks > 0));
}

function getActiveShadowVeil(defender) {
  return (defender.activeEffects || []).find(effect =>
    effect.type === 'shadow_veil' && (effect.attacksRemaining || 0) > 0) || null;
}

function getActiveBearTrap(combatant) {
  return (combatant.activeEffects || []).find(effect =>
    effect.type === 'bear_trap' && (effect.remainingTicks || 0) > 0) || null;
}

function getActiveBarbedTrap(combatant) {
  return (combatant.activeEffects || []).find(effect =>
    effect.type === 'barbed_trap' && (effect.remainingTicks || 0) > 0) || null;
}

function isRangedAutoAttacker(combatant) {
  const tags = new Set([...(combatant.weaponTags || []), ...(combatant.tags || [])]);
  return combatant.attackType === 'ranged'
    || combatant.family === 'ranged'
    || tags.has('ranged');
}

function isPlayerSideCombatant(combatant) {
  return combatant?.team === 'player' || combatant?.isPlayer || combatant?.isAlly;
}

function getBackRowMeleeDamageMult(combatant, frontId = null) {
  // Formation damage penalties are player-side only for now.
  if (!frontId || !isPlayerSideCombatant(combatant)) return 1;
  if (combatant.id === frontId) return 1;
  if (isRangedAutoAttacker(combatant)) return 1;
  return BACK_ROW_MELEE_DAMAGE_MULT;
}

function getTargetFrontDamageMult(attacker, defender, opts = {}) {
  if (!attacker || !defender) return 1;
  const attackerPlayerSide = isPlayerSideCombatant(attacker);
  const defenderPlayerSide = isPlayerSideCombatant(defender);
  if (attackerPlayerSide === defenderPlayerSide) return 1;
  if (attackerPlayerSide) {
    const enemyFormationActive = opts.enemyFrontId
      && (opts.enemyFrontId !== 'enemy' || defender.isDuelCompanion);
    return enemyFormationActive && defender.id !== opts.enemyFrontId
      ? OFF_FRONT_TARGET_DAMAGE_MULT
      : 1;
  }
  return opts.frontId && defender.id !== opts.frontId
    ? OFF_FRONT_TARGET_DAMAGE_MULT
    : 1;
}

function isAutoAttackStoppedByBearTrap(combatant) {
  const trap = getActiveBearTrap(combatant);
  if (!trap) return false;
  return !(trap.allowRangedAutoAttacks && isRangedAutoAttacker(combatant));
}

function isPoisoned(combatant) {
  return (combatant.activeEffects || []).some(effect =>
    effect.type === 'poison' && (effect.remainingTicks || 0) > 0);
}

function applyBarbedTrapBleed(combatant, trap, tick, log) {
  if (isBleedImmune(combatant)) {
    log.push(makeEntry(tick, combatant.id, 'immune', `${combatant.name} is immune to Bleeding.`, 0, null, null, {
      targetId: combatant.id,
      abilityId: trap.sourceAbilityId || 'barbed_trap',
      abilityType: 'barbed_trap',
    }));
    return;
  }

  const currentBleed = (combatant.activeEffects || []).find(effect => effect.type === 'bleed');
  const nextStacks = Math.min(6, (currentBleed?.stacks || 0) + 1);
  const remainingTicks = Math.max(currentBleed?.remainingTicks || 0, trap.bleedDurationTicks || 5);
  combatant.activeEffects = (combatant.activeEffects || []).filter(effect => effect.type !== 'bleed');
  combatant.activeEffects.push({
    type: 'bleed',
    stacks: nextStacks,
    remainingTicks,
    damagePctPerTick: trap.bleedDamagePct || currentBleed?.damagePctPerTick || 2,
    sourceAbilityId: trap.sourceAbilityId || 'barbed_trap',
  });
  log.push(makeEntry(tick, combatant.id, 'bleed', `Barbed Trap: ${combatant.name} gains Bleeding (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}).`, 0, null, null, {
    targetId: combatant.id,
    abilityId: trap.sourceAbilityId || 'barbed_trap',
    abilityType: 'barbed_trap',
  }));
}

function triggerBarbedTrapOnAutoAttack(combatant, tick, log) {
  const trap = getActiveBarbedTrap(combatant);
  if (!trap) return false;

  const wasPoisoned = isPoisoned(combatant);
  combatant.activeEffects = (combatant.activeEffects || []).filter(effect => effect !== trap);
  log.push(makeEntry(tick, combatant.id, 'trap', `Barbed Trap tears into ${combatant.name} as it attacks.`, 0, null, null, {
    targetId: combatant.id,
    abilityId: trap.sourceAbilityId || 'barbed_trap',
    abilityType: 'barbed_trap',
  }));

  applyBarbedTrapBleed(combatant, trap, tick, log);

  const slowPenalty = trap.attackSpeedPenaltyPct || 20;
  const slowTicks = trap.slowDurationTicks || 4;
  combatant.activeEffects = (combatant.activeEffects || []).filter(effect => effect.type !== 'attack_speed_slow');
  combatant.activeEffects.push({
    type: 'attack_speed_slow',
    remainingTicks: slowTicks,
    attackSpeedPenaltyPct: slowPenalty,
    sourceAbilityId: trap.sourceAbilityId || 'barbed_trap',
  });
  log.push(makeEntry(tick, combatant.id, 'slow', `Barbed Trap: ${combatant.name}'s attack speed is slowed by ${slowPenalty}% for ${slowTicks} seconds.`, 0, null, null, {
    targetId: combatant.id,
    abilityId: trap.sourceAbilityId || 'barbed_trap',
    abilityType: 'barbed_trap',
  }));

  const poisonStaggerAttacks = trap.poisonStaggerAttacks ?? 1;
  if (wasPoisoned && poisonStaggerAttacks > 0) {
    combatant.activeEffects = (combatant.activeEffects || []).filter(effect => effect.type !== 'stagger');
    combatant.activeEffects.push({
      type: 'stagger',
      remainingTicks: trap.poisonStaggerDurationTicks || 2,
      attacksRemaining: poisonStaggerAttacks,
      missPenalty: trap.poisonStaggerMissPenalty || 35,
      sourceAbilityId: trap.sourceAbilityId || 'barbed_trap',
    });
    log.push(makeEntry(tick, combatant.id, 'stagger', `Barbed Trap: poisoned ${combatant.name} is Staggered for ${poisonStaggerAttacks} attack.`, 0, null, null, {
      targetId: combatant.id,
      abilityId: trap.sourceAbilityId || 'barbed_trap',
      abilityType: 'barbed_trap',
      staggerAttacks: poisonStaggerAttacks,
    }));
  }

  return true;
}

function triggerBearTrapOnAutoAttack(combatant, tick, log) {
  const trap = getActiveBearTrap(combatant);
  if (!trap || !isAutoAttackStoppedByBearTrap(combatant)) return false;

  combatant.activeEffects = (combatant.activeEffects || []).filter(effect => effect !== trap);
  combatant.activeEffects = (combatant.activeEffects || []).filter(e => e.type !== 'force_next_auto_miss');
  combatant.activeEffects.push({
    type: 'force_next_auto_miss',
    attacksRemaining: 1,
    sourceAbilityId: trap.sourceAbilityId || 'bear_trap',
    sourceAbilityName: 'Bear Trap',
  });
  const stunTicks = combatant.isBoss ? (trap.bossTriggerStunTicks || 1) : (trap.triggerStunTicks || 2);
  applyStunToCombatant(combatant, tick, stunTicks);
  const durationLabel = `${stunTicks} second${stunTicks !== 1 ? 's' : ''}`;
  const text = combatant.isPlayer
    ? `Bear Trap snaps shut. Your auto attack misses and you are stunned for ${durationLabel}.`
    : `Bear Trap snaps shut on ${combatant.name}. Its auto attack misses and it is stunned for ${durationLabel}.`;
  log.push(makeEntry(tick, combatant.id, 'trap', text, 0, null, null, {
    targetId: combatant.id,
    abilityId: trap.sourceAbilityId || 'bear_trap',
    abilityType: 'bear_trap',
    stunTicks,
  }));

  const staggerAttacks = Math.max(0, trap.staggerAttacks || 0);
  if (staggerAttacks > 0) {
    const staggerDurationTicks = Math.max(1, trap.staggerDurationTicks || staggerAttacks);
    const missPenalty = trap.staggerMissPenalty || 35;
    combatant.activeEffects = (combatant.activeEffects || []).filter(effect => effect.type !== 'stagger');
    combatant.activeEffects.push({
      type: 'stagger',
      remainingTicks: staggerDurationTicks,
      attacksRemaining: staggerAttacks,
      missPenalty,
      sourceAbilityId: trap.sourceAbilityId || 'bear_trap',
      source: trap.upgradeSource || trap.sourceAbilityId || 'bear_trap',
    });
    const staggerText = combatant.isPlayer
      ? `Snare Specialist: you are Staggered for ${staggerAttacks} attacks.`
      : `Snare Specialist: ${combatant.name} is Staggered for ${staggerAttacks} attacks.`;
    log.push(makeEntry(tick, combatant.id, 'stagger', staggerText, 0, null, null, {
      targetId: combatant.id,
      abilityId: trap.sourceAbilityId || 'bear_trap',
      abilityType: 'bear_trap',
      staggerAttacks,
    }));
  }
  return false;
}

function isEffectActive(effect) {
  return effect.remainingTicks == null || effect.remainingTicks > 0;
}

function breakBearTrapOnAutoAttack(defender, tick, log, hero, enemy) {
  const trap = getActiveBearTrap(defender);
  if (!trap?.breaksOnAutoAttack) return;
  defender.activeEffects = (defender.activeEffects || []).filter(effect => effect.type !== 'bear_trap');
  const targetLabel = defender.isPlayer ? 'you' : defender.name;
  log.push(makeEntry(tick, 'hero', 'trap', `Bear Trap breaks on the auto attack against ${targetLabel}.`, 0, hero.hp, enemy.hp));
}

function getEvasionChancePct(defender) {
  const passiveChance = (defender.passiveEffects || []).reduce((total, effect) =>
    (effect.type === 'evasion_chance' || effect.type === 'dodge_chance') ? total + (effect.value || effect.chance || 0) : total, 0);
  const activeChance = (defender.activeEffects || []).reduce((total, effect) =>
    (effect.type === 'evasion_chance' || effect.type === 'dodge_chance') && isEffectActive(effect) ? total + (effect.value || effect.chance || 0) : total, 0);
  const shadowVeil = getActiveShadowVeil(defender);
  return Math.max(0, Math.min(100, passiveChance + activeChance + (shadowVeil?.evasionChanceBonus || 0)));
}

function getDefenseEffectivenessPct(attacker) {
  const penaltyPct = (attacker?.passiveEffects || []).reduce((best, effect) => {
    if (effect.type !== 'defense_penalty_pct' && effect.type !== 'aerial_pressure') return best;
    return Math.max(best, effect.value || effect.penaltyPct || 0);
  }, 0);
  return Math.max(0, Math.min(100, 100 - penaltyPct));
}

function getDoubleHitChancePct(combatant) {
  return Math.max(0, Math.min(100, (combatant.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'double_hit' ? total + (effect.value || effect.chance || 0) : total, 0)));
}

function consumeShadowVeilAttack(defender) {
  defender.activeEffects = (defender.activeEffects || [])
    .map(effect => {
      if (effect.type !== 'shadow_veil' || (effect.attacksRemaining || 0) <= 0) return effect;
      return { ...effect, attacksRemaining: effect.attacksRemaining - 1 };
    })
    .filter(effect => effect.type !== 'shadow_veil' || (effect.attacksRemaining || 0) > 0);
}

function consumeParryGuardAttack(defender) {
  defender.activeEffects = (defender.activeEffects || [])
    .map(effect => {
      if (effect.type !== 'parry_guard' || (effect.attacksRemaining || 0) <= 0) return effect;
      return { ...effect, attacksRemaining: effect.attacksRemaining - 1 };
    })
    .filter(effect => effect.type !== 'parry_guard' || (effect.attacksRemaining || 0) > 0);
}

function consumeAttackBasedEffects(combatant) {
  combatant.activeEffects = (combatant.activeEffects || [])
    .map(effect => {
      if (!['stagger', 'blind'].includes(effect.type) || effect.attacksRemaining == null) return effect;
      return { ...effect, attacksRemaining: effect.attacksRemaining - 1 };
    })
    .filter(effect => {
      if (effect.type === 'stagger') return effect.attacksRemaining > 0;
      if (effect.type === 'blind') return effect.attacksRemaining == null ? (effect.remainingTicks || 0) > 0 : effect.attacksRemaining > 0;
      return true;
    });
}

function consumeIncomingDamageReductionAttack(combatant) {
  combatant.activeEffects = (combatant.activeEffects || [])
    .map(effect => {
      if (effect.type !== 'damage_taken_reduction' || effect.attacksRemaining == null) return effect;
      return { ...effect, attacksRemaining: effect.attacksRemaining - 1 };
    })
    .filter(effect => effect.type !== 'damage_taken_reduction' || effect.attacksRemaining == null || effect.attacksRemaining > 0);
}

function consumeNextHitEffects(combatant) {
  combatant.activeEffects = (combatant.activeEffects || []).filter(effect => !effect.consumeOnNextHit);
}

function applyFirstHitCritDamageBuff(hero, tick, log, enemy) {
  const effect = (hero?.passiveEffects || []).find(entry => entry.type === 'first_hit_crit_damage_bonus_pct');
  const bonus = Math.max(0, effect?.value || effect?.critDamagePct || 0);
  if (!hero?.isPlayer || bonus <= 0) return;
  const source = effect.source || 'first_hit_crit_damage_bonus_pct';
  if ((hero.activeEffects || []).some(active => active.source === source && active.type === 'crit_damage_bonus_pct')) return;
  const durationTicks = Math.max(1, effect.durationTicks || 99999);
  hero.activeEffects = hero.activeEffects || [];
  hero.activeEffects.push({
    type: 'crit_damage_bonus_pct',
    value: bonus,
    remainingTicks: durationTicks,
    source,
  });
  const durationText = durationTicks >= 99999 ? 'for this fight' : `for ${durationTicks} seconds`;
  log.push(makeEntry(tick, 'hero', 'proc', `Optics: +${bonus}% crit damage ${durationText}.`, 0, hero.hp, enemy?.hp, {
    source,
  }));
}

function getPetFlankingEffect(hero) {
  return (hero?.passiveEffects || []).find(effect => effect.type === 'pet_flanking') || null;
}

function grantFlankingCritBonus(hero, procState, effect, tick, log, enemy) {
  if (!hero || !procState || !effect) return;
  const critBonus = Math.max(0, effect.critChanceBonus || effect.value || 0);
  if (critBonus <= 0) return;
  hero.activeEffects = (hero.activeEffects || [])
    .filter(active => active.source !== 'beastmaster_flanking');
  hero.activeEffects.push({
    type: 'crit_chance_buff',
    value: critBonus,
    source: 'beastmaster_flanking',
    consumeOnNextHit: true,
  });
  log.push(makeEntry(tick, 'hero', 'proc', `Flanking: your next shot gains +${critBonus}% crit chance.`, 0, hero.hp, enemy?.hp, {
    source: 'beastmaster_flanking',
  }));
}

function trackPetFlankingHit(attacker, hero, procState, tick, log, enemy) {
  if (!procState || !attacker || !hero) return;
  const isHeroHit = attacker.id === 'hero' && attacker.isPlayer;
  const isAllyHit = !!attacker.isAlly;
  if (!isHeroHit && !isAllyHit) return;

  const effect = getPetFlankingEffect(hero);
  if (!effect) return;

  const windowTicks = Math.max(0, effect.windowTicks ?? 2);
  let pairKey = null;

  if (isHeroHit) {
    procState.lastHeroFlankingHitTick = tick;
    const allyTick = procState.lastAllyFlankingHitTick;
    if (Number.isFinite(allyTick) && tick - allyTick <= windowTicks) {
      pairKey = `${tick}:${allyTick}`;
    }
  } else {
    procState.lastAllyFlankingHitTick = tick;
    const heroTick = procState.lastHeroFlankingHitTick;
    if (Number.isFinite(heroTick) && tick - heroTick <= windowTicks) {
      pairKey = `${heroTick}:${tick}`;
    }
  }

  if (!pairKey || procState.flankingLastPair === pairKey) return;
  procState.flankingLastPair = pairKey;
  grantFlankingCritBonus(hero, procState, effect, tick, log, enemy);
}

function grantHeroCritFromAllyAbility(action, attacker, hero, tick, log, enemy, damageDealt) {
  const critBonus = Math.max(0, action?.ability?.heroCritChanceBonus || 0);
  if (!attacker?.isAlly || !hero || critBonus <= 0 || damageDealt <= 0) return;
  const durationTicks = Math.max(1, action.ability.heroCritDurationTicks || 2);
  hero.activeEffects = (hero.activeEffects || [])
    .filter(active => active.source !== 'beastmaster_howling_strike');
  hero.activeEffects.push({
    type: 'crit_chance_buff',
    value: critBonus,
    remainingTicks: durationTicks,
    source: 'beastmaster_howling_strike',
  });
  log.push(makeEntry(tick, attacker.id, 'proc', `Howling Strike: you gain +${critBonus}% crit chance.`, 0, hero.hp, enemy?.hp, {
    abilityId: action.ability.id || null,
    abilityType: action.ability.type || null,
    targetId: 'hero',
    source: 'beastmaster_howling_strike',
  }));
}

function grantHeroCritFromPetHit(attacker, hero, tick, log, enemy, damageDealt) {
  if (!attacker?.isAlly || !hero?.isPlayer || damageDealt <= 0) return;
  const effect = (hero.passiveEffects || []).find(entry => entry.type === 'pet_hit_next_shot_crit') || null;
  const critBonus = Math.max(0, effect?.value || effect?.critChanceBonus || 0);
  if (critBonus <= 0) return;
  const durationTicks = Math.max(1, effect.durationTicks || 2);
  hero.activeEffects = (hero.activeEffects || [])
    .filter(active => active.source !== 'ranger_pack_bonds');
  hero.activeEffects.push({
    type: 'crit_chance_buff',
    value: critBonus,
    remainingTicks: durationTicks,
    consumeOnNextHit: true,
    source: 'ranger_pack_bonds',
  });
  log.push(makeEntry(tick, attacker.id, 'proc', `Pack Bonds: your next shot gains +${critBonus}% crit chance.`, 0, hero.hp, enemy?.hp, {
    source: 'ranger_pack_bonds',
    targetId: 'hero',
  }));
}

function getPetRageOnHitEffect(hero) {
  return (hero?.passiveEffects || []).find(effect => effect.type === 'pet_rage_on_hit') || null;
}

function grantHeroRageFromPetHit(attacker, hero, procState, damageDealt, isAbility = false) {
  if (!attacker?.isAlly || !hero || !procState || damageDealt <= 0) return;
  const effect = getPetRageOnHitEffect(hero);
  if (!effect) return;
  const rageGain = Math.max(0, Math.floor(isAbility
    ? (effect.abilityRage || effect.abilityValue || effect.value || 0)
    : (effect.rage || effect.value || 0)));
  if (rageGain <= 0) return;
  procState.rage = Math.min(HERO_RAGE_MAX, (procState.rage || 0) + rageGain);
}

function getPetAliveDamageReductionEffects(hero) {
  return (hero?.passiveEffects || []).filter(effect => effect.type === 'pet_alive_damage_taken_reduction_pct');
}

function applyPetAliveDamageReduction(hero, allies = []) {
  if (!hero?.isPlayer) return;
  const baseEffects = getPetAliveDamageReductionEffects(hero);
  hero.passiveEffects = (hero.passiveEffects || []).filter(effect => effect.source !== PET_ALIVE_DAMAGE_REDUCTION_SOURCE);
  if (!baseEffects.length || !allies.some(ally => ally?.isAlly && ally.hp > 0)) return;
  for (const effect of baseEffects) {
    const reduction = Math.max(0, effect.value || effect.reductionPct || 0);
    if (reduction <= 0) continue;
    hero.passiveEffects.push({
      type: 'damage_taken_reduction_pct',
      value: reduction,
      source: PET_ALIVE_DAMAGE_REDUCTION_SOURCE,
      talentSource: effect.source || null,
    });
  }
}

const RELENTLESS_PRESSURE_SOURCE = 'ranger_relentless_pressure';

function hasActiveDot(combatant) {
  return (combatant?.activeEffects || []).some(effect =>
    ['bleed', 'hemorrhage', 'poison'].includes(effect.type)
    && (effect.remainingTicks || 0) > 0);
}

function applyRelentlessPressure(hero, enemy, allies = [], procState = null) {
  hero.passiveEffects = (hero.passiveEffects || []).filter(effect => effect.source !== RELENTLESS_PRESSURE_SOURCE);
  for (const ally of allies || []) {
    if (!ally?.isAlly) continue;
    ally.passiveEffects = (ally.passiveEffects || []).filter(effect => effect.source !== RELENTLESS_PRESSURE_SOURCE);
  }

  const effect = (hero.passiveEffects || []).find(entry => entry.type === 'relentless_pressure') || null;
  if (!effect || !hasActiveDot(enemy)) return;

  const heroBonus = Math.max(0, effect.heroAttackSpeedPct || effect.value || 0);
  const petBonus = Math.max(0, effect.petAttackSpeedPct || effect.allyAttackSpeedPct || 0);
  if (heroBonus > 0) {
    hero.passiveEffects.push({
      type: 'attack_speed_bonus_pct',
      value: heroBonus,
      source: RELENTLESS_PRESSURE_SOURCE,
    });
    hero.passiveEffects.push({
      type: 'relentless_pressure_active',
      source: RELENTLESS_PRESSURE_SOURCE,
    });
  }
  if (petBonus > 0) {
    for (const ally of allies || []) {
      if (!ally?.isAlly || ally.hp <= 0) continue;
      ally.passiveEffects.push({
        type: 'attack_speed_bonus_pct',
        value: petBonus,
        source: RELENTLESS_PRESSURE_SOURCE,
      });
      ally.passiveEffects.push({
        type: 'relentless_pressure_active',
        source: RELENTLESS_PRESSURE_SOURCE,
      });
    }
  }
}

function applyPetLowHpGuards(hero, allies, procState, tick, log) {
  if (!hero?.isPlayer || !procState || !Array.isArray(allies)) return;
  const effects = (hero.passiveEffects || []).filter(effect => effect.type === 'pet_low_hp_guard');
  if (!effects.length) return;
  procState.onceFiredIds = procState.onceFiredIds || [];

  for (const effect of effects) {
    const thresholdPct = Math.max(1, Math.min(100, effect.thresholdPct || 50));
    const reductionPct = Math.max(0, effect.reductionPct || effect.value || 0);
    const durationTicks = Math.max(1, effect.durationTicks || effect.ticks || 4);
    if (reductionPct <= 0) continue;

    for (const ally of allies) {
      if (!ally?.isAlly || ally.hp <= 0 || ally.maxHp <= 0) continue;
      const allyHpPct = (ally.hp / ally.maxHp) * 100;
      if (allyHpPct > thresholdPct) continue;

      const source = effect.source || 'pet_low_hp_guard';
      const onceKey = `${source}:${ally.id}:low_hp_guard`;
      if (effect.oncePerFight !== false && procState.onceFiredIds.includes(onceKey)) continue;
      if (effect.oncePerFight !== false) procState.onceFiredIds.push(onceKey);

      ally.activeEffects = (ally.activeEffects || []).filter(active => active.source !== source);
      ally.activeEffects.push({
        type: 'damage_taken_reduction',
        reductionPct,
        remainingTicks: durationTicks + 1,
        source,
      });
      log.push(makeEntry(tick, ally.id, 'proc', `Protective Instinct: ${ally.name} is wounded. It takes ${reductionPct}% less damage for ${durationTicks} seconds.`, 0, hero.hp, null, {
        source,
        targetId: ally.id,
        reductionPct,
      }));
    }
  }
}

function getPetDeathSaveEffect(hero) {
  return (hero?.passiveEffects || []).find(effect => effect.type === 'pet_death_save') || null;
}

function applyPetDeathSaves(hero, allies, procState, tick, log) {
  const effect = getPetDeathSaveEffect(hero);
  if (!effect || !procState || !Array.isArray(allies)) return;
  procState.onceFiredIds = procState.onceFiredIds || [];
  const source = effect.source || 'beastmaster_undying_will';
  for (const ally of allies) {
    if (!ally?.isAlly || ally.hp > 0) continue;
    const onceKey = `${source}:${ally.id}`;
    if (procState.onceFiredIds.includes(onceKey)) continue;
    procState.onceFiredIds.push(onceKey);
    ally.hp = Math.max(1, Math.min(ally.maxHp || 1, effect.hp || 1));
    ally.activeEffects = (ally.activeEffects || []).filter(active => active.type !== 'bleed' && active.type !== 'poison' && active.type !== 'burning');
    resetAutoAttackCycle(ally, tick);
    log.push(makeEntry(tick, ally.id, 'death_save', `Undying Will: ${ally.name} refuses to fall.`, 0, hero.hp, null, {
      source,
      targetId: ally.id,
    }));
  }
}

function getPetRageAttackSpeedEffect(hero) {
  return (hero?.passiveEffects || []).find(effect => effect.type === 'pet_rage_attack_speed') || null;
}

function applyPetRageAttackSpeed(hero, allies, procState, tick, log) {
  if (!Array.isArray(allies)) return;
  const effect = getPetRageAttackSpeedEffect(hero);
  const source = effect?.source || 'beastmaster_shared_fury';
  const threshold = effect?.rageThreshold ?? 50;
  const bonus = Math.max(0, effect?.attackSpeedBonusPct || effect?.value || 0);
  const hasLivingAlly = allies.some(ally => ally?.isAlly && ally.hp > 0);
  const active = !!effect && bonus > 0 && hasLivingAlly && (procState?.rage || 0) >= threshold;

  for (const ally of allies) {
    if (!ally?.isAlly) continue;
    ally.passiveEffects = (ally.passiveEffects || []).filter(passive => passive.source !== source);
    if (active && ally.hp > 0) {
      ally.passiveEffects.push({ type: 'attack_speed_bonus_pct', value: bonus, source });
    }
  }

  if (!procState) return;
  if (active && !procState.sharedFuryActive) {
    procState.sharedFuryActive = true;
    log.push(makeEntry(tick, 'hero', 'proc', `Shared Fury: your wolf gains +${bonus}% attack speed.`, 0, hero.hp, null, {
      source,
    }));
  } else if (!active && procState.sharedFuryActive) {
    procState.sharedFuryActive = false;
    log.push(makeEntry(tick, 'hero', 'proc', 'Shared Fury fades.', 0, hero.hp, null, {
      source,
    }));
  }
}

function getIncomingPhysicalReductionPct(defender) {
  return (defender.passiveEffects || []).reduce((best, effect) => {
    if (effect.type !== 'physical_reduction_below_hp') return best;
    if (getHpPct(defender) > (effect.thresholdPct || 45)) return best;
    return Math.max(best, effect.reductionPct || effect.value || 0);
  }, 0);
}

function getDamageVsLowHpPct(attacker, defender) {
  return (attacker.passiveEffects || []).reduce((bonus, effect) => {
    if (effect.type !== 'damage_vs_low_hp') return bonus;
    if (getHpPct(defender) > (effect.thresholdPct || 35)) return bonus;
    return bonus + (effect.value || effect.damagePct || 0);
  }, 0);
}

function getDamageVsDisruptedPct(attacker, defender, tick) {
  const isDisrupted = tick <= (defender.stunUntilTick || -1)
    || (defender.activeEffects || []).some(e =>
      (e.type === 'daze' && e.remainingTicks > 0)
      || (e.type === 'stagger' && (e.remainingTicks > 0 || e.attacksRemaining > 0)));
  if (!isDisrupted) return 0;
  return (attacker.passiveEffects || []).reduce((bonus, effect) =>
    effect.type === 'damage_vs_disrupted' ? bonus + (effect.value || 0) : bonus, 0);
}

function getImpactOnBlockPct(attacker) {
  return (attacker.passiveEffects || []).reduce((total, effect) => {
    if (effect.type === 'impact_on_block_pct') return total + (effect.value || 0);
    if (effect.type === 'shock_on_block_pct') return total + (effect.value || 0);
    if (effect.type === 'crusher_stance') return total + (effect.impactOnBlockPct || effect.shockOnBlockPct || 0);
    return total;
  }, 0);
}

function getPassiveAutoBleedChancePct(attacker) {
  return (attacker.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'auto_bleed_chance' ? total + (effect.value || effect.chance || 0) : total, 0);
}

function getPoisonDamagePctBonus(attacker) {
  return (attacker?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'poison_damage_pct_bonus' ? total + (effect.value || 0) : total, 0);
}

function getPoisonDurationBonusTicks(attacker) {
  return (attacker?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'poison_duration_bonus_ticks' ? total + (effect.value || 0) : total, 0);
}

function getBleedDamageBonusPct(attacker) {
  return (attacker?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'bleed_damage_bonus_pct' ? total + (effect.value || 0) : total, 0);
}

function applyBleedDamageBonus(attacker, basePct) {
  const bonusPct = getBleedDamageBonusPct(attacker);
  return bonusPct > 0 ? basePct * (1 + bonusPct / 100) : basePct;
}

function getBleedDurationBonusTicks(attacker) {
  return (attacker?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'bleed_duration_bonus_ticks' ? total + (effect.value || 0) : total, 0);
}

function getPlayerBleedRefreshTicks(attacker) {
  return PLAYER_BLEED_REFRESH_TICKS + getBleedDurationBonusTicks(attacker);
}

function getRelicDotDurationBonus(procState) {
  for (const relic of procState?.activeRelics || []) {
    const p = relic?.relicPassive;
    if (p?.type === 'dot_bonus') return p.durationBonus || 0;
  }
  return 0;
}

function getRelicDotDamageMult(procState) {
  for (const relic of procState?.activeRelics || []) {
    const p = relic?.relicPassive;
    if (p?.type === 'dot_bonus') return 1 + (p.damageTickBonus || 0) / 100;
  }
  return 1;
}

function getActiveSwordStance(combatant) {
  return (combatant.activeEffects || []).find(effect => effect.type === 'sword_stance' && (effect.chargesLeft || 0) > 0) || null;
}

function getActiveHeavyStrikes(combatant) {
  return (combatant.activeEffects || []).find(effect => effect.type === 'heavy_strikes' && (effect.chargesLeft || 0) > 0) || null;
}

function getActiveBerserkerStance(combatant) {
  return (combatant.activeEffects || []).find(effect =>
    effect.type === 'berserker_stance'
    && (effect.remainingTicks == null || effect.remainingTicks > 0)
    && (effect.active !== false)
  ) || null;
}

function getActiveRapidFire(combatant) {
  return (combatant.activeEffects || []).find(effect => effect.type === 'rapid_fire' && (effect.chargesLeft || 0) > 0) || null;
}

function getActiveFlashBurst(combatant) {
  return (combatant.activeEffects || []).find(effect => effect.type === 'flash_burst' && (effect.remainingTicks || 0) > 0) || null;
}

function getAttackSpeedSlowPenaltyPct(combatant) {
  return (combatant.activeEffects || []).reduce((best, effect) => {
    if (effect.type !== 'attack_speed_slow') return best;
    const hasAttackCharges = effect.attacksRemaining == null || effect.attacksRemaining > 0;
    const hasTickDuration = effect.remainingTicks == null || effect.remainingTicks > 0;
    if (!hasAttackCharges || !hasTickDuration) return best;
    return Math.max(best, effect.attackSpeedPenaltyPct || effect.value || 0);
  }, 0);
}

function getActiveMaceMastery(combatant) {
  return (combatant.activeEffects || []).find(effect => effect.type === 'mace_mastery' && (effect.chargesLeft || 0) > 0) || null;
}

function consumeSwordStanceCharge(combatant) {
  const stanceIdx = (combatant.activeEffects || []).findIndex(effect => effect.type === 'sword_stance' && (effect.chargesLeft || 0) > 0);
  if (stanceIdx < 0) return null;
  const stance = combatant.activeEffects[stanceIdx];
  if (stance.chargesLeft <= 1) {
    combatant.activeEffects.splice(stanceIdx, 1);
  } else {
    combatant.activeEffects[stanceIdx] = { ...stance, chargesLeft: stance.chargesLeft - 1 };
  }
  return stance;
}

function consumeHeavyStrikesCharge(combatant) {
  const effectIdx = (combatant.activeEffects || []).findIndex(effect => effect.type === 'heavy_strikes' && (effect.chargesLeft || 0) > 0);
  if (effectIdx < 0) return null;
  const effect = combatant.activeEffects[effectIdx];
  if (effect.chargesLeft <= 1) {
    combatant.activeEffects.splice(effectIdx, 1);
  } else {
    combatant.activeEffects[effectIdx] = { ...effect, chargesLeft: effect.chargesLeft - 1 };
  }
  return effect;
}

function consumeBerserkerStanceCharge(combatant) {
  const effectIdx = (combatant.activeEffects || []).findIndex(effect => effect.type === 'berserker_stance' && (effect.chargesLeft || 0) > 0);
  if (effectIdx < 0) return null;
  const effect = combatant.activeEffects[effectIdx];
  if (effect.chargesLeft <= 1) {
    combatant.activeEffects.splice(effectIdx, 1);
  } else {
    combatant.activeEffects[effectIdx] = { ...effect, chargesLeft: effect.chargesLeft - 1 };
  }
  return effect;
}

function consumeMaceMasteryCharge(combatant) {
  const effectIdx = (combatant.activeEffects || []).findIndex(effect => effect.type === 'mace_mastery' && (effect.chargesLeft || 0) > 0);
  if (effectIdx < 0) return null;
  const effect = combatant.activeEffects[effectIdx];
  if (effect.chargesLeft <= 1) {
    combatant.activeEffects.splice(effectIdx, 1);
  } else {
    combatant.activeEffects[effectIdx] = { ...effect, chargesLeft: effect.chargesLeft - 1 };
  }
  return effect;
}

function consumeRapidFireCharge(combatant) {
  const effectIdx = (combatant.activeEffects || []).findIndex(effect => effect.type === 'rapid_fire' && (effect.chargesLeft || 0) > 0);
  if (effectIdx < 0) return null;
  const effect = combatant.activeEffects[effectIdx];
  if (effect.chargesLeft <= 1) {
    combatant.activeEffects.splice(effectIdx, 1);
  } else {
    combatant.activeEffects[effectIdx] = { ...effect, chargesLeft: effect.chargesLeft - 1 };
  }
  return effect;
}

function consumeAttackSpeedSlowCharge(combatant) {
  combatant.activeEffects = (combatant.activeEffects || [])
    .map(effect => {
      if (effect.type !== 'attack_speed_slow' || effect.attacksRemaining == null) return effect;
      return { ...effect, attacksRemaining: effect.attacksRemaining - 1 };
    })
    .filter(effect => effect.type !== 'attack_speed_slow' || effect.attacksRemaining == null || effect.attacksRemaining > 0);
}

function addBerserkerStanceCharge(combatant, sourceEffect) {
  const chargeGain = Math.max(0, sourceEffect?.critAddsCharge || 0);
  if (chargeGain <= 0) return;
  const effectIdx = (combatant.activeEffects || []).findIndex(effect => effect.type === 'berserker_stance');
  if (effectIdx >= 0) {
    const effect = combatant.activeEffects[effectIdx];
    combatant.activeEffects[effectIdx] = {
      ...effect,
      chargesLeft: (effect.chargesLeft || 0) + chargeGain,
    };
    return;
  }
  combatant.activeEffects.push({
    ...sourceEffect,
    chargesLeft: chargeGain,
  });
}

function addRapidFireCharge(combatant, sourceEffect) {
  const chargeGain = Math.max(0, sourceEffect?.critAddsCharge || 0);
  if (chargeGain <= 0) return;
  const effectIdx = (combatant.activeEffects || []).findIndex(effect => effect.type === 'rapid_fire');
  if (effectIdx >= 0) {
    const effect = combatant.activeEffects[effectIdx];
    combatant.activeEffects[effectIdx] = {
      ...effect,
      chargesLeft: (effect.chargesLeft || 0) + chargeGain,
    };
    return;
  }
  combatant.activeEffects.push({
    ...sourceEffect,
    chargesLeft: chargeGain,
  });
}

function getEffectiveAutoAttackRate(combatant) {
  if (!combatant || combatant.disableAutoAttack) return 0;
  if ((combatant.activeEffects || []).some(effect => effect.type === 'cannot_auto_attack' && isEffectActive(effect))) return 0;
  if ((combatant.activeEffects || []).some(e => e.type === 'web_snare' && (e.remainingTicks == null || e.remainingTicks > 0))) return 0;
  const parsedBaseRate = Number(combatant.autoAttackRate ?? 1);
  const baseRate = Number.isFinite(parsedBaseRate) ? parsedBaseRate : 1;
  if (baseRate <= 0) return combatant.isPlayer ? 1 : 0;
  const swordStance = getActiveSwordStance(combatant);
  const berserkerStance = getActiveBerserkerStance(combatant);
  const rapidFire = getActiveRapidFire(combatant);
  const stanceMult = swordStance ? 1 + (swordStance.attackSpeedBonusPct || 25) / 100 : 1;
  const berserkerMult = berserkerStance ? 1 + (berserkerStance.attackSpeedBonusPct || 0) / 100 : 1;
  const rapidFireMult = rapidFire ? 1 + (rapidFire.attackSpeedBonusPct || 40) / 100 : 1;
  const missingHpSpeedMult = 1 + getMissingHpAttackSpeedBonusPct(combatant) / 100;
  const slowPenaltyPct = Math.min(90, getAttackSpeedSlowPenaltyPct(combatant));
  const slowMult = 1 - slowPenaltyPct / 100;
  const passiveSpeedPct = (combatant.passiveEffects || []).reduce((sum, e) =>
    e.type === 'attack_speed_bonus_pct' ? sum + (e.value || 0) : sum, 0);
  const activeSpeedPct = (combatant.activeEffects || []).reduce((sum, e) =>
    e.type === 'attack_speed_buff' && (e.remainingTicks || 0) > 0 ? sum + (e.value || 0) : sum, 0);
  const procSpeedMult = 1 + (passiveSpeedPct + activeSpeedPct) / 100;
  const effectiveRate = baseRate * stanceMult * berserkerMult * rapidFireMult * missingHpSpeedMult * slowMult * procSpeedMult;
  if (!Number.isFinite(effectiveRate)) return combatant.isPlayer ? 1 : 0;
  return Math.max(0, effectiveRate);
}

function getReadyAutoAttackCount(combatant, tick = 0, options = {}) {
  const rate = getEffectiveAutoAttackRate(combatant);
  if (rate <= 0) {
    clearAutoAttackSchedule(combatant, { preserveStarted: true });
    return 0;
  }
  const storedProgress = Number.isFinite(combatant.autoAttackProgressTicks)
    ? Math.max(0, combatant.autoAttackProgressTicks)
    : 0;
  const dueBySchedule = combatant.autoAttackStarted
    && Number.isFinite(combatant.nextAutoAttackTick)
    && tick >= combatant.nextAutoAttackTick;
  let progress = storedProgress + rate;
  if (!combatant.autoAttackStarted) {
    combatant.autoAttackStarted = true;
    if (!options.allowOpeningAttack) {
      combatant.autoAttackProgressTicks = Math.min(AUTO_ATTACK_TICKS - 0.001, progress);
      const openingRemaining = Math.max(0, AUTO_ATTACK_TICKS - (combatant.autoAttackProgressTicks || 0));
      combatant.nextAutoAttackTick = tick + getAutoAttackDelayTicks(openingRemaining, rate);
      return 0;
    }
    progress = Math.max(AUTO_ATTACK_TICKS, progress);
  } else if (dueBySchedule) {
    progress = Math.max(AUTO_ATTACK_TICKS, progress);
  }
  const attackCount = Math.min(3, Math.floor(progress / AUTO_ATTACK_TICKS));
  combatant.autoAttackProgressTicks = attackCount > 0 ? progress - attackCount * AUTO_ATTACK_TICKS : progress;
  if (attackCount > 0) combatant.lastAutoAttackTick = tick;
  scheduleNextAutoAttackFromProgress(combatant, tick);
  return attackCount;
}

function getReadyAutoAttackCountForElapsed(combatant, elapsedTicks = 0) {
  const rate = getEffectiveAutoAttackRate(combatant);
  if (rate <= 0) {
    clearAutoAttackSchedule(combatant, { preserveStarted: true });
    return 0;
  }
  const storedProgress = Number.isFinite(combatant.autoAttackProgressTicks)
    ? Math.max(0, combatant.autoAttackProgressTicks)
    : 0;
  let progress = storedProgress + Math.max(0, elapsedTicks) * rate;
  if (!combatant.autoAttackStarted) {
    combatant.autoAttackStarted = true;
  }
  const attackCount = Math.min(3, Math.floor(progress / AUTO_ATTACK_TICKS));
  combatant.autoAttackProgressTicks = attackCount > 0 ? progress - attackCount * AUTO_ATTACK_TICKS : progress;
  if (attackCount > 0) combatant.lastAutoAttackTick = null;
  scheduleNextAutoAttackFromProgress(combatant, 0);
  return attackCount;
}

function getAutoAttackDelayTicks(remainingProgress, rate) {
  return Math.max(1, Math.ceil(Math.max(0, remainingProgress) / Math.max(0.01, rate)));
}

function scheduleNextAutoAttackFromProgress(combatant, tick = 0) {
  const rate = getEffectiveAutoAttackRate(combatant);
  if (rate <= 0) {
    clearAutoAttackSchedule(combatant, { preserveStarted: true });
    return;
  }
  const remainingProgress = Math.max(0, AUTO_ATTACK_TICKS - (combatant.autoAttackProgressTicks || 0));
  combatant.nextAutoAttackTick = tick + getAutoAttackDelayTicks(remainingProgress, rate);
}

function clearAutoAttackSchedule(combatant, options = {}) {
  combatant.autoAttackProgressTicks = 0;
  combatant.lastAutoAttackTick = null;
  combatant.nextAutoAttackTick = null;
  if (!options.preserveStarted) combatant.autoAttackStarted = false;
}

function resetAutoAttackCycle(combatant, tick = 0) {
  const wasStarted = !!combatant.autoAttackStarted;
  combatant.autoAttackProgressTicks = 0;
  if (!wasStarted) {
    combatant.lastAutoAttackTick = null;
    combatant.nextAutoAttackTick = null;
    return;
  }
  const rate = getEffectiveAutoAttackRate(combatant);
  if (rate <= 0) {
    clearAutoAttackSchedule(combatant, { preserveStarted: true });
    return;
  }
  combatant.lastAutoAttackTick = tick;
  scheduleNextAutoAttackFromProgress(combatant, tick);
}

function syncCombatantAutoAttackSchedule(combatant, tick = 0) {
  if (!combatant?.autoAttackStarted) return;
  if (combatant.hp <= 0 || combatant.disableAutoAttack) {
    clearAutoAttackSchedule(combatant, { preserveStarted: true });
    return;
  }
  scheduleNextAutoAttackFromProgress(combatant, tick);
}

function isAutoAttackBarProgressing(combatant, tick = 0) {
  if (!combatant || combatant.hp <= 0 || combatant.disableAutoAttack) return false;
  if (isStunned(combatant, tick)) return false;
  if (getEffectiveAutoAttackRate(combatant) <= 0) return false;
  return !!combatant.autoAttackStarted
    || (combatant.autoAttackProgressTicks || 0) > 0
    || Number.isFinite(combatant.nextAutoAttackTick);
}

function prepareBasicAttack(combatant, defender, rng, opts = {}) {
  const variance = Math.floor(rng() * 4);
  const swordStance = getActiveSwordStance(combatant);
  const heavyStrikes = getActiveHeavyStrikes(combatant);
  const berserkerStance = getActiveBerserkerStance(combatant);
  const rapidFire = getActiveRapidFire(combatant);
  const maceMastery = getActiveMaceMastery(combatant);
  const hunterMark = (defender.activeEffects || []).find(e => e.type === 'hunter_mark' && (e.remainingTicks || 0) > 0);
  const swordStanceCritBonus = swordStance && isTargetBleeding(defender)
    ? swordStance.bleedingCritChanceBonusPct || 10
    : 0;
  const berserkerCritBonus = berserkerStance?.critChanceBonusPct || 0;
  const hunterMarkCritBonus = hunterMark?.autoCritBonusPct || 0;
  const passiveCritBonus = (combatant.passiveEffects || []).reduce((sum, e) =>
    e.type === 'crit_chance_bonus' ? sum + (e.value || 0) : sum, 0);
  const activeCritBonus = (combatant.activeEffects || []).reduce((sum, e) =>
    e.type === 'crit_chance_buff' && isEffectActive(e) ? sum + (e.value || 0) : sum, 0);
  const passiveForceCrit = (combatant.passiveEffects || []).some(e => e.type === 'force_crit');
  const activeForceCrit = (combatant.activeEffects || []).some(e => e.type === 'force_crit' && isEffectActive(e));
  const firstHitForceCrit = !!(opts.procState && !opts.procState.firstHitFired
    && (combatant.passiveEffects || []).some(e => e.type === 'first_hit_force_crit'));
  const forceCrit = passiveForceCrit || activeForceCrit || firstHitForceCrit || !!(combatant.isPlayer && opts.procState?.forcedNextCrit);
  if (combatant.isPlayer && opts.procState?.forcedNextCrit) opts.procState.forcedNextCrit = false;
  const rawCritChance = (combatant.critChance || 0) + swordStanceCritBonus + berserkerCritBonus + hunterMarkCritBonus + passiveCritBonus + activeCritBonus;
  const critChance = getEffectiveCritChance(rawCritChance, defender);
  const critResist = getCritResistPct(defender);
  const isCrit = forceCrit || (critChance > 0 && rng() * 100 < critChance);
  const armorDebuffCritDamageBonusPct = hasArmorDebuff(defender) ? getCritDamageVsArmorDebuffPct(combatant) : 0;
  const markCritDamageBonusPct = getCritDamagePerMarkBonusPct(combatant, defender);
  const critDamageBonusPct = getCritDamageBonusPct(combatant) + armorDebuffCritDamageBonusPct + markCritDamageBonusPct;
  const critMult = (combatant.critMult || 1.5) * (1 + critDamageBonusPct / 100);
  const damageMult = getOutgoingDamageMult(combatant);
  if (swordStance) consumeSwordStanceCharge(combatant);
  if (heavyStrikes) consumeHeavyStrikesCharge(combatant);
  const consumedBerserkerStance = berserkerStance?.chargesLeft > 0 ? consumeBerserkerStanceCharge(combatant) : null;
  const consumedRapidFire = rapidFire ? consumeRapidFireCharge(combatant) : null;
  const consumedMaceMastery = maceMastery ? consumeMaceMasteryCharge(combatant) : null;

  const sunderIdx = (combatant.activeEffects || []).findIndex(e => e.type === 'sunder_armor' && (e.chargesLeft || 0) > 0);
  const sunder = sunderIdx >= 0 ? combatant.activeEffects[sunderIdx] : null;
  if (sunder) {
    if (sunder.chargesLeft <= 1) {
      combatant.activeEffects.splice(sunderIdx, 1);
    } else {
      combatant.activeEffects[sunderIdx] = { ...sunder, chargesLeft: sunder.chargesLeft - 1 };
    }
  }
  const sunderDamageMult = sunder ? (1 + (sunder.damageBonusPct || 20) / 100) : 1;
  const sunderArmorPen = sunder ? (sunder.armorPenPct || 10) : 0;

  const serratedIdx = (combatant.activeEffects || []).findIndex(e => e.type === 'serrated_strikes' && (e.chargesLeft || 0) > 0);
  const serrated = serratedIdx >= 0 ? combatant.activeEffects[serratedIdx] : null;
  if (serrated) {
    if (serrated.chargesLeft <= 1) {
      combatant.activeEffects.splice(serratedIdx, 1);
    } else {
      combatant.activeEffects[serratedIdx] = { ...serrated, chargesLeft: serrated.chargesLeft - 1 };
    }
  }
  const serratedDamageMult = serrated ? (1 + (serrated.damageBonusPct || 5) / 100) : 1;
  const serratedBleedChancePct = serrated ? (serrated.bleedChancePct || 100) : 0;
  const swordStanceBleedChancePct = swordStance ? (swordStance.bleedChancePct || 0) : 0;
  const passiveBleedChancePct = getPassiveAutoBleedChancePct(combatant);
  const bleedChancePct = Math.min(100, serratedBleedChancePct + swordStanceBleedChancePct + passiveBleedChancePct);
  const heavyStrikesDamageMult = heavyStrikes ? (1 + (heavyStrikes.damageBonusPct || 20) / 100) : 1;
  const berserkerDamageBonusPct = berserkerStance?.damageBonusPct ?? berserkerStance?.damageDealtPct ?? 0;
  const berserkerDamageMult = berserkerStance ? (1 + berserkerDamageBonusPct / 100) : 1;
  const hunterMarkDamageMult = hunterMark ? (1 + (hunterMark.autoDamageBonusPct || 30) / 100) : 1;
  const sniperPatiencePct = combatant.isPlayer ? Math.max(0, opts.procState?.sniperPatiencePct || 0) : 0;
  const sniperPatienceMult = 1 + sniperPatiencePct / 100;

  const powerBreakIdx = (defender.activeEffects || []).findIndex(e => e.type === 'power_shot_armor_break' && (e.attacksRemaining || 0) > 0);
  const powerBreak = powerBreakIdx >= 0 ? defender.activeEffects[powerBreakIdx] : null;
  if (powerBreak) {
    if (powerBreak.attacksRemaining <= 1) {
      defender.activeEffects.splice(powerBreakIdx, 1);
    } else {
      defender.activeEffects[powerBreakIdx] = { ...powerBreak, attacksRemaining: powerBreak.attacksRemaining - 1 };
    }
  }
  const powerBreakArmorPen = powerBreak ? (powerBreak.armorPenPct || 30) : 0;
  const passiveArmorPen = getPassiveArmorPenPct(combatant);
  const diceRoll = combatant.weaponDamageDice ? rollDice(combatant.weaponDamageDice, rng) : null;
  const diceAverage = combatant.weaponDamageDice ? getDiceAverage(combatant.weaponDamageDice) : 0;
  const diceDelta = diceRoll == null
    ? 0
    : Math.round((diceRoll - diceAverage) * (combatant.weaponDamageMult || 1));
  const attackDamageBase = Math.max(0, (combatant.damage || 0) + diceDelta);
  const backRowDamageMult = getBackRowMeleeDamageMult(combatant, opts.frontId);
  const targetFrontDamageMult = getTargetFrontDamageMult(combatant, defender, opts);
  const targetDamageBonusPct = getDamageVsTargetPct(combatant, defender);
  const baseMultipliedDamage = (attackDamageBase + variance) * damageMult * sunderDamageMult * serratedDamageMult * heavyStrikesDamageMult * berserkerDamageMult * hunterMarkDamageMult * sniperPatienceMult * backRowDamageMult * targetFrontDamageMult * (isCrit ? critMult : 1);

  const damage = attackDamageBase <= 0
    ? 0
    : Math.max(1, Math.floor(baseMultipliedDamage * (100 + targetDamageBonusPct) / 100));

  consumeAttackSpeedSlowCharge(combatant);

  return {
    damage,
    meta: {
      isCrit,
      critChance,
      rawCritChance,
      critResist,
      rageGainFlat: combatant.rageGainFlat || 0,
      armorPenPct: Math.min(100, passiveArmorPen + Math.max(sunderArmorPen, powerBreakArmorPen)),
      serratedBleedChancePct: bleedChancePct,
      swordStanceCritBonus,
      berserkerCritBonus,
      hunterMarkCritBonus,
      berserkerStanceRefundEffect: consumedBerserkerStance,
      rapidFireRefundEffect: consumedRapidFire,
      maceMasteryEffect: consumedMaceMastery,
      serratedEffect: serrated,
      weaponDamageRoll: diceRoll,
      weaponDamageDice: combatant.weaponDamageDice?.text || null,
      backRowPenalty: backRowDamageMult < 1,
      backRowDamageMult,
      targetFrontPenalty: targetFrontDamageMult < 1,
      targetFrontDamageMult,
      targetDamageBonusPct,
      critDamageBonusPct,
      armorDebuffCritDamageBonusPct,
      sniperPatiencePct,
    },
  };
}

function createBasicAttackImpact(combatant, defender, tick, rng, actionType = ACTION.BASIC_ATTACK, opts = {}) {
  const prepared = prepareBasicAttack(combatant, defender, rng, opts);
  return {
    actorId: combatant.id,
    targetId: defender?.id || null,
    type: actionType,
    startTick: tick,
    impactTick: tick,
    damage: prepared.damage,
    ...prepared.meta,
  };
}

function resolveCombatAction(combatant, requestedAction, tick) {
  return requestedAction || ACTION.NONE;
}

function applyEnemyBleed(enemy, tick, log, attacker = null, procState = null) {
  if (isBleedImmune(enemy)) {
    log.push(makeEntry(tick, 'hero', 'immune', `${enemy.name} is immune to Bleeding.`, 0, null, null));
    return;
  }
  const dotDmgMult = getRelicDotDamageMult(procState);
  const dotDurBonus = getRelicDotDurationBonus(procState);
  const damagePctPerTick = applyBleedDamageBonus(attacker, 1.15) * dotDmgMult;
  const refreshTicks = getPlayerBleedRefreshTicks(attacker) + dotDurBonus;
  const existing = (enemy.activeEffects || []).find(e => e.type === 'bleed');
  if (existing) {
    existing.remainingTicks = Math.max(existing.remainingTicks || 0, refreshTicks);
    existing.stacks = Math.min(6, (existing.stacks || 1) + 1);
    existing.damagePctPerTick = Math.max(existing.damagePctPerTick || 0, damagePctPerTick);
  } else {
    enemy.activeEffects.push({ type: 'bleed', remainingTicks: refreshTicks, stacks: 1, damagePctPerTick });
  }
  const bleed = (enemy.activeEffects || []).find(e => e.type === 'bleed');
  const stacks = bleed?.stacks || 1;
  log.push(makeEntry(tick, 'hero', 'bleed', `Status: ${enemy.name} gains Bleeding (${stacks} stack${stacks !== 1 ? 's' : ''}).`, 0, null, null));
}

function resolveBasicAttackImpact(action, attacker, defender, tick, log, rng, hero, enemy, heroResources, heroConditions, heroWounds, procState = null, heroProcNodes = [], opts = {}) {
  // Secondary chance rolls (relics, enchantments, double-hit, bleed) use the
  // isolated proc RNG so they don't shift the shared combat RNG sequence.
  const procRng = procState?.procRng || rng;
  // In duel mode the enemy has its own proc RNG (symmetric to the player's).
  // Fall back to opts.enemyProcRng (the raw enemy-side proc RNG from procRngBySide.enemy) when
  // enemyProcState is null (opponent has no proc nodes) — prevents using hero's procRng instead,
  // which would diverge because each client's "hero" uses a different seed.
  const enemyAttackerProcRng = opts.enemyProcState?.procRng || opts.enemyProcRng || procRng;
  const defenderStunBefore = defender?.stunUntilTick ?? -1;
  const attackerIsHero = attacker?.id === 'hero' && attacker?.isPlayer;
  const attackerIsAlly = !!attacker?.isAlly;
  const defenderIsHero = defender?.id === 'hero' && defender?.isPlayer;
  const defenderIsAlly = !!defender?.isAlly;
  const targetMeta = {
    targetId: defender?.id || action?.targetId || null,
    extraHit: !!action?.extraHit,
    extraHitSource: action?.extraHitSource || null,
    backRowPenalty: !!action?.backRowPenalty,
    backRowDamageMult: action?.backRowDamageMult ?? 1,
    targetFrontPenalty: !!action?.targetFrontPenalty,
    targetFrontDamageMult: action?.targetFrontDamageMult ?? 1,
    critChance: action?.critChance,
    rawCritChance: action?.rawCritChance,
    critResist: action?.critResist,
  };
  if (attackerIsHero && procState) {
    procState.heroAttackedThisTick = true;
    procState.sniperPatiencePct = 0;
  }
  const forcedAutoMiss = (attacker.activeEffects || []).find(effect =>
    effect.type === 'force_next_auto_miss' && (effect.attacksRemaining || 0) > 0);
  if (forcedAutoMiss) {
    attacker.activeEffects = (attacker.activeEffects || [])
      .map(effect => effect !== forcedAutoMiss ? effect : { ...effect, attacksRemaining: effect.attacksRemaining - 1 })
      .filter(effect => effect.type !== 'force_next_auto_miss' || (effect.attacksRemaining || 0) > 0);
    consumeAttackBasedEffects(attacker);
    const missSourceName = forcedAutoMiss.sourceAbilityName || 'Covering Fire';
    const text = attackerIsHero
      ? `${missSourceName} causes your auto attack to miss ${defender.name}.`
      : defenderIsHero
        ? `${attacker.name}'s auto attack misses under ${missSourceName}.`
        : `${attacker.name}'s auto attack misses ${defender.name}.`;
    log.push(makeEntry(tick, action.actorId, 'miss', text, 0, hero.hp, enemy?.hp, {
      ...targetMeta,
      forcedMiss: true,
      abilityId: forcedAutoMiss.sourceAbilityId || null,
    }));
    return;
  }
  const hitChance = attackerIsHero && procState?.guaranteedNextHit ? 100 : getHitChance(attacker);
  if (attackerIsHero && procState?.guaranteedNextHit) procState.guaranteedNextHit = false;
  consumeAttackBasedEffects(attacker);
  if (rng() * 100 >= hitChance) {
    const missHandTag = action.isOffhand ? '[OH] ' : action.isMainHand ? '[MH] ' : '';
    const text = attackerIsHero
      ? `${missHandTag}You miss ${defender.name}.`
      : defenderIsHero
        ? `${attacker.name} misses you.`
        : `${attacker.name} misses ${defender.name}.`;
    log.push(makeEntry(tick, action.actorId, 'miss', text, 0, hero.hp, enemy.hp, { ...targetMeta, isMainHand: !!action.isMainHand, isOffhand: !!action.isOffhand }));
    if (attackerIsHero && procState) {
      procState.consecutiveHits = 0;
      procState.consecutiveCrits = 0;
      if ((hero.passiveEffects || []).some(e => e.type === 'frenzy_stack')) procState.frenzyStacks = 0;
      fireProcTrigger('on_miss', {}, procState, heroProcNodes, hero, enemy, tick, log, rng);
      loseMomentumOnHeroAutoMiss(procState, hero, enemy, tick, log);
      syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, opts.allies || []);
    } else if (defender.isPlayer && procState) {
      fireProcTrigger('on_avoid', { avoidType: 'miss' }, procState, heroProcNodes, hero, enemy, tick, log, rng);
      syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, opts.allies || []);
    }
    return;
  }
  const defenseEffectivenessPct = getDefenseEffectivenessPct(attacker);
  const evasionChance = Math.floor(getEvasionChancePct(defender) * defenseEffectivenessPct / 100);
  const shadowVeil = getActiveShadowVeil(defender);
  if ((action.damage || 0) > 0 && evasionChance > 0) {
    if (shadowVeil) consumeShadowVeilAttack(defender);
    if (rng() * 100 < evasionChance) {
      const text = defenderIsHero
        ? `You dodge ${attacker.name}'s attack.`
        : `${defender.name} dodges ${attackerIsHero ? 'your' : `${attacker.name}'s`} attack.`;
      log.push(makeEntry(tick, defender.id, 'dodged', text, 0, hero.hp, enemy.hp, {
        evasionChance,
        defenseEffectivenessPct,
        ...targetMeta,
      }));
      if (defender.isPlayer && procState) {
        fireProcTrigger('on_dodge', {}, procState, heroProcNodes, hero, enemy, tick, log, rng);
        fireProcTrigger('on_avoid', { avoidType: 'dodge' }, procState, heroProcNodes, hero, enemy, tick, log, rng);
        syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, opts.allies || []);
      }
      if (shadowVeil && defender.hp > 0 && attacker.hp > 0) {
        const rawDamage = Math.max(1, Math.floor((defender.damage || 0) * (shadowVeil.counterDamageMult || 0.5)));
        const dmg = Math.max(1, applyArmor(rawDamage, getEffectiveArmor(attacker), getPassiveArmorPenPct(defender)));
        attacker.hp = Math.max(0, attacker.hp - dmg);
        const shotText = defender.isPlayer
          ? `Shadow Veil: you fire back for ${dmg}.`
          : `${defender.name}'s Shadow Veil fires back for ${dmg}.`;
        log.push(makeEntry(tick, defender.id, 'ability', shotText, dmg, hero.hp, enemy.hp, {
          abilityId: shadowVeil.sourceAbilityId || 'shadow_veil',
          element: 'shadow',
        }));
      }
      return;
    }
  }
  const parryChance = hasActiveEnGarde(defender)
    ? 100
    : Math.floor(getParryChancePct(defender) * defenseEffectivenessPct / 100);
  if ((action.damage || 0) > 0 && parryChance > 0) {
    consumeParryGuardAttack(defender);
    if (rng() * 100 < parryChance) {
      const text = defenderIsHero
        ? `You parry ${attacker.name}'s attack.`
        : `${defender.name} parries ${attackerIsHero ? 'your' : `${attacker.name}'s`} attack.`;
        log.push(makeEntry(tick, defender.id, 'parry', text, 0, hero.hp, enemy.hp, {
          parryChance,
          defenseEffectivenessPct,
          ...targetMeta,
        }));
      grantCombatTrigger(defender, 'after_parry');
      if (defender.isPlayer && procState) {
        procState.consecutiveParries += 1;
        procState.parryCountThisTick += 1;
        fireProcTrigger('on_parry', {}, procState, heroProcNodes, hero, enemy, tick, log, rng);
      }
      return;
    }
  }
  if (attackerIsHero && procState) {
    procState.consecutiveParries = 0;
    if ((procState.frenzyStacks || 0) > 0) {
      const frenzyPct = (hero.passiveEffects || []).reduce((max, e) => e.type === 'frenzy_stack' ? Math.max(max, e.value || 0) : max, 0);
      if (frenzyPct > 0) {
        action = { ...action, damage: Math.round(action.damage * (1 + procState.frenzyStacks * frenzyPct / 100)) };
      }
    }
  }
  const reductionPct = getIncomingPhysicalReductionPct(defender);
  const lowHpDamageBonus = getDamageVsLowHpPct(attacker, defender);
  const disruptedDamageBonus = getDamageVsDisruptedPct(attacker, defender, tick);
  const damageTakenBonus = getDamageTakenBonusPct(defender, attacker);
  const totalDamageBonus = lowHpDamageBonus + disruptedDamageBonus + damageTakenBonus;
  let adjustedAction = totalDamageBonus > 0
    ? { ...action, damage: Math.max(1, Math.floor(action.damage * (1 + totalDamageBonus / 100))) }
    : action;
  adjustedAction = reductionPct > 0
    ? { ...adjustedAction, damage: Math.max(1, Math.floor(adjustedAction.damage * (1 - reductionPct / 100))) }
    : adjustedAction;
  if (reductionPct > 0) {
    const text = defender.isPlayer
      ? `You harden up and reduce the blow by ${reductionPct}%.`
      : `${defender.name} hardens up and reduces the blow by ${reductionPct}%.`;
    log.push(makeEntry(tick, defender.id, 'guard', text, 0, hero.hp, enemy.hp, {
      reductionPct,
      ...targetMeta,
    }));
  }
  if (defenderIsHero && procState?.stonewallFirstBlockReady) {
    procState.stonewallFirstBlockReady = false;
    defender.activeEffects = defender.activeEffects || [];
    defender.activeEffects.push({ type: 'shield_up', attacksRemaining: 1, counterDamageMult: 1.0 });
  } else if (defender?.isDuelPlayer && opts.enemyProcState?.stonewallFirstBlockReady) {
    opts.enemyProcState.stonewallFirstBlockReady = false;
    defender.activeEffects = defender.activeEffects || [];
    defender.activeEffects.push({ type: 'shield_up', attacksRemaining: 1, counterDamageMult: 1.0 });
  }
  const result = resolveImpact(adjustedAction, defender, {
    rng,
    armorPenPct: adjustedAction.armorPenPct || 0,
    incomingAutoAttack: true,
    blockEffectivenessPct: defenseEffectivenessPct,
    dodgeEffectivenessPct: defenseEffectivenessPct,
  });
  if (!result.dodged) consumeIncomingDamageReductionAttack(defender);
  if (result.dodged) {
    const dodgeHandTag = action.isOffhand ? '[OH] ' : action.isMainHand ? '[MH] ' : '';
    const text = attackerIsHero
      ? `${dodgeHandTag}${defender.name} dodges your attack!`
      : defenderIsHero
        ? 'You dodge the attack!'
        : `${defender.name} dodges ${attacker.name}'s attack!`;
    log.push(makeEntry(tick, action.actorId, 'dodged', text, 0, hero.hp, enemy.hp, { ...targetMeta, isMainHand: !!action.isMainHand, isOffhand: !!action.isOffhand }));
  } else if (result.blocked) {
    if (attackerIsHero) {
      const _blockedDmg = enemy.physicalDmgReductionPct > 0 ? Math.max(0, Math.floor(result.damage * (1 - enemy.physicalDmgReductionPct / 100))) : result.damage;
      const applied = applyCombatantDamage(enemy, _blockedDmg);
      const critText = action.isCrit ? ' Critical hit!' : '';
      const blockSource = result.shieldUp ? 'Shield Up' : 'Block Power';
      const blockHandTag = action.isOffhand ? '[OH] ' : action.isMainHand ? '[MH] ' : '';
      log.push(makeEntry(tick, 'hero', 'blocked', `${blockHandTag}${defender.name} blocks ${result.absorbed || 0} with ${blockSource}. You deal ${applied.damage}.${critText}`, applied.damage, hero.hp, enemy.hp, {
        isCrit: !!action.isCrit,
        absorbed: result.absorbed || 0,
        shieldAbsorbed: applied.absorbed || 0,
        recovered: result.recovered || 0,
        isMainHand: !!action.isMainHand,
        isOffhand: !!action.isOffhand,
        ...targetMeta,
      }));
      logDamageShieldAbsorb(enemy, applied, tick, log, hero, enemy, targetMeta);
      applyHeroLifesteal(hero, applied.damage, tick, log, enemy, targetMeta);
      if (applied.damage > 0) applyCombatantStateHitReaction(hero, defender, tick, log, hero, enemy, procState);
      tryShieldUpCounter(enemy, hero, result, tick, log, hero, enemy);
      const impactPct = getImpactOnBlockPct(hero);
      if (impactPct > 0 && enemy.hp > 0) {
        const impactBase = result.damage + (result.absorbed || 0);
        const impactDmg = Math.max(1, Math.floor(impactBase * impactPct / 100));
        const impactApplied = applyCombatantDamage(enemy, impactDmg);
        log.push(makeEntry(tick, 'hero', 'impact', `Impact: ${impactApplied.damage} damage carries through the block!`, impactApplied.damage, hero.hp, enemy.hp, {
          ...targetMeta,
          shieldAbsorbed: impactApplied.absorbed || 0,
        }));
        logDamageShieldAbsorb(enemy, impactApplied, tick, log, hero, enemy, targetMeta);
      }
      gainHeroRage(procState, action, tick);
      recordHeroCritLanded(procState, action, applied.damage);
      tryAddBerserkerCritCharge(hero, action);
      tryAddRapidFireCritCharge(hero, action);
      if (action.isCrit) grantCombatTrigger(hero, 'after_crit');
      grantCombatTrigger(defender, 'after_block');
      tryApplyOnHitEffects(hero, enemy, tick, log, rng, null, { ...action, serratedEffect: null }, { allowBleed: applied.damage > 0, allowPoison: applied.damage > 0, procState, procRng });
      tryCounter(enemy, hero, tick, log, rng, hero, enemy);
      consumeNextHitEffects(hero);
      if (applied.damage > 0) trackPetFlankingHit(hero, hero, procState, tick, log, defender);
    } else if (attackerIsAlly) {
      const applied = applyCombatantDamage(defender, result.damage);
      const critText = action.isCrit ? ' Critical hit!' : '';
      const blockSource = result.shieldUp ? 'Shield Up' : 'Block Power';
      log.push(makeEntry(tick, attacker.id, 'blocked', `${defender.name} blocks ${result.absorbed || 0} with ${blockSource}. ${attacker.name} deals ${applied.damage}.${critText}`, applied.damage, hero.hp, defender.hp, {
        isCrit: !!action.isCrit,
        absorbed: result.absorbed || 0,
        shieldAbsorbed: applied.absorbed || 0,
        recovered: result.recovered || 0,
        ...targetMeta,
      }));
      logDamageShieldAbsorb(defender, applied, tick, log, hero, defender, targetMeta);
      applyLifeDrain(attacker, applied.damage, tick, log, hero, defender);
      if (applied.damage > 0) applyCombatantStateHitReaction(attacker, defender, tick, log, hero, defender, procState);
      tryShieldUpCounter(defender, attacker, result, tick, log, hero, defender);
      tryAddBerserkerCritCharge(attacker, action);
      tryAddRapidFireCritCharge(attacker, action);
      if (action.isCrit) grantCombatTrigger(attacker, 'after_crit');
      grantCombatTrigger(defender, 'after_block');
      tryApplyOnHitEffects(attacker, defender, tick, log, rng, null, { ...action, serratedEffect: null }, { allowBleed: applied.damage > 0, allowPoison: applied.damage > 0, procState, procRng });
      tryCounter(defender, attacker, tick, log, rng, hero, defender);
      consumeNextHitEffects(attacker);
      if (applied.damage > 0) {
        trackPetFlankingHit(attacker, hero, procState, tick, log, defender);
        grantHeroCritFromPetHit(attacker, hero, tick, log, defender, applied.damage);
        grantHeroRageFromPetHit(attacker, hero, procState, applied.damage, false);
      }
    } else if (defenderIsAlly) {
      const applied = applyCombatantDamage(defender, result.damage);
      const blockSource = result.shieldUp ? 'Shield Up' : 'Block Power';
      log.push(makeEntry(tick, attacker.id, 'blocked', `${defender.name} blocks ${result.absorbed || 0} with ${blockSource} and takes ${applied.damage}.`, applied.damage, hero.hp, attacker.hp, {
        absorbed: result.absorbed || 0,
        shieldAbsorbed: applied.absorbed || 0,
        recovered: result.recovered || 0,
        ...targetMeta,
      }));
      logDamageShieldAbsorb(defender, applied, tick, log, hero, attacker, targetMeta);
      tryAddBerserkerCritCharge(attacker, action);
      tryAddRapidFireCritCharge(attacker, action);
      grantCombatTrigger(defender, 'after_block');
      applyLifeDrain(attacker, applied.damage, tick, log, hero, attacker);
      tryApplyOnHitEffects(attacker, defender, tick, log, rng, null, action, { allowBleed: applied.damage > 0, allowPoison: applied.damage > 0, procRng });
      tryCounter(defender, attacker, tick, log, rng, hero, attacker);
    } else {
      hero.hp = Math.max(0, hero.hp - result.damage);
      const blockSource = result.shieldUp ? 'Shield Up' : 'Block Power';
      log.push(makeEntry(tick, attacker.id, 'blocked', `You block ${result.absorbed || 0} with ${blockSource}. You take ${result.damage}.`, result.damage, hero.hp, enemy.hp, {
        absorbed: result.absorbed || 0,
        recovered: result.recovered || 0,
        ...targetMeta,
      }));
      tryAddBerserkerCritCharge(enemy, action);
      tryAddRapidFireCritCharge(enemy, action);
      grantCombatTrigger(hero, 'after_block');
      if (procState) {
        procState.hasTakenDamageThisFight = true;
        procState.consecutiveBlocks += 1;
        fireProcTrigger('on_block', { damage: result.damage }, procState, heroProcNodes, hero, enemy, tick, log, rng);
        fireProcTrigger('on_take_damage', { damage: result.damage, isCrit: !!action.isCrit, attacker }, procState, heroProcNodes, hero, enemy, tick, log, rng);
      }
      tryShieldUpCounter(hero, enemy, result, tick, log, hero, enemy);
      applyLifeDrain(attacker, result.damage, tick, log, hero, enemy);
      tryApplyOnHitEffects(enemy, hero, tick, log, rng, heroConditions, action, { allowBleed: result.damage > 0, allowPoison: result.damage > 0, procRng: enemyAttackerProcRng });
      tryCounter(hero, enemy, tick, log, rng, hero, enemy);
      maybeInflictDeepCut(enemy, hero, result.damage, false, tick, log, heroWounds, enemyAttackerProcRng);
    }
  } else {
    if (attackerIsHero) {
      // Release grudge as bonus damage
      if (procState && (procState.grudge || 0) > 0 && enemy.hp > 0) {
        const grudgeDmg = Math.max(1, procState.grudge);
        const grudgeApplied = applyCombatantDamage(enemy, grudgeDmg);
        log.push(makeEntry(tick, 'hero', 'hit', `Grudge released: ${grudgeApplied.damage} bonus damage!`, grudgeApplied.damage, hero.hp, enemy.hp, {
          ...targetMeta,
          shieldAbsorbed: grudgeApplied.absorbed || 0,
        }));
        logDamageShieldAbsorb(enemy, grudgeApplied, tick, log, hero, enemy, targetMeta);
        procState.grudge = 0;
      }
      const _hitDmg = enemy.physicalDmgReductionPct > 0 ? Math.max(0, Math.floor(result.damage * (1 - enemy.physicalDmgReductionPct / 100))) : result.damage;
      const applied = applyCombatantDamage(enemy, _hitDmg);
      const hitHandTag = action.isOffhand ? '[OH] ' : action.isMainHand ? '[MH] ' : '';
      const offhandReductionNote = action.isOffhand && action.preReductionDamage != null
        ? ` (${action.preReductionDamage}→${Math.round((action.offhandDamageMult ?? 0.5) * 100)}%)`
        : '';
      log.push(makeEntry(tick, 'hero', 'hit', `${hitHandTag}You hit ${defender.name} for ${applied.damage}${action.isCrit ? ' (CRIT)' : ''}${offhandReductionNote}.`, applied.damage, hero.hp, enemy.hp, {
        isCrit: !!action.isCrit,
        shieldAbsorbed: applied.absorbed || 0,
        isMainHand: !!action.isMainHand,
        isOffhand: !!action.isOffhand,
        ...targetMeta,
      }));
      logDamageShieldAbsorb(enemy, applied, tick, log, hero, enemy, targetMeta);
      applyHeroLifesteal(hero, applied.damage, tick, log, enemy, targetMeta);
      if (applied.damage > 0) applyCombatantStateHitReaction(hero, defender, tick, log, hero, enemy, procState);
      breakBearTrapOnAutoAttack(defender, tick, log, hero, enemy);
      if (applied.damage > 0) {
        const channeledHealIdx = (defender.activeEffects || []).findIndex(e => e.type === 'channeled_heal');
        if (channeledHealIdx >= 0) {
          const ch = defender.activeEffects[channeledHealIdx];
          defender.activeEffects.splice(channeledHealIdx, 1);
          log.push(makeEntry(tick, 'hero', 'interrupt',
            `Your hit interrupts ${defender.name}'s ${ch.sourceAbilityName || 'Healing Seal'}!`,
            0, hero.hp, enemy.hp, { abilityId: ch.sourceAbilityId || null, interrupted: true }));
        }
      }
      gainHeroRage(procState, action, tick);
      recordHeroCritLanded(procState, action, applied.damage);
      tryAddBerserkerCritCharge(hero, action);
      tryAddRapidFireCritCharge(hero, action);
      if (action.isCrit) grantCombatTrigger(hero, 'after_crit');
      tryApplyOnHitEffects(hero, enemy, tick, log, rng, null, { ...action, serratedEffect: null }, { allowBleed: applied.damage > 0, allowPoison: applied.damage > 0, procState, procRng });
      if (applied.damage > 0 && (action.serratedBleedChancePct || 0) > 0 && enemy.hp > 0 && procRng() * 100 < action.serratedBleedChancePct) {
        applyEnemyBleed(enemy, tick, log, hero, procState);
      }
      tryCounter(enemy, hero, tick, log, rng, hero, enemy);
      if (procState) {
        const isFirstHit = !procState.firstHitFired;
        procState.consecutiveHits += 1;
        if ((hero.passiveEffects || []).some(e => e.type === 'frenzy_stack')) {
          procState.frenzyStacks = (procState.frenzyStacks || 0) + 1;
        }
        if (action.isCrit) {
          procState.consecutiveCrits += 1;
        } else {
          procState.consecutiveCrits = 0;
        }
        fireProcTrigger('on_hit', { damage: applied.damage, isCrit: !!action.isCrit }, procState, heroProcNodes, hero, enemy, tick, log, rng);
        if (action.isCrit) {
          fireProcTrigger('on_crit', { damage: applied.damage }, procState, heroProcNodes, hero, enemy, tick, log, rng);
        }
        if (isFirstHit) {
          procState.firstHitFired = true;
          applyFirstHitCritDamageBuff(hero, tick, log, enemy);
          fireProcTrigger('on_first_hit', { damage: applied.damage }, procState, heroProcNodes, hero, enemy, tick, log, rng);
        }
      }
      consumeNextHitEffects(hero);
      if (applied.damage > 0) trackPetFlankingHit(hero, hero, procState, tick, log, defender);
      if (!action.skipDoubleHit && enemy.hp > 0) {
        const doubleHitChance = getDoubleHitChancePct(hero);
        if (doubleHitChance > 0 && rng() * 100 < doubleHitChance) {
          const bonusAttack = {
            ...createBasicAttackImpact(hero, enemy, tick, rng, ACTION.BASIC_ATTACK, opts),
            skipDoubleHit: true,
            extraHit: true,
            extraHitSource: 'double_hit',
          };
          resolveBasicAttackImpact(bonusAttack, hero, enemy, tick, log, rng, hero, enemy, heroResources, heroConditions, heroWounds, procState, heroProcNodes, opts);
        }
      }
      syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, opts.allies || []);
      // Relic on-hit effects (armor_reduce_on_hit, burn_on_crit, poison_on_hit)
      if (applied.damage > 0 && enemy.hp > 0 && procState) {
        for (const relic of procState.activeRelics || []) {
          const p = relic?.relicPassive;
          if (!p) continue;
          if (p.type === 'armor_reduce_on_hit' && procRng() * 100 < (p.chance || 0)) {
            const dur = Math.round((p.durationSecs || 4) * 1000 / TICK_MS);
            enemy.activeEffects = (enemy.activeEffects || []).filter(e => e.type !== 'armor_debuff_relic');
            enemy.activeEffects.push({ type: 'armor_debuff_relic', value: p.reduction || 3, remainingTicks: dur, label: 'Infernal Fang' });
            log.push(makeEntry(tick, 'hero', 'proc', `Infernal Fang: -${p.reduction || 3} armor to ${enemy.name}.`, 0, hero.hp, enemy.hp, {}));
          }
          if (p.type === 'burn_on_crit' && action.isCrit) {
            const burnTicks = Math.round((p.burnDurationSecs || 2) * 1000 / TICK_MS);
            enemy.activeEffects = (enemy.activeEffects || []).filter(e => !(e.type === 'burning' && e.source === 'relic_igneous_scale'));
            enemy.activeEffects.push({ type: 'burning', damagePctPerTick: p.burnDamagePct || 3, remainingTicks: burnTicks, source: 'relic_igneous_scale', element: 'fire', label: 'Igneous Scale' });
            log.push(makeEntry(tick, 'hero', 'proc', `Igneous Scale: burn applied to ${enemy.name}!`, 0, hero.hp, enemy.hp, {}));
          }
          if (p.type === 'poison_on_hit' && !isPoisonImmune(enemy) && procRng() * 100 < (p.chance || 0)) {
            const baseDur = Math.max(1, p.duration || 3) + getRelicDotDurationBonus(procState);
            const adjDmgPct = (p.damagePct || 0.4) * getRelicDotDamageMult(procState);
            const currentPoison = (enemy.activeEffects || []).find(e => e.type === 'poison');
            const nextStacks = Math.min(6, (currentPoison?.stacks || 0) + 1);
            const remainingTicks = Math.max(currentPoison?.remainingTicks || 0, baseDur);
            enemy.activeEffects = (enemy.activeEffects || []).filter(e => e.type !== 'poison');
            enemy.activeEffects.push({ type: 'poison', stacks: nextStacks, remainingTicks, damagePctPerTick: Math.max(adjDmgPct, currentPoison?.damagePctPerTick || 0) });
            log.push(makeEntry(tick, 'hero', 'poison', `Queen's Venom: ${enemy.name} gains Poisoned (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}).`, 0, hero.hp, enemy.hp, {}));
          }
        }
        // Enchantment procs (fired once per auto-attack hit)
        for (const e of procState.enchantmentEffects || []) {
          if (!e?.type || !e?.chance) continue;
          if (procRng() * 100 >= e.chance) continue;
          if (e.type === 'fire_proc_on_hit') {
            const dmg = Math.max(1, e.damage || Math.floor(((e.minDamage || 0) + (e.maxDamage || 0)) / 2));
            enemy.hp = Math.max(0, enemy.hp - dmg);
            log.push(makeEntry(tick, 'hero', 'hit', `Ember: ${dmg} fire damage!`, dmg, hero.hp, enemy.hp, { element: 'fire' }));
            if (e.burnGuaranteed || (e.burnChanceBonus && procRng() * 100 < e.burnChanceBonus)) {
              const burnTicks = Math.round(((e.burnDurationSecs || 2) * 1000) / TICK_MS);
              enemy.activeEffects = (enemy.activeEffects || []).filter(eff => !(eff.type === 'burning' && eff.source === 'enchant_ember'));
              enemy.activeEffects.push({ type: 'burning', damagePctPerTick: e.burnDamagePct || 3, remainingTicks: burnTicks, source: 'enchant_ember', element: 'fire' });
            }
          } else if (e.type === 'lightning_proc_on_hit') {
            const dmg = Math.max(1, e.damage || Math.floor(((e.minDamage || 0) + (e.maxDamage || 0)) / 2));
            enemy.hp = Math.max(0, enemy.hp - dmg);
            log.push(makeEntry(tick, 'hero', 'hit', `Storm: ${dmg} lightning damage!`, dmg, hero.hp, enemy.hp, { element: 'lightning' }));
          } else if (e.type === 'armor_reduce_on_hit') {
            const dur = Math.round(((e.durationSecs || 3) * 1000) / TICK_MS);
            const reduction = e.reduction || 2;
            enemy.activeEffects = (enemy.activeEffects || []).filter(eff => eff.type !== 'armor_debuff_enchant');
            enemy.activeEffects.push({ type: 'armor_debuff_enchant', value: reduction, remainingTicks: dur });
            let sunderMsg = `Sunder: -${reduction} armor to ${enemy.name}.`;
            if (e.trueDamage) {
              enemy.hp = Math.max(0, enemy.hp - e.trueDamage);
              sunderMsg += ` ${e.trueDamage} true damage!`;
            }
            log.push(makeEntry(tick, 'hero', 'proc', sunderMsg, e.trueDamage || 0, hero.hp, enemy.hp, {}));
          }
        }
      }
      // Fire duel-enemy defensive procs (on_take_damage, on_take_crit) when the defender is a duel player.
      if (defender.isDuelPlayer && opts.enemyProcState) {
        const eProcState = opts.enemyProcState;
        const eProcNodes = opts.enemyProcNodes || [];
        eProcState.hasTakenDamageThisFight = true;
        fireProcTrigger('on_take_damage', { damage: applied.damage, isCrit: !!action.isCrit, attacker }, eProcState, eProcNodes, defender, hero, tick, log, rng);
        if (action.isCrit) fireProcTrigger('on_take_crit', { damage: applied.damage }, eProcState, eProcNodes, defender, hero, tick, log, rng);
        syncDuelEnemyProcEffects(eProcNodes, eProcState, defender, hero, tick);
      }
    } else if (attackerIsAlly) {
      const applied = applyCombatantDamage(defender, result.damage);
      log.push(makeEntry(tick, attacker.id, 'hit', `${attacker.name} hits ${defender.name} for ${applied.damage}${action.isCrit ? ' (CRIT)' : ''}.`, applied.damage, hero.hp, defender.hp, {
        isCrit: !!action.isCrit,
        shieldAbsorbed: applied.absorbed || 0,
        ...targetMeta,
      }));
      logDamageShieldAbsorb(defender, applied, tick, log, hero, defender, targetMeta);
      applyLifeDrain(attacker, applied.damage, tick, log, hero, defender);
      if (applied.damage > 0) applyCombatantStateHitReaction(attacker, defender, tick, log, hero, defender, procState);
      tryAddBerserkerCritCharge(attacker, action);
      tryAddRapidFireCritCharge(attacker, action);
      if (action.isCrit) grantCombatTrigger(attacker, 'after_crit');
      tryApplyOnHitEffects(attacker, defender, tick, log, rng, null, { ...action, serratedEffect: null }, { allowBleed: applied.damage > 0, allowPoison: applied.damage > 0, procState, procRng });
      tryCounter(defender, attacker, tick, log, rng, hero, defender);
      consumeNextHitEffects(attacker);
      if (applied.damage > 0) {
        trackPetFlankingHit(attacker, hero, procState, tick, log, defender);
        grantHeroCritFromPetHit(attacker, hero, tick, log, defender, applied.damage);
        grantHeroRageFromPetHit(attacker, hero, procState, applied.damage, false);
        // Relic: ally_hit_impetus_stack
        if (procState) {
          for (const relic of procState.activeRelics || []) {
            const p = relic?.relicPassive;
            if (p?.type === 'ally_hit_impetus_stack') {
              procState.impetusStacks = Math.min(p.maxStacks || 3, (procState.impetusStacks || 0) + 1);
            }
          }
        }
      }
    } else if (defenderIsAlly) {
      const incomingDamage = result.damage;
      const applied = applyCombatantDamage(defender, incomingDamage);
      log.push(makeEntry(tick, attacker.id, 'hit', `${attacker.name} hits ${defender.name} for ${applied.damage}${action.isCrit ? ' (CRIT)' : ''}.`, applied.damage, hero.hp, attacker.hp, {
        isCrit: !!action.isCrit,
        shieldAbsorbed: applied.absorbed || 0,
        ...targetMeta,
      }));
      logDamageShieldAbsorb(defender, applied, tick, log, hero, attacker, targetMeta);
      applyLifeDrain(attacker, applied.damage, tick, log, hero, attacker);
      tryAddBerserkerCritCharge(attacker, action);
      tryAddRapidFireCritCharge(attacker, action);
      tryApplyOnHitEffects(attacker, defender, tick, log, rng, null, action, { allowBleed: applied.damage > 0, allowPoison: applied.damage > 0, procRng });
      tryCounter(defender, attacker, tick, log, rng, hero, attacker);
    } else {
      let incomingDamage = result.damage;
      const capPct = getIncomingDamageCapPct(heroProcNodes, procState, hero, enemy, { damage: incomingDamage, isCrit: !!action.isCrit });
      if (capPct != null) {
        const cappedDamage = Math.max(1, Math.floor((hero.maxHp || 0) * capPct / 100));
        incomingDamage = Math.min(incomingDamage, cappedDamage);
      }
      // Earth Ancestral: physical damage reduction
      if (hero.physicalDmgReductionPct > 0 && incomingDamage > 0) {
        incomingDamage = Math.max(0, Math.floor(incomingDamage * (1 - hero.physicalDmgReductionPct / 100)));
      }
      // Relic barrier absorption (Black Armor)
      if (procState?.relicBarrier > 0 && incomingDamage > 0) {
        const barrierAbsorb = Math.min(procState.relicBarrier, incomingDamage);
        procState.relicBarrier = Math.max(0, procState.relicBarrier - barrierAbsorb);
        if (barrierAbsorb > 0) log.push(makeEntry(tick, 'hero', 'proc', `Black Armor: barrier absorbs ${barrierAbsorb} damage.`, 0, hero.hp, enemy.hp, {}));
        incomingDamage = Math.max(0, incomingDamage - barrierAbsorb);
      }
      const heroHpBeforeHit = hero.hp;
      hero.hp = Math.max(0, hero.hp - incomingDamage);
      // Relic barrier trigger on heavy hit
      if (procState && incomingDamage > 0) {
        for (const relic of procState.activeRelics || []) {
          const p = relic?.relicPassive;
          if (p?.type === 'barrier_on_heavy_hit') {
            const threshold = (hero.maxHp || 1) * (p.threshold || 15) / 100;
            if (incomingDamage > threshold && !(procState.relicBarrier > 0)) {
              procState.relicBarrier = p.barrierAmount || 20;
              log.push(makeEntry(tick, 'hero', 'proc', `Black Armor: barrier of ${procState.relicBarrier} damage activated.`, 0, hero.hp, enemy.hp, {}));
            }
          }
        }
      }
      log.push(makeEntry(tick, attacker.id, 'hit', `${attacker.name} hits you for ${incomingDamage}${action.isCrit ? ' (CRIT)' : ''}.`, incomingDamage, hero.hp, enemy.hp, { isCrit: !!action.isCrit, ...targetMeta }));
      applyLifeDrain(attacker, incomingDamage, tick, log, hero, enemy);
      tryAddBerserkerCritCharge(enemy, action);
      tryAddRapidFireCritCharge(enemy, action);
      tryApplyOnHitEffects(enemy, hero, tick, log, rng, heroConditions, action, { procRng: enemyAttackerProcRng });
      tryCounter(hero, enemy, tick, log, rng, hero, enemy);
      maybeInflictDeepCut(enemy, hero, incomingDamage, !!action.isCrit, tick, log, heroWounds, enemyAttackerProcRng);
      if (!action.skipDoubleHit && hero.hp > 0) {
        const doubleHitChance = getDoubleHitChancePct(enemy);
        if (doubleHitChance > 0 && rng() * 100 < doubleHitChance) {
          const bonusAttack = {
            ...createBasicAttackImpact(enemy, hero, tick, rng, ACTION.BASIC_ATTACK, opts),
            skipDoubleHit: true,
            extraHit: true,
            extraHitSource: 'double_hit',
          };
          resolveBasicAttackImpact(bonusAttack, enemy, hero, tick, log, rng, hero, enemy, heroResources, heroConditions, heroWounds, procState, heroProcNodes, opts);
        }
      }
      if (procState) {
        procState.hasTakenDamageThisFight = true;
        procState.consecutiveBlocks = 0;
        gainRageOnTakingHit(procState, incomingDamage, tick);
        fireProcTrigger('on_take_damage', { damage: incomingDamage, isCrit: !!action.isCrit, attacker }, procState, heroProcNodes, hero, enemy, tick, log, rng);
        if (action.isCrit) {
          fireProcTrigger('on_take_crit', { damage: incomingDamage }, procState, heroProcNodes, hero, enemy, tick, log, rng);
        }
        maybeFireHpCrossBelowProcs(heroHpBeforeHit, hero, procState, heroProcNodes, enemy, tick, log, rng);
        preventDeathWithLastBreath(hero, tick, log, enemy, procState);
        syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, opts.allies || []);
        // Fire duel-enemy offensive procs (on_hit, on_crit) when the attacker is a duel player.
        if (attacker.isDuelPlayer && opts.enemyProcState) {
          const eProcState = opts.enemyProcState;
          const eProcNodes = opts.enemyProcNodes || [];
          eProcState.consecutiveHits = (eProcState.consecutiveHits || 0) + 1;
          if (action.isCrit) eProcState.consecutiveCrits = (eProcState.consecutiveCrits || 0) + 1;
          else eProcState.consecutiveCrits = 0;
          fireProcTrigger('on_hit', { damage: incomingDamage, isCrit: !!action.isCrit }, eProcState, eProcNodes, attacker, hero, tick, log, rng);
          if (action.isCrit) fireProcTrigger('on_crit', { damage: incomingDamage }, eProcState, eProcNodes, attacker, hero, tick, log, rng);
          syncDuelEnemyProcEffects(eProcNodes, eProcState, attacker, hero, tick);
          // Relic and enchantment on-hit procs for the duel enemy attacker.
          // Must mirror the hero-attacker block (lines above) so both sides consume
          // the same number of calls from their respective procRng streams.
          if (incomingDamage > 0 && hero.hp > 0) {
            for (const relic of eProcState.activeRelics || []) {
              const p = relic?.relicPassive;
              if (!p) continue;
              if (p.type === 'armor_reduce_on_hit' && enemyAttackerProcRng() * 100 < (p.chance || 0)) {
                const dur = Math.round((p.durationSecs || 4) * 1000 / TICK_MS);
                hero.activeEffects = (hero.activeEffects || []).filter(e => e.type !== 'armor_debuff_relic');
                hero.activeEffects.push({ type: 'armor_debuff_relic', value: p.reduction || 3, remainingTicks: dur, label: 'Infernal Fang' });
                log.push(makeEntry(tick, attacker.id, 'proc', `Infernal Fang: -${p.reduction || 3} armor to ${hero.name}.`, 0, hero.hp, enemy.hp, {}));
              }
              if (p.type === 'burn_on_crit' && action.isCrit) {
                const burnTicks = Math.round((p.burnDurationSecs || 2) * 1000 / TICK_MS);
                hero.activeEffects = (hero.activeEffects || []).filter(e => !(e.type === 'burning' && e.source === 'relic_igneous_scale'));
                hero.activeEffects.push({ type: 'burning', damagePctPerTick: p.burnDamagePct || 3, remainingTicks: burnTicks, source: 'relic_igneous_scale', element: 'fire', label: 'Igneous Scale' });
                log.push(makeEntry(tick, attacker.id, 'proc', `Igneous Scale: burn applied to ${hero.name}!`, 0, hero.hp, enemy.hp, {}));
              }
              if (p.type === 'poison_on_hit' && !isPoisonImmune(hero) && enemyAttackerProcRng() * 100 < (p.chance || 0)) {
                const baseDur = Math.max(1, p.duration || 3) + getRelicDotDurationBonus(eProcState);
                const adjDmgPct = (p.damagePct || 0.4) * getRelicDotDamageMult(eProcState);
                const currentPoison = (hero.activeEffects || []).find(e => e.type === 'poison');
                const nextStacks = Math.min(6, (currentPoison?.stacks || 0) + 1);
                const remainingTicks = Math.max(currentPoison?.remainingTicks || 0, baseDur);
                hero.activeEffects = (hero.activeEffects || []).filter(e => e.type !== 'poison');
                hero.activeEffects.push({ type: 'poison', stacks: nextStacks, remainingTicks, damagePctPerTick: Math.max(adjDmgPct, currentPoison?.damagePctPerTick || 0) });
                log.push(makeEntry(tick, attacker.id, 'poison', `Queen's Venom: ${hero.name} gains Poisoned (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}).`, 0, hero.hp, enemy.hp, {}));
              }
            }
            for (const e of eProcState.enchantmentEffects || []) {
              if (!e?.type || !e?.chance) continue;
              if (enemyAttackerProcRng() * 100 >= e.chance) continue;
              if (e.type === 'fire_proc_on_hit') {
                const dmg = Math.max(1, e.damage || Math.floor(((e.minDamage || 0) + (e.maxDamage || 0)) / 2));
                hero.hp = Math.max(0, hero.hp - dmg);
                log.push(makeEntry(tick, attacker.id, 'hit', `Ember: ${dmg} fire damage!`, dmg, hero.hp, enemy.hp, { element: 'fire' }));
                if (e.burnGuaranteed || (e.burnChanceBonus && enemyAttackerProcRng() * 100 < e.burnChanceBonus)) {
                  const burnTicks = Math.round(((e.burnDurationSecs || 2) * 1000) / TICK_MS);
                  hero.activeEffects = (hero.activeEffects || []).filter(eff => !(eff.type === 'burning' && eff.source === 'enchant_ember'));
                  hero.activeEffects.push({ type: 'burning', damagePctPerTick: e.burnDamagePct || 3, remainingTicks: burnTicks, source: 'enchant_ember', element: 'fire' });
                }
              } else if (e.type === 'lightning_proc_on_hit') {
                const dmg = Math.max(1, e.damage || Math.floor(((e.minDamage || 0) + (e.maxDamage || 0)) / 2));
                hero.hp = Math.max(0, hero.hp - dmg);
                log.push(makeEntry(tick, attacker.id, 'hit', `Storm: ${dmg} lightning damage!`, dmg, hero.hp, enemy.hp, { element: 'lightning' }));
              } else if (e.type === 'armor_reduce_on_hit') {
                const dur = Math.round(((e.durationSecs || 3) * 1000) / TICK_MS);
                const reduction = e.reduction || 2;
                hero.activeEffects = (hero.activeEffects || []).filter(eff => eff.type !== 'armor_debuff_enchant');
                hero.activeEffects.push({ type: 'armor_debuff_enchant', value: reduction, remainingTicks: dur });
                let sunderMsg = `Sunder: -${reduction} armor to ${hero.name}.`;
                if (e.trueDamage) {
                  hero.hp = Math.max(0, hero.hp - e.trueDamage);
                  sunderMsg += ` ${e.trueDamage} true damage!`;
                }
                log.push(makeEntry(tick, attacker.id, 'proc', sunderMsg, e.trueDamage || 0, hero.hp, enemy.hp, {}));
              }
            }
          }
        }
      }
    }
  }
  return resetAutoAttackAfterNewStun(defender, tick, defenderStunBefore);
}

function tryMissHitChanceAbility(action, attacker, defender, tick, log, rng, hero, enemy, procState = null, heroProcNodes = [], opts = {}) {
  if (!abilityUsesHitChance(action?.ability)) return false;
  const attackerIsHero = attacker?.id === 'hero' && attacker?.isPlayer;
  const defenderIsHero = defender?.id === 'hero' && defender?.isPlayer;
  const targetMeta = {
    abilityId: action.ability?.id || null,
    abilityType: action.ability?.type || null,
    targetId: defender?.id || action?.targetId || null,
  };
  const hitChance = attackerIsHero && procState?.guaranteedNextHit ? 100 : getHitChance(attacker);
  if (attackerIsHero && procState?.guaranteedNextHit) procState.guaranteedNextHit = false;
  consumeAttackBasedEffects(attacker);
  if (rng() * 100 < hitChance) return false;

  const text = attackerIsHero
    ? `${action.ability.name} misses ${defender.name}.`
    : defenderIsHero
      ? `${attacker.name}'s ${action.ability.name} misses you.`
      : `${attacker.name}'s ${action.ability.name} misses ${defender.name}.`;
  log.push(makeEntry(tick, attacker.id, 'miss', text, 0, hero.hp, enemy?.hp, targetMeta));
  if (attackerIsHero && procState) {
    procState.consecutiveHits = 0;
    procState.consecutiveCrits = 0;
    if ((hero.passiveEffects || []).some(e => e.type === 'frenzy_stack')) procState.frenzyStacks = 0;
    fireProcTrigger('on_miss', {}, procState, heroProcNodes, hero, enemy, tick, log, rng);
    syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, opts.allies || []);
  } else if (defenderIsHero && procState) {
    fireProcTrigger('on_avoid', { avoidType: 'miss' }, procState, heroProcNodes, hero, enemy, tick, log, rng);
    syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, opts.allies || []);
  }
  return true;
}

function syncHeroProcEffects(heroProcNodes, procState, hero, enemy, tick, allies = []) {
  if (!hero?.isPlayer || !procState) return;
  applyScarStackArmor(hero, procState);
  applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies);
  if (hero.autoAttackStarted) scheduleNextAutoAttackFromProgress(hero, tick);
}

function syncDuelEnemyProcEffects(enemyProcNodes, enemyProcState, duelEnemy, hero, tick) {
  if (!duelEnemy?.isDuelPlayer || !enemyProcState) return;
  applyThresholdEffects(enemyProcNodes, enemyProcState, duelEnemy, hero, []);
  if (duelEnemy.autoAttackStarted) scheduleNextAutoAttackFromProgress(duelEnemy, tick);
}

function applyHeroLifesteal(hero, damage, tick, log, enemy, targetMeta) {
  if (damage <= 0 || hero.hp <= 0) return;
  const stealPct = (hero.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'lifesteal' ? total + (effect.value || 0) : total, 0);
  if (stealPct <= 0) return;
  const healed = Math.min(hero.maxHp - hero.hp, Math.max(1, Math.floor(damage * stealPct / 100)));
  if (healed <= 0) return;
  hero.hp = Math.min(hero.maxHp, hero.hp + healed);
  log.push(makeEntry(tick, 'hero', 'heal', `Lifesteal restores ${healed} HP.`, 0, hero.hp, enemy?.hp, targetMeta));
}

function applyLifeDrain(attacker, damage, tick, log, hero, enemy) {
  if (!attacker || damage <= 0 || attacker.hp <= 0) return;
  const drainPct = (attacker.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'life_drain_pct' ? total + (effect.value || effect.percent || 0) : total, 0);
  if (drainPct <= 0) return;
  const healed = Math.min(attacker.maxHp - attacker.hp, Math.max(1, Math.floor(damage * drainPct / 100)));
  if (healed <= 0) return;
  attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
  const text = attacker.isPlayer
    ? `Life Drain restores ${healed} HP.`
    : `${attacker.name} drains ${healed} HP.`;
  log.push(makeEntry(tick, attacker.id, 'heal', text, 0, hero.hp, enemy.hp));
}

function tryShieldUpCounter(reactor, attacker, result, tick, log, hero, enemy) {
  const damageMult = result?.shieldCounterDamageMult || 0;
  if (damageMult <= 0 || !reactor || !attacker || reactor.hp <= 0 || attacker.hp <= 0) return;
  const rawDamage = Math.max(1, Math.floor((reactor.damage || 0) * damageMult));
  const dmg = Math.max(1, applyArmor(rawDamage, getEffectiveArmor(attacker), getPassiveArmorPenPct(reactor)));
  attacker.hp = Math.max(0, attacker.hp - dmg);
  const text = reactor.isPlayer
    ? `Shield Up: you slam ${attacker.name} for ${dmg}.`
    : `${reactor.name}'s Shield Up slams you for ${dmg}.`;
  log.push(makeEntry(tick, reactor.id, 'shield', text, dmg, hero.hp, enemy.hp, {
    abilityId: 'shield_up',
    abilityType: 'shield_up',
  }));
}

function tryAddBerserkerCritCharge(combatant, action) {
  if (!combatant || !action?.isCrit || !action?.berserkerStanceRefundEffect) return;
  addBerserkerStanceCharge(combatant, action.berserkerStanceRefundEffect);
}

function tryAddRapidFireCritCharge(combatant, action) {
  if (!combatant || !action?.isCrit || !action?.rapidFireRefundEffect) return;
  addRapidFireCharge(combatant, action.rapidFireRefundEffect);
}

function tryCounter(reactor, attacker, tick, log, rng, hero, enemy) {
  const chance = reactor.counterChanceBonus || 0;
  if (chance <= 0 || rng() * 100 >= chance) return;
  const dmg = Math.max(1, applyArmor(reactor.damage, getEffectiveArmor(attacker), getPassiveArmorPenPct(reactor)));
  attacker.hp = Math.max(0, attacker.hp - dmg);
  const text = reactor.isPlayer
    ? `You counter for ${dmg}!`
    : `${reactor.name} counters for ${dmg}!`;
  log.push(makeEntry(tick, reactor.id, 'counter', text, dmg, hero.hp, enemy.hp));
}

function gainHeroRage(procState, action, tick = action?.impactTick ?? action?.startTick ?? 0) {
  if (action?.actorId !== 'hero' || action?.ability) return;
  if (!procState) return;
  const gain = (action.isCrit ? 9 : 6) + (action.rageGainFlat || 0);
  procState.rage = Math.min(HERO_RAGE_MAX, (procState.rage || 0) + gain);
  markRageActivity(procState, tick);
}

function recordHeroCritLanded(procState, actionOrEntry, damage = 0) {
  if (!procState || !actionOrEntry?.isCrit || damage <= 0) return;
  procState.critsLanded = Math.max(0, procState.critsLanded || 0) + 1;
}

function gainRageOnTakingHit(procState, damage, tick = 0) {
  if (!procState || damage <= 0) return;
  procState.rage = Math.min(HERO_RAGE_MAX, (procState.rage || 0) + 3);
  markRageActivity(procState, tick);
}

function getIncomingDamageCapPct(heroProcNodes, procState, hero, enemy, ctx) {
  if (!heroProcNodes?.length || !procState) return null;
  return heroProcNodes.reduce((capPct, node) => {
    const effect = node.proc?.effect;
    if (node.proc?.trigger !== 'on_take_damage' || effect?.type !== 'cap_hit_damage') return capPct;
    if (!checkProcCondition(node.proc.condition, { ...ctx, nodeId: node.id }, procState, hero, enemy)) return capPct;
    const nextCap = Math.max(1, Math.min(100, effect.maxPct || effect.value || 100));
    return capPct == null ? nextCap : Math.min(capPct, nextCap);
  }, null);
}

function spendAbilityResources(heroResources, procState, ability, combatant = null) {
  if (!heroResources || !procState || !ability) return;
  const isBerserkerDeactivate = ability.type === 'berserker_stance'
    && (combatant?.activeEffects || []).some(effect =>
      effect.type === 'berserker_stance'
      && effect.active !== false
      && (effect.remainingTicks == null || effect.remainingTicks > 0));
  if (isBerserkerDeactivate) return;
  const rageCost = getAbilityEnergyCost(ability);
  if (rageCost > 0) {
    if ('energy' in heroResources) {
      procState.energy = Math.max(0, (procState.energy || 0) - rageCost);
    } else {
      procState.rage = Math.max(0, (procState.rage || 0) - rageCost);
    }
    syncHeroCombatResources(heroResources, procState);
  }
  if (heroResources.mana && ability.manaCost) {
    heroResources.mana = { ...heroResources.mana, value: Math.max(0, heroResources.mana.value - ability.manaCost) };
  }
  if (heroResources.ki && ability.kiCost) {
    heroResources.ki = { ...heroResources.ki, value: Math.max(0, heroResources.ki.value - ability.kiCost) };
  }
}

function getAbilityCooldownTicks(ability) {
  if (!ability) return 0;
  if (ability.cooldownTicks != null) return Math.max(0, Math.ceil(ability.cooldownTicks));
  if (ability.cooldownSeconds != null) return Math.max(0, Math.ceil((ability.cooldownSeconds * 1000) / TICK_MS));
  return Math.max(0, Math.ceil(ability.cooldown || 0));
}

function startAbilityCooldown(combatant, ability, tick) {
  if (!combatant || !ability) return;
  combatant.abilityCooldowns[ability.id] = tick + getAbilityCooldownTicks(ability);
  if (ability.once) {
    combatant.usedAbilityIds = { ...(combatant.usedAbilityIds || {}), [ability.id]: true };
  }

  const cooldownReduction = combatant.spellCooldownReductionOnCast || 0;
  if (cooldownReduction <= 0) return;
  for (const [abilityId, cooldownUntilTick] of Object.entries(combatant.abilityCooldowns)) {
    if (abilityId === ability.id) continue;
    combatant.abilityCooldowns[abilityId] = Math.max(tick - 1, cooldownUntilTick - cooldownReduction);
  }
}

function grantCombatTrigger(combatant, triggerId) {
  if (!combatant || !triggerId) return;
  combatant.combatTriggers = {
    ...(combatant.combatTriggers || {}),
    [triggerId]: Math.min(1, (combatant.combatTriggers?.[triggerId] || 0) + 1),
  };
}

function consumeAbilityTrigger(combatant, ability) {
  if (!combatant || !ability?.requiredTrigger || !ability.consumeTrigger) return;
  if (!hasCombatTrigger(combatant, ability.requiredTrigger)) return;
  const nextValue = Math.max(0, (combatant.combatTriggers?.[ability.requiredTrigger] || 0) - 1);
  combatant.combatTriggers = {
    ...(combatant.combatTriggers || {}),
    [ability.requiredTrigger]: nextValue,
  };
}

function getOnHitEffects(attacker, action = null) {
  const activeOnHitEffects = (attacker.activeEffects || []).filter(effect =>
    (effect.remainingTicks == null || effect.remainingTicks > 0)
    && ['daze_on_hit', 'blind_on_hit', 'weaken_on_hit', 'stagger_on_hit', 'stun_on_hit', 'bleed_on_hit', 'poison_on_hit', 'burn_on_hit', 'armor_shred_on_hit', 'crusher_stance'].includes(effect.type));
  const effects = [...(attacker.passiveEffects || []), ...activeOnHitEffects];
  const maceMastery = action?.maceMasteryEffect;
  if (maceMastery) {
    effects.push({
      type: 'stagger_on_hit',
      chance: maceMastery.staggerChanceBonus || 10,
      duration: maceMastery.staggerDuration || 2,
      attacks: maceMastery.staggerAttacks || 2,
      missPenalty: maceMastery.staggerMissPenalty || 35,
    });
    effects.push({
      type: 'daze_on_hit',
      chance: maceMastery.dazeChanceBonus || 10,
      duration: maceMastery.dazeDuration || 2,
      missSpellChance: maceMastery.missSpellChance || 50,
    });
  }
  const serrated = action?.serratedStrikesEffect || action?.serratedEffect || action?.serrated;
  if (serrated) {
    effects.push({
      type: 'bleed_on_hit',
      chance: serrated.bleedChancePct || serrated.chance || 15,
      duration: serrated.bleedDuration || serrated.duration || 2,
      damagePct: serrated.bleedDamagePct || serrated.damagePct || 2,
    });
  }
  return effects;
}

function tryApplyOnHitEffects(attacker, defender, tick, log, rng, heroConditions, action = null, options = {}) {
  const targetMeta = { targetId: defender?.id || null };
  const attackerIsPlayerSide = isPlayerSideCombatant(attacker);
  // On-hit chance rolls use shared rng() so both duel screens consume the same
  // sequence and agree on whether each effect fires (stagger, daze, blind, etc.).
  // Effects with no chance (passive stat bonuses, etc.) are skipped without
  // consuming rng() at all — otherwise every passive entry shifts the sequence.
  const procRng = options.procRng || rng;
  for (const effect of getOnHitEffects(attacker, action)) {
    if (effect.type === 'momentum_on_hit') {
      // Enemy "Momentum" (mirrors the Fighter's): each landed hit stacks attack speed up to a cap.
      // Stored on a single refreshing attack_speed_buff so getEffectiveAutoAttackRate picks it up;
      // the stack count lives on the buff and fades if the attacker stops hitting.
      const maxStacks = effect.maxStacks || 6;
      const perStackPct = effect.perStackPct || 4;
      const durationTicks = effect.durationTicks || 4;
      const existing = (attacker.activeEffects || []).find(e => e.type === 'attack_speed_buff' && e.source === 'berserker_momentum');
      const stacks = Math.min(maxStacks, (existing?.stacks || 0) + 1);
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => !(e.type === 'attack_speed_buff' && e.source === 'berserker_momentum'));
      attacker.activeEffects.push({ type: 'attack_speed_buff', value: stacks * perStackPct, remainingTicks: durationTicks, source: 'berserker_momentum', stacks });
      continue;
    }
    if (effect.type === 'bleed_on_hit' && options.allowBleed === false) continue;
    if (effect.type === 'poison_on_hit' && options.allowPoison === false) continue;
    // crit-only effects skip the RNG roll entirely on non-crit hits
    if (effect.type === 'debilitated_on_crit' && !action?.isCrit) continue;
    if (!(effect.chance > 0)) continue;
    // Always use procRng (side-specific in duel mode, falls back to rng in solo).
    // Using the shared rng here would cause desync: each duel client processes its own
    // hero first, so rng consumption order differs between screens.
    if (procRng() * 100 >= effect.chance) continue;
    if (effect.type === 'daze_on_hit') {
      defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'daze');
      defender.activeEffects.push({
        type: 'daze',
        remainingTicks: effect.duration || 2,
        missSpellChance: effect.missSpellChance || 50,
      });
      const text = attackerIsPlayerSide ? `Status: ${defender.name} gains Dazed.` : `Status: You are Dazed by ${attacker.name}.`;
      log.push(makeEntry(tick, attacker.id, 'daze', text, 0, null, null, targetMeta));
      continue;
    }
    if (effect.type === 'blind_on_hit') {
      defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'blind');
      defender.activeEffects.push({
        type: 'blind',
        remainingTicks: effect.duration || 2,
        attacksRemaining: effect.attacks || 1,
        hitPenalty: effect.hitPenalty || 15,
      });
      const text = attackerIsPlayerSide ? `Status: ${defender.name} gains Blinded.` : `Status: You are Blinded by ${attacker.name}.`;
      log.push(makeEntry(tick, attacker.id, 'blind', text, 0, null, null, targetMeta));
    }
    if (effect.type === 'weaken_on_hit') {
      defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'weaken');
      defender.activeEffects.push({
        type: 'weaken',
        remainingTicks: effect.duration || 1,
        damageMult: effect.damageMult || 0.8,
      });
      const text = attackerIsPlayerSide ? `Status: ${defender.name} gains Weakened.` : `Status: You are Weakened by ${attacker.name}.`;
      log.push(makeEntry(tick, attacker.id, 'weaken', text, 0, null, null, targetMeta));
    }
    if (effect.type === 'stagger_on_hit') {
      defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'stagger');
      defender.activeEffects.push({
        type: 'stagger',
        remainingTicks: effect.duration || 2,
        attacksRemaining: effect.attacks || effect.duration || 2,
        missPenalty: effect.missPenalty || 35,
      });
      const text = attackerIsPlayerSide ? `Status: ${defender.name} gains Staggered.` : `Status: You are Staggered by ${attacker.name}.`;
      log.push(makeEntry(tick, attacker.id, 'stagger', text, 0, null, null, targetMeta));
    }
    if (effect.type === 'debilitated_on_crit') {
      // action?.isCrit guaranteed by the guard above
      defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'weaken');
      defender.activeEffects.push({
        type: 'weaken',
        remainingTicks: effect.debuffDurationSecs || 4,
        damageMult: 1 - (effect.damageReductionPct || 20) / 100,
      });
      const text = attackerIsPlayerSide ? `Debilitated: ${defender.name} deals -${effect.damageReductionPct || 20}% damage!` : `Debilitated: you deal -${effect.damageReductionPct || 20}% damage!`;
      log.push(makeEntry(tick, attacker.id, 'weaken', text, 0, null, null, targetMeta));
    }
    if (effect.type === 'burn_on_hit') {
      defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'burning');
      defender.activeEffects.push({
        type: 'burning',
        remainingTicks: effect.duration || 3,
        damagePctPerTick: effect.damagePct || 2,
        damageFlat: effect.damageFlat,
      });
      const text = attackerIsPlayerSide ? `Status: ${defender.name} gains Burning.` : `Status: You are Burning from ${attacker.name}.`;
      log.push(makeEntry(tick, attacker.id, 'burning', text, 0, null, null, targetMeta));
    }
    if (effect.type === 'stun_on_hit') {
      applyStunToCombatant(defender, tick, getEffectDurationTicks(effect, 1));
      const text = attackerIsPlayerSide
        ? `Status: ${defender.name} is Stunned.`
        : `Status: You are Stunned by ${attacker.name}.`;
      log.push(makeEntry(tick, attacker.id, 'stun', text, 0, null, null, targetMeta));
    }
    if (effect.type === 'armor_shred_on_hit') {
      if (hasArmorReductionImmunity(defender)) continue;
      const armorReduction = Math.max(1, effect.armorReduction || effect.value || 1);
      const maxReduction = Math.max(armorReduction, effect.maxReduction || armorReduction);
      const maxStacks = Math.max(1, Math.floor(maxReduction / armorReduction));
      const current = (defender.activeEffects || []).find(active =>
        active.type === 'armor_shred' && active.source === (effect.source || 'armor_shred_on_hit'));
      const nextStacks = Math.min(maxStacks, (current?.stacks || 0) + 1);
      const durationTicks = Math.max(1, effect.durationTicks || effect.duration || 4);
      defender.activeEffects = (defender.activeEffects || []).filter(active => active !== current);
      defender.activeEffects.push({
        type: 'armor_shred',
        stacks: nextStacks,
        armorReduction,
        remainingTicks: Math.max(current?.remainingTicks || 0, durationTicks),
        source: effect.source || 'armor_shred_on_hit',
      });
      const totalReduction = nextStacks * armorReduction;
      const text = attackerIsPlayerSide
        ? `Glass Arrow: ${defender.name} loses ${totalReduction} armor.`
        : `Glass Arrow: your armor is reduced by ${totalReduction}.`;
      log.push(makeEntry(tick, attacker.id, 'armor', text, 0, null, null, {
        ...targetMeta,
        armorReduction: totalReduction,
      }));
    }
    if (effect.type === 'poison_on_hit') {
      if (isPoisonImmune(defender)) {
        const text = attackerIsPlayerSide ? `${defender.name} is immune to Poison.` : 'You are immune to Poison.';
        log.push(makeEntry(tick, attacker.id, 'immune', text, 0, null, null, targetMeta));
        continue;
      }
      const poisonDuration = Math.max(1, (effect.duration || 3) + getPoisonDurationBonusTicks(attacker));
      const poisonDamagePct = (effect.damagePct || 0.9) + getPoisonDamagePctBonus(attacker);
      if (defender.isPlayer && heroConditions) {
        const current = heroConditions.poison?.stacks || 0;
        const nextStacks = Math.min(6, current + 1);
        heroConditions.poison = {
          type: 'poison',
          stacks: nextStacks,
          damagePct: poisonDamagePct,
        };
        const activeEffects = defender.activeEffects || [];
        const existingPoison = activeEffects.find(active => active.type === 'poison');
        const activeStacks = Math.min(6, (existingPoison?.stacks || 0) + 1);
        const remainingTicks = Math.max(existingPoison?.remainingTicks || 0, poisonDuration);
        defender.activeEffects = [
          ...activeEffects.filter(active => active.type !== 'poison'),
          {
            type: 'poison',
            stacks: activeStacks,
            remainingTicks,
            damagePctPerTick: poisonDamagePct,
          },
        ];
        log.push(makeEntry(tick, attacker.id, 'poison', `Status: You gain Poisoned (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}) from ${attacker.name}.`, 0, null, null, targetMeta));
      } else {
        const relicPoisonDurBonus = attackerIsPlayerSide ? getRelicDotDurationBonus(options.procState) : 0;
        const relicPoisonDmgMult = attackerIsPlayerSide ? getRelicDotDamageMult(options.procState) : 1;
        const adjPoisonDuration = poisonDuration + relicPoisonDurBonus;
        const adjPoisonDamagePct = poisonDamagePct * relicPoisonDmgMult;
        const currentPoison = (defender.activeEffects || []).find(active => active.type === 'poison');
        const nextStacks = Math.min(6, (currentPoison?.stacks || 0) + 1);
        const remainingTicks = Math.max(currentPoison?.remainingTicks || 0, adjPoisonDuration);
        defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'poison');
        defender.activeEffects.push({
          type: 'poison',
          stacks: nextStacks,
          remainingTicks,
          damagePctPerTick: Math.max(adjPoisonDamagePct, currentPoison?.damagePctPerTick || 0),
        });
        const text = attackerIsPlayerSide ? `Status: ${defender.name} gains Poisoned (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}).` : `Status: You are Poisoned by ${attacker.name}.`;
        log.push(makeEntry(tick, attacker.id, 'poison', text, 0, null, null, targetMeta));
      }
      continue;
    }
    if (effect.type === 'bleed_on_hit') {
      if (isBleedImmune(defender)) {
        const text = attackerIsPlayerSide ? `${defender.name} is immune to Bleeding.` : 'You are immune to Bleeding.';
        log.push(makeEntry(tick, attacker.id, 'immune', text, 0, null, null, targetMeta));
        continue;
      }
      const baseDuration = effect.duration || 2;
      const bleedDuration = attackerIsPlayerSide
        ? Math.max(baseDuration, getPlayerBleedRefreshTicks(attacker))
        : baseDuration;
      if (defender.isPlayer && heroConditions) {
        const current = heroConditions.bleeding?.stacks || 0;
        const nextStacks = Math.min(6, current + 1);
        heroConditions.bleeding = {
          type: 'bleeding',
          stacks: nextStacks,
          damagePct: effect.damagePct || 0.6,
        };
        const currentBleed = (defender.activeEffects || []).find(active => active.type === 'bleed');
        const remainingTicks = Math.max(currentBleed?.remainingTicks || 0, bleedDuration);
        defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'bleed');
        defender.activeEffects.push({
          type: 'bleed',
          stacks: nextStacks,
          remainingTicks,
          damagePctPerTick: effect.damagePct || currentBleed?.damagePctPerTick || 1.0,
        });
        log.push(makeEntry(tick, attacker.id, 'bleed', `Status: You gain Bleeding (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}) from ${attacker.name}.`, 0, null, null, targetMeta));
      } else {
        const relicBleedDurBonus = attackerIsPlayerSide ? getRelicDotDurationBonus(options.procState) : 0;
        const relicBleedDmgMult = attackerIsPlayerSide ? getRelicDotDamageMult(options.procState) : 1;
        const adjBleedDuration = bleedDuration + relicBleedDurBonus;
        const adjBleedDamagePct = (effect.damagePct || 0.6) * relicBleedDmgMult;
        const currentBleed = (defender.activeEffects || []).find(active => active.type === 'bleed');
        const nextStacks = Math.min(6, (currentBleed?.stacks || 0) + 1);
        const remainingTicks = Math.max(currentBleed?.remainingTicks || 0, adjBleedDuration);
        defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'bleed');
        defender.activeEffects.push({
          type: 'bleed',
          stacks: nextStacks,
          remainingTicks,
          damagePctPerTick: adjBleedDamagePct || currentBleed?.damagePctPerTick || 1.0,
        });
        log.push(makeEntry(tick, attacker.id, 'bleed', `Status: ${defender.name} gains Bleeding (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}).`, 0, null, null, targetMeta));
      }
    }
  }

  for (const effect of getOnHitEffects(attacker, action)) {
    if (effect.type !== 'crusher_stance') continue;
    if (rng() * 100 >= (effect.staggerBonus || 0)) continue;
    defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'stagger');
    defender.activeEffects.push({ type: 'stagger', remainingTicks: 2, attacksRemaining: 2, missPenalty: 35 });
    const text = attackerIsPlayerSide ? `Status: ${defender.name} gains Staggered from the crushing blow.` : `Status: You are Staggered by ${attacker.name}.`;
    log.push(makeEntry(tick, attacker.id, 'stagger', text, 0, null, null, targetMeta));
  }
}

function isTargetBleeding(defender, requiredStacks = 1) {
  return getTargetBleedStacks(defender) >= Math.max(1, requiredStacks || 1);
}

function isTargetDisrupted(defender, tick) {
  return tick <= (defender?.stunUntilTick || -1)
    || (defender?.activeEffects || []).some(e =>
      (e.type === 'daze' && e.remainingTicks > 0)
      || (e.type === 'stagger' && (e.remainingTicks > 0 || e.attacksRemaining > 0)));
}

function applyChannelStartEffects(caster, ability, allies, log, tick) {
  const spellBonus = 1 + ((caster.spellDamageBonus || 0) / 100);
  const durationTicks = Math.max(1, ability.durationTicks || 4);
  const reductionPct = ability.damageReductionPct || ability.reductionPct || 15;
  const targets = [caster, ...allies.filter(a => a && a.hp > 0)];

  for (const target of targets) {
    const healPct = target.isAlly
      ? (ability.allyHealPct || ability.healPct || 25)
      : (ability.healPct || 25);
    const totalHeal = Math.ceil(target.maxHp * healPct / 100 * spellBonus);
    const healPerTick = Math.max(1, Math.ceil(totalHeal / durationTicks));

    target.activeEffects = (target.activeEffects || []).filter(e =>
      !(e.sourceAbilityId === ability.id && e.type === 'heal_over_time'));
    target.activeEffects.push({
      type: 'heal_over_time',
      healPerTick,
      remainingTicks: durationTicks,
      sourceAbilityId: ability.id,
      sourceAbilityName: ability.name,
    });

    if (target.isAlly) {
      target.activeEffects = (target.activeEffects || []).filter(e =>
        !(e.type === 'damage_taken_reduction' && e.sourceAbilityId === ability.id));
      target.activeEffects.push({
        type: 'damage_taken_reduction',
        remainingTicks: durationTicks,
        reductionPct,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
    }

    const targetLabel = target.isPlayer ? 'you' : target.name;
    log.push(makeEntry(tick, caster.id, 'heal',
      `${ability.name}: ${targetLabel} channels — ${healPerTick} HP/tick for ${durationTicks} seconds.`,
      0, null, null, { targetId: target.id }));
  }
}

function applyChannelDamageStart(caster, ability, target, log, tick, hero) {
  const durationTicks = Math.max(1, Math.ceil(ability.durationTicks || ability.castTicks || 3));
  const spellBonus = 1 + ((caster.spellDamageBonus || 0) / 100);
  const damageFlat = ability.damage != null
    ? Math.max(1, Math.floor(ability.damage * spellBonus))
    : null;
  caster.activeEffects = (caster.activeEffects || []).filter(effect =>
    !(effect.type === 'channeled_damage' && effect.sourceAbilityId === ability.id));
  caster.activeEffects.push({
    type: 'channeled_damage',
    remainingTicks: durationTicks,
    damageFlat,
    damagePctPerTick: ability.damagePctPerTick,
    element: ability.element || ability.damageElement || 'fire',
    targetId: target?.id || null,
    sourceAbilityId: ability.id,
    sourceAbilityName: ability.name,
  });
  log.push(makeEntry(tick, caster.id, 'channel_start', `${caster.name} channels ${ability.name}.`, 0, hero?.hp ?? null, caster.hp, {
    abilityId: ability.id,
    abilityType: ability.type,
    targetId: target?.id || null,
    durationTicks,
  }));
}

function applyAction(combatant, action, tick, queue, log, rng, heroResources, defender = null, procState = null, opts = {}) {
  if (action === ACTION.NONE) return queue;
  if (isStunned(combatant, tick)) {
    if (combatant.isPlayer && ABILITY_ACTIONS.has(action)) {
      log.push(makeEntry(tick, combatant.id, 'ability_fail', 'You are stunned and cannot use an ability.', 0, null, null));
    }
    return queue;
  }

  if (action === ACTION.BLOCK && canBlock(combatant, tick)) {
    combatant.blocking = true;
    combatant.dodging = false;
    combatant.blockPending = false;
    combatant.dodgePending = false;
    combatant.blockCooldownUntilTick = tick + BLOCK_DODGE_COOLDOWN;
    const text = combatant.isPlayer ? 'You brace for the next hit.' : `${combatant.name} braces for the next hit.`;
    log.push(makeEntry(tick, combatant.id, 'block_start', text, 0, null, null));
    return queue;
  }

  if (action === ACTION.DODGE && canDodge(combatant, tick)) {
    combatant.dodging = true;
    combatant.blocking = false;
    combatant.dodgePending = false;
    combatant.blockPending = false;
    combatant.dodgeCooldownUntilTick = tick + BLOCK_DODGE_COOLDOWN;
    const text = combatant.isPlayer ? 'You ready an evasion for the next hit.' : `${combatant.name} readies an evasion for the next hit.`;
    log.push(makeEntry(tick, combatant.id, 'dodge_start', text, 0, null, null));
    return queue;
  }

  const activeAbilityCast = queue.find(queuedAction =>
    queuedAction.actorId === combatant.id
    && queuedAction.ability
    && (queuedAction.castEndTick ?? queuedAction.impactTick) > tick - 1);
  const activeBasicAttack = queue.find(queuedAction =>
    queuedAction.actorId === combatant.id
    && queuedAction.type === ACTION.BASIC_ATTACK
    && (queuedAction.castEndTick ?? queuedAction.impactTick) > tick - 1);
  const alreadyCasting = !!activeAbilityCast;

  if (ATTACK_ACTIONS.has(action) && !alreadyCasting) {
    if (opts.disableAutoAttacks) return queue;
    const flashBurst = combatant.isPlayer ? getActiveFlashBurst(combatant) : null;
    const attackCount = Math.max(
      getReadyAutoAttackCount(combatant, tick, { allowOpeningAttack: combatant.isPlayer || (combatant.isDuelPlayer && !!opts.disableEnemyAi) }),
      flashBurst ? (flashBurst.attacksPerTick || 3) : 0,
    );
    if (attackCount <= 0) return queue;

    triggerBarbedTrapOnAutoAttack(combatant, tick, log);
    if (triggerBearTrapOnAutoAttack(combatant, tick, log)) {
      return removePendingBasicAttacksForActor(queue, combatant.id);
    }

    let nextQueue = queue;
    const queuedBasicAttackCount = activeBasicAttack ? 1 : 0;
    const attacksToQueue = Math.max(0, attackCount - queuedBasicAttackCount);
    if (attacksToQueue <= 0) return nextQueue;

    for (let attackIndex = 0; attackIndex < attacksToQueue; attackIndex += 1) {
      const prepared = prepareBasicAttack(combatant, defender, rng, { ...opts, procState });
      nextQueue = enqueueAction(nextQueue, combatant.id, action, tick, prepared.damage, null, 0, {
        ...prepared.meta,
        targetId: defender?.id || null,
      });
    }
    return nextQueue;
  }

  if (ABILITY_ACTIONS.has(action) && !alreadyCasting) {
    const slotIdx = ABILITY_SLOT_INDEX[action];
    const ability = (combatant.abilities || [])[slotIdx];
    const abilityTarget = getAbilityTarget(combatant, ability, defender, opts);
    if (ability?.requiresTargetDisrupted && !isTargetDisrupted(abilityTarget, tick)) {
      if (combatant.isPlayer) log.push(makeEntry(tick, combatant.id, 'ability_fail', `${ability.name}: target must be Dazed, Staggered, or Stunned.`, 0, null, null));
      return applyAction(combatant, ACTION.BASIC_ATTACK, tick, queue, log, rng, heroResources, defender, procState, opts);
    }
    const requiredBleedStacks = ability?.requiredTargetBleedStacks || 1;
    if (ability?.requiresTargetBleeding && !isTargetBleeding(abilityTarget, requiredBleedStacks)) {
      const reason = requiredBleedStacks > 1
        ? `${ability.name}: target must have at least ${requiredBleedStacks} Bleeding stacks.`
        : `${ability.name}: target must be Bleeding.`;
      if (combatant.isPlayer) log.push(makeEntry(tick, combatant.id, 'ability_fail', reason, 0, null, null));
      return applyAction(combatant, ACTION.BASIC_ATTACK, tick, queue, log, rng, heroResources, defender, procState, opts);
    }
    const reason = getAbilityUseFailureReason(combatant, ability, tick, combatant.isPlayer ? heroResources : {}, abilityTarget, { procState });
    if (reason) {
      if (combatant.isPlayer) log.push(makeEntry(tick, combatant.id, 'ability_fail', reason, 0, null, null));
      return applyAction(combatant, ACTION.BASIC_ATTACK, tick, queue, log, rng, heroResources, defender, procState, opts);
    }
    if (!['sword_stance', 'berserker_stance', 'serrated_strikes', 'stagger_spell', 'rapid_fire', 'heavy_strikes', 'parry_guard', 'en_garde', 'shield_up', 'shield_wall', 'guard_instinct', 'mace_mastery', 'daze_shout', 'battle_focus', 'iron_will', 'pet_unleash'].includes(ability?.type)) {
      resetAutoAttackCycle(combatant, tick);
    }
    if (combatant.isPlayer) markRageActivity(procState, tick);
    if (combatant.isPlayer && procState && !isAllyTargetAbility(ability) && ability?.target !== 'self') {
      procState.heroAttackedThisTick = true;
      procState.sniperPatiencePct = 0;
    }
    if (combatant.isPlayer) spendAbilityResources(heroResources, procState, ability, combatant);
    consumeAbilityTrigger(combatant, ability);
    queue = removePendingBasicAttacksForActor(queue, combatant.id);

    const text = combatant.isPlayer
      ? `You begin ${ability.name}...`
      : (ability.castStartText || `${combatant.name} uses ${ability.name}!`);
    log.push(makeEntry(tick, combatant.id, 'cast_start', text, 0, null, null, {
      abilityId: ability.id,
      abilityType: ability.type,
      targetId: abilityTarget?.id || null,
    }));
    if (ability.channeledDamage) {
      applyChannelDamageStart(combatant, ability, abilityTarget, log, tick, opts.hero || null);
    } else if (ability.channeled) {
      applyChannelStartEffects(combatant, ability, opts.allies || [], log, tick);
    }
    const targetFrontDamageMult = ability?.ignoreTargetFrontPenalty
      ? 1
      : getTargetFrontDamageMult(combatant, abilityTarget, opts);
    return enqueueAbility(queue, combatant.id, action, ability.castTicks ?? 1, tick, combatant.damage, ability, {
      targetId: abilityTarget?.id || null,
      targetFrontPenalty: targetFrontDamageMult < 1,
      targetFrontDamageMult,
    });
  }

  if (ABILITY_ACTIONS.has(action) && activeAbilityCast?.ability && combatant.isPlayer) {
    log.push(makeEntry(tick, combatant.id, 'ability_fail', `You are already casting ${activeAbilityCast.ability.name}.`, 0, null, null));
  }

  return queue;
}

function makeEntry(tick, actorId, type, text, damage, heroHp, enemyHp, meta = {}) {
  return {
    tick,
    actorId,
    type,
    text,
    damage,
    heroHp: heroHp != null ? Math.max(0, Math.floor(heroHp)) : null,
    enemyHp: enemyHp != null ? Math.max(0, Math.floor(enemyHp)) : null,
    round: tick,
    ...meta,
  };
}

function maybeInflictDeepCut(attacker, defender, damage, isCrit, tick, log, heroWounds, rng) {
  if (TESTING_DISABLE_WOUNDS) return;
  if (!attacker || attacker.isPlayer || !defender?.isPlayer || damage <= 0) return;
  let chance = 0;
  const rarityId = attacker.rarityId || 'normal';
  if (rarityId === 'epico') chance += 8;
  if (rarityId === 'legendario') chance += 16;
  if (attacker.isBoss) chance += 12;

  const damagePct = defender.maxHp > 0 ? (damage / defender.maxHp) * 100 : 0;
  if (damagePct >= 35) chance += 18;
  else if (damagePct >= 20) chance += 10;
  else if (damagePct >= 12) chance += 4;

  if (isCrit) chance += 12;

  const hpPct = defender.maxHp > 0 ? defender.hp / defender.maxHp : 1;
  if (hpPct <= 0.15) chance += 20;
  else if (hpPct <= 0.3) chance += 10;
  else if (hpPct <= 0.5) chance += 4;

  if (chance <= 0 || rng() * 100 >= chance) return;
  heroWounds.deepCut = (heroWounds.deepCut || 0) + 1;
  log.push(makeEntry(tick, attacker.id, 'wound', `${attacker.name} leaves a deep cut.`, 0, defender.hp, null, {
    woundTier: 2,
    woundChance: chance,
  }));
}

// ─── Proc Chain Engine ────────────────────────────────────────────────────────

export function createInitialProcState(initialHp = 100, opts = {}) {
  const carriedMomentum = Math.max(0, Math.min(10, Math.floor(opts.momentumCarry || 0)));
  return {
    rage: Math.max(0, Math.min(HERO_RAGE_MAX, Math.floor(opts.initialRage || 0))),
    energy: 0,
    bladeStacks: 0,
    scarStacks: 0,
    grudge: 0,
    momentumStacks: carriedMomentum,
    momentumMaxHeldTicks: 0,
    lastRageActivityTick: opts.lastRageActivityTick || 0,
    consecutiveHits: 0,
    consecutiveCrits: 0,
    frenzyStacks: 0,
    activeThresholdIds: [],
    consecutiveBlocks: 0,
    consecutiveParries: 0,
    parryCountThisTick: 0,
    firstHitFired: false,
    stonewallFirstBlockReady: (opts.heroEffects || []).some(e => e.type === 'first_incoming_guaranteed_block'),
    onceFiredIds: [],
    hasTakenDamageThisFight: false,
    hasTakenDamageLastFight: opts.hasTakenDamageLastFight || false,
    bleedCarry: opts.bleedCarry || 0,
    momentumCarry: 0,
    carriedRage: opts.carriedRage || 0,
    prevHeroHp: initialHp,
    juggernaut: false,
    flowStateTicks: 0,
    guaranteedNextHit: opts.activeRelics
      ? (opts.activeRelics.some(r => r?.relicPassive?.type === 'first_hit_guaranteed'))
      : false,
    forcedNextCrit: false,
    lastBleedDamage: 0,
    lastHeroFlankingHitTick: null,
    lastAllyFlankingHitTick: null,
    flankingLastPair: null,
    sharedFuryActive: false,
    critsLanded: 0,
    sniperPatiencePct: 0,
    heroAttackedThisTick: false,
    // Relic state
    activeRelics: opts.activeRelics || [],
    enchantmentEffects: opts.enchantmentEffects || [],
    impetusStacks: 0,
    relicBarrier: 0,
    relicRegenAccum: 0,
    relicDeathCheatFired: false,
    nodeCooldowns: {},
  };
}

function checkProcCondition(condition, ctx, procState, hero, enemy) {
  if (!condition) return true;
  if (condition.hp_pct_below != null && getHpPct(hero) >= condition.hp_pct_below) return false;
  if (condition.hp_pct_above != null && getHpPct(hero) <= condition.hp_pct_above) return false;
  if (condition.rage_above != null && procState.rage < condition.rage_above) return false;
  if (condition.blade_stacks_eq != null && procState.bladeStacks !== condition.blade_stacks_eq) return false;
  if (condition.blade_stacks_gte != null && procState.bladeStacks < condition.blade_stacks_gte) return false;
  if (condition.scar_stacks_gte != null && procState.scarStacks < condition.scar_stacks_gte) return false;
  if (condition.momentum_stacks_gte != null && procState.momentumStacks < condition.momentum_stacks_gte) return false;
  if (condition.consecutive_crits_gte != null && procState.consecutiveCrits < condition.consecutive_crits_gte) return false;
  if (condition.consecutive_parries_gte != null && procState.consecutiveParries < condition.consecutive_parries_gte) return false;
  if (condition.consecutive_blocks_gte != null && procState.consecutiveBlocks < condition.consecutive_blocks_gte) return false;
  if (condition.bleed_stacks_gte != null && (ctx.bleedStacks || 0) < condition.bleed_stacks_gte) return false;
  if (condition.once_per_combat && procState.onceFiredIds.includes(ctx.nodeId || '')) return false;
  if (condition.target_has_bleed && !(enemy?.activeEffects || []).some(e => e.type === 'bleed' && (e.remainingTicks || 0) > 0)) return false;
  if (condition.hemorrhage_active && !(enemy?.activeEffects || []).some(e => e.type === 'hemorrhage' && (e.remainingTicks || 0) > 0)) return false;
  if (condition.took_damage_last_fight && !procState.hasTakenDamageLastFight) return false;
  if (condition.target_had_bleed && !ctx.targetHadBleed) return false;
  if (condition.carried_rage_gt != null && (procState.carriedRage || 0) <= condition.carried_rage_gt) return false;
  if (condition.already_parried_this_tick && procState.parryCountThisTick <= 1) return false;
  if (condition.energy_gte != null && (procState.energy || 0) < condition.energy_gte) return false;
  return true;
}

function applyProcEffect(effect, ctx, procState, heroProcNodes, hero, enemy, tick, log, rng) {
  if (!effect) return;
  switch (effect.type) {
    case 'gain_rage':
      procState.rage = Math.min(100, procState.rage + (effect.value || 0));
      break;
    case 'gain_rage_pct_damage':
      procState.rage = Math.min(100, procState.rage + Math.floor((ctx.damage || 0) * (effect.value || 10) / 100));
      break;
    case 'gain_blade_stack': {
      const enGarde = ctx.trigger === 'on_parry'
        ? (hero?.activeEffects || []).find(active =>
          active.type === 'en_garde'
          && (active.remainingTicks == null || active.remainingTicks > 0))
        : null;
      const bladeGain = (effect.value || 1) * (enGarde?.bladeStackMultiplier || 1);
      procState.bladeStacks = Math.min(5, procState.bladeStacks + bladeGain);
      break;
    }
    case 'gain_scar_stack': {
      const previousStacks = procState.scarStacks || 0;
      const maxStacks = effect.max || SCAR_STACK_MAX;
      procState.scarStacks = Math.min(maxStacks, previousStacks + (effect.value || 1));
      applyScarStackArmor(hero, procState);
      if (previousStacks !== procState.scarStacks) {
        fireProcTrigger('on_scar_stacks_reach', { ...ctx, prevStacks: previousStacks, newStacks: procState.scarStacks }, procState, heroProcNodes, hero, enemy, tick, log, rng);
      }
      if (previousStacks < maxStacks && procState.scarStacks >= maxStacks) {
        fireProcTrigger('on_scar_stacks_max', { ...ctx, scarStacks: procState.scarStacks }, procState, heroProcNodes, hero, enemy, tick, log, rng);
      }
      break;
    }
    case 'gain_momentum': {
      const prevMomentum = procState.momentumStacks || 0;
      procState.momentumStacks = Math.min(getMomentumMax(heroProcNodes, hero), prevMomentum + (effect.value || 1));
      if (prevMomentum !== procState.momentumStacks) {
        fireProcTrigger('on_momentum_reach', { prevStacks: prevMomentum, newStacks: procState.momentumStacks }, procState, heroProcNodes, hero, enemy, tick, log, rng);
      }
      break;
    }
    case 'set_momentum_min': {
      const prevMomentum = procState.momentumStacks || 0;
      procState.momentumStacks = Math.min(getMomentumMax(heroProcNodes, hero), Math.max(prevMomentum, effect.value || 0));
      if (prevMomentum !== procState.momentumStacks) {
        fireProcTrigger('on_momentum_reach', { prevStacks: prevMomentum, newStacks: procState.momentumStacks }, procState, heroProcNodes, hero, enemy, tick, log, rng);
      }
      break;
    }
    case 'gain_momentum_carry':
      procState.momentumCarry = Math.min(getMomentumMax(heroProcNodes, hero), (procState.momentumCarry || 0) + (effect.value || 0));
      break;
    case 'store_grudge_pct':
      procState.grudge = (procState.grudge || 0) + Math.floor((ctx.damage || 0) * (effect.value || 35) / 100);
      break;
    case 'apply_bleed':
      if (enemy && enemy.hp > 0 && !isBleedImmune(enemy)) {
        const stacks = effect.stacks || 1;
        for (let s = 0; s < stacks; s++) applyEnemyBleed(enemy, tick, log, hero, procState);
      }
      break;
    case 'counter_hit': {
      if (!enemy || enemy.hp <= 0) break;
      const rawDmg = Math.max(1, Math.floor((hero.damage || 0) * (effect.damageMult || 0.5)));
      const dmg = applyArmor(rawDmg, getEffectiveArmor(enemy), 0);
      enemy.hp = Math.max(0, enemy.hp - dmg);
      log.push(makeEntry(tick, 'hero', 'hit', `Proc: counter hit for ${dmg}.`, dmg, hero.hp, enemy.hp, {
        targetId: enemy.id,
        extraHit: true,
        extraHitSource: 'counter_hit',
      }));
      break;
    }
    case 'extra_arrow': {
      if (!enemy || enemy.hp <= 0) break;
      const rawDmg = Math.max(1, Math.floor((hero.damage || 0) * (effect.damageMult || 0.5)));
      const dmg = applyArmor(rawDmg, getEffectiveArmor(enemy), getPassiveArmorPenPct(hero));
      const applied = applyCombatantDamage(enemy, dmg);
      log.push(makeEntry(tick, 'hero', 'hit', `Hair Trigger: extra arrow for ${applied.damage}.`, applied.damage, hero.hp, enemy.hp, {
        targetId: enemy.id,
        extraHit: true,
        extraHitSource: 'hair_trigger',
        shieldAbsorbed: applied.absorbed || 0,
      }));
      logDamageShieldAbsorb(enemy, applied, tick, log, hero, enemy, { targetId: enemy.id });
      break;
    }
    case 'extra_auto_attack': {
      if (!enemy || enemy.hp <= 0) break;
      const damageMult = effect.damageMult ?? 0.5;
      const rawDmg = Math.max(1, Math.floor((hero.damage || 0) * damageMult));
      const dmg = applyArmor(rawDmg, getEffectiveArmor(enemy), getPassiveArmorPenPct(hero));
      const applied = applyCombatantDamage(enemy, dmg);
      const source = ctx.nodeId || effect.source || 'extra_auto_attack';
      log.push(makeEntry(tick, 'hero', 'hit', `Killing Speed: extra auto attack for ${applied.damage}.`, applied.damage, hero.hp, enemy.hp, {
        targetId: enemy.id,
        extraHit: true,
        extraHitSource: source,
        shieldAbsorbed: applied.absorbed || 0,
      }));
      logDamageShieldAbsorb(enemy, applied, tick, log, hero, enemy, { targetId: enemy.id });
      applyHeroLifesteal(hero, applied.damage, tick, log, enemy, {
        targetId: enemy.id,
        extraHit: true,
        extraHitSource: source,
      });
      break;
    }
    case 'heal_pct_max_hp': {
      const healed = Math.min(hero.maxHp - hero.hp, Math.max(1, Math.floor(hero.maxHp * (effect.value || 5) / 100)));
      if (healed > 0) {
        hero.hp = Math.min(hero.maxHp, hero.hp + healed);
        log.push(makeEntry(tick, 'hero', 'heal', `Proc heal: ${healed} HP restored.`, 0, hero.hp, enemy?.hp, {}));
      }
      break;
    }
    case 'heal_pct_bleed_dmg': {
      const bleedDmg = ctx.bleedDamage || procState.lastBleedDamage || 0;
      const healed = Math.min(hero.maxHp - hero.hp, Math.max(0, Math.floor(bleedDmg * (effect.value || 5) / 100)));
      if (healed > 0) {
        hero.hp = Math.min(hero.maxHp, hero.hp + healed);
        log.push(makeEntry(tick, 'hero', 'heal', `Bloodletter: ${healed} HP from bleed.`, 0, hero.hp, enemy?.hp, {}));
      }
      break;
    }
    case 'gain_attack_speed_pct':
      hero.activeEffects = hero.activeEffects || [];
      hero.activeEffects.push({ type: 'attack_speed_buff', value: effect.value || 0, remainingTicks: effect.durationTicks || 3, source: ctx.nodeId || null });
      break;
    case 'gain_attack_speed_pct_per_bleed_stack': {
      const bleedEff = (enemy?.activeEffects || []).find(e => e.type === 'bleed');
      const stacks = bleedEff?.stacks || 0;
      if (stacks > 0) {
        const speedVal = (effect.valuePerStack || 4) * stacks;
        hero.activeEffects = hero.activeEffects || [];
        // Tagged source:'bloodrush' + stacks so the UI can show a dedicated Bloodrush icon with the
        // number of Bleed stacks fuelling the current buff. Refresh (replace) instead of piling up.
        hero.activeEffects = hero.activeEffects.filter(e => !(e.type === 'attack_speed_buff' && e.source === 'bloodrush'));
        hero.activeEffects.push({ type: 'attack_speed_buff', value: speedVal, remainingTicks: effect.durationTicks || 1, source: 'bloodrush', stacks });
      }
      break;
    }
    case 'gain_crit_chance_pct':
      hero.activeEffects = hero.activeEffects || [];
      hero.activeEffects.push({
        type: 'crit_chance_buff',
        value: effect.value || 0,
        remainingTicks: effect.durationTicks || 3,
        source: ctx.nodeId,
      });
      break;
    case 'gain_evasion_chance_pct':
      hero.activeEffects = hero.activeEffects || [];
      hero.activeEffects.push({
        type: 'evasion_chance',
        value: effect.value || 10,
        remainingTicks: effect.durationTicks || 3,
        source: ctx.nodeId,
      });
      log.push(makeEntry(tick, 'hero', 'proc', `Perfect Rhythm: +${effect.value || 10}% dodge for ${effect.durationTicks || 5} seconds.`, 0, hero.hp, enemy?.hp, {}));
      break;
    case 'gain_parry_chance_pct':
      hero.activeEffects = hero.activeEffects || [];
      hero.activeEffects.push({
        type: 'parry_chance',
        value: effect.value || 15,
        remainingTicks: effect.durationTicks || 5,
        source: ctx.nodeId,
      });
      log.push(makeEntry(tick, 'hero', 'proc', `Perfect Rhythm: +${effect.value || 15}% parry for ${effect.durationTicks || 5} seconds.`, 0, hero.hp, enemy?.hp, {}));
      break;
    case 'set_bleed_carry':
      procState.bleedCarry = Math.max(procState.bleedCarry || 0, effect.value || 2);
      break;
    case 'set_rage_carry':
      procState.carriedRage = Math.min(100, procState.rage);
      break;
    case 'gain_rage_from_carry':
      if ((procState.carriedRage || 0) > 0) {
        const restored = Math.floor(procState.carriedRage * (effect.pct || 30) / 100);
        procState.rage = Math.min(100, procState.rage + restored);
        if (restored > 0) log.push(makeEntry(tick, 'hero', 'proc', `Lingering Rage: +${restored} Rage carried forward.`, 0, hero.hp, enemy?.hp, {}));
        procState.carriedRage = 0;
      }
      break;
    case 'apply_hemorrhage_auto': {
      // Hemorrhage: 1.5% max HP TRUE damage per second for 3 seconds (3 ticks). True damage —
      // the tick loop subtracts it straight from HP, bypassing armor, resists and shields.
      if (enemy && enemy.hp > 0) {
        const existing = (enemy.activeEffects || []).find(e => e.type === 'hemorrhage');
        if (!existing) {
          enemy.activeEffects = enemy.activeEffects || [];
          enemy.activeEffects.push({ type: 'hemorrhage', remainingTicks: 3, damagePctPerTick: 1.5, stacks: 1 });
          log.push(makeEntry(tick, 'hero', 'bleed', `Hemorrhage Mastery: ${enemy.name} begins hemorrhaging!`, 0, hero.hp, enemy.hp, {}));
        }
      }
      break;
    }
    case 'reset_hemorrhage_duration': {
      const hemo = (enemy?.activeEffects || []).find(e => e.type === 'hemorrhage' && (e.remainingTicks || 0) > 0);
      if (hemo) {
        hemo.remainingTicks = 4;
        log.push(makeEntry(tick, 'hero', 'bleed', `Reopen: Hemorrhage renewed on ${enemy.name}.`, 0, hero.hp, enemy?.hp, {}));
      }
      break;
    }
    case 'reflect_damage': {
      const target = ctx.attacker && ctx.attacker.hp > 0 ? ctx.attacker : enemy;
      if (!target || target.hp <= 0 || !(ctx.damage > 0)) break;
      const reflectedDamage = Math.max(1, Math.floor(ctx.damage));
      const applied = applyCombatantDamage(target, reflectedDamage);
      log.push(makeEntry(tick, 'hero', 'hit', `Spite Wall reflects ${applied.damage} damage to ${target.name}!`, applied.damage, hero.hp, target.hp, {
        targetId: target.id,
        reflectedDamage,
        shieldAbsorbed: applied.absorbed || 0,
      }));
      break;
    }
    case 'stun_enemy': {
      if (!enemy || enemy.hp <= 0) break;
      applyStunToCombatant(enemy, tick, getEffectDurationTicks(effect, 1));
      log.push(makeEntry(tick, 'hero', 'stun', `Steel Mirror: ${enemy.name} is stunned!`, 0, hero.hp, enemy.hp, {}));
      break;
    }
    case 'gain_damage_this_fight':
      hero.activeEffects = hero.activeEffects || [];
      hero.activeEffects.push({ type: 'damage_bonus_pct_buff', value: effect.value || 15, remainingTicks: 99999 });
      log.push(makeEntry(tick, 'hero', 'proc', `The Debt: +${effect.value || 15}% damage this fight.`, 0, hero.hp, enemy?.hp, {}));
      break;
    case 'gain_physical_reduction_pct': {
      const value = effect.value || effect.reductionPct || 30;
      const durationTicks = effect.durationTicks || effect.ticks || 6;
      const source = ctx.nodeId || effect.source || 'physical_reduction_pct';
      hero.activeEffects = (hero.activeEffects || []).filter(active => active.source !== source);
      hero.activeEffects.push({
        type: 'physical_reduction_pct',
        value,
        remainingTicks: durationTicks,
        source,
      });
      log.push(makeEntry(tick, 'hero', 'proc', `The Debt: +${value}% physical damage reduction for ${durationTicks} seconds.`, 0, hero.hp, enemy?.hp, {
        source,
        reductionPct: value,
      }));
      break;
    }
    case 'crash_landing':
      procState.momentumStacks = Math.max(0, procState.momentumStacks - 3);
      procState.guaranteedNextHit = true;
      break;
    case 'stutter_step': {
      hero.activeEffects = (hero.activeEffects || [])
        .filter(active => active.source !== 'speed_stutter_step');
      const evasionChance = effect.evasionChanceBonus || 10;
      const critChance = effect.critChanceBonus || 10;
      hero.activeEffects.push(
        { type: 'evasion_chance', value: evasionChance, source: 'speed_stutter_step', consumeOnNextHit: true },
        { type: 'crit_chance_buff', value: critChance, source: 'speed_stutter_step', consumeOnNextHit: true },
      );
      log.push(makeEntry(tick, 'hero', 'proc', `Stutter Step: +${evasionChance}% dodge and +${critChance}% crit until your next hit.`, 0, hero.hp, enemy?.hp, {}));
      break;
    }
    case 'flash_burst': {
      const attacksPerTick = effect.attacksPerTick || 3;
      const ticks = effect.ticks || 2;
      hero.activeEffects = (hero.activeEffects || []).filter(active => active.type !== 'flash_burst');
      hero.activeEffects.push({
        type: 'flash_burst',
        attacksPerTick,
        stacks: attacksPerTick,
        remainingTicks: ticks + 1,
      });
      procState.momentumStacks = 0;
      procState.momentumMaxHeldTicks = 0;
      log.push(makeEntry(tick, 'hero', 'proc', `Flash: ${attacksPerTick} attacks per tick for ${ticks} ticks. Momentum resets.`, 0, hero.hp, enemy?.hp, {}));
      break;
    }
    case 'thousand_cuts': {
      if (!enemy || enemy.hp <= 0) break;
      const hits = effect.hits || 4;
      const mult = effect.damageMult || 0.35;
      for (let i = 0; i < hits; i++) {
        if (enemy.hp <= 0) break;
        const rawDmg = Math.max(1, Math.floor((hero.damage || 0) * mult));
        const dmg = applyArmor(rawDmg, getEffectiveArmor(enemy), 0);
        enemy.hp = Math.max(0, enemy.hp - dmg);
        log.push(makeEntry(tick, 'hero', 'hit', `Thousand Cuts: ${dmg}.`, dmg, hero.hp, enemy.hp, {
          targetId: enemy.id,
          extraHit: true,
          extraHitSource: 'thousand_cuts',
        }));
      }
      procState.bladeStacks = 0;
      break;
    }
    case 'cap_hit_damage':
      // Handled pre-damage in resolveBasicAttackImpact when Scar conditions are active.
      break;
    case 'exsanguinate_burst': {
      if (!enemy || enemy.hp <= 0) break;
      const bleedEff = (enemy.activeEffects || []).find(e => e.type === 'bleed');
      const stacks = Math.max(1, bleedEff?.stacks || 1);
      const damagePctPerTick = bleedEff?.damagePctPerTick || 2;
      const remainingTicks = bleedEff?.remainingTicks || 1;
      const dmgPerTick = Math.max(1, Math.floor((enemy.maxHp || enemy.hp) * damagePctPerTick * stacks / 100));
      const dmg = Math.max(1, dmgPerTick * remainingTicks);
      enemy.hp = Math.max(0, enemy.hp - dmg);
      applyStunToCombatant(enemy, tick, effect.stunTicks || 1);
      if (effect.vulnerable) {
        const vuln = effect.vulnerable;
        enemy.activeEffects = (enemy.activeEffects || [])
          .filter(e => !(e.type === DAMAGE_TAKEN_BONUS_EFFECT && e.source === 'exsanguinate'));
        enemy.activeEffects.push({
          type: DAMAGE_TAKEN_BONUS_EFFECT,
          value: vuln.damageTakenPct || 10,
          remainingTicks: vuln.durationTicks || 5,
          source: 'exsanguinate',
        });
      }
      if (effect.clearBleed) {
        enemy.activeEffects = (enemy.activeEffects || []).filter(e => e.type !== 'bleed');
      }
      log.push(makeEntry(tick, 'hero', 'hit',
        `Exsanguinate! ${dmg} burst damage (${remainingTicks} tick${remainingTicks !== 1 ? 's' : ''} × ${stacks} stack${stacks !== 1 ? 's' : ''}) — Vulnerable & stunned! Bleed consumed.`,
        dmg, hero.hp, enemy.hp, {}));
      break;
    }
    case 'enter_flow_state':
      procState.flowStateTicks = effect.ticks || 4;
      log.push(makeEntry(tick, 'hero', 'proc', `Flow State: all hits crit for ${effect.ticks || 4} ticks!`, 0, hero.hp, enemy?.hp, {}));
      break;
    case 'enter_juggernaut':
      procState.juggernaut = true;
      log.push(makeEntry(tick, 'hero', 'proc', `JUGGERNAUT: armor cannot be reduced, -30% damage taken, -20% damage dealt.`, 0, hero.hp, enemy?.hp, {}));
      break;
    case 'death_cheat':
      hero.activeEffects = (hero.activeEffects || []).filter(active => active.type !== 'last_breath');
      // remainingTicks: null = persistent until it actually saves the hero (consumed in preventDeathWithLastBreath)
      hero.activeEffects.push({ type: 'last_breath', remainingTicks: null });
      log.push(makeEntry(tick, 'hero', 'proc', `Last Breath: you will survive the next lethal blow!`, 0, hero.hp, enemy?.hp, {}));
      break;
    case 'opener_attack': {
      if (!enemy || enemy.hp <= 0) break;
      const rawDmg = Math.max(1, Math.floor((hero.damage || 0) * (effect.damageMult || 1)));
      const dmg = applyArmor(rawDmg, getEffectiveArmor(enemy), 0);
      enemy.hp = Math.max(0, enemy.hp - dmg);
      log.push(makeEntry(tick, 'hero', 'hit', `Ambush: ${dmg} damage.`, dmg, hero.hp, enemy.hp, {
        targetId: enemy.id,
        extraHit: true,
        extraHitSource: 'opener_attack',
      }));
      const openerBleedStacks = (hero.passiveEffects || []).reduce((sum, e) => e.type === 'opener_applies_bleed' ? sum + (e.stacks || 1) : sum, 0);
      if (openerBleedStacks > 0 && !isBleedImmune(enemy)) {
        for (let s = 0; s < openerBleedStacks; s++) applyEnemyBleed(enemy, tick, log, hero, procState);
      }
      break;
    }
    case 'apply_shadow_mark': {
      if (!enemy || enemy.hp <= 0) break;
      const maxStacks = effect.maxStacks || 5;
      const addStacks = effect.stacks || 1;
      const existing = (enemy.activeEffects || []).find(e => e.type === 'shadow_mark');
      if (existing) {
        existing.stacks = Math.min(maxStacks, (existing.stacks || 0) + addStacks);
      } else {
        enemy.activeEffects = (enemy.activeEffects || []);
        enemy.activeEffects.push({ type: 'shadow_mark', stacks: Math.min(maxStacks, addStacks) });
      }
      const markEff = (enemy.activeEffects || []).find(e => e.type === 'shadow_mark');
      const stacks = markEff?.stacks || 1;
      log.push(makeEntry(tick, 'hero', 'proc', `Shadow Mark: ${enemy.name} marked (${stacks}/${maxStacks}).`, 0, hero.hp, enemy.hp, {
        targetId: enemy.id,
      }));
      break;
    }
    case 'predators_focus': {
      // Predator's Focus (Shadow tree): on crit, refund Energy. (The crit-damage-per-mark half is a
      // passive `crit_damage_pct_per_mark` effect applied in the crit calc, not here.) Silent — crits
      // are frequent, so logging every refund would spam the combat log.
      const energyGain = effect.energy ?? 8;
      if (energyGain > 0) {
        procState.energy = Math.min(HERO_ENERGY_MAX, (procState.energy || 0) + energyGain);
      }
      break;
    }
    case 'gain_energy_per_bleed_tick': {
      const bleedStacks = ctx.bleedStacks || 0;
      let gain = effect.value || 0;
      if (effect.bonusCondition?.bleed_stacks_gte != null && bleedStacks >= effect.bonusCondition.bleed_stacks_gte) {
        gain += effect.bonusValue || 0;
      }
      if (gain > 0) {
        procState.energy = Math.min(HERO_ENERGY_MAX, (procState.energy || 0) + gain);
        log.push(makeEntry(tick, 'hero', 'proc', `Energy: +${gain} from bleed tick.`, 0, hero.hp, enemy?.hp, {}));
      }
      break;
    }
    case 'apply_poison': {
      if (!enemy || enemy.hp <= 0 || isPoisonImmune(enemy)) break;
      const durationTicks = effect.duration || 4;
      const damagePctPerTick = effect.damagePct || 1.4;
      const existingPoison = (enemy.activeEffects || []).find(e => e.type === 'poison');
      if (existingPoison) {
        existingPoison.remainingTicks = Math.max(existingPoison.remainingTicks || 0, durationTicks);
        existingPoison.damagePctPerTick = Math.max(existingPoison.damagePctPerTick || 1, damagePctPerTick);
      } else {
        enemy.activeEffects = (enemy.activeEffects || []);
        enemy.activeEffects.push({ type: 'poison', remainingTicks: durationTicks, stacks: 1, damagePctPerTick });
      }
      log.push(makeEntry(tick, 'hero', 'proc', `${enemy.name} is poisoned!`, 0, hero.hp, enemy.hp, {
        targetId: enemy.id,
      }));
      break;
    }
    case 'multi':
      for (const sub of (effect.effects || [])) {
        applyProcEffect(sub, ctx, procState, heroProcNodes, hero, enemy, tick, log, rng);
      }
      break;
    default:
      break;
  }
}

function fireProcTrigger(trigger, ctx, procState, heroProcNodes, hero, enemy, tick, log, rng) {
  if (!heroProcNodes || !heroProcNodes.length || !procState) return;
  // Use the isolated proc RNG when available so proc chance-rolls don't consume
  // from the shared combat RNG.  This keeps hit/miss/damage sequences identical
  // on both screens in duel mode even when proc triggers fire asymmetrically.
  const procRng = procState.procRng || rng;
  for (const node of heroProcNodes) {
    if (!node.proc || node.proc.trigger !== trigger) continue;
    if (node.proc.held_ticks != null && (ctx.heldTicks || 0) < node.proc.held_ticks) continue;
    const nodeCtx = { ...ctx, trigger, nodeId: node.id };
    if (trigger === 'on_hp_cross_below') {
      const threshold = node.proc.threshold_value ?? node.proc.thresholdPct ?? node.proc.threshold;
      if (threshold != null) {
        const before = nodeCtx.hpPctBefore ?? 100;
        const after = nodeCtx.hpPctAfter ?? getHpPct(hero);
        if (!(before >= threshold && after <= threshold)) continue;
      }
    }
    if (trigger === 'on_momentum_reach') {
      const threshold = node.proc.threshold;
      if (threshold != null && !(ctx.prevStacks < threshold && ctx.newStacks >= threshold)) continue;
    }
    if (trigger === 'on_scar_stacks_reach') {
      const threshold = node.proc.threshold;
      if (threshold != null && !(ctx.prevStacks < threshold && ctx.newStacks >= threshold)) continue;
    }
    if (!checkProcCondition(node.proc.condition, nodeCtx, procState, hero, enemy)) continue;
    if (node.proc.cooldownTicks != null) {
      const readyAt = procState.nodeCooldowns?.[node.id] ?? 0;
      if (tick < readyAt) continue;
    }
    const chance = node.proc.chance ?? 100;
    if (chance < 100 && procRng() * 100 >= chance) continue;
    if (node.proc.condition?.once_per_combat) {
      procState.onceFiredIds = [...procState.onceFiredIds, node.id];
    }
    if (node.proc.cooldownTicks != null) {
      procState.nodeCooldowns = procState.nodeCooldowns || {};
      procState.nodeCooldowns[node.id] = tick + node.proc.cooldownTicks;
    }
    applyProcEffect(node.proc.effect, nodeCtx, procState, heroProcNodes, hero, enemy, tick, log, procRng);
  }
}

function loseMomentumOnHeroAutoMiss(procState, hero, enemy, tick, log) {
  if (!procState || (procState.momentumStacks || 0) <= 0) return;
  const missLoss = (hero?.passiveEffects || []).reduce((acc, e) =>
    e.type === 'momentum_miss_stacks_lost' ? Math.min(acc, e.value ?? 2) : acc, 2);
  const lost = Math.min(missLoss, procState.momentumStacks || 0);
  procState.momentumStacks = Math.max(0, (procState.momentumStacks || 0) - lost);
  procState.momentumMaxHeldTicks = 0;
  log.push(makeEntry(tick, 'hero', 'proc', `Momentum: missed auto attack and lost ${lost} stack${lost !== 1 ? 's' : ''}.`, 0, hero.hp, enemy?.hp, {
    momentumLost: lost,
  }));
}

function updateMomentumMaxHeld(heroProcNodes, procState, hero, enemy, tick, log, rng) {
  if (!procState) return;
  if ((procState.momentumStacks || 0) >= getMomentumMax(heroProcNodes, hero)) {
    procState.momentumMaxHeldTicks = (procState.momentumMaxHeldTicks || 0) + 1;
    fireProcTrigger('on_momentum_max_held', {
      heldTicks: procState.momentumMaxHeldTicks,
    }, procState, heroProcNodes, hero, enemy, tick, log, rng);
  } else {
    procState.momentumMaxHeldTicks = 0;
  }
}

function getThresholdReplacementIds(node = {}) {
  const threshold = node.threshold || {};
  return [
    ...(Array.isArray(node.replacesThresholdIds) ? node.replacesThresholdIds : []),
    ...(Array.isArray(node.upgradesFromIds) ? node.upgradesFromIds : []),
    ...(Array.isArray(threshold.replacesThresholdIds) ? threshold.replacesThresholdIds : []),
    ...(Array.isArray(threshold.upgradesFromIds) ? threshold.upgradesFromIds : []),
    node.replacesThresholdId,
    node.upgradesFromId,
    threshold.replacesThresholdId,
    threshold.upgradesFromId,
  ].filter(Boolean);
}

function applyThresholdEffects(heroProcNodes, procState, hero, enemy, allies = []) {
  if (!procState) return;
  const nodes = heroProcNodes || [];
  hero.passiveEffects = [...(hero.basePassiveEffects || hero.passiveEffects || [])];
  if (procState.juggernaut) {
    hero.passiveEffects.push({ type: 'juggernaut_active', value: 1 });
    hero.passiveEffects.push({ type: 'damage_taken_reduction_pct', value: JUGGERNAUT_DAMAGE_TAKEN_REDUCTION_PCT, source: 'juggernaut' });
    hero.passiveEffects.push({ type: 'threshold_dmg_pct', value: JUGGERNAUT_DAMAGE_DEALT_PCT, source: 'juggernaut' });
  }
  if ((procState.flowStateTicks || 0) > 0) {
    hero.passiveEffects.push({ type: 'force_crit', value: 1 });
  }
  if ((procState.bladeStacks || 0) > 0) {
    hero.passiveEffects.push({ type: 'crit_chance_bonus', value: procState.bladeStacks * 6, source: 'blade_stacks' });
  }
  if ((procState.momentumStacks || 0) > 0) {
    hero.passiveEffects.push({
      type: 'attack_speed_bonus_pct',
      value: procState.momentumStacks * MOMENTUM_ATTACK_SPEED_PCT_PER_STACK,
      source: 'momentum',
    });
  }
  procState.activeThresholdIds = [];
  const activeThresholds = [];
  const procNodeIds = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    if (!node.threshold) continue;
    const { stat, min, max, effects: threshEffects, replacesThresholdIds: replIds } = node.threshold;
    if (replIds?.length && !replIds.every(id => procNodeIds.has(id))) continue;
    let value = 0;
    if (stat === 'rage') value = procState.rage;
    else if (stat === 'hp_pct') value = getHpPct(hero);
    else if (stat === 'hp_pct_missing') value = 100 - getHpPct(hero);
    else if (stat === 'momentum_stacks') value = procState.momentumStacks;
    else if (stat === 'blade_stacks') value = procState.bladeStacks;
    else if (stat === 'scar_stacks') value = procState.scarStacks;
    else if (stat === 'hemorrhage_active') value = (enemy?.activeEffects || []).some(e => e.type === 'hemorrhage' && (e.remainingTicks || 0) > 0) ? 100 : 0;
    if (min != null && value < min) continue;
    if (max != null && value > max) continue;
    activeThresholds.push({ node, effects: threshEffects || [] });
  }
  const replacedThresholdIds = new Set(activeThresholds.flatMap(entry => getThresholdReplacementIds(entry.node)));
  for (const { node, effects } of activeThresholds) {
    if (replacedThresholdIds.has(node.id)) continue;
    procState.activeThresholdIds.push(node.id);
    hero.passiveEffects.push({ type: 'threshold_status', statusType: node.id });
    hero.passiveEffects.push(...effects.map(e => (e.chance > 0 ? { ...e, _threshold: true } : e)));
  }
  applyRelentlessPressure(hero, enemy, allies, procState);
  applyPetAliveDamageReduction(hero, allies);
}

function updateSniperPatience(hero, procState) {
  if (!hero?.isPlayer || !procState) return;
  const effect = (hero.basePassiveEffects || hero.passiveEffects || [])
    .find(entry => entry.type === 'sniper_patience') || null;
  if (!effect) {
    procState.sniperPatiencePct = 0;
    return;
  }
  if (procState.heroAttackedThisTick) return;
  const gain = Math.max(0, effect.valuePerSecond || effect.value || 8);
  const maxPct = Math.max(gain, effect.maxPct || 40);
  procState.sniperPatiencePct = Math.min(maxPct, Math.max(0, procState.sniperPatiencePct || 0) + gain);
}

// ─── Relic Internal Tick Handler ─────────────────────────────────────────────

function getRelicDotImmunityTick(procState) {
  for (const relic of procState?.activeRelics || []) {
    const p = relic?.relicPassive;
    if (p?.type === 'first_seconds_dot_immunity') {
      return Math.round((p.durationSecs || 5) * 1000 / TICK_MS);
    }
  }
  return 0;
}

function applyRelicKillEffects(hero, procState, tick, log) {
  if (!hero?.isPlayer || !procState) return;
  const relics = procState.activeRelics || [];
  for (const relic of relics) {
    const passive = relic?.relicPassive;
    if (!passive) continue;
    if (passive.type === 'kill_heal_pct') {
      const healAmt = Math.max(1, Math.round((hero.maxHp || 0) * (passive.value || 2) / 100));
      hero.hp = Math.min(hero.maxHp, hero.hp + healAmt);
      log.push(makeEntry(tick, 'hero', 'proc', `Soul Fragment restores ${healAmt} HP.`, 0, hero.hp, null, {}));
    }
  }
}

function applyRelicTickEffectsForHeroTick(hero, allies, procState, tick, log) {
  if (!hero?.isPlayer || !procState) return;
  const relics = procState.activeRelics || [];
  for (const relic of relics) {
    const passive = relic?.relicPassive;
    if (!passive) continue;
    if (passive.type === 'hp_regen_in_combat') {
      const regenPerSec = passive.value || 2;
      const regenThisTick = regenPerSec * TICK_MS / 1000;
      if (hero.hp > 0 && hero.hp < hero.maxHp) {
        procState.relicRegenAccum = (procState.relicRegenAccum || 0) + regenThisTick;
        if (procState.relicRegenAccum >= 1) {
          const healAmt = Math.floor(procState.relicRegenAccum);
          procState.relicRegenAccum -= healAmt;
          hero.hp = Math.min(hero.maxHp, hero.hp + healAmt);
        }
      }
      if (Array.isArray(allies)) {
        procState.allyRegenAccums = procState.allyRegenAccums || {};
        for (const ally of allies) {
          if (!ally?.isAlly || ally.hp <= 0 || ally.hp >= ally.maxHp) continue;
          procState.allyRegenAccums[ally.id] = (procState.allyRegenAccums[ally.id] || 0) + regenThisTick;
          if (procState.allyRegenAccums[ally.id] >= 1) {
            const healAmt = Math.floor(procState.allyRegenAccums[ally.id]);
            procState.allyRegenAccums[ally.id] -= healAmt;
            ally.hp = Math.min(ally.maxHp, ally.hp + healAmt);
          }
        }
      }
    }
  }
}

// ─── Relic Combat Handlers ────────────────────────────────────────────────────

/**
 * Apply relic passive effects that trigger on hero hit (basic attack lands).
 * Called after a successful hero hit resolves damage on enemy.
 */
export function applyRelicOnHitEffects(heroObj, enemy, tick, log, rng, procState, isCrit, damageDealt) {
  if (!heroObj?.relics || !enemy || enemy.hp <= 0) return;
  for (const relic of heroObj.relics) {
    const passive = relic?.relicPassive;
    if (!passive) continue;

    // armor_reduce_on_hit (relic_infernal_fang)
    if (passive.type === 'armor_reduce_on_hit') {
      if (rng() * 100 < (passive.chance || 0)) {
        const reduction = passive.reduction || 3;
        const durationTicks = Math.round((passive.durationSecs || 4) * 1000 / TICK_MS);
        enemy.activeEffects = (enemy.activeEffects || []).filter(e => e.type !== 'armor_debuff_relic');
        enemy.activeEffects.push({ type: 'armor_debuff_relic', value: reduction, remainingTicks: durationTicks, label: 'Infernal Fang' });
        log.push(makeEntry(tick, 'hero', 'proc', `Infernal Fang: -${reduction} armor to ${enemy.name}.`, 0, heroObj.hp, enemy.hp, {}));
      }
    }

    // burn_on_crit (relic_igneous_scale)
    if (passive.type === 'burn_on_crit' && isCrit) {
      const burnDurationTicks = Math.round((passive.burnDurationSecs || 2) * 1000 / TICK_MS);
      const burnDamagePct = passive.burnDamagePct || 3;
      enemy.activeEffects = (enemy.activeEffects || []).filter(e => e.type !== 'burning' || e.source !== 'relic_igneous_scale');
      enemy.activeEffects.push({
        type: 'burning',
        damagePctPerTick: burnDamagePct,
        remainingTicks: burnDurationTicks,
        source: 'relic_igneous_scale',
        element: 'fire',
        label: 'Igneous Scale',
      });
      log.push(makeEntry(tick, 'hero', 'proc', `Igneous Scale: burn applied to ${enemy.name}!`, 0, heroObj.hp, enemy.hp, {}));
    }

    // ally_hit_impetus_stack (relic_broken_standard) — applied on ally hit (separate hook)
    // active_skill_damage_bonus (relic_abyssal_seal) — applied in ability resolution
    // first_hit_guaranteed — handled in hit-chance check
    // kill_heal_pct — handled on kill
    // hp_regen_in_combat — handled in tick processing
    // death_cheat_once — handled in death check
    // first_seconds_dot_immunity — handled in dot application
    // barrier_on_heavy_hit — handled when hero takes damage
    // dot_bonus — handled when hero applies DoT
    // max_hp_pct_bonus — handled in calcStats via relics.js
  }
}

/**
 * Apply relic effects that trigger when an ally/pet lands a hit.
 */
export function applyRelicOnAllyHit(heroObj, tick, log, procState) {
  if (!heroObj?.relics || !procState) return;
  for (const relic of heroObj.relics) {
    const passive = relic?.relicPassive;
    if (!passive) continue;
    // ally_hit_impetus_stack (relic_broken_standard)
    if (passive.type === 'ally_hit_impetus_stack') {
      const maxStacks = passive.maxStacks || 3;
      procState.impetusStacks = Math.min(maxStacks, (procState.impetusStacks || 0) + 1);
    }
  }
}

/**
 * Apply impetus stacks damage multiplier on hero attack and reset stacks.
 * Returns the multiplied damage value.
 */
export function applyImpetusDamage(damage, procState) {
  const stacks = procState?.impetusStacks || 0;
  if (stacks <= 0) return damage;
  procState.impetusStacks = 0;
  return Math.round(damage * (1 + 0.05 * stacks));
}

/**
 * Apply relic kill effects (kill_heal_pct).
 */
export function applyRelicOnKill(heroObj, heroMaxHp, tick, log, procState) {
  if (!heroObj?.relics) return;
  for (const relic of heroObj.relics) {
    const passive = relic?.relicPassive;
    if (!passive) continue;
    if (passive.type === 'kill_heal_pct') {
      const healAmt = Math.max(1, Math.round((heroMaxHp || 0) * (passive.value || 2) / 100));
      heroObj.hp = Math.min(heroObj.maxHp, heroObj.hp + healAmt);
      log.push(makeEntry(tick, 'hero', 'proc', `Soul Fragment restores ${healAmt} HP.`, 0, heroObj.hp, null, {}));
    }
    if (passive.type === 'passive_lifesteal' && passive.killRestoreHpPct) {
      const healAmt = Math.max(1, Math.round((heroObj.maxHp || 0) * passive.killRestoreHpPct / 100));
      heroObj.hp = Math.min(heroObj.maxHp, heroObj.hp + healAmt);
      log.push(makeEntry(tick, 'hero', 'proc', `Ancestral Stone: kills restore ${healAmt} HP.`, 0, heroObj.hp, null, {}));
    }
  }
}

/**
 * Apply relic per-tick effects (hp_regen_in_combat).
 * Called once per combat tick.
 */
export function applyRelicTickEffects(heroObj, tick, log, procState) {
  if (!heroObj?.relics || !heroObj.isPlayer) return;
  for (const relic of heroObj.relics) {
    const passive = relic?.relicPassive;
    if (!passive) continue;
    if (passive.type === 'hp_regen_in_combat') {
      const regenPerSec = passive.value || 2;
      const regenPerTick = regenPerSec / (1000 / TICK_MS);
      if (heroObj.hp < heroObj.maxHp) {
        heroObj.hp = Math.min(heroObj.maxHp, heroObj.hp + regenPerTick);
      }
    }
  }
}

/**
 * Apply the death_cheat_once relic (once per combat, survive fatal hit at 1 HP).
 * Uses the same mechanism as last_breath.
 */
export function applyRelicDeathCheat(heroObj, tick, log, procState) {
  if (!heroObj?.relics || heroObj.hp > 0) return false;
  // Check for death_cheat_once relic that hasn't fired yet
  if (procState?.relicDeathCheatFired) return false;
  for (const relic of heroObj.relics) {
    const passive = relic?.relicPassive;
    if (passive?.type !== 'death_cheat_once') continue;
    // Apply
    if (procState) procState.relicDeathCheatFired = true;
    heroObj.hp = 1;
    log.push(makeEntry(tick, 'hero', 'proc', 'Spectral Echo: you survive at 1 HP!', 0, 1, null, { preventedDeath: true }));
    return true;
  }
  return false;
}

/**
 * Check if hero has dot immunity from relic (first_seconds_dot_immunity).
 */
export function heroHasRelicDotImmunity(heroObj, tick) {
  if (!heroObj?.relics) return false;
  for (const relic of heroObj.relics) {
    const passive = relic?.relicPassive;
    if (passive?.type !== 'first_seconds_dot_immunity') continue;
    const immuneSecs = passive.durationSecs || 5;
    const immuneTicks = Math.round(immuneSecs * 1000 / TICK_MS);
    if (tick <= immuneTicks) return true;
  }
  return false;
}

/**
 * Apply barrier_on_heavy_hit relic effect when hero takes damage.
 * Sets procState.relicBarrier if conditions are met.
 */
export function applyRelicBarrierOnHeavyHit(heroObj, incomingDamage, tick, log, procState) {
  if (!heroObj?.relics || !procState) return;
  for (const relic of heroObj.relics) {
    const passive = relic?.relicPassive;
    if (passive?.type !== 'barrier_on_heavy_hit') continue;
    const threshold = passive.threshold || 15;
    const barrierAmount = passive.barrierAmount || 20;
    const hpPct = (heroObj.maxHp || 1) * threshold / 100;
    if (incomingDamage > hpPct && !(procState.relicBarrier > 0)) {
      procState.relicBarrier = barrierAmount;
      log.push(makeEntry(tick, 'hero', 'proc', `Black Armor: barrier of ${barrierAmount} damage activated.`, 0, heroObj.hp, null, {}));
    }
  }
}

/**
 * Absorb incoming damage through relicBarrier in procState.
 * Returns adjusted damage after barrier absorption.
 */
export function absorbRelicBarrier(damage, procState) {
  if (!procState || !(procState.relicBarrier > 0)) return damage;
  const absorbed = Math.min(procState.relicBarrier, damage);
  procState.relicBarrier = Math.max(0, procState.relicBarrier - absorbed);
  return Math.max(0, damage - absorbed);
}

/**
 * Apply enchantment proc effects (fire, lightning, armor reduce) on hero hit.
 * heroInventory: hero's inventory items that may have enchantments.
 * heroEquip: hero's equipped items.
 */
export function applyEnchantmentProcs(heroInventory, heroEquip, enemy, tick, log, rng) {
  if (!enemy || enemy.hp <= 0) return;

  const allEnchanted = [];
  for (const item of Object.values(heroEquip || {})) {
    if (item?.enchantment?.effect) allEnchanted.push(item.enchantment.effect);
  }
  for (const placed of (heroInventory || [])) {
    if (placed?.itemId && typeof placed.itemId === 'object' && placed.itemId.enchantment?.effect) {
      allEnchanted.push(placed.itemId.enchantment.effect);
    }
  }

  for (const e of allEnchanted) {
    if (!e?.type || !e?.chance) continue;
    if (rng() * 100 >= e.chance) continue;

    if (e.type === 'fire_proc_on_hit') {
      const dmg = Math.max(1, e.damage || Math.floor(((e.minDamage || 0) + (e.maxDamage || 0)) / 2));
      enemy.hp = Math.max(0, enemy.hp - dmg);
      log.push(makeEntry(tick, 'hero', 'hit', `Ember: ${dmg} fire damage!`, dmg, null, enemy.hp, { element: 'fire' }));
      if (e.burnGuaranteed || (e.burnChanceBonus && rng() * 100 < e.burnChanceBonus)) {
        const burnTicks = Math.round(((e.burnDurationSecs || 2) * 1000) / TICK_MS);
        enemy.activeEffects = (enemy.activeEffects || []).filter(eff => eff.type !== 'burning' || eff.source !== 'enchant_ember');
        enemy.activeEffects.push({
          type: 'burning',
          damagePctPerTick: e.burnDamagePct || 3,
          remainingTicks: burnTicks,
          source: 'enchant_ember',
          element: 'fire',
        });
      }
    } else if (e.type === 'lightning_proc_on_hit') {
      const dmg = Math.max(1, e.damage || Math.floor(((e.minDamage || 0) + (e.maxDamage || 0)) / 2));
      enemy.hp = Math.max(0, enemy.hp - dmg);
      log.push(makeEntry(tick, 'hero', 'hit', `Storm: ${dmg} lightning damage!`, dmg, null, enemy.hp, { element: 'lightning' }));
    } else if (e.type === 'armor_reduce_on_hit') {
      const reduction = e.reduction || 2;
      const durationTicks = Math.round(((e.durationSecs || 3) * 1000) / TICK_MS);
      enemy.activeEffects = (enemy.activeEffects || []).filter(eff => eff.type !== 'armor_debuff_enchant');
      enemy.activeEffects.push({ type: 'armor_debuff_enchant', value: reduction, remainingTicks: durationTicks });
      log.push(makeEntry(tick, 'hero', 'proc', `Shadow: -${reduction} armor to ${enemy.name}.`, 0, null, enemy.hp, {}));
    }
  }
}

export function buildCombatResult(state) {
  const ps = state.procState || {};
  const allies = (state.combatants.allies || []).map(ally => ({
    id: ally.id,
    sourceId: ally.sourceId || ally.id,
    hp: Math.max(0, Math.floor(ally.hp || 0)),
    maxHp: Math.max(1, Math.floor(ally.maxHp || 1)),
  }));
  return {
    won: state.phase === PHASE.WON,
    fled: state.phase === PHASE.FLED,
    log: state.log,
    hpLeft: Math.max(0, Math.floor(state.combatants.hero.hp)),
    allies,
    rounds: state.tick,
    heroConditions: state.heroConditions || { bleeding: null, poison: null },
    heroWounds: state.heroWounds || { deepCut: 0 },
    procState: {
      bleedCarry: ps.bleedCarry || 0,
      momentumCarry: ps.momentumCarry || 0,
      hasTakenDamage: ps.hasTakenDamageThisFight || false,
      carriedRage: ps.rage || 0,
    },
    ultimateChargePct: Math.max(0, Math.min(100, state.ultimateChargePct || 0)),
  };
}
