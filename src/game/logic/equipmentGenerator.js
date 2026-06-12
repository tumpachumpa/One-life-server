import equipmentGenerationData from "../data/equipmentGeneration.json" with { type: "json" };

export const GENERATED_EQUIPMENT_DATA = equipmentGenerationData;

export const GENERATED_EQUIPMENT_RARITIES = {
  normal: { id: "normal", label: "", color: "#aaa", statMult: 1, priceMult: 1, affixSlots: 0, affixMult: 1 },
  uncommon: { id: "uncommon", label: "Uncommon", color: "#2ecc71", statMult: 1.06, priceMult: 1.18, affixSlots: 1, affixMult: 1 },
  rare: { id: "rare", label: "Rare", color: "#3498db", statMult: 1.12, priceMult: 1.45, affixSlots: 2, affixMult: 1 },
  epic: { id: "epic", label: "Epic", color: "#9b59b6", statMult: 1.28, priceMult: 2.2, affixSlots: 3, affixMult: 1.2 },
  legendary: { id: "legendary", label: "Legendary", color: "#f1c40f", statMult: 1.48, priceMult: 3.7, affixSlots: 4, affixMult: 1.4 },
  artifact: { id: "artifact", label: "Artifact", color: "#ff6b35", statMult: 1.7, priceMult: 6, affixSlots: 5, affixMult: 1.6 },
  unique: { id: "unique", label: "Unique", color: "#e74c3c", statMult: 1.55, priceMult: 5, affixSlots: 4, affixMult: 1.35 },
};

const BLOCK_AFFIX_TYPES = new Set(["block_chance", "block_power", "block_power_pct", "block_power_regen"]);
const ARMOR_CASTER_AFFIX_IDENTITIES = new Set(["spell_damage", "stat_bonus:int"]);
const SPECIAL_SCALING_AFFIX_RARITIES = new Set(["artifact", "unique"]);
const SPECIAL_SCALING_AFFIX_TYPES = new Set(["armor_pct", "damage_bonus_pct"]);

export const STARTER_LOADOUT_IDS = ["sword", "mace", "spear", "bow", "dagger"];

const STARTER_WEAPON_SPECS = {
  sword:  { baseId: "sword_1h",  grade: "worn", name: "Worn Sword" },
  mace:   { baseId: "mace_1h",   grade: "worn", name: "Worn Mace" },
  spear:  { baseId: "spear_2h",  grade: "worn", name: "Worn Spear" },
  bow:    { baseId: "bow",       grade: "worn", name: "Worn Bow" },
  dagger: { baseId: "dagger",    grade: "worn", name: "Worn Dagger" },
};

const STARTER_CHEST_SPEC = { baseId: "cloth_chest", grade: "worn", name: "Worn Tunic" };

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

