import { adventureById, bossById, enemyById, regionById, zoneById } from "./content.js";
import { applyEnemyRarity, getDayNight, rollEnemyRarity, scaleCombatant, ENEMY_RARITIES } from "./enemies.js";
import { getEncounterTableEnemyIds, rollEncounterTable } from "./encounters.js";
import { advanceDungeonProgress, createDungeonEncounter, createDungeonProgress, enterDungeon, getDungeonMap, hasEnteredDungeon, isDungeonAdventure, isDungeonNodeSelectable, normalizeDungeonProgress, revertDungeonOnDeath, selectDungeonNode } from "./dungeon.js";
import { applyCampfireRarityToEvent } from "./campfires.js";
import {
  ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR,
  clampAdventureDifficultyStars,
  clampSelectedAdventureDifficultyStars,
  clampUnlockedAdventureDifficultyStars,
} from "./adventureDifficulty.js";

const CHOICE_RUN_SCHEMA = 1;
const CHOICE_RUN_MAX_STEPS = 10;
const CHOICE_RUN_MIN_BOSS_STEPS = 5;
export const ROOTSPIRE_TOWER_ADVENTURE_IDS = [
  "rootspire_floor_1",
  "rootspire_floor_2",
  "rootspire_floor_3",
  "rootspire_rooftop",
];

function shouldUseChoiceRun(adventure) {
  if (!adventure || isDungeonAdventure(adventure)) return false;
  if (adventure.choiceRun === false || adventure.disableChoiceRun) return false;
  return adventure.proceduralChoices || adventureById[adventure.id] === adventure;
}

