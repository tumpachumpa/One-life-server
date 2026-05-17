import equipmentGenerationData from "../data/equipmentGeneration.json" with { type: "json" };

export const GENERATED_EQUIPMENT_DATA = equipmentGenerationData;

export const GENERATED_EQUIPMENT_RARITIES = {
  normal: { id: "normal", label: "", color: "#aaa", statMult: 1, priceMult: 1, affixSlots: 0, affixMult: 1 },
  uncommon: { id: "uncommon", label: "Uncommon", color: "#2ecc71", statMult: 1.06, priceMult: 1.18, affixSlots: 1, affixMult: 1 },
  rare: { id: "rare", label: "Rare", color: "#3498db", statMult: 1.12, priceMult: 1.45, affixSlots: 2, affixMult: 1 },
  epic: { id: "epic", label: "Epic", color: "#9b59b6", statMult: 1.28, priceMult: 2.2, affixSlots: 3, affixMult: 1.2 },
  legendary: { id: "legendary", label: "Legendary", color: "#f1c40f", statMult: 1.48, priceMult: 3.7, affixSlots: 4, affixMult: 1.4 },
  artifact: { id: "artifact", label: "Artifact", color: "#ff6b35", statMult: 1.7, priceMult: 6, affixSlots: 5, affixMult: 1.6 },
  unique: { id: "unique", label: "Unique", color: "#1abc9c", statMult: 1.55, priceMult: 5, affixSlots: 4, affixMult: 1.35 },
};

const BLOCK_AFFIX_TYPES = new Set(["block_chance", "block_power", "block_power_pct", "block_power_regen"]);
const ARMOR_CASTER_AFFIX_IDENTITIES = new Set(["spell_damage", "stat_bonus:int"]);
const SPECIAL_SCALING_AFFIX_RARITIES = new Set(["artifact", "unique"]);
const SPECIAL_SCALING_AFFIX_TYPES = new Set(["armor_pct", "damage_bonus_pct"]);

export const STARTER_LOADOUT_IDS = ["sword", "mace", "spear", "bow"];

const STARTER_WEAPON_SPECS = {
  sword: { baseId: "sword_1h", materialId: "rusty", name: "Crude Sword" },
  mace: { baseId: "mace_1h", materialId: "rusty", name: "Crude Mace" },
  spear: { baseId: "spear_2h", materialId: "rusty", name: "Crude Spear" },
  bow: { baseId: "bow", materialId: "worn", name: "Worn Bow" },
};

const STARTER_CHEST_SPEC = { baseId: "cloth_chest", materialId: "cloth", name: "Threadbare Tunic" };

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function weightedPickByWeight(list, rng = Math.random) {
  if (!list.length) return null;
  const total = list.reduce((sum, entry) => sum + Math.max(0, Number(entry.weight ?? 1)), 0);
  if (total <= 0) return list[list.length - 1];
  let roll = rng() * total;
  for (const entry of list) {
    roll -= Math.max(0, Number(entry.weight ?? 1));
    if (roll <= 0) return entry;
  }
  return list[list.length - 1];
}

function rollIntRange(min, max, rng = Math.random) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  if (high <= low) return low;
  return low + Math.floor(rng() * (high - low + 1));
}

export function getDiceAverage(dice = {}) {
  const count = Math.max(1, Math.floor(Number(dice.count) || 1));
  const sides = Math.max(1, Math.floor(Number(dice.sides) || 1));
  return count * ((sides + 1) / 2) + (Number(dice.bonus) || 0);
}

export function formatDice(dice = {}) {
  const count = Math.max(1, Math.floor(Number(dice.count) || 1));
  const sides = Math.max(1, Math.floor(Number(dice.sides) || 1));
  const bonus = Math.floor(Number(dice.bonus) || 0);
  if (bonus > 0) return `${count}d${sides}+${bonus}`;
  if (bonus < 0) return `${count}d${sides}${bonus}`;
  return `${count}d${sides}`;
}

export function rollDice(dice = {}, rng = Math.random) {
  const count = Math.max(1, Math.floor(Number(dice.count) || 1));
  const sides = Math.max(1, Math.floor(Number(dice.sides) || 1));
  const bonus = Math.floor(Number(dice.bonus) || 0);
  let total = bonus;
  for (let i = 0; i < count; i++) {
    total += 1 + Math.floor(rng() * sides);
  }
  return Math.max(1, total);
}

