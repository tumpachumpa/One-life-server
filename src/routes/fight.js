'use strict';
const pool = require('../db/pool');
const { createVerifier } = require('fast-jwt');
const classesData = require('../game/data/classes.json');
const talentsData = require('../game/data/talents.json');

// ── constants ─────────────────────────────────────────────────────────────────
const TICK_MS                = 1000;
const AUTO_ATTACK_TICKS      = 3;
const MAX_FIGHT_TICKS        = 600;
const ABILITY_COOLDOWN_TICKS = 15;
const ABILITY_AUTO_TICKS     = 20;
const CONNECT_TIMEOUT_MS     = 25000;
const LOOT_POOL_SIZE         = 5;
const PROTECT_MINUTES        = 5;

// ── ability map (built once at startup) ───────────────────────────────────────
function buildAbilityMap() {
  const map = new Map();
  function register(ab) { if (ab?.id) map.set(ab.id, ab); }
  for (const cls of (classesData.classes || [])) (cls.abilities || []).forEach(register);
  (classesData.universalAbilities || []).forEach(register);
  (classesData.universalUltimates || []).forEach(register);
  function walkTalents(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walkTalents); return; }
    if (obj.id && obj.type && !map.has(obj.id)) { register(obj); return; }
    for (const v of Object.values(obj)) walkTalents(v);
  }
  walkTalents(talentsData.trees || {});
  return map;
}
const ABILITY_MAP = buildAbilityMap();

// ── in-memory state ───────────────────────────────────────────────────────────
const games = new Map();

// ── pure helpers ──────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function xpToLevel(xp) {
  let lvl = 1, needed = 100, rest = xp || 0;
  while (rest >= needed) { rest -= needed; lvl++; needed = Math.floor(needed * 1.45); }
  return lvl;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function collectAllItems(saveData) {
  const items = [];
  const hero = saveData?.hero || {};
  for (const [slot, item] of Object.entries(hero.equip || {})) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    items.push({ source: 'equip', slot, itemUid: item.uid || null, itemId: item.id, item, qty: 1 });
  }
  for (const placed of (hero.inventory || [])) {
    if (!placed) continue;
    const item   = typeof placed.itemId === 'object' ? placed.itemId : null;
    const itemId = item ? item.id : placed.itemId;
    if (!itemId) continue;
    items.push({ source: 'inventory', itemUid: item?.uid || null, itemId, item: item || { id: itemId }, x: placed.x, y: placed.y, qty: 1 });
  }
  return items;
}

function getDiceAverage(dice) {
  if (!dice) return 0;
  const count = Math.max(1, Math.floor(Number(dice.count) || 1));
  const sides = Math.max(1, Math.floor(Number(dice.sides) || 1));
  return count * ((sides + 1) / 2) + (Number(dice.bonus) || 0);
}

function rollDice(dice, rng) {
  if (!dice) return 0;
  const count = Math.max(1, Math.floor(Number(dice.count) || 1));
  const sides = Math.max(1, Math.floor(Number(dice.sides) || 1));
  const bonus = Math.floor(Number(dice.bonus) || 0);
  let total = bonus;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(rng() * sides);
  return Math.max(1, total);
}

function makeCombatant(snap, side) {
  const s = snap || {};
  return {
    side,
    hp:               s.maxHp         ?? 100,
    maxHp:            s.maxHp         ?? 100,
    damage:           s.damage        ?? 10,
    armor:            s.armor         ?? 0,
    attackSpeed:      s.attackSpeed   ?? 1,
    critChance:       s.critChance    ?? 0,
    critMult:         s.critMult      ?? 1.5,
    critResist:       s.critResist    ?? 0,
    weaponDamageDice: s.weaponDamageDice  || null,
    weaponDamageMult: s.weaponDamageMult  ?? 1,
    autoProgress:     0,
    abilities:        (s.equippedSkillIds || s.availableSkillIds || []).filter(Boolean),
    lastAbilityTick:  -(ABILITY_AUTO_TICKS + 1),
    pendingAbilityIdx: null,
    // Phase 3 — combat state
    activeEffects:    [],
    armorReduction:   0,
    stunUntilTick:    -1,
    passiveEffects:   s.passiveEffects || [],
    heroClass:        s.heroClass || null,
    energy:           s.heroClass === 'rogue' ? 0 : null,
  };
}

// ── combat helpers ────────────────────────────────────────────────────────────
function baseAttackDamage(attacker, rng) {
  const diceRoll    = attacker.weaponDamageDice ? rollDice(attacker.weaponDamageDice, rng) : null;
  const diceAverage = attacker.weaponDamageDice ? getDiceAverage(attacker.weaponDamageDice) : 0;
  const diceDelta   = diceRoll == null ? 0 : Math.round((diceRoll - diceAverage) * (attacker.weaponDamageMult ?? 1));
  return Math.max(0, (attacker.damage ?? 0) + diceDelta);
}

