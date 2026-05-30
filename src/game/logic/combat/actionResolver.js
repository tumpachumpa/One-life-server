import { applyArmor } from '../hero.js';
import { getDamageTakenBonusPct, getDamageTakenReductionPct, getEffectiveArmor } from './combatant.js';

function effectHasTime(effect) {
  return effect.remainingTicks == null || effect.remainingTicks > 0;
}

// Internal cooldown on passive (chance-based) blocks. After one lands, no further passive block for
// this many ticks (TICK_MS = 1000ms, so 3 ticks = 3s). Modelled as a self-expiring activeEffect that
// tickActiveEffects decrements each tick. Forced/active blocks (shield wall, parry) are not gated.
const PASSIVE_BLOCK_ICD_TICKS = 3;

function isBlockOnCooldown(defender) {
  return (defender?.activeEffects || []).some(effect => effect.type === 'block_icd' && effectHasTime(effect));
}

function startBlockCooldown(defender) {
  defender.activeEffects = defender.activeEffects || [];
  defender.activeEffects.push({ type: 'block_icd', remainingTicks: PASSIVE_BLOCK_ICD_TICKS });
}

function getActiveShieldUpEffect(defender, options = {}) {
  if (isBlockDisabled(defender)) return null;
  if (!options.incomingAutoAttack) return null;
  return (defender.activeEffects || []).find(effect =>
    effect.type === 'shield_up'
    && effectHasTime(effect)
    && (effect.attacksRemaining || 0) > 0) || null;
}

function isBlockDisabled(defender) {
  return (defender?.activeEffects || []).some(effect =>
    effect.type === 'berserker_stance'
    && effect.disableBlock
    && effectHasTime(effect));
}

function getActiveBlockChance(defender, options = {}) {
  if (isBlockDisabled(defender)) return 0;
  const activeBonus = (defender.activeEffects || [])
    .filter(effect => effect.type === 'block_chance_buff' && effectHasTime(effect))
    .reduce((sum, effect) => sum + (effect.value || effect.bonus || 0), 0);
  const incomingAutoBonus = options.incomingAutoAttack
    ? (defender.activeEffects || [])
      .filter(effect =>
        effect.type === 'incoming_auto_block_chance_buff'
        && effectHasTime(effect)
        && (effect.attacksRemaining || 0) > 0)
      .reduce((sum, effect) => sum + (effect.value || effect.bonus || 0), 0)
    : 0;
  const effectivenessPct = Math.max(0, Math.min(100, options.blockEffectivenessPct ?? 100));
  const chance = (defender.blockChance || 0) + activeBonus + incomingAutoBonus;
  return Math.max(0, Math.min(100, chance * effectivenessPct / 100));
}

function canSpendBlockPower(defender) {
  if (isBlockDisabled(defender)) return false;
  return (defender.blockPowerMax || 0) > 0 && (defender.blockPower || 0) > 0;
}

function consumeIncomingAutoAttackEffects(defender) {
  defender.activeEffects = (defender.activeEffects || [])
    .map(effect => {
      if (!['incoming_auto_block_chance_buff', 'shield_up'].includes(effect.type)) return effect;
      if ((effect.attacksRemaining || 0) <= 0) return effect;
      return { ...effect, attacksRemaining: effect.attacksRemaining - 1 };
    })
    .filter(effect => !['incoming_auto_block_chance_buff', 'shield_up'].includes(effect.type) || (effect.attacksRemaining || 0) > 0);
}

function recoverBlockPowerFromBlock(defender) {
  const recoveryPct = (defender.passiveEffects || []).reduce((sum, effect) =>
    effect.type === 'block_power_recovery_pct' ? sum + (effect.value || effect.pct || 0) : sum, 0);
  const activeRecoveryPct = (defender.activeEffects || []).reduce((sum, effect) =>
    effect.type === 'block_power_recovery_pct' && effectHasTime(effect)
      ? sum + (effect.value || effect.pct || 0)
      : sum, 0);
  const maxBlockPower = Math.max(0, defender.blockPowerMax || 0);
  const totalRecoveryPct = recoveryPct + activeRecoveryPct;
  if (totalRecoveryPct <= 0 || maxBlockPower <= 0) return 0;
  const recovered = Math.max(1, Math.floor(maxBlockPower * totalRecoveryPct / 100));
  const before = Math.max(0, defender.blockPower || 0);
  defender.blockPower = Math.min(maxBlockPower, before + recovered);
  return Math.max(0, defender.blockPower - before);
}

function getPhysicalReductionPct(defender) {
  const passive = (defender.passiveEffects || []).reduce((best, effect) =>
    effect.type === 'physical_reduction_pct'
      ? Math.max(best, effect.value || effect.reductionPct || 0)
      : best, 0);
  const active = (defender.activeEffects || []).reduce((best, effect) => {
    if (effect.type !== 'physical_reduction_pct' || !effectHasTime(effect)) return best;
    return Math.max(best, effect.value || effect.reductionPct || 0);
  }, 0);
  return Math.min(75, passive + active + getDamageTakenReductionPct(defender));
}