function materializeDice(baseDice, itemLevel, material, rarity, kind) {
  const count = Math.max(1, Math.floor(Number(baseDice?.count) || 1));
  const sides = Math.max(1, Math.floor(Number(baseDice?.sides) || 1));
  const baseBonus = Math.floor(Number(baseDice?.bonus) || 0);
  const defaults = equipmentGenerationData.defaults || {};
  const levelBonusRate = kind === "armor"
    ? Number(defaults.levelArmorBonus ?? 0.55)
    : Number(defaults.levelDamageBonus ?? 0.65);
  const levelBonus = Math.max(0, itemLevel - 1) * levelBonusRate;
  const baseAverage = getDiceAverage({ count, sides });
  const materialBonus = baseAverage * ((Number(material?.powerMult) || 1) - 1);
  const rarityBonus = baseAverage * ((Number(rarity?.statMult) || 1) - 1);
  const bonus = Math.round(baseBonus + levelBonus + materialBonus + rarityBonus);
  const dice = { count, sides, bonus };
  const average = getDiceAverage(dice);
  return {
    ...dice,
    text: formatDice(dice),
    min: Math.max(1, count + bonus),
    max: Math.max(1, count * sides + bonus),
    average: Number(average.toFixed(1)),
  };
}

function materialById(id) {
  return (equipmentGenerationData.materials || []).find(material => material.id === id) || null;
}

function rarityFromOption(rarity = "normal") {
  const id = typeof rarity === "string" ? rarity : rarity?.id || "normal";
  return GENERATED_EQUIPMENT_RARITIES[id] || GENERATED_EQUIPMENT_RARITIES.normal;
}

function getBaseList() {
  return [
    ...(equipmentGenerationData.weaponBases || []),
    ...(equipmentGenerationData.armorBases || []),
  ];
}

function matchesAny(value, allowed) {
  return !allowed.length || allowed.includes(value);
}

function matchesTags(base, tags = []) {
  if (!tags.length) return true;
  const baseTags = new Set(base.tags || []);
  return tags.some(tag => baseTags.has(tag));
}

function isArmorSlot(slot) {
  return ["helmet", "chest", "legs", "boots", "gloves", "offhand"].includes(slot);
}

function matchesBase(base, options = {}) {
  const slots = unique([...asArray(options.slot), ...asArray(options.slots)]);
  const baseIds = asArray(options.baseId || options.baseIds);
  const families = asArray(options.family || options.families);
  const weaponTypes = asArray(options.weaponType || options.weaponTypes);
  const armorTypes = asArray(options.armorType || options.armorTypes);
  const tags = asArray(options.tag || options.tags);
  if (options.kind === "weapon" && base.slot !== "weapon") return false;
  if (options.kind === "armor" && !isArmorSlot(base.slot)) return false;
  if (slots.length && !slots.includes(base.slot) && !(slots.includes("armor") && isArmorSlot(base.slot))) return false;
  if (!matchesAny(base.id, baseIds)) return false;
  if (!matchesAny(base.family, families)) return false;
  if (!matchesAny(base.weaponType, weaponTypes)) return false;
  if (!matchesAny(base.armorType, armorTypes)) return false;
  if (!matchesTags(base, tags)) return false;
  return true;
}

export function getGeneratedEquipmentBases(options = {}) {
  return getBaseList().filter(base => matchesBase(base, options));
}

function rollMaterial(base, itemLevel, options = {}, rng = Math.random) {
  const allowedMaterialIds = asArray(options.materialId || options.materialIds || options.materials);
  const basePool = asArray(base.materialPool);
  const materials = (equipmentGenerationData.materials || [])
    .filter(material => basePool.includes(material.id))
    .filter(material => !allowedMaterialIds.length || allowedMaterialIds.includes(material.id))
    .filter(material => (material.itemLevelMin || 1) <= itemLevel);
  if (materials.length) return weightedPickByWeight(materials, rng);
  const fallbackId = allowedMaterialIds.find(id => basePool.includes(id)) || basePool[0];
  return materialById(fallbackId) || (equipmentGenerationData.materials || [])[0] || { id: "plain", name: "", powerMult: 1, priceMult: 1 };
}