function getEffectiveArmor(defender) {
  return Math.max(0, (defender.armor ?? 0) - (defender.armorReduction ?? 0));
}

function applyArmor(rawDmg, armor, armorPenPct) {
  const effectiveArmor = armor * (1 - (armorPenPct || 0) / 100);
  return Math.max(1, Math.floor(rawDmg * (100 / (100 + effectiveArmor))));
}

function calcHit(attacker, defender, rng) {
  const base = baseAttackDamage(attacker, rng);

  // Consume force_next_crit if active
  const fcIdx = (attacker.activeEffects || []).findIndex(e => e.type === 'force_next_crit');
  const forcedCrit = fcIdx >= 0;
  if (forcedCrit) attacker.activeEffects.splice(fcIdx, 1);

  // Consume heavy_strikes charge
  let bonusDamagePct = 0;
  for (const effect of (attacker.activeEffects || [])) {
    if (effect.type === 'heavy_strikes' && (effect.charges || 0) > 0) {
      bonusDamagePct += effect.damageBonusPct || 20;
      effect.charges--;
      break;
    }
  }
  attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'heavy_strikes' || (e.charges || 0) > 0);

  // Berserker stance bonus
  for (const effect of (attacker.activeEffects || [])) {
    if (effect.type === 'berserker_stance') bonusDamagePct += effect.damageDealtPct || 0;
  }

  // Hunter mark bonus (auto-attack only)
  let hunterMarkDamagePct = 0;
  let hunterMarkCritBonus = 0;
  for (const effect of (defender.activeEffects || [])) {
    if (effect.type === 'hunter_mark') {
      hunterMarkDamagePct += effect.autoDamageBonusPct || 0;
      hunterMarkCritBonus += effect.autoCritBonusPct || 0;
    }
  }

  // Vulnerable (damage_taken_bonus_pct) on defender
  const vulnerablePct = (defender.activeEffects || []).reduce((s, e) =>
    e.type === 'damage_taken_bonus_pct' ? s + (e.value || 0) : s, 0);

  const effectiveCrit = Math.max(0, (attacker.critChance ?? 0) + hunterMarkCritBonus - (defender.critResist ?? 0));
  const isCrit = forcedCrit || rng() * 100 < effectiveCrit;
  const totalMult = (1 + bonusDamagePct / 100) * (1 + hunterMarkDamagePct / 100) * (1 + vulnerablePct / 100) * (isCrit ? (attacker.critMult ?? 1.5) : 1);
  const rawDmg = base * totalMult;
  const dmg = applyArmor(rawDmg, getEffectiveArmor(defender), 0);

  // bleed_on_hit from passive effects
  const bleedPassive = (attacker.passiveEffects || []).find(e => e.type === 'bleed_on_hit');
  if (bleedPassive && rng() * 100 < (bleedPassive.chance || 0)) {
    applyBleed(defender, 1, bleedPassive.duration || 2, bleedPassive.damagePct || 2, null);
  }

  return { dmg, isCrit };
}

