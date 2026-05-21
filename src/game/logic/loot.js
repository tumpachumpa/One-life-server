import { items } from "./content.js";
import lootTablesData from "../data/lootTables.json" with { type: "json" };
import adventureLootPoolsData from "../data/adventureLootPools.json" with { type: "json" };
import { applyCampfireRarityToItem, isCampfireItem } from "./campfires.js";
import { rollEquipmentAffixes, rollGeneratedEquipment } from "./equipmentGenerator.js";

const ENEMY_RARITY_LOOT_BONUS = {
  normal:    0,
  uncommon:  10,
  rare:      25,
  epic:      50,
  legendary: 80,
};

export const ITEM_RARITIES = {
  normal: { id: "normal", label: "", color: "#aaa", statMult: 1, priceMult: 1, effectSlots: 0 },
  uncommon: { id: "uncommon", label: "Uncommon", color: "#2ecc71", statMult: 1.12, priceMult: 1.18, effectSlots: 1 },
  rare: { id: "rare", label: "Rare", color: "#3498db", statMult: 1.25, priceMult: 1.4, effectSlots: 2 },
  epic: { id: "epic", label: "Epic", color: "#9b59b6", statMult: 1.6, priceMult: 2.2, effectSlots: 3 },
  legendary: { id: "legendary", label: "Legendary", color: "#f1c40f", statMult: 2.2, priceMult: 4, effectSlots: 4 },
  artifact: { id: "artifact", label: "Artifact", color: "#ff6b35", statMult: 2.8, priceMult: 7, effectSlots: 5 },
  unique: { id: "unique", label: "Unique", color: "#1abc9c", statMult: 1, priceMult: 5, effectSlots: 5 },
};

export const ITEM_RARITY_TABLES = {
  normal: [
    ["normal", 60],
    ["uncommon", 20],
    ["rare", 12],
    ["epic", 6.5],
    ["legendary", 1.5],
  ],
  specialChest: [
    ["normal", 45],
    ["uncommon", 20],
    ["rare", 24],
    ["epic", 9],
    ["legendary", 2],
  ],
  forestChest: [
    ["normal", 25],
    ["uncommon", 20],
    ["rare", 35],
    ["epic", 16],
    ["legendary", 4],
  ],
  boss: [
    ["rare", 72],
    ["epic", 22],
    ["legendary", 3],
  ],
  rootspire: [
    ["normal", 40],
    ["uncommon", 22],
    ["rare", 24],
    ["epic", 11],
    ["legendary", 2.5],
  ],
  rootspireElite: [
    ["uncommon", 15],
    ["rare", 45],
    ["epic", 20],
    ["legendary", 7],
  ],
  wyvern: [
    ["rare", 55],
    ["epic", 32],
    ["legendary", 9],
  ],
  miniboss: [
    ["normal", 30],
    ["uncommon", 15],
    ["rare", 40],
    ["epic", 14],
    ["legendary", 1],
  ],
};

export const LOOT_TABLES = lootTablesData.tables || {};
export const ADVENTURE_LOOT_POOLS = adventureLootPoolsData.pools || {};

const ELEMENTAL_RESIST_EFFECTS = new Set(["fire_resist", "cold_resist", "lightning_resist", "shadow_resist", "poison_resist", "all_elemental_resist"]);
const RANDOM_LOOT_RARITY_CAPS = {
  unique: "legendary",
};

const ITEM_RARITY_RANKS = Object.fromEntries(
  Object.keys(ITEM_RARITIES).map((id, index) => [id, index])
);

const ENEMY_LOOT_RANKS = {
  minor: 0,
  standard: 1,
  dangerous: 2,
  special: 3,
  boss: 4,
};

export function weightedPick(list, rng = Math.random) {
  const total = list.reduce((sum, entry) => sum + (entry.dropWeight || 1), 0);
  let roll = rng() * total;
  for (const entry of list) {
    roll -= entry.dropWeight || 1;
    if (roll <= 0) return entry;
  }
  return list[list.length - 1];
}

