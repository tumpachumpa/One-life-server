import { ABILITY_ACTIONS, ACTION } from './types.js';
import { canUseAbility, isStunned } from './combatant.js';

const ENEMY_ABILITY_ACTIONS = [...ABILITY_ACTIONS];

function chooseWeightedAbility(candidates, rng) {
  const totalWeight = candidates.reduce((total, candidate) => total + Math.max(0, candidate.ability.aiWeight || 1), 0);
  if (totalWeight <= 0) return candidates[0] || null;
  let roll = rng() * totalWeight;
  for (const candidate of candidates) {
    roll -= Math.max(0, candidate.ability.aiWeight || 1);
    if (roll <= 0) return candidate;
  }
  return candidates[candidates.length - 1] || null;
}

function passesOncePerCombatChance(combatant, ability, rng) {
  const chance = ability.oncePerCombatChance;
  if (chance == null) return true;
  const rollKey = `${ability.id}:once_chance_rolled`;
  const successKey = `${ability.id}:once_chance_success`;
  combatant.usedAbilityIds = combatant.usedAbilityIds || {};
  if (!combatant.usedAbilityIds[rollKey]) {
    combatant.usedAbilityIds[rollKey] = true;
    combatant.usedAbilityIds[successKey] = rng() * 100 < chance;
  }
  return !!combatant.usedAbilityIds[successKey];
}

// True when this combatant's auto attack is due to fire this tick. Starting an ability cast now would
// advance/reschedule that pending auto (combatManager folds the cast time into the auto window), so we
// hold off: let the imminent auto land, then the AI casts on a following tick.
function isAutoAttackImminent(combatant, tick) {
  if (!combatant || combatant.disableAutoAttack) return false;
  if ((combatant.autoAttackRate ?? 0) <= 0) return false;
  if (!combatant.autoAttackStarted) return false;
  if (!Number.isFinite(combatant.nextAutoAttackTick)) return false;
  return tick >= combatant.nextAutoAttackTick;
}

// Returns the action the enemy AI wants to take this tick.
// Designed to be swappable without touching the core engine.
export function aiDecide(combatant, tick, rng = Math.random) {
  // Stunned or cocooned enemies skip their turn
  if (isStunned(combatant, tick)) return ACTION.NONE;
  if (combatant.inCocoon) return ACTION.NONE;

  // Don't pre-empt an auto attack that is about to land — cast the ability after it instead.
  if (!isAutoAttackImminent(combatant, tick)) {
    const availableAbilities = (combatant.abilities || [])
      .map((ability, index) => ({ ability, index }))
      .filter(({ ability }) => canUseAbility(combatant, ability, tick))
      .filter(({ ability }) => passesOncePerCombatChance(combatant, ability, rng));

    const pooledAbilities = availableAbilities.filter(({ ability }) => ability.aiPool);
    if (pooledAbilities.length > 0) {
      const willingAbilities = pooledAbilities.filter(({ ability }) => rng() * 100 < (ability.aiUseChance ?? 35));
      const selected = chooseWeightedAbility(willingAbilities, rng);
      if (selected) return ENEMY_ABILITY_ACTIONS[selected.index] || ACTION.BASIC_ATTACK;
    }

    const fallbackAbilities = pooledAbilities.length > 0
      ? availableAbilities.filter(({ ability }) => !ability.aiPool)
      : availableAbilities;
    const availableAbilityIndex = fallbackAbilities[0]?.index ?? -1;
    if (availableAbilityIndex >= 0 && rng() < 0.35) {
      return ENEMY_ABILITY_ACTIONS[availableAbilityIndex] || ACTION.BASIC_ATTACK;
    }
  }

  if (combatant.disableAutoAttack || (combatant.autoAttackRate ?? 1) <= 0) return ACTION.NONE;

  return ACTION.BASIC_ATTACK;
}
