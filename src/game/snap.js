'use strict'; // intentionally omitted — this file is ESM (loaded from game/ which has { "type": "module" })

import {
  BASE_HERO,
  buildPetCombatant,
  calcStats,
  getHeroRawDamageBase,
  getHungerLevel,
  getWeaponAttackType,
  resolveEquipment,
} from './logic/hero.js';
import { collectEffects } from './logic/effectEngine.js';
import { heroClasses } from './logic/content.js';
import { getActiveRelics } from './logic/relics.js';

function getClassDef(classId = null) {
  const raw = `${classId || ''}`.trim();
  const normalized = raw.toLowerCase();
  return heroClasses.find(e => e.id === raw)
    || heroClasses.find(e => e.id === normalized)
    || heroClasses.find(e => e.name?.toLowerCase() === normalized)
    || null;
}

export function buildCombatSnapFromHero(hero) {
  if (!hero || typeof hero !== 'object') return null;

  const equipment = resolveEquipment(hero);
  const stats = calcStats(hero);
  const normalizedHeroClass = getClassDef(hero.heroClass)?.id || hero.heroClass || null;
  const heroEffects = collectEffects(hero);

  const physDmgBonus = heroEffects
    .filter(e => e.type === 'damage_bonus_pct')
    .reduce((s, e) => s + (e.value || 0), 0);
  const passiveHitChanceBonus = heroEffects
    .filter(e => e.type === 'hit_chance')
    .reduce((s, e) => s + (e.value || 0), 0);

  const hungerLevel = getHungerLevel(hero.hunger ?? 100);
  const attackRate = Math.max(0.35, (stats.weaponAttackSpeed || 1) * (stats.attackSpeedMult || 1));
  // Offhand (dual-wield) auto-attack rate — mirrors buildCombatInitArgs so a Rogue's
  // second weapon swings (and shows its bar) in duels, not just solo combat.
  const mainWeaponBase = equipment.weapon?.attackSpeed || equipment.weapon?.baseStats?.attackSpeed || 1;
  const weaponSpeedEffectFactor = (stats.weaponAttackSpeed || 1) / mainWeaponBase;
  const offhandRate = (equipment.offhand && equipment.offhand.slot === 'weapon')
    ? Math.max(0.35, (equipment.offhand.attackSpeed || equipment.offhand.baseStats?.attackSpeed || 1) * weaponSpeedEffectFactor * (stats.attackSpeedMult || 1) * 0.5)
    : 0;
  const damageMult = (hungerLevel.dmgMult ?? 1) * (stats.damageMult ?? 1) * (1 + physDmgBonus / 100);
  const damage = Math.max(1, Math.floor(
    getHeroRawDamageBase(stats, equipment.weapon) * damageMult
  ));

  const pet = buildPetCombatant({ ...hero, heroClass: normalizedHeroClass });
  // Duels are isolated sims: the hero enters at full HP (heroHp = snap.maxHp in
  // the client's buildDuelHeroInitArgs), so the pet must too — don't carry
  // open-world pet damage into PvP. buildPetCombatant returns the saved hp.
  if (pet) pet.hp = pet.stats.maxHp;

  return {
    maxHp:            stats.maxHp,
    damage,
    armor:            stats.armor || 0,
    attackSpeed:      attackRate,
    critChance:       stats.critChance || 0,
    critResist:       stats.critResist || 0,
    critMult:         1 + ((stats.critDamage ?? 75) / 100),
    blockChance:      stats.blockChance || 0,
    blockPower:       stats.blockPower || 0,
    blockPowerRegen:  stats.blockPowerRegen || 0,
    hitChanceBonus:   (stats.hitChance ?? BASE_HERO.hitChance) - BASE_HERO.hitChance - passiveHitChanceBonus,
    magicDefense:     stats.magicDefense || 0,
    fireResist:       stats.fireResist || 0,
    coldResist:       stats.coldResist || 0,
    lightningResist:  stats.lightningResist || 0,
    shadowResist:     stats.shadowResist || 0,
    poisonResist:     stats.poisonResist || 0,
    weaponDamageDice: equipment.weapon?.damageDice || null,
    weaponDamageMult: damageMult,
    weaponFamily:     equipment.weapon?.family || stats.weaponFamily || null,
    weaponTags:       [...(equipment.weapon?.tags || stats.weaponTags || [])],
    attackType:       getWeaponAttackType(equipment.weapon || stats),
    offhandFamily:    equipment.offhand?.family || null,
    offhandRate,
    passiveEffects:   heroEffects,
    heroClass:        normalizedHeroClass,
    talents:          hero.talents || {},
    equippedSkillIds: [...(hero.equippedSkillIds || [])],
    availableSkillIds:[...(hero.availableSkillIds || [])],
    allies:           pet ? [pet] : [],
    activeRelics:     getActiveRelics(hero),
  };
}
