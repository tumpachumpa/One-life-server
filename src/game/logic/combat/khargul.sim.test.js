// Khargul (Sealed Deep) headless fight sim — local tuning/verification harness.
// Drives the full 5-phase fight with a strong auto-attacking hero and checks the
// new systems: intro log, brands, seal cleansing, seal intermission, Rising Heat.
import { describe, expect, it } from "vitest";
import { getEnemy } from "../content.js";
import { buildCombatInitArgs } from "./buildInitArgs.js";
import { initCombat, processTick, processAutoAttackFrame } from "./combatManager.js";
import { ACTION, PHASE, TICK_MS } from "./types.js";
import { initHero } from "../hero.js";
import { KHARGUL_BRAND_EFFECT } from "./combatant.js";

function makeKhargulEnemyObj() {
  const def = getEnemy("khargul");
  if (!def) throw new Error("khargul not found in bosses.json");
  return { ...def, stats: { ...def.baseStats } };
}

function makeRng(seed = 1234567) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function runFight({ heroHp = 12000, heroDamage = 110, maxTicks = 600, onTick = null, seed = 42 } = {}) {
  const hero = initHero("Simmy", { heroClass: "fighter" });
  const args = buildCombatInitArgs(hero, [makeKhargulEnemyObj()]);
  // Beef the sim hero so it reliably clears all five phases on auto-attacks.
  args.heroHp = heroHp;
  args.heroMaxHp = heroHp;
  args.heroDamage = heroDamage;
  args.heroAttackRate = 1.2;
  args.allies = [];
  const rng = makeRng(seed);
  let state = initCombat(args);
  let ticks = 0;
  while (state.phase === PHASE.FIGHTING && ticks < maxTicks) {
    ticks += 1;
    state = processAutoAttackFrame(state, TICK_MS, rng);
    if (state.phase !== PHASE.FIGHTING) break;
    state = processTick(state, ACTION.NONE, rng);
    if (onTick) onTick(state, ticks);
  }
  return { state, ticks };
}