function materializeDice(baseDice, itemLevel, grade, rarity, kind) {
  const count = Math.max(1, Math.floor(Number(baseDice?.count) || 1));
  const sides = Math.max(1, Math.floor(Number(baseDice?.sides) || 1));
  const baseBonus = Math.floor(Number(baseDice?.bonus) || 0);
  const defaults = equipmentGenerationData.defaults || {};
  const levelBonusRate = kind === "armor"
    ? Number(defaults.levelArmorBonus ?? 0.55)
    : Number(defaults.levelDamageBonus ?? 0.65);
  const levelBonus = Math.max(0, itemLevel - 1) * levelBonusRate;
  const baseAverage = getDiceAverage({ count, sides });
  const materialBonus = baseAverage * ((Number(grade?.powerMult) || 1) - 1);
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

function gradeById(id) {
  return (equipmentGenerationData.grades || []).find(g => g.id === id) || null;
}

function rollGradeMult(grade, rng = Math.random) {
  const min = Number(grade.multMin) || 1;
  const max = Number(grade.multMax) || 1;
  return Math.round((min + rng() * (max - min)) * 1000) / 1000;
}

const RARITY_GRADE_BIAS = {
  normal:    { worn: 1.0, normal: 1.0, excellent: 1.0, masterpiece: 1.0 },
  uncommon:  { worn: 0.7, normal: 1.0, excellent: 1.4, masterpiece: 2.0 },
  rare:      { worn: 0.5, normal: 1.0, excellent: 1.8, masterpiece: 2.5 },
  epic:      { worn: 0.3, normal: 0.8, excellent: 2.2, masterpiece: 3.5 },
  legendary: { worn: 0.1, normal: 0.6, excellent: 2.8, masterpiece: 5.0 },
  artifact:  { worn: 0.0, normal: 0.4, excellent: 3.0, masterpiece: 6.0 },
  unique:    { worn: 0.1, normal: 0.6, excellent: 2.8, masterpiece: 5.0 },
};

function rollGrade(options = {}, rng = Math.random) {
  const grades = equipmentGenerationData.grades || [];
  const forced = options.grade ? gradeById(options.grade) : null;
  if (forced) return { ...forced, powerMult: rollGradeMult(forced, rng) };
  const rarityId = typeof options.rarity === "string" ? options.rarity : (options.rarity?.id || "normal");
  const bias = RARITY_GRADE_BIAS[rarityId] || RARITY_GRADE_BIAS.normal;
  const biasedGrades = grades.map(g => ({ ...g, weight: (g.weight || 1) * (bias[g.id] ?? 1) }));
  const picked = weightedPickByWeight(biasedGrades, rng) || { id: "normal", label: "", multMin: 1, multMax: 1.12, priceMult: 1 };
  return { ...picked, powerMult: rollGradeMult(picked, rng) };
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

function scaleBaseEffectValueByRarity(effect, definition, rarity, rng = Math.random) {
  if (!definition?.rarityMin && !definition?.rarityMax) return false;
  const rarityId = rarity?.id || "normal";
  const rarityMin = Number(definition.rarityMin?.[rarityId] ?? definition.rarityMin?.normal ?? definition.min ?? definition.max ?? 0);
  const rarityMax = Number(definition.rarityMax?.[rarityId] ?? definition.rarityMax?.normal ?? definition.max ?? definition.min ?? rarityMin);
  if (!Number.isFinite(rarityMin) || !Number.isFinite(rarityMax)) return false;
  if (!Number.isFinite(effect.value)) {
    // No base value rolled — effect uses only rarity range; pick within it directly.
    effect.value = Math.round(rarityMin + rng() * (rarityMax - rarityMin));
    return true;
  }
  const baseMin = Number(definition.min ?? definition.max);
  const baseMax = Number(definition.max ?? definition.min);
  if (!Number.isFinite(baseMin) || !Number.isFinite(baseMax)) return false;
  const baseSpan = Math.max(0, baseMax - baseMin);
  const rollProgress = baseSpan > 0 ? Math.max(0, Math.min(1, (effect.value - baseMin) / baseSpan)) : 1;
  effect.value = Math.max(1, Math.round(rarityMin + rollProgress * (rarityMax - rarityMin)));
  return true;
}

function materializeBaseEffect(definition, rarity, rng = Math.random) {
  const effect = materializeAffix(definition, { affixMult: 1 }, rng);
  effect._base = true;
  if (scaleBaseEffectValueByRarity(effect, definition, rarity, rng)) return effect;
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

function rollAffixes(base, rarity, rng = Math.random) {
  const raritySlots = Math.max(0, Number(rarity?.affixSlots ?? rarity?.effectSlots) || 0);
  const guaranteed = Math.max(0, Number(base.guaranteedAffixes) || 0);
  const rawSlots = Math.max(raritySlots, guaranteed);
  const slots = base.maxAffixes != null ? Math.min(rawSlots, base.maxAffixes) : rawSlots;
  if (!slots) return [];
  const poolIds = unique([...(base.affixPools || [])]);
  const definitions = poolIds.flatMap(id => equipmentGenerationData.affixPools?.[id] || []);
  const result = [];
  const used = new Set((base.effects || []).map(affixIdentity));
  const blocked = new Set(base.blockedAffixTypes || []);
  while (result.length < slots) {
    const candidates = definitions.filter(definition =>
      isGeneratedEquipmentAffixAllowedForBase(definition, base, rarity)
      && !used.has(affixIdentity(definition))
      && !blocked.has(definition.type)
    );
    if (!candidates.length) break;
    const picked = materializeAffix(weightedPickByWeight(candidates, rng), rarity, rng);
    result.push(picked);
    used.add(affixIdentity(picked));
  }
  return result;
}

export function rollEquipmentAffixes(base, rarity, rng = Math.random) {
  return rollAffixes(base, rarityFromOption(rarity), rng);
}

export function rollReplacementEquipmentAffix({ baseId, rarity = "normal", usedEffects = [], disallowedTypes = [] } = {}, rng = Math.random) {
  const base = getGeneratedEquipmentBases({ baseId })[0];
  if (!base) return null;
  const rarityDef = rarityFromOption(rarity);
  const disallowed = new Set(disallowedTypes || []);
  const poolIds = unique([...(base.affixPools || [])]);
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
  const grade = rollGrade(options, rng);
  const isWeapon = base.slot === "weapon";
  const diceKey = isWeapon ? "damageDice" : "armorDice";
  const baseStats = clone(base.baseStats || {});
  const hasDice = !!base[diceKey];
  const dice = hasDice ? materializeDice(base[diceKey], itemLevel, grade, rarity, isWeapon ? "weapon" : "armor") : null;
  if (isWeapon) baseStats.damage = Math.max(1, Math.round(dice.average));
  else if (dice) baseStats.armor = Math.max(1, Math.round(dice.average));
  const effects = [
    ...(base.effects || []).map(effect => materializeBaseEffect(effect, rarity, rng)),
    ...rollAffixes(base, rarity, rng),
  ];
  const rarityLabel = rarity.label ? `${rarity.label} ` : "";
  const gradeLabel = grade.label ? `${grade.label} ` : "";
  const name = `${rarityLabel}${gradeLabel}${base.name}`.replace(/\s+/g, " ").trim();
  const basePrice = Number(base.price || 25);
  const pricePerLevel = Number(equipmentGenerationData.defaults?.pricePerLevel ?? 12);
  const price = Math.max(1, Math.round((basePrice + itemLevel * pricePerLevel) * (grade.priceMult || 1) * rarity.priceMult));
  const id = `generated_${base.id}`;
  return {
    id,
    uid: createGeneratedUid(base, grade, rarity, rng),
    baseId: id,
    generated: true,
    generation: {
      system: "dice_v1",
      baseId: base.id,
      gradeId: grade.id,
      gradeMult: grade.powerMult,
      itemLevel,
      ...(options.materialId != null ? { materialId: options.materialId } : {}),
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
    grade: grade.id,
    gradeColor: grade.color || null,
    effects,
    tags: unique([...(base.tags || []), "generated", "dice_v1", grade.id, `ilvl_${itemLevel}`]),
    price,
    icon: base.icon,
    ...(base.iconScale != null ? { iconScale: base.iconScale } : {}),
    ...(dice ? { [diceKey]: dice } : {}),
  };
}

function createStarterGeneratedItem(spec, kind, loadoutId, rng = () => 0) {
  const item = rollGeneratedEquipment({
    baseId: spec.baseId,
    grade: spec.grade || "worn",
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
