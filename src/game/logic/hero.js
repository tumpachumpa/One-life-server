import { CAMPFIRE_CARRY_BASE, DMG_CAP, EQUIP_SLOTS, INV_BASE } from "../constants.js";
import { getItem, getPet, heroClasses } from "./content.js";
import { createStarterEquipment, isStarterLoadoutId } from "./equipmentGenerator.js";
import { collectEffects, effectsOfType, isQuiverInactiveForHero, sumEffect } from "./effectEngine.js";
import { DEEP_CUT_MAX_HP_PENALTY_PCT, GORE_MAX_HP_PENALTY_PCT, INFECTION_ATTACK_SPEED_MULT, INFECTION_HIT_CHANCE_PENALTY, getSurvivalStatModifiers, normalizeConditions } from "./survival.js";
import { getActiveRelics, applyRelicStatBonuses } from "./relics.js";

export const COMBAT_SKILL_SLOTS = 6;
export const DEFAULT_COMBAT_SKILL_IDS = Array(COMBAT_SKILL_SLOTS).fill(null);
export const DEFAULT_ULTIMATE_ID = "bankai_senbonzakura";
export const DEFAULT_HERO_CLASS_ID = "fighter";

export const BASE_HERO = {
  str: 10,
  dex: 8,
  int: 6,
  maxHp: 100,
  armor: 0,
  damage: 0,
  hitChance: 85,
  critChance: 5,
  critDamage: 75,
  doubleHit: 0,
  dodgeChance: 0,
  lifesteal: 0,
  spellDamage: 0,
  blockChance: 0,
  blockPower: 0,
  blockPowerRegen: 0,
};

export const STR_DAMAGE_SCALE = 0.65;
export const DEX_DAMAGE_SCALE = 0.08;
export const RANGED_DEX_DAMAGE_SCALE = 0.65;
export const RANGED_STR_DAMAGE_SCALE = 0.08;
export const ATTRIBUTE_UPGRADES = {
  str: 1,
  dex: 1,
  int: 1,
  maxHp: 5,
};
export const ATTRIBUTE_STAT_KEYS = Object.keys(ATTRIBUTE_UPGRADES);

export const HUNGER_LEVELS = [
  { name: "Starving", icon: "red", dmgMult: 0.9, xpMult: 0.9, threshold: 0 },
  { name: "Hungry", icon: "yellow", dmgMult: 1.0, xpMult: 1.0, threshold: 25 },
  { name: "Fed", icon: "green", dmgMult: 1.0, xpMult: 1.05, threshold: 50 },
  { name: "Well Fed", icon: "gold", dmgMult: 1.05, xpMult: 1.15, threshold: 75 },
];

export function getHungerLevel(hunger) {
  for (let i = HUNGER_LEVELS.length - 1; i >= 0; i--) {
    if (hunger >= HUNGER_LEVELS[i].threshold) return HUNGER_LEVELS[i];
  }
  return HUNGER_LEVELS[0];
}

export function getDmgReduction(armor) {
  return Math.min(DMG_CAP, armor / (armor + 100));
}

export function applyArmor(damage, armor, ignorePct = 0) {
  const effectiveArmor = armor * (1 - (ignorePct || 0) / 100);
  return Math.max(1, Math.round(damage * (1 - getDmgReduction(effectiveArmor))));
}

export function isRangedWeapon(weaponOrStats = {}) {
  const tags = new Set([...(weaponOrStats.tags || []), ...(weaponOrStats.weaponTags || [])]);
  return weaponOrStats.attackType === "ranged"
    || weaponOrStats.family === "ranged"
    || weaponOrStats.weaponFamily === "ranged"
    || tags.has("ranged");
}

export function getWeaponAttackType(weaponOrStats = {}) {
  return isRangedWeapon(weaponOrStats) ? "ranged" : "melee";
}

export function getHeroRawDamageBase(stats = {}, weapon = null) {
  const ranged = isRangedWeapon(weapon || stats);
  const strScale = ranged ? RANGED_STR_DAMAGE_SCALE : STR_DAMAGE_SCALE;
  const dexScale = ranged ? RANGED_DEX_DAMAGE_SCALE : DEX_DAMAGE_SCALE;
  return (stats.str || 0) * strScale + (stats.dex || 0) * dexScale + (stats.damage || 0);
}

export const MAX_HERO_LEVEL = 30;

export function xpToLevel(xp) {
  let lvl = 1;
  let needed = 100;
  let rest = xp;
  while (rest >= needed) {
    rest -= needed;
    lvl++;
    needed = Math.floor(needed * 1.45);
  }
  return { lvl, xp: rest, needed };
}

