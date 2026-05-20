import {
  GENERATED_EQUIPMENT_DATA,
  isGeneratedEquipmentAffixAllowedForBase,
  rollReplacementEquipmentAffix,
  rollEquipmentAffixes,
} from "./equipmentGenerator.js";

export function removeDormantCombatEffects(effects = []) {
  return effects.filter(effect => effect?.type !== "initiative" && effect?.type !== "reach");
}

const GENERATED_EQUIPMENT_BASES = [
  ...(GENERATED_EQUIPMENT_DATA.weaponBases || []),
  ...(GENERATED_EQUIPMENT_DATA.armorBases || []),
];

const GENERATED_EQUIPMENT_BASE_BY_ID = Object.fromEntries(
  GENERATED_EQUIPMENT_BASES.map(base => [base.id, base])
);

const GENERATED_EQUIPMENT_MATERIAL_BY_ID = Object.fromEntries(
  (GENERATED_EQUIPMENT_DATA.materials || []).map(material => [material.id, material])
);

const ELEMENTAL_RESIST_EFFECT_TYPES = new Set([
  "fire_resist",
  "cold_resist",
  "lightning_resist",
  "shadow_resist",
  "poison_resist",
  "all_elemental_resist",
]);
const DEPRECATED_CASTER_ARMOR_EFFECT_IDENTITIES = new Set(["spell_damage", "stat_bonus:int"]);
const ARMOR_CATEGORY_TAGS = new Set(["light", "medium", "heavy", "armor_light", "armor_medium", "armor_heavy"]);

const RAPIER_BASE_PARRY_RANGE_BY_RARITY = {
  normal: [3, 5],
  uncommon: [4, 6],
  rare: [5, 7],
  epic: [6, 8],
  legendary: [7, 10],
  artifact: [8, 12],
  unique: [7, 10],
};

const CRIT_DAMAGE_CAP_BY_RARITY = {
  normal: 5,
  uncommon: 6,
  rare: 7,
  epic: 8,
  legendary: 9,
  artifact: 10,
  unique: 10,
};

const SAVED_ITEM_ICON_OVERRIDES = {
  fur_cloak: "/assets/items/generated/cape.png?v=2",
  leather_boots: "/assets/items/generated/Leather%20boots.png?v=2",
  oathbound_plate_sabatons: "/assets/items/generated/Leather%20boots.png?v=2",
  plate_boots: "/assets/items/generated/Leather%20boots.png?v=2",
};

const LEGACY_RING_METADATA = {
  ring_of_thorns: {
    name: "Guard Ring",
    previousName: "Guarding Ring",
    rarityAffixPools: ["guard", "survival"],
  },
  vampire_ring: {
    rarityAffixPools: ["blood", "survival"],
  },
  gust_ring: {
    rarityAffixPools: ["speed", "precision"],
  },
};

const NON_RECIPE_FOOD_BUFF_ITEM_IDS = new Set([
  "ration",
  "hearty_stew",
  "wolf_meat",
  "cooked_wolf_meat",
  "boar_meat",
  "cooked_boar_meat",
  "warg_meat",
  "cooked_warg_meat",
  "bear_meat",
  "cooked_bear_meat",
  "wild_berries",
  "wild_mushrooms",
  "root_vegetables",
  "raw_honey",
  "cooking_herbs",
  "prime_forage",
]);

