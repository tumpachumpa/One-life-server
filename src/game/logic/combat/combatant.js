import { BLOCK_DODGE_COOLDOWN } from './types.js';

export const DEFAULT_ABILITY_RAGE_COST = 10;
export const DEFAULT_ABILITY_ENERGY_COST = DEFAULT_ABILITY_RAGE_COST;

const ARMOR_PENETRATION_EFFECT_TYPES = new Set([
  "armor_penetration",
  "armor_penetration_pct",
  "armor_pen",
  "armor_ignore",
]);

function effectArmorPenetrationValue(effect) {
  return effect.value ?? effect.pct ?? effect.percent ?? effect.armorPenPct ?? effect.penetrationPct ?? 0;
}

export function getPassiveArmorPenPct(combatant) {
  const total = (combatant?.passiveEffects || []).reduce((sum, effect) => {
    if (!ARMOR_PENETRATION_EFFECT_TYPES.has(effect.type)) return sum;
    return sum + effectArmorPenetrationValue(effect);
  }, 0);
  return Math.max(0, Math.min(100, total));
}

export function getEffectiveArmor(combatant) {
  const baseArmor = Math.max(0, combatant?.armor || 0);
  const activeReduction = (combatant?.activeEffects || []).reduce((total, effect) => {
    const hasTime = effect.remainingTicks == null || effect.remainingTicks > 0;
    if (!hasTime) return total;
    if (effect.type === "armor_shred") {
      return total + Math.max(0, (effect.armorReduction || effect.value || 0) * Math.max(1, effect.stacks || 1));
    }
    if (effect.type === "armor_reduction" || effect.type === "armor_reduction_debuff") {
      return total + Math.max(0, effect.armorReduction || effect.value || 0);
    }
    // Sunder enchant (shadow stone) and the Infernal Fang relic both push these armor
    // debuffs but they were never subtracted here — so the debuff did nothing.
    if (effect.type === "armor_debuff_enchant" || effect.type === "armor_debuff_relic") {
      return total + Math.max(0, effect.value || effect.armorReduction || effect.reduction || 0);
    }
    return total;
  }, 0);
  return Math.max(0, baseArmor - activeReduction);
}

export function getDamageTakenReductionPct(combatant) {
  const passive = (combatant?.passiveEffects || []).reduce((total, effect) => {
    if (effect.type !== "damage_taken_reduction_pct") return total;
    return total + (effect.value || effect.reductionPct || 0);
  }, 0);
  const active = (combatant?.activeEffects || []).reduce((total, effect) => {
    const hasTime = effect.remainingTicks == null || effect.remainingTicks > 0;
    const hasCharges = effect.attacksRemaining == null || effect.attacksRemaining > 0;
    if (effect.type !== "damage_taken_reduction" || !hasTime || !hasCharges) return total;
    return total + (effect.reductionPct || effect.value || 0);
  }, 0);
  return Math.max(0, Math.min(75, passive + active));
}

export function getDamageTakenBonusPct(combatant) {
  return (combatant?.activeEffects || []).reduce((total, effect) => {
    const hasTime = effect.remainingTicks == null || effect.remainingTicks > 0;
    if (!hasTime) return total;
    if (effect.type === "berserker_stance") return total + (effect.damageTakenPct || 0);
    if (effect.type === "incoming_damage_taken_bonus_pct") return total + (effect.value || effect.damageTakenPct || 0);
    return total;
  }, 0);
}

export function getCritResistPct(combatant) {
  const passive = (combatant?.passiveEffects || []).reduce((total, effect) => {
    if (effect.type !== "crit_resist" && effect.type !== "crit_resist_pct" && effect.type !== "crit_resistance") return total;
    return total + (effect.value || effect.resistPct || 0);
  }, 0);
  const active = (combatant?.activeEffects || []).reduce((total, effect) => {
    const hasTime = effect.remainingTicks == null || effect.remainingTicks > 0;
    if (!hasTime || (effect.type !== "crit_resist" && effect.type !== "crit_resist_pct" && effect.type !== "crit_resistance")) return total;
    return total + (effect.value || effect.resistPct || 0);
  }, 0);
  return Math.max(0, Math.min(100, (combatant?.critResist || 0) + passive + active));
}

export function getEffectiveCritChance(chance, defender = null) {
  const rawChance = Math.max(0, Number(chance || 0));
  return Math.max(0, Math.min(100, rawChance - getCritResistPct(defender)));
}