describe("Khargul fight sim", () => {
  it("clears all five phases and the new systems fire", () => {
    let sawBrand = false;
    let cleansedBrandIds = [];
    const { state, ticks } = runFight({
      onTick: (s) => {
        const hero = s.combatants.hero;
        const brands = (hero.activeEffects || []).filter(e => e.type === KHARGUL_BRAND_EFFECT);
        if (brands.length && !sawBrand) sawBrand = true;
        // Once branded, swing at the matching seal to cleanse. sealIsDark =
        // The Last Flame: seals are cold ash and brands are permanent — a real
        // player goes back to the boss, so the sim must too.
        const seal = brands.length ? (s.combatants.enemies || []).find(e =>
          e.isSeal && e.hp > 0 && !e.sealIsDark && e.sealConfig?.brandId === brands[0].brandId) : null;
        if (seal && !seal.sealIntermissionActive) {
          s.selectedTargetId = seal.id;
        } else {
          const boss = (s.combatants.enemies || []).find(e => e.sourceId === "khargul");
          if (boss) s.selectedTargetId = boss.id;
        }
      },
    });

    const log = state.log || [];
    const text = log.map(entry => entry.text).join("\n");
    const phaseLines = log.filter(e => e.type === "phase_change").map(e => e.text);

    console.log("=== FIGHT SUMMARY ===");
    console.log("result phase:", state.phase, "| ticks:", ticks);
    console.log("hero hp:", state.combatants.hero.hp, "/", state.combatants.hero.maxHp);
    console.log("--- phase_change lines ---");
    for (const line of phaseLines) console.log(" •", line);
    console.log("--- brand lines ---");
    for (const e of log.filter(e => ["cast_start", "brand", "seal_cleanse", "seal_reject", "seal"].includes(e.type))) {
      console.log(` [T${e.tick}]`, e.type, "→", e.text);
    }
    const heatLines = log.filter(e => e.text?.includes("Rising Heat"));
    console.log("--- Rising Heat (first/last) ---");
    if (heatLines.length) {
      console.log(" first:", heatLines[0].text, "| last:", heatLines[heatLines.length - 1].text, `(${heatLines.length} casts)`);
    }
    cleansedBrandIds = log.filter(e => e.type === "seal_cleanse").map(e => e.text);

    // Intro plays before the first blow.
    expect(log[0]?.type).toBe("intro");
    expect(text).toContain("Khargul rises.");
    // Phases announced (no intermission phase any more — seals stay up the whole fight).
    expect(text).toContain("The Sleeper Wakes");
    expect(text).toContain("Shadow and Flame");
    expect(text).toContain("Wrath Unbound");
    expect(text).toContain("The Last Flame");
    // Seals raised once and persist as cleanse stations (no "break them all" intermission).
    expect(text).toContain("three Seals ignite");
    expect(text).not.toContain("Break them all");
    expect(text).not.toContain("The last seal shatters");
    // Branding happened and at least one cleanse landed.
    expect(sawBrand).toBe(true);
    expect(cleansedBrandIds.length).toBeGreaterThan(0);
    // Rising Heat ramped (later cast hits harder than the first) and the boss called it out.
    expect(heatLines.length).toBeGreaterThan(3);
    expect(log.some(e => e.type === "boss_callout")).toBe(true);
    const firstHeat = Number(heatLines[0].text.match(/for (\d+)/)?.[1] || 0);
    const lastHeat = Number(heatLines[heatLines.length - 1].text.match(/for (\d+)/)?.[1] || 0);
    expect(lastHeat).toBeGreaterThan(firstHeat);
    // The kill ends the fight in victory.
    expect(state.phase).toBe("won");
  });

  it("brands always land on the HERO even when the pet holds the front row", () => {
    const hero = initHero("Simmy", { heroClass: "archer" });
    const args = buildCombatInitArgs(hero, [makeKhargulEnemyObj()]);
    args.heroHp = 12000;
    args.heroMaxHp = 12000;
    args.heroDamage = 80;
    args.allies = [{
      id: "pet_wolf",
      name: "Wolf",
      hp: 3000,
      isAlly: true,
      team: "player",
      stats: { maxHp: 3000, attack: 10, armor: 5, attackSpeed: 1 },
      effects: [],
      abilities: [],
    }];
    const rng = makeRng(99);
    let state = initCombat(args);
    // Pet leads by default (no preferredFrontId) — exactly the risky case.
    expect(state.frontId).toBe("pet_wolf");
    let heroBranded = false;
    let petBranded = false;
    for (let tick = 0; tick < 200 && state.phase === PHASE.FIGHTING; tick += 1) {
      state = processAutoAttackFrame(state, TICK_MS, rng);
      if (state.phase !== PHASE.FIGHTING) break;
      state = processTick(state, ACTION.NONE, rng);
      if ((state.combatants.hero.activeEffects || []).some(e => e.type === KHARGUL_BRAND_EFFECT)) heroBranded = true;
      for (const ally of state.combatants.allies || []) {
        if ((ally.activeEffects || []).some(e => e.type === KHARGUL_BRAND_EFFECT)) petBranded = true;
      }
      if (heroBranded) break;
    }
    expect(heroBranded).toBe(true);
    expect(petBranded).toBe(false);
  });

  it("khargul is immune to fire damage and burn status; bleed is 75% reduced", () => {
    const enemyObj = makeKhargulEnemyObj();
    const hero = initHero("Simmy", { heroClass: "fighter" });
    const args = buildCombatInitArgs(hero, [enemyObj]);
    const state = initCombat(args);
    const boss = state.combatants.enemy;
    // Fire immunity via tag.
    expect((boss.tags || [])).toContain("fire_immune");
    // dotDamageTakenPct carried onto the combatant.
    expect(boss.dotDamageTakenPct).toEqual({ bleed: 25, poison: 25 });
  });
});