export function getDropPool(tags = [], options = {}) {
  const includeIds = new Set(options.includeItemIds || options.includeIds || []);
  const excludeIds = new Set(options.excludeItemIds || options.excludeIds || []);
  const excludeTags = new Set(options.excludeTags || []);
  const weightOverrides = options.itemWeights || options.weights || {};
  return items.flatMap(item => {
    const override = weightOverrides[item.id];
    const dropWeight = override == null ? item.dropWeight : Number(override);
    if (!Number.isFinite(dropWeight) || dropWeight <= 0) return [];
    if (excludeIds.has(item.id)) return [];
    if (excludeTags.size && item.tags?.some(tag => excludeTags.has(tag))) return [];
    const included = includeIds.has(item.id) || (tags.length ? tags.some(tag => item.tags?.includes(tag)) : includeIds.size === 0);
    if (!included) return [];
    return dropWeight === item.dropWeight ? [item] : [{ ...item, dropWeight }];
  });
}

export function rollDrop(tags = [], rng = Math.random, options = {}) {
  const pool = getDropPool(tags, options);
  return pool.length ? weightedPick(pool, rng) : null;
}

function shouldUseManualCombatLoot(enemy) {
  return !!(enemy?.lootMode === "manual"
    || enemy?.manualLoot
    || enemy?.phases
    || enemy?.boss
    || enemy?.isMiniBoss
    || enemy?.threat === "boss"
    || enemy?.threat === "special");
}

export function getEnemyLootRank(enemy = {}) {
  const tier = Math.max(1, Math.floor(enemy?.tier || 1));
  const threatRank = ENEMY_LOOT_RANKS[enemy?.threat] ?? ENEMY_LOOT_RANKS.standard;
  const rarityBonus = enemy?.rarity?.id && enemy.rarity.id !== "normal" ? 1 : 0;
  return Math.max(0, tier - 1 + threatRank + rarityBonus + (enemy?.isMiniBoss ? 1 : 0));
}

export function getItemLootTier(item, pool = {}) {
  const explicit = pool.itemTiers?.[item?.id] ?? item?.lootTier ?? item?.tier;
  if (Number.isFinite(Number(explicit))) return Math.max(0, Number(explicit));
  const rarityRank = {
    uncommon: 1,
    rare: 2,
    epic: 3,
    legendary: 4,
    artifact: 5,
    unique: 5,
  }[item?.rarity];
  if (rarityRank != null) return rarityRank;
  const price = Number(item?.price || 0);
  const weight = Number(item?.dropWeight || 0);
  if (item?.type === "gear") {
    if (price >= 180 || (weight > 0 && weight <= 2)) return 3;
    if (price >= 120 || (weight > 0 && weight <= 4)) return 2;
    if (price >= 70 || (weight > 0 && weight <= 7)) return 1;
  }
  if (price >= 50 || (weight > 0 && weight <= 3)) return 1;
  return 0;
}

function scaleDropWeightForEnemy(item, baseWeight, enemy, pool = {}) {
  const numericWeight = Number(baseWeight);
  if (!Number.isFinite(numericWeight) || numericWeight <= 0) return 0;
  const enemyRank = getEnemyLootRank(enemy);
  const itemTier = getItemLootTier(item, pool);
  const deficit = itemTier - enemyRank;
  if (deficit <= 0) return numericWeight;
  const penalty = Number(pool.goodItemPenalty ?? 0.35);
  return numericWeight * Math.pow(Math.max(0.05, Math.min(1, penalty)), deficit);
}

function resolveAdventureLootPool(adventureOrPool = null, zone = null) {
  if (!adventureOrPool) return null;
  if (adventureOrPool.includeItemIds || adventureOrPool.tags || adventureOrPool.items) return adventureOrPool;
  if (adventureOrPool.lootPool) return adventureOrPool.lootPool;
  return ADVENTURE_LOOT_POOLS[adventureOrPool.lootPoolId]
    || ADVENTURE_LOOT_POOLS[adventureOrPool.id]
    || ADVENTURE_LOOT_POOLS[zone?.lootPoolId]
    || ADVENTURE_LOOT_POOLS[zone?.id]
    || null;
}

function expandPoolItems(pool = {}) {
  if (!Array.isArray(pool.items) || !pool.items.length) return pool;
  const includeItemIds = [];
  const tags = [];
  const itemWeights = { ...(pool.itemWeights || {}) };
  for (const entry of pool.items) {
    if (typeof entry === "string") {
      includeItemIds.push(entry);
      continue;
    }
    if (entry?.id) {
      includeItemIds.push(entry.id);
      if (entry.weight != null) itemWeights[entry.id] = entry.weight;
    }
    if (entry?.tag) tags.push(entry.tag);
    if (Array.isArray(entry?.tags)) tags.push(...entry.tags);
  }
  return {
    ...pool,
    tags: [...new Set([...(pool.tags || []), ...tags])],
    includeItemIds: [...new Set([...(pool.includeItemIds || []), ...includeItemIds])],
    itemWeights,
  };
}