// ── Phase 3: real ability resolution ─────────────────────────────────────────
function resolveAbilityPvP(attacker, defender, abilityId, rng, tick) {
  const ability = ABILITY_MAP.get(abilityId);
  const sideEffects = [];

  if (!ability) {
    // Unknown ability: fallback 1.5× placeholder
    const base = baseAttackDamage(attacker, rng);
    const effectiveCrit = Math.max(0, (attacker.critChance ?? 0) - (defender.critResist ?? 0));
    const isCrit = rng() * 100 < effectiveCrit;
    const rawDmg = base * 1.5 * (isCrit ? (attacker.critMult ?? 1.5) : 1);
    const dmg = applyArmor(rawDmg, getEffectiveArmor(defender), 0);
    return { dmg, isCrit, sideEffects };
  }

  // Energy gate — rogues must have enough energy to fire the ability
  // Mirror getAbilityEnergyCost logic: rageCost>0 takes priority; rageCost===0 means free; energyCost is the rogue/energy fallback
  const energyCost = (ability.rageCost != null && ability.rageCost > 0)
    ? ability.rageCost
    : (ability.energyCost != null ? ability.energyCost : (ability.rageCost === 0 ? 0 : 10));
  if (attacker.energy !== null && energyCost > 0 && (attacker.energy || 0) < energyCost) {
    return { dmg: 0, isCrit: false, sideEffects };
  }

  // Deduct energy upfront so all ability branches (including self-buffs that return early) pay their cost
  const energyBeforeAbility = attacker.energy || 0;
  if (attacker.energy !== null && energyCost > 0) {
    attacker.energy = Math.max(0, energyBeforeAbility - energyCost);
  }

  // ── Self-buff / no-damage abilities ──────────────────────────────────────
  switch (ability.type) {
    case 'force_next_crit':
      attacker.activeEffects.push({ type: 'force_next_crit' });
      sideEffects.push({ type: 'buff', effect: 'force_next_crit', target: 'self' });
      return { dmg: 0, isCrit: false, sideEffects };

    case 'heavy_strikes':
      attacker.activeEffects.push({
        type: 'heavy_strikes',
        charges: ability.chargesGranted ?? 3,
        damageBonusPct: ability.damageBonusPct ?? 20,
      });
      sideEffects.push({ type: 'buff', effect: 'heavy_strikes', charges: ability.chargesGranted ?? 3, target: 'self' });
      return { dmg: 0, isCrit: false, sideEffects };

    case 'berserker_stance': {
      // Remove existing stance first (toggle)
      const existing = attacker.activeEffects.findIndex(e => e.type === 'berserker_stance');
      if (existing >= 0) { attacker.activeEffects.splice(existing, 1); }
      else {
        const dur = ability.durationTicks ?? Math.round((ability.durationSeconds ?? 8));
        attacker.activeEffects.push({
          type: 'berserker_stance',
          damageDealtPct: ability.damageDealtPct ?? 30,
          damageTakenPct: ability.damageTakenPct ?? 30,
          remainingTicks: dur,
        });
      }
      sideEffects.push({ type: 'buff', effect: 'berserker_stance', target: 'self' });
      return { dmg: 0, isCrit: false, sideEffects };
    }

    case 'rapid_fire':
      attacker.activeEffects.push({
        type: 'rapid_fire',
        charges: ability.chargesGranted ?? 3,
        attackSpeedBonusPct: ability.attackSpeedBonusPct ?? 40,
      });
      sideEffects.push({ type: 'buff', effect: 'rapid_fire', target: 'self' });
      return { dmg: 0, isCrit: false, sideEffects };

    case 'heal_over_time':
    case 'wild_renewal': {
      const dur = ability.durationTicks ?? 4;
      const healPerTick = Math.max(1, Math.ceil(attacker.maxHp * (ability.healPct ?? 15) / 100 / dur));
      attacker.activeEffects.push({ type: 'heal_over_time', healPerTick, remainingTicks: dur });
      sideEffects.push({ type: 'buff', effect: 'heal_over_time', healPerTick, ticks: dur, target: 'self' });
      return { dmg: 0, isCrit: false, sideEffects };
    }

    case 'parry_guard':
    case 'en_garde':
    case 'shield_up':
    case 'guard_instinct':
    case 'iron_will':
    case 'shadow_veil':
    case 'battle_focus': {
      const dur = ability.durationTicks ?? Math.max(1, Math.round((ability.durationSeconds ?? ability.cooldownSeconds ?? 6) * 0.5));
      const reductionPct = ability.damageReductionPct ?? ability.reductionPct ?? 20;
      attacker.activeEffects.push({ type: 'damage_reduction', reductionPct, remainingTicks: dur });
      sideEffects.push({ type: 'buff', effect: ability.type, reductionPct, target: 'self' });
      return { dmg: 0, isCrit: false, sideEffects };
    }

    case 'hunter_mark':
      defender.activeEffects.push({
        type: 'hunter_mark',
        autoDamageBonusPct: ability.autoDamageBonusPct ?? 30,
        autoCritBonusPct: ability.autoCritBonusPct ?? 10,
        remainingTicks: ability.markTicks ?? 3,
      });
      sideEffects.push({ type: 'debuff', effect: 'hunter_mark', target: 'enemy' });
      return { dmg: 0, isCrit: false, sideEffects };

    case 'daze_shout':
    case 'demoralize': {
      const stunTicks = ability.durationTicks ?? ability.stunTicks ?? 2;
      defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + stunTicks);
      sideEffects.push({ type: 'stun', ticks: stunTicks, target: 'enemy' });
      return { dmg: 0, isCrit: false, sideEffects };
    }

    case 'pet_unleash':
    case 'pet_heal_over_time':
      // Simplified: no pet tracking in PvP fight loop
      return { dmg: 0, isCrit: false, sideEffects };

    case 'detonate_marks': {
      const markEff = (defender.activeEffects || []).find(e => e.type === 'shadow_mark');
      const markStacks = markEff?.stacks || 0;
      if (markStacks === 0) return { dmg: 0, isCrit: false, sideEffects };
      const currentEnergy = energyBeforeAbility;
      const damagePerMark = ability.damagePerMark || 0.5;
      const dmg = Math.max(1, Math.floor(attacker.damage * damagePerMark * markStacks));
      defender.hp = Math.max(0, defender.hp - dmg);
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'shadow_mark');
      sideEffects.push({ type: 'detonate', markStacks, dmg, target: 'enemy' });
      if (ability.vulnerable && currentEnergy >= (ability.vulnerable.minEnergy || 60)) {
        defender.activeEffects = defender.activeEffects.filter(e => !(e.type === 'damage_taken_bonus_pct' && e.source === 'detonate'));
        defender.activeEffects.push({ type: 'damage_taken_bonus_pct', value: ability.vulnerable.damageTakenPct || 15, remainingTicks: ability.vulnerable.durationTicks || 5, source: 'detonate' });
        sideEffects.push({ type: 'buff', effect: 'vulnerable', target: 'enemy' });
      }
      if (ability.stun && currentEnergy >= (ability.stun.minEnergy || 80)) {
        defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + (ability.stun.ticks || 1));
        sideEffects.push({ type: 'stun', ticks: ability.stun.ticks || 1, target: 'enemy' });
      }
      return { dmg, isCrit: false, sideEffects };
    }
  }

  // ── Damage abilities ───────────────────────────────────────────────────────
  const forcedCritIdx = attacker.activeEffects.findIndex(e => e.type === 'force_next_crit');
  const forcedCrit = forcedCritIdx >= 0;
  if (forcedCrit) attacker.activeEffects.splice(forcedCritIdx, 1);

  // Active damage bonuses
  let bonusDamagePct = 0;
  for (const effect of attacker.activeEffects) {
    if (effect.type === 'berserker_stance') bonusDamagePct += effect.damageDealtPct || 0;
  }

  // Hunter mark bonus on target (applies to abilities too)
  let hunterDamagePct = 0;
  for (const effect of (defender.activeEffects || [])) {
    if (effect.type === 'hunter_mark') hunterDamagePct += effect.autoDamageBonusPct || 0;
  }

  // Damage reduction on defender
  const defDR = (defender.activeEffects || []).reduce((s, e) =>
    e.type === 'damage_reduction' ? s + (e.reductionPct || 0) : s, 0);

  const damageMult   = ability.damageMult ?? 1.0;
  const armorPenPct  = ability.armorPenPct ?? ability.armorIgnorePct ?? 0;
  const critBonus    = ability.critChance ?? 0;

  const base = baseAttackDamage(attacker, rng);
  const effectiveCrit = Math.max(0, (attacker.critChance ?? 0) + critBonus - (defender.critResist ?? 0));
  const isCrit = forcedCrit || rng() * 100 < effectiveCrit;
  const totalMult = damageMult * (1 + bonusDamagePct / 100) * (1 + hunterDamagePct / 100) * (isCrit ? (attacker.critMult ?? 1.5) : 1);

  let dmg = applyArmor(base * totalMult, getEffectiveArmor(defender), armorPenPct);
  if (defDR > 0) dmg = Math.max(1, Math.floor(dmg * (1 - defDR / 100)));

  // multi_hit: sum separate rolls
  if (ability.type === 'multi_hit') {
    const hitCount = Math.max(2, ability.hits ?? ability.hitCount ?? 2);
    for (let i = 1; i < hitCount; i++) {
      const extraBase = baseAttackDamage(attacker, rng);
      dmg += applyArmor(extraBase * totalMult, getEffectiveArmor(defender), armorPenPct);
    }
  }

  // execute: bonus damage below threshold, or instant kill if way below
  if (ability.type === 'execute') {
    const hpPct = defender.maxHp > 0 ? (defender.hp / defender.maxHp) * 100 : 100;
    if (hpPct < (ability.requiresTargetHpPctBelow ?? 20)) {
      dmg = Math.max(dmg, defender.hp); // finish them
    }
  }

  // stun / stunblow
  if (ability.type === 'stun' || ability.type === 'stunblow') {
    const stunTicks = ability.stunTicks ?? 1;
    defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + stunTicks);
    sideEffects.push({ type: 'stun', ticks: stunTicks, target: 'enemy' });
  }

  // stagger_shot / stagger_spell
  if (ability.type === 'stagger_shot' || ability.type === 'stagger_spell') {
    const stagTicks = ability.staggerDurationTicks ?? ability.durationTicks ?? 2;
    defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + stagTicks);
    sideEffects.push({ type: 'stagger', ticks: stagTicks, target: 'enemy' });
  }

  // armor_shatter
  if (ability.type === 'armor_shatter') {
    const reduction = ability.armorReduction ?? 8;
    defender.armorReduction = (defender.armorReduction || 0) + reduction;
    sideEffects.push({ type: 'armor_shatter', reduction, total: defender.armorReduction, target: 'enemy' });
  }

  // empowered_attack (shadowstrike): always applies 1 shadow mark
  if (ability.type === 'empowered_attack') {
    applyOrStackShadowMark(defender, 1, sideEffects);
  }

  // open_vein: direct bleed stacks, no weapon hit damage
  if (ability.type === 'open_vein') {
    const stacksToAdd = ability.bleedStacks ?? 2;
    const duration    = ability.bleedDuration ?? 3;
    const damagePct   = ability.bleedDamagePct ?? 2;
    applyBleed(defender, stacksToAdd, duration, damagePct, sideEffects);
    // open_vein deals no weapon damage itself
    return { dmg: 0, isCrit: false, sideEffects };
  }

  // hemorrhaging_shot: weapon damage + hemorrhage DoT
  if (ability.type === 'hemorrhaging_shot') {
    const duration  = ability.hemorrhageDuration ?? 3;
    const damagePct = ability.hemorrhageDamagePct ?? 3;
    const existing = (defender.activeEffects || []).find(e => e.type === 'hemorrhage');
    if (existing) {
      existing.remainingTicks = Math.max(existing.remainingTicks, duration);
      existing.damagePctPerTick = Math.max(existing.damagePctPerTick, damagePct);
    } else {
      defender.activeEffects.push({ type: 'hemorrhage', stacks: 1, remainingTicks: duration, damagePctPerTick: damagePct });
    }
    sideEffects.push({ type: 'hemorrhage_applied', ticks: duration, target: 'enemy' });
  }

  return { dmg, isCrit, sideEffects };
}

