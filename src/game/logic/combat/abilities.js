import { applyArmor } from '../hero.js';
import { getDiceAverage, rollDice } from '../equipmentGenerator.js';
import { resolveImpact } from './actionResolver.js';
import { applyCombatantDamage, applyDamageTakenReduction, getEffectiveArmor, getEffectiveCritChance, getPassiveArmorPenPct, isBleedImmune, resolveElementalDamage } from './combatant.js';

const PLAYER_BLEED_REFRESH_TICKS = 4;

function effectHasTime(effect) {
  return effect?.remainingTicks == null || effect.remainingTicks > 0;
}

function getJuggernautDamageDealtMult(attacker) {
  const penaltyPct = (attacker?.passiveEffects || []).reduce((total, effect) => {
    if (effect.type !== 'threshold_dmg_pct' || effect.source !== 'juggernaut') return total;
    return total + (effect.value || 0);
  }, 0);
  return penaltyPct < 0 ? Math.max(0.1, 1 + penaltyPct / 100) : 1;
}

function getActiveDamageDealtMult(attacker) {
  let mult = 1;
  const bonusPct = (attacker?.activeEffects || []).reduce((total, effect) => {
    if (!effectHasTime(effect) || effect.active === false) return total;
    if (effect.type === 'berserker_stance') {
      return total + (effect.damageDealtPct ?? effect.damageBonusPct ?? 0);
    }
    return total;
  }, 0);
  return mult * (bonusPct > 0 ? 1 + bonusPct / 100 : 1);
}

function getHpPct(combatant) {
  return combatant?.maxHp > 0 ? (combatant.hp / combatant.maxHp) * 100 : 100;
}

function getWeaponAbilityOutgoingDamageMult(attacker) {
  let mult = 1;
  for (const effect of attacker?.activeEffects || []) {
    if (!effectHasTime(effect) || effect.active === false) continue;
    if (effect.type === 'weaken') mult *= effect.damageMult || 0.8;
    if (effect.type === 'damage_bonus_pct_buff') mult *= 1 + (effect.value || 0) / 100;
  }
  for (const effect of attacker?.passiveEffects || []) {
    if (effect.type === 'rage_below_hp' && getHpPct(attacker) <= (effect.thresholdPct || 35)) mult *= effect.attackMult || 1.25;
    if (effect.type === 'threshold_dmg_pct') mult *= 1 + (effect.value || 0) / 100;
  }
  return mult;
}

function toLowerList(values = []) {
  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map(value => String(value).toLowerCase());
}

function effectMatchesTargetClassifier(effect, target) {
  if (!effect || !target) return false;
  const targetFamily = String(target.family || '').toLowerCase();
  const targetTags = new Set(toLowerList(target.tags || []));
  const families = toLowerList(effect.family || effect.families || effect.targetFamily || effect.targetFamilies);
  const tags = toLowerList(effect.tag || effect.tags || effect.targetTag || effect.targetTags);
  return families.includes(targetFamily) || tags.some(tag => targetTags.has(tag));
}

function getWeaponAbilityDamageVsTargetPct(attacker, defender) {
  return (attacker?.passiveEffects || []).reduce((total, effect) => {
    if (effect.type !== 'damage_vs_tag' && effect.type !== 'damage_vs_family') return total;
    return effectMatchesTargetClassifier(effect, defender)
      ? total + (effect.value || effect.damagePct || 0)
      : total;
  }, 0);
}

function applyWeaponDamageAbilityBonuses(attacker, defender, amount) {
  const targetBonusPct = getWeaponAbilityDamageVsTargetPct(attacker, defender);
  const mult = getActiveDamageDealtMult(attacker) * getWeaponAbilityOutgoingDamageMult(attacker) * (1 + targetBonusPct / 100);
  return Math.max(1, Math.floor(amount * mult));
}

function spellDamage(attacker, amount) {
  const bonus = 1 + ((attacker.spellDamageBonus || 0) / 100);
  return Math.max(1, Math.floor(amount * bonus * getJuggernautDamageDealtMult(attacker) * getActiveDamageDealtMult(attacker)));
}

function getWeaponDamageAbilityBase(attacker, rng) {
  const variance = Math.floor(rng() * 4);
  const diceRoll = attacker.weaponDamageDice ? rollDice(attacker.weaponDamageDice, rng) : null;
  const diceAverage = attacker.weaponDamageDice ? getDiceAverage(attacker.weaponDamageDice) : 0;
  const diceDelta = diceRoll == null
    ? 0
    : Math.round((diceRoll - diceAverage) * (attacker.weaponDamageMult || 1));
  return Math.max(1, (attacker.damage || 0) + diceDelta + variance);
}

function resolveSpellDamage(amount, defender = null, element = 'magic') {
  return resolveElementalDamage(amount, element, defender);
}

function resolvePhysicalImpact(attacker, defender, damage, rng, ability = null) {
  const abilityArmorPen = ability?.armorPenPct ?? ability?.armorIgnorePct ?? ability?.armorIgnore ?? 0;
  const armorPenPct = getPassiveArmorPenPct(attacker) + abilityArmorPen;
  return resolveImpact({ damage, armorPenPct }, defender, { rng, armorPenPct });
}

function isPlayerSideCombatant(combatant) {
  return combatant?.team === 'player' || combatant?.isPlayer || combatant?.isAlly;
}

function applyPhysicalArmor(attacker, damage, defender) {
  return applyDamageTakenReduction(applyArmor(damage, getEffectiveArmor(defender), getPassiveArmorPenPct(attacker)), defender);
}

function hasArmorReductionImmunity(defender) {
  const effects = [
    ...(defender?.passiveEffects || []),
    ...(defender?.activeEffects || []),
  ];
  return effects.some(effect => effect.type === 'juggernaut_active' || effect.type === 'armor_reduction_immune');
}

function getBleedDamageBonusPct(attacker) {
  return (attacker?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'bleed_damage_bonus_pct' ? total + (effect.value || 0) : total, 0);
}

function applyBleedDamageBonus(attacker, basePct) {
  const bonusPct = getBleedDamageBonusPct(attacker);
  return bonusPct > 0 ? basePct * (1 + bonusPct / 100) : basePct;
}

function applyBleedDurationBonus(attacker, baseTicks) {
  const bonusTicks = (attacker?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'bleed_duration_bonus_ticks' ? total + (effect.value || 0) : total, 0);
  return Math.max(1, baseTicks + bonusTicks);
}

function getAppliedBleedDuration(attacker, baseTicks) {
  const floorTicks = isPlayerSideCombatant(attacker) ? PLAYER_BLEED_REFRESH_TICKS : baseTicks;
  return applyBleedDurationBonus(attacker, Math.max(baseTicks, floorTicks));
}

function hpPct(combatant) {
  return combatant.maxHp > 0 ? (combatant.hp / combatant.maxHp) * 100 : 100;
}

function applyDisruptedDamageBonus(attacker, defender, damage, tick) {
  const isDisrupted = (tick != null && tick <= (defender.stunUntilTick || -1))
    || (defender.activeEffects || []).some(e =>
      (e.type === 'daze' && e.remainingTicks > 0)
      || (e.type === 'stagger' && (e.remainingTicks > 0 || e.attacksRemaining > 0)));
  if (!isDisrupted) return damage;
  const bonus = (attacker.passiveEffects || []).reduce((sum, e) =>
    e.type === 'damage_vs_disrupted' ? sum + (e.value || 0) : sum, 0);
  return bonus > 0 ? Math.max(1, Math.floor(damage * (1 + bonus / 100))) : damage;
}

function applyLowHpDamageBonuses(attacker, defender, damage) {
  const bonus = (attacker.passiveEffects || []).reduce((sum, effect) => {
    if (effect.type !== 'damage_vs_low_hp') return sum;
    if (hpPct(defender) > (effect.thresholdPct || 35)) return sum;
    return sum + (effect.value || effect.damagePct || 0);
  }, 0);
  return bonus > 0 ? Math.max(1, Math.floor(damage * (1 + bonus / 100))) : damage;
}

function livingUniqueTargets(targets = []) {
  const seen = new Set();
  const result = [];
  for (const target of targets) {
    if (!target || target.hp <= 0 || !target.id || seen.has(target.id)) continue;
    seen.add(target.id);
    result.push(target);
  }
  return result;
}

function getCleaveTargets(attacker, defender, context = {}, maxTargets = 3) {
  const opposingTargets = isPlayerSideCombatant(attacker)
    ? [defender, ...(context.enemyAllies || [])]
    : [defender, context.hero, ...(context.playerAllies || [])];
  return livingUniqueTargets(opposingTargets).slice(0, Math.max(1, maxTargets));
}

function getAllOpposingTargets(attacker, defender, context = {}) {
  const opposingTargets = isPlayerSideCombatant(attacker)
    ? [defender, ...(context.enemyAllies || [])]
    : [defender, context.hero, ...(context.playerAllies || [])];
  return livingUniqueTargets(opposingTargets);
}

function tryApplyDaze(attacker, defender, tick, rng, entries) {
  for (const effect of attacker.passiveEffects || []) {
    if (effect.type !== 'daze_on_hit') continue;
    if (rng() * 100 >= (effect.chance || 0)) continue;
    defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'daze');
    defender.activeEffects.push({
      type: 'daze',
      remainingTicks: effect.duration || 2,
      missSpellChance: effect.missSpellChance || 50,
    });
    entries.push({
      type: 'daze',
      text: attacker.isPlayer
        ? `Status: ${defender.name} gains Dazed.`
        : `Status: You are Dazed by ${attacker.name}.`,
      damage: 0,
    });
    break;
  }
}

function tryApplyAbilityBleed(attacker, defender, ability, tick, rng, entries, heroConditions = null) {
  if ((ability.bleedChance || 0) <= 0 || rng() * 100 >= ability.bleedChance) return;
  const attackerIsPlayerSide = isPlayerSideCombatant(attacker);
  if (isBleedImmune(defender)) {
    entries.push({
      type: 'immune',
      text: attackerIsPlayerSide ? `${defender.name} is immune to Bleeding.` : 'You are immune to Bleeding.',
      damage: 0,
    });
    return;
  }

  const duration = getAppliedBleedDuration(attacker, ability.bleedDuration || 2);
  const damagePct = ability.bleedDamagePct || 0.75;
  const currentBleed = (defender.activeEffects || []).find(active => active.type === 'bleed');
  const nextStacks = Math.min(6, (currentBleed?.stacks || 0) + 1);
  const remainingTicks = Math.max(currentBleed?.remainingTicks || 0, duration);
  defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'bleed');
  defender.activeEffects.push({
    type: 'bleed',
    stacks: nextStacks,
    remainingTicks,
    damagePctPerTick: damagePct,
  });

  if (defender.isPlayer && heroConditions) {
    heroConditions.bleeding = {
      type: 'bleeding',
      stacks: nextStacks,
      damagePct,
    };
  }

  entries.push({
    type: 'bleed',
    text: attackerIsPlayerSide
      ? `Status: ${defender.name} gains Bleeding (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}).`
      : `Status: You gain Bleeding (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}) from ${ability.name}.`,
    damage: 0,
  });
}

function applyDirectBleedStacks(attacker, defender, ability, entries, heroConditions = null) {
  const stacksToAdd = Math.max(1, Math.floor(ability.bleedStacks || ability.stacks || 1));
  const attackerIsPlayerSide = isPlayerSideCombatant(attacker);
  if (isBleedImmune(defender)) {
    entries.push({
      type: 'immune',
      text: attackerIsPlayerSide ? `${defender.name} is immune to Bleeding.` : 'You are immune to Bleeding.',
      damage: 0,
    });
    return;
  }

  const duration = getAppliedBleedDuration(attacker, ability.bleedDuration || ability.durationTicks || 2);
  const damagePct = ability.bleedDamagePct || 0.75;
  const currentBleed = (defender.activeEffects || []).find(active => active.type === 'bleed');
  const nextStacks = Math.min(6, (currentBleed?.stacks || 0) + stacksToAdd);
  const remainingTicks = Math.max(currentBleed?.remainingTicks || 0, duration);
  defender.activeEffects = (defender.activeEffects || []).filter(active => active.type !== 'bleed');
  defender.activeEffects.push({
    type: 'bleed',
    stacks: nextStacks,
    remainingTicks,
    damagePctPerTick: damagePct,
  });

  if (defender.isPlayer && heroConditions) {
    heroConditions.bleeding = {
      type: 'bleeding',
      stacks: nextStacks,
      damagePct,
    };
  }

  entries.push({
    type: 'bleed',
    text: attackerIsPlayerSide
      ? `${ability.name}: ${defender.name} gains Bleeding (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}).`
      : `${ability.name}: You gain Bleeding (${nextStacks} stack${nextStacks !== 1 ? 's' : ''}).`,
    damage: 0,
  });
}

