import { BASE_HERO, buildPetCombatant, calcStats, getHeroRawDamageBase, getHungerLevel, getWeaponAttackType } from '../hero.js';
import { collectEffects, collectProcNodes, getEquippedEnchantmentEffects } from '../effectEngine.js';
import { getActiveRelics } from '../relics.js';
import { getCombatSkill, getItem } from '../content.js';

// On-hit elemental procs that flow through combat's enchantment proc loop. Base
// item effects of these types (not just enchant stones) must reach that loop.
const BASE_WEAPON_ELEMENTAL_PROC_TYPES = new Set([
  'fire_proc_on_hit', 'lightning_proc_on_hit', 'armor_reduce_on_hit',
]);

// Single source of truth for turning a saved hero + resolved enemies into the
// argument object `initCombat` expects.
//
// This used to live inline inside InteractiveCombat (client-only), which meant
// the server had no way to build a fighter from the authoritative DB hero. By
// extracting it here (mirrored into onelife-server/src/game/logic/combat) the
// SAME construction runs in three places:
//   1. client render of solo adventure combat (InteractiveCombat),
//   2. the server-authoritative adventure fight loop,
//   3. the duel fix (server rebuilds each duelist from their DB hero).
//
// `stats` may be passed in (the client already has it from calcStats); if absent
// it is computed here so the server can call buildCombatInitArgs(hero, enemies).
export function buildCombatInitArgs(hero, enemyObjs, options = {}) {
  const stats = options.stats || calcStats(hero);
  const encounterEnemies = (Array.isArray(enemyObjs) ? enemyObjs : [enemyObjs]).filter(Boolean);

  const heroAbilities = (hero?.equippedSkillIds || []).map(getCombatSkill).filter(Boolean);
  const heroEffects = collectEffects(hero);
  const heroProcNodes = collectProcNodes(hero);
  const heroWeapon = getItem(hero?.equip?.weapon);
  const heroOffhand = getItem(hero?.equip?.offhand);
  const pet = buildPetCombatant(hero);
  const allies = pet ? [pet] : [];

  const physicalDamageBonus = heroEffects
    .filter(effect => effect.type === 'damage_bonus_pct')
    .reduce((sum, effect) => sum + (effect.value || 0), 0);
  const passiveHitChanceBonus = heroEffects
    .filter(effect => effect.type === 'hit_chance')
    .reduce((sum, effect) => sum + (effect.value || 0), 0);
  const heroHitChanceBonus = (stats.hitChance ?? BASE_HERO.hitChance) - BASE_HERO.hitChance - passiveHitChanceBonus;
  const heroAttackRate = Math.max(0.35, (stats.weaponAttackSpeed || 1) * (stats.attackSpeedMult || 1));
  const mainWeaponBase = heroWeapon?.attackSpeed || heroWeapon?.baseStats?.attackSpeed || 1;
  const weaponSpeedEffectFactor = (stats.weaponAttackSpeed || 1) / mainWeaponBase;
  const heroOffhandRate = (heroOffhand && heroOffhand.slot === 'weapon')
    ? Math.max(0.35, (heroOffhand.attackSpeed || heroOffhand.baseStats?.attackSpeed || 1) * weaponSpeedEffectFactor * (stats.attackSpeedMult || 1) * 0.5)
    : 0;

  const hungerLevel = getHungerLevel(hero?.hunger ?? 100);
  const heroDamageBaseMult = (hungerLevel.dmgMult ?? 1) * (stats.damageMult ?? 1) * (1 + physicalDamageBonus / 100);
  const heroDamage = Math.max(1, Math.floor(getHeroRawDamageBase(stats, heroWeapon) * heroDamageBaseMult));

  return {
    heroName: hero?.name,
    heroSprite: hero?.sprite,
    heroHp: hero?.hp,
    heroMaxHp: stats.maxHp,
    heroDamage,
    heroArmor: stats.armor ?? 0,
    enemyObj: encounterEnemies[0],
    enemyObjs: encounterEnemies,
    allies,
    preferredFrontId: hero?.preferredFront === 'hero' ? 'hero' : null,
    heroAbilities,
    heroEffects,
    heroAttackRate,
    heroBlockChance: stats.blockChance || 0,
    heroBlockPower: stats.blockPower || 0,
    heroBlockPowerRegen: stats.blockPowerRegen || 0,
    heroHitChanceBonus,
    heroCritChance: stats.critChance || 0,
    heroCritMult: 1 + ((stats.critDamage ?? 75) / 100),
    heroMagicDefense: stats.magicDefense || 0,
    heroFireResist: stats.fireResist || 0,
    heroColdResist: stats.coldResist || 0,
    heroLightningResist: stats.lightningResist || 0,
    heroShadowResist: stats.shadowResist || 0,
    heroPoisonResist: stats.poisonResist || 0,
    heroWeaponDamageDice: heroWeapon?.damageDice || null,
    heroWeaponDamageMult: heroDamageBaseMult,
    heroWeaponFamily: heroWeapon?.family || null,
    heroWeaponTags: heroWeapon?.tags || [],
    heroAttackType: getWeaponAttackType(heroWeapon || stats),
    heroOffhandFamily: heroOffhand?.family || null,
    heroOffhandRate,
    heroOffhandDamageMult: 0.5,
    ultimateChargePct: hero?.ultimateChargePct || 0,
    bossEnemyId: options.bossEnemyId ?? null,
    bossDeathEndsFight: options.bossDeathEndsFight ?? true,
    addsDespawnOnBossDeath: options.addsDespawnOnBossDeath ?? true,
    heroProcNodes,
    // Relics/artifacts (activeRelics) and enchant-stone effects (enchantmentEffects)
    // reach combat ONLY through heroProcOpts → createInitialProcState. Compute them
    // from the hero HERE so they always fire — including server-authoritative
    // adventure, whose caller passes no heroProcOpts. A caller that already supplies
    // these (e.g. the client's mid-run procCarryAtStart) still wins via the spread.
    heroProcOpts: {
      activeRelics: getActiveRelics(hero),
      // enchantmentEffects feeds combat's on-hit elemental proc loop (fire/lightning
      // sunder). Enchant STONES come from getEquippedEnchantmentEffects; a unique's
      // BASE on-hit elemental proc (e.g. Cinderdoom's "Khargul's Fury" fireball) lives
      // in the item's own effects[] and shares that loop — but was never collected, so
      // it silently never fired. Pull those base procs (already in heroEffects, gated
      // for offhand/quiver) into the same channel. Status on-hits (burn/bleed/stagger)
      // use a different path (getOnHitEffects) and are unaffected.
      enchantmentEffects: [
        ...getEquippedEnchantmentEffects(hero),
        ...heroEffects.filter(effect => BASE_WEAPON_ELEMENTAL_PROC_TYPES.has(effect.type)),
      ],
      ...(options.heroProcOpts || {}),
    },
    heroClass: hero?.heroClass || null,
    debugPreventHeroDeath: options.debugPreventHeroDeath || false,
  };
}