export function getAdventureDropPool(adventureOrPool, enemy = null, options = {}) {
  const pool = expandPoolItems(resolveAdventureLootPool(adventureOrPool, options.zone) || adventureOrPool);
  if (!pool) return [];
  const hasLegacyFilters = (pool.tags || []).length
    || (pool.includeItemIds || []).length
    || (pool.includeIds || []).length
    || (pool.items || []).length;
  if (pool.generatedEquipment && !hasLegacyFilters) return [];
  return getDropPool(pool.tags || [], pool)
    .map(item => {
      const dropWeight = scaleDropWeightForEnemy(item, item.dropWeight || 1, enemy, pool);
      return dropWeight > 0 ? { ...item, dropWeight } : null;
    })
    .filter(Boolean);
}

function getGeneratedEquipmentConfig(pool = {}) {
  const config = pool.generatedEquipment;
  if (!config || config.enabled === false) return null;
  if (config.dropChance != null) return config;
  const weight = Number(config.weight ?? 0);
  return weight > 0 ? { ...config, weight } : null;
}

function getRarityWithMinimum(rarity, minimumRarity = null) {
  if (!minimumRarity) return rarity;
  const rarityId = typeof rarity === "string" ? rarity : rarity?.id;
  const minimumId = typeof minimumRarity === "string" ? minimumRarity : minimumRarity?.id;
  if ((ITEM_RARITY_RANKS[rarityId] ?? 0) >= (ITEM_RARITY_RANKS[minimumId] ?? 0)) return rarity;
  return ITEM_RARITIES[minimumId] || rarity;
}

function getLootTableRollCount(table = {}, lootBonus = 0) {
  const baseRolls = Math.max(0, Math.floor(Number(table.rolls ?? 1)));
  if (table.allowBonusRolls !== true) return baseRolls;
  const bonusStep = Math.max(1, Number(table.bonusRollStep || 100));
  const maxBonusRolls = Math.max(0, Math.floor(Number(table.maxBonusRolls ?? 1)));
  const bonusRolls = Math.floor(Math.max(0, Number(lootBonus) || 0) / bonusStep);
  return baseRolls + Math.min(maxBonusRolls, bonusRolls);
}

function getLootBonusQualityRerolls(table = {}, lootBonus = 0) {
  if (table.qualityBonusRerolls === false) return 0;
  const bonusStep = Math.max(1, Number(table.qualityBonusStep || 30));
  const maxRerolls = Math.max(0, Math.floor(Number(table.maxQualityBonusRerolls ?? 3)));
  const rerolls = Math.floor(Math.max(0, Number(lootBonus) || 0) / bonusStep);
  return Math.min(maxRerolls, rerolls);
}

function rollItemRarityWithLootBonus(tableName = "normal", rng = Math.random, lootBonus = 0, table = {}) {
  let best = capRandomLootRarity(rollItemRarity(tableName, rng));
  const rerolls = getLootBonusQualityRerolls(table, lootBonus);
  for (let i = 0; i < rerolls; i++) {
    const candidate = capRandomLootRarity(rollItemRarity(tableName, rng));
    if ((ITEM_RARITY_RANKS[candidate?.id] ?? 0) > (ITEM_RARITY_RANKS[best?.id] ?? 0)) {
      best = candidate;
    }
  }
  return best;
}

function shouldPreventDuplicateItems(table = {}, rolls = 1) {
  if (table.allowDuplicateItems === true) return false;
  if (table.preventDuplicateItems != null) return !!table.preventDuplicateItems;
  return rolls > 1;
}

function getLootDropId(drop) {
  if (!drop || drop.generatedEquipment) return null;
  return drop.id || drop.itemId || drop.baseId || null;
}

function filterUnpickedItems(pool = [], pickedItemIds = new Set()) {
  if (!pickedItemIds.size) return pool;
  return pool.filter(entry => entry.generatedEquipment || !pickedItemIds.has(getLootDropId(entry)));
}

function isRarityAtLeast(rarity, minimumRarity = null) {
  if (!minimumRarity) return true;
  const rarityId = typeof rarity === "string" ? rarity : rarity?.id;
  const minimumId = typeof minimumRarity === "string" ? minimumRarity : minimumRarity?.id;
  return (ITEM_RARITY_RANKS[rarityId] ?? 0) >= (ITEM_RARITY_RANKS[minimumId] ?? 0);
}