function hashString(value = "") {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRng(seed) {
  let state = (seed || 1) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function randomSeed(adventure) {
  return (hashString(adventure?.id || "adventure") ^ Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function findOpenStep(preferred, min, max, blocked = new Set()) {
  if (preferred == null || max < min) return null;
  const start = clampInt(preferred, min, max);
  for (let offset = 0; offset <= max - min; offset++) {
    const forward = start + offset;
    if (forward <= max && !blocked.has(forward)) return forward;
    const backward = start - offset;
    if (backward >= min && !blocked.has(backward)) return backward;
  }
  return null;
}

function shuffle(values = [], rng = Math.random) {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index--) {
    const target = Math.floor(rng() * (index + 1));
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}

function makeRepeatingPicker(ids = [], rng = Math.random) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  let deck = shuffle(uniqueIds.length ? [...uniqueIds, ...uniqueIds.slice(0, Math.max(1, Math.ceil(uniqueIds.length / 2)))] : [], rng);
  let index = 0;
  return fallbackIds => {
    const fallback = [...new Set((fallbackIds || []).filter(Boolean))];
    if (!deck.length) deck = shuffle(fallback, rng);
    if (!deck.length) return null;
    if (index >= deck.length) {
      deck = shuffle(deck, rng);
      index = 0;
    }
    return deck[index++] || deck[0] || null;
  };
}

function getLegacyAdventureNodes(adventure) {
  return (adventure?.routes || []).flatMap(route => route.nodes || []);
}

function getValidBossIds(ids = []) {
  return [...new Set(ids.filter(id => bossById[id]))];
}

function getConfiguredBossIds(...configs) {
  return getValidBossIds(configs.flatMap(config => [
    ...(Array.isArray(config?.bossIds) ? config.bossIds : []),
    ...(Array.isArray(config?.bosses) ? config.bosses : []),
    config?.bossId,
    config?.boss,
  ].filter(Boolean)));
}

function pickBossId(bossIds = [], rng = Math.random) {
  const validBossIds = getValidBossIds(bossIds);
  if (!validBossIds.length) return null;
  return validBossIds[Math.min(validBossIds.length - 1, Math.floor(rng() * validBossIds.length))];
}

function getLegacyBossIds(adventure) {
  return getConfiguredBossIds(...getLegacyAdventureNodes(adventure).filter(node => node.type === "boss"));
}

function getChoiceRunBossIds(adventure) {
  const adventureBossIds = getConfiguredBossIds(adventure, ...getLegacyAdventureNodes(adventure).filter(node => node.type === "boss"));
  if (adventureBossIds.length) return adventureBossIds;
  const zone = zoneById[adventure?.zoneId];
  return getConfiguredBossIds(zone);
}

function getChoiceRunBossId(adventure, rng = Math.random) {
  return pickBossId(getChoiceRunBossIds(adventure), rng);
}

function getNodeBossId(node, adventure, zone, rng = Math.random, progress = null) {
  const selectedBossId = node?.id ? progress?.bossRolls?.[node.id] : null;
  if (selectedBossId && bossById[selectedBossId]) return selectedBossId;
  const nodeBossIds = getConfiguredBossIds(node);
  if (nodeBossIds.length) return pickBossId(nodeBossIds, rng);
  const adventureBossIds = getConfiguredBossIds(adventure);
  if (adventureBossIds.length) return pickBossId(adventureBossIds, rng);
  return pickBossId(getConfiguredBossIds(zone), rng);
}

function repairChoiceRunBosses(adventure, choiceRun) {
  const bossIds = getChoiceRunBossIds(adventure);
  const fallbackBossId = bossIds[0] || null;
  if (!fallbackBossId || !choiceRun?.route?.nodes) return choiceRun;
  let changed = false;
  const nodes = choiceRun.route.nodes.map(node => {
    if (node.type !== "boss" || bossIds.includes(node.bossId)) return node;
    changed = true;
    return { ...node, bossId: fallbackBossId };
  });
  if (!changed) return choiceRun;
  return {
    ...choiceRun,
    route: {
      ...choiceRun.route,
      nodes,
    },
  };
}

function getAdventureEnemyPoolIds(adventure, zone) {
  const legacyIds = getLegacyAdventureNodes(adventure).flatMap(node => [
    ...getNodeEnemyIds(node),
    ...(node.encounterTableId ? getEncounterTableEnemyIds(node.encounterTableId) : []),
  ]);
  const ids = legacyIds.length ? legacyIds : (zone?.enemyPool || []);
  return [...new Set(ids)].filter(id => enemyById[id]);
}

function getConfiguredChoiceEnemyIds(choiceConfig = {}) {
  return [
    ...(Array.isArray(choiceConfig.enemyIds) ? choiceConfig.enemyIds : []),
    ...(Array.isArray(choiceConfig.extraEnemyIds) ? choiceConfig.extraEnemyIds : []),
    ...(Array.isArray(choiceConfig.enemyPoolIds) ? choiceConfig.enemyPoolIds : []),
  ].filter(id => enemyById[id]);
}

export function getChoiceRunEnemyPoolIds(adventure) {
  const zone = zoneById[adventure?.zoneId];
  const choiceConfig = getChoiceRunConfig(adventure);
  return [...new Set([
    ...getAdventureEnemyPoolIds(adventure, zone),
    ...getConfiguredChoiceEnemyIds(choiceConfig),
    ...(choiceConfig.specialEnemyIds || []).filter(id => enemyById[id]),
  ])];
}

function getThreatRank(enemy) {
  if (!enemy) return 1;
  if (enemy.threat === "minor") return 0;
  if (enemy.threat === "standard") return 1;
  if (enemy.threat === "dangerous") return 2;
  if (enemy.threat === "special" || enemy.isMiniBoss || enemy.phases || enemy.boss) return 3;
  return Math.max(0, Math.min(3, Math.floor((enemy.tier || 1) / 2)));
}

function getChoiceRunConfig(adventure) {
  if (adventure?.choiceRunConfig) return adventure.choiceRunConfig;
  return adventure?.choiceRun && typeof adventure.choiceRun === "object" ? adventure.choiceRun : {};
}

function splitEnemyPools(ids = [], configuredSpecialIds = []) {
  const valid = [...new Set(ids)].map(id => enemyById[id]).filter(Boolean);
  const configuredSpecials = new Set((configuredSpecialIds || []).filter(id => enemyById[id]));
  const standardCandidates = valid.filter(enemy => !configuredSpecials.has(enemy.id));
  const byRank = rank => standardCandidates.filter(enemy => getThreatRank(enemy) === rank).map(enemy => enemy.id);
  const easy = byRank(0);
  const medium = [...byRank(1), ...easy];
  const hard = [...byRank(2), ...byRank(3), ...byRank(1)];
  const special = valid.filter(enemy => configuredSpecials.has(enemy.id) || getThreatRank(enemy) >= 3 || (enemy.abilities || []).length > 1).map(enemy => enemy.id);
  return {
    all: valid.map(enemy => enemy.id),
    easy: easy.length ? easy : valid.map(enemy => enemy.id),
    medium: medium.length ? medium : valid.map(enemy => enemy.id),
    hard: hard.length ? hard : (medium.length ? medium : valid.map(enemy => enemy.id)),
    special: special.length ? special : (hard.length ? hard : valid.map(enemy => enemy.id)),
  };
}

function getChoiceRunStepCount(adventure, zone, hasBoss) {
  const legacyCount = getLegacyAdventureNodes(adventure).filter(node => {
    if (isWaypointNode(node)) return false;
    if (node.event?.effects?.some(effect => effect.type === "enter_adventure" || effect.type === "leave_adventure")) return false;
    return node.type === "combat" || node.type === "boss" || node.type === "event";
  }).length;
  if (adventure?.id === "rootspire_tower") return 1;
  const configured = adventure?.encounterCount || zone?.rooms || legacyCount || 7;
  const min = hasBoss ? CHOICE_RUN_MIN_BOSS_STEPS : 1;
  return clampInt(configured, min, CHOICE_RUN_MAX_STEPS);
}

function getChestLootTable(adventure, zone) {
  if (adventure?.lootPoolId === "orc_war_camp" || zone?.id === "orc_war_camp") return "orc_basic";
  if (adventure?.lootPoolId === "crypts" || adventure?.id === "crypts" || adventure?.id === "crypts_floor_2" || zone?.lootPoolId === "crypts" || zone?.id === "crypts") return "crypts_chest_equipment";
  return "forest_chest_equipment";
}

function makeGeneratedNode(adventure, stepIndex, choiceIndex, type, patch = {}) {
  const role = patch.encounterRole || type;
  return {
    id: `${adventure.id}_choice_${stepIndex}_${choiceIndex}_${role}`,
    type,
    stepIndex,
    choiceIndex,
    next: [],
    generatedChoice: true,
    ...patch,
  };
}

function makeCombatChoice(adventure, stepIndex, choiceIndex, enemyId, patch = {}) {
  return makeGeneratedNode(adventure, stepIndex, choiceIndex, "combat", {
    enemyId,
    encounterRole: "standard",
    difficulty: "medium",
    ...patch,
  });
}

function makeSpecialCombatChoice(adventure, stepIndex, choiceIndex, enemyId) {
  return makeCombatChoice(adventure, stepIndex, choiceIndex, enemyId, {
    encounterRole: "special",
    difficulty: "special",
  });
}

function makeShrineChoice(adventure, stepIndex, choiceIndex, rarity = null) {
  return makeGeneratedNode(adventure, stepIndex, choiceIndex, "event", {
    encounterRole: "shrine",
    difficulty: "support",
    event: {
      id: `${adventure.id}_choice_${stepIndex}_${choiceIndex}_shrine_event`,
      title: rarity === "greater" ? "Greater Shrine" : "Restorative Shrine",
      description: "An old shrine hums softly, restoring part of your strength.",
      effects: [
        { type: "restore_hp_pct", value: rarity === "greater" ? 45 : 30 },
        { type: "restore_energy", value: rarity === "greater" ? 20 : 10 },
      ],
    },
  });
}

function makeChestChoice(adventure, zone, stepIndex, choiceIndex) {
  return makeGeneratedNode(adventure, stepIndex, choiceIndex, "event", {
    encounterRole: "chest",
    difficulty: "reward",
    event: {
      id: `${adventure.id}_choice_${stepIndex}_${choiceIndex}_chest_event`,
      title: "Guarded Chest",
      description: "A sealed chest remains after the stronger fight.",
      effects: [
        { type: "grant_gold", value: 12 + stepIndex * 3 },
        { type: "grant_loot", lootTable: getChestLootTable(adventure, zone), rolls: 1 },
      ],
    },
  });
}

function pickEnemy(picker, pool, fallback) {
  return picker(pool) || pool[0] || fallback[0] || null;
}

function pickMultiEnemyIds(picker, pools, sourceIds = null, maxCount = 2) {
  const source = [...new Set((sourceIds?.length ? sourceIds : [...(pools.hard || []), ...(pools.medium || []), ...(pools.easy || [])]).filter(Boolean))];
  const targetCount = Math.min(Math.max(1, maxCount), Math.max(2, source.length));
  const ids = [];
  let guard = 0;
  while (ids.length < targetCount && guard < 12) {
    const id = pickEnemy(picker, source, pools.all);
    if (id && !ids.includes(id)) ids.push(id);
    guard++;
  }
  if (ids.length < 2) {
    for (const id of source) {
      if (!ids.includes(id)) ids.push(id);
      if (ids.length >= 2) break;
    }
  }
  return ids.slice(0, Math.min(maxCount, Math.max(2, ids.length)));
}

function pickConfiguredMultiEnemyIds(tableId, rng = Math.random) {
  const roll = tableId ? rollEncounterTable(tableId, rng) : null;
  const enemyIds = roll?.entry?.enemyIds || roll?.enemies?.map(enemy => enemy.id) || [];
  return enemyIds.filter(id => enemyById[id]);
}

function createChoiceLayer(adventure, zone, stepIndex, totalSteps, markers, pools, pickers, rng) {
  if (stepIndex === markers.bossStep && markers.bossId) {
    return [makeGeneratedNode(adventure, stepIndex, 0, "boss", {
      bossId: markers.bossId,
      encounterCap: 1,
      encounterRole: "boss",
      difficulty: "boss",
    })];
  }
  if (stepIndex === markers.chestStep) return [makeChestChoice(adventure, zone, stepIndex, 0)];
  if (stepIndex === markers.multiStep) {
    const configuredEnemyIds = pickConfiguredMultiEnemyIds(markers.multiEncounterTableId, rng);
    const neutralMultiPool = pools.medium?.length >= 2 ? pools.medium : [...new Set([...(pools.medium || []), ...(pools.easy || [])])];
    const enemyIds = configuredEnemyIds.length >= 2 ? configuredEnemyIds.slice(0, 2) : pickMultiEnemyIds(pickers.medium, pools, neutralMultiPool, 2);
    return [makeCombatChoice(adventure, stepIndex, 0, enemyIds[0], {
      enemyIds,
      ...(markers.multiEncounterTableId ? { sourceEncounterTableId: markers.multiEncounterTableId } : {}),
      encounterCap: 1,
      encounterRole: "multi",
      difficulty: "medium",
      bossDeathEndsFight: false,
      addsDespawnOnBossDeath: false,
    })];
  }
  if (stepIndex === markers.specialStep && markers.requiredSpecialStep) {
    const enemyId = markers.specialEnemyIds?.[0] || pickEnemy(pickers.special, pools.special, pools.hard);
    return enemyId ? [makeSpecialCombatChoice(adventure, stepIndex, 0, enemyId)] : [];
  }

  const early = stepIndex <= 1;
  const choiceCount = early ? (rng() < 0.55 ? 2 : 1) : 2 + (rng() < 0.32 ? 1 : 0);
  const neutralPool = pools.medium?.length ? pools.medium : pools.easy?.length ? pools.easy : pools.all;
  const standardPool = early ? (pools.easy?.length ? pools.easy : neutralPool) : neutralPool;
  const standardPicker = early ? pickers.easy : pickers.medium;
  const choices = [];

  for (let choiceIndex = 0; choiceIndex < choiceCount; choiceIndex++) {
    if (stepIndex > 1 && stepIndex === markers.shrineStep && choiceIndex === choiceCount - 1) {
      choices.push(makeShrineChoice(adventure, stepIndex, choiceIndex));
      continue;
    }

    const specialChoice = stepIndex > 1 && stepIndex === markers.specialStep && choiceIndex === 0;
    const repeatableChoice = stepIndex > 1 && !specialChoice && choiceIndex === 1 && rng() < 0.45;
    if (specialChoice) {
      const enemyId = markers.specialEnemyIds?.[0] || pickEnemy(pickers.special, pools.special, pools.hard);
      choices.push(makeSpecialCombatChoice(adventure, stepIndex, choiceIndex, enemyId));
      continue;
    }
    if (repeatableChoice) {
      const enemyId = pickEnemy(pickers.medium, neutralPool, pools.all);
      choices.push(makeCombatChoice(adventure, stepIndex, choiceIndex, enemyId, {
        encounterRole: "repeatable",
        repeatPool: "limited",
        difficulty: "medium",
      }));
      continue;
    }

    const enemyId = pickEnemy(standardPicker, standardPool, pools.all);
    choices.push(makeCombatChoice(adventure, stepIndex, choiceIndex, enemyId, {
      encounterRole: "standard",
      difficulty: early ? "easy" : "medium",
    }));
  }

  return choices.filter(choice => choice.type !== "combat" || choice.enemyId);
}

function connectChoiceLayers(layers = []) {
  for (let index = 0; index < layers.length - 1; index++) {
    const nextIds = layers[index + 1].map(node => node.id);
    layers[index].forEach(node => {
      node.next = [...nextIds];
    });
  }
}

function createChoiceAdventureRun(adventure, seed = randomSeed(adventure)) {
  const rng = createSeededRng(seed);
  const zone = zoneById[adventure.zoneId];
  const validBossId = getChoiceRunBossId(adventure, rng);
  const choiceConfig = getChoiceRunConfig(adventure);
  const configuredSpecialIds = (choiceConfig.specialEnemyIds || []).filter(id => enemyById[id]);
  const pools = splitEnemyPools(getChoiceRunEnemyPoolIds(adventure), configuredSpecialIds);
  const fallbackEnemy = pools.all[0];
  if (!fallbackEnemy && !validBossId) {
    const emptyRoute = { id: `${adventure.id}_choice_run`, name: `${adventure.name || "Adventure"} Run`, nodes: [] };
    return { schema: CHOICE_RUN_SCHEMA, seed, route: emptyRoute, stepCount: 0 };
  }
  const stepCount = getChoiceRunStepCount(adventure, zone, !!validBossId);
  const bossStep = validBossId ? stepCount - 1 : null;
  const multiStep = choiceConfig.multiEncounterTableId && stepCount >= 6 && pools.all.length >= 2
    ? clampInt(Math.floor(stepCount * 0.55) + Math.floor(rng() * 2), 2, Math.max(2, stepCount - 3))
    : null;
  const blockedForChest = new Set([bossStep, multiStep].filter(value => value != null));
  const chestStep = multiStep != null && multiStep + 1 < (bossStep ?? stepCount)
    ? multiStep + 1
    : stepCount >= 5
      ? findOpenStep(Math.floor(stepCount * 0.55), 1, Math.max(1, stepCount - 2), blockedForChest)
    : null;
  const blocked = new Set([bossStep, multiStep, chestStep].filter(value => value != null));
  const requiredSpecialStep = !!choiceConfig.requiredSpecialBeforeBoss;
  const configuredSpecialStep = Number.isFinite(Number(choiceConfig.specialStep)) ? Number(choiceConfig.specialStep) : null;
  const specialPreferredStep = requiredSpecialStep && bossStep != null
    ? bossStep - 1
    : configuredSpecialStep != null
      ? configuredSpecialStep
      : Math.floor(stepCount * 0.72);
  const specialStep = configuredSpecialIds.length > 0
    ? findOpenStep(specialPreferredStep, 2, Math.max(2, stepCount - 2), blocked)
    : null;
  if (specialStep != null) blocked.add(specialStep);
  const shrineStep = stepCount >= 7
    ? findOpenStep(Math.floor(stepCount * 0.45), 2, Math.max(2, stepCount - 3), blocked)
    : null;

  const markers = {
    bossId: validBossId,
    bossStep,
    multiStep,
    chestStep,
    specialStep,
    requiredSpecialStep,
    shrineStep,
    specialEnemyIds: configuredSpecialIds,
    multiEncounterTableId: choiceConfig.multiEncounterTableId || null,
  };
  const pickers = {
    easy: makeRepeatingPicker(pools.easy, rng),
    medium: makeRepeatingPicker(pools.medium, rng),
    hard: makeRepeatingPicker(pools.hard, rng),
    special: makeRepeatingPicker(pools.special, rng),
  };
  const layers = [];
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
    const layer = createChoiceLayer(adventure, zone, stepIndex, stepCount, markers, pools, pickers, rng);
    layers.push(layer.length ? layer : [makeCombatChoice(adventure, stepIndex, 0, fallbackEnemy, {
      difficulty: "medium",
    })]);
  }
  connectChoiceLayers(layers);
  const route = {
    id: `${adventure.id}_choice_run`,
    name: `${adventure.name || "Adventure"} Run`,
    nodes: layers.flat(),
  };
  return {
    schema: CHOICE_RUN_SCHEMA,
    seed,
    route,
    stepCount,
    multiStep,
    chestStep,
    bossStep,
  };
}

function isChoiceRunProgress(progress) {
  return progress?.choiceRun?.schema === CHOICE_RUN_SCHEMA && progress.choiceRun.route;
}

function getAdventureRoutes(adventure, progress = null) {
  const choiceRoute = shouldUseChoiceRun(adventure)
    ? progress?.choiceRun?.route || adventure?.__progress?.choiceRun?.route
    : null;
  if (choiceRoute) return [choiceRoute];
  return adventure?.routes || [];
}

function createInitialChoiceAdventureProgress(adventure) {
  const choiceRun = createChoiceAdventureRun(adventure);
  const firstNodes = choiceRun.route.nodes.filter(node => node.stepIndex === 0);
  return {
    selectedRouteId: choiceRun.route.id,
    selectedNodeId: null,
    unlockedNodes: firstNodes.map(node => node.id),
    completedNodes: [],
    secrets: [],
    bossCompleted: false,
    choiceRun,
  };
}

export function getAdventure(id) {
  return adventureById[id] || null;
}

export function getRegion(id) {
  return regionById[id] || null;
}

function clampAdventureCarryValue(value, max = 100) {
  const numeric = Math.floor(Number(value || 0));
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(max, numeric));
}

export function normalizeAdventureProcCarry(carry = null) {
  if (!carry || typeof carry !== "object") return null;
  return {
    bleedCarry: clampAdventureCarryValue(carry.bleedCarry, 100),
    momentumCarry: clampAdventureCarryValue(carry.momentumCarry, 10),
    hasTakenDamageLastFight: !!carry.hasTakenDamageLastFight,
    carriedRage: clampAdventureCarryValue(carry.carriedRage, 100),
  };
}

function hasNormalizedAdventureProcCarry(carry = null) {
  return !!carry && (
    carry.bleedCarry > 0
    || carry.momentumCarry > 0
    || carry.hasTakenDamageLastFight
    || carry.carriedRage > 0
  );
}

export function hasAdventureProcCarry(carry = null) {
  return hasNormalizedAdventureProcCarry(normalizeAdventureProcCarry(carry));
}

export function clearAdventureProcCarry(progress = {}) {
  const { procCarry, ...rest } = progress || {};
  return rest;
}

export function setAdventureProcCarry(progress = {}, carry = null) {
  const normalizedCarry = normalizeAdventureProcCarry(carry);
  if (!hasNormalizedAdventureProcCarry(normalizedCarry)) return clearAdventureProcCarry(progress);
  return {
    ...(progress || {}),
    procCarry: normalizedCarry,
  };
}

export function transferAdventureProcCarry(sourceProgress = {}, targetProgress = {}) {
  const carry = normalizeAdventureProcCarry(sourceProgress?.procCarry);
  return {
    sourceProgress: clearAdventureProcCarry(sourceProgress),
    targetProgress: setAdventureProcCarry(targetProgress, carry),
  };
}

export function normalizeAdventureDifficultyProgress(progress = {}) {
  const unlockedDifficultyStars = clampUnlockedAdventureDifficultyStars(
    progress?.unlockedDifficultyStars ?? ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR,
  );
  const selectedDifficultyStars = clampSelectedAdventureDifficultyStars(
    progress?.selectedDifficultyStars ?? ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR,
    unlockedDifficultyStars,
  );
  const procCarry = normalizeAdventureProcCarry(progress?.procCarry);
  const normalized = {
    ...(progress || {}),
    unlockedDifficultyStars,
    selectedDifficultyStars,
  };
  if (hasNormalizedAdventureProcCarry(procCarry)) normalized.procCarry = procCarry;
  else delete normalized.procCarry;
  if (progress?.lastCompletedDifficultyStars != null) {
    normalized.lastCompletedDifficultyStars = clampAdventureDifficultyStars(progress.lastCompletedDifficultyStars);
  }
  if (progress?.activeDifficultyStars != null) {
    normalized.activeDifficultyStars = clampSelectedAdventureDifficultyStars(
      progress.activeDifficultyStars,
      unlockedDifficultyStars,
    );
  }
  return normalized;
}

export function getUnlockedAdventureDifficulty(progress = {}) {
  return normalizeAdventureDifficultyProgress(progress).unlockedDifficultyStars;
}

export function getSelectedAdventureDifficulty(progress = {}) {
  return normalizeAdventureDifficultyProgress(progress).selectedDifficultyStars;
}

export function getActiveAdventureDifficulty(progress = {}) {
  return normalizeAdventureDifficultyProgress(progress).activeDifficultyStars ?? 0;
}

export function getAdventureRunDifficulty(adventure, progress = {}) {
  const normalized = normalizeAdventureDifficultyProgress(progress);
  if (normalized.activeDifficultyStars != null) return getActiveAdventureDifficulty(normalized);
  return hasAdventureRunProgress(adventure, normalized)
    ? getSelectedAdventureDifficulty(normalized)
    : 0;
}

export function setAdventureDifficulty(progress = {}, stars = ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR, options = {}) {
  const normalized = normalizeAdventureDifficultyProgress(progress);
  const selectedDifficultyStars = clampSelectedAdventureDifficultyStars(stars, normalized.unlockedDifficultyStars);
  return {
    ...normalized,
    selectedDifficultyStars,
    ...(options.active ? { activeDifficultyStars: selectedDifficultyStars } : {}),
  };
}

export function clearAdventureActiveDifficulty(progress = {}) {
  const normalized = normalizeAdventureDifficultyProgress(progress);
  const { activeDifficultyStars, ...rest } = normalized;
  return rest;
}

export function unlockNextAdventureDifficulty(progress = {}, completedStars = null) {
  const normalized = normalizeAdventureDifficultyProgress(progress);
  const completed = clampAdventureDifficultyStars(completedStars ?? getActiveAdventureDifficulty(normalized));
  const nextUnlocked = clampUnlockedAdventureDifficultyStars(completed + 1);
  const unlockedDifficultyStars = Math.max(normalized.unlockedDifficultyStars, nextUnlocked);
  return {
    ...normalized,
    unlockedDifficultyStars,
    selectedDifficultyStars: Math.min(
      unlockedDifficultyStars,
      Math.max(normalized.selectedDifficultyStars, nextUnlocked),
    ),
  };
}

function carryAdventureDifficulty(nextProgress, previousProgress) {
  const normalized = normalizeAdventureDifficultyProgress(previousProgress || {});
  return {
    ...nextProgress,
    unlockedDifficultyStars: normalized.unlockedDifficultyStars,
    selectedDifficultyStars: normalized.selectedDifficultyStars,
  };
}

export function getLinkedAdventureDifficultyIds(adventure) {
  if (!adventure?.id) return [];
  const linkedIds = new Set([adventure.id]);
  if (adventure.regionId) {
    Object.values(adventureById).forEach(candidate => {
      if (candidate?.id && candidate.regionId === adventure.regionId) linkedIds.add(candidate.id);
    });
  }
  if (isRootspireTowerAdventure(adventure)) {
    ROOTSPIRE_TOWER_ADVENTURE_IDS.forEach(adventureId => linkedIds.add(adventureId));
  }
  return [...linkedIds].filter(adventureId => adventureById[adventureId] || adventureId === adventure.id);
}

function getCompletedBossDifficultyStars(progress = {}) {
  const normalized = normalizeAdventureDifficultyProgress(progress || {});
  if (!normalized.bossCompleted) return null;
  if (normalized.lastCompletedDifficultyStars != null) {
    return clampAdventureDifficultyStars(normalized.lastCompletedDifficultyStars);
  }
  return clampAdventureDifficultyStars(Math.max(
    ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR,
    getUnlockedAdventureDifficulty(normalized) - 1,
  ));
}

function getCompletedBossUnlockedDifficulty(progress = {}) {
  const completedStars = getCompletedBossDifficultyStars(progress);
  return completedStars == null
    ? ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR
    : clampUnlockedAdventureDifficultyStars(completedStars + 1);
}

function resolveLinkedAdventure(adventureId, sourceAdventure = null) {
  return adventureById[adventureId] || (sourceAdventure?.id === adventureId ? sourceAdventure : null);
}

function syncAdventureDifficultyGroupProgress(adventureProgress = {}, adventureIds = [], sourceAdventure = null) {
  const entries = adventureIds
    .map(adventureId => {
      const linkedAdventure = resolveLinkedAdventure(adventureId, sourceAdventure);
      if (!linkedAdventure) return null;
      const progress = normalizeAdventureProgress(
        linkedAdventure,
        adventureProgress?.[adventureId] || createInitialAdventureProgress(linkedAdventure),
      );
      return { adventureId, progress };
    })
    .filter(Boolean);
  if (entries.length < 1) return adventureProgress;
  const groupHasCompletedBoss = entries.some(entry => entry.progress?.bossCompleted);
  const unlockedDifficultyStars = entries.reduce(
    (highest, entry) => Math.max(
      highest,
      getUnlockedAdventureDifficulty(entry.progress),
      getCompletedBossUnlockedDifficulty(entry.progress),
    ),
    ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR,
  );
  const selectedDifficultyStars = Math.min(
    unlockedDifficultyStars,
    entries.reduce(
      (highest, entry) => Math.max(
        highest,
        getSelectedAdventureDifficulty(entry.progress),
        entry.progress?.bossCompleted ? unlockedDifficultyStars : 0,
      ),
      0,
    ),
  );
  return entries.reduce((nextProgress, entry) => {
    const linkedAdventure = resolveLinkedAdventure(entry.adventureId, sourceAdventure);
    const syncedProgress = normalizeAdventureDifficultyProgress({
      ...entry.progress,
      unlockedDifficultyStars,
      selectedDifficultyStars,
    });
    const cleanedProgress = groupHasCompletedBoss && linkedAdventure
      ? {
          ...carryAdventureDifficulty(createInitialAdventureProgress(linkedAdventure), syncedProgress),
          bossCompleted: !!syncedProgress.bossCompleted,
          ...(syncedProgress.bossCompleted && getCompletedBossDifficultyStars(syncedProgress) != null
            ? { lastCompletedDifficultyStars: getCompletedBossDifficultyStars(syncedProgress) }
            : {}),
        }
      : syncedProgress;
    return {
      ...nextProgress,
      [entry.adventureId]: cleanedProgress,
    };
  }, adventureProgress);
}

export function syncLinkedAdventureDifficultyProgress(adventureProgress = {}, adventure = null) {
  const baseProgress = { ...(adventureProgress || {}) };
  if (adventure?.id) {
    return syncAdventureDifficultyGroupProgress(
      baseProgress,
      getLinkedAdventureDifficultyIds(adventure),
      adventure,
    );
  }
  const visited = new Set();
  return Object.values(adventureById).reduce((nextProgress, linkedAdventure) => {
    if (!linkedAdventure?.id || visited.has(linkedAdventure.id)) return nextProgress;
    const linkedIds = getLinkedAdventureDifficultyIds(linkedAdventure)
      .filter(adventureId => Object.prototype.hasOwnProperty.call(baseProgress, adventureId));
    linkedIds.forEach(adventureId => visited.add(adventureId));
    return syncAdventureDifficultyGroupProgress(nextProgress, linkedIds, linkedAdventure);
  }, baseProgress);
}

export function createInitialAdventureProgress(adventure) {
  if (isDungeonAdventure(adventure)) return normalizeAdventureDifficultyProgress(createDungeonProgress(adventure.zoneId));
  if (shouldUseChoiceRun(adventure)) return normalizeAdventureDifficultyProgress(createInitialChoiceAdventureProgress(adventure));
  const starts = (adventure.routes || [])
    .map(route => ({ route, node: route.nodes?.[0] || null }))
    .filter(entry => entry.node?.id);
  const entranceStarts = starts.filter(entry => isEntranceNode(entry.node));
  const unlockedNodes = Array.from(new Set([
    ...starts.map(entry => entry.node.id),
    ...entranceStarts.flatMap(entry => entry.node.next || []),
  ]));
  const completedNodes = entranceStarts.map(entry => entry.node.id);
  const selected = entranceStarts[0] || null;
  return normalizeAdventureDifficultyProgress({
    selectedRouteId: selected?.route?.id || null,
    selectedNodeId: selected?.node?.id || null,
    unlockedNodes,
    completedNodes,
    secrets: [],
    bossCompleted: false,
  });
}

export function isRootspireTowerAdventure(adventure) {
  return !!adventure && (
    ROOTSPIRE_TOWER_ADVENTURE_IDS.includes(adventure.id)
    || adventure.regionId === "rootspire_tower_region"
  );
}

export function resetAdventureProgress(adventureProgress = {}, adventure) {
  if (!adventure?.id) return adventureProgress || {};
  const linkedIds = getLinkedAdventureDifficultyIds(adventure);
  return (linkedIds.length ? linkedIds : [adventure.id]).reduce((nextProgress, adventureId) => {
    const linkedAdventure = resolveLinkedAdventure(adventureId, adventure);
    if (!linkedAdventure) return nextProgress;
    return {
      ...nextProgress,
      [adventureId]: carryAdventureDifficulty(
        createInitialAdventureProgress(linkedAdventure),
        nextProgress[adventureId],
      ),
    };
  }, { ...(adventureProgress || {}) });
}

export function finishAdventureRunProgress(adventureProgress = {}, adventure, options = {}) {
  if (!adventure?.id) return adventureProgress || {};
  const previousProgress = normalizeAdventureProgress(
    adventure,
    adventureProgress?.[adventure.id] || createInitialAdventureProgress(adventure),
  );
  const completedDifficultyStars = options.completedDifficultyStars ?? getAdventureRunDifficulty(adventure, previousProgress);
  const reset = resetAdventureProgress(adventureProgress, adventure);
  const finished = unlockNextAdventureDifficulty(
    {
      ...(reset[adventure.id] || createInitialAdventureProgress(adventure)),
      bossCompleted: true,
      lastCompletedDifficultyStars: clampAdventureDifficultyStars(completedDifficultyStars),
    },
    completedDifficultyStars,
  );
  return syncLinkedAdventureDifficultyProgress({
    ...reset,
    [adventure.id]: clearAdventureActiveDifficulty(finished),
  }, adventure);
}

export function hasAdventureRunProgress(adventure, progress) {
  if (!adventure || !progress) return false;
  const safeProgress = normalizeAdventureProgress(adventure, progress);
  if (safeProgress.bossCompleted) return false;
  if (isDungeonAdventure(adventure)) return hasEnteredDungeon(safeProgress);

  const initial = createInitialAdventureProgress(adventure);
  const initialCompleted = new Set(initial.completedNodes || []);
  const nodeLookup = getAdventureNodeLookup(adventure, safeProgress);
  const selectedNode = nodeLookup.get(safeProgress.selectedNodeId) || null;
  const selectedPastEntrance = !!selectedNode && !isEntranceNode(selectedNode);
  const completedPastEntrance = (safeProgress.completedNodes || []).some(nodeId => {
    const node = nodeLookup.get(nodeId) || null;
    return !initialCompleted.has(nodeId) || !isEntranceNode(node);
  });
  const encounterPoolsStarted = Object.values(safeProgress.encounterPools || {}).some(pool => {
    const defeated = Math.max(0, Math.floor(pool?.defeated ?? pool?.kills ?? 0));
    return defeated > 0;
  });
  return selectedPastEntrance || completedPastEntrance || encounterPoolsStarted;
}

export function startAdventureProgress(adventure, progress, difficultyStars = null) {
  const normalizedProgress = normalizeAdventureProgress(adventure, progress);
  const selectedDifficultyStars = difficultyStars == null
    ? getSelectedAdventureDifficulty(normalizedProgress)
    : difficultyStars;
  const safeProgress = {
    ...setAdventureDifficulty(normalizedProgress, selectedDifficultyStars, { active: true }),
    runSeed: randomSeed(adventure),
  };
  if (isDungeonAdventure(adventure)) return enterDungeon(safeProgress);
  const choiceNodes = getAdventureChoiceNodesFromProgress(adventure, safeProgress);
  const firstChoice = choiceNodes.find(node => canPlayNode(node, safeProgress)) || choiceNodes[0] || null;
  if (firstChoice) return selectNode(adventure, safeProgress, firstChoice.id);
  const status = getAdventureStatus(adventure, safeProgress);
  const fallback = (status.activeRoute?.nodes || []).find(node => canPlayNode(node, safeProgress))
    || (status.activeRoute?.nodes || []).find(node => isNodeKnown(safeProgress, node.id))
    || null;
  return fallback ? selectNode(adventure, safeProgress, fallback.id) : safeProgress;
}

function getAdventureNodeIds(adventure, progress = null) {
  return new Set(getAdventureRoutes(adventure, progress).flatMap(route => (route.nodes || []).map(node => node.id)));
}

function getAdventureNodeLookup(adventure, progress = null) {
  return new Map(getAdventureRoutes(adventure, progress).flatMap(route => route.nodes || []).map(node => [node.id, node]));
}

function getNodeEnemyIds(node = {}) {
  const fromObjects = Array.isArray(node.enemies)
    ? node.enemies.map(enemy => enemy?.enemyId || enemy?.id)
    : [];
  const fromIds = Array.isArray(node.enemyIds) ? node.enemyIds : [];
  const configuredIds = [...fromObjects, ...fromIds].filter(Boolean);
  return configuredIds.length ? configuredIds : [node.enemyId].filter(Boolean);
}

function resolveNodeEnemies(node = {}) {
  return getNodeEnemyIds(node).map(id => enemyById[id]).filter(Boolean);
}

function isEntranceNode(node) {
  const text = `${node?.id || ""} ${node?.event?.id || ""} ${node?.event?.title || ""}`.toLowerCase();
  return text.includes("entrance");
}

function getNormalEnemyRarity() {
  return { id: "normal", ...ENEMY_RARITIES.normal };
}

function isFirstAdventureEncounterNode(adventure, node) {
  if (!adventure || node?.type !== "combat") return false;
  if (node.generatedChoice && Number(node.stepIndex ?? -1) === 0) return true;
  return getAdventureRoutes(adventure, adventure.__progress || null).some(route => {
    const firstCombat = (route.nodes || []).find(entry => entry?.type === "combat");
    return firstCombat?.id === node.id;
  });
}

export function isWaypointNode(node) {
  if (!node) return false;
  const effects = node.event?.effects || [];
  const hasEntranceOrExitEffect = effects.some(effect => effect.type === "enter_adventure" || effect.type === "leave_adventure");
  if (hasEntranceOrExitEffect) return false;
  if (node.type === "waypoint") return true;
  const title = `${node.event?.title || ""}`.toLowerCase();
  const description = `${node.event?.description || ""}`.toLowerCase();
  return node.type === "event"
    && effects.length === 0
    && (
      title === "connector"
      || description === "a mapped path connector."
    );
}

export function getWaypointReachableNodeIds(adventure, progress) {
  if (!adventure || isDungeonAdventure(adventure)) return new Set();
  const lookup = getAdventureNodeLookup(adventure, progress);
  const adjacency = new Map([...lookup.keys()].map(id => [id, new Set()]));
  lookup.forEach(node => {
    (node.next || []).forEach(nextId => {
      if (!lookup.has(nextId)) return;
      adjacency.get(node.id)?.add(nextId);
      adjacency.get(nextId)?.add(node.id);
    });
  });
  const traversed = new Set([
    ...(progress?.completedNodes || []),
    isWaypointNode(lookup.get(progress?.selectedNodeId)) ? progress?.selectedNodeId : null,
  ].filter(id => id && lookup.has(id)));
  const reachableWaypoints = new Set([...traversed].filter(id => isWaypointNode(lookup.get(id))));
  let changed = true;
  while (changed) {
    changed = false;
    const sources = new Set([...traversed, ...reachableWaypoints]);
    for (const node of lookup.values()) {
      if (!isWaypointNode(node) || reachableWaypoints.has(node.id)) continue;
      const canReachWaypoint = [...sources].some(sourceId => adjacency.get(sourceId)?.has(node.id));
      if (canReachWaypoint) {
        reachableWaypoints.add(node.id);
        changed = true;
      }
    }
  }
  const reachable = new Set(reachableWaypoints);
  reachableWaypoints.forEach(waypointId => {
    (adjacency.get(waypointId) || []).forEach(nextId => {
      if (lookup.has(nextId)) reachable.add(nextId);
    });
  });
  return reachable;
}

function syncUnlockedNodesFromCompleted(adventure, progress) {
  const lookup = getAdventureNodeLookup(adventure, progress);
  const suppressed = new Set(progress?.suppressedNodes || []);
  const unlocked = new Set([...(progress?.unlockedNodes || []), ...(progress?.completedNodes || [])]);
  const queue = [...(progress?.completedNodes || [])];
  while (queue.length) {
    const node = lookup.get(queue.shift());
    if (isBossEncounterNode(node)) continue;
    (node?.next || []).forEach(nextId => {
      if (!suppressed.has(nextId)) unlocked.add(nextId);
    });
  }
  return [...unlocked].filter(id => lookup.has(id) && !suppressed.has(id));
}

const STATIC_ADVENTURE_NODE_RENAMES = {
  orc_war_camp: {
    orc_troll: "small_troll",
  },
};
const STATIC_CAP_REPAIR_ADVENTURES = new Set([
  "rootspire_floor_1",
  "rootspire_floor_2",
  "rootspire_floor_3",
  "rootspire_rooftop",
]);

function repairRenamedStaticNodeIds(adventure, progress) {
  const renames = STATIC_ADVENTURE_NODE_RENAMES[adventure?.id];
  if (!renames || !progress) return progress;
  const renameNodeId = id => renames[id] || id;
  const renameList = list => Array.from(new Set((list || []).map(renameNodeId)));
  const encounterPools = Object.entries(progress.encounterPools || {}).reduce((next, [nodeId, pool]) => {
    next[renameNodeId(nodeId)] = pool;
    return next;
  }, {});
  return {
    ...progress,
    selectedNodeId: renameNodeId(progress.selectedNodeId),
    unlockedNodes: renameList(progress.unlockedNodes),
    completedNodes: renameList(progress.completedNodes),
    suppressedNodes: renameList(progress.suppressedNodes),
    ...(Object.keys(encounterPools).length ? { encounterPools } : {}),
  };
}

function repairKnownStaticAdventureNodes(adventure, progress) {
  if (adventure?.id !== "rootspire_ability_lab") return progress;
  const known = new Set([
    ...(progress?.unlockedNodes || []),
    ...(progress?.completedNodes || []),
    progress?.selectedNodeId,
  ].filter(Boolean));
  const knowsAbyssLane = known.has("rootspire_lab_abyss_wing") || known.has("rootspire_lab_abyssal_fiend");
  if (!knowsAbyssLane) return progress;
  return {
    ...progress,
    unlockedNodes: Array.from(new Set([
      ...(progress.unlockedNodes || []),
      "rootspire_lab_old_knight_journal",
      "rootspire_lab_oath_door",
    ])),
  };
}

function repairStaticEncounterPoolCaps(adventure, progress) {
  if (!STATIC_CAP_REPAIR_ADVENTURES.has(adventure?.id)) return progress;
  const pools = progress?.encounterPools;
  if (!pools || !Object.keys(pools).length) return progress;
  const lookup = getAdventureNodeLookup(adventure, progress);
  let changed = false;
  const encounterPools = Object.entries(pools).reduce((next, [nodeId, pool]) => {
    const node = lookup.get(nodeId);
    if (!node || (node.type !== "combat" && node.type !== "boss")) {
      next[nodeId] = pool;
      return next;
    }
    const targetCap = getAdventureEncounterCap(node);
    const currentCap = Math.max(0, Math.floor(pool?.cap ?? 0));
    const currentDefeated = Math.max(0, Math.floor(pool?.defeated ?? pool?.kills ?? 0));
    if (currentCap <= targetCap && currentDefeated <= targetCap) {
      next[nodeId] = pool;
      return next;
    }
    changed = true;
    next[nodeId] = {
      ...pool,
      cap: currentCap > targetCap ? targetCap : currentCap,
      defeated: Math.min(targetCap, currentDefeated),
    };
    return next;
  }, {});
  return changed ? { ...progress, encounterPools } : progress;
}

export function normalizeAdventureProgress(adventure, progress) {
  if (!adventure) return progress;
  if (isDungeonAdventure(adventure)) return normalizeAdventureDifficultyProgress(normalizeDungeonProgress(progress || createInitialAdventureProgress(adventure)));
  if (shouldUseChoiceRun(adventure)) {
    if (!progress || !isChoiceRunProgress(progress)) {
      return carryAdventureDifficulty(createInitialAdventureProgress(adventure), progress);
    }
    const choiceRun = repairChoiceRunBosses(adventure, progress.choiceRun);
    const repairedProgress = choiceRun === progress.choiceRun ? progress : { ...progress, choiceRun };
    const nodeIds = getAdventureNodeIds(adventure, repairedProgress);
    const firstNodeIds = (choiceRun.route.nodes || []).filter(node => node.stepIndex === 0).map(node => node.id);
    const completedNodes = Array.from(new Set(repairedProgress.completedNodes || [])).filter(id => nodeIds.has(id));
    const suppressedNodes = Array.from(new Set(repairedProgress.suppressedNodes || [])).filter(id => nodeIds.has(id));
    const unlockedNodes = syncUnlockedNodesFromCompleted(adventure, {
      ...repairedProgress,
      unlockedNodes: Array.from(new Set([...(repairedProgress.unlockedNodes || []), ...firstNodeIds])).filter(id => nodeIds.has(id)),
      completedNodes,
      suppressedNodes,
    });
    return normalizeAdventureDifficultyProgress({
      ...repairedProgress,
      selectedRouteId: choiceRun.route.id,
      selectedNodeId: repairedProgress.bossCompleted
        ? null
        : nodeIds.has(repairedProgress.selectedNodeId) ? repairedProgress.selectedNodeId : null,
      unlockedNodes,
      completedNodes,
      suppressedNodes,
      secrets: repairedProgress.secrets || [],
      bossCompleted: !!repairedProgress.bossCompleted,
    });
  }
  const initial = createInitialAdventureProgress(adventure);
  if (!progress) return initial;
  const repairedProgress = repairStaticEncounterPoolCaps(adventure, repairRenamedStaticNodeIds(adventure, progress));
  const nodeIds = getAdventureNodeIds(adventure, repairedProgress);
  const knownIds = [...(repairedProgress.unlockedNodes || []), ...(repairedProgress.completedNodes || [])];
  if (knownIds.some(id => nodeIds.has(id))) {
    const completedNodes = Array.from(new Set([...(repairedProgress.completedNodes || []), ...(initial.completedNodes || [])]));
    const suppressedNodes = Array.from(new Set(repairedProgress.suppressedNodes || [])).filter(id => nodeIds.has(id));
    return normalizeAdventureDifficultyProgress(repairKnownStaticAdventureNodes(adventure, {
      ...repairedProgress,
      selectedRouteId: repairedProgress.selectedRouteId || initial.selectedRouteId,
      selectedNodeId: repairedProgress.bossCompleted
        ? null
        : nodeIds.has(repairedProgress.selectedNodeId) ? repairedProgress.selectedNodeId : initial.selectedNodeId,
      unlockedNodes: syncUnlockedNodesFromCompleted(adventure, {
        ...repairedProgress,
        unlockedNodes: Array.from(new Set([...(repairedProgress.unlockedNodes || []), ...(initial.unlockedNodes || [])])),
        completedNodes,
        suppressedNodes,
      }),
      completedNodes,
      suppressedNodes,
    }));
  }
  return carryAdventureDifficulty({
    ...initial,
    secrets: repairedProgress.secrets || initial.secrets,
  }, repairedProgress);
}

export function getRoute(adventure, routeId, progress = null) {
  const routes = getAdventureRoutes(adventure, progress);
  return routes.find(route => route.id === routeId) || routes[0] || null;
}

export function getNode(adventure, nodeId, progress = null) {
  if (isDungeonAdventure(adventure)) {
    const dungeonProgress = adventure.__progress || createDungeonProgress(adventure.zoneId);
    const map = getDungeonMap(dungeonProgress);
    const node = map.nodes.find(entry => entry.id === nodeId);
    return { node: node || null, route: { id: `dungeon_level_${dungeonProgress.level}`, nodes: map.nodes } };
  }
  for (const route of getAdventureRoutes(adventure, progress)) {
    const node = route.nodes.find(entry => entry.id === nodeId);
    if (node) return { node, route };
  }
  return { node: null, route: null };
}

export function isNodeKnown(progress, nodeId) {
  if (!nodeId || (progress?.suppressedNodes || []).includes(nodeId)) return false;
  return !!nodeId && ((progress?.unlockedNodes || []).includes(nodeId) || (progress?.completedNodes || []).includes(nodeId));
}

export function isNodeCompleted(progress, nodeId) {
  return !!nodeId && (progress?.completedNodes || []).includes(nodeId);
}

function isBossEncounterNode(node) {
  return !!(node?.type === "boss"
    || node?.bossId
    || (Array.isArray(node?.bossIds) && node.bossIds.length > 0));
}

function isEncounterPoolNode(node) {
  return node?.type === "combat" || node?.type === "boss";
}

function getExclusiveChoiceSiblingIds(route, node) {
  if (!route || !node?.exclusiveChoice) return [];
  return route.nodes
    .filter(candidate => (candidate.next || []).includes(node.id))
    .flatMap(parent => parent.next || [])
    .filter(id => id && id !== node.id);
}

export function getNodeEncounterPool(progress, nodeId) {
  const pool = nodeId ? progress?.encounterPools?.[nodeId] : null;
  const defeated = Math.max(0, Math.floor(pool?.defeated ?? pool?.kills ?? 0));
  const result = {
    defeated,
    cap: Math.max(0, Math.floor(pool?.cap ?? 0)),
    total: Math.max(0, Math.floor(pool?.total ?? defeated)),
  };
  if (pool?.lastEnemy) result.lastEnemy = pool.lastEnemy;
  if (Array.isArray(pool?.lastEnemies) && pool.lastEnemies.length) result.lastEnemies = pool.lastEnemies;
  return result;
}

export function getAdventureEncounterCap(node = {}) {
  if (node?.encounterCap) return Math.max(1, Math.floor(Number(node.encounterCap) || 1));
  if (node?.generatedChoice && node?.repeatPool) return 3;
  return 1;
}

export function hasRemainingNodeEncounters(node, progress) {
  if (!isEncounterPoolNode(node)) return false;
  const pool = getNodeEncounterPool(progress, node?.id);
  return pool.cap > pool.defeated;
}

export function isNodeRepeatable(node) {
  return !!(node?.repeatable
    || isWaypointNode(node)
    || node?.event?.effects?.some(effect => effect.type === "enter_adventure" || effect.type === "leave_adventure"));
}

export function canPlayNode(node, progress) {
  return isNodeKnown(progress, node?.id)
    && (!isNodeCompleted(progress, node?.id) || isNodeRepeatable(node) || hasRemainingNodeEncounters(node, progress));
}

function getAdventureChoiceLimit(adventure) {
  const configuredLimit = Math.floor(Number(adventure?.choiceLimit ?? adventure?.maxChoices ?? 3));
  return Math.max(1, configuredLimit || 3);
}

function getAdventureChoiceNodesFromProgress(adventure, progress) {
  if (!adventure || !progress) return [];
  if (progress.bossCompleted) return [];
  const choiceLimit = getAdventureChoiceLimit(adventure);
  const route = getRoute(adventure, progress.selectedRouteId, progress);
  const nodes = route?.nodes || [];
  const lookup = new Map(nodes.map(node => [node.id, node]));
  const activeNode = lookup.get(progress.selectedNodeId) || null;

  if (!activeNode) {
    if (isChoiceRunProgress(progress)) {
      // Skip steps where any node is already completed — the player chose their path.
      const completedStepIndices = new Set(
        nodes.filter(n => isNodeCompleted(progress, n.id)).map(n => n.stepIndex ?? 0)
      );
      const candidates = nodes.filter(node =>
        isNodeKnown(progress, node.id) &&
        !isNodeCompleted(progress, node.id) &&
        !completedStepIndices.has(node.stepIndex ?? 0)
      );
      const firstOpenStep = candidates.length
        ? candidates.reduce((min, n) => Math.min(min, n.stepIndex ?? 0), Infinity)
        : null;
      if (firstOpenStep == null) return [];
      return candidates
        .filter(node => (node.stepIndex ?? 0) === firstOpenStep)
        .sort((a, b) => (a.choiceIndex ?? 0) - (b.choiceIndex ?? 0))
        .slice(0, choiceLimit);
    }
    const firstOpenStep = nodes
      .filter(node => isNodeKnown(progress, node.id) && !isNodeCompleted(progress, node.id))
      .sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0))[0]?.stepIndex;
    return nodes
      .filter(node => isNodeKnown(progress, node.id) && !isNodeCompleted(progress, node.id))
      .sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0) || (a.choiceIndex ?? 0) - (b.choiceIndex ?? 0))
      .filter(node => (node.stepIndex ?? 0) === (firstOpenStep ?? node.stepIndex ?? 0))
      .slice(0, choiceLimit);
  }

  if (activeNode.exclusiveChoice && canPlayNode(activeNode, progress)) return [activeNode];

  if (!isNodeCompleted(progress, activeNode.id)) {
    const activeStep = activeNode.stepIndex ?? 0;
    return nodes
      .filter(node => !isNodeCompleted(progress, node.id) && (node.stepIndex ?? 0) === activeStep && (isNodeKnown(progress, node.id) || isChoiceRunProgress(progress)))
      .sort((a, b) => (a.choiceIndex ?? 0) - (b.choiceIndex ?? 0))
      .slice(0, choiceLimit);
  }

  const nextChoices = (activeNode.next || [])
    .map(id => lookup.get(id))
    .filter(node => node && isNodeKnown(progress, node.id) && (!isNodeCompleted(progress, node.id) || canPlayNode(node, progress)))
    .sort((a, b) => (a.choiceIndex ?? 0) - (b.choiceIndex ?? 0))
    .slice(0, choiceLimit);

  if (hasRemainingNodeEncounters(activeNode, progress)) {
    if (!isChoiceRunProgress(progress) && nextChoices.length) {
      return [activeNode, ...nextChoices].slice(0, choiceLimit);
    }
    return [activeNode];
  }

  if (nextChoices.length) return nextChoices;

  return nodes
    .filter(node => isNodeKnown(progress, node.id) && canPlayNode(node, progress))
    .sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0) || (a.choiceIndex ?? 0) - (b.choiceIndex ?? 0))
    .slice(0, choiceLimit);
}