// Rarity IDs match ENEMY_RARITIES keys (normal / raro / epico / legendario).
// Each tier's "center level" = tier * 5 - 2 (tier 1 ≈ 3, tier 2 ≈ 8, tier 3 ≈ 13 …).
// Rarer enemies have higher effective levels so they stay relevant longer.
// Energy is a minor factor: being well-rested (≥75) gives 1 level of grace.
// Extra XP for killing rare/epic/legendary enemies (stacks on top of overlevel mult).
export function getRarityXpMult(rarityId) {
  const RARITY_XP = { normal: 1.0, raro: 1.5, epico: 2.5, legendario: 4.0 };
  return RARITY_XP[rarityId] ?? 1.0;
}

export function getOverlevelXpMult(heroLevel, enemyTier, rarityId, heroEnergy) {
  const RARITY_BONUS = { normal: 0, raro: 3, epico: 7, legendario: 12 };
  const rarityBonus = RARITY_BONUS[rarityId] ?? 0;
  const energyGrace = (heroEnergy || 0) >= 75 ? 1 : 0;
  const enemyEffectiveLevel = (enemyTier || 1) * 5 - 2 + rarityBonus + energyGrace;
  const levelGap = Math.max(0, heroLevel - enemyEffectiveLevel);
  if (levelGap === 0) return 1.0;
  return Math.max(0.5, 1.0 - levelGap * 0.05);
}

export function getHeroClassDefinition(classId) {
  return heroClasses.find(entry => entry.id === classId)
    || heroClasses.find(entry => entry.id === DEFAULT_HERO_CLASS_ID)
    || heroClasses[0]
    || null;
}

export function getClassBaseStats(classId) {
  return normalizeBaseStats({
    ...BASE_HERO,
    ...(getHeroClassDefinition(classId)?.baseStats || {}),
  });
}

export function getLevelRewards(prevXp, nextXp) {
  const before = xpToLevel(prevXp);
  const after = xpToLevel(nextXp);
  const levelsGained = Math.max(0, after.lvl - before.lvl);
  // Talent points stop at the level cap; stat/attribute points continue indefinitely.
  const cappedBefore = Math.min(before.lvl, MAX_HERO_LEVEL);
  const cappedAfter = Math.min(after.lvl, MAX_HERO_LEVEL);
  const talentLevelsGained = Math.max(0, cappedAfter - cappedBefore);
  return {
    before,
    after,
    levelsGained,
    talentPoints: talentLevelsGained,
    statPoints: levelsGained,
  };
}

function cleanAttributeAllocations(allocations = {}) {
  const clean = {};
  for (const key of ATTRIBUTE_STAT_KEYS) {
    const value = Math.max(0, Math.floor(Number(allocations?.[key] || 0)));
    if (value > 0) clean[key] = value;
  }
  return clean;
}

function sameAttributeAllocations(a = {}, b = {}) {
  const relevantKeys = Object.keys(a || {}).filter(key => ATTRIBUTE_STAT_KEYS.includes(key) || Math.floor(Number(a[key] || 0)) !== 0);
  return relevantKeys.length === Object.keys(b || {}).length
    && ATTRIBUTE_STAT_KEYS.every(key => Math.floor(a?.[key] || 0) === Math.floor(b?.[key] || 0));
}

function getLevelMaxHpBonus(hero = {}) {
  return Math.max(0, Math.min(xpToLevel(hero?.xp || 0).lvl, MAX_HERO_LEVEL) - 1) * 5;
}

function getBaseStatsBeforeAttributePoints(hero = {}) {
  const base = getClassBaseStats(hero?.heroClass);
  return {
    ...base,
    maxHp: (base.maxHp || 0) + getLevelMaxHpBonus(hero),
  };
}

function getStatPointSpendBudget(hero = {}) {
  const earned = Math.max(0, xpToLevel(hero?.xp || 0).lvl - 1);
  const unspent = Math.max(0, Math.floor(Number(hero?.statPoints || 0)));
  return Math.max(0, earned - unspent);
}