function tryApplyAbilityBurning(attacker, defender, ability, entries, rng = Math.random) {
  const burn = ability.burning || ability.burn || null;
  const chance = ability.burnChance ?? ability.burningChance ?? burn?.chance ?? 100;
  if (chance < 100 && rng() * 100 >= chance) return;
  const durationTicks = Math.max(0, Math.ceil(
    ability.burnDurationTicks
      ?? ability.burningDurationTicks
      ?? burn?.durationTicks
      ?? burn?.duration
      ?? 0,
  ));
  if (durationTicks <= 0 || defender.hp <= 0) return;

  const damageFlat = ability.burnDamageFlat ?? burn?.damageFlat ?? burn?.damage;
  const damagePctPerTick = ability.burnDamagePct ?? burn?.damagePctPerTick ?? burn?.damagePct;
  defender.activeEffects = (defender.activeEffects || [])
    .filter(effect => !(effect.type === 'burning' && effect.sourceAbilityId === ability.id));
  defender.activeEffects.push({
    type: 'burning',
    remainingTicks: durationTicks,
    damageFlat,
    damagePctPerTick,
    element: burn?.element || ability.burnElement || 'fire',
    sourceAbilityId: ability.id,
  });
  entries.push({
    type: 'burning',
    text: attacker.isPlayer
      ? `Status: ${defender.name} is Burning.`
      : `Status: You are Burning from ${ability.name}.`,
    damage: 0,
    element: 'fire',
  });
}

function tryApplyAbilityStagger(attacker, defender, ability, entries) {
  const attacksRemaining = ability.staggerAttacks || ability.attacksStaggered || 0;
  const durationTicks = ability.staggerDurationTicks || ability.staggerDuration || attacksRemaining;
  if (attacksRemaining <= 0 || durationTicks <= 0 || defender.hp <= 0) return;
  defender.activeEffects = (defender.activeEffects || []).filter(effect => effect.type !== 'stagger');
  defender.activeEffects.push({
    type: 'stagger',
    remainingTicks: durationTicks,
    attacksRemaining,
    missPenalty: ability.staggerMissPenalty || ability.missPenalty || 35,
    sourceAbilityId: ability.id,
  });
  entries.push({
    type: 'stagger',
    text: attacker.isPlayer
      ? `${ability.name}: ${defender.name} is staggered for ${attacksRemaining} attack${attacksRemaining !== 1 ? 's' : ''}.`
      : `${attacker.name}'s ${ability.name} staggers you for ${attacksRemaining} attack${attacksRemaining !== 1 ? 's' : ''}.`,
    damage: 0,
  });
}

function addHealOverTimeEffect(target, ability, healPct, durationTicks) {
  const totalHeal = Math.ceil(target.maxHp * healPct / 100);
  const healPerTick = Math.max(1, Math.ceil(totalHeal / durationTicks));
  target.activeEffects = (target.activeEffects || []).filter(effect => effect.sourceAbilityId !== ability.id || effect.type !== 'heal_over_time');
  target.activeEffects.push({
    type: 'heal_over_time',
    healPerTick,
    remainingTicks: durationTicks,
    visual: ability.visual || null,
    sourceAbilityId: ability.id,
    sourceAbilityName: ability.name,
  });
  return healPerTick;
}

function addDamageReductionEffect(target, ability, reductionPct, durationTicks) {
  if ((reductionPct || 0) <= 0 || durationTicks <= 0) return;
  target.activeEffects = (target.activeEffects || []).filter(effect =>
    !(effect.type === 'damage_taken_reduction' && effect.sourceAbilityId === ability.id));
  target.activeEffects.push({
    type: 'damage_taken_reduction',
    remainingTicks: durationTicks,
    reductionPct,
    sourceAbilityId: ability.id,
    sourceAbilityName: ability.name,
  });
}

function getAbilityCritChance(attacker, defender = null, bonus = 0) {
  const passiveBonus = (attacker?.passiveEffects || []).reduce((total, effect) => {
    if (effect.type === 'crit_chance' || effect.type === 'crit_chance_bonus') return total + (effect.value || effect.chance || 0);
    return total;
  }, 0);
  const activeBonus = (attacker?.activeEffects || []).reduce((total, effect) => {
    const hasTime = effect.remainingTicks == null || effect.remainingTicks > 0;
    if (effect.type !== 'crit_chance_buff' || !hasTime) return total;
    return total + (effect.value || effect.chance || 0);
  }, 0);
  return getEffectiveCritChance((attacker?.critChance || 0) + bonus + passiveBonus + activeBonus, defender);
}

function getAbilityCritDamageBonusPct(attacker) {
  const passiveBonus = (attacker?.passiveEffects || []).reduce((total, effect) => {
    if (effect.type === 'crit_damage' || effect.type === 'crit_damage_pct' || effect.type === 'crit_damage_bonus_pct') {
      return total + (effect.value || 0);
    }
    return total;
  }, 0);
  const activeBonus = (attacker?.activeEffects || []).reduce((total, effect) => {
    const hasTime = effect.remainingTicks == null || effect.remainingTicks > 0;
    if (!hasTime) return total;
    if (effect.type === 'crit_damage' || effect.type === 'crit_damage_pct' || effect.type === 'crit_damage_bonus_pct') {
      return total + (effect.value || 0);
    }
    return total;
  }, 0);
  return Math.max(0, passiveBonus + activeBonus);
}

// Predator's Focus: crit damage scales by the number of Shadow Marks on the defender.
// Returns perMarkPct × markStacks (0 if the attacker lacks the passive or the target is unmarked).
function getCritDamageVsMarkedPct(attacker, defender) {
  const perMark = (attacker?.passiveEffects || []).reduce((total, effect) =>
    effect.type === 'crit_damage_pct_per_mark' ? total + (effect.value || 0) : total, 0);
  if (perMark <= 0) return 0;
  const marks = (defender?.activeEffects || []).find(e => e.type === 'shadow_mark')?.stacks || 0;
  return perMark * marks;
}