export function getAdventureChoiceNodes(adventure, progress) {
  return getAdventureChoiceNodesFromProgress(adventure, normalizeAdventureProgress(adventure, progress));
}

export function selectRoute(adventure, progress, routeId) {
  const route = getRoute(adventure, routeId, progress);
  if (!route) return progress;
  const selected = route.nodes.find(node => isNodeKnown(progress, node.id)) || route.nodes[0] || null;
  return {
    ...progress,
    selectedRouteId: route.id,
    selectedNodeId: selected?.id || progress.selectedNodeId,
  };
}

export function selectNode(adventure, progress, nodeId) {
  const safeProgress = normalizeAdventureProgress(adventure, progress);
  if (safeProgress.bossCompleted) return safeProgress;
  if (isDungeonAdventure(adventure) && !isDungeonNodeSelectable(safeProgress, nodeId)) return progress;
  const { node, route } = getNode(adventure, nodeId, safeProgress);
  const waypointReachable = getWaypointReachableNodeIds(adventure, safeProgress);
  const isReachable = isNodeKnown(safeProgress, node?.id) || waypointReachable.has(node?.id);
  if (!node || !route || !isReachable) return progress;
  if (isDungeonAdventure(adventure)) return selectDungeonNode(safeProgress, nodeId);
  let currentChoiceIds = [];
  if (isChoiceRunProgress(safeProgress)) {
    const currentChoices = getAdventureChoiceNodesFromProgress(adventure, safeProgress);
    if (!currentChoices.some(choice => choice.id === node.id)) return progress;
    currentChoiceIds = currentChoices.map(choice => choice.id);
  }
  const reachableProgress = isNodeKnown(safeProgress, node.id) && !currentChoiceIds.length
    ? safeProgress
    : { ...safeProgress, unlockedNodes: Array.from(new Set([...(safeProgress.unlockedNodes || []), ...currentChoiceIds, node.id])) };
  const seededProgress = reachableProgress.runSeed
    ? reachableProgress
    : { ...reachableProgress, runSeed: randomSeed(adventure) };
  const bossId = isBossEncounterNode(node)
    ? getNodeBossId(node, adventure, zoneById[adventure?.zoneId], Math.random, seededProgress)
    : null;
  const bossRolls = bossId
    ? { ...(seededProgress.bossRolls || {}), [node.id]: bossId }
    : seededProgress.bossRolls;
  if (isWaypointNode(node)) return completeNode(adventure, { ...reachableProgress, selectedRouteId: route.id, selectedNodeId: node.id }, node.id);
  return {
    ...seededProgress,
    bossRolls,
    selectedRouteId: route.id,
    selectedNodeId: node.id,
  };
}

