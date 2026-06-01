import itemsData from "../data/items.json" with { type: "json" };
import classesData from "../data/classes.json" with { type: "json" };
import enemiesData from "../data/enemies.json" with { type: "json" };
import bossesData from "../data/bosses.json" with { type: "json" };
import petsData from "../data/pets.json" with { type: "json" };
import zonesData from "../data/zones.json" with { type: "json" };
import talentsData from "../data/talents.json" with { type: "json" };
import adventuresData from "../data/adventures.json" with { type: "json" };
import equipmentGenerationData from "../data/equipmentGeneration.json" with { type: "json" };
import { migrateSavedItemRef } from "./itemRefs.js";

export const TALENT_TIER_ENERGY_COSTS = Object.freeze({
  1: 15,
  2: 25,
  3: 35,
});

function tierEnergyCost(tier) {
  return TALENT_TIER_ENERGY_COSTS[Number(tier)] ?? null;
}

function replaceEnergyText(text, energyCost) {
  if (typeof text !== "string" || energyCost == null) return text;
  return text
    .replace(/\(\s*\d+\s*energy\s*\)/gi, `(${energyCost} energy)`)
    .replace(/\b\d+\s*energy\b/gi, `${energyCost} energy`);
}

function normalizeTalentChoice(choice, energyCost, skillEnergyCosts) {
  const unlocksSkill = (choice.effects || []).some(effect => effect?.type === "unlock_skill" && effect.skillId);
  if (!unlocksSkill || energyCost == null) return choice;
  return {
    ...choice,
    summary: (choice.summary || []).map(line => replaceEnergyText(line, energyCost)),
    effects: (choice.effects || []).map(effect => {
      if (effect?.type !== "unlock_skill" || !effect.skillId) return effect;
      skillEnergyCosts.set(effect.skillId, energyCost);
      return { ...effect, energyCost };
    }),
  };
}

function normalizeTalentTier(tier, skillEnergyCosts) {
  const energyCost = tierEnergyCost(tier?.tier);
  return {
    ...tier,
    choices: (tier.choices || []).map(choice => normalizeTalentChoice(choice, energyCost, skillEnergyCosts)),
    nodes: (tier.nodes || []).map(node => normalizeTalentChoice(node, energyCost, skillEnergyCosts)),
  };
}

function normalizeTalentTreeData(trees = []) {
  const skillEnergyCosts = new Map();
  const treesWithTierCosts = trees.map(tree => ({
    ...tree,
    branches: (tree.branches || []).map(branch => ({
      ...branch,
      tiers: (branch.tiers || []).map(tier => normalizeTalentTier(tier, skillEnergyCosts)),
    })),
    tiers: (tree.tiers || []).map(tier => normalizeTalentTier(tier, skillEnergyCosts)),
  }));
  return { trees: treesWithTierCosts, skillEnergyCosts };
}

const normalizedTalentData = normalizeTalentTreeData(talentsData.trees || []);

function normalizeAbilityEnergyCost(ability) {
  const energyCost = normalizedTalentData.skillEnergyCosts.get(ability?.id);
  if (energyCost == null) return ability;
  return {
    ...ability,
    energyCost,
    description: replaceEnergyText(ability.description, energyCost),
  };
}

export const universalAbilities = (classesData.universalAbilities || []).map(normalizeAbilityEnergyCost);
export const universalUltimates = classesData.universalUltimates || [];
export const heroClasses = classesData.classes.map(entry => ({
  ...entry,
  abilities: [
    ...(entry.abilities || []),
    ...universalAbilities.map(a => ({ ...a, universal: true })),
  ].map(normalizeAbilityEnergyCost),
  ultimates: [...(entry.ultimates || []), ...universalUltimates],
}));
export const items = itemsData.items;
export const enemies = enemiesData.enemies;
export const bosses = bossesData.bosses;
export const pets = petsData.pets || [];
export const zones = zonesData.zones;
export const talentTrees = normalizedTalentData.trees;
export const regions = adventuresData.regions;
export const adventures = adventuresData.adventures;
export const combatSkills = Array.from(
  new Map(heroClasses.flatMap(entry => entry.abilities || []).map(ability => [ability.id, ability])).values(),
);
export const ultimateSkills = Array.from(
  new Map(heroClasses.flatMap(entry => entry.ultimates || []).map(ultimate => [ultimate.id, ultimate])).values(),
);

