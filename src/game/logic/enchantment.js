// Enchantment stone system
// applyEnchantmentStone(item, stone, rng) -> { success, result, newItem }
// resolveEnchantmentEffect(pool, rng) -> effect object
// canEnchant(item) -> bool
// getEnchantmentDisplay(enchantment) -> string description

// Failure chances by stone rarity
const STONE_FAIL_CHANCE = {
  common: 0,
  uncommon: 8,
  rare: 15,
  epic: 22,
  legendary: 30,
};

// Failure outcomes by rarity
const STONE_FAIL_OUTCOME = {
  common: 'minimum', // effect applied at minimum of range
  uncommon: 'minimum',
  rare: 'none',     // no effect, stone consumed
  epic: 'fracture', // item becomes fractured
  legendary: 'destroy', // item destroyed (soulbound -> fracture)
};

const STONE_TYPE_DISPLAY_NAMES = {
  ember: 'Ember',
  shadow: 'Shadow',
  storm: 'Storm',
  frost: 'Frost',
  blood: 'Blood',
  earth: 'Earth',
  void: 'Void',
};

export function getStoneTypeDisplayName(stoneType) {
  return STONE_TYPE_DISPLAY_NAMES[stoneType] || String(stoneType || '').replace(/_/g, ' ');
}

// Passive effect pool for void (random combined)
const VOID_POOL = [
  { type: 'fire_proc_on_hit', chance: 8, minDamage: 10, maxDamage: 18 },
  { type: 'armor_reduce_on_hit', chance: 8, minReduction: 3, maxReduction: 6, durationSecs: 3 },
  { type: 'lightning_proc_on_hit', chance: 8, minDamage: 7, maxDamage: 14 },
  { type: 'passive_armor_bonus', minArmor: 5, maxArmor: 12 },
  { type: 'passive_lifesteal', lifestealPct: 3 },
  { type: 'passive_max_hp_bonus', minHp: 15, maxHp: 30 },
  { type: 'passive_damage_reduction', reductionPct: 5 },
  { type: 'kill_restore_hp_pct', value: 4 },
];

/**
 * Determine whether an item can receive an enchantment.
 * Only equippable gear (type === 'gear') is valid.
 */
export function canEnchant(item) {
  if (!item) return false;
  return item.type === 'gear';
}

/**
 * Pick a random integer in [min, max] inclusive.
 */