export function continueFromCompletedNode(adventure, progress, nodeId) {
  const safeProgress = normalizeAdventureProgress(adventure, progress);
  if (safeProgress.bossCompleted) return { ...safeProgress, selectedNodeId: null };
  if (!adventure || !nodeId || isDungeonAdventure(adventure)) return safeProgress;
  const { node } = getNode(adventure, nodeId, safeProgress);
  if (!node || !isNodeCompleted(safeProgress, node.id)) return safeProgress;
  if (isChoiceRunProgress(safeProgress)) {
    return {
      ...safeProgress,
      selectedNodeId: null,
    };
  }
  const nextNodeId = (node.next || []).find(id => isNodeKnown(safeProgress, id));
  return {
    ...safeProgress,
    selectedNodeId: nextNodeId || safeProgress.selectedNodeId,
  };
}

export function completeNode(adventure, progress, nodeId, options = {}) {
  const safeProgress = normalizeAdventureProgress(adventure, progress);
  if (isDungeonAdventure(adventure)) {
    const node = safeProgress?.maps?.[safeProgress.level]?.nodes?.find(entry => entry.id === nodeId) || null;
    return advanceDungeonProgress(safeProgress, nodeId, node);
  }
  const { node, route } = getNode(adventure, nodeId, safeProgress);
  if (!node || !route) return progress;
  const bossCompleted = safeProgress.bossCompleted || isBossEncounterNode(node);
  const completedNodes = Array.from(new Set([...(safeProgress.completedNodes || []), node.id]));
  const extraUnlockedNodes = Array.isArray(options.unlockNodeIds) ? options.unlockNodeIds.filter(Boolean) : [];
  const exclusiveChoiceSiblingIds = new Set(getExclusiveChoiceSiblingIds(route, node));
  const nextNodeSet = new Set(node.next || []);
  const prevSuppressed = isWaypointNode(node)
    ? (safeProgress.suppressedNodes || []).filter(id => !nextNodeSet.has(id))
    : (safeProgress.suppressedNodes || []);
  const suppressedNodes = Array.from(new Set([...prevSuppressed, ...exclusiveChoiceSiblingIds]));
  const unlockedNodes = Array.from(new Set([...(safeProgress.unlockedNodes || []), ...(bossCompleted ? [] : (node.next || [])), ...extraUnlockedNodes]))
    .filter(id => !suppressedNodes.includes(id));
  const existingPools = safeProgress.encounterPools || {};
  const existingPool = getNodeEncounterPool(safeProgress, node.id);
  const encounterCap = Math.max(1, Math.floor(options.encounterCap || node.encounterCap || existingPool.cap || 1));
  const lastEnemies = Array.isArray(options.lastEnemies) && options.lastEnemies.length
    ? options.lastEnemies
    : existingPool.lastEnemies;
  const lastEnemy = options.lastEnemy || lastEnemies?.[0] || existingPool.lastEnemy;
  const encounterPools = isEncounterPoolNode(node)
    ? {
      ...existingPools,
      [node.id]: {
        cap: encounterCap,
        defeated: Math.min(encounterCap, existingPool.defeated + 1),
        total: (existingPool.total || 0) + 1,
        ...(lastEnemy ? { lastEnemy } : {}),
        ...(Array.isArray(lastEnemies) && lastEnemies.length ? { lastEnemies } : {}),
      },
    }
    : existingPools;
  const completedPool = getNodeEncounterPool({ ...safeProgress, encounterPools }, node.id);
  const hasMoreEncounters = isEncounterPoolNode(node) && completedPool.cap > completedPool.defeated;
  const nextNodes = node.next || [];
  const preferredNextNodeId = options.selectedNodeId && unlockedNodes.includes(options.selectedNodeId)
    ? options.selectedNodeId
    : null;
  const nextSelected = bossCompleted
    ? null
    : hasMoreEncounters
    ? node.id
    : preferredNextNodeId
      ? preferredNextNodeId
    : node.id;
  return {
    ...safeProgress,
    selectedRouteId: route.id,
    selectedNodeId: nextSelected,
    completedNodes,
    unlockedNodes,
    suppressedNodes,
    encounterPools,
    bossCompleted,
  };
}