function inferAttributeAllocations(hero = {}) {
  const budget = getStatPointSpendBudget(hero);
  if (budget <= 0) return {};
  const baseStats = normalizeBaseStats(hero?.baseStats || {});
  const beforeAttributes = getBaseStatsBeforeAttributePoints(hero);
  const inferred = {};
  for (const key of ATTRIBUTE_STAT_KEYS) {
    const amount = ATTRIBUTE_UPGRADES[key];
    const delta = Math.max(0, Math.floor((baseStats[key] || 0) - (beforeAttributes[key] || 0)));
    const points = key === "maxHp" ? Math.floor(delta / amount) : delta;
    if (points > 0) inferred[key] = points;
  }
  const inferredTotal = getAttributeAllocationTotal(inferred);
  if (inferredTotal <= budget) return inferred;
  let remaining = budget;
  const capped = {};
  for (const key of ATTRIBUTE_STAT_KEYS) {
    const points = Math.min(inferred[key] || 0, remaining);
    if (points > 0) capped[key] = points;
    remaining -= points;
    if (remaining <= 0) break;
  }
  return capped;
}

export function getAttributeAllocationTotal(heroOrAllocations = {}) {
  const allocations = heroOrAllocations?.baseStats
    ? cleanAttributeAllocations(heroOrAllocations.attributeAllocations || {})
    : cleanAttributeAllocations(heroOrAllocations || {});
  return ATTRIBUTE_STAT_KEYS.reduce((total, key) => total + (allocations[key] || 0), 0);
}

export function normalizeHeroAttributeAllocations(hero) {
  if (!hero) return hero;
  const hasSavedAllocations = Object.prototype.hasOwnProperty.call(hero, "attributeAllocations");
  const allocations = hasSavedAllocations
    ? cleanAttributeAllocations(hero.attributeAllocations)
    : inferAttributeAllocations(hero);
  const hasAllocations = getAttributeAllocationTotal(allocations) > 0;
  if (!hasAllocations) {
    if (!hasSavedAllocations) return hero;
    const { attributeAllocations: _attributeAllocations, ...withoutAllocations } = hero;
    return withoutAllocations;
  }
  if (hasSavedAllocations && sameAttributeAllocations(hero.attributeAllocations, allocations)) return hero;
  return { ...hero, attributeAllocations: allocations };
}

export function spendAttributePoint(hero, key) {
  if (!ATTRIBUTE_UPGRADES[key]) return hero;
  const normalized = normalizeHeroAttributeAllocations(hero);
  if ((normalized?.statPoints || 0) <= 0) return normalized;
  const amount = ATTRIBUTE_UPGRADES[key];
  const allocations = cleanAttributeAllocations(normalized.attributeAllocations || {});
  const currentHp = Number(normalized.hp);
  return {
    ...normalized,
    statPoints: Math.max(0, Math.floor(normalized.statPoints || 0) - 1),
    baseStats: {
      ...(normalized.baseStats || {}),
      [key]: (normalized.baseStats?.[key] || 0) + amount,
    },
    hp: key === "maxHp" && Number.isFinite(currentHp) ? currentHp + amount : normalized.hp,
    attributeAllocations: {
      ...allocations,
      [key]: (allocations[key] || 0) + 1,
    },
  };
}

export function resetAttributeAllocations(hero) {
  const normalized = normalizeHeroAttributeAllocations(hero);
  const allocations = cleanAttributeAllocations(normalized?.attributeAllocations || {});
  const refund = getAttributeAllocationTotal(allocations);
  if (refund <= 0) return normalized;
  const beforeAttributes = getBaseStatsBeforeAttributePoints(normalized);
  const baseStats = { ...(normalized.baseStats || {}) };
  for (const key of ATTRIBUTE_STAT_KEYS) {
    const amount = (allocations[key] || 0) * ATTRIBUTE_UPGRADES[key];
    if (amount <= 0) continue;
    baseStats[key] = Math.max(beforeAttributes[key] || 0, (baseStats[key] || 0) - amount);
  }
  const { attributeAllocations: _attributeAllocations, ...withoutAllocations } = normalized;
  return clampHeroHpToStats({
    ...withoutAllocations,
    baseStats,
    statPoints: Math.max(0, Math.floor(normalized.statPoints || 0)) + refund,
  });
}