function randInt(min, max, rng) {
  if (min >= max) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Resolve an enchantment effect from the pool entry, fixing ranges to specific values.
 * For void stones (enchantmentPool === 'random_combined'), pick a random entry.
 * @param {Array|string} pool - enchantmentPool from stone definition
 * @param {function} rng
 * @param {boolean} useMinimum - if true, numeric ranges use their minimum value
 * @returns {object} - fixed effect object with all ranges resolved
 */
export function resolveEnchantmentEffect(pool, rng, useMinimum = false) {
  if (!pool) return null;

  let entry;
  if (pool === 'random_combined') {
    entry = VOID_POOL[Math.floor(rng() * VOID_POOL.length)];
    // Void can combine two effects
    const second = rng() < 0.3 ? VOID_POOL[Math.floor(rng() * VOID_POOL.length)] : null;
    entry = second && second !== entry ? { ...entry, secondEffect: resolveEntryValues(second, rng, false) } : entry;
  } else if (Array.isArray(pool)) {
    entry = pool[Math.floor(rng() * pool.length)];
  } else {
    return null;
  }

  return resolveEntryValues(entry, rng, useMinimum);
}

function resolveEntryValues(entry, rng, useMinimum) {
  if (!entry) return null;
  const resolved = { ...entry };

  // Resolve numeric ranges
  if (resolved.minDamage != null && resolved.maxDamage != null) {
    resolved.damage = useMinimum ? resolved.minDamage : randInt(resolved.minDamage, resolved.maxDamage, rng);
    delete resolved.minDamage;
    delete resolved.maxDamage;
  }
  if (resolved.minArmor != null && resolved.maxArmor != null) {
    resolved.armor = useMinimum ? resolved.minArmor : randInt(resolved.minArmor, resolved.maxArmor, rng);
    delete resolved.minArmor;
    delete resolved.maxArmor;
  }
  if (resolved.minHp != null && resolved.maxHp != null) {
    resolved.hp = useMinimum ? resolved.minHp : randInt(resolved.minHp, resolved.maxHp, rng);
    delete resolved.minHp;
    delete resolved.maxHp;
  }
  if (resolved.minReduction != null && resolved.maxReduction != null) {
    resolved.reduction = useMinimum ? resolved.minReduction : randInt(resolved.minReduction, resolved.maxReduction, rng);
    delete resolved.minReduction;
    delete resolved.maxReduction;
  }

  return resolved;
}

/**
 * Apply an enchantment stone to an item.
 * @param {object} item - item definition (from items.json, with optional enchantment/fractured fields)
 * @param {object} stone - stone item definition
 * @param {function} rng - random function () -> [0,1)
 * @returns {{ success: bool, result: string, newItem: object|null }}
 *   result: 'success' | 'minimum' | 'none' | 'fracture' | 'destroy'
 */
export function applyEnchantmentStone(item, stone, rng = Math.random) {
  if (!canEnchant(item)) {
    return { success: false, result: 'invalid', newItem: null };
  }

  const rarity = stone.stoneRarity || 'common';
  const failChance = STONE_FAIL_CHANCE[rarity] ?? 0;
  const failOutcome = STONE_FAIL_OUTCOME[rarity] ?? 'none';
  const pool = stone.enchantmentPool;

  // Roll for failure
  const failed = failChance > 0 && rng() * 100 < failChance;

  if (failed) {
    if (failOutcome === 'minimum') {
      // Effect applied at minimum range
      const effect = resolveEnchantmentEffect(pool, rng, true);
      if (!effect) return { success: false, result: 'none', newItem: null };
      const newItem = {
        ...item,
        enchantment: {
          stoneType: stone.stoneType,
          stoneRarity: rarity,
          effect,
        },
      };
      return { success: false, result: 'minimum', newItem };
    }
    if (failOutcome === 'fracture') {
      const newItem = { ...item, fractured: true };
      // Clear previous enchantment on fracture
      delete newItem.enchantment;
      return { success: false, result: 'fracture', newItem };
    }
    if (failOutcome === 'destroy') {
      if (item.soulbound) {
        // Soulbound items degrade to fracture instead of destroy
        const newItem = { ...item, fractured: true };
        delete newItem.enchantment;
        return { success: false, result: 'fracture', newItem };
      }
      return { success: false, result: 'destroy', newItem: null };
    }
    // failOutcome === 'none': stone consumed, nothing happens
    return { success: false, result: 'none', newItem: { ...item } };
  }

  // Success path
  const effect = resolveEnchantmentEffect(pool, rng, false);
  if (!effect) return { success: false, result: 'none', newItem: null };

  const newItem = {
    ...item,
    enchantment: {
      stoneType: stone.stoneType,
      stoneRarity: rarity,
      effect,
    },
  };

  return { success: true, result: 'success', newItem };
}

/**
 * Return a human-readable description of an enchantment effect.
 */
export function getEnchantmentDisplay(enchantment) {
  if (!enchantment?.effect) return '';
  const e = enchantment.effect;
  switch (e.type) {
    case 'fire_proc_on_hit':
      return `${e.chance}% chance: ${e.damage} fire damage on hit${e.burnGuaranteed ? ' + guaranteed burn' : e.burnChanceBonus ? ` (+${e.burnChanceBonus}% burn chance)` : ''}`;
    case 'armor_reduce_on_hit':
      return `${e.chance}% chance: -${e.reduction ?? e.minReduction ?? '?'} armor for ${e.durationSecs}s${e.blindChance ? ` +${e.blindChance}% blind chance` : ''}`;
    case 'debilitated_on_crit':
      return `${e.chance}% chance on crit: -${e.damageReductionPct}% enemy damage for ${e.debuffDurationSecs}s`;
    case 'consecutive_hit_scale':
      return `${e.chance}% chance: consecutive hits gain +${e.scalePerHit}% damage (max x${e.maxStacks})`;
    case 'lightning_proc_on_hit':
      return `${e.chance}% chance: ${e.damage} lightning damage on hit${e.critStunSecs ? ` + ${e.critStunSecs}s stun on crit` : ''}${e.chainChance ? ` +${e.chainChance}% chain chance` : ''}`;
    case 'passive_armor_bonus':
      return `+${e.armor} armor`;
    case 'passive_damage_reduction':
      return `-${e.reductionPct}% damage taken`;
    case 'frost_reflect':
      return `Reflects ${e.reflectDamage} frost damage to the attacker`;
    case 'passive_lifesteal':
      return `+${e.lifestealPct}% lifesteal${e.killRestoreHpPct ? ` + kills restore ${e.killRestoreHpPct}% HP` : ''}${e.lowHpDamageBonus ? ` + +${e.lowHpDamageBonus}% damage below 50% HP` : ''}`;
    case 'passive_max_hp_bonus':
      return `+${e.hp} max HP${e.scalesWithArmor ? ' (scales with armor)' : ''}`;
    case 'kill_restore_hp_pct':
      return `Kills restore ${e.value}% max HP`;
    default:
      return String(e.type).replace(/_/g, ' ');
  }
}

function rng(min, max) {
  return min === max ? `${min}` : `${min}–${max}`;
}

function describePoolEntry(entry) {
  if (!entry) return null;
  switch (entry.type) {
    case 'fire_proc_on_hit':
      return `${entry.chance}% chance: ${rng(entry.minDamage, entry.maxDamage)} fire damage on hit${entry.burnGuaranteed ? ' + guaranteed burn' : entry.burnChanceBonus ? ` (+${entry.burnChanceBonus}% burn chance)` : ''}`;
    case 'armor_reduce_on_hit':
      return `${entry.chance}% chance: -${rng(entry.minReduction, entry.maxReduction)} armor for ${entry.durationSecs}s${entry.blindChance ? ` +${entry.blindChance}% blind` : ''}`;
    case 'debilitated_on_crit':
      return `${entry.chance}% chance on crit: -${entry.damageReductionPct}% enemy damage for ${entry.debuffDurationSecs}s`;
    case 'consecutive_hit_scale':
      return `${entry.chance}% chance: consecutive hits +${entry.scalePerHit}% damage (max x${entry.maxStacks})`;
    case 'lightning_proc_on_hit':
      return `${entry.chance}% chance: ${rng(entry.minDamage, entry.maxDamage)} lightning on hit${entry.critStunSecs ? ` + ${entry.critStunSecs}s stun on crit` : ''}${entry.chainChance ? ` +${entry.chainChance}% chain` : ''}`;
    case 'passive_armor_bonus':
      return `+${rng(entry.minArmor, entry.maxArmor)} armor`;
    case 'passive_damage_reduction':
      return `-${entry.reductionPct}% damage taken`;
    case 'frost_reflect':
      return `Reflects ${entry.reflectDamage} frost damage to attacker`;
    case 'passive_lifesteal':
      return `+${entry.lifestealPct}% lifesteal${entry.killRestoreHpPct ? ` + kills restore ${entry.killRestoreHpPct}% HP` : ''}${entry.lowHpDamageBonus ? ` + +${entry.lowHpDamageBonus}% damage below 50% HP` : ''}`;
    case 'passive_max_hp_bonus':
      return `+${rng(entry.minHp, entry.maxHp)} max HP${entry.scalesWithArmor ? ' (scales with armor)' : ''}`;
    case 'kill_restore_hp_pct':
      return `Kills restore ${entry.value}% max HP`;
    default:
      return String(entry.type).replace(/_/g, ' ');
  }
}

/**
 * Describe what an enchantment stone will do when applied (shows ranges, not resolved values).
 * @param {object} stone - stone item from items.json
 * @returns {string[]} - array of human-readable effect lines
 */
export function getStonePoolDescriptions(stone) {
  const pool = stone?.enchantmentPool;
  if (!pool) return [];
  if (pool === 'random_combined') return ['Random enchantment from any type (may grant 2 effects)'];
  if (!Array.isArray(pool)) return [];
  return pool.map(describePoolEntry).filter(Boolean);
}

/**
 * Get the failure chance for a stone rarity.
 */
export function getStoneFailChance(stoneRarity) {
  return STONE_FAIL_CHANCE[stoneRarity] ?? 0;
}

/**
 * Get the failure outcome description for a stone rarity.
 */
export function getStoneFailOutcomeDescription(stoneRarity) {
  const outcome = STONE_FAIL_OUTCOME[stoneRarity] ?? 'none';
  switch (outcome) {
    case 'minimum': return 'The effect is applied at its minimum value';
    case 'none': return 'No effect, stone consumed';
    case 'fracture': return 'Item fractured (-10% base stats until repaired)';
    case 'destroy': return 'Item destroyed (soulbound items are fractured instead)';
    default: return '';
  }
}