export function resolveAbilityImpact(action, attacker, defender, tick, rng, context = {}) {
  const { ability } = action;
  const entries = [];

  // Relic: active_skill_damage_bonus (relic_abyssal_seal) — hero abilities deal +X% damage
  let _relicSavedDamage, _relicSavedSpell;
  if (attacker.isPlayer) {
    for (const relic of context.procState?.activeRelics || []) {
      const p = relic?.relicPassive;
      if (p?.type === 'active_skill_damage_bonus') {
        const mult = 1 + (p.value || 8) / 100;
        _relicSavedDamage = attacker.damage;
        _relicSavedSpell = attacker.spellDamage;
        attacker.damage = Math.max(1, Math.round((attacker.damage || 0) * mult));
        if (Number.isFinite(attacker.spellDamage)) {
          attacker.spellDamage = Math.max(1, Math.round(attacker.spellDamage * mult));
        }
        break;
      }
    }
  }

  switch (ability.type) {
    case 'multi_hit': {
      let totalDmg = 0;
      for (let i = 0; i < ability.hits; i++) {
        const variance = Math.floor(rng() * 4);
        const hitDmg = spellDamage(attacker, Math.max(1, attacker.damage + variance));
        const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, hitDmg), rng);
        if (!result.dodged) {
          defender.hp = Math.max(0, defender.hp - result.damage);
          totalDmg += result.damage;
          tryApplyDaze(attacker, defender, tick, rng, entries);
        }
      }
      const text = attacker.isPlayer
        ? `Flurry of Fists: ${ability.hits} strikes for ${totalDmg} total damage!`
        : `${attacker.name} flurries for ${totalDmg} total damage!`;
      entries.push({ type: 'ability', text, damage: totalDmg });
      break;
    }

    case 'stun': {
      const variance = Math.floor(rng() * 4);
      const baseDamage = Math.max(1, attacker.damage + variance);
      const dmg = spellDamage(attacker, Math.max(1, Math.floor(baseDamage * (ability.damageMult || 1))));
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), rng);
      if (result.dodged) {
        const text = attacker.isPlayer
          ? `${defender.name} dodges your ${ability.name}!`
          : `You dodge ${ability.name}!`;
        entries.push({ type: 'dodged', text, damage: 0 });
      } else if (result.blocked) {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const text = attacker.isPlayer
          ? `${defender.name} blocks ${result.absorbed || 0} with Block Power. Your ${ability.name} deals ${result.damage} - no stun.`
          : `You block ${result.absorbed || 0} with Block Power, taking ${result.damage}. No stun!`;
        entries.push({ type: 'blocked', text, damage: result.damage });
        tryApplyDaze(attacker, defender, tick, rng, entries);
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        defender.stunUntilTick = tick + ability.stunTicks;
        const text = attacker.isPlayer
          ? `${ability.name}: ${result.damage} damage - ${defender.name} is stunned!`
          : `${attacker.name} uses ${ability.name} for ${result.damage}! You are stunned!`;
        entries.push({ type: 'stun', text, damage: result.damage });
        tryApplyDaze(attacker, defender, tick, rng, entries);
      }
      break;
    }

    case 'heal_over_time': {
      const totalHeal = Math.ceil(attacker.maxHp * ability.healPct / 100);
      const healPerTick = Math.ceil(totalHeal / ability.durationTicks);
      attacker.activeEffects.push({
        type: 'heal_over_time',
        healPerTick,
        remainingTicks: ability.durationTicks,
        visual: ability.visual || null,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      const text = attacker.isPlayer
        ? `${ability.name}: restoring ${healPerTick} HP/tick for ${ability.durationTicks} ticks.`
        : `${attacker.name} uses ${ability.name} - ${healPerTick} HP/tick for ${ability.durationTicks} ticks.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'pet_heal_over_time': {
      if (!defender?.isAlly || defender.hp <= 0) {
        entries.push({
          type: 'ability_fail',
          text: attacker.isPlayer ? `${ability.name}: no living companion to heal.` : `${attacker.name}'s ${ability.name} fails.`,
          damage: 0,
        });
        break;
      }
      const durationTicks = Math.max(1, ability.durationTicks || 1);
      const totalHeal = Math.ceil(defender.maxHp * (ability.healPct || 0) / 100);
      const healPerTick = Math.max(1, Math.ceil(totalHeal / durationTicks));
      const mendUpgrade = (attacker.passiveEffects || [])
        .find(effect => effect.type === 'mend_companion_upgrade') || null;
      const upgradeThresholdPct = mendUpgrade?.thresholdPct || 40;
      if (mendUpgrade && hpPct(defender) <= upgradeThresholdPct) {
        const instantHeal = Math.min(
          defender.maxHp - defender.hp,
          Math.max(1, Math.ceil(defender.maxHp * (mendUpgrade.instantHealPct || 10) / 100)),
        );
        if (instantHeal > 0) {
          defender.hp = Math.min(defender.maxHp, defender.hp + instantHeal);
          entries.push({
            type: 'heal',
            text: `Emergency Triage: ${defender.name} immediately recovers ${instantHeal} HP.`,
            damage: 0,
            targetId: defender.id,
          });
        }
        const reductionPct = mendUpgrade.reductionPct || 30;
        const reductionTicks = mendUpgrade.durationTicks || 3;
        addDamageReductionEffect(defender, ability, reductionPct, reductionTicks);
        entries.push({
          type: 'buff',
          text: `Emergency Triage: ${defender.name} takes ${reductionPct}% less damage for ${reductionTicks} seconds.`,
          damage: 0,
          targetId: defender.id,
        });
      }
      defender.activeEffects = (defender.activeEffects || []).filter(effect =>
        !(effect.sourceAbilityId === ability.id && effect.type === 'heal_over_time'));
      defender.activeEffects.push({
        type: 'heal_over_time',
        healPerTick,
        remainingTicks: durationTicks,
        visual: ability.visual || null,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} will recover ${healPerTick} HP/tick for ${durationTicks} seconds.`
          : `${attacker.name} uses ${ability.name} on ${defender.name}.`,
        damage: 0,
      });
      const selfDodge = (attacker.passiveEffects || [])
        .find(effect => effect.type === 'mend_companion_self_dodge') || null;
      const dodgeBonus = Math.max(0, selfDodge?.value || selfDodge?.chance || 0);
      const dodgeTicks = Math.max(1, selfDodge?.durationTicks || 4);
      if (dodgeBonus > 0) {
        attacker.activeEffects = (attacker.activeEffects || [])
          .filter(effect => !(effect.type === 'evasion_chance' && effect.source === 'ranger_pack_bonds'));
        attacker.activeEffects.push({
          type: 'evasion_chance',
          value: dodgeBonus,
          remainingTicks: dodgeTicks,
          source: 'ranger_pack_bonds',
          sourceAbilityId: ability.id,
        });
        entries.push({
          type: 'buff',
          text: `Pack Bonds: you gain +${dodgeBonus}% dodge for ${dodgeTicks} seconds.`,
          damage: 0,
          targetId: attacker.id,
        });
      }
      break;
    }

    case 'pet_unleash': {
      if (!defender?.isAlly || defender.hp <= 0) {
        entries.push({
          type: 'ability_fail',
          text: attacker.isPlayer ? `${ability.name}: no living companion to command.` : `${attacker.name}'s ${ability.name} fails.`,
          damage: 0,
        });
        break;
      }
      const durationTicks = Math.max(1, ability.durationTicks || 4);
      const attackSpeedBonus = Math.max(0, ability.attackSpeedBonusPct || 50);
      const damageBonus = Math.max(0, ability.damageBonusPct || 35);
      const damageTaken = Math.max(0, ability.damageTakenPct || 30);
      defender.activeEffects = (defender.activeEffects || []).filter(effect => effect.sourceAbilityId !== ability.id);
      defender.activeEffects.push({
        type: 'attack_speed_buff',
        value: attackSpeedBonus,
        remainingTicks: durationTicks,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      defender.activeEffects.push({
        type: 'damage_bonus_pct_buff',
        value: damageBonus,
        remainingTicks: durationTicks,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      defender.activeEffects.push({
        type: 'incoming_damage_taken_bonus_pct',
        value: damageTaken,
        remainingTicks: durationTicks,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      defender.activeEffects.push({
        type: 'pet_unleash',
        remainingTicks: durationTicks,
        recoveryTicks: Math.max(0, ability.recoveryTicks || 3),
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      entries.push({
        type: 'buff',
        text: `${ability.name}: ${defender.name} enters a frenzy for ${durationTicks} seconds.`,
        damage: 0,
        targetId: defender.id,
      });
      break;
    }

    case 'wild_renewal': {
      const allies = Array.isArray(context.allies) ? context.allies : [];

      if (ability.channeled) {
        // HoT and damage reduction were applied at channel start; handle revive at completion.
        for (const ally of allies) {
          if (!ally || ally.hp > 0) continue;
          const revivePct = ability.reviveAllyHpPct || 0;
          if (revivePct <= 0) continue;
          const revivedHp = Math.max(1, Math.ceil(ally.maxHp * revivePct / 100));
          ally.hp = Math.min(ally.maxHp, revivedHp);
          addDamageReductionEffect(ally, ability, ability.damageReductionPct || 15, 2);
          entries.push({
            type: 'heal',
            text: `${ability.name}: ${ally.name} returns to the fight with ${ally.hp} HP.`,
            damage: 0,
            targetId: ally.id,
          });
        }
        entries.push({
          type: 'ability',
          text: attacker.isPlayer ? `${ability.name}: channel complete.` : `${attacker.name} completes ${ability.name}.`,
          damage: 0,
        });
        break;
      }

      const durationTicks = Math.max(1, ability.durationTicks || 5);
      const reductionPct = ability.damageReductionPct || ability.reductionPct || 15;
      const targets = [attacker, ...allies];
      const affectedNames = [];

      for (const target of targets) {
        if (!target) continue;
        const isFallenAlly = target.isAlly && target.hp <= 0;
        if (isFallenAlly) {
          const revivePct = ability.reviveAllyHpPct || 0;
          if (revivePct <= 0) continue;
          const revivedHp = Math.max(1, Math.ceil(target.maxHp * revivePct / 100));
          target.hp = Math.min(target.maxHp, revivedHp);
          addDamageReductionEffect(target, ability, reductionPct, durationTicks);
          affectedNames.push(target.name);
          entries.push({
            type: 'heal',
            text: `${ability.name}: ${target.name} returns to the fight with ${target.hp} HP.`,
            damage: 0,
            targetId: target.id,
          });
          continue;
        }
        if (target.hp <= 0) continue;
        const healPct = target.isAlly ? (ability.allyHealPct || ability.healPct || 25) : (ability.healPct || 25);
        const healPerTick = addHealOverTimeEffect(target, ability, healPct, durationTicks);
        if (target.isAlly) addDamageReductionEffect(target, ability, reductionPct, durationTicks);
        affectedNames.push(target.name);
        entries.push({
          type: 'heal',
          text: `${ability.name}: ${target.name} will recover ${healPerTick} HP/tick for ${durationTicks} seconds.`,
          damage: 0,
          targetId: target.id,
        });
      }

      const names = affectedNames.length ? affectedNames.join(' and ') : 'no one';
      entries.push({
        type: 'ability',
        text: `${ability.name}: renewal surrounds ${names}.`,
        damage: 0,
        targetId: attacker.id,
      });
      break;
    }

    case 'empowered_attack': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const empowered = applyWeaponDamageAbilityBonuses(attacker, defender, Math.floor(base * ability.damageMult));
      const critChance = getEffectiveCritChance(ability.critChance || 0, defender);
      const forcedNextCrit = !!(attacker.isPlayer && context.procState?.forcedNextCrit);
      if (forcedNextCrit) context.procState.forcedNextCrit = false;
      const isCrit = forcedNextCrit || (critChance > 0 && rng() * 100 < critChance);
      const markCritBonusPct = isCrit ? getCritDamageVsMarkedPct(attacker, defender) : 0;
      const finalDmg = isCrit ? Math.floor(empowered * 1.5 * (1 + markCritBonusPct / 100)) : empowered;
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, finalDmg), rng, ability);
      if (result.dodged) {
        const text = attacker.isPlayer
          ? `${defender.name} dodges your ${ability.name}!`
          : `You dodge ${ability.name}!`;
        entries.push({ type: 'dodged', text, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const suffix = isCrit ? ' (CRIT!)' : result.blocked ? ' (blocked)' : '';
        const text = attacker.isPlayer
          ? `${ability.name}${suffix}: ${result.damage} damage!`
          : `${attacker.name} lands ${ability.name}${suffix} for ${result.damage}!`;
        entries.push({ type: result.blocked ? 'blocked' : 'ability', text, damage: result.damage, isCrit, absorbed: result.absorbed || 0 });
        if (defender.hp > 0 && result.damage > 0) tryApplyAbilityBleed(attacker, defender, ability, tick, rng, entries, context.heroConditions);
        if (defender.hp > 0 && result.damage > 0) tryApplyAbilityBurning(attacker, defender, ability, entries, rng);
        if (defender.hp > 0 && result.damage > 0) tryApplyAbilityStagger(attacker, defender, ability, entries);
        if (!result.blocked && (ability.stunTicks || ability.stunDurationTicks || ability.stunSeconds)) {
          const stunTicks = ability.stunTicks || ability.stunDurationTicks || ability.stunSeconds || 3;
          defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + stunTicks);
          entries.push({
            type: 'stun',
            text: attacker.isPlayer
              ? `${ability.name}: ${defender.name} is stunned for ${stunTicks} seconds.`
              : `${attacker.name}'s ${ability.name} stuns you for ${stunTicks} seconds.`,
            damage: 0,
          });
        }
        tryApplyDaze(attacker, defender, tick, rng, entries);
      }
      break;
    }

    case 'cleaving_order': {
      const targets = getCleaveTargets(attacker, defender, context, ability.maxTargets || 3);
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, (attacker.damage || 0) + variance);
      for (const target of targets) {
        const isPrimaryTarget = target.id === defender?.id;
        const damageMult = isPrimaryTarget
          ? (ability.damageMult || 1.15)
          : (ability.secondaryDamageMult || 0.7);
        const rawDamage = spellDamage(attacker, Math.max(1, Math.floor(base * damageMult)));
        const damage = applyLowHpDamageBonuses(attacker, target, rawDamage);
        const result = resolvePhysicalImpact(attacker, target, damage, rng, ability);
        const targetLabel = target.isPlayer ? 'you' : target.name;
        if (result.dodged) {
          entries.push({
            type: 'dodged',
            text: target.isPlayer
              ? `You dodge ${ability.name}!`
              : `${target.name} dodges ${attacker.name}'s ${ability.name}!`,
            damage: 0,
            targetId: target.id,
          });
          continue;
        }
        target.hp = Math.max(0, target.hp - result.damage);
        const suffix = result.blocked ? ' (blocked)' : '';
        entries.push({
          type: result.blocked ? 'blocked' : 'ability',
          text: `${attacker.name}'s ${ability.name} cleaves ${targetLabel} for ${result.damage}${suffix}.`,
          damage: result.damage,
          absorbed: result.absorbed || 0,
          targetId: target.id,
          cleaveSecondary: !isPrimaryTarget,
        });
        if (target.hp > 0 && result.damage > 0) tryApplyDaze(attacker, target, tick, rng, entries);
      }
      break;
    }

    case 'whirlwind': {
      const targets = getAllOpposingTargets(attacker, defender, context);
      if (!targets.length) {
        entries.push({
          type: 'ability_fail',
          text: `${ability.name}: no enemies are in reach.`,
          damage: 0,
          targetId: attacker.id,
        });
        break;
      }

      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, (attacker.damage || 0) + variance);
      let totalDamage = 0;
      let killedAny = false;

      for (const target of targets) {
        const hpBefore = target.hp;
        const rawDamage = Math.max(1, Math.floor(base * (ability.damageMult || 1.5)));
        const boostedDamage = applyWeaponDamageAbilityBonuses(attacker, target, rawDamage);
        const damage = applyLowHpDamageBonuses(attacker, target, boostedDamage);
        const result = resolvePhysicalImpact(attacker, target, damage, rng, ability);
        const targetLabel = target.isPlayer ? 'you' : target.name;
        if (result.dodged) {
          entries.push({
            type: 'dodged',
            text: target.isPlayer
              ? `You dodge ${ability.name}!`
              : `${target.name} dodges ${attacker.name}'s ${ability.name}!`,
            damage: 0,
            targetId: target.id,
          });
          continue;
        }

        target.hp = Math.max(0, target.hp - result.damage);
        totalDamage += result.damage;
        if (hpBefore > 0 && target.hp <= 0) killedAny = true;
        const suffix = result.blocked ? ' (blocked)' : target.hp <= 0 ? ' (defeated)' : '';
        entries.push({
          type: result.blocked ? 'blocked' : 'ability',
          text: `${attacker.name}'s ${ability.name} hits ${targetLabel} for ${result.damage}${suffix}.`,
          damage: result.damage,
          absorbed: result.absorbed || 0,
          targetId: target.id,
        });
        if (target.hp > 0 && result.damage > 0) tryApplyDaze(attacker, target, tick, rng, entries);
      }

      if (killedAny) {
        const procState = context.procState;
        const rageGain = Math.max(0, Math.floor(ability.rageOnKill || 25));
        const healPct = Math.max(0, ability.healOnKillMaxHpPct || ability.healOnKillPct || 15);
        let healed = 0;
        if (procState && rageGain > 0) {
          procState.rage = Math.min(100, (procState.rage || 0) + rageGain);
        }
        if (healPct > 0 && attacker.hp > 0) {
          healed = Math.min(attacker.maxHp - attacker.hp, Math.max(1, Math.floor((attacker.maxHp || 0) * healPct / 100)));
          if (healed > 0) attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
        }
        entries.push({
          type: 'heal',
          text: `${ability.name}: kill momentum restores ${rageGain} Rage and ${healed} HP.`,
          damage: 0,
          targetId: attacker.id,
          rageGained: rageGain,
          healed,
        });
      } else {
        entries.push({
          type: 'ability',
          text: `${attacker.name}'s ${ability.name} deals ${totalDamage} total damage.`,
          damage: 0,
          targetId: attacker.id,
        });
      }
      break;
    }

    case 'commanding_shout': {
      const durationTicks = Math.max(1, ability.durationTicks || 4);
      const damageBonusPct = Math.max(0, ability.damageBonusPct || ability.damagePct || 0);
      const attackSpeedBonusPct = Math.max(0, ability.attackSpeedBonusPct || ability.speedBonusPct || 0);
      const targets = livingUniqueTargets([attacker, ...(context.allies || [])]);
      for (const target of targets) {
        target.activeEffects = (target.activeEffects || []).filter(effect =>
          effect.sourceAbilityId !== ability.id
          || (effect.type !== 'damage_bonus_pct_buff' && effect.type !== 'attack_speed_buff'));
        if (damageBonusPct > 0) {
          target.activeEffects.push({
            type: 'damage_bonus_pct_buff',
            value: damageBonusPct,
            remainingTicks: durationTicks,
            sourceAbilityId: ability.id,
            sourceAbilityName: ability.name,
          });
        }
        if (attackSpeedBonusPct > 0) {
          target.activeEffects.push({
            type: 'attack_speed_buff',
            value: attackSpeedBonusPct,
            remainingTicks: durationTicks,
            sourceAbilityId: ability.id,
            sourceAbilityName: ability.name,
          });
        }
      }
      const targetNames = targets.map(target => target.name).join(' and ') || attacker.name;
      entries.push({
        type: 'buff',
        text: `${attacker.name} uses ${ability.name}: ${targetNames} gain +${damageBonusPct}% damage and +${attackSpeedBonusPct}% attack speed for ${durationTicks} seconds.`,
        damage: 0,
        targetId: attacker.id,
      });
      break;
    }

    case 'spell_attack': {
      const variance = Math.floor(rng() * 5);
      const base = Math.max(1, (attacker.spellDamage ?? attacker.damage ?? 0) + variance);
      const rawSpellDamage = ability.damage != null
        ? ability.damage
        : Math.floor(base * (ability.damageMult || 1));
      const spellPower = spellDamage(attacker, rawSpellDamage);
      const element = ability.element || ability.damageElement || 'magic';
      const damage = resolveSpellDamage(spellPower, defender, element);
      const applied = applyCombatantDamage(defender, damage);
      const elementLabel = element !== 'magic' ? ` ${element}` : '';
      const absorbedText = applied.absorbed > 0 ? ` (${applied.absorbed} absorbed)` : '';
      const text = attacker.isPlayer
        ? `${ability.name}: ${applied.damage}${elementLabel} spell damage${absorbedText}!`
        : `${attacker.name} casts ${ability.name} for ${applied.damage}${elementLabel} damage${absorbedText}!`;
      entries.push({ type: 'ability', text, damage: applied.damage, absorbed: applied.absorbed, element });
      if (applied.damage > 0) tryApplyAbilityBurning(attacker, defender, ability, entries, rng);
      tryApplyDaze(attacker, defender, tick, rng, entries);
      break;
    }

    case 'channeled_spell': {
      entries.push({
        type: 'ability',
        text: attacker.isPlayer ? `${ability.name}: channel complete.` : `${attacker.name} completes ${ability.name}.`,
        damage: 0,
      });
      break;
    }

    case 'stagger_spell': {
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'stagger');
      defender.activeEffects.push({
        type: 'stagger',
        remainingTicks: ability.durationTicks || 2,
        attacksRemaining: ability.attacks || ability.attacksRemaining || 2,
        missPenalty: ability.missPenalty || 35,
      });
      const text = attacker.isPlayer
        ? `${ability.name}: ${defender.name} is staggered for ${ability.attacks || ability.attacksRemaining || 2} auto attacks.`
        : `${attacker.name} casts ${ability.name}. You are staggered for ${ability.attacks || ability.attacksRemaining || 2} auto attacks.`;
      entries.push({ type: 'stagger', text, damage: 0 });
      break;
    }

    case 'stun_spell': {
      const stunTicks = ability.stunTicks || ability.stunDurationTicks || ability.stunSeconds || 2;
      defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + stunTicks);
      const text = attacker.isPlayer
        ? `${ability.name}: ${defender.name} is stunned for ${stunTicks} seconds.`
        : `${attacker.name} uses ${ability.name}. You are stunned for ${stunTicks} seconds.`;
      entries.push({ type: 'stun', text, damage: 0 });
      break;
    }

    case 'attack_speed_slow': {
      const attacks = ability.attacks || ability.attacksRemaining || 3;
      const penalty = ability.attackSpeedPenaltyPct || ability.value || 40;
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'attack_speed_slow');
      defender.activeEffects.push({
        type: 'attack_speed_slow',
        attacksRemaining: attacks,
        attackSpeedPenaltyPct: penalty,
        sourceAbilityId: ability.id,
      });
      entries.push({
        type: 'slow',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name}'s attack speed is slowed by ${penalty}% for ${attacks} auto attacks.`
          : `${attacker.name} uses ${ability.name}. Your attack speed is slowed by ${penalty}% for ${attacks} auto attacks.`,
        damage: 0,
      });
      break;
    }

    case 'web_snare': {
      const durationTicks = ability.durationTicks ?? 2;
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'web_snare');
      defender.activeEffects.push({
        type: 'web_snare',
        remainingTicks: durationTicks,
        sourceAbilityId: ability.id,
      });
      entries.push({
        type: 'web_snare',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} is caught in sticky webbing and cannot attack for ${durationTicks}s.`
          : `${attacker.name} uses ${ability.name}. Sticky webbing snares you — you cannot attack for ${durationTicks}s!`,
        damage: 0,
      });
      break;
    }

    case 'poison_spit': {
      const spellDmg = attacker.spellDamage ?? attacker.damage ?? 0;
      const rawDmg = Math.max(1, Math.floor(spellDmg * (ability.damageMult || 1.0)));
      const poisonResist = defender.poisonResist || 0;
      let spitDmg = rawDmg;
      if (defender.inCocoon) {
        spitDmg = Math.max(1, Math.floor(rawDmg * 0.05));
        defender.cocoonDamageTaken = (defender.cocoonDamageTaken || 0) + spitDmg;
      }
      const actualDmg = Math.max(1, Math.floor(spitDmg * Math.max(0, 1 - poisonResist / 100)));
      defender.hp = Math.max(0, defender.hp - actualDmg);
      entries.push({
        type: 'spell',
        text: attacker.isPlayer
          ? `${ability.name} hits ${defender.name} for ${actualDmg} poison damage.`
          : `${attacker.name} uses ${ability.name}, spraying ${actualDmg} corrosive venom at you.`,
        damage: actualDmg,
        damageType: 'poison',
      });
      if (ability.usesBroodVenom) {
        const damagePct = ability.broodVenomDamagePct || 0.65;
        const existingIdx = (defender.activeEffects || []).findIndex(e => e.type === 'brood_venom');
        if (existingIdx >= 0) {
          const existing = defender.activeEffects[existingIdx];
          const newStacks = Math.min(5, (existing.stacks || 1) + 1);
          defender.activeEffects.splice(existingIdx, 1);
          defender.activeEffects.push({ ...existing, stacks: newStacks, remainingTicks: 3, damagePctPerTick: damagePct });
          entries.push({ type: 'poison', text: attacker.isPlayer ? `${defender.name} suffers Brood Venom (${newStacks}/5 stacks).` : `Brood Venom intensifies (${newStacks}/5 stacks)!`, damage: 0 });
        } else {
          defender.activeEffects.push({ type: 'brood_venom', stacks: 1, remainingTicks: 3, damagePctPerTick: damagePct });
          entries.push({ type: 'poison', text: attacker.isPlayer ? `${defender.name} suffers Brood Venom (1/5 stacks).` : `You suffer Brood Venom (1/5 stacks)!`, damage: 0 });
        }
      } else {
        const poisonChance = ability.poisonChance ?? 60;
        if (rng() * 100 < poisonChance) {
          const pDamagePct = ability.poisonDamagePct ?? 0.55;
          const pDuration = ability.poisonDuration ?? 3;
          const existing = (defender.activeEffects || []).find(e => e.type === 'poison');
          if (existing) {
            existing.remainingTicks = Math.max(existing.remainingTicks || 0, pDuration);
            existing.damagePctPerTick = Math.max(existing.damagePctPerTick || 0, pDamagePct);
          } else {
            (defender.activeEffects = defender.activeEffects || []).push({ type: 'poison', remainingTicks: pDuration, damagePctPerTick: pDamagePct, stacks: 1 });
          }
          entries.push({ type: 'poison', text: attacker.isPlayer ? `${defender.name} is poisoned.` : `You are poisoned.`, damage: 0 });
        }
      }
      break;
    }

    case 'counter_buff': {
      const counterBonus = ability.counterBonus ?? ability.counterChanceBonus ?? 0;
      attacker.activeEffects.push({
        type: 'counter_chance_buff',
        bonus: counterBonus,
        remainingTicks: ability.durationTicks,
        visual: ability.visual || null,
        sourceAbilityId: ability.id,
      });
      attacker.counterChanceBonus = (attacker.counterChanceBonus || 0) + counterBonus;
      const text = attacker.isPlayer
        ? `${ability.name}: +${counterBonus}% counter chance for ${ability.durationTicks} ticks.`
        : `${attacker.name} uses ${ability.name}.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'guard_stance': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(effect => effect.type !== 'block_chance_buff');
      attacker.activeEffects.push({
        type: 'block_chance_buff',
        value: ability.blockChanceBonus || 0,
        blockPowerRegenBonus: ability.blockPowerRegenBonus || 0,
        remainingTicks: ability.durationTicks || 3,
        visual: ability.visual || null,
        sourceAbilityId: ability.id,
      });
      const text = attacker.isPlayer
        ? `${ability.name}: +${ability.blockChanceBonus || 0}% block chance for ${ability.durationTicks || 3} ticks.`
        : `${attacker.name} raises a guard.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'shield_wall': {
      const durationTicks = ability.durationTicks || 5;
      attacker.activeEffects = (attacker.activeEffects || []).filter(effect => effect.sourceAbilityId !== ability.id);
      attacker.activeEffects.push(
        {
          type: 'block_chance_buff',
          value: ability.blockChanceBonus || 35,
          remainingTicks: durationTicks,
          sourceAbilityId: ability.id,
        },
        {
          type: 'block_power_recovery_pct',
          value: ability.blockPowerRecoveryPct || 50,
          remainingTicks: durationTicks,
          sourceAbilityId: ability.id,
        },
        {
          type: 'damage_taken_reduction',
          reductionPct: ability.damageReductionPct || ability.physicalReductionPct || ability.reductionPct || 20,
          remainingTicks: durationTicks,
          sourceAbilityId: ability.id,
        },
        {
          type: 'damage_bonus_pct_buff',
          value: ability.damageDealtPct ?? -20,
          remainingTicks: durationTicks,
          sourceAbilityId: ability.id,
        },
      );
      const text = attacker.isPlayer
        ? `${ability.name}: shield raised for ${durationTicks} seconds. +${ability.blockChanceBonus || 35}% block chance, +${ability.blockPowerRecoveryPct || 50}% Block Power recovery, ${ability.damageReductionPct || ability.physicalReductionPct || ability.reductionPct || 20}% less damage taken, and ${Math.abs(ability.damageDealtPct ?? -20)}% less damage dealt.`
        : `${attacker.name} raises a shield wall.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'shield_up': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'shield_up');
      attacker.activeEffects.push({
        type: 'shield_up',
        attacksRemaining: ability.attacksBlocked || 1,
        counterDamageMult: ability.counterDamageMult || 0.5,
        sourceAbilityId: ability.id,
      });
      const text = attacker.isPlayer
        ? `${ability.name}: your next incoming auto attack will be fully blocked without spending Block Power, then you counter for ${Math.round((ability.counterDamageMult || 0.5) * 100)}% weapon damage.`
        : `${attacker.name} raises a shield.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'guard_instinct': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'incoming_auto_block_chance_buff');
      attacker.activeEffects.push({
        type: 'incoming_auto_block_chance_buff',
        value: ability.blockChanceBonus || 10,
        attacksRemaining: ability.attacksReceived || 3,
        sourceAbilityId: ability.id,
      });
      const recoverAmount = Math.max(0, Math.floor((attacker.blockPowerMax || 0) * (ability.blockPowerRecoverPct || 50) / 100));
      const before = Math.max(0, attacker.blockPower || 0);
      attacker.blockPower = Math.min(attacker.blockPowerMax || 0, before + recoverAmount);
      const recovered = Math.max(0, (attacker.blockPower || 0) - before);
      const text = attacker.isPlayer
        ? `${ability.name}: recover ${recovered} Block Power and gain +${ability.blockChanceBonus || 10}% block chance for the next ${ability.attacksReceived || 3} incoming auto attacks.`
        : `${attacker.name} follows the block with Guard Instinct.`;
      entries.push({ type: 'ability', text, damage: 0, recovered });
      break;
    }

    case 'mace_mastery': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.sourceAbilityId !== ability.id);
      attacker.activeEffects.push({
        type: 'mace_mastery',
        chargesLeft: ability.chargesGranted || 4,
        staggerChanceBonus: ability.staggerChanceBonus || 10,
        staggerDuration: ability.staggerDuration || 2,
        staggerAttacks: ability.staggerAttacks || 2,
        staggerMissPenalty: ability.staggerMissPenalty || 35,
        dazeChanceBonus: ability.dazeChanceBonus || 10,
        dazeDuration: ability.dazeDuration || 2,
        missSpellChance: ability.missSpellChance || 50,
        sourceAbilityId: ability.id,
      });
      const text = attacker.isPlayer
        ? `${ability.name}: next ${ability.chargesGranted || 4} auto attacks gain +${ability.staggerChanceBonus || 10}% Stagger and +${ability.dazeChanceBonus || 10}% Daze chance.`
        : `${attacker.name} enters Mace Mastery.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'heavy_strikes': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'heavy_strikes');
      attacker.activeEffects.push({
        type: 'heavy_strikes',
        chargesLeft: ability.chargesGranted || 3,
        damageBonusPct: ability.damageBonusPct || 20,
        sourceAbilityId: ability.id,
      });
      const charges = ability.chargesGranted || 3;
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: next ${charges} auto attacks deal +${ability.damageBonusPct || 20}% damage.`
          : `${attacker.name} readies heavier strikes.`,
        damage: 0,
      });
      break;
    }

    case 'parry_guard': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'parry_guard');
      attacker.activeEffects.push({
        type: 'parry_guard',
        attacksRemaining: ability.attacksReceived || 2,
        parryChanceBonus: ability.parryChanceBonus || 50,
        sourceAbilityId: ability.id,
      });
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: +${ability.parryChanceBonus || 50}% parry chance for the next ${ability.attacksReceived || 2} incoming attacks.`
          : `${attacker.name} prepares to parry.`,
        damage: 0,
      });
      break;
    }

    case 'berserker_stance': {
      const activeIdx = (attacker.activeEffects || []).findIndex(effect =>
        effect.type === 'berserker_stance'
        && effect.active !== false
        && (effect.remainingTicks == null || effect.remainingTicks > 0));
      if (activeIdx >= 0) {
        attacker.activeEffects = (attacker.activeEffects || []).filter((_, index) => index !== activeIdx);
        const deactivateCooldown = ability.deactivateCooldownTicks ?? ability.deactivateCooldownSeconds ?? 3;
        if (context.procState) context.procState.rage = 0;
        attacker.abilityCooldowns = {
          ...(attacker.abilityCooldowns || {}),
          [ability.id]: tick + Math.max(0, Math.ceil(deactivateCooldown)),
        };
        entries.push({
          type: 'ability',
          text: attacker.isPlayer
            ? `${ability.name}: stance released, draining all Rage. You can re-enter it in ${Math.max(0, Math.ceil(deactivateCooldown))} seconds.`
            : `${attacker.name} releases ${ability.name}.`,
          damage: 0,
        });
        break;
      }

      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'berserker_stance');
      attacker.activeEffects.push({
        type: 'berserker_stance',
        damageDealtPct: ability.damageDealtPct || ability.damageBonusPct || 30,
        damageTakenPct: ability.damageTakenPct || 30,
        disableBlock: ability.disableBlock !== false,
        active: true,
        sourceAbilityId: ability.id,
      });
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: +${ability.damageDealtPct || ability.damageBonusPct || 30}% damage dealt, +${ability.damageTakenPct || 30}% damage taken, blocks disabled.`
          : `${attacker.name} enters Berserker Stance.`,
        damage: 0,
      });
      break;
    }

    case 'burnout': {
      const procState = context.procState;
      const stacks = Math.max(0, Math.floor(procState?.momentumStacks || 0));
      if (!procState || stacks < (ability.requiredMomentumStacks || 3)) {
        entries.push({
          type: 'ability_fail',
          text: `${ability.name}: requires at least ${ability.requiredMomentumStacks || 3} Momentum stacks.`,
          damage: 0,
        });
        break;
      }

      procState.momentumStacks = 0;
      procState.momentumMaxHeldTicks = 0;
      let totalDmg = 0;
      const damageMultPerStack = ability.damageMultPerStack ?? 0.25;
      const weaponDamageBase = getWeaponDamageAbilityBase(attacker, rng);
      const rawStackDamage = Math.max(1, Math.floor(weaponDamageBase * damageMultPerStack * stacks));
      const boostedDamage = applyWeaponDamageAbilityBonuses(attacker, defender, rawStackDamage);
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, boostedDamage), rng, ability);
      const dodgedHits = result.dodged ? stacks : 0;
      const landedHits = result.dodged ? 0 : stacks;
      const blockedHits = result.blocked ? 1 : 0;
      if (!result.dodged) {
        defender.hp = Math.max(0, defender.hp - result.damage);
        totalDmg += result.damage;
      }
      const avoidedText = dodgedHits > 0 ? ` ${dodgedHits} miss${dodgedHits !== 1 ? 'es' : ''}.` : '';
      const blockedText = blockedHits > 0 ? ` ${blockedHits} blocked.` : '';
      entries.push({
        type: blockedHits > 0 && landedHits === blockedHits ? 'blocked' : 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: consumed ${stacks} Momentum for ${landedHits} hit${landedHits !== 1 ? 's' : ''}, dealing ${totalDmg} total damage.${blockedText}${avoidedText}`
          : `${attacker.name}'s ${ability.name} deals ${totalDmg} total damage.`,
        damage: totalDmg,
      });
      break;
    }

    case 'en_garde': {
      const durationTicks = ability.durationTicks || 3;
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'en_garde');
      attacker.activeEffects.push({
        type: 'en_garde',
        remainingTicks: durationTicks,
        parryChance: ability.parryChance || 100,
        bladeStackMultiplier: ability.bladeStackMultiplier || 1,
        sourceAbilityId: ability.id,
      });
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: parry chance is 100% for ${durationTicks} seconds.`
          : `${attacker.name} enters ${ability.name}.`,
        damage: 0,
      });
      break;
    }

    case 'grudge_release': {
      const procState = context.procState;
      const stored = Math.max(0, Math.floor(procState?.grudge || 0));
      if (!procState || stored < (ability.requiredGrudge || 1)) {
        entries.push({
          type: 'ability_fail',
          text: `${ability.name}: requires stored Grudge.`,
          damage: 0,
        });
        break;
      }

      procState.grudge = 0;
      const applied = applyCombatantDamage(defender, stored);
      const absorbedText = applied.absorbed > 0 ? ` (${applied.absorbed} absorbed)` : '';
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: released ${stored} stored Grudge for ${applied.damage} raw damage${absorbedText}.`
          : `${attacker.name} releases Grudge for ${applied.damage} damage${absorbedText}.`,
        damage: applied.damage,
        absorbed: applied.absorbed,
      });
      break;
    }

    case 'open_vein': {
      applyDirectBleedStacks(attacker, defender, ability, entries, context.heroConditions);
      break;
    }

    case 'shadow_veil': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'shadow_veil');
      attacker.activeEffects.push({
        type: 'shadow_veil',
        attacksRemaining: ability.attacksReceived || 3,
        evasionChanceBonus: ability.evasionChanceBonus || 20,
        counterDamageMult: ability.counterDamageMult || 0.5,
        sourceAbilityId: ability.id,
      });
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: +${ability.evasionChanceBonus || 20}% Evasion for the next ${ability.attacksReceived || 3} incoming auto attacks.`
          : `${attacker.name} fades into shadow.`,
        damage: 0,
      });
      break;
    }

    case 'rapid_fire': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'rapid_fire');
      attacker.activeEffects.push({
        type: 'rapid_fire',
        chargesLeft: ability.chargesGranted || 3,
        attackSpeedBonusPct: ability.attackSpeedBonusPct || 40,
        critAddsCharge: ability.critAddsCharge || 0,
        sourceAbilityId: ability.id,
      });
      const charges = ability.chargesGranted || 3;
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: next ${charges} auto attacks gain +${ability.attackSpeedBonusPct || 40}% attack speed. Critical strikes add ${ability.critAddsCharge || 0} auto attack.`
          : `${attacker.name} draws faster.`,
        damage: 0,
      });
      break;
    }

    case 'hunter_mark': {
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'hunter_mark');
      defender.activeEffects.push({
        type: 'hunter_mark',
        remainingTicks: ability.markTicks || 3,
        autoDamageBonusPct: ability.autoDamageBonusPct || 30,
        autoCritBonusPct: ability.autoCritBonusPct || 10,
      });
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} is marked for ${ability.markTicks || 3} ticks.`
          : `${attacker.name} marks you.`,
        damage: 0,
      });
      break;
    }

    case 'bear_trap': {
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'bear_trap');
      const durationTicks = ability.durationTicks || 6;
      const trapUpgrade = (attacker.passiveEffects || [])
        .find(effect => effect.type === 'bear_trap_upgrade') || null;
      const staggerAttacks = Math.max(0, trapUpgrade?.staggerAttacks || trapUpgrade?.attacks || 0);
      defender.activeEffects.push({
        type: 'bear_trap',
        remainingTicks: durationTicks,
        breaksOnAutoAttack: ability.breaksOnAutoAttack !== false,
        allowRangedAutoAttacks: ability.allowRangedAutoAttacks === true,
        triggerStunTicks: ability.triggerStunTicks || 2,
        bossTriggerStunTicks: ability.bossTriggerStunTicks || 1,
        staggerAttacks,
        staggerDurationTicks: trapUpgrade?.staggerDurationTicks || trapUpgrade?.durationTicks || staggerAttacks,
        staggerMissPenalty: trapUpgrade?.missPenalty || 35,
        upgradeSource: trapUpgrade?.source || null,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      entries.push({
        type: 'trap',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} is trapped. Its next auto attack will be stopped.`
          : `${attacker.name} traps you.`,
        damage: 0,
      });
      break;
    }

    case 'barbed_trap': {
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'barbed_trap');
      defender.activeEffects.push({
        type: 'barbed_trap',
        remainingTicks: ability.durationTicks || 8,
        bleedDurationTicks: ability.bleedDurationTicks || ability.bleedDuration || 5,
        bleedDamagePct: ability.bleedDamagePct || 2,
        attackSpeedPenaltyPct: ability.attackSpeedPenaltyPct || 20,
        slowDurationTicks: ability.slowDurationTicks || 4,
        poisonStaggerAttacks: ability.poisonStaggerAttacks || 1,
        poisonStaggerDurationTicks: ability.poisonStaggerDurationTicks || 2,
        poisonStaggerMissPenalty: ability.poisonStaggerMissPenalty || 35,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      entries.push({
        type: 'trap',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} is caught in a barbed trap. Its next auto attack will trigger the barbs.`
          : `${attacker.name} sets ${ability.name}.`,
        damage: 0,
      });
      break;
    }

    case 'stagger_shot': {
      const attackerIsPlayerSide = isPlayerSideCombatant(attacker);
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const raw = Math.max(1, Math.floor(base * (ability.damageMult || 1.1)));
      const dmg = applyWeaponDamageAbilityBonuses(attacker, defender, raw);
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), rng);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attackerIsPlayerSide ? `${defender.name} dodges ${ability.name}!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const text = attacker.isPlayer
          ? `${ability.name}: ${result.damage} damage!`
          : `${attacker.name} lands ${ability.name} for ${result.damage}!`;
        entries.push({ type: result.blocked ? 'blocked' : 'ability', text, damage: result.damage, absorbed: result.absorbed || 0 });
        if (defender.hp > 0 && rng() * 100 < (ability.staggerChance || 20)) {
          defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'stagger');
          defender.activeEffects.push({ type: 'stagger', remainingTicks: ability.staggerDuration || 2, attacksRemaining: ability.staggerDuration || 2, missPenalty: 35 });
          entries.push({ type: 'stagger', text: attackerIsPlayerSide ? `Status: ${defender.name} gains Staggered.` : `Status: You are Staggered.`, damage: 0 });
        }
        if (defender.hp > 0 && result.damage > 0) {
          tryApplyAbilityBleed(attacker, defender, ability, tick, rng, entries, context.heroConditions);
        }
      }
      break;
    }

    case 'power_shot': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const raw = Math.max(1, Math.floor(base * (ability.damageMult || 2)));
      const boosted = applyWeaponDamageAbilityBonuses(attacker, defender, raw);
      const critChance = getAbilityCritChance(attacker, defender);
      const isCrit = critChance > 0 && rng() * 100 < critChance;
      const finalDmg = isCrit ? Math.floor(boosted * (attacker.critMult || 2)) : boosted;
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, finalDmg), rng, ability);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges ${ability.name}!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        if (isCrit && ability.critCooldownReductionPct > 0 && attacker.abilityCooldowns?.[ability.id] != null) {
          const remaining = Math.max(0, attacker.abilityCooldowns[ability.id] - tick);
          attacker.abilityCooldowns[ability.id] = tick + Math.ceil(remaining * (1 - ability.critCooldownReductionPct / 100));
        }
        defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'power_shot_armor_break');
        defender.activeEffects.push({
          type: 'power_shot_armor_break',
          attacksRemaining: ability.armorBreakAttacks || 2,
          armorPenPct: ability.armorPenPct || 30,
        });
        const suffix = isCrit ? ' (CRIT!)' : result.blocked ? ' (blocked)' : '';
        entries.push({ type: isCrit ? 'crit' : result.blocked ? 'blocked' : 'ability', text: attacker.isPlayer ? `${ability.name}${suffix}: ${result.damage} damage!` : `${attacker.name} lands ${ability.name}${suffix} for ${result.damage}!`, damage: result.damage, isCrit, absorbed: result.absorbed || 0 });
        entries.push({ type: 'armor', text: attacker.isPlayer ? `Status: ${defender.name}'s armor is exposed for your next ${ability.armorBreakAttacks || 2} auto attacks.` : `Status: Your armor is exposed.`, damage: 0 });
      }
      break;
    }

    case 'covering_fire': {
      const hits = Math.max(1, Math.floor(ability.hits || 3));
      const damageMult = ability.damageMult || 0.4;
      let totalDmg = 0;
      let landedHits = 0;
      // Emit a separate entry per arrow so all arrows produce their own hit-splat in the same
      // tick — the renderer spreads same-tick splats apart, so the burst shows 3 splashes at once
      // instead of a single combined number.
      for (let i = 0; i < hits; i += 1) {
        if (!defender || defender.hp <= 0) break;
        const variance = Math.floor(rng() * 4);
        const base = Math.max(1, attacker.damage + variance);
        const raw = Math.max(1, Math.floor(base * damageMult));
        const boosted = applyWeaponDamageAbilityBonuses(attacker, defender, raw);
        const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, boosted), rng, ability);
        if (result.dodged) {
          entries.push({
            type: 'dodged',
            text: attacker.isPlayer
              ? `${ability.name}: ${defender.name} avoids arrow ${i + 1}.`
              : `${attacker.name}'s arrow ${i + 1} misses.`,
            damage: 0,
            targetId: defender.id,
          });
          continue;
        }
        const applied = applyCombatantDamage(defender, result.damage);
        totalDmg += applied.damage;
        landedHits += 1;
        entries.push({
          type: result.blocked ? 'blocked' : 'ability',
          text: attacker.isPlayer
            ? `${ability.name}: arrow ${i + 1} hits for ${applied.damage}${result.blocked ? ' (blocked)' : ''}.`
            : `${attacker.name}'s ${ability.name} arrow ${i + 1} hits for ${applied.damage}.`,
          damage: applied.damage,
          absorbed: applied.absorbed || 0,
          targetId: defender.id,
        });
      }
      if ((ability.forceMissAttacks || 0) > 0 && defender?.hp > 0) {
        defender.activeEffects = (defender.activeEffects || [])
          .filter(effect => effect.type !== 'force_next_auto_miss');
        defender.activeEffects.push({
          type: 'force_next_auto_miss',
          attacksRemaining: ability.forceMissAttacks || 1,
          sourceAbilityId: ability.id,
          sourceAbilityName: ability.name,
        });
        if (attacker.isPlayer) {
          // damage:0 → no extra splat; this line only summarises the snare in the combat log.
          entries.push({
            type: 'ability',
            text: `${ability.name}: ${landedHits}/${hits} arrows landed (${totalDmg} total). ${defender.name}'s next auto attack will miss.`,
            damage: 0,
            targetId: defender.id,
          });
        }
      }
      break;
    }

    case 'headshot': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const raw = Math.max(1, Math.floor(base * (ability.damageMult || 2.8)));
      const boosted = applyWeaponDamageAbilityBonuses(attacker, defender, raw);
      const critChance = getAbilityCritChance(attacker, defender);
      const isCrit = critChance > 0 && rng() * 100 < critChance;
      const critMult = (attacker.critMult || 1.5) * (1 + getAbilityCritDamageBonusPct(attacker) / 100);
      const finalDmg = isCrit ? Math.max(1, Math.floor(boosted * critMult)) : boosted;
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, finalDmg), rng, ability);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges your ${ability.name}!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        const applied = applyCombatantDamage(defender, result.damage);
        const suffix = isCrit ? ' (CRIT!)' : result.blocked ? ' (blocked)' : '';
        entries.push({
          type: isCrit ? 'crit' : result.blocked ? 'blocked' : 'ability',
          text: attacker.isPlayer ? `${ability.name}${suffix}: ${applied.damage} damage!` : `${attacker.name} lands ${ability.name}${suffix} for ${applied.damage}!`,
          damage: applied.damage,
          absorbed: (result.absorbed || 0) + (applied.absorbed || 0),
          isCrit,
        });
        if (isCrit && applied.damage > 0 && (ability.stunOnCritTicks || 0) > 0) {
          const stunTicks = ability.stunOnCritTicks;
          defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + stunTicks);
          entries.push({
            type: 'stun',
            text: `${ability.name}: ${defender.name} is stunned for ${stunTicks} seconds.`,
            damage: 0,
          });
        }
      }
      break;
    }

    case 'aimed_shot': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const raw = Math.max(1, Math.floor(base * (ability.damageMult || 1.5)));
      const dmg = applyWeaponDamageAbilityBonuses(attacker, defender, raw);
      const critChance = getAbilityCritChance(attacker, defender, ability.critChanceBonus || 0);
      const isCrit = critChance > 0 && rng() * 100 < critChance;
      const finalDmg = isCrit ? Math.floor(dmg * (attacker.critMult || 1.5)) : dmg;
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, finalDmg), rng, ability);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges ${ability.name}!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const suffix = isCrit ? ' (CRIT!)' : result.blocked ? ' (blocked)' : '';
        entries.push({
          type: isCrit ? 'crit' : result.blocked ? 'blocked' : 'ability',
          text: attacker.isPlayer ? `${ability.name}${suffix}: ${result.damage} damage!` : `${attacker.name} lands ${ability.name}${suffix} for ${result.damage}!`,
          damage: result.damage,
          isCrit,
          absorbed: result.absorbed || 0,
        });
      }
      break;
    }

    case 'hemorrhaging_shot': {
      const attackerIsPlayerSide = isPlayerSideCombatant(attacker);
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const raw = Math.max(1, Math.floor(base * (ability.damageMult || 1.3)));
      const dmg = applyWeaponDamageAbilityBonuses(attacker, defender, raw);
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), rng);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attackerIsPlayerSide ? `${defender.name} dodges ${ability.name}!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        entries.push({ type: result.blocked ? 'blocked' : 'ability', text: attackerIsPlayerSide ? `${ability.name}: ${result.damage} damage!` : `${attacker.name} lands ${ability.name} for ${result.damage}!`, damage: result.damage, absorbed: result.absorbed || 0 });
        if (result.damage <= 0) break;
        if (isBleedImmune(defender)) {
          entries.push({ type: 'immune', text: attackerIsPlayerSide ? `${defender.name} is immune to Hemorrhage.` : 'You are immune to Hemorrhage.', damage: 0 });
          break;
        }
        defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'hemorrhage');
        defender.activeEffects.push({ type: 'hemorrhage', remainingTicks: applyBleedDurationBonus(attacker, ability.hemorrhageDuration || 3), damagePctPerTick: applyBleedDamageBonus(attacker, ability.hemorrhageDamagePct || 3) });
        entries.push({ type: 'hemorrhage', text: attackerIsPlayerSide ? `Status: ${defender.name} gains Hemorrhage.` : `Status: You gain Hemorrhage.`, damage: 0 });
      }
      break;
    }

    case 'riposte': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = Math.max(1, Math.floor(base * (ability.damageMult || 1.8)));
      const critChance = getAbilityCritChance(attacker, defender, ability.critChanceBonus || 20);
      const isCrit = critChance > 0 && rng() * 100 < critChance;
      const finalDmg = isCrit ? Math.floor(dmg * (attacker.critMult || 2)) : dmg;
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, finalDmg), rng, ability);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges ${ability.name}!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const suffix = isCrit ? ' (CRIT!)' : result.blocked ? ' (blocked)' : '';
        const text = attacker.isPlayer
          ? `${ability.name}${suffix}: ${result.damage} damage!`
          : `${attacker.name} uses ${ability.name}${suffix} for ${result.damage}!`;
        entries.push({ type: isCrit ? 'crit' : result.blocked ? 'blocked' : 'ability', text, damage: result.damage, isCrit, absorbed: result.absorbed || 0 });
        if (defender.hp > 0 && result.damage > 0) tryApplyAbilityBurning(attacker, defender, ability, entries, rng);
        if (defender.hp > 0 && result.damage > 0) tryApplyAbilityStagger(attacker, defender, ability, entries);
        tryApplyDaze(attacker, defender, tick, rng, entries);
      }
      break;
    }

    case 'crushing_blow': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = Math.max(1, Math.floor(base * (ability.damageMult || 1.5)));
      const critChance = getAbilityCritChance(attacker, defender, ability.critChanceBonus ?? 25);
      const isCrit = critChance > 0 && rng() * 100 < critChance;
      const finalDmg = isCrit ? Math.floor(dmg * (attacker.critMult || 2)) : dmg;
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, finalDmg), rng, ability);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges ${ability.name}!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        if (isCrit && ability.critCooldownReductionPct > 0 && attacker.abilityCooldowns?.[ability.id] != null) {
          const remaining = Math.max(0, attacker.abilityCooldowns[ability.id] - tick);
          attacker.abilityCooldowns[ability.id] = tick + Math.ceil(remaining * (1 - ability.critCooldownReductionPct / 100));
        }
        const suffix = isCrit ? ' (CRIT!)' : result.blocked ? ' (blocked)' : '';
        const text = attacker.isPlayer
          ? `${ability.name}${suffix}: ${result.damage} damage!`
          : `${attacker.name} uses ${ability.name}${suffix} for ${result.damage}!`;
        entries.push({ type: isCrit ? 'crit' : result.blocked ? 'blocked' : 'ability', text, damage: result.damage, isCrit, absorbed: result.absorbed || 0 });
        if (result.damage > 0 && (ability.stunTicks || ability.stunDurationTicks || ability.stunSeconds)) {
          const stunTicks = ability.stunTicks || ability.stunDurationTicks || ability.stunSeconds || 2;
          defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + stunTicks);
          entries.push({
            type: 'stun',
            text: attacker.isPlayer
              ? `${ability.name}: ${defender.name} is stunned for ${stunTicks} seconds.`
              : `${attacker.name}'s ${ability.name} stuns you for ${stunTicks} seconds.`,
            damage: 0,
          });
        }
        if (defender.hp > 0 && result.damage > 0) tryApplyAbilityBurning(attacker, defender, ability, entries, rng);
        if (defender.hp > 0 && result.damage > 0) tryApplyAbilityStagger(attacker, defender, ability, entries);
        tryApplyDaze(attacker, defender, tick, rng, entries);
      }
      break;
    }

    case 'weapon_throw': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = Math.max(1, Math.floor(base * (ability.damageMult || 2)));
      const critChance = getAbilityCritChance(attacker, defender, ability.critChanceBonus ?? 20);
      const isCrit = critChance > 0 && rng() * 100 < critChance;
      const finalDmg = isCrit ? Math.floor(dmg * (attacker.critMult || 1.5)) : dmg;
      const result = resolvePhysicalImpact(attacker, defender, applyLowHpDamageBonuses(attacker, defender, finalDmg), rng);
      const postThrowMult = ability.postThrowDamageMult ?? 0.6;
      const reducedDamage = Math.max(1, Math.floor((attacker.baseDamage ?? attacker.damage ?? 1) * postThrowMult));
      attacker.damage = reducedDamage;
      attacker.activeEffects = (attacker.activeEffects || []).filter(effect => effect.sourceAbilityId !== ability.id);
      attacker.activeEffects.push({
        type: 'weapon_thrown',
        remainingTicks: 99999,
        damageMult: postThrowMult,
        sourceAbilityId: ability.id,
      });

      if (result.dodged) {
        entries.push({
          type: 'dodged',
          text: attacker.isPlayer
            ? `${defender.name} dodges ${ability.name}! Your damage is reduced for the rest of the fight.`
            : `You dodge ${attacker.name}'s thrown weapon! Its damage is reduced for the rest of the fight.`,
          damage: 0,
        });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const suffix = isCrit ? ' (CRIT!)' : result.blocked ? ' (blocked)' : '';
        entries.push({
          type: isCrit ? 'crit' : result.blocked ? 'blocked' : 'ability',
          text: attacker.isPlayer
            ? `${ability.name}${suffix}: ${result.damage} damage!`
            : `${attacker.name} hurls its weapon${suffix} for ${result.damage}! Its damage is reduced for the rest of the fight.`,
          damage: result.damage,
          isCrit,
          absorbed: result.absorbed || 0,
        });
      }
      break;
    }

    case 'execute': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const raw = Math.max(1, Math.floor(base * (ability.damageMult || 1.8)));
      const final = applyPhysicalArmor(attacker, applyLowHpDamageBonuses(attacker, defender, raw), defender);
      defender.hp = Math.max(0, defender.hp - final);
      entries.push({
        type: 'ability',
        text: attacker.isPlayer ? `Execute: ${final} guaranteed damage!` : `${attacker.name} executes for ${final}!`,
        damage: final,
      });
      break;
    }

    case 'sunder_armor': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'sunder_armor');
      attacker.activeEffects.push({
        type: 'sunder_armor',
        chargesLeft: ability.chargesGranted || 2,
        damageBonusPct: ability.damageBonusPct || 20,
        armorPenPct: ability.armorPenPct || 10,
      });
      const charges = ability.chargesGranted || 2;
      const text = attacker.isPlayer
        ? `Sunder Armor: next ${charges} attacks deal +${ability.damageBonusPct || 20}% damage and ignore ${ability.armorPenPct || 10}% armor.`
        : `${attacker.name} readies a sundering strike.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'weak_strike': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = spellDamage(attacker, Math.floor(base * (ability.damageMult || 2.2)));
      const boosted = applyDisruptedDamageBonus(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), tick);

      const targetIsStunned = tick <= (defender.stunUntilTick || -1);
      const targetIsDazed = (defender.activeEffects || []).some(e => e.type === 'daze' && e.remainingTicks > 0);
      const targetIsStaggered = (defender.activeEffects || []).some(e => e.type === 'stagger' && (e.remainingTicks > 0 || e.attacksRemaining > 0));

      let isCrit = false;
      let finalDmg = boosted;
      let stateLabel = '';

      if (targetIsStunned) {
        isCrit = true;
        finalDmg = Math.floor(boosted * (attacker.critMult || 1.5));
        stateLabel = 'stunned';
      } else if (targetIsDazed || targetIsStaggered) {
        const critChance = getAbilityCritChance(attacker, defender, ability.dazedStaggeredCritBonus || 50);
        isCrit = rng() * 100 < critChance;
        if (isCrit) finalDmg = Math.floor(boosted * (attacker.critMult || 1.5));
        stateLabel = targetIsDazed ? 'dazed' : 'staggered';
      }

      const result = resolvePhysicalImpact(attacker, defender, finalDmg, rng);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges Weak Strike!` : `You dodge Weak Strike!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const critText = isCrit ? ' CRITICAL' : '';
        const suffix = result.blocked ? ' (blocked)' : '';
        const text = attacker.isPlayer
          ? `Weak Strike (${stateLabel})${suffix}${critText}: ${result.damage} damage!`
          : `${attacker.name} lands Weak Strike for ${result.damage}!`;
        entries.push({ type: isCrit ? 'crit' : 'ability', text, damage: result.damage, isCrit, absorbed: result.absorbed || 0 });
      }
      break;
    }

    case 'armor_shatter': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = spellDamage(attacker, Math.floor(base * (ability.damageMult || 0.9)));
      const boosted = applyDisruptedDamageBonus(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), tick);
      const result = resolvePhysicalImpact(attacker, defender, boosted, rng);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges Armor Shatter!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const reduction = Math.floor(ability.armorReduction || 8);
        const armorImmune = hasArmorReductionImmunity(defender);
        if (!armorImmune) {
          defender.armor = Math.max(0, (defender.armor || 0) - reduction);
          defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'armor_shattered');
          defender.activeEffects.push({ type: 'armor_shattered', armorLost: reduction });
        }
        const suffix = result.blocked ? ' (blocked)' : '';
        if (armorImmune) {
          entries.push({
            type: 'ability',
            text: attacker.isPlayer
              ? `Armor Shatter${suffix}: ${result.damage} damage - ${defender.name}'s armor holds.`
              : `${attacker.name} shatters for ${result.damage}, but your armor holds!`,
            damage: result.damage,
            absorbed: result.absorbed || 0,
          });
          break;
        }
        entries.push({ type: 'ability', text: attacker.isPlayer ? `Armor Shatter${suffix}: ${result.damage} damage — ${defender.name} loses ${reduction} armor for this encounter!` : `${attacker.name} shatters your armor for ${result.damage}!`, damage: result.damage, absorbed: result.absorbed || 0 });
      }
      break;
    }

    case 'stunblow': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = spellDamage(attacker, Math.floor(base * (ability.damageMult || 1.3)));
      const boosted = applyDisruptedDamageBonus(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), tick);
      const result = resolvePhysicalImpact(attacker, defender, boosted, rng);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges Stunblow!` : `You dodge ${ability.name}!`, damage: 0 });
      } else if (result.blocked) {
        defender.hp = Math.max(0, defender.hp - result.damage);
        entries.push({ type: 'blocked', text: attacker.isPlayer ? `Stunblow blocked ${result.absorbed || 0}. You deal ${result.damage} — no stun.` : `You block ${ability.name}: ${result.damage} taken, no stun.`, damage: result.damage, absorbed: result.absorbed || 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const stunned = rng() * 100 < (ability.stunChance || 60);
        if (stunned) defender.stunUntilTick = tick + (ability.stunTicks || 1);
        entries.push({ type: stunned ? 'stun' : 'ability', text: attacker.isPlayer ? `Stunblow: ${result.damage} damage${stunned ? ` — ${defender.name} is stunned!` : '.'}` : `${attacker.name} uses ${ability.name} for ${result.damage}${stunned ? '! You are stunned!' : '.'}`, damage: result.damage });
      }
      break;
    }

    case 'pummel_strike': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = spellDamage(attacker, Math.floor(base * (ability.damageMult || 0.75)));
      const boosted = applyDisruptedDamageBonus(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), tick);
      const result = resolvePhysicalImpact(attacker, defender, boosted, rng);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges ${ability.name}!` : `You dodge ${ability.name}!`, damage: 0 });
      } else if (result.blocked) {
        defender.hp = Math.max(0, defender.hp - result.damage);
        entries.push({ type: 'blocked', text: attacker.isPlayer ? `${ability.name} is blocked for ${result.absorbed || 0}. You deal ${result.damage} - no stun.` : `You block ${ability.name}: ${result.damage} taken, no stun.`, damage: result.damage, absorbed: result.absorbed || 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const stunned = rng() * 100 < (ability.stunChance || 50);
        if (stunned) defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + (ability.stunTicks || 2));
        entries.push({
          type: stunned ? 'stun' : 'ability',
          text: attacker.isPlayer
            ? `${ability.name}: ${result.damage} damage${stunned ? ` - ${defender.name} is stunned!` : '.'}`
            : `${attacker.name} uses ${ability.name} for ${result.damage}${stunned ? '! You are stunned!' : '.'}`,
          damage: result.damage,
        });
      }
      break;
    }

    case 'pressure_strike': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = spellDamage(attacker, Math.floor(base * (ability.damageMult || 0.8)));
      const boosted = applyDisruptedDamageBonus(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), tick);
      const result = resolvePhysicalImpact(attacker, defender, boosted, rng);
      if (result.dodged) {
        entries.push({ type: 'dodged', text: attacker.isPlayer ? `${defender.name} dodges Pressure Strike!` : `You dodge ${ability.name}!`, damage: 0 });
      } else {
        defender.hp = Math.max(0, defender.hp - result.damage);
        const reduction = Math.floor(ability.armorReduction || 3);
        const armorImmune = hasArmorReductionImmunity(defender);
        if (!armorImmune) defender.armor = Math.max(0, (defender.armor || 0) - reduction);
        const suffix = result.blocked ? ' (blocked)' : '';
        if (armorImmune) {
          entries.push({
            type: 'ability',
            text: attacker.isPlayer
              ? `Pressure Strike${suffix}: ${result.damage} damage - ${defender.name}'s armor holds.`
              : `${attacker.name} strikes for ${result.damage}, but your armor holds!`,
            damage: result.damage,
            absorbed: result.absorbed || 0,
          });
          break;
        }
        entries.push({ type: 'ability', text: attacker.isPlayer ? `Pressure Strike${suffix}: ${result.damage} damage — ${defender.name} loses ${reduction} armor for this encounter. (${defender.armor} remaining)` : `${attacker.name} strikes for ${result.damage}!`, damage: result.damage, absorbed: result.absorbed || 0 });
      }
      break;
    }

    case 'thunderstrike': {
      const variance = Math.floor(rng() * 4);
      const base = Math.max(1, attacker.damage + variance);
      const dmg = spellDamage(attacker, Math.floor(base * (ability.damageMult || 2.0)));
      const final = applyDisruptedDamageBonus(attacker, defender, applyLowHpDamageBonuses(attacker, defender, dmg), tick);
      defender.hp = Math.max(0, defender.hp - final);
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'stagger');
      defender.activeEffects.push({ type: 'stagger', remainingTicks: 2, attacksRemaining: 2, missPenalty: 35 });
      entries.push({ type: 'ability', text: attacker.isPlayer ? `Thunderstrike: ${final} damage — fully penetrates armor!` : `${attacker.name} lands Thunderstrike for ${final}!`, damage: final });
      entries.push({ type: 'stagger', text: attacker.isPlayer ? `Status: ${defender.name} gains Staggered.` : `Status: You are Staggered.`, damage: 0 });
      break;
    }

    case 'serrated_strikes': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'serrated_strikes');
      attacker.activeEffects.push({
        type: 'serrated_strikes',
        chargesLeft: ability.chargesGranted || 3,
        damageBonusPct: ability.damageBonusPct || 5,
        bleedChancePct: ability.bleedChancePct || 15,
      });
      const charges = ability.chargesGranted || 3;
      const text = attacker.isPlayer
        ? `Serrated Strikes: next ${charges} attacks deal +${ability.damageBonusPct || 5}% damage and inflict Bleeding.`
        : `${attacker.name} serrates their blade.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'sword_stance': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'sword_stance');
      attacker.activeEffects.push({
        type: 'sword_stance',
        chargesLeft: ability.chargesGranted || 3,
        attackSpeedBonusPct: ability.attackSpeedBonusPct || 25,
        bleedChancePct: ability.bleedChancePct || 0,
        bleedingCritChanceBonusPct: ability.bleedingCritChanceBonusPct || 10,
      });
      const charges = ability.chargesGranted || 3;
      const text = attacker.isPlayer
        ? `Sword Stance: next ${charges} auto attacks are ${ability.attackSpeedBonusPct || 25}% faster, have +${ability.bleedChancePct || 0}% Bleeding chance${ability.bleedingCritChanceBonusPct ? `, and gain +${ability.bleedingCritChanceBonusPct}% crit against Bleeding targets` : ''}.`
        : `${attacker.name} shifts into Sword Stance.`;
      entries.push({ type: 'ability', text, damage: 0 });
      break;
    }

    case 'hemorrhage': {
      const attackerIsPlayerSide = isPlayerSideCombatant(attacker);
      if (isBleedImmune(defender)) {
        entries.push({
          type: 'immune',
          text: attackerIsPlayerSide ? `${defender.name} is immune to Bleeding and Hemorrhage.` : 'You are immune to Bleeding and Hemorrhage.',
          damage: 0,
        });
        break;
      }
      const trueDmg = Math.max(1, Math.floor((defender.maxHp || defender.hp) * (ability.trueDamagePct || 5) / 100));
      defender.hp = Math.max(0, defender.hp - trueDmg);
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'bleed' && e.type !== 'hemorrhage');
      defender.activeEffects.push({
        type: 'hemorrhage',
        remainingTicks: applyBleedDurationBonus(attacker, ability.hemorrhageDuration || 4),
        damagePctPerTick: applyBleedDamageBonus(attacker, ability.hemorrhageDamagePct || 1.5),
      });
      const text = attackerIsPlayerSide
        ? `Hemorrhage: ${trueDmg} true damage — the wound tears open into severe hemorrhaging!`
        : `${attacker.name} hemorrhages you for ${trueDmg} true damage!`;
      entries.push({ type: 'ability', text, damage: trueDmg });
      entries.push({ type: 'hemorrhage', text: attackerIsPlayerSide ? `Status: ${defender.name} gains Hemorrhage.` : `Status: You gain Hemorrhage.`, damage: 0 });
      break;
    }

    case 'rupture_hemorrhage': {
      const hasHemorrhage = (defender.activeEffects || []).some(e => e.type === 'hemorrhage' && e.remainingTicks > 0);
      if (!hasHemorrhage) {
        entries.push({
          type: 'ability_fail',
          text: attacker.isPlayer ? `${ability.name}: target must have Hemorrhage.` : `${attacker.name}'s ${ability.name} fails.`,
          damage: 0,
        });
        break;
      }
      if (ability.consumeHemorrhage !== false) {
        defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'hemorrhage');
      }
      const trueDmg = Math.max(1, Math.floor((attacker.damage || 0) * (ability.trueDamageMult || 2)));
      defender.hp = Math.max(0, defender.hp - trueDmg);
      const text = attacker.isPlayer
        ? `${ability.name}: ${trueDmg} true damage. Hemorrhage is consumed.`
        : `${attacker.name} ruptures your Hemorrhage for ${trueDmg} true damage.`;
      entries.push({ type: 'ability', text, damage: trueDmg });
      entries.push({ type: 'hemorrhage', text: attacker.isPlayer ? `Status: ${defender.name}'s Hemorrhage is consumed.` : 'Status: Your Hemorrhage is consumed.', damage: 0 });
      break;
    }

    case 'daze_shout': {
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'daze');
      defender.activeEffects.push({
        type: 'daze',
        remainingTicks: ability.durationTicks || 2,
        missSpellChance: ability.missSpellChance || 50,
      });
      entries.push({
        type: 'daze',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} is Dazed!`
          : `${attacker.name} shouts — you are Dazed!`,
        damage: 0,
      });
      break;
    }

    case 'battle_focus': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'heavy_strikes');
      attacker.activeEffects.push({
        type: 'heavy_strikes',
        chargesLeft: ability.chargesGranted || 3,
        damageBonusPct: ability.damageBonusPct || 15,
        sourceAbilityId: ability.id,
      });
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: next ${ability.chargesGranted || 3} auto attacks deal +${ability.damageBonusPct || 15}% damage.`
          : `${attacker.name} focuses their strikes.`,
        damage: 0,
      });
      break;
    }

    case 'demoralize': {
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'weaken');
      defender.activeEffects.push({
        type: 'weaken',
        remainingTicks: ability.durationTicks || 4,
        damageMult: ability.damageMult || 0.75,
      });
      entries.push({
        type: 'weaken',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} is Demoralized — deals ${Math.round((1 - (ability.damageMult || 0.75)) * 100)}% less damage.`
          : `${attacker.name} demoralizes you — you deal ${Math.round((1 - (ability.damageMult || 0.75)) * 100)}% less damage.`,
        damage: 0,
      });
      break;
    }

    case 'savage_roar': {
      const staggerTicks = ability.staggerDuration || ability.durationTicks || 2;
      const attacksRemaining = ability.staggerAttacks || ability.attacks || staggerTicks;
      const weakenTicks = ability.weakenDurationTicks || ability.durationTicks || 4;
      const damageMult = ability.damageMult || ability.weakenDamageMult || 0.8;

      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'stagger' && e.type !== 'weaken');
      defender.activeEffects.push({
        type: 'stagger',
        remainingTicks: staggerTicks,
        attacksRemaining,
        missPenalty: ability.missPenalty || 35,
      });
      defender.activeEffects.push({
        type: 'weaken',
        remainingTicks: weakenTicks,
        damageMult,
        sourceAbilityId: ability.id,
      });
      entries.push({
        type: 'stagger',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} is staggered.`
          : `${attacker.name} roars - you are staggered!`,
        damage: 0,
      });
      entries.push({
        type: 'weaken',
        text: attacker.isPlayer
          ? `${ability.name}: ${defender.name} deals ${Math.round((1 - damageMult) * 100)}% less damage for ${weakenTicks} seconds.`
          : `${attacker.name}'s roar rattles you - you deal ${Math.round((1 - damageMult) * 100)}% less damage for ${weakenTicks} seconds.`,
        damage: 0,
      });
      break;
    }

    case 'iron_will': {
      attacker.activeEffects = (attacker.activeEffects || []).filter(e => e.type !== 'damage_taken_reduction');
      const attackCharges = ability.attacksRemaining || ability.attacks || 0;
      attacker.activeEffects.push({
        type: 'damage_taken_reduction',
        remainingTicks: attackCharges > 0 ? 99999 : ability.durationTicks || 5,
        attacksRemaining: attackCharges > 0 ? attackCharges : undefined,
        reductionPct: ability.reductionPct || 35,
        sourceAbilityId: ability.id,
      });
      const durationText = attackCharges > 0
        ? `for the next ${attackCharges} incoming auto attack${attackCharges !== 1 ? 's' : ''}`
        : `for ${ability.durationTicks || 5} seconds`;
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: you reduce incoming damage by ${ability.reductionPct || 35}% ${durationText}.`
          : `${attacker.name} braces - takes ${ability.reductionPct || 35}% less damage ${durationText}.`,
        damage: 0,
      });
      break;
    }

    case 'force_next_crit': {
      if (attacker.isPlayer && context.procState) {
        context.procState.forcedNextCrit = true;
        entries.push({
          type: 'ability',
          text: `${ability.name}: your next hit is guaranteed to critically strike!`,
          damage: 0,
        });
      }
      break;
    }

    case 'enrage_buff': {
      const attackSpeedPct = ability.attackSpeedBonusPct || 0;
      const spellDmgBonus = ability.spellDamageBonus || 0;
      if (attackSpeedPct > 0) {
        attacker.activeEffects = (attacker.activeEffects || [])
          .filter(e => !(e.type === 'attack_speed_buff' && e.sourceAbilityId === ability.id));
        attacker.activeEffects.push({
          type: 'attack_speed_buff',
          value: attackSpeedPct,
          remainingTicks: 99999,
          sourceAbilityId: ability.id,
          sourceAbilityName: ability.name,
        });
      }
      if (spellDmgBonus > 0) {
        attacker.spellDamage = (attacker.spellDamage || 0) + spellDmgBonus;
        attacker.baseSpellDamage = (attacker.baseSpellDamage || 0) + spellDmgBonus;
      }
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: attack speed +${attackSpeedPct}%, spell power +${spellDmgBonus}.`
          : `${attacker.name} enrages! Attack speed and spell power surge!`,
        damage: 0,
      });
      break;
    }

    case 'channeled_heal': {
      attacker.activeEffects = (attacker.activeEffects || [])
        .filter(e => e.sourceAbilityId !== ability.id);
      attacker.activeEffects.push({
        type: 'channeled_heal',
        healPctPerTick: ability.healPctPerTick || 5,
        remainingTicks: 99999,
        sourceAbilityId: ability.id,
        sourceAbilityName: ability.name,
      });
      entries.push({
        type: 'ability',
        text: attacker.isPlayer
          ? `${ability.name}: channeling a healing seal.`
          : `${attacker.name} begins channeling ${ability.name}! Hit to interrupt!`,
        damage: 0,
      });
      break;
    }

    case 'detonate_marks': {
      if (!defender || defender.hp <= 0) break;
      const markEff = (defender.activeEffects || []).find(e => e.type === 'shadow_mark');
      const markStacks = markEff?.stacks || 0;
      if (markStacks <= 0) {
        entries.push({ type: 'ability_fail', text: `${ability.name}: no Shadow Marks to detonate!`, damage: 0 });
        break;
      }
      const currentEnergy = context.procState?.energy || 0;
      const damagePerMark = ability.damagePerMark || 0.5;
      const bonusPctPerMark = (attacker.passiveEffects || []).reduce((sum, e) => e.type === 'detonate_base_pct_per_mark' ? sum + (e.value || 0) : sum, 0);
      const bonusDmgPerMark = bonusPctPerMark > 0 ? Math.floor(attacker.damage * bonusPctPerMark / 100) : 0;
      const baseDmg = Math.max(1, Math.floor(attacker.damage * damagePerMark * markStacks) + bonusDmgPerMark * markStacks);
      defender.hp = Math.max(0, defender.hp - baseDmg);
      // Remove shadow marks
      defender.activeEffects = (defender.activeEffects || []).filter(e => e.type !== 'shadow_mark');
      const vuln = ability.vulnerable;
      if (vuln && currentEnergy >= (vuln.minEnergy || 60)) {
        defender.activeEffects = (defender.activeEffects || [])
          .filter(e => !(e.type === 'damage_taken_bonus_pct' && e.source === 'detonate'));
        defender.activeEffects.push({
          type: 'damage_taken_bonus_pct',
          value: vuln.damageTakenPct || 15,
          remainingTicks: vuln.durationTicks || 5,
          source: 'detonate',
        });
      }
      const stun = ability.stun;
      if (stun && currentEnergy >= (stun.minEnergy || 80)) {
        defender.stunUntilTick = Math.max(defender.stunUntilTick || -1, tick + (stun.ticks || 1));
      }
      const energyText = currentEnergy >= 80 ? ' (Vulnerable + Stun!)' : currentEnergy >= 60 ? ' (Vulnerable!)' : '';
      entries.push({
        type: 'ability',
        text: `${ability.name}: ${markStacks} marks detonate for ${baseDmg} damage!${energyText}`,
        damage: baseDmg,
      });
      break;
    }

    default:
      break;
  }

  if (_relicSavedDamage !== undefined) {
    attacker.damage = _relicSavedDamage;
    if (_relicSavedSpell !== undefined) attacker.spellDamage = _relicSavedSpell;
  }

  return entries;
}