export function initHero(name = "Hero", options = {}) {
  const classDef = getHeroClassDefinition(options.heroClass || DEFAULT_HERO_CLASS_ID);
  const heroClass = classDef?.id || DEFAULT_HERO_CLASS_ID;
  const baseStats = {
    ...getClassBaseStats(heroClass),
    ...(options.baseStats || {}),
  };
  const preferredWeapon = options.weapon || classDef?.startingWeapon || "sword";
  const usesStarterLoadout = isStarterLoadoutId(preferredWeapon);
  const starterLoadoutId = usesStarterLoadout ? preferredWeapon : "sword";
  const starterEquipment = createStarterEquipment(starterLoadoutId);
  const startingWeaponId = usesStarterLoadout
    ? starterEquipment.weapon
    : getItem(preferredWeapon) ? preferredWeapon : starterEquipment.weapon;
  const startingChestId = getItem(options.chest) ? options.chest : starterEquipment.chest;
  return normalizeHeroPet({
    name,
    heroClass,
    gender: options.gender || "male",
    characterCreated: !!options.characterCreated,
    sprite: "/assets/sprites/Hero_real.png",
    baseStats,
    hp: baseStats.maxHp,
    hunger: 100,
    energy: 100,
    stamina: 100,
    conditions: normalizeConditions(),
    xp: 0,
    gold: 150,
    statPoints: 0,
    talentPoints: 0,
    talents: {},
    equip: {
      weapon: startingWeaponId,
      offhand: options.offhand ? options.offhand : null,
      helmet: null,
      chest: startingChestId,
      legs: null,
      boots: null,
      gloves: null,
      cloak: null,
      ring: null,
      ring2: null,
      amulet: null,
      bag: null,
    },
    inventory: [
      "campfire",
      "campfire",
      "ration",
      "ration",
      "ration",
    ],
    combatsWon: 0,
    activeBuffs: [],
    availableSkillIds: [],
    equippedSkillIds: [...DEFAULT_COMBAT_SKILL_IDS],
    availableUltimateIds: [DEFAULT_ULTIMATE_ID],
    equippedUltimateId: DEFAULT_ULTIMATE_ID,
    ultimateChargePct: 0,
    ultimateTestingReady: false,
  }, { fillPetHp: true });
}

function pctRatio(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.abs(raw) > 1 ? raw / 100 : raw;
}

function scalePetStat(scaling = {}, heroStats = {}, heroLevel = 1, context = {}) {
  if (typeof scaling === "number") return scaling;
  const scaled = (scaling.base || 0)
    + (scaling.perHeroLevel || 0) * heroLevel
    + (scaling.perHeroStr || 0) * (heroStats.str || 0)
    + (scaling.perHeroDex || 0) * (heroStats.dex || 0)
    + (scaling.perHeroInt || 0) * (heroStats.int || 0)
    + (scaling.perHeroDamage || 0) * (heroStats.damage || 0)
    + pctRatio(scaling.heroMaxHpPct) * (heroStats.maxHp || 0)
    + pctRatio(scaling.heroDamagePct) * (context.heroDamage || 0)
    + pctRatio(scaling.heroArmorPct) * (heroStats.armor || 0)
    + pctRatio(scaling.heroCritChancePct) * (heroStats.critChance || 0);
  const min = scaling.min ?? null;
  const max = scaling.max ?? null;
  return Math.max(min ?? -Infinity, Math.min(max ?? Infinity, scaled));
}

export function getHeroPetDefinition(hero) {
  const classDef = heroClasses.find(entry => entry.id === (hero?.heroClass || DEFAULT_HERO_CLASS_ID));
  return getPet(classDef?.pet || classDef?.petId || null);
}

function clampPetHunger(value = 100) {
  const raw = Math.floor(Number(value ?? 100));
  if (!Number.isFinite(raw)) return 100;
  return Math.max(0, Math.min(100, raw));
}

function clampPetHp(value, maxHp) {
  const hp = Math.floor(Number(value ?? maxHp));
  if (!Number.isFinite(hp)) return maxHp;
  return Math.max(0, Math.min(maxHp, hp));
}