function rollGeneratedEquipmentFromPool(pool = {}, enemy = null, rng = Math.random, rarityTable = "normal", minimumRarity = null, lootBonus = 0) {
  const config = getGeneratedEquipmentConfig(pool);
  if (!config) return null;
  const {
    enabled,
    weight,
    dropChance,
    materials,
    rarityTable: generatedRarityTable,
    itemLevel,
    itemLevelBonus,
    ...filters
  } = config;
  const enemyRank = enemy ? getEnemyLootRank(enemy) : 0;
  const finalItemLevel = Math.max(1, Math.floor(Number(itemLevel) || (enemyRank + 1 + Number(itemLevelBonus || 0))));
  const rarity = getRarityWithMinimum(
    rollItemRarityWithLootBonus(generatedRarityTable || rarityTable || "normal", rng, lootBonus, pool),
    minimumRarity
  );
  return rollGeneratedEquipment({
    ...filters,
    itemLevel: finalItemLevel,
    rarity: rarity.id,
  }, rng);
}

export function rollAdventureLootPool(adventureOrPool, enemy = null, rng = Math.random, lootBonus = 0, forcedRarityTable = null, options = {}) {
  const pool = expandPoolItems(resolveAdventureLootPool(adventureOrPool, options.zone) || adventureOrPool);
  if (!pool) return [];
  const drops = [];
  const rolls = getLootTableRollCount(pool, lootBonus);
  const dropChance = Math.min(1, (pool.dropChance ?? 0) + lootBonus / 100);
  const rarityTable = forcedRarityTable || pool.rarityTable || "normal";
  const pickedItemIds = new Set();
  const preventDuplicateItems = shouldPreventDuplicateItems(pool, rolls);
  for (let i = 0; i < rolls; i++) {
    if (rng() > dropChance) continue;
    const generatedConfig = getGeneratedEquipmentConfig(pool);
    const dropPool = preventDuplicateItems
      ? filterUnpickedItems(getAdventureDropPool(pool, enemy), pickedItemIds)
      : getAdventureDropPool(pool, enemy);
    const weightedPool = generatedConfig
      ? [...dropPool, { generatedEquipment: true, dropWeight: generatedConfig.weight }]
      : dropPool;
    const drop = weightedPool.length ? weightedPick(weightedPool, rng) : null;
    if (drop?.generatedEquipment) {
      const generated = rollGeneratedEquipmentFromPool(pool, enemy, rng, rarityTable, null, lootBonus);
      if (generated) drops.push(generated);
    } else if (drop) {
      drops.push(createLootItem(drop, rarityTable, rng, null, lootBonus));
      const dropId = getLootDropId(drop);
      if (dropId) pickedItemIds.add(dropId);
    }
  }
  return drops;
}

export function rollEventLootEffect(effect, rng = Math.random, lootBonus = 0) {
  if (!effect || effect.type !== "grant_loot") return [];
  const rolls = Math.max(1, Math.floor(Number(effect.rolls || 1)));
  if (effect.lootPoolId) {
    const pool = ADVENTURE_LOOT_POOLS[effect.lootPoolId];
    if (!pool) return [];
    return rollAdventureLootPool({ ...pool, rolls }, null, rng, lootBonus, effect.rarityTable || null).slice(0, rolls);
  }
  return rollLootTable(effect.lootTable, rng, lootBonus, effect.rarityTable || null).slice(0, rolls);
}

function getContextLootBonus(context = {}) {
  return Math.max(0, Math.floor(Number(context.lootBonus || 0) + Number(context.magicFind || 0)));
}

function getContextDifficulty(context = {}) {
  return Math.max(0, Math.floor(Number(context.difficultyStars ?? context.difficulty ?? context.adventure?.difficultyStars ?? 0)));
}

function getContextStoneZoneId(context = {}) {
  return context.stoneZoneId
    || context.adventure?.id
    || context.zone?.id
    || context.zoneId
    || context.adventure?.zoneId
    || context.lootPoolId
    || null;
}

function getItemBaseId(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  return ref.itemId || ref.baseId || ref.id || null;
}