function affixIdentity(effect) {
  if (!effect?.type) return "";
  return effect.type === "stat_bonus" ? `${effect.type}:${effect.stat || ""}` : effect.type;
}

function isClothArmorBase(base) {
  return base.armorType === "cloth" || (base.tags || []).includes("cloth");
}

function isOneHandedWeaponBase(base) {
  return base.slot === "weapon"
    && Math.max(1, Math.floor(Number(base.hands) || 1)) === 1
    && !(base.tags || []).includes("ranged");
}

function canRollBlockChanceAffix(base) {
  return base.family === "shield"
    || isOneHandedWeaponBase(base)
    || base.id === "ring_of_thorns";
}

function getRarityRange(rangeMap, rarity) {
  if (!rangeMap || typeof rangeMap !== "object") return null;
  const rarityId = rarity?.id || "normal";
  const range = rangeMap[rarityId] || rangeMap.normal || rangeMap.uncommon;
  if (!Array.isArray(range) || range.length < 2) return null;
  const min = Math.ceil(Number(range[0]));
  const max = Math.floor(Number(range[1]));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return [min, max];
}

function getAffixScalingRange(definition, rarity) {
  const explicitRange = getRarityRange(definition?.rarityRanges, rarity);
  if (explicitRange) return explicitRange;
  const profileId = definition?.scalingProfile;
  if (!profileId) return null;
  return getRarityRange(equipmentGenerationData.affixScalingProfiles?.[profileId], rarity);
}

function materializeAffix(definition, rarity, rng = Math.random) {
  const effect = clone(definition);
  delete effect.weight;
  delete effect.scalesWithRarity;
  delete effect.scalingProfile;
  delete effect.rarityRanges;
  delete effect.rarityMin;
  delete effect.rarityMax;
  const scalingRange = getAffixScalingRange(definition, rarity);
  if (scalingRange && (definition?.chanceMin != null || definition?.chanceMax != null)) {
    effect.chance = rollIntRange(scalingRange[0], scalingRange[1], rng);
    delete effect.chanceMin;
    delete effect.chanceMax;
    delete effect.min;
    delete effect.max;
  } else if (scalingRange && (definition?.min != null || definition?.max != null)) {
    effect.value = rollIntRange(scalingRange[0], scalingRange[1], rng);
    delete effect.min;
    delete effect.max;
    delete effect.chanceMin;
    delete effect.chanceMax;
  } else if (effect.min != null || effect.max != null) {
    effect.value = rollIntRange(effect.min ?? effect.max, effect.max ?? effect.min, rng);
    delete effect.min;
    delete effect.max;
  }
  if (effect.chanceMin != null || effect.chanceMax != null) {
    effect.chance = rollIntRange(effect.chanceMin ?? effect.chanceMax, effect.chanceMax ?? effect.chanceMin, rng);
    delete effect.chanceMin;
    delete effect.chanceMax;
  }
  const mult = Number(rarity?.affixMult) || 1;
  if (Number.isFinite(effect.value) && !scalingRange) effect.value = Math.max(1, Math.round(effect.value * mult));
  if (effect.type === "crit_damage" && Number.isFinite(effect.value)) effect.value = Math.min(10, Math.max(5, effect.value));
  if (Number.isFinite(effect.chance)) {
    effect.chance = scalingRange
      ? Math.max(1, Math.min(100, Math.round(effect.chance)))
      : Math.max(1, Math.min(100, Math.round(effect.chance * Math.sqrt(mult))));
  }
  return effect;
}

function scaleBaseEffectValueByRarity(effect, definition, rarity) {
  if (!definition?.rarityMin && !definition?.rarityMax) return false;
  if (!Number.isFinite(effect.value)) return false;
  const rarityId = rarity?.id || "normal";
  const baseMin = Number(definition.min ?? definition.max);
  const baseMax = Number(definition.max ?? definition.min);
  const rarityMin = Number(definition.rarityMin?.[rarityId] ?? definition.rarityMin?.normal ?? definition.min ?? definition.max);
  const rarityMax = Number(definition.rarityMax?.[rarityId] ?? definition.rarityMax?.normal ?? definition.max ?? definition.min);
  if (!Number.isFinite(baseMin) || !Number.isFinite(baseMax) || !Number.isFinite(rarityMin) || !Number.isFinite(rarityMax)) return false;
  const baseSpan = Math.max(0, baseMax - baseMin);
  const rollProgress = baseSpan > 0 ? Math.max(0, Math.min(1, (effect.value - baseMin) / baseSpan)) : 1;
  effect.value = Math.max(1, Math.round(rarityMin + rollProgress * (rarityMax - rarityMin)));
  return true;
}