export function buildPetCombatant(hero, petDef = null) {
  const resolvedPet = typeof petDef === "string" ? getPet(petDef) : petDef || getHeroPetDefinition(hero);
  if (!resolvedPet) return null;

  const heroLevel = xpToLevel(hero?.xp || 0).lvl;
  const heroStats = calcStats(hero);
  const heroEquipment = resolveEquipment(hero);
  const heroDamage = getHeroRawDamageBase(heroStats, heroEquipment.weapon);
  const heroEffects = collectEffects(hero);
  const scaling = resolvedPet.statScaling || {};
  const scalingContext = { heroDamage };
  const petMaxHpMult = 1 + sumEffect(heroEffects, "pet_max_hp_pct") / 100;
  const petDamageMult = 1 + sumEffect(heroEffects, "pet_damage_pct") / 100;
  const petArmorBonus = sumEffect(heroEffects, "pet_armor");
  const petArmorMult = 1 + sumEffect(heroEffects, "pet_armor_pct") / 100;
  const petAttackSpeedMult = 1 + sumEffect(heroEffects, "pet_attack_speed_pct") / 100;
  const petCritChanceMult = 1 + sumEffect(heroEffects, "pet_crit_chance_pct") / 100;
  const wolfLungeUpgrade = effectsOfType(heroEffects, "wolf_lunge_upgrade")[0] || null;
  const applyPetAbilityUpgrades = ability => {
    if (ability?.id !== "wolf_lunge" || !wolfLungeUpgrade) return ability;
    return {
      ...ability,
      bleedChance: Math.max(ability.bleedChance || 0, wolfLungeUpgrade.bleedChance || 0),
      bleedDuration: Math.max(ability.bleedDuration || 0, wolfLungeUpgrade.bleedDuration || 0),
      bleedDamagePct: Math.max(ability.bleedDamagePct || 0, wolfLungeUpgrade.bleedDamagePct || 0),
      heroCritChanceBonus: Math.max(ability.heroCritChanceBonus || 0, wolfLungeUpgrade.heroCritChanceBonus || 0),
      heroCritDurationTicks: Math.max(ability.heroCritDurationTicks || 0, wolfLungeUpgrade.heroCritDurationTicks || 0),
    };
  };
  const petPassiveDamageReductionPct = sumEffect(heroEffects, "pet_passive_damage_reduction_pct");
  const unlockedPetAbilities = effectsOfType(heroEffects, "pet_unlock_ability")
    .map(effect => effect.ability)
    .filter(Boolean);
  const unlockedPetEffects = effectsOfType(heroEffects, "pet_effect")
    .map(effect => effect.effect)
    .filter(Boolean);
  const maxHp = Math.max(1, Math.round(scalePetStat(scaling.hp || scaling.maxHp || 1, heroStats, heroLevel, scalingContext) * petMaxHpMult));
  const damage = Math.max(1, Math.round(scalePetStat(scaling.damage || scaling.attack || 1, heroStats, heroLevel, scalingContext) * petDamageMult));
  const armor = Math.max(0, Math.round((scalePetStat(scaling.armor || 0, heroStats, heroLevel, scalingContext) + petArmorBonus) * petArmorMult));
  const attackSpeed = Math.max(0.35, (Number(scaling.attackSpeed ?? resolvedPet.attackSpeed ?? 1) || 1) * petAttackSpeedMult);
  const critChance = Math.max(0, Math.round(scalePetStat(scaling.critChance || 0, heroStats, heroLevel, scalingContext) * petCritChanceMult));
  const savedPetState = hero?.pet?.id === resolvedPet.id ? hero.pet : null;
  const hp = clampPetHp(savedPetState?.hp, maxHp);
  const baseAbilities = (resolvedPet.abilities || []).map(applyPetAbilityUpgrades);
  const abilities = [...baseAbilities];
  for (const ability of unlockedPetAbilities) {
    const upgradedAbility = applyPetAbilityUpgrades(ability);
    if (!abilities.some(entry => entry.id === upgradedAbility.id)) abilities.push(upgradedAbility);
  }

  return {
    id: resolvedPet.id,
    name: resolvedPet.name || "Pet",
    hp,
    family: resolvedPet.family || "pet",
    sprite: resolvedPet.sprite || null,
    visual: resolvedPet.visual || null,
    combatVisual: resolvedPet.combatVisual || null,
    tags: [...(resolvedPet.tags || []), "pet"],
    effects: [
      ...(resolvedPet.effects || []),
      ...unlockedPetEffects,
      ...(petPassiveDamageReductionPct > 0 ? [{ type: "damage_taken_reduction_pct", value: petPassiveDamageReductionPct, source: "guardian_bond" }] : []),
    ],
    abilities,
    isAlly: true,
    team: "player",
    stats: {
      maxHp,
      attack: damage,
      armor,
      attackSpeed,
      critChance,
      attackType: resolvedPet.attackType || "melee",
      weaponTags: resolvedPet.weaponTags || ["melee"],
    },
  };
}

export function normalizeHeroPet(hero, opts = {}) {
  if (!hero) return hero;
  const petDef = getHeroPetDefinition(hero);
  if (!petDef) {
    const { pet: _legacyPet, ...heroWithoutPet } = hero;
    return heroWithoutPet;
  }
  const petStatsCombatant = buildPetCombatant({ ...hero, pet: null }, petDef);
  const maxHp = Math.max(1, petStatsCombatant?.stats?.maxHp || 1);
  const previous = hero.pet?.id === petDef.id ? hero.pet : null;
  const hp = opts.fillPetHp || previous?.hp == null
    ? maxHp
    : clampPetHp(previous.hp, maxHp);
  return {
    ...hero,
    pet: {
      ...(previous || {}),
      id: petDef.id,
      hp,
    },
  };
}

