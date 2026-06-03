import { describe, it, expect } from 'vitest';
import { buildDuelHeroInitArgs, buildDuelEnemy } from '../lib/duels.js';
import { initCombat, processAutoAttackFrame, processTick } from './combat/combatManager.js';
import { AUTO_ATTACK_TICKS, TICK_MS } from './combat/types.js';
import { mulberry32, duelSeed } from '../lib/rng.js';

describe('Duel — seed & Last Breath', () => {
  it('duelSeed is symmetric regardless of ID order', () => {
    const s1 = duelSeed('player-aaa', 'player-bbb');
    const s2 = duelSeed('player-bbb', 'player-aaa');
    expect(s1).toBe(s2);
  });

  it('both clients produce identical RNG sequences from the same seed', () => {
    const seed = duelSeed('player-aaa', 'player-bbb');
    const rng1 = mulberry32(seed);
    const rng2 = mulberry32(seed);
    for (let i = 0; i < 20; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('uses stable player-owned RNG streams for mirrored duel auto attacks', () => {
    const alphaSnap = makeSnap({ maxHp: 160, damage: 23, attackSpeed: 1, hitChanceBonus: 100 });
    const betaSnap = makeSnap({ maxHp: 170, damage: 31, attackSpeed: 1, hitChanceBonus: 100 });
    const duelId = ['alpha', 'beta'].sort().join(':');
    const makeSideRng = (myId, opponentId) => ({
      player: mulberry32(duelSeed(`${duelId}:player`, myId)),
      enemy: mulberry32(duelSeed(`${duelId}:player`, opponentId)),
    });

    const alphaView = initCombat(buildDuelHeroInitArgs(
      'Alpha',
      alphaSnap,
      buildDuelEnemy('Beta', { combatSnap: betaSnap }),
    ));
    const betaView = initCombat(buildDuelHeroInitArgs(
      'Beta',
      betaSnap,
      buildDuelEnemy('Alpha', { combatSnap: alphaSnap }),
    ));

    const alphaAfter = processAutoAttackFrame(alphaView, AUTO_ATTACK_TICKS * TICK_MS, () => 0.5, {
      rngBySide: makeSideRng('alpha', 'beta'),
    });
    const betaAfter = processAutoAttackFrame(betaView, AUTO_ATTACK_TICKS * TICK_MS, () => 0.5, {
      rngBySide: makeSideRng('beta', 'alpha'),
    });

    expect(alphaAfter.combatants.hero.hp).toBe(betaAfter.combatants.enemy.hp);
    expect(alphaAfter.combatants.enemy.hp).toBe(betaAfter.combatants.hero.hp);
  });

  it('buildDuelHeroInitArgs picks up berserker_last_breath proc node from snap', () => {
    const snap = makeSnap({ talents: { berserker_last_breath: 1 } });
    const initArgs = buildDuelHeroInitArgs('Hero', snap, makeDummyEnemy(1));
    const node = initArgs.heroProcNodes.find(n => n.id === 'berserker_last_breath');
    expect(node).toBeTruthy();
    expect(node.proc.trigger).toBe('on_hp_cross_below');
    expect(node.proc.effect.type).toBe('death_cheat');
  });

  it('Last Breath fires in duel combat when hero HP drops below 10%', () => {
    const snap = makeSnap({ talents: { berserker_last_breath: 1 } });
    // Enemy hits hard enough to push hero below 10% HP in a few ticks
    const enemyObj = makeDummyEnemy(88);
    const initArgs = buildDuelHeroInitArgs('Hero', snap, enemyObj);
    const rng = mulberry32(duelSeed('id-aaa', 'id-bbb'));
    let state = initCombat({ ...initArgs });

    let fired = false;
    for (let i = 0; i < 300 && state.phase === 'fighting'; i++) {
      state = processTick(state, null, rng);
      if (state.procState?.onceFiredIds?.includes('berserker_last_breath')) {
        fired = true;
        break;
      }
    }

    expect(fired).toBe(true);
    expect(state.procState.onceFiredIds).toContain('berserker_last_breath');
    expect(state.log.some(e => e.text?.includes('Last Breath'))).toBe(true);
  });

  it('Last Breath fires at most once per duel combat', () => {
    const snap = makeSnap({ talents: { berserker_last_breath: 1 } });
    const enemyObj = makeDummyEnemy(88);
    const initArgs = buildDuelHeroInitArgs('Hero', snap, enemyObj);
    const rng = mulberry32(duelSeed('id-aaa', 'id-bbb'));
    let state = initCombat({ ...initArgs });

    for (let i = 0; i < 500 && state.phase === 'fighting'; i++) {
      state = processTick(state, null, rng);
    }

    const count = state.log.filter(e => e.text?.includes('Last Breath:')).length;
    expect(count).toBeLessThanOrEqual(1);
  });
});

describe('Duel — lifesteal (generic, attacker-based)', () => {
  const punchingBag = (overrides = {}) => buildDuelEnemy('Bag', {
    combatSnap: {
      maxHp: 100000, damage: 1, armor: 0, attackSpeed: 1, hitChanceBonus: 100,
      critChance: 0, critResist: 0, weaponTags: [], allies: [], passiveEffects: [],
      ...overrides,
    },
  });

  it('heals the HERO (p1) on auto-attacks (regression)', () => {
    const heroSnap = makeSnap({ maxHp: 200, damage: 60, attackSpeed: 1, hitChanceBonus: 100,
      passiveEffects: [{ type: 'lifesteal', value: 50 }] });
    let state = initCombat(buildDuelHeroInitArgs('Hero', heroSnap, punchingBag()));
    state.combatants.hero.hp = 50; // leave room to heal
    state = processAutoAttackFrame(state, AUTO_ATTACK_TICKS * TICK_MS, () => 0.5);
    expect(state.combatants.hero.hp).toBeGreaterThan(50);
    expect(state.log.some(e => e.type === 'heal' && /Lifesteal restores/.test(e.text || ''))).toBe(true);
  });

  it('heals the ENEMY/opponent (p2) on auto-attacks — the fix', () => {
    // Hero is a near-immortal, near-harmless bag; the opponent has lifesteal and hits hard.
    const heroSnap = makeSnap({ maxHp: 100000, damage: 1, hitChanceBonus: 100 });
    const enemyObj = punchingBag({ maxHp: 200, damage: 60, hitChanceBonus: 100,
      passiveEffects: [{ type: 'lifesteal', value: 50 }] });
    let state = initCombat(buildDuelHeroInitArgs('Hero', heroSnap, enemyObj));
    state.combatants.enemy.hp = 50; // leave room to heal
    state = processAutoAttackFrame(state, AUTO_ATTACK_TICKS * TICK_MS, () => 0.5);
    expect(state.combatants.enemy.hp).toBeGreaterThan(50); // before the fix this stayed ≤ 50
  });

  it('does NOT heal an opponent without lifesteal (control)', () => {
    const heroSnap = makeSnap({ maxHp: 100000, damage: 1, hitChanceBonus: 100 });
    const enemyObj = punchingBag({ maxHp: 200, damage: 60, hitChanceBonus: 100, passiveEffects: [] });
    let state = initCombat(buildDuelHeroInitArgs('Hero', heroSnap, enemyObj));
    state.combatants.enemy.hp = 50;
    state = processAutoAttackFrame(state, AUTO_ATTACK_TICKS * TICK_MS, () => 0.5);
    expect(state.combatants.enemy.hp).toBeLessThanOrEqual(50);
  });
});

function makeSnap(overrides = {}) {
  return {
    maxHp: 100, damage: 5, armor: 0, attackSpeed: 1,
    critChance: 0, critResist: 0, critMult: 2,
    blockChance: 0, blockPower: 0, blockPowerRegen: 0,
    hitChanceBonus: 0, magicDefense: 0,
    fireResist: 0, coldResist: 0, lightningResist: 0, shadowResist: 0, poisonResist: 0,
    weaponDamageDice: null, weaponDamageMult: 1,
    weaponFamily: 'axe', weaponTags: ['melee', 'two_handed'],
    attackType: null, offhandFamily: null,
    passiveEffects: [],
    heroClass: 'fighter', heroSprite: null, heroVisual: null,
    talents: {},
    equippedSkillIds: [], availableSkillIds: [], allies: [],
    ...overrides,
  };
}

function makeDummyEnemy(damage = 1) {
  return buildDuelEnemy('Opponent', {
    combatSnap: {
      maxHp: 10000, damage, armor: 0, attackSpeed: 1,
      critChance: 0, critResist: 0, weaponTags: [], allies: [],
    },
  });
}