function arraysEqual(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function itemEffectIdentity(effect) {
  if (!effect?.type) return "";
  return effect.type === "stat_bonus" ? `${effect.type}:${effect.stat || ""}` : effect.type;
}

function hasGeneratedEquipmentShape(ref) {
  if (!ref || typeof ref !== "object") return false;
  const candidates = [ref.generation?.baseId, ref.baseId, ref.id].filter(Boolean);
  return !!ref.generated
    || !!ref.generation
    || !!ref.armorDice
    || !!ref.damageDice
    || (ref.tags || []).some(tag => tag === "generated" || tag === "dice_v1")
    || candidates.some(candidate => typeof candidate === "string" && candidate.startsWith("generated_"));
}

function scoreGeneratedBaseCandidate(ref, base) {
  if (!base || ref.slot && base.slot !== ref.slot) return 0;
  const refTags = new Set(ref.tags || []);
  const refName = `${ref.name || ""}`.toLowerCase();
  const baseName = `${base.name || ""}`.toLowerCase();
  let score = 0;
  if (baseName && refName.includes(baseName)) score += 80;
  if (ref.family && base.family === ref.family) score += 20;
  if (ref.armorType && base.armorType === ref.armorType) score += 20;
  if (ref.weaponType && base.weaponType === ref.weaponType) score += 20;
  for (const tag of base.tags || []) {
    if (refTags.has(tag)) score += 8;
  }
  if (refName && base.id && base.id.split("_").every(part => refName.includes(part))) score += 12;
  return score;
}

function inferGeneratedBaseId(ref) {
  if (!hasGeneratedEquipmentShape(ref)) return null;
  const scored = GENERATED_EQUIPMENT_BASES
    .map(base => ({ base, score: scoreGeneratedBaseCandidate(ref, base) }))
    .filter(entry => entry.score >= 35)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.base?.id || null;
}

function getGeneratedBaseId(ref) {
  if (!ref || typeof ref !== "object") return null;
  const candidates = [ref.generation?.baseId, ref.baseId, ref.id].filter(Boolean);
  for (const candidate of candidates) {
    if (GENERATED_EQUIPMENT_BASE_BY_ID[candidate]) return candidate;
    if (typeof candidate === "string" && candidate.startsWith("generated_")) {
      const baseId = candidate.slice("generated_".length);
      if (GENERATED_EQUIPMENT_BASE_BY_ID[baseId]) return baseId;
    }
  }
  return inferGeneratedBaseId(ref);
}

function getGeneratedMaterialId(ref) {
  if (!ref || typeof ref !== "object") return null;
  const explicit = ref.generation?.materialId || ref.materialId;
  if (GENERATED_EQUIPMENT_MATERIAL_BY_ID[explicit]) return explicit;
  const taggedMaterial = (ref.tags || []).find(tag => GENERATED_EQUIPMENT_MATERIAL_BY_ID[tag]);
  return taggedMaterial || null;
}

function getGeneratedAffixDefinitions(base, materialId, rarity = "normal") {
  const material = GENERATED_EQUIPMENT_MATERIAL_BY_ID[materialId] || null;
  const poolIds = [...new Set([...(base?.affixPools || []), ...(material?.extraAffixPools || [])])];
  return poolIds
    .flatMap(id => GENERATED_EQUIPMENT_DATA.affixPools?.[id] || [])
    .filter(definition => isGeneratedEquipmentAffixAllowedForBase(definition, base, rarity));
}

function isCurrentGeneratedEffectAllowed(ref, effect) {
  const base = GENERATED_EQUIPMENT_BASE_BY_ID[getGeneratedBaseId(ref)];
  if (!base) return true;
  const identity = itemEffectIdentity(effect);
  if ((base.effects || []).some(baseEffect => itemEffectIdentity(baseEffect) === identity)) return true;
  return getGeneratedAffixDefinitions(base, getGeneratedMaterialId(ref), ref.rarity || "normal")
    .some(definition => itemEffectIdentity(definition) === identity);
}

function stableRerollRng(ref, effect, index) {
  const key = `${ref.uid || ref.name || ref.id || "item"}:${effect?.type || "effect"}:${effect?.value ?? ""}:${index}:elemental-affix-reroll-v1`;
  let seed = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    seed ^= key.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed = Math.imul(seed, 1664525) + 1013904223;
    return (seed >>> 0) / 4294967296;
  };
}

function getStaticSavedBaseId(ref) {
  if (!ref || typeof ref !== "object") return null;
  return ref.baseId || ref.id || null;
}

function getSavedVisualBaseId(ref) {
  if (!ref || typeof ref !== "object") return null;
  const candidates = [ref.generation?.baseId, ref.baseId, ref.id].filter(Boolean);
  for (const candidate of candidates) {
    if (SAVED_ITEM_ICON_OVERRIDES[candidate]) return candidate;
    if (typeof candidate === "string" && candidate.startsWith("generated_")) {
      const baseId = candidate.slice("generated_".length);
      if (SAVED_ITEM_ICON_OVERRIDES[baseId]) return baseId;
    }
  }
  return null;
}

function migrateSavedItemIcon(ref) {
  const visualBaseId = getSavedVisualBaseId(ref);
  const icon = SAVED_ITEM_ICON_OVERRIDES[visualBaseId];
  if (!icon || ref.icon === icon) return ref;
  return { ...ref, icon };
}

function hasSameArmorCategoryTags(currentTags = [], baseCategoryTags = []) {
  const currentCategoryTags = currentTags.filter(tag => ARMOR_CATEGORY_TAGS.has(tag));
  return currentCategoryTags.length === baseCategoryTags.length
    && currentCategoryTags.every(tag => baseCategoryTags.includes(tag));
}