export function setHeroPetHp(hero, hp) {
  const normalized = normalizeHeroPet(hero);
  if (!normalized?.pet) return normalized;
  return normalizeHeroPet({
    ...normalized,
    pet: {
      ...normalized.pet,
      hp,
    },
  });
}

export function healHeroPet(hero, amount = 0) {
  const normalized = normalizeHeroPet(hero);
  if (!normalized?.pet) return normalized;
  const combatant = buildPetCombatant(normalized);
  const maxHp = Math.max(1, combatant?.stats?.maxHp || 1);
  const healedHp = clampPetHp((combatant?.hp ?? normalized.pet.hp ?? maxHp) + Math.max(0, Math.round(amount || 0)), maxHp);
  return {
    ...normalized,
    pet: {
      ...normalized.pet,
      hp: healedHp,
    },
  };
}

export function healHeroPetByPct(hero, pctValue = 0) {
  const normalized = normalizeHeroPet(hero);
  if (!normalized?.pet) return normalized;
  const combatant = buildPetCombatant(normalized);
  const maxHp = Math.max(1, combatant?.stats?.maxHp || 1);
  return healHeroPet(normalized, Math.round(maxHp * Math.max(0, pctValue) / 100));
}

export function feedHeroPet(hero, hungerValue = 0) {
  const normalized = normalizeHeroPet(hero);
  if (!normalized?.pet) return normalized;
  return {
    ...normalized,
    pet: {
      ...normalized.pet,
      hunger: clampPetHunger((normalized.pet.hunger ?? 100) + Math.max(0, Math.round(hungerValue || 0))),
    },
  };
}

export function reduceHeroPetHunger(hero, hungerValue = 0) {
  const normalized = normalizeHeroPet(hero);
  if (!normalized?.pet) return normalized;
  return {
    ...normalized,
    pet: {
      ...normalized.pet,
      hunger: clampPetHunger((normalized.pet.hunger ?? 100) - Math.max(0, Math.round(hungerValue || 0))),
    },
  };
}

export function getHeroPetStatus(hero) {
  const normalized = normalizeHeroPet(hero);
  const combatant = buildPetCombatant(normalized);
  if (!combatant || !normalized?.pet) return null;
  return {
    id: combatant.id,
    name: combatant.name,
    sprite: combatant.sprite,
    hp: combatant.hp,
    maxHp: combatant.stats.maxHp,
    stats: combatant.stats,
  };
}

export function resolveEquipment(hero) {
  return Object.fromEntries(
    EQUIP_SLOTS.map(slot => [slot, hero.equip?.[slot] ? getItem(hero.equip[slot]) : null])
  );
}

export function normalizeBaseStats(baseStats = {}) {
  const stats = { ...BASE_HERO, ...(baseStats || {}) };
  if (stats.agi && !stats.dex) stats.dex = stats.agi;
  delete stats.agi;
  delete stats.initiative;
  if (stats.int == null) stats.int = 6;
  return stats;
}