function materializeBaseEffect(definition, rarity, rng = Math.random) {
  const effect = materializeAffix(definition, { affixMult: 1 }, rng);
  if (scaleBaseEffectValueByRarity(effect, definition, rarity)) return effect;
  if (!definition?.scalesWithRarity) return effect;
  const mult = Number(rarity?.statMult) || 1;
  if (Number.isFinite(effect.value)) effect.value = Math.max(1, Math.round(effect.value * mult));
  if (Number.isFinite(effect.chance)) effect.chance = Math.max(1, Math.min(100, Math.round(effect.chance * Math.sqrt(mult))));
  return effect;
}

export function isGeneratedEquipmentAffixAllowedForBase(definition, base = {}, rarity = null) {
  if (!definition?.type) return false;
  if (definition.type === "counter_chance" && base.family !== "shield") return false;
  if (definition.type === "block_chance" && !canRollBlockChanceAffix(base)) return false;
  if (definition.type !== "block_chance" && BLOCK_AFFIX_TYPES.has(definition.type) && base.family !== "shield") return false;
  if (
    base.family === "armor"
    && !isClothArmorBase(base)
    && ARMOR_CASTER_AFFIX_IDENTITIES.has(affixIdentity(definition))
  ) {
    return false;
  }
  if (SPECIAL_SCALING_AFFIX_TYPES.has(definition.type)) {
    const tags = new Set(base.tags || []);
    const rarityId = typeof rarity === "string" ? rarity : rarity?.id;
    return SPECIAL_SCALING_AFFIX_RARITIES.has(rarityId)
      || tags.has("artifact")
      || tags.has("unique")
      || tags.has("special");
  }
  return true;
}

function rollAffixes(base, material, rarity, rng = Math.random) {
  const slots = Math.max(0, Number(rarity?.affixSlots) || 0);
  if (!slots) return [];
  const poolIds = unique([...(base.affixPools || []), ...(material?.extraAffixPools || [])]);
  const definitions = poolIds.flatMap(id => equipmentGenerationData.affixPools?.[id] || []);
  const result = [];
  const used = new Set((base.effects || []).map(affixIdentity));
  while (result.length < slots) {
    const candidates = definitions.filter(definition =>
      isGeneratedEquipmentAffixAllowedForBase(definition, base, rarity)
      && !used.has(affixIdentity(definition))
    );
    if (!candidates.length) break;
    const picked = materializeAffix(weightedPickByWeight(candidates, rng), rarity, rng);
    result.push(picked);
    used.add(affixIdentity(picked));
  }
  return result;
}

export function rollEquipmentAffixes(base, rarity, rng = Math.random) {
  return rollAffixes(base, null, rarityFromOption(rarity), rng);
}

export function rollReplacementEquipmentAffix({ baseId, materialId = null, rarity = "normal", usedEffects = [], disallowedTypes = [] } = {}, rng = Math.random) {
  const base = getGeneratedEquipmentBases({ baseId })[0];
  if (!base) return null;
  const material = materialId ? materialById(materialId) : null;
  const rarityDef = rarityFromOption(rarity);
  const disallowed = new Set(disallowedTypes || []);
  const poolIds = unique([...(base.affixPools || []), ...(material?.extraAffixPools || [])]);
  const definitions = poolIds.flatMap(id => equipmentGenerationData.affixPools?.[id] || []);
  const used = new Set([...(base.effects || []), ...(usedEffects || [])].map(affixIdentity));
  const candidates = definitions.filter(definition =>
    isGeneratedEquipmentAffixAllowedForBase(definition, base, rarityDef)
    && !used.has(affixIdentity(definition))
    && !disallowed.has(definition.type)
  );
  return candidates.length ? materializeAffix(weightedPickByWeight(candidates, rng), rarityDef, rng) : null;
}