function applyPhysicalReduction(damage, defender) {
  const bonusPct = Math.max(0, getDamageTakenBonusPct(defender));
  const boostedDamage = bonusPct > 0 ? Math.max(1, Math.floor(damage * (1 + bonusPct / 100))) : damage;
  const reductionPct = Math.max(0, Math.min(90, getPhysicalReductionPct(defender)));
  return reductionPct > 0 ? Math.max(1, Math.floor(boostedDamage * (1 - reductionPct / 100))) : boostedDamage;
}

// Resolves physical impact against a defender.
// Block Chance decides if a passive block happens; Block Power decides how much physical damage is absorbed.
export function resolveImpact(action, defender, options = {}) {
  const shieldUp = getActiveShieldUpEffect(defender, options);
  const blockDisabled = isBlockDisabled(defender);

  if (defender.dodging) {
    defender.dodging = false;
    const dodgeEffectivenessPct = Math.max(0, Math.min(100, options.dodgeEffectivenessPct ?? 100));
    const dodgeSucceeds = !options.rng || options.rng() * 100 < dodgeEffectivenessPct;
    if (dodgeSucceeds) {
      if (options.incomingAutoAttack) consumeIncomingAutoAttackEffects(defender);
      return { damage: 0, dodged: true, blocked: false, absorbed: 0 };
    }
  }

  if ((action.damage || 0) <= 0) {
    const zeroDamageBlockChance = getActiveBlockChance(defender, options);
    const zeroDamagePassiveBlock = !defender.blocking
      && !isBlockOnCooldown(defender)
      && canSpendBlockPower(defender)
      && zeroDamageBlockChance > 0
      && options.rng
      && options.rng() * 100 < zeroDamageBlockChance;
    if (!blockDisabled && (defender.blocking || zeroDamagePassiveBlock || shieldUp)) {
      defender.blocking = false;
      if (zeroDamagePassiveBlock) startBlockCooldown(defender);
      if (options.incomingAutoAttack) consumeIncomingAutoAttackEffects(defender);
      return {
        damage: 0,
        dodged: false,
        blocked: true,
        absorbed: 0,
        recovered: shieldUp ? 0 : recoverBlockPowerFromBlock(defender),
        shieldCounterDamageMult: shieldUp?.counterDamageMult || 0,
        shieldUp: !!shieldUp,
      };
    }
    defender.blocking = false;
    if (options.incomingAutoAttack) consumeIncomingAutoAttackEffects(defender);
    return { damage: 0, dodged: false, blocked: false, absorbed: 0 };
  }

  const armorPenPct = Math.max(0, Math.min(100, options.armorPenPct || 0));
  const defenderArmor = getEffectiveArmor(defender);
  const effectiveArmor = armorPenPct > 0
    ? Math.max(0, Math.floor(defenderArmor * (1 - armorPenPct / 100)))
    : defenderArmor;
  const armoredDamage = applyPhysicalReduction(applyArmor(action.damage, effectiveArmor), defender);
  const blockChance = getActiveBlockChance(defender, options);
  const passiveBlock = !defender.blocking
    && !isBlockOnCooldown(defender)
    && canSpendBlockPower(defender)
    && blockChance > 0
    && options.rng
    && options.rng() * 100 < blockChance;
  const forcedBlock = !!shieldUp;

  if (forcedBlock) {
    defender.blocking = false;
    if (options.incomingAutoAttack) consumeIncomingAutoAttackEffects(defender);
    return {
      damage: 0,
      dodged: false,
      blocked: true,
      absorbed: armoredDamage,
      recovered: 0,
      shieldCounterDamageMult: shieldUp?.counterDamageMult || 0,
      shieldUp: true,
    };
  }

  if (!blockDisabled && (defender.blocking || passiveBlock || forcedBlock)) {
    defender.blocking = false;
    if (passiveBlock) startBlockCooldown(defender);
    const blockEffectivenessPct = Math.max(0, Math.min(100, options.blockEffectivenessPct ?? 100));
    const available = Math.max(0, Math.floor((defender.blockPower || 0) * blockEffectivenessPct / 100));
    const absorbed = Math.min(armoredDamage, available);
    defender.blockPower = Math.max(0, Math.floor((defender.blockPower || 0) - absorbed));
    const recovered = recoverBlockPowerFromBlock(defender);
    if (options.incomingAutoAttack) consumeIncomingAutoAttackEffects(defender);
    return {
      damage: Math.max(0, armoredDamage - absorbed),
      dodged: false,
      blocked: true,
      absorbed,
      recovered,
      shieldCounterDamageMult: shieldUp?.counterDamageMult || 0,
    };
  }

  if (options.incomingAutoAttack) consumeIncomingAutoAttackEffects(defender);
  return { damage: armoredDamage, dodged: false, blocked: false, absorbed: 0 };
}