export const byId = list => Object.fromEntries(list.map(entry => [entry.id, entry]));

export const itemById = byId(items);
export const enemyById = byId(enemies);
export const bossById = byId(bosses);
export const petById = byId(pets);
export const zoneById = byId(zones);
export const regionById = byId(regions);
export const adventureById = byId(adventures);
export const combatSkillById = byId(combatSkills);
export const ultimateSkillById = byId(ultimateSkills);

const ITEM_ICON_OVERRIDES = {
  fur_cloak: "/assets/items/generated/cape.png?v=2",
  leather_boots: "/assets/items/generated/Leather%20boots.png?v=2",
  plate_boots: "/assets/items/generated/Leather%20boots.png?v=2",
  troll_hide: "/assets/items/troll hide.png",
  tanned_troll_hide: "/assets/items/Troll tanned hide.png",
  foragers_satchel: "/assets/items/Forager satchel.png",
};

const generatedEquipmentBaseById = byId([
  ...(equipmentGenerationData.weaponBases || []),
  ...(equipmentGenerationData.armorBases || []),
]);

export const equipmentSets = equipmentGenerationData.sets || {};

const DEPRECATED_GENERATED_BASE_EFFECTS = {
  leather_helm: [
    { type: "dodge_chance", value: 1 },
    { type: "attack_speed", value: 1 },
  ],
  leather_chest: [
    { type: "dodge_chance", value: 2 },
    { type: "attack_speed", value: 1 },
  ],
  leather_legs: [
    { type: "dodge_chance", value: 1 },
    { type: "attack_speed", value: 1 },
  ],
  leather_boots: [
    { type: "dodge_chance", value: 2 },
    { type: "attack_speed", value: 2 },
  ],
  leather_gloves: [
    { type: "dodge_chance", value: 1 },
    { type: "attack_speed", value: 2 },
  ],
  mail_chest: [
    { type: "crit_chance", value: 1 },
    { type: "hit_chance", value: 2 },
  ],
  plate_helm: [
    { type: "armor", value: 1 },
    { type: "crit_resist", value: 1 },
  ],
  plate_chest: [
    { type: "armor", value: 3 },
    { type: "max_hp", value: 8 },
  ],
  plate_legs: [
    { type: "armor", value: 2 },
    { type: "max_hp", value: 5 },
  ],
  plate_boots: [
    { type: "armor", value: 1 },
    { type: "crit_resist", value: 1 },
  ],
  plate_gloves: [
    { type: "armor", value: 1 },
    { type: "max_hp", value: 4 },
  ],
  // imp_ember_ring's burn_on_hit was removed for being too strong; strip it from
  // copies already rolled before the template was fixed (they now use the named
  // fire_resist + attack_speed profile instead).
  imp_ember_ring: [
    { type: "burn_on_hit", chance: 8, duration: 2, damagePct: 2 },
  ],
};

function itemEffectIdentity(effect) {
  if (!effect?.type) return "";
  if (effect.type === "stat_bonus") return `${effect.type}:${effect.stat || ""}`;
  if (effect.type === "damage_vs_tag") return `${effect.type}:${effect.tag || effect.targetTag || ""}`;
  if (effect.type === "damage_vs_family") return `${effect.type}:${effect.family || effect.targetFamily || ""}`;
  return effect.type;
}

function itemEffectMatches(effect, reference) {
  if (!effect || !reference) return false;
  if (itemEffectIdentity(effect) !== itemEffectIdentity(reference)) return false;
  return Object.entries(reference).every(([key, value]) => effect[key] === value);
}

function getGeneratedEquipmentBaseId(item) {
  if (!item || typeof item !== "object") return null;
  const candidates = [item.generation?.baseId, item.baseId, item.id].filter(Boolean);
  for (const candidate of candidates) {
    if (generatedEquipmentBaseById[candidate]) return candidate;
    if (typeof candidate === "string" && candidate.startsWith("generated_")) {
      const baseId = candidate.slice("generated_".length);
      if (generatedEquipmentBaseById[baseId]) return baseId;
    }
  }
  return null;
}