function collectContextRelicIds(context = {}) {
  const ids = new Set(context.heroRelicIds || context.existingRelicIds || []);
  for (const slot of context.hero?.relicSlots || []) {
    const id = getItemBaseId(slot);
    if (id) ids.add(id);
  }
  for (const placed of context.hero?.inventory || []) {
    const ref = placed?.itemId ?? placed;
    const id = getItemBaseId(ref);
    if (id && items.find(item => item.id === id)?.type === "relic") ids.add(id);
  }
  for (const drop of context.pendingLoot || []) {
    const id = getItemBaseId(drop);
    if (id && items.find(item => item.id === id)?.type === "relic") ids.add(id);
  }
  return [...ids];
}

function hasSpecialDropConfig(table) {
  return !!(table?.relicDrop || table?.stoneDrop);
}

function getSpecialDropLootTable(enemy, fallbackTable) {
  if (hasSpecialDropConfig(fallbackTable)) return fallbackTable;
  const enemyTable = LOOT_TABLES[enemy?.id];
  return hasSpecialDropConfig(enemyTable) ? enemyTable : fallbackTable;
}

function appendCombatBonusDrops(drops, enemy, table, rng = Math.random, context = {}) {
  const next = [...drops];
  const difficulty = getContextDifficulty(context);
  const zoneId = getContextStoneZoneId(context);
  const relicIds = collectContextRelicIds(context);
  const specialTable = getSpecialDropLootTable(enemy, table);

  const relicDrop = rollRelicDrop(specialTable, difficulty, relicIds, rng);
  if (relicDrop) next.push(relicDrop);

  const stoneDrop = specialTable?.stoneDrop
    ? rollBossStoneDrop(specialTable, difficulty, zoneId, rng)
    : rollStoneDrop(enemy, difficulty, zoneId, rng);
  if (stoneDrop) next.push(stoneDrop);

  return next;
}

function getManualCombatLootTable(enemy) {
  return LOOT_TABLES[enemy.lootTable] || (enemy.phases ? LOOT_TABLES.boss : LOOT_TABLES.forest_basic);
}

function rollManualCombatLoot(enemy, rng = Math.random, contextLootBonus = 0) {
  const table = getManualCombatLootTable(enemy);
  const lootBonus = (enemy.lootBonus || 0) + contextLootBonus;
  if (Array.isArray(enemy.lootTags) && enemy.lootTags.length) {
    return rollLootTable({ rolls: enemy.lootRolls || 1, tags: enemy.lootTags, dropChance: enemy.lootChance ?? 1, rarityTable: enemy.lootRarityTable || (enemy.phases ? "boss" : enemy.isMiniBoss ? "miniboss" : "normal") }, rng, lootBonus, enemy.lootRarityTable || null);
  }
  const fallbackRarityTable = enemy.phases ? "boss" : enemy.isMiniBoss ? "miniboss" : null;
  return rollLootTable(table, rng, lootBonus, enemy.lootRarityTable || (table.rarityTable ? null : fallbackRarityTable));
}

export function rollCombatLoot(enemy, rng = Math.random, context = {}) {
  if (!enemy) return [];
  const rarityLootBonus = ENEMY_RARITY_LOOT_BONUS[enemy?.rarity?.id] ?? 0;
  const contextLootBonus = getContextLootBonus(context) + rarityLootBonus;
  // Boss-type enemies always use their own manual tables regardless of adventure pool
  const isBossEnemy = enemy?.phases || enemy?.boss || enemy?.isMiniBoss
    || enemy?.threat === "boss" || enemy?.threat === "special";
  if (isBossEnemy) {
    const table = getManualCombatLootTable(enemy);
    return appendCombatBonusDrops(rollManualCombatLoot(enemy, rng, contextLootBonus), enemy, table, rng, context);
  }
  // Each enemy uses its own individual table (adventure pools disabled)
  const table = getManualCombatLootTable(enemy);
  return appendCombatBonusDrops(rollManualCombatLoot(enemy, rng, contextLootBonus), enemy, table, rng, context);
}

export function rollItemRarity(tableName = "normal", rng = Math.random) {
  const table = ITEM_RARITY_TABLES[tableName] || ITEM_RARITY_TABLES.normal;
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [id, weight] of table) {
    roll -= weight;
    if (roll <= 0) return ITEM_RARITIES[id];
  }
  return ITEM_RARITIES.normal;
}

function capRandomLootRarity(rarity) {
  const id = typeof rarity === "string" ? rarity : rarity?.id;
  return ITEM_RARITIES[RANDOM_LOOT_RARITY_CAPS[id] || id] || ITEM_RARITIES.normal;
}