export function applyDamageTakenReduction(amount, combatant) {
  const bonusPct = getDamageTakenBonusPct(combatant);
  const rawAmount = bonusPct > 0 ? amount * (1 + bonusPct / 100) : amount;
  const raw = Math.max(1, Math.floor(rawAmount));
  const reductionPct = getDamageTakenReductionPct(combatant);
  return reductionPct > 0 ? Math.max(1, Math.floor(raw * (1 - reductionPct / 100))) : raw;
}

export function getAbilityEnergyCost(ability) {
  if (!ability) return 0;
  if (ability.rageCost != null && ability.rageCost > 0) return Math.max(0, Math.ceil(ability.rageCost));
  if (ability.energyCost != null) return Math.max(0, Math.ceil(ability.energyCost));
  if (ability.rageCost === 0) return 0; // explicitly free (no energyCost fallback)
  return DEFAULT_ABILITY_RAGE_COST;
}

function hasActiveBerserkerStance(combatant) {
  return (combatant?.activeEffects || []).some(effect =>
    effect.type === "berserker_stance"
    && effect.active !== false
    && (effect.remainingTicks == null || effect.remainingTicks > 0));
}

export function isAllyTargetAbility(ability) {
  return ability?.target === "ally"
    || ability?.target === "pet"
    || ability?.requiresLivingAlly
    || ability?.type === "pet_heal_over_time";
}

export function createCombatant(id, isPlayer, hp, maxHp, damage, armor, name, abilities = [], options = {}) {
  const rawAutoAttackRate = Number(options.autoAttackRate ?? 1);
  const autoAttackRate = Number.isFinite(rawAutoAttackRate) ? rawAutoAttackRate : 1;
  const passiveEffects = [...(options.passiveEffects || [])];
  return {
    id,
    isPlayer,
    isAlly: !!options.isAlly,
    team: options.team || (isPlayer || options.isAlly ? "player" : "enemy"),
    name: name || id,
    hp: Math.max(0, hp),
    maxHp,
    damage,
    baseDamage: damage,
    armor: armor || 0,
    baseArmor: armor || 0,
    blocking: false,
    dodging: false,
    blockPending: false,
    dodgePending: false,
    blockCooldownUntilTick: 0,
    dodgeCooldownUntilTick: 0,
    isCasting: false,
    autoAttackProgressTicks: 0,
    autoAttackStarted: false,
    lastAutoAttackTick: null,
    nextAutoAttackTick: null,
    autoAttackRate: isPlayer && autoAttackRate <= 0 ? 1 : autoAttackRate,
    abilities,
    passiveEffects,
    basePassiveEffects: [...passiveEffects],
    spellDamageBonus: options.spellDamageBonus || 0,
    spellCooldownReductionOnCast: options.spellCooldownReductionOnCast || 0,
    blockChance: Math.max(0, options.blockChance || 0),
    blockPowerMax: Math.max(0, options.blockPowerMax || 0),
    blockPower: Math.max(0, options.blockPower ?? options.blockPowerMax ?? 0),
    blockPowerRegen: Math.max(0, options.blockPowerRegen || 0),
    magicDefense: Math.max(0, options.magicDefense || options.magicResistance || 0),
    fireResist: Math.max(0, options.fireResist || 0),
    coldResist: Math.max(0, options.coldResist || 0),
    lightningResist: Math.max(0, options.lightningResist || 0),
    shadowResist: Math.max(0, options.shadowResist || 0),
    poisonResist: Math.max(0, options.poisonResist || 0),
    rageGainFlat: Math.max(0, options.rageGainFlat || 0),
    hitChanceBonus: options.hitChanceBonus || 0,
    critChance: options.critChance || 0,
    critResist: Math.max(0, Math.min(100, options.critResist || 0)),
    critMult: options.critMult || 1.5,
    weaponDamageDice: options.weaponDamageDice || null,
    weaponDamageMult: options.weaponDamageMult || 1,
    weaponFamily: options.weaponFamily || null,
    weaponTags: [...(options.weaponTags || [])],
    offhandFamily: options.offhandFamily || null,
    offhandAutoAttackRate: options.offhandAutoAttackRate ?? 0,
    offhandAutoAttackProgressTicks: options.offhandAutoAttackProgressTicks ?? 0,
    offhandAutoAttackStarted: options.offhandAutoAttackStarted ?? false,
    offhandLastAutoAttackTick: options.offhandLastAutoAttackTick ?? null,
    offhandNextAutoAttackTick: options.offhandNextAutoAttackTick ?? null,
    offhandDamageMult: options.offhandDamageMult ?? 0.5,
    family: options.family || null,
    tags: [...(options.tags || [])],
    attackType: options.attackType || null,
    rarityId: options.rarityId || "normal",
    isBoss: !!options.isBoss,
    abilityCooldowns: {},
    usedAbilityIds: {},
    completedDodgePhaseIds: {},
    activeEffects: [],
    stunUntilTick: -1,
    counterChanceBonus: 0,
    combatTriggers: {},
  };
}