function createGeneratedUid(base, material, rarity, rng = Math.random) {
  const suffix = Math.floor(rng() * 0xffffff).toString(36).padStart(4, "0");
  return `gen_${base.id}_${material.id}_${rarity.id}_${Date.now()}_${suffix}`;
}

export function rollGeneratedEquipment(options = {}, rng = Math.random) {
  const itemLevel = Math.max(1, Math.floor(Number(options.itemLevel) || 1));
  const bases = getGeneratedEquipmentBases(options);
  const base = options.base
    || (options.baseId ? bases.find(entry => entry.id === options.baseId) : null)
    || weightedPickByWeight(bases, rng);
  if (!base) return null;
  const rarity = rarityFromOption(options.rarity);
  const material = rollMaterial(base, itemLevel, options, rng);
  const isWeapon = base.slot === "weapon";
  const diceKey = isWeapon ? "damageDice" : "armorDice";
  const baseStats = clone(base.baseStats || {});
  const hasDice = !!base[diceKey];
  const dice = hasDice ? materializeDice(base[diceKey], itemLevel, material, rarity, isWeapon ? "weapon" : "armor") : null;
  if (isWeapon) baseStats.damage = Math.max(1, Math.round(dice.average));
  else if (dice) baseStats.armor = Math.max(1, Math.round(dice.average));
  const effects = [
    ...(base.effects || []).map(effect => materializeBaseEffect(effect, rarity, rng)),
    ...rollAffixes(base, material, rarity, rng),
  ];
  const rarityLabel = rarity.label ? `${rarity.label} ` : "";
  const materialName = material.name ? `${material.name} ` : "";
  const name = `${rarityLabel}${materialName}${base.name}`.replace(/\s+/g, " ").trim();
  const basePrice = Number(base.price || 25);
  const pricePerLevel = Number(equipmentGenerationData.defaults?.pricePerLevel ?? 12);
  const price = Math.max(1, Math.round((basePrice + itemLevel * pricePerLevel) * (material.priceMult || 1) * rarity.priceMult));
  const id = `generated_${base.id}`;
  return {
    id,
    uid: createGeneratedUid(base, material, rarity, rng),
    baseId: id,
    generated: true,
    generation: {
      system: "dice_v1",
      baseId: base.id,
      materialId: material.id,
      itemLevel,
    },
    name,
    type: "gear",
    slot: base.slot,
    family: base.family,
    armorType: base.armorType,
    weaponType: base.weaponType,
    hands: base.hands,
    attackSpeed: base.attackSpeed,
    size: clone(base.size || [1, 1]),
    baseStats,
    itemLevel,
    rarity: rarity.id,
    rarityColor: rarity.color,
    effects,
    tags: unique([...(base.tags || []), "generated", "dice_v1", material.id, `ilvl_${itemLevel}`]),
    price,
    icon: base.icon,
    ...(dice ? { [diceKey]: dice } : {}),
  };
}

function createStarterGeneratedItem(spec, kind, loadoutId, rng = () => 0) {
  const item = rollGeneratedEquipment({
    baseId: spec.baseId,
    materialId: spec.materialId,
    rarity: "normal",
    itemLevel: 1,
  }, rng);
  if (!item) return null;
  return {
    ...item,
    uid: `starter_${kind}_${loadoutId}_${Date.now()}_${Math.floor(rng() * 0xffffff).toString(36).padStart(4, "0")}`,
    name: spec.name || item.name,
    starter: true,
    generation: {
      ...(item.generation || {}),
      starterLoadout: loadoutId,
      starterSlot: kind,
    },
    tags: unique([...(item.tags || []), "starter"]),
    price: Math.max(1, Math.floor((item.price || 1) * 0.25)),
  };
}

export function isStarterLoadoutId(loadoutId) {
  return !!STARTER_WEAPON_SPECS[loadoutId];
}

export function createStarterEquipment(loadoutId = "sword", rng = () => 0) {
  const id = isStarterLoadoutId(loadoutId) ? loadoutId : "sword";
  return {
    weapon: createStarterGeneratedItem(STARTER_WEAPON_SPECS[id], "weapon", id, rng),
    chest: createStarterGeneratedItem(STARTER_CHEST_SPEC, "chest", id, rng),
  };
}