function resolveBaseStatOption(baseStatOptions, rng) {
  if (!baseStatOptions?.length) return null;
  const group = baseStatOptions[Math.floor(rng() * baseStatOptions.length)];
  if (!group?.length) return null;
  const variant = group[Math.floor(rng() * group.length)];
  const { min, max, ...rest } = variant;
  if (min != null && max != null) {
    return { ...rest, value: Math.floor(rng() * (max - min + 1)) + min };
  }
  return { ...rest };
}

export function applyItemRarity(item, rarity, rng = Math.random) {
  if (isCampfireItem(item)) return applyCampfireRarityToItem(item, rarity);
  if (!item?.rarityAffixPools?.length || item.type !== "gear") return item;
  const itemRarity = ITEM_RARITIES[rarity?.id || rarity] || ITEM_RARITIES.normal;
  const baseStatEffect = resolveBaseStatOption(item.baseStatOptions, rng);
  if (itemRarity.id === "normal" && !item.guaranteedAffixes && !baseStatEffect) return item;
  const scaledEffects = [
    ...(item.effects || []).map(effect => {
      if (!ELEMENTAL_RESIST_EFFECTS.has(effect?.type) || !Number.isFinite(Number(effect.value))) return { ...effect };
      return {
        ...effect,
        value: Math.max(1, Math.round(Number(effect.value) * itemRarity.statMult)),
      };
    }),
    ...(baseStatEffect ? [baseStatEffect] : []),
  ];
  const affixes = rollEquipmentAffixes({
    ...item,
    affixPools: item.rarityAffixPools,
    effects: scaledEffects,
  }, itemRarity, rng);
  const baseName = `${item.name || item.id || "Item"}`.replace(/^(Uncommon|Rare|Epic|Legendary|Artifact|Unique)\s+/i, "").trim();
  return {
    ...item,
    uid: item.uid || `${item.id}_${itemRarity.id}_${Date.now()}_${Math.floor(rng() * 0xffffff).toString(36).padStart(4, "0")}`,
    baseId: item.baseId || item.id,
    name: itemRarity.label ? `${itemRarity.label} ${baseName}` : baseName,
    rarity: itemRarity.id,
    rarityColor: itemRarity.color,
    effects: [...scaledEffects, ...affixes],
    price: Math.max(1, Math.round((item.price || 10) * itemRarity.priceMult)),
  };
}

export function createLootItem(item, tableName = "normal", rng = Math.random, minimumRarity = null, lootBonus = 0) {
  if (!item || (!isCampfireItem(item) && !(item.type === "gear" && item.rarityAffixPools?.length))) return item;
  return applyItemRarity(item, getRarityWithMinimum(rollItemRarityWithLootBonus(tableName, rng, lootBonus), minimumRarity), rng);
}

// ─── Stone Drop System ────────────────────────────────────────────────────────

// Stone rarity ranks for zone-gating
const STONE_RARITY_RANKS = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
const STONE_RARITY_NAMES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const STONE_TYPES = ['ember', 'shadow', 'storm', 'frost', 'blood', 'earth'];

// Zone stone caps
const ZONE_STONE_CAPS = {
  dungeon_depths: 'common',
  ancient_forest_floor_2: 'common',
  crypts: 'uncommon',
  crypts_floor_2: 'uncommon',
  orc_war_camp: 'rare',
  rootspire_floor_1: 'epic',
  rootspire_floor_2: 'epic',
  rootspire_floor_3: 'epic',
  rootspire_rooftop: 'epic',
};

// Difficulty stone rarity chance tables [rarity, baseChancePct]
const DIFF_STONE_CHANCES = {
  0: [['common', 1.5], ['uncommon', 0.2]],
  1: [['common', 4], ['uncommon', 0.8], ['rare', 0.1]],
  2: [['common', 8], ['uncommon', 3], ['rare', 0.6]],
  3: [['common', 14], ['uncommon', 6], ['rare', 2], ['epic', 0.4]],
  4: [['common', 18], ['uncommon', 10], ['rare', 5], ['epic', 1.5], ['legendary', 0.3]],
  5: [['common', 22], ['uncommon', 14], ['rare', 8], ['epic', 3], ['legendary', 0.8]],
};

