export const TICK_MS = 1000;
export const CAST_TICKS = 2;
export const AUTO_ATTACK_TICKS = 3;
export const MOMENTUM_ATTACK_SPEED_PCT_PER_STACK = 4;
export const COMBAT_OPENING_TICKS = 2;
export const BLOCK_DODGE_COOLDOWN = 4;

export const ACTION = Object.freeze({
  NONE:         'none',
  BLOCK:        'block',
  DODGE:        'dodge',
  FLEE:         'flee',
  SWAP_FRONT:   'swap_front',
  BASIC_ATTACK: 'basic_attack',
  ABILITY_0:    'ability_0',
  ABILITY_1:    'ability_1',
  ABILITY_2:    'ability_2',
  ABILITY_3:    'ability_3',
  ABILITY_4:    'ability_4',
  ABILITY_5:    'ability_5',
  ULTIMATE:     'ultimate',
});

export const PHASE = Object.freeze({
  FIGHTING: 'fighting',
  WON:      'won',
  LOST:     'lost',
  FLED:     'fled',
});

// Basic attacks only — abilities are handled separately
export const ATTACK_ACTIONS = new Set([ACTION.BASIC_ATTACK]);

export const ABILITY_ACTIONS = new Set([
  ACTION.ABILITY_0,
  ACTION.ABILITY_1,
  ACTION.ABILITY_2,
  ACTION.ABILITY_3,
  ACTION.ABILITY_4,
  ACTION.ABILITY_5,
]);

// Maps an ABILITY_* action to its slot index (0-5)
export const ABILITY_SLOT_INDEX = {
  [ACTION.ABILITY_0]: 0,
  [ACTION.ABILITY_1]: 1,
  [ACTION.ABILITY_2]: 2,
  [ACTION.ABILITY_3]: 3,
  [ACTION.ABILITY_4]: 4,
  [ACTION.ABILITY_5]: 5,
};