export function calcStats(hero) {
  const stats = normalizeBaseStats(hero?.baseStats || {});
  const equipment = resolveEquipment(hero);
  const effects = collectEffects(hero);
  const canDualWield = sumEffect(effects, "dual_wield") > 0;
  const survival = getSurvivalStatModifiers(hero);
  const hasWeapon = !!equipment.weapon;
  const hasShield = equipment.offhand?.family === "shield";

  for (const effect of effectsOfType(effects, "stat_bonus")) {
    const stat = effect.stat === "agi" ? "dex" : effect.stat;
    if (!stat) continue;
    stats[stat] = (stats[stat] || 0) + (effect.value || 0);
  }

  for (const [slot, item] of Object.entries(equipment)) {
    if (!item) continue;
    if (slot === "offhand" && item.slot === "weapon" && !canDualWield) continue;
    if (isQuiverInactiveForHero(hero, slot, item)) continue;
    for (const [key, value] of Object.entries(item.baseStats || {})) {
      const statKey = key === "agi" ? "dex" : key;
      const statValue = slot === "offhand" && item.slot === "weapon" && canDualWield && statKey === "damage"
        ? Math.floor(value * 0.5)
        : value;
      stats[statKey] = (stats[statKey] || 0) + statValue;
    }
  }
  stats.maxHp = (stats.maxHp || 0) + sumEffect(effects, "max_hp");
  const maxHpPctBonus = sumEffect(effects, "max_hp_pct");
  if (maxHpPctBonus) stats.maxHp = Math.max(1, Math.round(stats.maxHp * (1 + maxHpPctBonus / 100)));
  stats.armor = Math.max(0, Math.floor(((stats.armor || 0) + sumEffect(effects, "armor")) * (1 + sumEffect(effects, "armor_pct") / 100)));

  stats.fistDamage = Math.max(0, sumEffect(effects, "fist_damage"));
  if (!hasWeapon) stats.damage = (stats.damage || 0) + 1 + stats.fistDamage;
  stats.weaponFamily = equipment.weapon?.family || null;
  stats.weaponTags = [...(equipment.weapon?.tags || [])];
  stats.weaponType = equipment.weapon?.weaponType || null;
  stats.weaponAttackSpeed = equipment.weapon?.attackSpeed || equipment.weapon?.baseStats?.attackSpeed || 1;
  stats.weaponAttackSpeed *= 1 + ((sumEffect(effects, "attack_speed_pct") + sumEffect(effects, "attack_speed")) / 100);

  stats.str = Math.max(1, stats.str + survival.str);
  stats.hitChance = Math.min(98, stats.hitChance + Math.floor(stats.dex / 5) + sumEffect(effects, "hit_chance") + survival.hitChance);
  stats.critChance = Math.min(60, stats.critChance + Math.floor(stats.dex / 3) + sumEffect(effects, "crit_chance"));
  stats.critDamage = Math.max(75, stats.critDamage + sumEffect(effects, "crit_damage"));
  stats.doubleHit = Math.min(40, stats.doubleHit + sumEffect(effects, "double_hit"));
  stats.dodgeChance = Math.min(60, (stats.dodgeChance || 0) + sumEffect(effects, "dodge_chance"));
  stats.lifesteal = stats.lifesteal + sumEffect(effects, "lifesteal");
  stats.spellDamage = (stats.spellDamage || 0) + sumEffect(effects, "spell_damage");
  stats.blockChance = hasShield
    ? Math.max(0, Math.min(100, (stats.blockChance || 0) + sumEffect(effects, "block_chance")))
    : 0;
  if (hasShield) {
    const flatBlockPower = Math.max(0, Math.floor((stats.blockPower || 0) + sumEffect(effects, "block_power")));
    const blockPowerPct = sumEffect(effects, "block_power_pct");
    stats.blockPower = Math.max(0, Math.floor(flatBlockPower * (1 + blockPowerPct / 100)));
  } else {
    stats.blockPower = 0;
  }
  stats.blockPowerRegen = hasShield
    ? Math.max(0, Math.floor((stats.blockPowerRegen || 0) + sumEffect(effects, "block_power_regen")))
    : 0;
  stats.attackSpeedMult = survival.attackSpeedMult;
  stats.damageMult = survival.damageMult || 1;
  stats.canFight = survival.canFight;
  stats.maxHp = Math.max(1, Math.round(stats.maxHp * (survival.maxHpMult || 1)));
  const conditions = normalizeConditions(hero?.conditions);
  const deepCutStacks = conditions.deepCut?.stacks || 0;
  if (deepCutStacks > 0) {
    stats.maxHp = Math.max(1, Math.round(stats.maxHp * Math.max(0.1, 1 - deepCutStacks * (DEEP_CUT_MAX_HP_PENALTY_PCT / 100))));
  }
  const goreStacks = conditions.wretchedGore?.stacks || 0;
  if (goreStacks > 0) {
    stats.maxHp = Math.max(1, Math.round(stats.maxHp * Math.max(0.1, 1 - goreStacks * (GORE_MAX_HP_PENALTY_PCT / 100))));
  }
  const infectionStacks = conditions.infection?.stacks || 0;
  if (infectionStacks > 0) {
    stats.hitChance -= infectionStacks * INFECTION_HIT_CHANCE_PENALTY;
    stats.attackSpeedMult *= Math.pow(INFECTION_ATTACK_SPEED_MULT, infectionStacks);
  }
  const bagInventorySlotBonus = sumEffect(equipment.bag?.effects || [], "inventory_slots");
  const bagCampfireCarryBonus = sumEffect(equipment.bag?.effects || [], "campfire_carry_limit");
  const baseBag = equipment.bag ? getItem(equipment.bag.baseId || equipment.bag.id) : null;
  const legacyBagCampfireCarryBonus = equipment.bag && bagCampfireCarryBonus === 0
    ? sumEffect(baseBag?.effects || [], "campfire_carry_limit")
    : 0;
  stats.inventorySlots = INV_BASE + sumEffect(effects, "inventory_slots") - bagInventorySlotBonus;
  stats.inventorySlots += Math.max(0, Math.floor(Number(hero?.devInventorySlotBonus || 0)));
  stats.campfireCarryLimit = Math.max(0, CAMPFIRE_CARRY_BASE + sumEffect(effects, "campfire_carry_limit") + legacyBagCampfireCarryBonus);
  stats.magicDefense = Math.floor(stats.int / 2) + sumEffect(effects, "magic_defense");
  stats.critResist = Math.min(50, Math.floor(stats.int / 5) + sumEffect(effects, "crit_resist"));
  const allElementalResist = sumEffect(effects, "all_elemental_resist");
  stats.fireResist = (stats.fireResist || 0) + sumEffect(effects, "fire_resist") + allElementalResist;
  stats.coldResist = (stats.coldResist || 0) + sumEffect(effects, "cold_resist") + allElementalResist;
  stats.lightningResist = (stats.lightningResist || 0) + sumEffect(effects, "lightning_resist") + allElementalResist;
  stats.shadowResist = (stats.shadowResist || 0) + sumEffect(effects, "shadow_resist") + allElementalResist;
  stats.poisonResist = (stats.poisonResist || 0) + sumEffect(effects, "poison_resist") + allElementalResist;
  stats.magicFind = Math.max(0, sumEffect(effects, "magic_find"));

  // Apply passive enchantment effects from equipped items and inventory
  applyEnchantmentPassives(hero, stats, equipment);

  // Apply relic stat bonuses (e.g. max_hp_pct_bonus)
  const relicBoostedStats = applyRelicStatBonuses(hero, stats);
  Object.assign(stats, relicBoostedStats);

  return stats;
}