function migrateGeneratedArmorCategory(ref) {
  const base = GENERATED_EQUIPMENT_BASE_BY_ID[getGeneratedBaseId(ref)];
  if (!base || base.family !== "armor") return ref;
  let next = ref;
  if (base.armorType && ref.armorType !== base.armorType) {
    next = { ...next, armorType: base.armorType };
  }
  const currentTags = Array.isArray(next.tags) ? next.tags : [];
  const baseCategoryTags = (base.tags || []).filter(tag => ARMOR_CATEGORY_TAGS.has(tag));
  if (currentTags.length && baseCategoryTags.length && !hasSameArmorCategoryTags(currentTags, baseCategoryTags)) {
    const withoutOldCategory = currentTags.filter(tag => !ARMOR_CATEGORY_TAGS.has(tag));
    const tags = [...withoutOldCategory, ...baseCategoryTags];
    if (!arraysEqual(tags, currentTags)) next = { ...next, tags };
  }
  return next;
}

function migrateLegacyRingMetadata(ref) {
  const baseId = getStaticSavedBaseId(ref);
  const metadata = LEGACY_RING_METADATA[baseId];
  if (!metadata) return ref;
  let next = ref;
  if (metadata.previousName && typeof next.name === "string" && next.name.includes(metadata.previousName)) {
    next = { ...next, name: next.name.replace(metadata.previousName, metadata.name) };
  }
  if (metadata.rarityAffixPools && !arraysEqual(next.rarityAffixPools || [], metadata.rarityAffixPools)) {
    next = { ...next, rarityAffixPools: [...metadata.rarityAffixPools] };
  }
  return next;
}

function getSavedCritDamageCap(ref = {}) {
  const rarity = String(ref.rarity || "normal").toLowerCase();
  return CRIT_DAMAGE_CAP_BY_RARITY[rarity] || CRIT_DAMAGE_CAP_BY_RARITY.normal;
}

function clampSavedCritDamage(ref) {
  if (!Array.isArray(ref.effects)) return ref;
  const cap = getSavedCritDamageCap(ref);
  let changed = false;
  const effects = ref.effects.map(effect => {
    if (effect?.type !== "crit_damage" || !Number.isFinite(Number(effect.value)) || Number(effect.value) <= cap) return effect;
    changed = true;
    return { ...effect, value: cap };
  });
  return changed ? { ...ref, effects } : ref;
}

function getSavedRapierParryRange(ref = {}) {
  const rarity = String(ref.rarity || "normal").toLowerCase();
  return RAPIER_BASE_PARRY_RANGE_BY_RARITY[rarity] || RAPIER_BASE_PARRY_RANGE_BY_RARITY.normal;
}

function migrateSavedRapierBaseEffects(ref) {
  if (getGeneratedBaseId(ref) !== "rapier" || !Array.isArray(ref.effects)) return ref;
  const [parryMin, parryMax] = getSavedRapierParryRange(ref);
  let changed = false;
  const effects = ref.effects.reduce((next, effect) => {
    if (effect?.type === "crit_chance" && Number(effect.value) === 2) {
      changed = true;
      return next;
    }
    if (effect?.type === "parry_chance") {
      const value = Number(effect.value);
      if (Number.isFinite(value) && (value < parryMin || value > parryMax)) {
        changed = true;
        next.push({ ...effect, value: Math.max(parryMin, Math.min(parryMax, value)) });
        return next;
      }
    }
    if (effect?.type === "parry_chance" && !Number.isFinite(Number(effect.value))) {
      changed = true;
      next.push({ ...effect, value: parryMin });
      return next;
    }
    next.push(effect);
    return next;
  }, []);
  return changed ? { ...ref, effects } : ref;
}

function migrateSavedFoodBuffs(ref) {
  const baseId = getStaticSavedBaseId(ref);
  if (!NON_RECIPE_FOOD_BUFF_ITEM_IDS.has(baseId) || !Array.isArray(ref.effects)) return ref;
  const effects = ref.effects.filter(effect => effect?.type !== "food_buff");
  return effects.length === ref.effects.length ? ref : { ...ref, effects };
}

function isGeneratedCasterRestrictedBase(base) {
  return base?.family === "armor"
    && base.armorType !== "cloth"
    && !(base.tags || []).includes("cloth");
}

function migrateDeprecatedGeneratedCasterBaseStats(ref) {
  const baseId = getGeneratedBaseId(ref);
  const base = GENERATED_EQUIPMENT_BASE_BY_ID[baseId];
  if (!base || !isGeneratedCasterRestrictedBase(base) || !ref.baseStats || typeof ref.baseStats !== "object") return ref;

  const casterStatKeys = ["int", "spellDamage", "spell_damage"];
  const removed = casterStatKeys
    .map(key => [key, Number(ref.baseStats[key] || 0)])
    .filter(([, value]) => value !== 0);
  if (!removed.length) return ref;

  const baseStats = { ...ref.baseStats };
  removed.forEach(([key]) => { delete baseStats[key]; });

  const materialId = getGeneratedMaterialId(ref);
  const effects = [...(ref.effects || [])];
  removed.forEach(([key, value], index) => {
    const replacement = rollReplacementEquipmentAffix({
      baseId,
      materialId,
      rarity: ref.rarity || "normal",
      usedEffects: effects,
      disallowedTypes: [...ELEMENTAL_RESIST_EFFECT_TYPES, "spell_damage"],
    }, stableRerollRng(ref, { type: key, value }, index));
    if (replacement) effects.push(replacement);
  });

  return { ...ref, baseStats, effects };
}