export function revertAdventureOnDeath(adventure, progress) {
  const safeProgress = normalizeAdventureProgress(adventure, progress);
  if (isDungeonAdventure(adventure)) return revertDungeonOnDeath(safeProgress);
  return safeProgress;
}

export function markSecretCompleted(progress, secretId) {
  return {
    ...progress,
    secrets: Array.from(new Set([...(progress.secrets || []), secretId])),
  };
}

export function getAdventureStatus(adventure, progress) {
  const safeProgress = normalizeAdventureProgress(adventure, progress);
  if (isDungeonAdventure(adventure)) {
    const map = getDungeonMap({ ...safeProgress, zoneId: adventure.zoneId });
    const activeNode = safeProgress.selectedNodeId ? map.nodes.find(node => node.id === safeProgress.selectedNodeId) || null : null;
    return {
      activeRoute: { id: `dungeon_level_${safeProgress.level}`, nodes: map.nodes },
      activeNode,
      routeSummaries: [{
        id: `dungeon_level_${safeProgress.level}`,
        completed: map.nodes.every(node => isNodeCompleted(safeProgress, node.id)),
        knownCount: map.nodes.filter(node => isNodeKnown(safeProgress, node.id)).length,
      }],
      bossNode: map.nodes.find(node => node.type === "boss") || null,
      bossKnown: map.nodes.some(node => node.type === "boss" && isNodeKnown(safeProgress, node.id)),
      bossCompleted: !!safeProgress.bossCompleted,
    };
  }
  const active = getNode(adventure, safeProgress.selectedNodeId, safeProgress);
  const activeRoute = active.route || getRoute(adventure, safeProgress.selectedRouteId, safeProgress);
  const activeNode = active.node || null;
  const routes = getAdventureRoutes(adventure, safeProgress);
  const routeSummaries = routes.map(route => ({
    ...route,
    completed: route.nodes.every(node => isNodeCompleted(safeProgress, node.id)),
    knownCount: route.nodes.filter(node => isNodeKnown(safeProgress, node.id)).length,
  }));
  const bossNode = routes.flatMap(route => route.nodes).find(node => node.type === "boss") || null;
  return {
    activeRoute,
    activeNode,
    routeSummaries,
    bossNode,
    bossKnown: isNodeKnown(safeProgress, bossNode?.id),
    bossCompleted: !!safeProgress.bossCompleted,
  };
}