/**
 * Apply passive stat bonuses from enchantments on equipped items and inventory items.
 * Modifies the stats object in-place.
 */
function applyEnchantmentPassives(hero, stats, equipment) {
  // Collect enchantments from equipped items
  const enchantedItems = [];
  for (const [, item] of Object.entries(equipment || {})) {
    if (item?.enchantment) enchantedItems.push(item);
  }
  // Collect enchantments from inventory items (object-form itemId with enchantment)
  for (const placed of (hero?.inventory || [])) {
    if (placed?.itemId && typeof placed.itemId === 'object' && placed.itemId.enchantment) {
      enchantedItems.push(placed.itemId);
    }
  }

  let totalArmorBonus = 0;
  let totalMaxHpBonus = 0;
  let totalLifesteal = 0;

  for (const item of enchantedItems) {
    const ench = item.enchantment;
    if (!ench?.effect) continue;
    const e = ench.effect;

    if (e.type === 'passive_armor_bonus') {
      totalArmorBonus += Number(e.armor || 0);
    } else if (e.type === 'passive_max_hp_bonus') {
      totalMaxHpBonus += Number(e.hp || 0);
      if (e.scalesWithArmor) {
        // Tierra legendary: additionally scales with hero armor ×0.5
        totalMaxHpBonus += Math.floor((stats.armor || 0) * 0.5);
      }
    } else if (e.type === 'passive_lifesteal') {
      totalLifesteal += Number(e.lifestealPct || 0);
    } else if (e.type === 'passive_damage_reduction') {
      // Record for use in combat; not a direct stat but store as damageTakenReductionPct
      stats.enchantDamageTakenReductionPct = (stats.enchantDamageTakenReductionPct || 0) + Number(e.reductionPct || 0);
    }

    // Apply fractured penalty: -10% base stats
    if (item.fractured) {
      // We track this so combat/UI can display it; actual penalty applied to the item's baseStats is handled separately
      stats._hasFracturedItem = true;
    }
  }

  if (totalArmorBonus > 0) {
    stats.armor = Math.max(0, (stats.armor || 0) + totalArmorBonus);
  }
  if (totalMaxHpBonus > 0) {
    stats.maxHp = Math.max(1, (stats.maxHp || 0) + totalMaxHpBonus);
  }
  if (totalLifesteal > 0) {
    stats.lifesteal = (stats.lifesteal || 0) + totalLifesteal;
  }
}

export function clampHeroHpToStats(hero) {
  if (!hero) return hero;
  const maxHp = calcStats(hero).maxHp;
  const currentHp = Number(hero.hp);
  const hp = Number.isFinite(currentHp) ? currentHp : maxHp;
  return normalizeHeroPet({ ...hero, hp: Math.max(0, Math.min(hp, maxHp)) });
}

export function getStatBreakdown(hero) {
  const base = normalizeBaseStats(hero?.baseStats || {});
  const total = calcStats(hero);
  const bonus = {};
  for (const key of Object.keys(total)) {
    const delta = (total[key] || 0) - (base[key] || 0);
    if (delta) bonus[key] = delta;
  }
  return { base, bonus, total };
}