function buildRetroactiveDice(baseDice, storedStatValue) {
  const count = Math.max(1, Math.floor(Number(baseDice?.count) || 1));
  const sides = Math.max(1, Math.floor(Number(baseDice?.sides) || 1));
  const average = count * ((sides + 1) / 2);
  const stored = Number(storedStatValue) || average;
  const bonus = Math.round(stored - average);
  const b = bonus;
  const text = b > 0 ? `${count}d${sides}+${b}` : b < 0 ? `${count}d${sides}${b}` : `${count}d${sides}`;
  return { count, sides, bonus, text, average: stored, min: Math.max(1, count + bonus), max: Math.max(1, count * sides + bonus) };
}

function normalizeGeneratedBaseEffects(item) {
  if (!item || typeof item !== "object") return item;
  const baseId = getGeneratedEquipmentBaseId(item);
  const generatedBase = generatedEquipmentBaseById[baseId];
  let normalized = item;
  if (generatedBase && item.slot === "weapon" && item.attackSpeed == null && generatedBase.attackSpeed != null) {
    normalized = {
      ...normalized,
      attackSpeed: generatedBase.attackSpeed,
    };
  }
  // Carry the paperdoll icon scale from the generated base so items dropped before iconScale was
  // set on the base (or before the generator copied it) still render at the tuned size.
  if (generatedBase && normalized.iconScale == null && generatedBase.iconScale != null) {
    normalized = { ...normalized, iconScale: generatedBase.iconScale };
  }
  // Retroactively add armorDice/damageDice if the base defines them but the item predates the dice system
  if (generatedBase) {
    const isWeapon = item.slot === "weapon";
    const diceKey = isWeapon ? "damageDice" : "armorDice";
    const statKey = isWeapon ? "damage" : "armor";
    if (generatedBase[diceKey] && !normalized[diceKey]) {
      const storedStat = normalized.baseStats?.[statKey];
      normalized = { ...normalized, [diceKey]: buildRetroactiveDice(generatedBase[diceKey], storedStat) };
    }
  }
  let currentEffects = item.effects || [];
  let removedDeprecatedEffects = false;
  const deprecatedBaseEffects = DEPRECATED_GENERATED_BASE_EFFECTS[baseId] || [];
  if (deprecatedBaseEffects.length && currentEffects.length) {
    const filteredEffects = currentEffects.filter(effect =>
      !deprecatedBaseEffects.some(reference => itemEffectMatches(effect, reference))
    );
    removedDeprecatedEffects = filteredEffects.length !== currentEffects.length;
    currentEffects = filteredEffects;
  }
  const baseEffects = generatedEquipmentBaseById[baseId]?.effects || [];
  if (!baseEffects.length && !removedDeprecatedEffects) return normalized;
  const baseEffectIdentities = new Set(baseEffects.map(itemEffectIdentity));
  const currentEffectIds = new Set(currentEffects.map(itemEffectIdentity));
  const missingBaseEffects = baseEffects.filter(effect => !currentEffectIds.has(itemEffectIdentity(effect)));
  const needsBaseTag = currentEffects.some(e => baseEffectIdentities.has(itemEffectIdentity(e)) && !e._base);
  if (!missingBaseEffects.length && !removedDeprecatedEffects && !needsBaseTag) return normalized;
  return {
    ...normalized,
    effects: [
      ...missingBaseEffects.map(effect => ({ ...effect, _base: true })),
      ...currentEffects.map(effect =>
        baseEffectIdentities.has(itemEffectIdentity(effect)) ? { ...effect, _base: true } : effect
      ),
    ],
  };
}

function getItemVisualBaseId(item) {
  if (!item || typeof item !== "object") return item || null;
  return item.baseId || item.generation?.baseId || item.id || null;
}