// Apply shadow mark stacks to a target
function applyOrStackShadowMark(target, stacks, sideEffects) {
  const existing = (target.activeEffects || []).find(e => e.type === 'shadow_mark');
  if (existing) {
    existing.stacks = Math.min(5, (existing.stacks || 1) + stacks);
  } else {
    target.activeEffects.push({ type: 'shadow_mark', stacks });
  }
  const total = (target.activeEffects || []).find(e => e.type === 'shadow_mark')?.stacks || stacks;
  if (sideEffects) sideEffects.push({ type: 'shadow_mark_applied', stacks: total, target: 'enemy' });
}

// Apply bleed stacks to a target (adds/refreshes the bleed effect)
function applyBleed(target, stacksToAdd, duration, damagePctPerTick, sideEffects) {
  const existing = (target.activeEffects || []).find(e => e.type === 'bleed');
  if (existing) {
    existing.stacks      = Math.min(6, (existing.stacks || 1) + stacksToAdd);
    existing.remainingTicks = Math.max(existing.remainingTicks, duration);
    existing.damagePctPerTick = Math.max(existing.damagePctPerTick || 2, damagePctPerTick);
  } else {
    target.activeEffects.push({ type: 'bleed', stacks: stacksToAdd, remainingTicks: duration, damagePctPerTick });
  }
  const bleed = (target.activeEffects || []).find(e => e.type === 'bleed');
  if (sideEffects) sideEffects.push({ type: 'bleed_applied', stacks: bleed?.stacks, ticks: duration, target: 'enemy' });
}