// Mob multipliers by tier/threat
function getMobStoneMultiplier(enemy) {
  if (enemy?.threat === 'summon') return 0;
  if (enemy?.threat === 'special') return 1.5;
  const tier = Math.max(1, Math.floor(enemy?.tier || 1));
  const tierMults = { 1: 0.25, 2: 0.5, 3: 0.75, 4: 1.0 };
  return tierMults[Math.min(4, tier)] ?? 1.0;
}

function getZoneStoneCap(zoneId) {
  return ZONE_STONE_CAPS[zoneId] || 'legendary';
}

/**
 * Roll for a stone drop from an enemy kill.
 * @param {object} enemy - enemy definition with tier/threat fields
 * @param {number} difficulty - adventure difficulty (0-5+)
 * @param {string} zoneId - current zone id for cap
 * @param {function} rng
 * @returns {object|null} - stone item or null
 */
export function rollStoneDrop(enemy, difficulty = 0, zoneId = null, rng = Math.random) {
  const mult = getMobStoneMultiplier(enemy);
  if (mult <= 0) return null;

  const diffLevel = Math.max(0, Math.min(5, Math.floor(difficulty)));
  const chances = DIFF_STONE_CHANCES[diffLevel] || DIFF_STONE_CHANCES[0];
  const zoneCap = getZoneStoneCap(zoneId);
  const zoneCapRank = STONE_RARITY_RANKS[zoneCap] ?? 4;

  // Roll each rarity from highest to lowest, apply zone cap
  const filtered = chances.filter(([rarity]) => (STONE_RARITY_RANKS[rarity] ?? 0) <= zoneCapRank);
  if (!filtered.length) return null;

  // Pick rarity (roll cumulatively from best to worst)
  let stoneRarity = null;
  for (const [rarity, baseChance] of [...filtered].reverse()) {
    if (rng() * 100 < baseChance * mult) {
      stoneRarity = rarity;
      break;
    }
  }
  if (!stoneRarity) return null;

  // Pick a random stone type (void excluded from normal drops)
  const stoneType = STONE_TYPES[Math.floor(rng() * STONE_TYPES.length)];
  const stoneId = `stone_${stoneType}_${stoneRarity}`;
  return items.find(item => item.id === stoneId) || null;
}

/**
 * Roll for a relic drop from a boss/special encounter.
 * @param {object} lootTable - loot table definition with optional relicDrop field
 * @param {number} difficulty - adventure difficulty
 * @param {string[]} heroRelicIds - relic ids already in hero inventory (to prevent duplicates)
 * @param {function} rng
 * @returns {object|null} - relic item or null
 */
export function rollRelicDrop(lootTable, difficulty = 0, heroRelicIds = [], rng = Math.random) {
  const relicDrop = lootTable?.relicDrop;
  if (!relicDrop?.itemId) return null;

  const baseChance = relicDrop.chance || 0;
  const d4Bonus = relicDrop.chanceD4Bonus || 0;
  const isD4Plus = difficulty >= 4;
  const finalChance = isD4Plus ? Math.min(100, baseChance + d4Bonus) : baseChance;

  if (rng() * 100 >= finalChance) return null;

  // Check hero doesn't already have this relic
  if (heroRelicIds.includes(relicDrop.itemId)) return null;

  return items.find(item => item.id === relicDrop.itemId) || null;
}

/**
 * Roll for a stone drop from a boss/special chest encounter.
 * @param {object} lootTable - loot table with optional stoneDrop field
 * @param {number} difficulty
 * @param {string} zoneId
 * @param {function} rng
 * @returns {object|null}
 */
export function rollBossStoneDrop(lootTable, difficulty = 0, zoneId = null, rng = Math.random) {
  const stoneDrop = lootTable?.stoneDrop;
  if (!stoneDrop) return null;

  const baseChance = stoneDrop.baseChance || 0;
  const d4Bonus = stoneDrop.chanceD4Bonus || 0;
  const isD4Plus = difficulty >= 4;
  const finalChance = isD4Plus ? Math.min(100, baseChance + d4Bonus) : baseChance;

  if (rng() * 100 >= finalChance) return null;

  const maxRarity = stoneDrop.maxRarity || 'common';
  const maxRarityRank = STONE_RARITY_RANKS[maxRarity] ?? 0;
  const zoneCap = getZoneStoneCap(zoneId);
  const zoneCapRank = STONE_RARITY_RANKS[zoneCap] ?? 4;
  const cappedRank = Math.min(maxRarityRank, zoneCapRank);
  const availableRarities = STONE_RARITY_NAMES.slice(0, cappedRank + 1);
  if (!availableRarities.length) return null;

  // Pick random rarity up to cap (weighted toward lower rarities)
  const rarityIndex = Math.floor(Math.pow(rng(), 1.5) * availableRarities.length);
  const stoneRarity = availableRarities[Math.min(rarityIndex, availableRarities.length - 1)];
  const stoneType = STONE_TYPES[Math.floor(rng() * STONE_TYPES.length)];
  const stoneId = `stone_${stoneType}_${stoneRarity}`;
  return items.find(item => item.id === stoneId) || null;
}