function normalizeItemVisuals(item) {
  if (!item || typeof item !== "object") return item;
  const visualBaseId = getItemVisualBaseId(item);
  const generatedVisualBaseId = typeof visualBaseId === "string" && visualBaseId.startsWith("generated_")
    ? visualBaseId.slice("generated_".length)
    : null;
  const name = `${item.name || ""}`.toLowerCase();
  const tags = new Set(item.tags || []);
  const inferredVisualBaseId = visualBaseId === "generated_leather_boots"
    || item.generation?.baseId === "leather_boots"
    || (item.slot === "boots" && name.includes("leather boots"))
    || (item.slot === "boots" && tags.has("leather"))
    ? "leather_boots"
    : item.generation?.baseId || generatedVisualBaseId || visualBaseId;
  const icon = ITEM_ICON_OVERRIDES[inferredVisualBaseId];
  if (!icon || item.icon === icon) return item;
  return { ...item, icon };
}

export function getItem(id) {
  if (id && typeof id === "object") {
    const migrated = migrateSavedItemRef(id);
    const itemRef = migrated && typeof migrated === "object" ? migrated : id;
    // Enchantment overlay { id, enchantment?, fractured? } for static (non-generated) items.
    // Merge the overlay onto the base definition so size, type, slot, etc. are preserved.
    if (typeof itemRef.id === "string" && !itemRef.generation && itemById[itemRef.id]
        && (!itemRef.baseId || itemRef.baseId === itemRef.id)) {
      const template = itemById[itemRef.id];
      const merged = { ...template, ...itemRef };
      if (template.attackSpeed != null) merged.attackSpeed = template.attackSpeed;
      if (template.baseStats != null) merged.baseStats = { ...template.baseStats };
      if (template.damageDice) merged.damageDice = { ...template.damageDice };
      if (template.armorDice) merged.armorDice = { ...template.armorDice };
      if (template.size != null) merged.size = template.size;
      // Relic passives are balance data, not per-item rolls — always use the live definition so
      // tuning changes apply to relics already saved/equipped (they're stored as full objects).
      if (template.relicPassive != null) merged.relicPassive = template.relicPassive;
      // Same for enchantment-stone effect pools: stones are stored as full object snapshots, so an
      // old saved stone keeps a stale pool (e.g. a rare Blood stone still rolling the removed
      // "+5% damage below 50% HP"). Always resolve the pool from the live definition.
      if (template.enchantmentPool != null) merged.enchantmentPool = template.enchantmentPool;
      const templateBaseEffects = (template.effects || []).filter(e => e._base);
      if (templateBaseEffects.length > 0) {
        const templateBaseTypes = new Set(templateBaseEffects.map(e => e.type + (e.stat ? ':' + e.stat : '')));
        const currentTypes = new Set((merged.effects || []).map(e => e.type + (e.stat ? ':' + e.stat : '')));
        const missing = templateBaseEffects.filter(e => !currentTypes.has(e.type + (e.stat ? ':' + e.stat : '')));
        // Stamp _base: true on any stored effect whose type matches a template base effect
        merged.effects = (merged.effects || []).map(e => {
          const key = e.type + (e.stat ? ':' + e.stat : '');
          return templateBaseTypes.has(key) ? { ...e, _base: true } : e;
        });
        if (missing.length > 0) merged.effects = [...missing, ...merged.effects];
      }
      return normalizeItemVisuals(merged);
    }
    return normalizeItemVisuals(normalizeGeneratedBaseEffects(itemRef));
  }
  return normalizeItemVisuals(itemById[id]) || null;
}

export function getEnemy(id) {
  return enemyById[id] || bossById[id] || null;
}

export function getPet(id) {
  return petById[id] || null;
}

export function getTalentNode(id) {
  for (const tree of talentTrees) {
    for (const level of tree.levels || []) {
      const node = level.choices?.find(choice => choice.id === id);
      if (node) return node;
    }
    for (const branch of tree.branches || []) {
      for (const tier of branch.tiers || []) {
        const node = tier.choices?.find(choice => choice.id === id);
        if (node) return node;
      }
    }
    for (const tier of tree.tiers || []) {
      const node = tier.nodes.find(n => n.id === id);
      if (node) return node;
    }
  }
  return null;
}

export function getCombatSkill(id) {
  return combatSkillById[id] || null;
}

export function getUltimateSkill(id) {
  return ultimateSkillById[id] || null;
}