export function canBlock(combatant, tick) {
  if ((combatant?.activeEffects || []).some(effect =>
    effect.type === "berserker_stance"
    && effect.disableBlock
    && effect.active !== false
    && (effect.remainingTicks == null || effect.remainingTicks > 0)
  )) return false;
  return tick > combatant.blockCooldownUntilTick && (combatant.blockPowerMax || 0) > 0 && (combatant.blockPower || 0) > 0;
}

const ELEMENT_RESIST_KEY = {
  fire:      'fireResist',
  cold:      'coldResist',
  lightning: 'lightningResist',
  shadow:    'shadowResist',
  poison:    'poisonResist',
  magic:     'magicDefense',
};

export function resolveElementalDamage(amount, element, defender = null) {
  const raw = Math.max(1, Math.floor(amount));
  const resistKey = ELEMENT_RESIST_KEY[element] || 'magicDefense';
  const resist = Math.max(0, defender?.[resistKey] || defender?.magicResistance || 0);
  if (resist <= 0) return applyDamageTakenReduction(raw, defender);
  const reduction = Math.min(0.75, resist / (resist + 100));
  return applyDamageTakenReduction(Math.max(1, Math.floor(raw * (1 - reduction))), defender);
}

export function absorbDamageShield(combatant, amount) {
  const incoming = Math.max(0, Math.floor(amount || 0));
  if (!combatant || incoming <= 0) return { damage: incoming, absorbed: 0, shields: [] };

  let remainingDamage = incoming;
  let absorbed = 0;
  const shields = [];
  const nextEffects = [];

  for (const effect of combatant.activeEffects || []) {
    if (effect.type !== 'damage_shield' || remainingDamage <= 0) {
      nextEffects.push(effect);
      continue;
    }

    const shieldHp = Math.max(0, Math.floor(effect.shieldHp ?? effect.value ?? effect.amount ?? 0));
    if (shieldHp <= 0) continue;

    const absorbedByShield = Math.min(shieldHp, remainingDamage);
    remainingDamage -= absorbedByShield;
    absorbed += absorbedByShield;
    shields.push({
      absorbed: absorbedByShield,
      sourceAbilityId: effect.sourceAbilityId || null,
      label: effect.label || effect.name || 'Barrier',
    });

    const nextShieldHp = shieldHp - absorbedByShield;
    if (nextShieldHp > 0) {
      nextEffects.push({
        ...effect,
        shieldHp: nextShieldHp,
        value: nextShieldHp,
      });
    }
  }

  combatant.activeEffects = nextEffects;
  return { damage: remainingDamage, absorbed, shields };
}

export function isInvulnerable(combatant) {
  return (combatant?.activeEffects || []).some(effect =>
    effect.type === 'invulnerable' && (effect.remainingTicks == null || effect.remainingTicks > 0));
}

export function applyCombatantDamage(combatant, amount) {
  if (isInvulnerable(combatant)) return { damage: 0, absorbed: 0, shields: [] };
  let finalAmount = amount;
  if (combatant.inCocoon) {
    finalAmount = Math.max(1, Math.floor(amount * 0.10));
    combatant.cocoonDamageTaken = (combatant.cocoonDamageTaken || 0) + finalAmount;
  }
  const result = absorbDamageShield(combatant, finalAmount);
  if (result.damage > 0) {
    combatant.hp = Math.max(0, combatant.hp - result.damage);
  }
  return result;
}

export function canDodge(combatant, tick) {
  return tick > combatant.dodgeCooldownUntilTick;
}

export function blockCooldownRemaining(combatant, tick) {
  return Math.max(0, combatant.blockCooldownUntilTick - tick + 1);
}