export function rollLootTable(tableOrId, rng = Math.random, lootBonus = 0, forcedRarityTable = null) {
  const table = typeof tableOrId === "string" ? LOOT_TABLES[tableOrId] : tableOrId;
  if (!table) return [];
  const drops = [];
  const pickedItemIds = new Set();
  for (const itemId of table.guaranteedDrops || []) {
    const itemDef = items.find(i => i.id === itemId);
    if (itemDef) {
      drops.push({ ...itemDef, rarity: itemDef.rarity || "normal" });
      pickedItemIds.add(itemId);
    }
  }
  const rolls = getLootTableRollCount(table, lootBonus);
  const dropChance = Math.min(1, (table.dropChance || 0) + lootBonus / 100);
  const rarityTable = forcedRarityTable || table.rarityTable || "normal";
  const minimumRarity = table.minimumRarity || table.minRarity || null;
  let minimumApplied = false;
  const generatedConfig = getGeneratedEquipmentConfig(table);
  const useIndependentEquipment = generatedConfig?.dropChance != null;
  const preventDuplicateItems = shouldPreventDuplicateItems(table, rolls);
  for (let i = 0; i < rolls; i++) {
    if (rng() > dropChance) continue;
    const hasLegacyFilters = (table.tags || []).length
      || (table.includeItemIds || []).length
      || (table.includeIds || []).length
      || (table.items || []).length;
    const dropPool = hasLegacyFilters
      ? filterUnpickedItems(getDropPool(table.tags || [], table), preventDuplicateItems ? pickedItemIds : new Set())
      : [];
    const weightedPool = (!useIndependentEquipment && generatedConfig)
      ? [...dropPool, { generatedEquipment: true, dropWeight: generatedConfig.weight }]
      : dropPool;
    const drop = weightedPool.length ? weightedPick(weightedPool, rng) : null;
    const minimumForDrop = minimumApplied ? null : minimumRarity;
    const previousDropCount = drops.length;
    if (drop?.generatedEquipment) {
      const generated = rollGeneratedEquipmentFromPool(table, null, rng, rarityTable, minimumForDrop, lootBonus);
      if (generated) drops.push(generated);
    } else if (drop) {
      drops.push(createLootItem(drop, rarityTable, rng, minimumForDrop, lootBonus));
      const dropId = getLootDropId(drop);
      if (dropId) pickedItemIds.add(dropId);
    }
    if (minimumForDrop && drops.slice(previousDropCount).some(rolledDrop => isRarityAtLeast(rolledDrop?.rarity, minimumForDrop))) {
      minimumApplied = true;
    }
  }
  if (useIndependentEquipment) {
    const equipChance = Math.min(1, (generatedConfig.dropChance || 0) + lootBonus / 200);
    if (rng() <= equipChance) {
      const generated = rollGeneratedEquipmentFromPool(table, null, rng, rarityTable, minimumApplied ? null : minimumRarity, lootBonus);
      if (generated) {
        drops.push(generated);
        minimumApplied = true;
      }
    }
  }
  if (table.equipmentDrops) {
    const eqChance = Math.min(1, (table.equipmentDrops.dropChance || 0) + lootBonus / 200);
    if (rng() <= eqChance) {
      const eqWeights = table.equipmentDrops.items || {};
      const eqPool = filterUnpickedItems(
        getDropPool([], { includeItemIds: Object.keys(eqWeights), itemWeights: eqWeights }),
        preventDuplicateItems ? pickedItemIds : new Set()
      );
      const drop = eqPool.length ? weightedPick(eqPool, rng) : null;
      if (drop) {
        drops.push(createLootItem(drop, rarityTable, rng, minimumApplied ? null : minimumRarity, lootBonus));
        const dropId = getLootDropId(drop);
        if (dropId) pickedItemIds.add(dropId);
      }
    }
  }
  return drops;
}