// ── per-tick active effect processing ────────────────────────────────────────
function tickActiveEffects(combatant, tick, events, side) {
  const keep = [];
  for (const effect of (combatant.activeEffects || [])) {
    switch (effect.type) {
      case 'bleed':
      case 'hemorrhage': {
        if ((effect.remainingTicks || 0) <= 0) continue;
        const stacks = Math.max(1, effect.stacks || 1);
        const dmg = Math.max(1, Math.floor((combatant.maxHp || combatant.hp) * (effect.damagePctPerTick || 2) * stacks / 100));
        combatant.hp = Math.max(0, combatant.hp - dmg);
        events.push({ type: effect.type === 'hemorrhage' ? 'hemorrhage_tick' : 'bleed_tick', target: side, dmg, stacks });
        effect.remainingTicks--;
        if (effect.remainingTicks > 0) keep.push(effect);
        break;
      }
      case 'heal_over_time': {
        if ((effect.remainingTicks || 0) <= 0) continue;
        const heal = Math.min(effect.healPerTick || 0, combatant.maxHp - combatant.hp);
        combatant.hp = Math.min(combatant.maxHp, combatant.hp + (effect.healPerTick || 0));
        events.push({ type: 'heal_tick', target: side, amount: heal });
        effect.remainingTicks--;
        if (effect.remainingTicks > 0) keep.push(effect);
        break;
      }
      case 'berserker_stance':
      case 'damage_reduction':
      case 'damage_taken_bonus_pct': {
        if (effect.remainingTicks == null) { keep.push(effect); break; }
        effect.remainingTicks--;
        if (effect.remainingTicks > 0) keep.push(effect);
        break;
      }
      case 'hunter_mark': {
        if (effect.remainingTicks == null) { keep.push(effect); break; }
        effect.remainingTicks--;
        if (effect.remainingTicks > 0) keep.push(effect);
        break;
      }
      case 'shadow_mark':
        // Permanent until detonated
        keep.push(effect);
        break;
      default:
        // Permanent until consumed (force_next_crit, heavy_strikes, rapid_fire, etc.)
        keep.push(effect);
    }
  }
  combatant.activeEffects = keep;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sendSSE(reply, data) {
  try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}

function broadcast(game, data) {
  for (const c of game.clients.values()) sendSSE(c.reply, data);
}

function snapState(c, currentTick) {
  return {
    hp:               c.hp,
    maxHp:            c.maxHp,
    autoProgress:     c.autoProgress,
    ticksSinceAbility: currentTick - c.lastAbilityTick,
    abilities:        c.abilities,
    // Phase 3 state
    activeEffects:    (c.activeEffects || []).map(e => ({
      type:           e.type,
      remainingTicks: e.remainingTicks,
      charges:        e.charges,
      stacks:         e.stacks,
    })),
    armorReduction:   c.armorReduction || 0,
    isStunned:        currentTick <= (c.stunUntilTick || -1),
    energy:           c.energy ?? null,
  };
}

// ── tick logic ────────────────────────────────────────────────────────────────
function runTick(game) {
  if (game.finished) return;
  game.tick++;
  const events = [];

  const atk = game.challenger;
  const def = game.defender;

  // 1. Tick DoTs, HoTs, buff durations
  tickActiveEffects(atk, game.tick, events, 'challenger');
  tickActiveEffects(def, game.tick, events, 'defender');

  // 1b. Energy regen for rogue class
  if (atk.energy !== null) atk.energy = Math.min(100, (atk.energy || 0) + 5);
  if (def.energy !== null) def.energy = Math.min(100, (def.energy || 0) + 5);

  // 2. Early end — DoT may have finished a combatant
  if (atk.hp <= 0 || def.hp <= 0) {
    broadcast(game, { type: 'tick', tick: game.tick, challenger: snapState(atk, game.tick), defender: snapState(def, game.tick), events });
    finishGame(game);
    return;
  }

  // 3. Auto-attacks (skip if stunned)
  const atkStunned = game.tick <= (atk.stunUntilTick || -1);
  const defStunned = game.tick <= (def.stunUntilTick || -1);

  if (!atkStunned) {
    atk.autoProgress += atk.attackSpeed;
    while (atk.autoProgress >= AUTO_ATTACK_TICKS) {
      atk.autoProgress -= AUTO_ATTACK_TICKS;
      const { dmg, isCrit } = calcHit(atk, def, game.atkRng);
      def.hp = Math.max(0, def.hp - dmg);
      events.push({ type: 'auto_attack', attacker: 'challenger', dmg, isCrit });
    }
  }

  if (!defStunned) {
    def.autoProgress += def.attackSpeed;
    while (def.autoProgress >= AUTO_ATTACK_TICKS) {
      def.autoProgress -= AUTO_ATTACK_TICKS;
      const { dmg, isCrit } = calcHit(def, atk, game.defRng);
      atk.hp = Math.max(0, atk.hp - dmg);
      events.push({ type: 'auto_attack', attacker: 'defender', dmg, isCrit });
    }
  }

  // 4. Abilities (skip if stunned)
  for (const [side, combatant, opponent, rng] of [
    ['challenger', atk, def, game.atkRng],
    ['defender',   def, atk, game.defRng],
  ]) {
    if (game.tick <= (combatant.stunUntilTick || -1)) continue;

    const ticksSince = game.tick - combatant.lastAbilityTick;
    const cooldownOk = ticksSince >= ABILITY_COOLDOWN_TICKS;
    const hasPending = combatant.pendingAbilityIdx !== null;
    const shouldAuto = ticksSince >= ABILITY_AUTO_TICKS && combatant.abilities.length > 0;

    if ((hasPending && cooldownOk) || shouldAuto) {
      const abilityCount = Math.max(1, combatant.abilities.length);
      const idx = hasPending
        ? combatant.pendingAbilityIdx
        : Math.floor(game.tick / ABILITY_AUTO_TICKS) % abilityCount;

      combatant.pendingAbilityIdx = null;
      combatant.lastAbilityTick   = game.tick;

      const abilityId = combatant.abilities[idx] || null;
      const { dmg, isCrit, sideEffects } = resolveAbilityPvP(combatant, opponent, abilityId, rng, game.tick);

      if (dmg > 0) opponent.hp = Math.max(0, opponent.hp - dmg);

      events.push({
        type:       'ability',
        attacker:   side,
        abilityIdx: idx,
        abilityId,
        dmg,
        isCrit,
        sideEffects,
      });
    }
  }

  // 5. Broadcast tick
  broadcast(game, {
    type:       'tick',
    tick:       game.tick,
    challenger: snapState(atk, game.tick),
    defender:   snapState(def, game.tick),
    events,
  });

  // 6. End condition
  if (atk.hp <= 0 || def.hp <= 0 || game.tick >= MAX_FIGHT_TICKS) {
    finishGame(game);
  }
}

async function finishGame(game) {
  if (game.finished) return;
  game.finished = true;
  clearInterval(game.timer);
  clearTimeout(game.startTimer);

  const challengerId = game.challengerId;
  const defenderId   = game.defenderId;
  const attackerWon  = game.challenger.hp > 0 && game.defender.hp <= 0
    ? true
    : game.defender.hp > 0 && game.challenger.hp <= 0
    ? false
    : (game.challenger.hp / game.challenger.maxHp) >= (game.defender.hp / game.defender.maxHp);
  const winnerId = attackerWon ? challengerId : defenderId;
  const loserId  = attackerWon ? defenderId   : challengerId;

  try {
    const [atkSaveRes, defSaveRes] = await Promise.all([
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [challengerId]),
      pool.query('SELECT save_data FROM heroes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [defenderId]),
    ]);
    const atkSave    = atkSaveRes.rows[0]?.save_data;
    const defSave    = defSaveRes.rows[0]?.save_data;
    const loserSave  = attackerWon ? defSave : atkSave;
    const lootPool   = shuffle(collectAllItems(loserSave)).slice(0, LOOT_POOL_SIZE);
    const atkLevel   = xpToLevel(atkSave?.hero?.xp);
    const defLevel   = xpToLevel(defSave?.hero?.xp);
    const protectedUntil = new Date(Date.now() + PROTECT_MINUTES * 60 * 1000);

    const record = await pool.query(
      `INSERT INTO pvp_records (challenge_id, attacker_id, defender_id, winner_id, loot_pool, attacker_level, defender_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (challenge_id) DO NOTHING
       RETURNING id`,
      [game.challengeId, challengerId, defenderId, winnerId, JSON.stringify(lootPool), atkLevel, defLevel],
    );

    let recordId = record.rows[0]?.id;
    if (!recordId) {
      const existing = await pool.query('SELECT id FROM pvp_records WHERE challenge_id = $1', [game.challengeId]);
      recordId = existing.rows[0]?.id;
    }

    await Promise.all([
      pool.query(`UPDATE pvp_challenges SET status = 'done', winner_id = $1 WHERE id = $2`, [winnerId, game.challengeId]),
      pool.query(`UPDATE camps SET protected_until = $1 WHERE user_id = $2`, [protectedUntil, loserId]),
    ]);

    broadcast(game, {
      type:      'end',
      winnerId:  String(winnerId),
      recordId,
      lootPool:  attackerWon ? lootPool : [],
    });
  } catch (err) {
    console.error('[fight] finishGame error:', err);
    broadcast(game, { type: 'end', winnerId: String(winnerId), recordId: null, lootPool: [] });
  }

  for (const c of game.clients.values()) {
    try { c.reply.raw.end(); } catch {}
  }
  games.delete(String(game.challengeId));
}

function startFight(game) {
  if (game.started || game.finished) return;
  game.started = true;
  clearTimeout(game.startTimer);
  game.startTimer = null;
  broadcast(game, { type: 'start', tick: 0 });
  game.timer = setInterval(() => runTick(game), TICK_MS);
}

// ── route registration ────────────────────────────────────────────────────────
async function fightRoutes(fastify) {
  const verifyToken = createVerifier({ key: async () => process.env.JWT_SECRET });

  fastify.get('/fight/:id/prep', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: challengeId } = request.params;
    const { id: userId }      = request.user;

    const chRes = await pool.query(`
      SELECT ch.*,
        COALESCE(ch.defender_snap, dc.combat_snap) AS resolved_defender_snap,
        COALESCE(ch_hero.save_data->'hero'->>'name', cu.username) AS challenger_name,
        COALESCE(dh_hero.save_data->'hero'->>'name', du.username) AS defender_name
      FROM pvp_challenges ch
      LEFT JOIN camps dc ON dc.user_id = ch.defender_id
      JOIN users cu ON cu.id = ch.challenger_id
      LEFT JOIN heroes ch_hero ON ch_hero.user_id = ch.challenger_id
      JOIN users du ON du.id = ch.defender_id
      LEFT JOIN heroes dh_hero ON dh_hero.user_id = ch.defender_id
      WHERE ch.id = $1
        AND (ch.challenger_id = $2 OR ch.defender_id = $2)
        AND ch.status IN ('prep', 'done')
    `, [challengeId, userId]);

    if (!chRes.rows[0]) return reply.status(404).send({ error: 'Challenge not found' });
    const ch = chRes.rows[0];

    return {
      challengerId:   String(ch.challenger_id),
      defenderId:     String(ch.defender_id),
      challengerSnap: ch.challenger_snap      || null,
      defenderSnap:   ch.resolved_defender_snap || null,
      fightSeed:      ch.fight_seed != null ? Number(ch.fight_seed) : null,
      challengerName: ch.challenger_name || 'Challenger',
      defenderName:   ch.defender_name   || 'Defender',
    };
  });

  fastify.get('/fight/:id/stream', async (request, reply) => {
    const { id: challengeId } = request.params;
    const { token }           = request.query;

    let user;
    try {
      user = await verifyToken(token);
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const userId = String(user.id);

    const chRes = await pool.query(`
      SELECT ch.*,
        COALESCE(ch.defender_snap, dc.combat_snap) AS resolved_defender_snap
      FROM pvp_challenges ch
      LEFT JOIN camps dc ON dc.user_id = ch.defender_id
      WHERE ch.id = $1
        AND (ch.challenger_id = $2 OR ch.defender_id = $2)
        AND ch.status = 'prep'
    `, [challengeId, userId]);

    if (!chRes.rows[0]) return reply.status(404).send({ error: 'Challenge not found or not in prep' });
    const ch = chRes.rows[0];

    const origin = request.headers.origin || '*';
    reply.raw.setHeader('Access-Control-Allow-Origin',      origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Content-Type',      'text/event-stream');
    reply.raw.setHeader('Cache-Control',     'no-cache');
    reply.raw.setHeader('Connection',        'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    const key  = String(challengeId);
    let   game = games.get(key);

    if (!game) {
      const seed = (Number(ch.fight_seed) || 0) >>> 0;
      game = {
        challengeId:  Number(challengeId),
        challengerId: String(ch.challenger_id),
        defenderId:   String(ch.defender_id),
        challenger:   makeCombatant(ch.challenger_snap,          'challenger'),
        defender:     makeCombatant(ch.resolved_defender_snap,   'defender'),
        atkRng:       mulberry32((seed ^ 0x10001) >>> 0),
        defRng:       mulberry32((seed ^ 0x10002) >>> 0),
        tick:         0,
        clients:      new Map(),
        started:      false,
        finished:     false,
        timer:        null,
        startTimer:   null,
      };
      games.set(key, game);
    }

    game.clients.set(userId, { reply, userId });

    if (game.started) {
      sendSSE(reply, {
        type:       'state',
        tick:       game.tick,
        challenger: snapState(game.challenger, game.tick),
        defender:   snapState(game.defender,   game.tick),
      });
    }

    if (!game.started && game.clients.size >= 2) {
      clearTimeout(game.startTimer);
      startFight(game);
    } else if (!game.started && !game.startTimer) {
      game.startTimer = setTimeout(() => startFight(game), CONNECT_TIMEOUT_MS);
    }

    const ping = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch {}
    }, 20000);

    return new Promise((resolve) => {
      request.raw.on('close', () => {
        clearInterval(ping);
        game.clients.delete(userId);
        resolve();
      });
    });
  });

  fastify.post('/fight/:id/action', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: challengeId } = request.params;
    const { id: userId }      = request.user;
    const { abilityIdx }      = request.body;

    const game = games.get(String(challengeId));
    if (!game || game.finished) return reply.status(404).send({ error: 'No active fight' });

    const isChallenger = String(userId) === game.challengerId;
    const isDefender   = String(userId) === game.defenderId;
    if (!isChallenger && !isDefender) return reply.status(403).send({ error: 'Not in this fight' });

    const combatant  = isChallenger ? game.challenger : game.defender;
    const ticksSince = game.tick - combatant.lastAbilityTick;

    if (ticksSince < ABILITY_COOLDOWN_TICKS) {
      return reply.status(429).send({ error: 'Ability on cooldown', readyInTicks: ABILITY_COOLDOWN_TICKS - ticksSince });
    }

    const maxIdx = Math.max(0, combatant.abilities.length - 1);
    combatant.pendingAbilityIdx = Math.max(0, Math.min(Number(abilityIdx) || 0, maxIdx));

    return { ok: true };
  });

  fastify.get('/fight/:id/state', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id: challengeId } = request.params;
    const { id: userId }      = request.user;

    const game = games.get(String(challengeId));
    if (!game) return reply.status(404).send({ error: 'No active fight' });

    const isParticipant = String(userId) === game.challengerId || String(userId) === game.defenderId;
    if (!isParticipant) return reply.status(403).send({ error: 'Not in this fight' });

    return {
      tick:       game.tick,
      started:    game.started,
      challenger: snapState(game.challenger, game.tick),
      defender:   snapState(game.defender,   game.tick),
    };
  });
}

module.exports = fightRoutes;
