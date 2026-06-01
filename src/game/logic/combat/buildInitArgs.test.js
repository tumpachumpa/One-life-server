import { describe, expect, it } from "vitest";
import { buildCombatInitArgs } from "./buildInitArgs.js";
import { initCombat } from "./combatManager.js";
import { PHASE } from "./types.js";
import { calcStats, initHero } from "../hero.js";

const ENEMY = {
  id: "target_dummy",
  name: "Target Dummy",
  hp: 500,
  stats: { maxHp: 500, attack: 8, armor: 2 },
  effects: [],
};

describe("buildCombatInitArgs", () => {
  it("maps a saved hero + enemy into valid initCombat args", () => {
    const hero = initHero("Fighter", { heroClass: "fighter" });
    const stats = calcStats(hero);
    const args = buildCombatInitArgs(hero, [ENEMY]);

    expect(args.heroMaxHp).toBe(stats.maxHp);
    expect(args.heroArmor).toBe(stats.armor ?? 0);
    expect(args.heroClass).toBe("fighter");
    expect(args.heroDamage).toBeGreaterThanOrEqual(1);
    expect(args.heroAttackRate).toBeGreaterThanOrEqual(0.35);
    expect(args.heroCritMult).toBeCloseTo(1 + (stats.critDamage ?? 75) / 100, 5);
    expect(args.enemyObj).toBe(ENEMY);
    expect(args.enemyObjs).toEqual([ENEMY]);
  });

  it("normalizes a single enemy object into an array", () => {
    const hero = initHero("Archer", { heroClass: "archer" });
    const args = buildCombatInitArgs(hero, ENEMY);
    expect(args.enemyObjs).toEqual([ENEMY]);
    expect(args.enemyObj).toBe(ENEMY);
  });

  it("produces identical scalar args whether stats are passed in or computed internally", () => {
    const hero = initHero("Rogue", { heroClass: "rogue" });
    const fromProp = buildCombatInitArgs(hero, [ENEMY], { stats: calcStats(hero) });
    const computed = buildCombatInitArgs(hero, [ENEMY]);
    const scalars = a => ({
      heroMaxHp: a.heroMaxHp, heroDamage: a.heroDamage, heroArmor: a.heroArmor,
      heroAttackRate: a.heroAttackRate, heroCritChance: a.heroCritChance,
      heroCritMult: a.heroCritMult, heroHitChanceBonus: a.heroHitChanceBonus,
      heroWeaponDamageMult: a.heroWeaponDamageMult, heroOffhandRate: a.heroOffhandRate,
    });
    expect(scalars(fromProp)).toEqual(scalars(computed));
  });

  it("feeds initCombat to a live FIGHTING state", () => {
    const hero = initHero("Fighter", { heroClass: "fighter" });
    const args = buildCombatInitArgs(hero, [ENEMY]);
    const state = initCombat(args);
    expect(state.phase).toBe(PHASE.FIGHTING);
    expect(state.combatants.hero.maxHp).toBe(args.heroMaxHp);
    expect(state.combatants.enemy).toBeTruthy();
    expect(state.combatants.enemy.hp).toBeGreaterThan(0);
  });
});