export function dodgeCooldownRemaining(combatant, tick) {
  return Math.max(0, combatant.dodgeCooldownUntilTick - tick + 1);
}

export function canUseAbility(combatant, abilityOrId, tick, heroResources = {}, target = null, options = {}) {
  return !getAbilityUseFailureReason(combatant, abilityOrId, tick, heroResources, target, options);
}

export function isBleedImmune(combatant) {
  const family = String(combatant?.family || "").toLowerCase();
  const tags = (combatant?.tags || []).map(tag => String(tag).toLowerCase());
  return family.includes("undead")
    || family.includes("skeleton")
    || family.includes("zombie")
    || family.includes("ghoul")
    || tags.includes("undead")
    || tags.includes("bleed_immune");
}

export function isPoisonImmune(combatant) {
  const family = String(combatant?.family || "").toLowerCase();
  const tags = (combatant?.tags || []).map(tag => String(tag).toLowerCase());
  return family.includes("wraith")
    || family.includes("undead")
    || family.includes("skeleton")
    || family.includes("zombie")
    || family.includes("ghoul")
    || family.includes("spider")
    || tags.includes("undead")
    || tags.includes("poison_immune");
}

export function getTargetBleedStacks(target) {
  if (isBleedImmune(target)) return 0;
  return (target?.activeEffects || [])
    .filter(effect => effect.type === "bleed" && effect.remainingTicks > 0)
    .reduce((total, effect) => total + Math.max(1, effect.stacks || 1), 0);
}

export function hasTargetHemorrhage(target) {
  if (isBleedImmune(target)) return false;
  return (target?.activeEffects || []).some(effect => effect.type === "hemorrhage" && effect.remainingTicks > 0);
}

