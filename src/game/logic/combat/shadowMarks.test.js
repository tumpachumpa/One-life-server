import { describe, it, expect } from 'vitest';
import { buildDuelHeroInitArgs, buildDuelEnemy } from '../../lib/duels.js';
import { initCombat, processAutoAttackFrame, processTick } from './combatManager.js';
import { AUTO_ATTACK_TICKS, TICK_MS } from './types.js';

function makeRogueSnap(overrides = {}) {
  return {
    maxHp: 500, damage: 30, armor: 0, attackSpeed: 1,
    critChance: 0, critResist: 0, critMult: 2,
    blockChance: 0, blockPower: 0, blockPowerRegen: 0,
    hitChanceBonus: 100, magicDefense: 0,
    fireResist: 0, coldResist: 0, lightningResist: 0, shadowResist: 0, poisonResist: 0,
    weaponDamageDice: null, weaponDamageMult: 1,
    weaponFamily: 'dagger', weaponTags: ['melee'],
    attackType: null, offhandFamily: null,
    passiveEffects: [{ type: 'shadow_mark_tick_damage_pct', valuePerMark: 1 }],
    heroClass: 'rogue', heroSprite: null, heroVisual: null,
    talents: { shadow_mark_passive: 1, shadow_deep_marks: 1 },
    equippedSkillIds: [], availableSkillIds: [], allies: [],
    ...overrides,
  };
}

function makeDummyTarget() {
  return buildDuelEnemy('Dummy', {
    combatSnap: { maxHp: 100000, damage: 1, armor: 0, attackSpeed: 0.01, critChance: 0, critResist: 0, weaponTags: [], allies: [] },
  });
}

function runFrames(state, frames, rng = () => 0.0) {
  for (let i = 0; i < frames; i++) {
    state = processAutoAttackFrame(state, AUTO_ATTACK_TICKS * TICK_MS, rng);
    state = processTick(state, undefined, rng);
  }
  return state;
}

describe('Shadow Marks', () => {
  it('stacks marks up to 5 on repeated autoattack procs', () => {
    const state = runFrames(initCombat(buildDuelHeroInitArgs('Rogue', makeRogueSnap(), makeDummyTarget())), 7);
    const mark = (state.combatants.enemy.activeEffects || []).find(e => e.type === 'shadow_mark');
    expect(mark?.stacks).toBe(5);
  });

  it('Deep Marks tick damage scales with stacks even at low weapon damage', () => {
    // Regression: floor(30 * 1% * stacks) is 0 for stacks 1-5, and a flat max(1,...)
    // clamp made Deep Marks deal 1 damage regardless of marks ("damage not stacking").
    const state = runFrames(initCombat(buildDuelHeroInitArgs('Rogue', makeRogueSnap({ damage: 30 }), makeDummyTarget())), 6);
    const deepMarkDamage = state.log
      .filter(e => /Deep Marks/.test(e.text || ''))
      .map(e => e.damage);
    expect(deepMarkDamage.length).toBeGreaterThanOrEqual(5);
    // Damage must strictly increase while marks build 1 -> 5 (1 per mark minimum).
    expect(deepMarkDamage.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('Deep Marks keeps the percent formula at high weapon damage', () => {
    const state = runFrames(initCombat(buildDuelHeroInitArgs('Rogue', makeRogueSnap({ damage: 250 }), makeDummyTarget())), 6);
    const deepMarkDamage = state.log
      .filter(e => /Deep Marks/.test(e.text || ''))
      .map(e => e.damage);
    // floor(250 * 1% * stacks) = 2,5,7,10,12
    expect(deepMarkDamage.slice(0, 5)).toEqual([2, 5, 7, 10, 12]);
  });
});