export function resolveAdventureNode(adventure, node, totalCombats = 0, rng = Math.random, options = {}) {
  if (!adventure || !node) return null;
  const difficultyStars = clampAdventureDifficultyStars(
    options.difficultyStars ?? getActiveAdventureDifficulty(adventure.__progress || {}),
  );
  if (isDungeonAdventure(adventure)) {
    const dungeonState = adventure.__progress || createDungeonProgress(adventure.zoneId);
    return createDungeonEncounter(adventure, node, { ...dungeonState, activeDifficultyStars: difficultyStars }, rng);
  }
  const zone = zoneById[adventure.zoneId];
  const dn = getDayNight(totalCombats);
  if (isWaypointNode(node)) return { type: "waypoint", idx: 0, node };
  if (node.type === "event") return { type: "event", idx: 0, event: applyCampfireRarityToEvent(node.event, node.campfireRarity || node.event?.rarity), node };
  if (node.type === "boss") {
    const boss = bossById[getNodeBossId(node, adventure, zone, rng, adventure.__progress || null)];
    const scaledBoss = scaleCombatant(boss, node.scaleIndex ?? node.stepIndex ?? 0, zone, dn.isNight, { difficultyStars });
    const bossAboveBase = difficultyStars > ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR;
    const bossRarity = bossAboveBase ? rollEnemyRarity(rng, { difficultyStars, boss: true }) : getNormalEnemyRarity();
    const rolledBoss = applyEnemyRarity(scaledBoss, bossRarity, { allowBossRarity: bossAboveBase });
    return { type: "boss", idx: node.stepIndex ?? 0, enemy: rolledBoss, enemies: [rolledBoss], bossDeathEndsFight: true, addsDespawnOnBossDeath: true, node };
  }
  const tableRoll = node.encounterTableId ? rollEncounterTable(node.encounterTableId, rng) : null;
  const enemies = tableRoll?.enemies?.length ? tableRoll.enemies : resolveNodeEnemies(node);
  const enemy = tableRoll?.enemy || enemies[0];
  if (!enemy) return { type: "event", idx: 0, event: { id: `${node.id}_fallback`, title: "Empty Room", description: "This encounter has not been assigned yet.", effects: [] }, node };
  const scaledEnemies = enemies.map(entry => scaleCombatant(entry, node.scaleIndex ?? node.stepIndex ?? 0, zone, dn.isNight, { difficultyStars }));
  const forceNormalRarity = node.noRarity || (difficultyStars <= 0 && isFirstAdventureEncounterNode(adventure, node));
  const rolledEnemies = scaledEnemies.map(entry => (
    applyEnemyRarity(entry, forceNormalRarity ? getNormalEnemyRarity() : rollEnemyRarity(rng, { difficultyStars }))
  ));
  let finalEnemies = rolledEnemies;
  if (rolledEnemies.length === 1 && !node.noGroup) {
    const roll = rng();
    let groupSize = 1;
    if (node.special) {
      if (roll < 0.05) groupSize = 2;
    } else {
      if (roll < 0.13) groupSize = 2;
    }
    if (groupSize > 1) {
      finalEnemies = Array.from({ length: groupSize }, () => ({ ...rolledEnemies[0] }));
    }
  }
  return {
    type: "combat",
    idx: node.stepIndex ?? 0,
    enemy: finalEnemies[0],
    enemies: finalEnemies,
    groupSize: finalEnemies.length,
    bossDeathEndsFight: node.bossDeathEndsFight ?? tableRoll?.entry?.bossDeathEndsFight ?? (finalEnemies.length <= 1),
    addsDespawnOnBossDeath: node.addsDespawnOnBossDeath ?? tableRoll?.entry?.addsDespawnOnBossDeath ?? true,
    node,
  };
}