function isDeprecatedGeneratedEffect(ref, effect) {
  if (ELEMENTAL_RESIST_EFFECT_TYPES.has(effect?.type)) return !isCurrentGeneratedEffectAllowed(ref, effect);
  if (DEPRECATED_CASTER_ARMOR_EFFECT_IDENTITIES.has(itemEffectIdentity(effect))) {
    return !isCurrentGeneratedEffectAllowed(ref, effect);
  }
  return false;
}

function migrateDeprecatedGeneratedAffixes(ref) {
  const baseId = getGeneratedBaseId(ref);
  if (!baseId || !Array.isArray(ref.effects)) return ref;
  const materialId = getGeneratedMaterialId(ref);
  const invalidIndexes = new Set();
  ref.effects.forEach((effect, index) => {
    if (isDeprecatedGeneratedEffect(ref, effect)) {
      invalidIndexes.add(index);
    }
  });
  if (!invalidIndexes.size) return ref;

  let changed = false;
  const keptEffects = ref.effects.filter((_, index) => !invalidIndexes.has(index));
  const effects = [];
  ref.effects.forEach((effect, index) => {
    if (!invalidIndexes.has(index)) {
      effects.push(effect);
      return;
    }
    changed = true;
    const replacement = rollReplacementEquipmentAffix({
      baseId,
      materialId,
      rarity: ref.rarity || "normal",
      usedEffects: [...keptEffects, ...effects],
      disallowedTypes: [...ELEMENTAL_RESIST_EFFECT_TYPES, "spell_damage"],
    }, stableRerollRng(ref, effect, index));
    if (replacement) effects.push(replacement);
  });
  return changed ? { ...ref, effects } : ref;
}

function migrateWargFangNecklace(ref) {
  if (ref?.id !== "warg_fang_necklace") return ref;
  // Already migrated — new pool in place, nothing to do.
  if (Array.isArray(ref.rarityAffixPools) && ref.rarityAffixPools.includes("warg_fang")) return ref;

  // Wipe all old hardcoded stats/effects and roll exactly 1 from the new pool.
  const rng = stableRerollRng(ref, { type: "warg_fang_v1", value: 0 }, 0);
  const affixes = rollEquipmentAffixes(
    { affixPools: ["warg_fang"], guaranteedAffixes: 1, maxAffixes: 1, effects: [] },
    ref.rarity || "normal",
    rng
  );

  return {
    ...ref,
    baseStats: {},
    effects: affixes,
    rarityAffixPools: ["warg_fang"],
    guaranteedAffixes: 1,
    maxAffixes: 1,
  };
}

export function migrateItemRef(ref) {
  if (!ref || typeof ref !== "object") return ref;
  let migrated = migrateSavedItemIcon(ref);
  migrated = migrateWargFangNecklace(migrated);
  migrated = migrateGeneratedArmorCategory(migrated);
  migrated = migrateLegacyRingMetadata(migrated);
  migrated = migrateSavedRapierBaseEffects(migrated);
  migrated = migrateDeprecatedGeneratedCasterBaseStats(migrated);
  migrated = migrateDeprecatedGeneratedAffixes(migrated);
  migrated = clampSavedCritDamage(migrated);
  migrated = migrateSavedFoodBuffs(migrated);
  if (!migrated.effects?.some(effect => effect?.type === "initiative" || effect?.type === "reach")) return migrated;
  return { ...migrated, effects: removeDormantCombatEffects(migrated.effects) };
}

export function migrateSavedItemRef(ref) {
  return migrateItemRef(ref);
}

export function migrateInventoryItemRef(ref) {
  if (ref && typeof ref === "object" && Object.prototype.hasOwnProperty.call(ref, "itemId")) {
    const itemId = migrateSavedItemRef(ref.itemId);
    return itemId === ref.itemId ? ref : { ...ref, itemId };
  }
  return migrateSavedItemRef(ref);
}

export function migrateLootList(list = []) {
  let changed = false;
  const next = (list || []).map(ref => {
    const migrated = migrateSavedItemRef(ref);
    if (migrated !== ref) changed = true;
    return migrated;
  });
  return changed ? next : (list || []);
}