export function getAbilityUseFailureReason(combatant, abilityOrId, tick, heroResources = {}, target = null, options = {}) {
  const ability = typeof abilityOrId === "string"
    ? (combatant.abilities || []).find(entry => entry.id === abilityOrId) || null
    : abilityOrId;
  const abilityId = typeof abilityOrId === "string" ? abilityOrId : abilityOrId?.id;
  if (!abilityId || !ability) return "No ability in that slot.";
  const cooldown = Math.max(0, (combatant.abilityCooldowns[abilityId] || 0) - tick);
  if (cooldown > 0) return `${ability.name} is on cooldown (${cooldown} second${cooldown !== 1 ? "s" : ""} left).`;
  if (ability.once && combatant.usedAbilityIds?.[abilityId]) return `${ability.name} has already been used.`;
  if (ability.unlocksAfterDodgePhaseId && !combatant.completedDodgePhaseIds?.[ability.unlocksAfterDodgePhaseId]) {
    return `${ability.name} is not ready yet.`;
  }
  if (ability.requiresWeaponFamily && combatant.weaponFamily !== ability.requiresWeaponFamily) {
    return `${ability.name} requires a ${ability.requirementLabel || ability.requiresWeaponFamily} equipped.`;
  }
  if (ability.requiresWeaponTag && !(combatant.weaponTags || []).includes(ability.requiresWeaponTag)) {
    return `${ability.name} requires a ${ability.requirementLabel || ability.requiresWeaponTag} equipped.`;
  }
  if (ability.requiresWeaponTags && !ability.requiresWeaponTags.every(tag => (combatant.weaponTags || []).includes(tag))) {
    return `${ability.name} requires a ${ability.requirementLabel || ability.requiresWeaponTags.join(" ")} equipped.`;
  }
  if (ability.forbiddenWeaponFamilies?.includes(combatant.weaponFamily)) {
    return `${ability.name} requires a ${ability.requirementLabel || "valid weapon"} equipped.`;
  }
  if (ability.forbiddenWeaponTags?.some(tag => (combatant.weaponTags || []).includes(tag))) {
    return `${ability.name} requires a ${ability.requirementLabel || "valid weapon"} equipped.`;
  }
  if (ability.requiresOffhandFamily && combatant.offhandFamily !== ability.requiresOffhandFamily) {
    return `${ability.name} requires a ${ability.requiresOffhandFamily} equipped.`;
  }
  if (isAllyTargetAbility(ability)) {
    if (!target?.isAlly || target.hp <= 0) return `${ability.name} requires a living companion.`;
    if (ability.requiresWoundedAlly && target.hp >= target.maxHp) return `${target.name} is already at full health.`;
  }
  if (ability.requiresTargetBleeding) {
    const requiredStacks = Math.max(1, ability.requiredTargetBleedStacks || 1);
    const stacks = getTargetBleedStacks(target);
    if (stacks < requiredStacks) {
      return requiredStacks > 1
        ? `${ability.name} requires ${requiredStacks} Bleeding stacks on the target.`
        : `${ability.name} requires the target to be Bleeding.`;
    }
  }
  if (ability.requiresTargetHemorrhage && !hasTargetHemorrhage(target)) {
    return `${ability.name} requires Hemorrhage on the target.`;
  }
  if (ability.requiresTargetStunned && !(tick <= (target?.stunUntilTick || -1))) {
    return `${ability.name} requires the target to be Stunned.`;
  }
  if (ability.requiresTargetHpPctBelow != null) {
    const targetHpPct = target?.maxHp > 0 ? ((target.hp || 0) / target.maxHp) * 100 : 100;
    if (targetHpPct >= ability.requiresTargetHpPctBelow) {
      return `${ability.name} requires the target below ${ability.requiresTargetHpPctBelow}% HP.`;
    }
  }
  if (ability.requiredMomentumStacks != null) {
    const momentumStacks = Math.max(0, Math.floor(options.procState?.momentumStacks || 0));
    if (momentumStacks < ability.requiredMomentumStacks) {
      return `${ability.name} requires ${ability.requiredMomentumStacks} Momentum stacks.`;
    }
  }
  if (ability.requiredGrudge != null) {
    const grudge = Math.max(0, Math.floor(options.procState?.grudge || 0));
    if (grudge < ability.requiredGrudge) {
      return `${ability.name} requires stored Grudge.`;
    }
  }
  if (ability.requiredCritsLanded != null) {
    const critsLanded = Math.max(0, Math.floor(options.procState?.critsLanded || 0));
    if (critsLanded < ability.requiredCritsLanded) {
      return `${ability.name} requires ${ability.requiredCritsLanded} critical hits landed this fight.`;
    }
  }
  if (ability.requiresSelfHpPctBelow != null) {
    const selfHpPct = combatant?.maxHp > 0 ? ((combatant.hp || 0) / combatant.maxHp) * 100 : 100;
    if (selfHpPct > ability.requiresSelfHpPctBelow) {
      return `${ability.name} requires ${combatant.name} below ${ability.requiresSelfHpPctBelow}% HP.`;
    }
  }
  if (ability.requiredTrigger && !hasCombatTrigger(combatant, ability.requiredTrigger)) {
    if (ability.requiredTrigger === "after_crit") return `${ability.name} requires a critical hit first.`;
    if (ability.requiredTrigger === "after_block") return `${ability.name} requires a block first.`;
    if (ability.requiredTrigger === "after_parry") return `${ability.name} requires a parry first.`;
    return `${ability.name} requires ${ability.requiredTrigger}.`;
  }
  if (combatant.isPlayer) {
    const cost = getAbilityEnergyCost(ability);
    const isBerserkerDeactivate = ability.type === "berserker_stance" && hasActiveBerserkerStance(combatant);
    if (!isBerserkerDeactivate && cost > 0) {
      if (heroResources?.energy) {
        const currentEnergy = Math.max(0, heroResources.energy.value || 0);
        if (currentEnergy < cost) return `Not enough Energy (${Math.floor(currentEnergy)}/${cost}).`;
      } else {
        const currentRage = Math.max(0, heroResources?.rage?.value || 0);
        if (currentRage < cost) return `Not enough Rage (${Math.floor(currentRage)}/${cost}).`;
      }
    }
  }
  return null;
}

export function abilityCooldownRemaining(combatant, abilityId, tick) {
  return Math.max(0, (combatant.abilityCooldowns[abilityId] || 0) - tick);
}

export function isStunned(combatant, tick) {
  return tick <= combatant.stunUntilTick;
}

export function getActiveEffectTotal(combatant, type, field = "value") {
  return (combatant.activeEffects || [])
    .filter(effect => effect.type === type && effect.remainingTicks > 0)
    .reduce((sum, effect) => sum + (effect[field] || 0), 0);
}

export function isDazed(combatant) {
  return getActiveEffectTotal(combatant, "daze", "missSpellChance") > 0;
}

export function hasCombatTrigger(combatant, triggerId) {
  return !!(combatant?.combatTriggers?.[triggerId] > 0);
}
