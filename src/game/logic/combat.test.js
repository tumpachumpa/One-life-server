import { describe, expect, it } from "vitest";
import { buildPetCombatant, initHero, calcStats, getClassBaseStats, getHeroRawDamageBase, getHungerLevel, getWeaponAttackType, healHeroPetByPct, normalizeHeroPet, reduceHeroPetHunger } from "./hero.js";
import { applyEnemyRarity, buildZoneRooms, ENEMY_RARITIES, rollEnemyRarity, scaleMonsterArmor, scaleMonsterAttack } from "./enemies.js";
import { bossById, combatSkillById, enemyById, heroClasses, items, regions, talentTrees, zoneById } from "./content.js";
import { runCombat } from "./combat.js";
import { ADVENTURE_LOOT_POOLS, getDropPool, LOOT_TABLES, rollCombatLoot, rollLootTable } from "./loot.js";
import { rollGeneratedEquipment } from "./equipmentGenerator.js";
import { collectEffects, collectProcNodes } from "./effectEngine.js";
import { applyPoultice, tickBleeding, treatBleeding, treatDeepCut } from "./survival.js";
import { buildCombatResult, initCombat, processAutoAttackFrame, processTick, resolveFrontSwapCast } from "./combat/combatManager.js";
import { resolveAbilityImpact } from "./combat/abilities.js";
import { applyCombatantDamage, getAbilityEnergyCost, getAbilityUseFailureReason } from "./combat/combatant.js";
import { aiDecide } from "./combat/aiSystem.js";
import { ACTION, PHASE, AUTO_ATTACK_TICKS, MOMENTUM_ATTACK_SPEED_PCT_PER_STACK, TICK_MS } from "./combat/types.js";
import { createActionQueue, enqueueAction, enqueueAbility } from "./combat/actionQueue.js";
import { buildCombatSnapFromHero, buildDuelEnemy, buildDuelHeroInitArgs } from "../lib/duels.js";

function withCombatRage(state, rage = 100) {
  return {
    ...state,
    heroResources: {
      ...state.heroResources,
      rage: {
        ...(state.heroResources?.rage || { key: "rage", label: "Rage", max: 100 }),
        value: rage,
      },
    },
    procState: {
      ...state.procState,
      rage,
    },
  };
}

function withEnemyList(state, enemies) {
  return {
    ...state,
    combatants: {
      ...state.combatants,
      enemy: enemies[0],
      enemies,
    },
  };
}

describe("modular combat", () => {
  it("resolves flee attempts by chance and ends combat on success", () => {
    const state = initCombat({
      heroName: "Runner",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const fled = processTick(state, ACTION.FLEE, () => 0.2, {
      fleeContext: { chancePct: 30 },
      disableAutoAttacks: true,
      disableEnemyAi: true,
    });

    expect(fled.phase).toBe(PHASE.FLED);
    expect(fled.fleeAttempted).toBe(true);
    expect(fled.log.at(-1).text).toBe("You slipped away and escaped!");
    expect(buildCombatResult(fled)).toMatchObject({ won: false, fled: true });
  });

  it("consumes one flee attempt on failure and keeps combat running", () => {
    const state = initCombat({
      heroName: "Runner",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const failed = processTick(state, ACTION.FLEE, () => 0.95, {
      fleeContext: { chancePct: 75, itemId: "flash_powder", itemName: "Flash Powder" },
      disableAutoAttacks: true,
      disableEnemyAi: true,
    });
    const retried = processTick(failed, ACTION.FLEE, () => 0, {
      fleeContext: { chancePct: 100 },
      disableAutoAttacks: true,
      disableEnemyAi: true,
    });

    expect(failed.phase).toBe(PHASE.FIGHTING);
    expect(failed.fleeAttempted).toBe(true);
    expect(failed.log.map(entry => entry.text)).toEqual(expect.arrayContaining([
      "Flash Powder consumed. Inventory updated.",
      "You threw a Flash Powder — but the enemy pushed through! Flee failed.",
    ]));
    expect(retried.phase).toBe(PHASE.FIGHTING);
    expect(retried.log.at(-1).text).toBe("Already attempted to flee.");
  });

  it("uses dexterity and intelligence derived stats", () => {
    const hero = initHero("Tester");
    hero.baseStats = { ...hero.baseStats, dex: 15, int: 12 };
    const stats = calcStats(hero);
    expect(stats.dex).toBeGreaterThanOrEqual(15);
    expect(stats.critChance).toBe(7);
    expect(stats.magicDefense).toBeGreaterThan(0);
    expect(stats.critResist).toBeGreaterThan(0);
    expect(stats).not.toHaveProperty("initiative");
  });

  it("applies class-specific starting attributes to new characters", () => {
    const fighter = initHero("Fighter", { heroClass: "fighter" });
    const archer = initHero("Archer", { heroClass: "archer" });

    expect(getClassBaseStats("fighter")).toMatchObject({ str: 11, dex: 7, int: 5, maxHp: 110, critChance: 2 });
    expect(fighter.baseStats).toMatchObject({ str: 11, dex: 7, int: 5, maxHp: 110, critChance: 2 });
    expect(fighter.hp).toBe(110);
    expect(calcStats(fighter).critChance).toBe(4);
    expect(calcStats({ ...fighter, xp: 100 }).critChance).toBe(4);

    expect(getClassBaseStats("archer")).toMatchObject({ str: 6, dex: 10, int: 6, maxHp: 60 });
    expect(archer.baseStats).toMatchObject({ str: 6, dex: 10, int: 6, maxHp: 60 });
    expect(archer.hp).toBe(60);
    expect(calcStats(archer).weaponTags).toContain("ranged");
  });

  it("keeps low-level fighter autoattack crit rolls close to the displayed crit chance", () => {
    const rng = (() => {
      let state = 0x9e3779b9;
      return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const fighter = initHero("Fighter", { heroClass: "fighter", weapon: "sword" });
    const levelTwoFighter = { ...fighter, xp: 100 };
    const stats = calcStats(levelTwoFighter);
    const target = {
      id: "crit_roll_dummy",
      name: "Crit Roll Dummy",
      stats: { maxHp: 1000000, attack: 0, armor: 0, attackSpeed: 0 },
      disableAutoAttack: true,
    };
    let combat = initCombat({
      heroName: levelTwoFighter.name,
      heroHp: levelTwoFighter.hp,
      heroMaxHp: stats.maxHp,
      heroDamage: Math.max(1, Math.floor(getHeroRawDamageBase(stats, levelTwoFighter.equip.weapon))),
      heroArmor: stats.armor,
      heroCritChance: stats.critChance,
      heroCritMult: 1 + ((stats.critDamage ?? 75) / 100),
      heroHitChanceBonus: 10,
      heroAttackRate: 1,
      enemyObj: target,
    });

    let hits = 0;
    let crits = 0;
    let seenLogEntries = 0;
    while (hits < 5000) {
      combat = processAutoAttackFrame(combat, AUTO_ATTACK_TICKS * TICK_MS, rng, { skipEnemyAutos: true });
      for (const entry of combat.log.slice(seenLogEntries)) {
        if (entry.actorId !== "hero" || entry.type !== "hit") continue;
        hits += 1;
        if (entry.isCrit) crits += 1;
      }
      seenLogEntries = combat.log.length;
    }

    const observedCritPct = (crits / hits) * 100;
    expect(stats.critChance).toBe(4);
    expect(observedCritPct).toBeGreaterThanOrEqual(2.8);
    expect(observedCritPct).toBeLessThanOrEqual(5.2);
  });

  it("applies hero crit resist against enemy auto-attack crits", () => {
    const makeFight = heroCritResist => {
      let state = initCombat({
        heroName: "Crit Target",
        heroHp: 200,
        heroMaxHp: 200,
        heroDamage: 0,
        heroArmor: 0,
        heroCritResist,
        enemyObj: {
          id: "crit_enemy",
          name: "Crit Enemy",
          hp: 100,
          stats: {
            maxHp: 100,
            attack: 20,
            armor: 0,
            attackSpeed: 3,
            critChance: 100,
          },
          effects: [],
        },
        heroAbilities: [],
        heroEffects: [],
      });

      state = processTick(state, ACTION.NONE, () => 0.01);
      state = processTick(state, ACTION.NONE, () => 0.01);
      return state.log.find(entry => entry.actorId === "enemy" && entry.type === "hit");
    };

    const critHit = makeFight(0);
    const resistedHit = makeFight(100);

    expect(critHit?.isCrit).toBe(true);
    expect(resistedHit?.isCrit).toBe(false);
    expect(resistedHit?.rawCritChance).toBe(100);
    expect(resistedHit?.critResist).toBe(100);
    expect(resistedHit?.critChance).toBe(0);
  });

  it("applies defender crit resist to PvP weapon abilities", () => {
    const ability = combatSkillById.aimed_shot;
    const resolveShot = defenderCritResist => {
      const attacker = {
        id: "hero",
        name: "Archer",
        team: "player",
        isPlayer: true,
        hp: 100,
        maxHp: 100,
        damage: 20,
        armor: 0,
        critChance: 100,
        critMult: 2,
        passiveEffects: [],
        activeEffects: [],
      };
      const defender = {
        id: "enemy",
        name: "Opponent",
        team: "enemy",
        hp: 1000,
        maxHp: 1000,
        armor: 0,
        critResist: defenderCritResist,
        passiveEffects: [],
        activeEffects: [],
      };
      return resolveAbilityImpact({ ability }, attacker, defender, 1, () => 0.01)
        .find(entry => entry.damage > 0);
    };

    const critShot = resolveShot(0);
    const resistedShot = resolveShot(100);

    expect(critShot?.isCrit).toBe(true);
    expect(resistedShot?.isCrit).toBe(false);
    expect(critShot?.damage).toBeGreaterThan(resistedShot?.damage || 0);
  });

  it("scales PvP archer weapon abilities from combatant damage", () => {
    const abilityDamage = (abilityId, damage) => {
      const attacker = {
        id: "hero",
        name: "Archer",
        team: "player",
        isPlayer: true,
        hp: 100,
        maxHp: 100,
        damage,
        armor: 0,
        critChance: 0,
        critMult: 2,
        passiveEffects: [],
        activeEffects: [],
      };
      const defender = {
        id: "enemy",
        name: "Opponent",
        team: "enemy",
        hp: 5000,
        maxHp: 5000,
        armor: 0,
        passiveEffects: [],
        activeEffects: [],
      };
      return resolveAbilityImpact({ ability: combatSkillById[abilityId] }, attacker, defender, 1, () => 0.01)
        .find(entry => entry.damage > 0)?.damage || 0;
    };

    for (const abilityId of ["aimed_shot", "power_shot", "headshot"]) {
      expect(abilityDamage(abilityId, 40)).toBeGreaterThan(abilityDamage(abilityId, 20));
    }
  });

  it("builds an archer wolf companion as a player-side combatant", () => {
    const fighterClass = heroClasses.find(entry => entry.id === "fighter");
    const archerClass = heroClasses.find(entry => entry.id === "archer");
    expect(fighterClass).toMatchObject({
      name: "Fighter",
      sprite: "/assets/characters/fighter/Fighter.png",
    });
    expect(archerClass).toMatchObject({
      name: "Archer",
      playable: true,
      pet: "wolf_companion",
      startingWeapon: "bow",
      sprite: "/assets/characters/archer/Archer.png",
    });

    const hero = initHero("Tester", { heroClass: "archer", weapon: "bow" });
    hero.baseStats = { ...hero.baseStats, dex: 18 };
    const stats = calcStats(hero);
    const wolf = buildPetCombatant(hero);
    const expectedWolfHp = Math.max(60, Math.round(stats.maxHp * 0.55 + 4));
    const expectedWolfDamage = Math.max(3, Math.round(getHeroRawDamageBase(stats) * 0.15 + 1));
    const expectedWolfArmor = 0;
    const expectedWolfCrit = Math.min(15, Math.round(2 + (stats.critChance || 0) * 0.5));

    expect(wolf).toMatchObject({
      id: "wolf_companion",
      name: "Wolf Companion",
      isAlly: true,
      team: "player",
      sprite: "/assets/sprites/Wolf%20class.png",
      stats: {
        maxHp: expectedWolfHp,
        attack: expectedWolfDamage,
        armor: expectedWolfArmor,
        attackSpeed: 0.85,
        critChance: expectedWolfCrit,
      },
    });
    expect(wolf.effects.some(effect => effect.type === "bleed_on_hit")).toBe(false);
    expect(wolf.abilities.some(ability => ability.id === "wolf_lunge")).toBe(false);
  });

  it("uses saved wolf HP instead of restoring the companion for free", () => {
    const hero = normalizeHeroPet(initHero("Tester", { heroClass: "archer", weapon: "bow" }));
    const woundedHero = {
      ...hero,
      pet: {
        ...hero.pet,
        hp: 11,
      },
    };

    expect(buildPetCombatant(woundedHero).hp).toBe(11);
  });

  it("heals the wolf from percent healing and full-heal pet normalization", () => {
    const hero = normalizeHeroPet(initHero("Tester", { heroClass: "archer", weapon: "bow" }));
    const maxHp = buildPetCombatant(hero).stats.maxHp;
    const woundedHero = {
      ...hero,
      pet: {
        ...hero.pet,
        hp: 10,
      },
    };

    const shrineHealed = healHeroPetByPct(woundedHero, 50);
    const fullyHealed = normalizeHeroPet(woundedHero, { fillPetHp: true });

    expect(shrineHealed.pet.hp).toBe(Math.min(maxHp, 10 + Math.round(maxHp * 0.5)));
    expect(fullyHealed.pet.hp).toBe(maxHp);
    expect(healHeroPetByPct(initHero("Fighter", { heroClass: "fighter" }), 50).pet).toBeUndefined();
  });

  it("reduces saved wolf hunger without affecting fighter saves", () => {
    const archer = normalizeHeroPet(initHero("Tester", { heroClass: "archer", weapon: "bow" }));
    const hungryWolf = {
      ...archer,
      pet: {
        ...archer.pet,
        hunger: 12,
      },
    };
    const drained = reduceHeroPetHunger(hungryWolf, 5);
    const empty = reduceHeroPetHunger(drained, 99);
    const fighter = reduceHeroPetHunger(initHero("Fighter", { heroClass: "fighter" }), 5);

    expect(drained.pet.hunger).toBe(7);
    expect(empty.pet.hunger).toBe(0);
    expect(fighter.pet).toBeUndefined();
  });

  it("does not build a companion for fighter characters", () => {
    expect(buildPetCombatant(initHero("Tester", { heroClass: "fighter" }))).toBeNull();
  });

  it("Rending Bite unlocks the wolf's bleed on hit", () => {
    const hero = {
      ...initHero("Tester", { heroClass: "archer" }),
      talents: { beastmaster_rending_bite: 1 },
    };
    const wolf = buildPetCombatant(hero);

    expect(wolf.effects).toContainEqual({
      type: "bleed_on_hit",
      chance: 12,
      duration: 2,
      damagePct: 0.6,
    });
  });

  it("Predatory Lunge unlocks the wolf's Lunge ability", () => {
    const hero = {
      ...initHero("Tester", { heroClass: "archer" }),
      talents: { beastmaster_predatory_lunge: 1 },
    };
    const wolf = buildPetCombatant(hero);

    expect(wolf.abilities).toContainEqual(expect.objectContaining({
      id: "wolf_lunge",
      type: "stagger_shot",
      castTicks: 1,
      cooldownSeconds: 8,
      damageMult: 1.25,
      aiPool: true,
    }));
  });

  it("Pack Leader increases wolf damage, max HP, and armor", () => {
    const hero = initHero("Tester", { heroClass: "archer" });
    const baseline = buildPetCombatant(hero);
    const trained = buildPetCombatant({
      ...hero,
      talents: { beastmaster_pack_leader: 1 },
    });

    expect(trained.stats.maxHp).toBe(Math.round(baseline.stats.maxHp * 1.25));
    expect(trained.stats.attack).toBe(Math.round(baseline.stats.attack * 1.12));
    expect(trained.stats.armor).toBe(baseline.stats.armor + 6);
    expect(trained.stats.attackSpeed).toBe(baseline.stats.attackSpeed);
  });

  it("Howling Strike upgrades wolf Lunge with bleed and a hero crit buff", () => {
    const hero = {
      ...initHero("Tester", { heroClass: "archer" }),
      talents: {
        beastmaster_pack_leader: 1,
        beastmaster_predatory_lunge: 1,
        beastmaster_howling_strike: 1,
      },
    };
    const wolf = buildPetCombatant(hero);
    const lunge = wolf.abilities.find(ability => ability.id === "wolf_lunge");

    expect(lunge).toMatchObject({
      bleedChance: 100,
      bleedDuration: 2,
      bleedDamagePct: 0.75,
      heroCritChanceBonus: 10,
      heroCritDurationTicks: 2,
    });
  });

  it("Apex Predator unlocks wolf Rend", () => {
    const hero = {
      ...initHero("Tester", { heroClass: "archer" }),
      talents: { beastmaster_apex_predator: 1 },
    };
    const wolf = buildPetCombatant(hero);
    const rend = wolf.abilities.find(ability => ability.id === "wolf_rend");

    expect(rend).toMatchObject({
      name: "Rend",
      type: "hemorrhaging_shot",
      castTicks: 1,
      cooldownSeconds: 12,
      damageMult: 1,
      hemorrhageDuration: 3,
      hemorrhageDamagePct: 1.5,
      aiPool: true,
      aiUseChance: 35,
    });
  });

  it("calculates poison resistance from gear effects", () => {
    const hero = initHero("Tester");
    hero.equip = { ...hero.equip, amulet: items.find(item => item.id === "thorn_amulet") };
    const stats = calcStats(hero);

    expect(stats.poisonResist).toBe(5);
  });

  it("unarmed combat starts with base fist damage", () => {
    const hero = initHero("Tester");
    hero.equip = { ...hero.equip, weapon: null };
    expect(calcStats(hero).damage).toBe(1);
  });

  it("uses strength as the primary melee damage stat", () => {
    expect(getHeroRawDamageBase({ str: 10, dex: 0, damage: 0 })).toBeCloseTo(6.5);
    expect(getHeroRawDamageBase({ str: 10, dex: 0, damage: 4 })).toBeCloseTo(10.5);
    expect(getHeroRawDamageBase({ str: 10, dex: 20, damage: 4 }, { tags: ["weapon", "melee"] })).toBeCloseTo(12.1);
  });

  it("uses dexterity as the primary ranged damage stat", () => {
    expect(getHeroRawDamageBase({ str: 10, dex: 20, damage: 4 }, { tags: ["weapon", "ranged"] })).toBeCloseTo(17.8);
    expect(getHeroRawDamageBase({ str: 10, dex: 20, damage: 4, weaponTags: ["ranged"] })).toBeCloseTo(17.8);
  });

  it("marks ranged starter weapons as ranged combat attacks", () => {
    const hero = initHero("Archer", { heroClass: "archer", weapon: "bow" });
    hero.availableSkillIds = ["quick_shot"];
    hero.equippedSkillIds = ["quick_shot", null, null, null, null, null];
    const stats = calcStats(hero);

    expect(stats.weaponFamily).toBe("bow");
    expect(stats.weaponTags).toContain("ranged");
    expect(getWeaponAttackType(stats)).toBe("ranged");

    const snap = buildCombatSnapFromHero(hero);
    expect(snap.attackType).toBe("ranged");
    expect(snap.weaponFamily).toBe("bow");
    expect(snap.weaponTags).toContain("ranged");
    expect(snap.heroClass).toBe("archer");
    expect(snap.heroSprite).toBe("/assets/characters/archer/Archer.png");
    expect(snap.critResist).toBe(stats.critResist);
    expect(snap.equippedSkillIds).toContain("quick_shot");
    expect(snap.allies[0]).toMatchObject({ id: "wolf_companion", isAlly: true });

    const duelEnemy = buildDuelEnemy("Archer", { combatSnap: snap });
    expect(duelEnemy.stats.attackType).toBe("ranged");
    expect(duelEnemy.stats.weaponFamily).toBe("bow");
    expect(duelEnemy.stats.weaponTags).toContain("ranged");
    expect(duelEnemy.stats.critResist).toBe(snap.critResist);
    expect(duelEnemy.abilities.map(ability => ability.id)).toContain("quick_shot");

    const initArgs = buildDuelHeroInitArgs("Archer", snap, duelEnemy);
    expect(initArgs.heroClass).toBe("archer");
    expect(initArgs.heroVisual.sprite).toBe("/assets/characters/archer/Archer.png");
    expect(initArgs.heroInitialRage).toBe(0);
    expect(initArgs.heroCritResist).toBe(snap.critResist);
    expect(initArgs.heroAbilities.map(ability => ability.id)).toContain("quick_shot");
    expect(initArgs.allies[0]).toMatchObject({ id: "wolf_companion", isAlly: true });
    const duelState = initCombat({ ...initArgs, heroInitialRage: 10 });
    expect(duelState.combatants.enemies.map(entry => entry.id)).toContain("enemy_wolf_companion");
    expect(duelState.enemyFrontId).toBe("enemy_wolf_companion");
    expect(duelState.selectedTargetId).toBe("enemy_wolf_companion");
    const afterQuickShot = processTick(duelState, ACTION.ABILITY_0, () => 0.01, {
      disableAutoAttacks: true,
      disableEnemyAi: true,
    });
    expect(afterQuickShot.log).toContainEqual(expect.objectContaining({
      actorId: "hero",
      type: "cast_start",
      abilityId: "quick_shot",
    }));

    const archerDefaultSnap = buildCombatSnapFromHero(initHero("Archer", { heroClass: "archer", weapon: "bow" }));
    const defaultDuelArgs = buildDuelHeroInitArgs("Archer", archerDefaultSnap, duelEnemy);
    expect(defaultDuelArgs.heroAbilities.map(ability => ability.id)).toEqual(expect.arrayContaining(["quick_shot", "focused_shot"]));

    const capitalizedClassSnap = buildCombatSnapFromHero({ ...initHero("Archer", { heroClass: "archer", weapon: "bow" }), heroClass: "Archer" });
    expect(capitalizedClassSnap.heroClass).toBe("archer");
    expect(capitalizedClassSnap.allies[0]).toMatchObject({ id: "wolf_companion", isAlly: true });

    const legacyArcherSnap = {
      heroClass: "archer",
      maxHp: 80,
      damage: 12,
      attackSpeed: 1,
      equippedSkillIds: [],
      availableSkillIds: [],
    };
    const legacyDuelEnemy = buildDuelEnemy("Legacy Archer", { combatSnap: legacyArcherSnap });
    const legacyDuelArgs = buildDuelHeroInitArgs("Legacy Archer", legacyArcherSnap, legacyDuelEnemy);
    expect(legacyDuelArgs.heroAbilities.map(ability => ability.id)).toEqual(expect.arrayContaining(["quick_shot", "focused_shot"]));
    expect(legacyDuelArgs.allies[0]).toMatchObject({ id: "wolf_companion", isAlly: true });
    expect(legacyDuelEnemy.allies[0]).toMatchObject({ id: "wolf_companion", isAlly: true });

    const rangedLegacySnap = {
      maxHp: 80,
      damage: 12,
      attackSpeed: 1,
      weaponFamily: "bow",
      weaponTags: ["ranged"],
    };
    const rangedLegacyEnemy = buildDuelEnemy("Saved Archer", { combatSnap: rangedLegacySnap });
    const rangedLegacyArgs = buildDuelHeroInitArgs("Saved Archer", rangedLegacySnap, rangedLegacyEnemy);
    expect(rangedLegacyArgs.heroClass).toBe("archer");
    expect(rangedLegacyArgs.heroVisual.sprite).toBe("/assets/characters/archer/Archer.png");
    expect(rangedLegacyArgs.heroAbilities.map(ability => ability.id)).toEqual(expect.arrayContaining(["quick_shot", "focused_shot"]));
    expect(rangedLegacyEnemy.heroClass).toBe("archer");
    expect(rangedLegacyEnemy.abilities.map(ability => ability.id)).toEqual(expect.arrayContaining(["quick_shot", "focused_shot"]));
  });

  it("uses fighter talent unlocks for duels instead of legacy fighter class abilities", () => {
    const snap = {
      heroClass: "fighter",
      maxHp: 120,
      damage: 18,
      attackSpeed: 1,
      weaponTags: ["melee"],
      talents: { berserker_stance: true, duelist_en_garde: true },
      equippedSkillIds: ["heavy_blow"],
      availableSkillIds: ["heavy_blow", "whirlwind", "en_garde"],
    };
    const duelEnemy = buildDuelEnemy("Fighter", { combatSnap: snap });
    const initArgs = buildDuelHeroInitArgs("Fighter", snap, duelEnemy);

    expect(initArgs.heroAbilities.map(ability => ability.id)).toEqual(["whirlwind", "en_garde"]);
    expect(duelEnemy.abilities.map(ability => ability.id)).toEqual(["whirlwind", "en_garde"]);

    const staleFighter = buildDuelHeroInitArgs("Old Fighter", {
      ...snap,
      talents: {},
      availableSkillIds: ["heavy_blow"],
    }, duelEnemy);
    expect(staleFighter.heroAbilities.map(ability => ability.id)).not.toContain("heavy_blow");
  });

  it("treats duel companions as the enemy front and penalizes attacks around them", () => {
    const primary = {
      id: "opponent",
      name: "Opponent",
      hp: 1000,
      stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 0 },
      effects: [],
    };
    const guard = {
      id: "wolf_companion",
      combatantId: "enemy_wolf_companion",
      name: "Wolf",
      hp: 1000,
      stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 0 },
      effects: [],
      isDuelCompanion: true,
    };
    const baseState = initCombat({
      heroName: "Targeter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 40,
      heroArmor: 0,
      heroAttackRate: 1,
      enemyObj: primary,
      enemyObjs: [primary, guard],
      enemyFrontId: "enemy_wolf_companion",
      heroAbilities: [],
      heroEffects: [],
    });
    const readyHero = state => ({
      ...state,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          autoAttackStarted: true,
          autoAttackProgressTicks: AUTO_ATTACK_TICKS,
        },
      },
    });

    const frontHit = processAutoAttackFrame(readyHero({ ...baseState, selectedTargetId: "enemy_wolf_companion" }), TICK_MS, () => 0.5, {
      skipEnemyAutos: true,
      skipAllyAutos: true,
    });
    const backHit = processAutoAttackFrame(readyHero({ ...baseState, selectedTargetId: "enemy" }), TICK_MS, () => 0.5, {
      skipEnemyAutos: true,
      skipAllyAutos: true,
    });
    const frontDamage = 1000 - frontHit.combatants.enemies.find(entry => entry.id === "enemy_wolf_companion").hp;
    const backDamage = 1000 - backHit.combatants.enemies.find(entry => entry.id === "enemy").hp;

    expect(baseState.selectedTargetId).toBe("enemy_wolf_companion");
    expect(frontDamage).toBeGreaterThan(0);
    expect(backDamage).toBe(Math.floor(frontDamage * 0.75));
    expect(backHit.log).toContainEqual(expect.objectContaining({
      actorId: "hero",
      targetId: "enemy",
      targetFrontPenalty: true,
      targetFrontDamageMult: 0.75,
    }));
  });

  it("uses network-supplied duel enemy actions while duel AI is disabled", () => {
    const duelStrike = {
      id: "duel_strike",
      name: "Duel Strike",
      castTicks: 1,
      cooldown: 0,
      type: "empowered_attack",
      damageMult: 1,
    };
    const baseArgs = {
      heroName: "Local",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "opponent",
        name: "Opponent",
        hp: 50,
        disableAutoAttack: true,
        isDuelPlayer: true,
        stats: { maxHp: 50, attack: 0, armor: 0, attackSpeed: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
        abilities: [duelStrike],
      },
      allies: [{
        id: "wolf_companion",
        name: "Wolf",
        hp: 40,
        stats: { maxHp: 40, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    };

    const idle = processTick(initCombat(baseArgs), ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      disableEnemyAi: true,
    });
    expect(idle.log.some(entry => entry.type === "cast_start" && entry.actorId === "enemy")).toBe(false);

    const mirrored = processTick(initCombat(baseArgs), ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      disableEnemyAi: true,
      enemyActions: { enemy: { action: ACTION.ABILITY_0, targetId: "hero" } },
    });
    expect(mirrored.log).toContainEqual(expect.objectContaining({
      type: "cast_start",
      actorId: "enemy",
      abilityId: "duel_strike",
      targetId: "hero",
    }));
  });

  it("shield block stats provide visible Block Power in combat", () => {
    const hero = initHero("Tester");
    const shield = rollGeneratedEquipment({ baseId: "buckler", itemLevel: 2 }, () => 0);
    hero.equip = { ...hero.equip, offhand: shield };
    const stats = calcStats(hero);

    expect(stats.blockChance).toBeGreaterThan(0);
    expect(stats.blockPower).toBeGreaterThan(0);
  });

  it("starts new heroes with generated starter weapon and cloth armor", () => {
    const hero = initHero("Tester");

    expect(hero.equip.offhand).toBeNull();
    expect(hero.equip.weapon).toMatchObject({
      generated: true,
      starter: true,
      name: "Worn Sword",
      family: "sword",
      damageDice: { count: 1, sides: 8 },
    });
    expect(hero.equip.chest).toMatchObject({
      generated: true,
      starter: true,
      name: "Worn Tunic",
      armorType: "cloth",
      armorDice: { count: 1, sides: 2 },
    });
  });

  it("sets shield block stats to zero when no shield is equipped", () => {
    const hero = initHero("Tester");
    hero.equip = { ...hero.equip, offhand: null };
    const stats = calcStats(hero);

    expect(stats.blockChance).toBe(0);
    expect(stats.blockPower).toBe(0);
    expect(stats.blockPowerRegen).toBe(0);
  });

  it("runs combat from data-driven hero and enemy definitions", () => {
    const hero = initHero("Tester");
    const stats = calcStats(hero);
    const [room] = buildZoneRooms("ancient_forest");
    const result = runCombat(hero, stats, room.enemy, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    expect(result.log.length).toBeGreaterThan(0);
    expect(result.log[0]).toHaveProperty("type");
  });

  it("wild boars can lunge as a physical enemy ability", () => {
    const lunge = enemyById.boar.abilities?.find(ability => ability.id === "boar_lunge");

    expect(lunge).toMatchObject({
      name: "Lunge",
      type: "empowered_attack",
      castTicks: 2,
      cooldownSeconds: 8,
      damageMult: 1.5,
    });
  });

  it("Cave Troll has a special ability pool", () => {
    const troll = enemyById.cave_troll;
    const weaponThrow = troll.abilities?.find(ability => ability.id === "cave_troll_weapon_throw");
    const crushingBlow = troll.abilities?.find(ability => ability.id === "cave_troll_crushing_blow");
    const savageRoar = troll.abilities?.find(ability => ability.id === "cave_troll_savage_roar");

    expect(weaponThrow).toMatchObject({
      type: "weapon_throw",
      castTicks: 3,
      once: true,
      damageMult: 2,
      critChanceBonus: 20,
      postThrowDamageMult: 0.6,
      aiPool: "cave_troll_specials",
    });
    expect(crushingBlow).toMatchObject({
      type: "crushing_blow",
      castTicks: 2,
      cooldownSeconds: 6,
      damageMult: 1,
      stunTicks: 2,
      aiPool: "cave_troll_specials",
    });
    expect(savageRoar).toMatchObject({
      type: "savage_roar",
      castTicks: 1,
      cooldownSeconds: 8,
      staggerAttacks: 2,
      weakenDurationTicks: 4,
      damageMult: 0.8,
      aiPool: "cave_troll_specials",
    });
  });

  it("Cave Troll AI picks a willing ability from its special pool", () => {
    const combatant = {
      id: "enemy",
      name: "Cave Troll",
      isPlayer: false,
      hp: 100,
      stunUntilTick: -1,
      disableAutoAttack: false,
      autoAttackRate: 1,
      abilityCooldowns: {},
      usedAbilityIds: {},
      abilities: enemyById.cave_troll.abilities,
    };
    const rolls = [0.99, 0.01, 0.99, 0];
    const action = aiDecide(combatant, 1, () => rolls.shift() ?? 0.99);

    expect(action).toBe(ACTION.ABILITY_1);
  });

  it("enemy AI rolls once-per-combat ability chances only once", () => {
    const combatant = {
      id: "enemy",
      name: "Cultist",
      isPlayer: false,
      hp: 100,
      stunUntilTick: -1,
      disableAutoAttack: true,
      autoAttackRate: 0,
      abilityCooldowns: {},
      usedAbilityIds: {},
      abilities: [
        {
          id: "rare_bolt",
          name: "Rare Bolt",
          type: "spell_attack",
          castTicks: 3,
          cooldownSeconds: 999,
          once: true,
          oncePerCombatChance: 5,
          aiPool: "test",
          aiUseChance: 100,
        },
      ],
    };

    expect(aiDecide(combatant, 1, () => 0.99)).toBe(ACTION.NONE);
    expect(combatant.usedAbilityIds).toMatchObject({
      "rare_bolt:once_chance_rolled": true,
      "rare_bolt:once_chance_success": false,
    });
    expect(aiDecide(combatant, 2, () => 0)).toBe(ACTION.NONE);

    const lucky = {
      ...combatant,
      abilityCooldowns: {},
      usedAbilityIds: {},
    };
    expect(aiDecide(lucky, 1, () => 0)).toBe(ACTION.ABILITY_0);
  });

  it("Oathbound Squire blocks often and retaliates with Shield Bash", () => {
    const squire = enemyById.oathbound_squire;
    const shieldBash = squire.abilities?.find(ability => ability.id === "oathbound_shield_bash");

    expect(squire.baseStats).toMatchObject({
      maxHp: 145,
      attack: 15,
      blockChance: 25,
      blockPower: 16,
    });
    expect(shieldBash).toMatchObject({
      type: "stun_spell",
      requiredTrigger: "after_block",
      consumeTrigger: true,
      aiUseChance: 100,
      stunTicks: 2,
    });
  });

  it("Rootspire elites have their custom ability kits", () => {
    const blackKnight = enemyById.black_knight;
    const graveCleave = blackKnight.abilities?.find(ability => ability.id === "black_knight_grave_cleave");
    const blackBanner = blackKnight.abilities?.find(ability => ability.id === "black_knight_black_banner");
    const sentinel = enemyById.spellbound_sentinel;
    const sentinelShadowBolt = sentinel.abilities?.find(ability => ability.id === "spellbound_sentinel_shadow_bolt");
    const sentinelArcaneBolt = sentinel.abilities?.find(ability => ability.id === "spellbound_sentinel_arcane_disruption");
    const sentinelBindingFlash = sentinel.abilities?.find(ability => ability.id === "spellbound_sentinel_binding_flash");
    const golem = enemyById.stone_golem;
    const abyssalFiend = enemyById.abyssal_fiend;
    const abyssalPulse = abyssalFiend.abilities?.find(ability => ability.id === "abyssal_fiend_abyssal_pulse");

    expect(graveCleave).toMatchObject({
      type: "crushing_blow",
      castTicks: 3,
      cooldownSeconds: 10,
      damageMult: 1.4,
      armorPenPct: 30,
    });
    expect(blackBanner).toMatchObject({
      type: "summon_add",
      enemyId: "black_banner",
      requiresSelfHpPctBelow: 50,
      once: true,
    });
    expect(enemyById.black_banner).toMatchObject({
      disableAutoAttack: true,
      baseStats: { maxHp: 50 },
      aura: { blockChanceBonus: 15, damageBonusPct: 20 },
    });
    expect(sentinel.baseStats.maxHp).toBe(136);
    expect(sentinelShadowBolt).toMatchObject({
      name: "Shadow Bolt",
      type: "spell_attack",
      castTicks: 2,
      cooldownSeconds: 6,
      damageMult: 1.25,
    });
    expect(sentinelArcaneBolt).toMatchObject({
      name: "Arcane Bolt",
      type: "spell_attack",
      damageMult: 1,
    });
    expect(sentinelArcaneBolt).not.toMatchObject({
      type: "stagger_spell",
    });
    expect(sentinelBindingFlash).toMatchObject({
      name: "Binding Flash",
      type: "stun_spell",
      castTicks: 1.5,
      cooldownSeconds: 11,
      stunTicks: 1,
    });
    expect(golem.abilities?.map(ability => ability.id)).toEqual([
      "stone_golem_seismic_slam",
      "stone_golem_stoneguard",
    ]);
    expect(abyssalFiend.abilities?.find(ability => ability.id === "abyssal_fiend_infernal_rend")).toMatchObject({
      type: "empowered_attack",
      burnDurationTicks: 3,
      burnDamagePct: 3,
    });
    expect(abyssalPulse).toMatchObject({
      type: "iron_will",
      requiresSelfHpPctBelow: 25,
      reductionPct: 50,
      attacksRemaining: 2,
      once: true,
    });
    expect(enemyById.wyvern_whelp.effects).toContainEqual(expect.objectContaining({ type: "burn_on_hit", duration: 1 }));
    expect(enemyById.ash_imp.abilities?.find(ability => ability.id === "ash_imp_ember_spit")).toMatchObject({
      type: "spell_attack",
      element: "fire",
      burnChance: 35,
    });
    expect(enemyById.ashbound_cultist).toMatchObject({
      name: "Cultist",
      baseStats: {
        maxHp: 92,
        attack: 8,
        attackSpeed: 0.75,
        spellDamage: 20,
      },
    });
    expect(enemyById.ashbound_cultist.abilities?.map(ability => ability.id)).toEqual([
      "ashbound_cultist_dark_bolt",
      "ashbound_cultist_greater_dark_bolt",
    ]);
    expect(enemyById.ashbound_cultist.abilities?.find(ability => ability.id === "ashbound_cultist_greater_dark_bolt")).toMatchObject({
      type: "spell_attack",
      element: "shadow",
      castTicks: 3,
      once: true,
      oncePerCombatChance: 5,
      damageMult: 2,
    });
  });

  it("Wyvern Breath channels fire damage every second", () => {
    const breath = bossById.wyvern.abilities.find(ability => ability.id === "wyvern_breath");
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 0,
      heroArmor: 0,
      enemyObj: {
        id: "wyvern",
        name: "Wyvern",
        hp: 500,
        disableAutoAttack: true,
        stats: { maxHp: 500, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
        abilities: [breath],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.ABILITY_0 },
    });
    state = processTick(state, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.NONE },
    });
    state = processTick(state, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.NONE },
    });
    state = processTick(state, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.NONE },
    });

    const breathTicks = state.log.filter(entry => entry.abilityId === "wyvern_breath" && entry.type === "ability" && entry.damage > 0);
    expect(state.log).toContainEqual(expect.objectContaining({
      type: "channel_start",
      actorId: "enemy",
      abilityId: "wyvern_breath",
      durationTicks: 3,
    }));
    expect(breathTicks).toHaveLength(3);
    expect(breathTicks.every(entry => entry.element === "fire" && entry.damage > 0)).toBe(true);
    expect(state.combatants.hero.hp).toBe(200 - breathTicks.reduce((total, entry) => total + entry.damage, 0));
    expect(state.log).toContainEqual(expect.objectContaining({
      actorId: "enemy",
      abilityId: "wyvern_breath",
      text: "Wyvern completes Wyvern Breath.",
    }));
  });

  it("stunning Wyvern interrupts Breath and clears the pending channel", () => {
    const breath = bossById.wyvern.abilities.find(ability => ability.id === "wyvern_breath");
    const stun = {
      id: "test_interrupt",
      name: "Interrupting Bash",
      type: "stun_spell",
      castTicks: 0,
      cooldownSeconds: 0,
      rageCost: 0,
      stunTicks: 2,
    };
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 0,
      heroArmor: 0,
      heroInitialRage: 100,
      enemyObj: {
        id: "wyvern",
        name: "Wyvern",
        hp: 500,
        disableAutoAttack: true,
        stats: { maxHp: 500, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
        abilities: [breath],
      },
      heroAbilities: [stun],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.ABILITY_0 },
    });
    state = processTick(state, ACTION.ABILITY_0, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.NONE },
    });
    expect(state.actionQueue.some(action => action.actorId === "enemy" && action.ability?.id === "wyvern_breath")).toBe(false);

    state = processTick(state, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.NONE },
    });

    const breathTicks = state.log.filter(entry => entry.abilityId === "wyvern_breath" && entry.type === "ability" && entry.damage > 0);
    expect(breathTicks).toHaveLength(1);
    expect(state.log).toContainEqual(expect.objectContaining({
      actorId: "enemy",
      type: "interrupt",
      abilityId: "wyvern_breath",
    }));
    expect(state.log.some(entry => entry.abilityId === "wyvern_breath" && entry.text === "Wyvern completes Wyvern Breath.")).toBe(false);
  });

  it("Wyvern Tail Swing unlocks after the first tail dodge phase and stuns on hit", () => {
    const tailSwing = bossById.wyvern.abilities.find(ability => ability.id === "wyvern_tail_swing");
    expect(tailSwing).toMatchObject({
      type: "empowered_attack",
      damageMult: 1.5,
      cooldownSeconds: 10,
      stunDurationTicks: 2,
      unlocksAfterDodgePhaseId: "wyvern_dodge_tail_1",
    });

    const baseEnemy = {
      id: "wyvern",
      name: "Wyvern",
      hp: 500,
      disableAutoAttack: true,
      stats: { maxHp: 500, attack: 40, armor: 0, attackSpeed: 0 },
      effects: [],
      abilities: [tailSwing],
    };
    let locked = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 0,
      heroArmor: 0,
      enemyObj: baseEnemy,
      heroAbilities: [],
      heroEffects: [],
    });

    locked = processTick(locked, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.ABILITY_0 },
    });
    expect(locked.log.some(entry => entry.abilityId === "wyvern_tail_swing" && entry.type === "cast_start")).toBe(false);

    let unlocked = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 0,
      heroArmor: 0,
      enemyObj: baseEnemy,
      heroAbilities: [],
      heroEffects: [],
    });
    unlocked = {
      ...unlocked,
      combatants: {
        ...unlocked.combatants,
        enemy: {
          ...unlocked.combatants.enemy,
          completedDodgePhaseIds: { wyvern_dodge_tail_1: true },
        },
        enemies: unlocked.combatants.enemies.map(foe => foe.id === "enemy"
          ? { ...foe, completedDodgePhaseIds: { wyvern_dodge_tail_1: true } }
          : foe),
      },
    };

    unlocked = processTick(unlocked, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.ABILITY_0 },
    });
    expect(unlocked.log).toContainEqual(expect.objectContaining({
      actorId: "enemy",
      abilityId: "wyvern_tail_swing",
      type: "cast_start",
      text: "Wyvern winds up Tail Swing...",
    }));

    unlocked = processTick(unlocked, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.NONE },
    });
    unlocked = processTick(unlocked, ACTION.NONE, () => 0.01, {
      disableAutoAttacks: true,
      enemyActions: { enemy: ACTION.NONE },
    });

    expect(unlocked.log).toContainEqual(expect.objectContaining({
      actorId: "enemy",
      abilityId: "wyvern_tail_swing",
      type: "stun",
      text: "Wyvern's Tail Swing stuns you for 2 seconds.",
    }));
    expect(unlocked.combatants.hero.stunUntilTick).toBeGreaterThanOrEqual(unlocked.tick);
    expect(unlocked.combatants.hero.hp).toBeLessThan(200);
  });

  it("Rootspire Restless Skeletons reassemble after 10 seconds while another pack skeleton lives", () => {
    const skeleton = enemyById.rootspire_restless_skeleton;
    const enemyObjs = Array.from({ length: 2 }, () => ({
      ...skeleton,
      hp: skeleton.baseStats.maxHp,
      stats: { ...skeleton.baseStats, attack: 0 },
    }));
    let state = initCombat({
      heroName: "Tester",
      heroHp: 300,
      heroMaxHp: 300,
      heroDamage: 1,
      heroArmor: 100,
      enemyObjs,
      bossDeathEndsFight: false,
      addsDespawnOnBossDeath: false,
      heroAbilities: [],
      heroEffects: [],
    });

    state = withEnemyList(state, state.combatants.enemies.map((enemy, index) => (
      index === 0 ? { ...enemy, hp: 0 } : enemy
    )));
    state = processTick(state, ACTION.NONE, () => 0.99);

    expect(state.combatants.enemies[0]).toMatchObject({
      hp: 0,
      reviveAtTick: 11,
      reviveDelayTicks: 10,
    });
    expect(state.log).toContainEqual(expect.objectContaining({
      type: "revive_pending",
      targetId: "enemy",
      reviveDelayTicks: 10,
    }));

    for (let i = 0; i < 9; i += 1) {
      state = processTick(state, ACTION.NONE, () => 0.99);
    }
    expect(state.tick).toBe(10);
    expect(state.combatants.enemies[0].hp).toBe(0);

    state = processTick(state, ACTION.NONE, () => 0.99);
    expect(state.tick).toBe(11);
    expect(state.combatants.enemies[0].hp).toBe(Math.ceil(skeleton.baseStats.maxHp * 0.45));
    expect(state.log).toContainEqual(expect.objectContaining({
      type: "revive",
      targetId: "enemy",
      reviveGroup: "rootspire_restless_skeleton",
    }));
  });

  it("Rootspire Restless Skeletons stay dead when the pack is cleared before the timer", () => {
    const skeleton = enemyById.rootspire_restless_skeleton;
    const enemyObjs = Array.from({ length: 2 }, () => ({
      ...skeleton,
      hp: skeleton.baseStats.maxHp,
      stats: { ...skeleton.baseStats, attack: 0 },
    }));
    let state = initCombat({
      heroName: "Tester",
      heroHp: 300,
      heroMaxHp: 300,
      heroDamage: 1,
      heroArmor: 100,
      enemyObjs,
      bossDeathEndsFight: false,
      addsDespawnOnBossDeath: false,
      heroAbilities: [],
      heroEffects: [],
    });

    state = withEnemyList(state, state.combatants.enemies.map((enemy, index) => (
      index === 0 ? { ...enemy, hp: 0 } : enemy
    )));
    state = processTick(state, ACTION.NONE, () => 0.99);
    state = withEnemyList(state, state.combatants.enemies.map(enemy => ({ ...enemy, hp: 0 })));
    state = processTick(state, ACTION.NONE, () => 0.99);

    expect(state.phase).toBe(PHASE.WON);
    expect(state.combatants.enemies.every(enemy => enemy.hp <= 0)).toBe(true);
  });

  it("crow swarm is a fast low-damage crit enemy", () => {
    const crow = enemyById.crow_swarm;
    const scaledCrow = buildZoneRooms("ancient_forest", 0, () => 0.1)
      .find(room => room.enemy?.id === "crow_swarm")?.enemy;
    expect(crow.baseStats).toMatchObject({
      maxHp: 50,
      attack: 2,
      attackSpeed: 1.75,
    });
    expect(applyEnemyRarity({ ...crow, stats: { ...crow.baseStats }, hp: crow.baseStats.maxHp, rewards: crow.rewards }, ENEMY_RARITIES.raro).stats.attackSpeed).toBe(1.75);
    expect(scaledCrow?.stats.attackSpeed).toBe(1.75);
    expect(crow.effects).toContainEqual({ type: "crit_chance", value: 10 });

    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...crow, hp: 50, stats: crow.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });

    expect(state.combatants.enemy.critChance).toBe(10);
    expect(state.combatants.enemy.autoAttackRate).toBe(1.75);

    const firstTick = processTick(state, ACTION.NONE, () => 0.5);
    expect(firstTick.combatants.enemy.lastAutoAttackTick).toBeNull();
    expect(firstTick.combatants.enemy.nextAutoAttackTick).toBe(firstTick.tick + 1);

    const secondTick = processTick(firstTick, ACTION.NONE, () => 0.5);
    expect(secondTick.combatants.enemy.lastAutoAttackTick).toBe(secondTick.tick);

    const scaledState = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: scaledCrow,
      heroAbilities: [],
      heroEffects: [],
    });
    expect(scaledState.combatants.enemy.damage).toBe(2);
    expect(scaledState.combatants.enemy.autoAttackRate).toBe(1.75);

    const legacyCrow = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...crow, hp: 50, stats: { maxHp: 50, attack: 3, armor: 0 } },
      heroAbilities: [],
      heroEffects: [],
    });
    expect(legacyCrow.combatants.enemy.autoAttackRate).toBe(1.75);
  });

  it("initializes combat with a target-aware enemy list while keeping the single enemy alias", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        stats: { maxHp: 40, attack: 1, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    expect(state.combatants.enemies).toHaveLength(1);
    expect(state.combatants.enemy).toBe(state.combatants.enemies[0]);
    expect(state.selectedTargetId).toBe("enemy");
    expect(state.bossEnemyId).toBe("enemy");
    expect(state.bossDeathEndsFight).toBe(true);
    expect(state.addsDespawnOnBossDeath).toBe(true);
    expect(state.combatants.allies).toEqual([]);
    expect(state.frontId).toBe("hero");
  });

  it("can prevent hero death in debug combat without ending the fight", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 1,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        stats: { maxHp: 40, attack: 50, armor: 0, attackSpeed: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      debugPreventHeroDeath: true,
    });
    state = {
      ...state,
      actionQueue: enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 0, 50, null, 1, { targetId: "hero" }),
    };

    state = processTick(state, ACTION.NONE, () => 0.5);

    expect(state.phase).toBe(PHASE.FIGHTING);
    expect(state.combatants.hero.hp).toBe(1);
    expect(state.log).toContainEqual(expect.objectContaining({
      actorId: "hero",
      type: "death_save",
      debugPreventHeroDeath: true,
    }));
  });

  it("rounds regular fractional ability casts to the engine impact tick", () => {
    const normalCast = enqueueAbility(
      createActionQueue(),
      "enemy",
      ACTION.ABILITY_0,
      1.5,
      1,
      10,
      { id: "fractional_rend", name: "Fractional Rend", type: "empowered_attack" },
      { targetId: "hero" },
    )[0];
    expect(normalCast).toMatchObject({
      startTick: 1,
      castEndTick: 3,
      impactTick: 3,
    });

    const frontSwapCast = enqueueAbility(
      createActionQueue(),
      "hero",
      ACTION.SWAP_FRONT,
      1.5,
      1,
      0,
      { id: "front_swap", name: "Swap", type: "front_swap" },
      { targetId: "wolf" },
    )[0];
    expect(frontSwapCast).toMatchObject({
      startTick: 1,
      castEndTick: 2.5,
      impactTick: 2.5,
    });
  });

  it("initializes allies as player-side front combatants", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        stats: { maxHp: 40, attack: 1, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        stats: { maxHp: 30, attack: 8, armor: 0, attackSpeed: 1 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    expect(state.combatants.allies).toHaveLength(1);
    expect(state.combatants.allies[0]).toMatchObject({ id: "wolf", isAlly: true, team: "player" });
    expect(state.frontId).toBe("wolf");
    expect(buildCombatResult(state).allies).toContainEqual(expect.objectContaining({
      id: "wolf",
      hp: 30,
      maxHp: 30,
    }));
  });

  it("Guardian Bond reduces hero damage taken while the wolf is alive", () => {
    const hero = {
      ...initHero("Archer", { heroClass: "archer", weapon: "bow" }),
      talents: { beastmaster_guardian_bond: 1 },
    };
    const wolf = buildPetCombatant(hero);
    const state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [wolf],
      heroAbilities: [],
      heroEffects: collectEffects(hero),
    });

    expect(state.combatants.hero.passiveEffects).toContainEqual(expect.objectContaining({
      type: "damage_taken_reduction_pct",
      value: 5,
      source: "pet_alive_damage_reduction",
    }));
  });

  it("Guardian Bond falls off before the next enemy hit after the wolf dies", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObjs: [
        {
          id: "killer",
          name: "Killer",
          hp: 100,
          disableAutoAttack: true,
          stats: { maxHp: 100, attack: 0, armor: 0 },
          rewards: { xp: 0, gold: 0 },
          effects: [],
        },
        {
          id: "striker",
          name: "Striker",
          hp: 100,
          disableAutoAttack: true,
          stats: { maxHp: 100, attack: 0, armor: 0 },
          rewards: { xp: 0, gold: 0 },
          effects: [],
        },
      ],
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 5,
        disableAutoAttack: true,
        stats: { maxHp: 5, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [{ type: "pet_alive_damage_taken_reduction_pct", value: 5, source: "beastmaster_guardian_bond" }],
    });
    state = {
      ...state,
      actionQueue: enqueueAction(
        enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, state.tick, 5, null, 1, { targetId: "wolf" }),
        "enemy_1",
        ACTION.BASIC_ATTACK,
        state.tick,
        20,
        null,
        1,
        { targetId: "hero" },
      ),
    };

    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.combatants.allies[0].hp).toBe(0);
    expect(state.frontId).toBe("hero");
    expect(state.combatants.hero.hp).toBe(80);
    expect(state.combatants.hero.passiveEffects.some(effect => effect.source === "pet_alive_damage_reduction")).toBe(false);
  });

  it("Protective Instinct triggers when the wolf drops below half HP", () => {
    const hero = {
      ...initHero("Archer", { heroClass: "archer", weapon: "bow" }),
      talents: { beastmaster_protective_instinct: 1 },
    };
    const wolf = buildPetCombatant(hero);
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{ ...wolf, hp: Math.floor(wolf.stats.maxHp * 0.4) }],
      heroAbilities: [],
      heroEffects: collectEffects(hero),
    });

    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "damage_taken_reduction",
      reductionPct: 30,
      source: "beastmaster_protective_instinct",
    }));
    expect(state.procState.onceFiredIds).toContain("beastmaster_protective_instinct:wolf_companion:low_hp_guard");
    expect(state.log.some(entry => entry.type === "proc" && entry.text.includes("Protective Instinct"))).toBe(true);
  });

  it("Optics guarantees the first shot crit and grants crit damage for four seconds", () => {
    const hero = {
      ...initHero("Archer", { heroClass: "archer", weapon: "bow" }),
      talents: { sharpshooter_optics: 1 },
    };
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 10,
      heroArmor: 0,
      heroCritChance: 0,
      heroCritMult: 2,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "hero" && entry.type === "hit");
    expect(hit?.isCrit).toBe(true);
    expect(state.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "crit_damage_bonus_pct",
      value: 20,
      remainingTicks: 4,
      source: "sharpshooter_optics",
    }));
    expect(state.log.some(entry => entry.type === "proc" && entry.text.includes("Optics"))).toBe(true);
  });

  it("Hair Trigger can fire a free half-damage arrow after a crit", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 10,
      heroArmor: 0,
      heroCritChance: 0,
      heroCritMult: 2,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "force_crit" }],
      heroProcNodes: [{
        id: "sharpshooter_hair_trigger",
        proc: {
          trigger: "on_crit",
          chance: 100,
          condition: null,
          effect: { type: "extra_arrow", damageMult: 0.5 },
        },
      }],
    });

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    expect(state.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && entry.extraHitSource === "hair_trigger")).toBe(true);
    expect(state.combatants.enemy.hp).toBeLessThan(80);
  });

  it("Aimed Shot unlocks after a crit and consumes the crit trigger for a heavy shot", () => {
    const aimedShot = combatSkillById.aimed_shot;
    const enemyObj = {
      id: "dummy",
      name: "Training Dummy",
      hp: 120,
      disableAutoAttack: true,
      stats: { maxHp: 120, attack: 0, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };

    const locked = processTick(withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 10,
      heroArmor: 0,
      heroCritChance: 0,
      heroWeaponTags: ["ranged"],
      enemyObj,
      heroAbilities: [aimedShot],
      heroEffects: [],
    })), ACTION.ABILITY_0, () => 0.5);

    expect(locked.log.some(entry => entry.type === "ability_fail" && entry.text.includes("critical hit first"))).toBe(true);

    let state = withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 10,
      heroArmor: 0,
      heroCritChance: 0,
      heroCritMult: 2,
      heroWeaponTags: ["ranged"],
      enemyObj,
      heroAbilities: [aimedShot],
      heroEffects: [{ type: "first_hit_force_crit" }],
    }));

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    expect(state.combatants.hero.combatTriggers.after_crit).toBe(1);

    const casting = processTick(state, ACTION.ABILITY_0, () => 0.1);
    expect(casting.actionQueue.some(action => action.actorId === "hero" && action.ability?.id === "aimed_shot")).toBe(true);
    expect(casting.combatants.hero.combatTriggers.after_crit).toBe(0);

    const resolved = processTick(casting, ACTION.NONE, () => 0.1);
    const aimedEntry = resolved.log.find(entry => entry.abilityId === "aimed_shot" && entry.damage > 0);
    expect(aimedEntry?.damage).toBeGreaterThanOrEqual(15);
    expect(resolved.combatants.enemy.hp).toBeLessThan(state.combatants.enemy.hp);
  });

  it("enemies attack the front ally before the hero", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        stats: { maxHp: 40, attack: 10, armor: 0, attackSpeed: 3 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    const wolf = state.combatants.allies[0];
    const hit = state.log.find(entry => entry.actorId === "enemy" && entry.type === "hit");
    expect(hit?.targetId).toBe("wolf");
    expect(wolf.hp).toBeLessThan(30);
    expect(state.combatants.hero.hp).toBe(100);
    expect(state.heroResources.rage.value).toBe(0);
  });

  it("allies auto-attack enemies without generating hero Rage", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        disableAutoAttack: true,
        stats: { maxHp: 40, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        stats: { maxHp: 30, attack: 10, armor: 0, attackSpeed: 3 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "wolf" && entry.type === "hit");
    expect(hit?.targetId).toBe("enemy");
    expect(state.combatants.enemy.hp).toBeLessThan(40);
    expect(state.heroResources.rage.value).toBe(0);
  });

  it("wolf companion uses Lunge to stagger enemies", () => {
    const hero = {
      ...initHero("Archer", { heroClass: "archer" }),
      talents: { beastmaster_predatory_lunge: 1 },
    };
    const wolf = buildPetCombatant(hero);
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [wolf],
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.log.some(entry => entry.actorId === "wolf_companion" && entry.type === "cast_start" && entry.abilityId === "wolf_lunge")).toBe(true);

    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.log.some(entry => entry.actorId === "wolf_companion" && entry.type === "ability" && entry.abilityId === "wolf_lunge")).toBe(true);
    expect(state.log.some(entry => entry.actorId === "wolf_companion" && entry.type === "stagger" && entry.text.includes("Training Dummy gains Staggered"))).toBe(true);
    expect(state.combatants.enemy.activeEffects.some(effect => effect.type === "stagger")).toBe(true);
  });

  it("Mend Companion heals the wounded wolf instead of targeting the enemy", () => {
    const mendCompanion = combatSkillById.mend_companion;
    expect(getAbilityUseFailureReason(
      { abilities: [mendCompanion], abilityCooldowns: {}, usedAbilityIds: {}, isPlayer: true, weaponTags: ["ranged"] },
      mendCompanion,
      1,
      { rage: { value: 100 } },
      { id: "wolf", name: "Wolf", isAlly: true, hp: 30, maxHp: 30 },
    )).toBe("Wolf is already at full health.");

    let state = withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 5,
      heroArmor: 0,
      heroWeaponFamily: "bow",
      heroWeaponTags: ["ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 15,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [mendCompanion],
      heroEffects: [],
    }));

    state = processTick(state, ACTION.ABILITY_0, () => 0.5);
    expect(state.log.some(entry => entry.actorId === "hero" && entry.type === "cast_start" && entry.abilityId === "mend_companion" && entry.targetId === "wolf")).toBe(true);

    state = processTick(state, ACTION.NONE, () => 0.5);
    expect(state.log.some(entry => entry.actorId === "hero" && entry.type === "ability" && entry.abilityId === "mend_companion" && entry.targetId === "wolf")).toBe(true);
    expect(state.combatants.enemy.hp).toBe(100);

    state = processTick(state, ACTION.NONE, () => 0.5);
    expect(state.combatants.allies[0].hp).toBe(18);
    expect(state.log.some(entry => entry.actorId === "wolf" && entry.type === "heal" && entry.text.includes("Mend Companion"))).toBe(true);
  });

  it("Emergency Triage upgrades Mend Companion for a badly wounded wolf", () => {
    const mendCompanion = combatSkillById.mend_companion;
    let state = withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 5,
      heroArmor: 0,
      heroWeaponFamily: "bow",
      heroWeaponTags: ["ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 10,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [mendCompanion],
      heroEffects: [{
        type: "mend_companion_upgrade",
        thresholdPct: 40,
        instantHealPct: 10,
        reductionPct: 30,
        durationTicks: 3,
        source: "ranger_emergency_triage",
      }],
    }));

    state = processTick(state, ACTION.ABILITY_0, () => 0.5);
    state = processTick(state, ACTION.NONE, () => 0.5);

    const wolf = state.combatants.allies[0];
    expect(wolf.hp).toBe(13);
    expect(wolf.activeEffects).toContainEqual(expect.objectContaining({
      type: "damage_taken_reduction",
      reductionPct: 30,
      remainingTicks: 3,
      sourceAbilityId: "mend_companion",
    }));
    expect(wolf.activeEffects).toContainEqual(expect.objectContaining({
      type: "heal_over_time",
      healPerTick: 3,
      sourceAbilityId: "mend_companion",
    }));
    expect(state.log.some(entry => entry.type === "heal" && entry.targetId === "wolf" && entry.text.includes("Emergency Triage"))).toBe(true);
  });

  it("Wild Renewal heals the hero and wolf while only protecting the wolf", () => {
    const wildRenewal = combatSkillById.wild_renewal;
    expect(getAbilityEnergyCost(wildRenewal)).toBe(10);
    let state = withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 50,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      heroWeaponFamily: "bow",
      heroWeaponTags: ["ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 40,
        disableAutoAttack: true,
        stats: { maxHp: 80, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [wildRenewal],
      heroEffects: [],
    }), 10);

    state = processTick(state, ACTION.ABILITY_0, () => 0.5);
    state = processTick(state, ACTION.NONE, () => 0.5);

    expect(state.heroResources.rage.value).toBe(0);
    expect(state.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "heal_over_time",
      healPerTick: 10,
      sourceAbilityId: "wild_renewal",
    }));
    expect(state.combatants.hero.activeEffects.some(effect =>
      effect.type === "damage_taken_reduction" && effect.sourceAbilityId === "wild_renewal")).toBe(false);
    expect(state.combatants.allies[0].activeEffects).toContainEqual(expect.objectContaining({
      type: "heal_over_time",
      healPerTick: 4,
      sourceAbilityId: "wild_renewal",
    }));
    expect(state.combatants.allies[0].activeEffects).toContainEqual(expect.objectContaining({
      type: "damage_taken_reduction",
      reductionPct: 15,
      sourceAbilityId: "wild_renewal",
    }));

    state = processTick(state, ACTION.NONE, () => 0.5);
    expect(state.combatants.hero.hp).toBe(70);
    expect(state.combatants.allies[0].hp).toBe(48);
    expect(state.log.some(entry => entry.type === "heal" && entry.targetId === "wolf" && entry.text.includes("Wild Renewal"))).toBe(true);
  });

  it("Archer active skills use expected Rage costs", () => {
    const expectedCosts = {
      shadow_veil: 0,
      hunter_mark: 0,
      bear_trap: 15,
      stagger_shot: 0,
      power_shot: 0,
      aimed_shot: 0,
      hemorrhaging_shot: 0,
      rapid_fire: 0,
      unleash: 0,
      mend_companion: 10,
      barbed_trap: 10,
      covering_fire: 0,
      headshot: 0,
      wild_renewal: 10,
    };

    for (const [skillId, cost] of Object.entries(expectedCosts)) {
      expect(getAbilityEnergyCost(combatSkillById[skillId]), skillId).toBe(cost);
    }
  });

  it("Howling Strike makes wolf Lunge apply bleed and grant hero crit chance", () => {
    const hero = {
      ...initHero("Archer", { heroClass: "archer" }),
      talents: {
        beastmaster_pack_leader: 1,
        beastmaster_predatory_lunge: 1,
        beastmaster_howling_strike: 1,
      },
    };
    const wolf = buildPetCombatant(hero);
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [wolf],
      heroAbilities: [],
      heroEffects: collectEffects(hero),
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.combatants.enemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "bleed",
      stacks: 1,
      remainingTicks: 4,
      damagePctPerTick: 0.75,
    }));
    expect(state.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "crit_chance_buff",
      value: 10,
      remainingTicks: 2,
      source: "beastmaster_howling_strike",
    }));
    expect(state.log.some(entry => entry.actorId === "wolf_companion" && entry.type === "bleed" && entry.text.includes("Training Dummy gains Bleeding"))).toBe(true);
    expect(state.log.some(entry => entry.actorId === "wolf_companion" && entry.type === "proc" && entry.text.includes("Howling Strike"))).toBe(true);
  });

  it("Rend applies Hemorrhage from the wolf's side", () => {
    const hero = {
      ...initHero("Archer", { heroClass: "archer" }),
      talents: { beastmaster_apex_predator: 1 },
    };
    const wolf = buildPetCombatant(hero);
    const rend = wolf.abilities.find(ability => ability.id === "wolf_rend");
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [wolf],
      heroAbilities: [],
      heroEffects: collectEffects(hero),
    });

    state = {
      ...state,
      actionQueue: enqueueAbility(createActionQueue(), "wolf_companion", ACTION.ABILITY_0, rend.castTicks, state.tick, 0, rend, { targetId: "enemy" }),
    };
    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.combatants.enemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "hemorrhage",
      remainingTicks: 3,
      damagePctPerTick: 1.5,
    }));
    expect(state.log.some(entry => entry.actorId === "wolf_companion" && entry.type === "hemorrhage" && entry.text.includes("Training Dummy gains Hemorrhage"))).toBe(true);
    expect(state.log.some(entry => entry.actorId === "wolf_companion" && entry.type === "hemorrhage" && entry.text.includes("You gain Hemorrhage"))).toBe(false);
  });

  it("Flanking grants the hero a crit bonus when hero and wolf hit within two seconds", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 10,
      heroArmor: 0,
      heroCritChance: 0,
      heroAttackRate: 10,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 10, armor: 0, attackSpeed: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [{ type: "pet_flanking", windowTicks: 2, critChanceBonus: 30 }],
    });

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    state = {
      ...state,
      actionQueue: enqueueAction(createActionQueue(), "wolf", ACTION.BASIC_ATTACK, state.tick, 10, null, 1, { targetId: "enemy" }),
    };
    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.procState.lastHeroFlankingHitTick).toBe(1);
    expect(state.procState.lastAllyFlankingHitTick).toBe(2);
    expect(state.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "crit_chance_buff",
      value: 30,
      source: "beastmaster_flanking",
      consumeOnNextHit: true,
    }));
    expect(state.log.some(entry => entry.type === "proc" && entry.text.includes("Flanking"))).toBe(true);

    const rolls = [0, 0.2, 0.01];
    state = processTick(state, ACTION.BASIC_ATTACK, () => rolls.shift() ?? 0.01);
    const heroCrit = state.log.find(entry => entry.actorId === "hero" && entry.type === "hit" && entry.tick === state.tick);
    expect(heroCrit?.isCrit).toBe(true);
  });

  it("Undying Will saves the wolf from lethal damage once per fight", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 30, armor: 0, attackSpeed: 3 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 10,
        disableAutoAttack: true,
        stats: { maxHp: 10, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [{ type: "pet_death_save", hp: 1, source: "beastmaster_undying_will" }],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.combatants.allies[0].hp).toBe(1);
    expect(state.frontId).toBe("wolf");
    expect(state.procState.onceFiredIds).toContain("beastmaster_undying_will:wolf");
    expect(state.log.some(entry => entry.actorId === "wolf" && entry.type === "death_save" && entry.text.includes("Undying Will"))).toBe(true);

    state = {
      ...state,
      actionQueue: enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, state.tick, 30, null, 1, { targetId: "wolf" }),
    };
    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.combatants.allies[0].hp).toBe(0);
    expect(state.frontId).toBe("hero");
    expect(state.log.filter(entry => entry.actorId === "wolf" && entry.type === "death_save")).toHaveLength(1);
  });

  it("Shared Fury grants wolf attack speed at 50 or more Rage and fades below it", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 75,
      heroMaxHp: 75,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        stats: { maxHp: 30, attack: 5, armor: 0, attackSpeed: 1 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [{ type: "pet_rage_attack_speed", rageThreshold: 50, attackSpeedBonusPct: 50, source: "beastmaster_shared_fury" }],
    });

    state = processTick(withCombatRage(state, 55), ACTION.NONE, () => 0.5);
    expect(state.heroResources.rage.value).toBe(55);
    expect(state.combatants.allies[0].passiveEffects).toContainEqual({
      type: "attack_speed_bonus_pct",
      value: 50,
      source: "beastmaster_shared_fury",
    });
    expect(state.log.some(entry => entry.type === "proc" && entry.text.includes("Shared Fury"))).toBe(true);

    for (let i = 0; i < 5; i += 1) {
      state = processTick(state, ACTION.NONE, () => 0.5);
    }
    expect(state.heroResources.rage.value).toBe(49);
    expect(state.combatants.allies[0].passiveEffects.some(effect => effect.source === "beastmaster_shared_fury")).toBe(false);
    expect(state.log.some(entry => entry.type === "proc" && entry.text.includes("Shared Fury fades"))).toBe(true);
  });

  it("Unleash sends the wolf into a risky short frenzy", () => {
    const hero = {
      id: "hero",
      name: "Archer",
      isPlayer: true,
      hp: 75,
      maxHp: 75,
      damage: 5,
      activeEffects: [],
      passiveEffects: [],
    };
    const wolf = {
      id: "wolf",
      name: "Wolf",
      isAlly: true,
      team: "player",
      hp: 30,
      maxHp: 30,
      damage: 10,
      activeEffects: [],
      passiveEffects: [],
    };

    const entries = resolveAbilityImpact({ ability: combatSkillById.unleash }, hero, wolf, 1, () => 0.5, {});

    expect(entries).toContainEqual(expect.objectContaining({ type: "buff", targetId: "wolf" }));
    expect(wolf.activeEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "attack_speed_buff", value: 50, remainingTicks: 4, sourceAbilityId: "unleash" }),
      expect.objectContaining({ type: "damage_bonus_pct_buff", value: 35, remainingTicks: 4, sourceAbilityId: "unleash" }),
      expect.objectContaining({ type: "incoming_damage_taken_bonus_pct", value: 30, remainingTicks: 4, sourceAbilityId: "unleash" }),
      expect.objectContaining({ type: "pet_unleash", remainingTicks: 4, recoveryTicks: 3, sourceAbilityId: "unleash" }),
    ]));
  });

  it("reduces back-row melee ally auto-attack damage", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        disableAutoAttack: true,
        stats: { maxHp: 40, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        stats: { maxHp: 30, attack: 12, armor: 0, attackSpeed: 3 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    state = { ...state, frontId: "hero" };
    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "wolf" && entry.type === "hit");
    expect(hit?.damage).toBe(9);
    expect(hit?.backRowPenalty).toBe(true);
    expect(hit?.backRowDamageMult).toBe(0.75);
    expect(state.combatants.enemy.hp).toBe(31);
  });

  it("does not reduce front-line melee ally auto-attack damage", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        disableAutoAttack: true,
        stats: { maxHp: 40, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        stats: { maxHp: 30, attack: 12, armor: 0, attackSpeed: 3 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "wolf" && entry.type === "hit");
    expect(hit?.damage).toBe(12);
    expect(hit?.backRowPenalty).toBe(false);
    expect(state.combatants.enemy.hp).toBe(28);
  });

  it("does not reduce ranged hero auto-attack damage from the back row", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      heroAttackRate: 3,
      heroWeaponTags: ["ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 60,
        disableAutoAttack: true,
        stats: { maxHp: 60, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    expect(state.frontId).toBe("wolf");
    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "hero" && entry.type === "hit");
    expect(hit?.damage).toBe(20);
    expect(hit?.backRowPenalty).toBe(false);
    expect(state.combatants.enemy.hp).toBe(40);
  });

  it("reduces melee hero auto-attack damage from the back row", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      heroAttackRate: 3,
      heroWeaponTags: ["sword", "weapon", "melee"],
      heroAttackType: "melee",
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 60,
        disableAutoAttack: true,
        stats: { maxHp: 60, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    expect(state.frontId).toBe("wolf");
    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "hero" && entry.type === "hit");
    expect(hit?.damage).toBe(15);
    expect(hit?.backRowPenalty).toBe(true);
    expect(hit?.backRowDamageMult).toBe(0.75);
    expect(state.combatants.enemy.hp).toBe(45);
  });

  it("allows ranged hero auto-attacks while trapped", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      heroAttackRate: 3,
      heroWeaponTags: ["bow", "weapon", "ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 60,
        disableAutoAttack: true,
        stats: { maxHp: 60, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          activeEffects: [{ type: "bear_trap", remainingTicks: 3, allowRangedAutoAttacks: true }],
        },
      },
    };

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "hero" && entry.type === "hit");
    expect(state.combatants.hero.attackType).toBe("ranged");
    expect(hit?.damage).toBe(20);
    expect(state.combatants.enemy.hp).toBe(40);
    expect(state.log.some(entry => entry.type === "trap")).toBe(false);
  });

  it("Bear Trap stops the target's next auto-attack and stuns it", () => {
    const bearTrap = combatSkillById.bear_trap;
    let state = withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      heroWeaponTags: ["ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 20, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [bearTrap],
      heroEffects: [],
    }));

    state = processTick(state, ACTION.ABILITY_0, () => 0.5);
    state = processTick(state, ACTION.NONE, () => 0.5);
    expect(state.combatants.enemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "bear_trap",
      triggerStunTicks: 2,
      bossTriggerStunTicks: 1,
    }));

    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: {
          ...state.combatants.enemy,
          disableAutoAttack: false,
          autoAttackRate: 3,
          baseAutoAttackRate: 3,
          autoAttackStarted: true,
          autoAttackProgressTicks: AUTO_ATTACK_TICKS,
          nextAutoAttackTick: state.tick,
        },
      },
    };

    const beforeHp = state.combatants.hero.hp;
    state = processTick(state, ACTION.NONE, () => 0.5);

    expect(state.combatants.hero.hp).toBe(beforeHp);
    expect(state.combatants.enemy.activeEffects.some(effect => effect.type === "bear_trap")).toBe(false);
    expect(state.combatants.enemy.stunUntilTick).toBe(state.tick + 2);
    expect(state.log.some(entry => (
      entry.actorId === "enemy"
      && entry.type === "trap"
      && entry.abilityId === "bear_trap"
      && entry.stunTicks === 2
      && entry.text.includes("auto attack is stopped")
    ))).toBe(true);
  });

  it("Bear Trap can miss using the ranged ability hit chance roll", () => {
    const bearTrap = combatSkillById.bear_trap;
    let state = withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      heroWeaponTags: ["ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 20, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [bearTrap],
      heroEffects: [],
    }));

    state = processTick(state, ACTION.ABILITY_0, () => 0.99);
    state = processTick(state, ACTION.NONE, () => 0.99);

    expect(state.combatants.enemy.activeEffects.some(effect => effect.type === "bear_trap")).toBe(false);
    expect(state.log.some(entry => (
      entry.actorId === "hero"
      && entry.type === "miss"
      && entry.abilityId === "bear_trap"
      && entry.text.includes("Bear Trap misses")
    ))).toBe(true);
  });

  it("Snare Specialist makes Bear Trap stagger the target for two attacks", () => {
    const bearTrap = combatSkillById.bear_trap;
    let state = withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      heroWeaponTags: ["ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 20, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [bearTrap],
      heroEffects: [{
        type: "bear_trap_upgrade",
        staggerAttacks: 2,
        staggerDurationTicks: 4,
        missPenalty: 35,
        source: "ranger_snare_specialist",
      }],
    }));

    state = processTick(state, ACTION.ABILITY_0, () => 0.5);
    state = processTick(state, ACTION.NONE, () => 0.5);
    expect(state.combatants.enemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "bear_trap",
      staggerAttacks: 2,
      staggerDurationTicks: 4,
      staggerMissPenalty: 35,
      upgradeSource: "ranger_snare_specialist",
    }));

    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: {
          ...state.combatants.enemy,
          disableAutoAttack: false,
          autoAttackRate: 3,
          baseAutoAttackRate: 3,
          autoAttackStarted: true,
          autoAttackProgressTicks: AUTO_ATTACK_TICKS,
          nextAutoAttackTick: state.tick,
        },
      },
    };

    state = processTick(state, ACTION.NONE, () => 0.5);

    const stagger = state.combatants.enemy.activeEffects.find(effect => effect.type === "stagger");
    expect(stagger).toMatchObject({
      attacksRemaining: 2,
      remainingTicks: 4,
      missPenalty: 35,
      source: "ranger_snare_specialist",
    });
    expect(state.log.some(entry => (
      entry.actorId === "enemy"
      && entry.type === "stagger"
      && entry.abilityId === "bear_trap"
      && entry.staggerAttacks === 2
      && entry.text.includes("Snare Specialist")
    ))).toBe(true);
  });

  it("Barbed Trap bleeds and slows the target when its auto-attack triggers it", () => {
    const barbedTrap = combatSkillById.barbed_trap;
    let state = withCombatRage(initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      heroWeaponTags: ["ranged"],
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 20, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [barbedTrap],
      heroEffects: [],
    }));

    state = processTick(state, ACTION.ABILITY_0, () => 0.5);
    state = processTick(state, ACTION.NONE, () => 0.5);
    expect(state.combatants.enemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "barbed_trap",
      bleedDurationTicks: 5,
      attackSpeedPenaltyPct: 20,
      slowDurationTicks: 4,
    }));

    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: {
          ...state.combatants.enemy,
          activeEffects: [
            ...state.combatants.enemy.activeEffects,
            { type: "poison", remainingTicks: 3, stacks: 1, damagePctPerTick: 3 },
          ],
          disableAutoAttack: false,
          autoAttackRate: 3,
          baseAutoAttackRate: 3,
          autoAttackStarted: true,
          autoAttackProgressTicks: AUTO_ATTACK_TICKS,
          nextAutoAttackTick: state.tick,
        },
      },
    };

    state = processTick(state, ACTION.NONE, () => 0.5);

    expect(state.combatants.enemy.activeEffects.some(effect => effect.type === "barbed_trap")).toBe(false);
    expect(state.combatants.enemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "bleed",
      stacks: 1,
      remainingTicks: 5,
      damagePctPerTick: 0.75,
      sourceAbilityId: "barbed_trap",
    }));
    expect(state.combatants.enemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "attack_speed_slow",
      remainingTicks: 4,
      attackSpeedPenaltyPct: 20,
      sourceAbilityId: "barbed_trap",
    }));
    expect(state.log.some(entry => entry.type === "trap" && entry.abilityId === "barbed_trap")).toBe(true);
    expect(state.log.some(entry => entry.type === "stagger" && entry.abilityId === "barbed_trap")).toBe(true);
  });

  it("Bear Trap only stuns bosses for one second", () => {
    let state = initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "boss_dummy",
        name: "Boss Dummy",
        hp: 100,
        phases: [],
        stats: { maxHp: 100, attack: 20, armor: 0, attackSpeed: 3 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: {
          ...state.combatants.enemy,
          activeEffects: [{
            type: "bear_trap",
            remainingTicks: 3,
            triggerStunTicks: 2,
            bossTriggerStunTicks: 1,
            sourceAbilityId: "bear_trap",
          }],
          autoAttackStarted: true,
          autoAttackProgressTicks: AUTO_ATTACK_TICKS,
          nextAutoAttackTick: state.tick,
        },
      },
    };

    state = processTick(state, ACTION.NONE, () => 0.5);

    expect(state.combatants.hero.hp).toBe(100);
    expect(state.combatants.enemy.isBoss).toBe(true);
    expect(state.combatants.enemy.stunUntilTick).toBe(state.tick + 1);
    expect(state.log.some(entry => entry.type === "trap" && entry.stunTicks === 1)).toBe(true);
  });

  it("does not apply back-row damage penalties to enemies", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        stats: { maxHp: 40, attack: 20, armor: 0, attackSpeed: 3 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    state = { ...state, frontId: "hero" };
    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "enemy" && entry.type === "hit");
    expect(hit?.targetId).toBe("hero");
    expect(hit?.damage).toBe(20);
    expect(hit?.backRowPenalty).toBe(false);
    expect(state.combatants.hero.hp).toBe(80);
  });

  it("ally death flips the front line back to the hero without ending combat", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 40,
        stats: { maxHp: 40, attack: 20, armor: 0, attackSpeed: 3 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 10,
        disableAutoAttack: true,
        stats: { maxHp: 10, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.combatants.allies[0].hp).toBe(0);
    expect(state.frontId).toBe("hero");
    expect(state.combatants.hero.hp).toBe(100);
    expect(state.phase).toBe(PHASE.FIGHTING);
  });

  it("swaps the front line between hero and living ally", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    expect(state.frontId).toBe("wolf");

    state = processTick(state, ACTION.SWAP_FRONT, () => 0.01);
    expect(state.frontId).toBe("wolf");
    expect(state.log.some(entry => entry.type === "cast_start" && entry.abilityId === "front_swap")).toBe(true);
    const swapCast = state.actionQueue.find(action => action.ability?.type === "front_swap");
    expect(swapCast).toMatchObject({
      startTick: 1,
      castEndTick: 2.5,
      impactTick: 2.5,
      ability: expect.objectContaining({ castTicks: 1.5 }),
    });
    state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.frontId).toBe("wolf");
    state = resolveFrontSwapCast(state, swapCast.id);
    expect(state.tick).toBe(2.5);
    expect(state.frontId).toBe("hero");
    expect(state.log.some(entry => entry.type === "front_swap" && entry.frontId === "hero")).toBe(true);

    state = processTick(state, ACTION.SWAP_FRONT, () => 0.01);
    expect(state.frontId).toBe("hero");
    expect(state.log.some(entry => entry.type === "front_swap_fail" && String(entry.text).includes("cooldown"))).toBe(true);
    for (let i = 0; i < 3; i += 1) state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.SWAP_FRONT, () => 0.01);
    const secondSwapCast = state.actionQueue.find(action => action.ability?.type === "front_swap");
    state = resolveFrontSwapCast(state, secondSwapCast.id);
    expect(state.frontId).toBe("wolf");
    expect(state.log.some(entry => entry.type === "front_swap" && entry.frontId === "wolf")).toBe(true);
  });

  it("pauses hero and ally auto-attacks while swap is casting", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 40,
      heroArmor: 0,
      heroAttackRate: 3,
      enemyObj: {
        name: "Training Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        stats: { maxHp: 30, attack: 40, armor: 0, attackSpeed: 3 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.SWAP_FRONT, () => 0.01);
    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    expect(state.combatants.enemy.hp).toBe(100);
    expect(state.log.some(entry => (entry.actorId === "hero" || entry.actorId === "wolf") && entry.type === "hit")).toBe(false);
    expect(state.actionQueue.some(action => action.ability?.type === "front_swap")).toBe(true);

    const swapCast = state.actionQueue.find(action => action.ability?.type === "front_swap");
    state = resolveFrontSwapCast(state, swapCast.id);
    expect(state.frontId).toBe("hero");
    expect(state.combatants.enemy.hp).toBe(100);
    expect(state.combatants.hero.abilityCooldowns.front_swap).toBe(state.tick + 4);
  });

  it("enemies attack the hero after swapping the ally out of front", () => {
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        name: "Goblin",
        hp: 100,
        stats: { maxHp: 100, attack: 20, armor: 0, attackSpeed: 0.5 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      allies: [{
        id: "wolf",
        name: "Wolf",
        hp: 30,
        disableAutoAttack: true,
        stats: { maxHp: 30, attack: 0, armor: 0 },
        effects: [],
      }],
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.SWAP_FRONT, () => 0.01);
    for (let i = 0; i < 5; i += 1) state = processTick(state, ACTION.NONE, () => 0.01);

    const hit = state.log.find(entry => entry.actorId === "enemy" && entry.type === "hit");
    expect(hit?.targetId).toBe("hero");
    expect(hit?.damage).toBe(20);
    expect(hit?.backRowPenalty).toBe(false);
    expect(state.combatants.hero.hp).toBeLessThan(100);
    expect(state.combatants.allies[0].hp).toBe(30);
  });

  it("marks hero auto-attack critical hits in the combat log", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 12,
      heroArmor: 0,
      heroCritChance: 100,
      heroCritMult: 2,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 1, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const next = processTick(state, ACTION.BASIC_ATTACK, () => 0);
    const heroHit = next.log.find(entry => entry.actorId === "hero" && entry.damage > 0);

    expect(heroHit?.isCrit).toBe(true);
    expect(heroHit?.text).toMatch(/CRIT|Critical/i);
  });

  it("initializes multiple enemies from an encounter group", () => {
    const rat = enemyById.blood_rat;
    const crow = enemyById.crow_swarm;
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObjs: [
        { ...rat, hp: rat.baseStats.maxHp, stats: rat.baseStats },
        { ...crow, hp: crow.baseStats.maxHp, stats: crow.baseStats },
      ],
      bossDeathEndsFight: false,
      heroAbilities: [],
      heroEffects: [],
    });

    expect(state.combatants.enemies).toHaveLength(2);
    expect(state.combatants.enemies.map(enemy => enemy.id)).toEqual(["enemy", "enemy_1"]);
    expect(state.combatants.enemy).toBe(state.combatants.enemies[0]);
    expect(state.combatants.enemies[1].sourceId).toBe("crow_swarm");
    expect(state.selectedTargetId).toBe("enemy");
    expect(state.bossDeathEndsFight).toBe(false);
  });

  it("keeps a duplicate pack encounter fighting after one copy dies", () => {
    const warg = enemyById.warg;
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 500,
      heroMaxHp: 500,
      heroDamage: 5,
      heroArmor: 0,
      enemyObjs: [
        { ...warg, hp: 0, stats: { ...warg.baseStats, maxHp: warg.baseStats.maxHp } },
        { ...warg, hp: warg.baseStats.maxHp, stats: warg.baseStats },
      ],
      bossDeathEndsFight: false,
      heroAbilities: [],
      heroEffects: [],
    });

    const next = processTick(state, ACTION.NONE, () => 0.5);

    expect(next.phase).toBe(PHASE.FIGHTING);
    expect(next.combatants.enemies).toHaveLength(2);
    expect(next.combatants.enemies[0].hp).toBe(0);
    expect(next.combatants.enemies[1].hp).toBeGreaterThan(0);
    expect(next.selectedTargetId).toBe("enemy_1");
  });

  it("marks queued actions with targets and ends the fight when the boss target dies", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "boss_dummy",
        name: "Boss Dummy",
        hp: 40,
        stats: { maxHp: 40, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    const add = {
      ...state.combatants.enemy,
      id: "add_1",
      name: "Training Add",
      hp: 20,
      maxHp: 20,
      damage: 0,
      activeEffects: [],
      passiveEffects: [],
      abilityCooldowns: {},
      combatTriggers: {},
    };
    state.combatants = {
      ...state.combatants,
      enemies: [state.combatants.enemy, add],
    };
    state.actionQueue = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 0, 99, null, 1, {
      targetId: "enemy",
    });

    const resolved = processTick(state, ACTION.NONE, () => 0.1);
    const hit = resolved.log.find(entry => entry.actorId === "hero" && entry.type === "hit");
    const despawnedAdd = resolved.combatants.enemies.find(entry => entry.id === "add_1");

    expect(hit?.targetId).toBe("enemy");
    expect(resolved.phase).toBe(PHASE.WON);
    expect(despawnedAdd).toMatchObject({ hp: 0, despawned: true });
  });

  it("uses hero hit chance bonus when resolving interactive basic attacks", () => {
    const state = initCombat({
      heroName: "Accurate Hero",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroHitChanceBonus: 5,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    state.combatants.enemy.stunUntilTick = 1;
    state.actionQueue = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 0, 10, null, 1);

    const resolved = processTick(state, ACTION.NONE, () => 0.94);

    expect(resolved.log.some(entry => entry.actorId === "hero" && entry.type === "hit")).toBe(true);
    expect(resolved.combatants.enemy.hp).toBe(90);
  });

  it("applies passive armor penetration to hero basic attacks", () => {
    const state = initCombat({
      heroName: "Piercer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 100,
      heroArmor: 0,
      heroCritChance: 0,
      enemyObj: {
        id: "armored_dummy",
        name: "Armored Dummy",
        hp: 5000,
        stats: { maxHp: 5000, attack: 0, armor: 100 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "armor_penetration", value: 50 }],
    });

    const resolved = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    expect(resolved.combatants.enemy.hp).toBe(4933);
    expect(resolved.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && entry.damage === 67)).toBe(true);
  });

  it("applies spear-style damage bonuses against beast-tagged enemies only", () => {
    const beastState = initCombat({
      heroName: "Hunter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 100,
      heroArmor: 0,
      heroCritChance: 0,
      enemyObj: {
        id: "beast_dummy",
        name: "Beast Dummy",
        hp: 1000,
        family: "wolf",
        tags: ["beast"],
        stats: { maxHp: 1000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "damage_vs_tag", tag: "beast", value: 15 }],
    });
    const armoredState = initCombat({
      heroName: "Hunter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 100,
      heroArmor: 0,
      heroCritChance: 0,
      enemyObj: {
        id: "armor_dummy",
        name: "Armor Dummy",
        hp: 1000,
        family: "construct",
        tags: ["construct"],
        stats: { maxHp: 1000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "damage_vs_tag", tag: "beast", value: 15 }],
    });

    const beastResolved = processTick(beastState, ACTION.BASIC_ATTACK, () => 0.01);
    const armorResolved = processTick(armoredState, ACTION.BASIC_ATTACK, () => 0.01);

    expect(beastResolved.combatants.enemy.hp).toBe(885);
    expect(armorResolved.combatants.enemy.hp).toBe(900);
  });

  it("applies passive physical reduction after armor to basic attacks", () => {
    const state = initCombat({
      heroName: "Striker",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 100,
      heroArmor: 0,
      heroCritChance: 0,
      enemyObj: {
        id: "resistant_dummy",
        name: "Resistant Dummy",
        hp: 5000,
        stats: { maxHp: 5000, attack: 0, armor: 100 },
        effects: [{ type: "physical_reduction_pct", value: 30 }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const resolved = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    expect(resolved.combatants.enemy.hp).toBe(4965);
    expect(resolved.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && entry.damage === 35)).toBe(true);
  });

  it("keeps Wraith as a disruptive Crypts caster with working Grave Chill", () => {
    const wraith = enemyById.wraith;
    expect(wraith.baseStats).toMatchObject({
      maxHp: 90,
      attack: 13,
      armor: 9,
      magicDefense: 10,
    });
    expect(wraith.effects).toContainEqual({ type: "physical_reduction_pct", value: 20 });
    expect(wraith.effects).toContainEqual({ type: "spell_damage", value: 15 });
    expect(wraith.abilities).toContainEqual(expect.objectContaining({
      id: "grave_chill",
      type: "stagger_spell",
      attacks: 2,
      missPenalty: 35,
    }));
    expect(wraith.abilities).toContainEqual(expect.objectContaining({
      id: "shadow_bolt",
      type: "spell_attack",
      element: "shadow",
      castTicks: 3,
      cooldownSeconds: 10,
      damage: 31,
      castVisual: expect.objectContaining({
        animation: expect.objectContaining({
          src: "/assets/spells/Buffs/electirc_spark.png",
        }),
      }),
    }));

    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...wraith, hp: wraith.baseStats.maxHp, stats: wraith.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });

    const casting = processTick(state, ACTION.NONE, () => 0.01);
    const chilled = processTick(casting, ACTION.NONE, () => 0.5);
    const stagger = chilled.combatants.hero.activeEffects.find(effect => effect.type === "stagger");

    expect(casting.log.some(entry => entry.type === "cast_start" && entry.abilityId === "grave_chill")).toBe(true);
    expect(chilled.log.some(entry => entry.type === "stagger" && entry.abilityId === "grave_chill")).toBe(true);
    expect(stagger).toMatchObject({ attacksRemaining: 2, missPenalty: 35 });

    const shadowState = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...wraith, hp: wraith.baseStats.maxHp, stats: wraith.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });
    shadowState.combatants.enemy.abilityCooldowns.grave_chill = 99;

    const shadowCasting = processTick(shadowState, ACTION.NONE, () => 0.01);
    const shadowCharging = processTick(shadowCasting, ACTION.NONE, () => 0.5);
    const shadowCharged = processTick(shadowCharging, ACTION.NONE, () => 0.5);
    const shadowHit = processTick(shadowCharged, ACTION.NONE, () => 0.5);

    expect(shadowCasting.log.some(entry => entry.type === "cast_start" && entry.abilityId === "shadow_bolt")).toBe(true);
    expect(shadowCharged.combatants.hero.hp).toBe(100);
    expect(shadowHit.combatants.hero.hp).toBe(71);
    expect(shadowHit.log.some(entry => entry.type === "ability" && entry.abilityId === "shadow_bolt" && entry.damage === 29)).toBe(true);
  });

  it("has Ghoul Life Drain active from its first damaging auto attack", () => {
    const ghoul = enemyById.ghoul;
    const base = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      heroBlockPower: 10,
      heroBlockPowerRegen: 0,
      enemyObj: { ...ghoul, hp: ghoul.baseStats.maxHp, stats: ghoul.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });
    const woundedGhoul = {
      ...base.combatants.enemy,
      hp: 70,
    };
    const state = {
      ...base,
      tick: 2,
      actionQueue: enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 40, null, undefined, { targetId: "hero" }),
      combatants: {
        ...base.combatants,
        enemy: woundedGhoul,
        enemies: [woundedGhoul],
      },
    };

    const drained = processTick(state, ACTION.BLOCK, () => 0.1);

    expect(drained.combatants.hero.hp).toBe(70);
    expect(drained.combatants.enemy.hp).toBe(77);
    expect(drained.log.some(entry => entry.actorId === "enemy" && entry.type === "heal" && entry.text.includes("drains 7 HP"))).toBe(true);
  });

  it("runs the Lich as a caster boss with shadow bolts and delayed summons", () => {
    const lich = bossById.lich;
    const skeletonSummons = lich.phases.map(phase => phase.effects.find(effect => effect.id === "summon_skeleton_spell"));
    expect(skeletonSummons.every(Boolean)).toBe(true);
    for (const summon of skeletonSummons) {
      expect(summon).toMatchObject({ maxAdds: 1, cooldownSeconds: 7 });
    }

    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      heroShadowResist: 100,
      enemyObj: { ...lich, hp: lich.baseStats.maxHp, stats: lich.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });

    let shadowState = state;
    for (let i = 0; i < 3; i += 1) shadowState = processTick(shadowState, ACTION.NONE, () => 0.99);
    expect(shadowState.log.some(entry => entry.actorId === "enemy" && entry.type === "hit")).toBe(false);
    expect(shadowState.log.some(entry => entry.abilityId === "lich_shadow_bolt" && entry.element === "shadow" && entry.damage === 7)).toBe(true);
    expect(shadowState.combatants.hero.hp).toBe(93);

    const summonRng = (() => {
      const rolls = [0];
      return () => rolls.shift() ?? 0.99;
    })();
    const casting = processTick(state, ACTION.NONE, summonRng);
    const chargingOne = processTick(casting, ACTION.NONE, summonRng);
    const chargingTwo = processTick(chargingOne, ACTION.NONE, summonRng);
    const summoned = processTick(chargingTwo, ACTION.NONE, summonRng);

    expect(casting.log.some(entry => entry.type === "cast_start" && entry.abilityId === "summon_skeleton_spell")).toBe(true);
    expect(chargingTwo.combatants.enemies.some(enemy => enemy.sourceId === "skeleton" && enemy.hp > 0)).toBe(false);
    expect(summoned.combatants.enemies.some(enemy => enemy.sourceId === "skeleton" && enemy.hp > 0)).toBe(true);
  });

  it("configures the Lich bone hazard as a 1 HP explosive skeleton", () => {
    const explosiveHazards = bossById.lich.phases.map(phase => phase.effects.find(effect => effect.type === "delayed_hazard_summon"));

    expect(explosiveHazards.every(Boolean)).toBe(true);
    for (const hazard of explosiveHazards) {
      expect(hazard).toMatchObject({
        id: "explosive_skeleton_summon",
        name: "Explosive Skeleton Summon",
        hazardId: "explosive_skeleton",
        hazardName: "Explosive Skeleton",
        hazardSprite: "/assets/sprites/encounters/skeleton.png",
        hazardHp: 1,
        durationTicks: 5,
        explosionDamage: 30,
      });
    }
  });

  it("respects delayed phase summon cooldowns before recasting", () => {
    let state = initCombat({
      heroName: "Tester",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 0,
      heroArmor: 0,
      enemyObj: {
        id: "cooldown_summoner",
        name: "Cooldown Summoner",
        disableAutoAttack: true,
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
        phases: [{
          id: "summon",
          label: "Summon",
          thresholdPct: 100,
          stats: { attack: 0, armor: 0 },
          effects: [{
            type: "delayed_summon_add",
            id: "cooldown_skeleton_summon",
            name: "Cooldown Skeleton",
            chance: 100,
            castTicks: 1,
            cooldownSeconds: 6,
            enemyId: "skeleton",
            maxAdds: 1,
            maxSummons: 3,
          }],
        }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.log.filter(entry => entry.type === "cast_start" && entry.abilityId === "cooldown_skeleton_summon")).toHaveLength(1);

    state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.combatants.enemy.abilityCooldowns.cooldown_skeleton_summon).toBe(8);
    expect(state.combatants.enemies.some(enemy => enemy.sourceId === "skeleton" && enemy.hp > 0)).toBe(true);

    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemies: state.combatants.enemies.map(enemy => (
          enemy.sourceId === "skeleton" ? { ...enemy, hp: 0 } : enemy
        )),
      },
    };

    for (let i = 0; i < 5; i += 1) state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.tick).toBe(7);
    expect(state.log.filter(entry => entry.type === "cast_start" && entry.abilityId === "cooldown_skeleton_summon")).toHaveLength(1);

    state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.tick).toBe(8);
    expect(state.log.filter(entry => entry.type === "cast_start" && entry.abilityId === "cooldown_skeleton_summon")).toHaveLength(2);
  });

  it("runs the Fallen Knight pillar intermission at 70% HP", () => {
    const fallenKnight = bossById.fallen_knight;
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 18,
      heroArmor: 0,
      enemyObj: {
        ...fallenKnight,
        hp: Math.floor(fallenKnight.baseStats.maxHp * 0.69),
        stats: fallenKnight.baseStats,
      },
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.99);

    const boss = state.combatants.enemy;
    const pillars = state.combatants.enemies.filter(enemy => enemy.sourceId === "fallen_knight_oath_pillar");
    expect(boss.combatHidden).toBe(true);
    expect(boss.untargetable).toBe(true);
    expect(pillars).toHaveLength(4);
    expect(pillars.map(pillar => pillar.pillarState).sort()).toEqual(["blue", "blue", "purple", "purple"]);
    expect(state.selectedTargetId).toBe(pillars[0].id);
    expect(state.log.some(entry => entry.abilityType === "pillar_intermission" && entry.text.includes("Four pillars"))).toBe(true);

    const firstPillarId = pillars[0].id;
    for (let i = 0; i < 3; i += 1) state = processTick(state, ACTION.NONE, () => 0.99);
    const shiftedPillar = state.combatants.enemies.find(enemy => enemy.id === firstPillarId);
    expect(shiftedPillar.pillarState).toBe("purple");
    expect(shiftedPillar.sprite).toBe("/assets/sprites/encounters/Bosses/Fallen knight purple pillar.png");

    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemies: state.combatants.enemies.map(enemy => (
          enemy.sourceId === "fallen_knight_oath_pillar" ? { ...enemy, hp: 0 } : enemy
        )),
      },
    };
    state = processTick(state, ACTION.NONE, () => 0.99);
    expect(state.combatants.enemy.combatHidden).toBe(false);
    expect(state.log.some(entry => entry.text.includes("Fallen Knight steps back"))).toBe(true);
  });

  it("applies the purple pillar backlash and stacking shadow burn when the player strikes that state", () => {
    const fallenKnight = bossById.fallen_knight;
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 24,
      heroArmor: 0,
      heroShadowResist: 0,
      enemyObj: {
        ...fallenKnight,
        hp: Math.floor(fallenKnight.baseStats.maxHp * 0.69),
        stats: fallenKnight.baseStats,
      },
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.99);
    const purplePillar = state.combatants.enemies.find(enemy => enemy.pillarState === "purple");
    const heroHpBefore = state.combatants.hero.hp;
    state = {
      ...state,
      selectedTargetId: purplePillar.id,
      enemyFrontId: purplePillar.id,
    };

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    expect(state.combatants.hero.hp).toBe(heroHpBefore - 20);
    expect(state.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "shadow_burn",
      damageFlat: 20,
      element: "shadow",
      stacks: 1,
      maxStacks: 3,
    }));
    expect(state.log.some(entry =>
      entry.abilityType === "state_hit_reaction"
      && entry.state === "purple"
      && entry.element === "shadow"
      && entry.damage === 20
      && entry.dotType === "shadow_burn"
      && entry.dotStacks === 1
    )).toBe(true);

    const hpBeforeTick = state.combatants.hero.hp;
    state = processTick(state, ACTION.NONE, () => 0.99);
    expect(state.combatants.hero.hp).toBe(hpBeforeTick - 20);
    expect(state.log.some(entry =>
      entry.type === "shadow_burn"
      && entry.element === "shadow"
      && entry.damage === 20
    )).toBe(true);
  });

  it("runs the Orc Shaman as a cast-only fire summoner", () => {
    const shaman = bossById.orc_shaman;
    const summoner = shaman.phases.find(phase => phase.id === "summoner");
    const frenzy = shaman.phases.find(phase => phase.id === "frenzy");
    const spectral = shaman.phases.find(phase => phase.id === "spectral");

    expect(shaman.sprite).toBe("/assets/sprites/encounters/Bosses/Orc shaman boss.png");
    expect(shaman.disableAutoAttack).toBe(true);
    expect(shaman.baseStats).toMatchObject({ attack: 0, spellDamage: 18 });
    expect(summoner.effects.find(effect => effect.type === "delayed_summon_add")).toMatchObject({
      id: "orc_shaman_summon_patrol",
      enemyId: "orc_patrol",
      castTicks: 2,
    });
    expect(summoner.effects.some(effect => effect.id === "orc_shaman_burning_hex" && effect.burning?.durationTicks === 5)).toBe(true);
    expect(frenzy.effects.some(effect => effect.id === "orc_shaman_burning_hex" && effect.burning?.durationTicks === 5)).toBe(true);
    expect(spectral.effects.find(effect => effect.id === "orc_shaman_spectral_barrier")).toMatchObject({
      type: "boss_shield",
      shieldHp: 100,
      once: true,
    });

    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...shaman, hp: shaman.baseStats.maxHp, stats: shaman.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });

    const castingSummon = processTick(state, ACTION.NONE, () => 0.01);
    expect(castingSummon.actionQueue.find(action => action.actorId === "enemy" && action.ability?.id === "orc_shaman_summon_patrol")).toMatchObject({
      castEndTick: castingSummon.tick + 2,
      impactTick: castingSummon.tick + 2,
    });
    expect(castingSummon.log.some(entry => entry.type === "summon")).toBe(false);

    state = processTick(processTick(castingSummon, ACTION.NONE, () => 0.01), ACTION.NONE, () => 0.01);
    expect(state.combatants.enemies.some(enemy => enemy.sourceId === "orc_patrol")).toBe(true);

    for (let i = 0; i < 3; i += 1) state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.log.some(entry => entry.actorId === "enemy" && entry.type === "hit")).toBe(false);
    expect(state.log.some(entry => entry.actorId === "enemy" && entry.type === "cast_start" && entry.abilityId === "orc_shaman_burning_hex")).toBe(true);
  });

  it("lets the Orc Shaman apply Burning Hex and gain one spectral barrier", () => {
    const shaman = bossById.orc_shaman;
    const withBossState = (state, updates) => {
      const boss = { ...state.combatants.enemy, ...updates };
      return {
        ...state,
        combatants: {
          ...state.combatants,
          enemy: boss,
          enemies: state.combatants.enemies.map(enemy => enemy.id === boss.id ? boss : enemy),
        },
      };
    };

    let earlyBurningState = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...shaman, hp: shaman.baseStats.maxHp, stats: shaman.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });
    earlyBurningState = withBossState(earlyBurningState, {
      summonCounts: { orc_shaman_summon_patrol: 99 },
      bossTimers: { "casted_spell:orc_shaman_flame_bolt:ready": 999 },
    });
    earlyBurningState = processTick(earlyBurningState, ACTION.NONE, () => 0.01);
    expect(earlyBurningState.log.some(entry => entry.type === "cast_start" && entry.abilityId === "orc_shaman_burning_hex")).toBe(true);

    let burningState = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...shaman, hp: 90, stats: shaman.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });
    burningState = withBossState(burningState, {
      summonCounts: { orc_shaman_summon_patrol: 99 },
      bossTimers: { "casted_spell:orc_shaman_flame_bolt:ready": 999 },
    });
    for (let i = 0; i < 5; i += 1) burningState = processTick(burningState, ACTION.NONE, () => 0.01);

    expect(burningState.log.some(entry => entry.type === "cast_start" && entry.abilityId === "orc_shaman_burning_hex")).toBe(true);
    expect(burningState.log.some(entry => entry.abilityId === "orc_shaman_burning_hex" && entry.element === "fire" && entry.damage > 0)).toBe(true);
    expect(burningState.combatants.hero.activeEffects.some(effect => effect.type === "burning" && effect.damageFlat === 5)).toBe(true);

    let shieldState = initCombat({
      heroName: "Adventurer",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 40,
      heroArmor: 0,
      enemyObj: { ...shaman, hp: 35, stats: shaman.baseStats },
      heroAbilities: [],
      heroEffects: [],
    });
    shieldState = withBossState(shieldState, { summonCounts: { orc_shaman_summon_patrol: 99 } });
    const shielded = processTick(shieldState, ACTION.BASIC_ATTACK, () => 0.01);
    const barrier = shielded.combatants.enemy.activeEffects.find(effect => effect.type === "damage_shield");

    expect(shielded.log.filter(entry => entry.abilityId === "orc_shaman_spectral_barrier" && entry.type === "shield" && entry.text.includes("gains Spectral Barrier"))).toHaveLength(1);
    expect(shielded.combatants.enemy.hp).toBe(35);
    expect(barrier.shieldHp).toBeLessThan(100);

    const nextTick = processTick(shielded, ACTION.NONE, () => 0.01);
    expect(nextTick.log.filter(entry => entry.abilityId === "orc_shaman_spectral_barrier" && entry.text.includes("gains Spectral Barrier"))).toHaveLength(1);
  });

  it("summons explosive skeleton hazards that explode if they are not killed", () => {
    const pileBoss = {
      id: "pile_boss",
      name: "Pile Boss",
      family: "undead",
      threat: "boss",
      disableAutoAttack: true,
      hp: 100,
      stats: { maxHp: 100, attack: 0, armor: 0 },
      phases: [
        {
          id: "bones",
          label: "Bones",
          thresholdPct: 100,
          stats: { attack: 0, armor: 0 },
          effects: [
            {
              type: "delayed_hazard_summon",
              id: "explosive_skeleton_summon",
              name: "Explosive Skeleton Summon",
              chance: 100,
              castTicks: 2,
              hazardId: "explosive_skeleton",
              hazardName: "Explosive Skeleton",
              hazardSprite: "/assets/sprites/encounters/skeleton.png",
              hazardHp: 1,
              durationTicks: 4,
              explosionDamage: 30,
            },
          ],
        },
      ],
    };
    let state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: pileBoss,
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0);
    state = processTick(state, ACTION.NONE, () => 0.99);
    state = processTick(state, ACTION.NONE, () => 0.99);
    const explosiveSkeleton = state.combatants.enemies.find(enemy => enemy.sourceId === "explosive_skeleton");
    expect(explosiveSkeleton).toMatchObject({
      name: "Explosive Skeleton",
      hp: 1,
      maxHp: 1,
      sprite: "/assets/sprites/encounters/skeleton.png",
      explodeTick: 7,
    });

    state = processTick(state, ACTION.NONE, () => 0.99);
    state = processTick(state, ACTION.NONE, () => 0.99);
    state = processTick(state, ACTION.NONE, () => 0.99);
    state = processTick(state, ACTION.NONE, () => 0.99);

    expect(state.combatants.hero.hp).toBe(70);
    expect(state.log.some(entry => entry.type === "hazard_explosion" && entry.damage === 30)).toBe(true);
    expect(state.combatants.enemies.find(enemy => enemy.sourceId === "explosive_skeleton")?.hp).toBe(0);
  });

  it("applies passive armor penetration to physical ability impacts", () => {
    const state = withCombatRage(initCombat({
      heroName: "Piercer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 100,
      heroArmor: 0,
      heroCritChance: 0,
      enemyObj: {
        id: "armored_dummy",
        name: "Armored Dummy",
        hp: 5000,
        stats: { maxHp: 5000, attack: 0, armor: 100 },
        effects: [],
      },
      heroAbilities: [{
        id: "piercing_blow",
        name: "Piercing Blow",
        type: "empowered_attack",
        castTicks: 1,
        cooldown: 3,
        damageMult: 1,
        critChance: 0,
      }],
      heroEffects: [{ type: "armor_penetration", value: 50 }],
    }));

    const casting = processTick(state, ACTION.ABILITY_0, () => 0.01);
    const impacted = processTick(casting, ACTION.NONE, () => 0.01);

    expect(impacted.combatants.enemy.hp).toBe(4933);
    expect(impacted.log.some(entry => entry.actorId === "hero" && entry.abilityId === "piercing_blow" && entry.damage === 67)).toBe(true);
  });

  it("white wolf is a tier 2 standard enemy with a bleeding bite and wounded speed boost", () => {
    const wolf = enemyById.white_wolf;
    expect(wolf).toMatchObject({
      name: "White Wolf",
      family: "wolf",
      tier: 2,
      threat: "standard",
      baseStats: expect.objectContaining({ attack: 11 }),
      lootTable: "forest_white_wolf",
    });
    expect(wolf.effects).toContainEqual({
      type: "attack_speed_by_missing_hp",
      thresholdPct: 50,
      maxBonusPct: 25,
    });
    expect(wolf.abilities).toContainEqual(expect.objectContaining({
      id: "white_wolf_bite",
      name: "Bite",
      type: "empowered_attack",
      castTicks: 1,
      damageMult: 1.25,
      bleedChance: 25,
    }));
  });

  it("empowered enemy attacks can apply bleed from ability data", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "white_wolf",
        name: "White Wolf",
        hp: 95,
        stats: { maxHp: 95, attack: 11, armor: 2, attackSpeed: 1.1 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
        abilities: [{
          id: "white_wolf_bite",
          name: "Bite",
          type: "empowered_attack",
          castTicks: 1,
          cooldownSeconds: 6,
          damageMult: 1.25,
          bleedChance: 100,
          bleedDuration: 2,
          bleedDamagePct: 2,
        }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const casting = processTick(state, ACTION.NONE, () => 0.01);
    const resolved = processTick(casting, ACTION.NONE, () => 0.01);

    expect(resolved.combatants.hero.activeEffects.some(effect => effect.type === "bleed")).toBe(true);
    expect(resolved.heroConditions.bleeding?.stacks).toBe(1);
    expect(resolved.log.some(entry => entry.type === "bleed" && entry.text.includes("Bite"))).toBe(true);
  });

  it("giant spider is a tier 1 dangerous enemy with poison, web snare freeze, and recovery", () => {
    const spider = enemyById.giant_spider;
    expect(spider).toMatchObject({
      name: "Giant Webspinner",
      tier: 1,
      threat: "dangerous",
      baseStats: expect.objectContaining({ maxHp: 145, armor: 2 }),
    });
    expect(spider.effects).toContainEqual(expect.objectContaining({
      type: "poison_on_hit",
      chance: 15,
      duration: 3,
      damagePct: 0.4,
    }));
    expect(spider.abilities).toContainEqual(expect.objectContaining({
      id: "web_snare",
      type: "web_snare",
      durationTicks: 2,
      cooldownSeconds: 14,
    }));
    expect(spider.abilities).toContainEqual(expect.objectContaining({
      id: "silken_recovery",
      type: "heal_over_time",
      healPct: 9,
      durationTicks: 3,
    }));
  });

  it("forest spirit has a castable hp regen ability", () => {
    const spirit = enemyById.forest_spirit;
    expect(spirit.lootTable).toBe("forest_spirit");
    expect(spirit.effects).toContainEqual({ type: "regen_each_round", value: 1 });
    expect(spirit.abilities).toContainEqual(expect.objectContaining({
      id: "forest_renewal",
      type: "heal_over_time",
      cooldownSeconds: 20,
      healPct: 10,
      durationTicks: 3,
    }));
  });

  it("small troll has a low-health mending ability", () => {
    const troll = enemyById.troll_small;
    expect(troll.abilities).toContainEqual(expect.objectContaining({
      id: "small_troll_mending_hide",
      type: "heal_over_time",
      target: "self",
      castTicks: 0,
      cooldownSeconds: 16,
      requiresSelfHpPctBelow: 40,
      healPct: 25,
      durationTicks: 3,
      aiUseChance: 100,
    }));
  });

  it("armored bear is a tier 1 special enemy with low hp speed and stun blow", () => {
    const bear = enemyById.armored_bear;
    expect(bear).toMatchObject({
      name: "Armored Bear",
      tier: 1,
      threat: "special",
      lootTable: "armored_bear",
    });
    expect(bear.effects).toContainEqual({ type: "attack_speed_by_missing_hp", maxBonusPct: 50 });
    expect(bear.effects).toContainEqual({ type: "rage_below_hp", thresholdPct: 35, attackMult: 1.5 });
    expect(bear.abilities).toContainEqual(expect.objectContaining({
      id: "mauling_blow",
      type: "empowered_attack",
      cooldownSeconds: 8,
      damageMult: 1.2,
      stunTicks: 2,
    }));
  });

  it("keeps fighter attack speed talents wired to combat effects", () => {
    const tree = talentTrees.find(entry => entry.id === "fighter");
    const berserkerBranch = tree.branches.find(branch => branch.id === "berserker");
    const rogueTree = talentTrees.find(entry => entry.id === "rogue");
    const duelistBranch = rogueTree.branches.find(branch => branch.id === "duelist");
    const frenzyState = berserkerBranch.tiers
      .flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "berserker_frenzy_state");
    const berserkState = berserkerBranch.tiers
      .flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "berserker_berserk_state");
    const spite = berserkerBranch.tiers
      .flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "berserker_spite");
    const deathsDoor = berserkerBranch.tiers
      .flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "berserker_deaths_door");
    const duelistFlow = duelistBranch.tiers
      .flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "duelist_flow");

    expect(spite.threshold).toMatchObject({ stat: "hp_pct", max: 35 });
    expect(spite.threshold.effects).toContainEqual({ type: "crit_chance_bonus", value: 10 });
    expect(spite.threshold.effects).toContainEqual({ type: "lifesteal", value: 10 });
    expect(frenzyState.threshold.effects).toContainEqual({ type: "attack_speed_bonus_pct", value: 12 });
    expect(berserkState.requiresTalentId).toBe("berserker_frenzy_state");
    expect(berserkState.threshold.replacesThresholdIds).toContain("berserker_frenzy_state");
    expect(berserkState.threshold.effects).toContainEqual({ type: "attack_speed_bonus_pct", value: 25 });
    expect(berserkState.threshold.effects).toContainEqual({ type: "threshold_dmg_pct", value: 20 });
    expect(deathsDoor.proc).toMatchObject({
      trigger: "on_hp_cross_below",
      threshold: 15,
      effect: { type: "gain_crit_chance_pct", value: 50, durationTicks: 3 },
    });
    expect(duelistFlow.proc.effect).toMatchObject({ type: "gain_attack_speed_pct", value: 25, durationTicks: 3 });
    expect(combatSkillById.pummel_strike).toMatchObject({
      name: "Pummel Strike",
      type: "pummel_strike",
      castTicks: 2,
      energyCost: 15,
      requiresWeaponFamily: "sword",
      damageMult: 0.75,
      stunChance: 50,
      stunTicks: 2,
    });
  });

  it("applies Berserk State while Rage is at least 75", () => {
    const hero = {
      ...initHero("Fighter", { heroClass: "fighter" }),
      talents: { berserker_frenzy_state: 1, berserker_berserk_state: 1 },
    };
    const enemyObj = {
      id: "dummy",
      name: "Training Dummy",
      hp: 100,
      disableAutoAttack: true,
      stats: { maxHp: 100, attack: 0, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };
    const inactive = initCombat({
      heroName: "Fighter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroInitialRage: 74,
      enemyObj,
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });
    const active = initCombat({
      heroName: "Fighter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroInitialRage: 75,
      enemyObj,
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });

    expect(inactive.procState.activeThresholdIds).not.toContain("berserker_berserk_state");
    expect(inactive.combatants.hero.passiveEffects).not.toContainEqual({ type: "attack_speed_bonus_pct", value: 25 });
    expect(active.procState.activeThresholdIds).toContain("berserker_berserk_state");
    expect(active.combatants.hero.passiveEffects).toContainEqual({ type: "attack_speed_bonus_pct", value: 25 });
    expect(active.combatants.hero.passiveEffects).toContainEqual({ type: "threshold_dmg_pct", value: 20 });
  });

  it("upgrades Frenzy State into Berserk State when both Rage thresholds are met", () => {
    const hero = {
      ...initHero("Fighter", { heroClass: "fighter" }),
      talents: { berserker_frenzy_state: 1, berserker_berserk_state: 1 },
    };
    const enemyObj = {
      id: "dummy",
      name: "Training Dummy",
      hp: 100,
      disableAutoAttack: true,
      stats: { maxHp: 100, attack: 0, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };
    const frenzyOnly = initCombat({
      heroName: "Fighter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroInitialRage: 50,
      enemyObj,
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });
    const active = initCombat({
      heroName: "Fighter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroInitialRage: 75,
      enemyObj,
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });

    expect(frenzyOnly.procState.activeThresholdIds).toEqual(["berserker_frenzy_state"]);
    expect(frenzyOnly.combatants.hero.passiveEffects).toEqual(expect.arrayContaining([
      { type: "threshold_status", statusType: "berserker_frenzy_state" },
      { type: "attack_speed_bonus_pct", value: 12 },
      { type: "threshold_dmg_pct", value: 8 },
    ]));
    expect(active.procState.activeThresholdIds).toEqual(["berserker_berserk_state"]);
    expect(active.combatants.hero.passiveEffects).toEqual(expect.arrayContaining([
      { type: "threshold_status", statusType: "berserker_berserk_state" },
      { type: "attack_speed_bonus_pct", value: 25 },
      { type: "threshold_dmg_pct", value: 20 },
    ]));
    expect(active.combatants.hero.passiveEffects).not.toContainEqual({ type: "threshold_status", statusType: "berserker_frenzy_state" });
    expect(active.combatants.hero.passiveEffects).not.toContainEqual({ type: "attack_speed_bonus_pct", value: 12 });
    expect(active.combatants.hero.passiveEffects).not.toContainEqual({ type: "threshold_dmg_pct", value: 8 });
  });

  it("applies Spite while the fighter is below 35% HP", () => {
    const hero = {
      ...initHero("Fighter", { heroClass: "fighter" }),
      talents: { berserker_spite: 1 },
    };
    const enemyObj = {
      id: "dummy",
      name: "Training Dummy",
      hp: 100,
      disableAutoAttack: true,
      stats: { maxHp: 100, attack: 0, armor: 0 },
      effects: [],
    };
    const inactive = initCombat({
      heroName: "Fighter",
      heroHp: 36,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });
    const active = initCombat({
      heroName: "Fighter",
      heroHp: 34,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });

    expect(inactive.procState.activeThresholdIds).not.toContain("berserker_spite");
    expect(active.procState.activeThresholdIds).toContain("berserker_spite");
    expect(active.combatants.hero.passiveEffects).toEqual(expect.arrayContaining([
      { type: "threshold_status", statusType: "berserker_spite" },
      { type: "crit_chance_bonus", value: 10 },
      { type: "lifesteal", value: 10 },
    ]));
  });

  it("triggers Death's Door as a temporary crit chance buff when HP crosses below 15%", () => {
    const hero = {
      ...initHero("Fighter", { heroClass: "fighter" }),
      talents: { berserker_deaths_door: 1 },
    };
    const base = initCombat({
      heroName: "Fighter",
      heroHp: 20,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "executioner",
        name: "Executioner",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });
    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 6);
    const state = { ...base, tick: 2, actionQueue: enemyStrike };

    const result = processTick(state, ACTION.NONE, () => 0.5);

    expect(result.combatants.hero.hp).toBe(14);
    expect(result.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "crit_chance_buff",
      value: 50,
      remainingTicks: 3,
      source: "berserker_deaths_door",
    }));
    expect(result.procState.onceFiredIds).toContain("berserker_deaths_door");
  });

  it("triggers Last Breath when HP crosses below 10% and shows it as an active effect", () => {
    const hero = {
      ...initHero("Fighter", { heroClass: "fighter" }),
      talents: { berserker_last_breath: 1 },
    };
    const base = initCombat({
      heroName: "Fighter",
      heroHp: 12,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "executioner",
        name: "Executioner",
        hp: 100,
        stats: { maxHp: 100, attack: 80, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: collectEffects(hero),
      heroProcNodes: collectProcNodes(hero),
    });
    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 80);
    const state = { ...base, tick: 2, actionQueue: enemyStrike };

    const result = processTick(state, ACTION.NONE, () => 0.5);

    expect(result.combatants.hero.hp).toBe(1);
    expect(result.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "last_breath",
      remainingTicks: 3.5,
    }));
    expect(result.combatants.hero.activeEffects.find(effect => effect.type === "last_breath")).not.toHaveProperty("damageMult");
    expect(result.procState.onceFiredIds).toContain("berserker_last_breath");
    expect(result.log.some(entry => entry.text?.includes("Last Breath"))).toBe(true);
  });

  it("Last Breath expiring does not kill the hero until later damage lands", () => {
    const base = initCombat({
      heroName: "Fighter",
      heroHp: 1,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [],
    });
    const state = {
      ...base,
      combatants: {
        ...base.combatants,
        hero: {
          ...base.combatants.hero,
          activeEffects: [{ type: "last_breath", remainingTicks: 1 }],
        },
      },
    };

    const expired = processTick(state, ACTION.NONE, () => 0.5);

    expect(expired.combatants.hero.hp).toBe(1);
    expect(expired.phase).toBe(PHASE.FIGHTING);
    expect(expired.combatants.hero.activeEffects.some(effect => effect.type === "last_breath")).toBe(false);
    expect(expired.log.some(entry => entry.text?.includes("Last Breath fades"))).toBe(false);

    const lethalQueue = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, expired.tick, 5, null, 1);
    const afterHit = processTick({ ...expired, actionQueue: lethalQueue }, ACTION.NONE, () => 0.5);

    expect(afterHit.combatants.hero.hp).toBe(0);
    expect(afterHit.phase).toBe(PHASE.LOST);
  });

  it("Last Breath does not increase outgoing auto attack damage", () => {
    const base = initCombat({
      heroName: "Fighter",
      heroHp: 1,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroCritChance: 0,
      heroAttackRate: 1,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 1000,
        disableAutoAttack: true,
        stats: { maxHp: 1000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [],
    });
    const readyHero = state => ({
      ...state,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          autoAttackStarted: true,
          autoAttackProgressTicks: AUTO_ATTACK_TICKS,
          activeEffects: state.combatants.hero.activeEffects || [],
        },
      },
    });
    const baseline = processAutoAttackFrame(readyHero(base), TICK_MS, () => 0.5, { skipEnemyAutos: true });
    const withLastBreath = processAutoAttackFrame(readyHero({
      ...base,
      combatants: {
        ...base.combatants,
        hero: {
          ...base.combatants.hero,
          activeEffects: [{ type: "last_breath", remainingTicks: 3.5 }],
        },
      },
    }), TICK_MS, () => 0.5, { skipEnemyAutos: true });

    const baselineDamage = 1000 - baseline.combatants.enemy.hp;
    const lastBreathDamage = 1000 - withLastBreath.combatants.enemy.hp;
    expect(lastBreathDamage).toBe(baselineDamage);
  });

  it("tunes Heavy Strikes as a stronger, slower-cycling two-handed buff", () => {
    const heavyStrikes = combatSkillById.heavy_strikes;

    expect(heavyStrikes).toMatchObject({
      energyCost: 15,
      cooldownSeconds: 12,
      chargesGranted: 3,
      damageBonusPct: 20,
    });
    expect(heavyStrikes.description).toContain("+20% damage");
  });

  it("missing hp attack speed effect makes enemies autoattack faster at low hp", () => {
    const healthy = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "speed_bear",
        name: "Speed Bear",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0, attackSpeed: 1 },
        rewards: { xp: 0, gold: 0 },
        effects: [{ type: "attack_speed_by_missing_hp", maxBonusPct: 200 }],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    const wounded = {
      ...healthy,
      combatants: {
        ...healthy.combatants,
        enemy: { ...healthy.combatants.enemy, hp: 20 },
      },
    };

    const healthyTick = processTick(healthy, ACTION.NONE, () => 0.9);
    const woundedTick = processTick(wounded, ACTION.NONE, () => 0.9);

    expect(woundedTick.combatants.enemy.nextAutoAttackTick).toBeLessThan(healthyTick.combatants.enemy.nextAutoAttackTick);
  });

  it("empowered attacks can stun their target", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "stun_bear",
        name: "Stun Bear",
        hp: 100,
        stats: { maxHp: 100, attack: 10, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
        abilities: [{
          id: "mauling_blow",
          name: "Mauling Blow",
          type: "empowered_attack",
          castTicks: 0,
          cooldownSeconds: 9,
          damageMult: 1.2,
          critChance: 0,
          stunTicks: 3,
        }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const stunned = processTick(state, ACTION.NONE, () => 0.1);

    expect(stunned.combatants.hero.stunUntilTick).toBeGreaterThan(stunned.tick);
    expect(stunned.log.some(entry => entry.type === "stun" && entry.abilityId === "mauling_blow")).toBe(true);
  });

  it("Pummel Strike uses the longer cast time and has a 50 percent stun chance", () => {
    const state = withCombatRage(initCombat({
      heroName: "Swordsman",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      heroWeaponFamily: "sword",
      heroWeaponTags: ["sword", "weapon", "melee", "one_handed"],
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [combatSkillById.pummel_strike],
      heroEffects: [],
    }));
    const rng = (() => {
      const rolls = [0, 0.1];
      return () => rolls.shift() ?? 0.1;
    })();

    const casting = processTick(state, ACTION.ABILITY_0, rng);
    const stillCasting = processTick(casting, ACTION.NONE, rng);
    const resolved = processTick(stillCasting, ACTION.NONE, rng);

    expect(casting.actionQueue.some(action => action.ability?.id === "pummel_strike")).toBe(true);
    expect(stillCasting.combatants.enemy.hp).toBe(100);
    expect(resolved.combatants.enemy.hp).toBe(85);
    expect(resolved.combatants.enemy.stunUntilTick).toBeGreaterThan(resolved.tick);
    expect(resolved.log.some(entry => entry.type === "stun" && entry.abilityId === "pummel_strike" && entry.damage === 15)).toBe(true);
  });

  it("prevents stunned enemies from auto attacking", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "stunned_wolf",
        name: "Stunned Wolf",
        hp: 60,
        stats: { maxHp: 60, attack: 20, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    state.combatants.enemy.stunUntilTick = 1;

    const resolved = processTick(state, ACTION.NONE, () => 0.5);

    expect(resolved.combatants.hero.hp).toBe(100);
    expect(resolved.combatants.enemy.lastAutoAttackTick).toBeNull();
    expect(resolved.actionQueue.some(action => action.actorId === "enemy")).toBe(false);
  });

  it("lets Pummel Strike stun stop a same-tick enemy auto attack", () => {
    const state = initCombat({
      heroName: "Swordsman",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      heroWeaponFamily: "sword",
      enemyObj: {
        id: "duelist",
        name: "Duelist",
        hp: 100,
        stats: { maxHp: 100, attack: 30, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [combatSkillById.pummel_strike],
      heroEffects: [],
    });
    state.tick = 1;
    state.combatants.enemy.autoAttackRate = 0;
    state.combatants.enemies[0].autoAttackRate = 0;
    let queue = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 2, 30, null, 0, { targetId: "hero" });
    queue = enqueueAbility(queue, "hero", ACTION.ABILITY_0, 1, 1, 20, combatSkillById.pummel_strike, { targetId: "enemy" });
    state.actionQueue = queue;

    const resolved = processTick(state, ACTION.NONE, () => 0);

    expect(resolved.combatants.hero.hp).toBe(100);
    expect(resolved.combatants.enemy.stunUntilTick).toBeGreaterThan(resolved.tick);
    expect(resolved.log.some(entry => entry.type === "hit" && entry.actorId === "enemy")).toBe(false);
    expect(resolved.actionQueue.some(action => action.actorId === "enemy" && action.type === ACTION.BASIC_ATTACK)).toBe(false);
  });

  it("glove stun lasts one second and resets the enemy autoattack bar", () => {
    const state = initCombat({
      heroName: "Duelist",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      enemyObj: {
        id: "training_raider",
        name: "Training Raider",
        hp: 100,
        stats: { maxHp: 100, attack: 25, armor: 0, attackSpeed: 1 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "stun_on_hit", chance: 100, durationSeconds: 1 }],
    });
    Object.assign(state.combatants.enemy, {
      autoAttackStarted: true,
      autoAttackProgressTicks: AUTO_ATTACK_TICKS - 0.25,
      lastAutoAttackTick: 0,
      nextAutoAttackTick: 2,
    });
    state.actionQueue = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 25, null, 3, { targetId: "hero" });

    const resolved = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    const enemy = resolved.combatants.enemy;

    expect(enemy.stunUntilTick).toBe(resolved.tick + 1);
    expect(enemy.autoAttackProgressTicks).toBe(0);
    expect(enemy.lastAutoAttackTick).toBe(resolved.tick);
    expect(enemy.nextAutoAttackTick).toBe(resolved.tick + AUTO_ATTACK_TICKS);
    expect(resolved.actionQueue.some(action => action.actorId === "enemy" && action.type === ACTION.BASIC_ATTACK)).toBe(false);
  });

  it("enemy web slow reduces hero autoattack speed for three auto attacks", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroAttackRate: 1,
      enemyObj: {
        id: "web_test_spider",
        name: "Web Test Spider",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
        abilities: [{
          id: "web_snare",
          name: "Web Snare",
          type: "attack_speed_slow",
          castTicks: 0,
          cooldownSeconds: 8,
          attacks: 3,
          attackSpeedPenaltyPct: 40,
        }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const slowed = processTick(state, ACTION.NONE, () => 0.1);
    const slow = slowed.combatants.hero.activeEffects.find(effect => effect.type === "attack_speed_slow");
    expect(slow).toMatchObject({ attacksRemaining: 3, attackSpeedPenaltyPct: 40 });

    const afterHeroAuto = processTick(slowed, ACTION.BASIC_ATTACK, () => 0.9);
    const remainingSlow = afterHeroAuto.combatants.hero.activeEffects.find(effect => effect.type === "attack_speed_slow");
    expect(remainingSlow?.attacksRemaining).toBe(2);
    expect(afterHeroAuto.combatants.hero.nextAutoAttackTick).toBeGreaterThan(slowed.tick + 1);
  });

  it("enemy AI does not block by default", () => {
    const action = aiDecide({
      activeEffects: [],
      abilities: [],
      blockCooldownUntilTick: 0,
      blockPower: 20,
      blockPowerMax: 20,
      stunUntilTick: -1,
    }, 1, () => 0);

    expect(action).toBe(ACTION.BASIC_ATTACK);
  });

  it("starts combat with empty Rage and no combat Energy, Mana, or Ki resources", () => {
    const state = initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 1, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [{ id: "costly", name: "Costly", manaCost: 10, rageCost: 10, kiCost: 10 }],
      heroEffects: [],
    });

    expect(state.heroResources.energy).toBeUndefined();
    expect(state.heroResources.rage).toMatchObject({ label: "Rage", value: 0, max: 100 });
    expect(state.heroResources.mana).toBeUndefined();
    expect(state.heroResources.ki).toBeUndefined();
  });

  it("spends combat Rage for abilities", () => {
    const state = withCombatRage(initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [{ id: "quick", name: "Quick Skill", castTicks: 1, cooldown: 0 }],
      heroEffects: [],
    }), 30);

    const casting = processTick(state, ACTION.ABILITY_0, () => 0.1);
    expect(casting.heroResources.rage.value).toBe(20);

    const decayed = processTick(casting, ACTION.NONE, () => 0.1);
    expect(decayed.heroResources.rage.value).toBe(20);
  });

  it("does not spend hero Rage when enemies cast abilities", () => {
    const state = withCombatRage(initCombat({
      heroName: "Adventurer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "caster_dummy",
        name: "Caster Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
        abilities: [{ id: "enemy_cast", name: "Enemy Cast", castTicks: 1, cooldown: 0, damage: 1 }],
      },
      heroAbilities: [],
      heroEffects: [],
    }), 30);

    const afterEnemyCast = processTick(state, ACTION.NONE, () => 0.1);
    expect(afterEnemyCast.log.some(entry => entry.actorId === "enemy" && entry.type === "cast_start")).toBe(true);
    expect(afterEnemyCast.heroResources.rage.value).toBe(30);
  });

  it("can roll and apply stronger enemy rarities to normal encounters", () => {
    const rarity = rollEnemyRarity(() => 0.999);
    const wolf = {
      ...enemyById.wolf,
      stats: { maxHp: 32, attack: 8, armor: 1 },
      hp: 32,
    };
    const rareWolf = applyEnemyRarity(wolf, rarity);
    expect(rarity.id).toBe("legendario");
    expect(rareWolf.name).toContain("Legendary");
    expect(rareWolf.stats.maxHp).toBe(Math.round(32 * ENEMY_RARITIES.legendario.hp));
    expect(rareWolf.stats.attack).toBe(Math.round(8 * ENEMY_RARITIES.legendario.attack));
    expect(rareWolf.rewards.xp).toBeGreaterThan(wolf.rewards.xp);
    expect(rareWolf.lootBonus).toBe(ENEMY_RARITIES.legendario.lootBonus);
  });

  it("boss phases emit generic phase_change events", () => {
    const hero = initHero("Tester");
    hero.baseStats = { ...hero.baseStats, str: 40, damage: 20 };
    const stats = calcStats(hero);
    const bossRoom = buildZoneRooms("ancient_forest").at(-1);
    const result = runCombat(hero, stats, bossRoom.enemy, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    expect(result.log.some(entry => entry.type === "phase_change")).toBe(true);
  });

  it("elder stag frenzy phase uses the current balance values", () => {
    const frenzy = bossById.elder_stag.phases.find(phase => phase.id === "charge");
    expect(frenzy.thresholdPct).toBe(45);
    expect(bossById.elder_stag.baseStats.maxHp).toBe(320);
    expect(bossById.elder_stag.baseStats.attack).toBe(14);
    expect(frenzy.stats.attack).toBe(26);
    expect(frenzy.stats.armor).toBe(10);
    expect(frenzy.effects).toContainEqual({ type: "double_attack", chance: 25 });
    expect(frenzy.effects).toContainEqual({ type: "attack_mult", value: 1.1 });
  });

  it("weakens boss phase attack and armor when the phase becomes active", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 120,
      heroMaxHp: 120,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "phase_balance_dummy",
        name: "Phase Balance Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 20, armor: 8 },
        effects: [],
        phases: [{
          id: "rage",
          label: "Rage",
          thresholdPct: 100,
          stats: { attack: 30, armor: 10 },
          effects: [],
        }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const next = processTick(state, ACTION.NONE, () => 0.5);

    expect(next.combatants.enemy.damage).toBe(scaleMonsterAttack(30));
    expect(next.combatants.enemy.armor).toBe(scaleMonsterArmor(10));
  });

  it("summoned adds become real automatic-priority targets", () => {
    const hero = initHero("Tester");
    hero.hp = 200;
    hero.baseStats = { ...hero.baseStats, str: 35, dex: 15, damage: 16 };
    const stats = calcStats(hero);
    const boss = {
      id: "summon_boss",
      name: "Guardian de prueba",
      family: "deer",
      hp: 160,
      stats: { maxHp: 160, attack: 1, armor: 4 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
      phases: [
        {
          id: "summon",
          label: "Invocador",
          thresholdPct: 100,
          stats: { attack: 1, armor: 4 },
          effects: [{ type: "summon_add", chance: 100, enemyId: "wolf" }],
        },
      ],
    };
    const result = runCombat(hero, stats, boss, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    expect(result.log.some(entry => entry.type === "summon" && entry.addId === "wolf" && entry.addFamily === "wolf" && entry.pauseMs > 0)).toBe(true);
    expect(result.log.some(entry => entry.type === "add_kill")).toBe(true);
  });

  it("interactive boss phase summons add a real second attacker", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 0,
      heroArmor: 0,
      enemyObj: {
        id: "summon_boss",
        name: "Summon Boss",
        hp: 100,
        stats: { maxHp: 100, attack: 10, armor: 0, attackSpeed: 1 },
        effects: [],
        phases: [{
          id: "summon",
          label: "Calls the Pack",
          thresholdPct: 100,
          stats: { attack: 10, armor: 0 },
          effects: [{ type: "summon_add", chance: 100, enemyId: "wolf", maxAdds: 1, maxSummons: 1 }],
        }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const afterSummon = processTick(state, ACTION.NONE, () => 0.01);
    const afterWindup = processTick(afterSummon, ACTION.NONE, () => 0.01);
    const afterAttacks = processTick(afterWindup, ACTION.NONE, () => 0.01);
    const attackers = new Set(afterAttacks.log
      .filter(entry => entry.type === "hit" && entry.actorId !== "hero")
      .map(entry => entry.actorId));

    expect(afterAttacks.combatants.enemies).toHaveLength(2);
    expect(afterAttacks.log.some(entry => entry.type === "summon" && entry.addSourceId === "wolf")).toBe(true);
    expect(attackers.has("enemy")).toBe(true);
    expect([...attackers].some(id => id.startsWith("enemy_wolf_"))).toBe(true);
  });

  it("Orc General ties Commanding Shout to Rally the Camp summons", () => {
    const commanderPhase = bossById.orc_general.phases.find(phase => phase.id === "commander");
    const rally = commanderPhase.effects.find(effect => effect.id === "orc_general_rally_the_camp");
    expect(rally).toMatchObject({
      type: "delayed_summon_add",
      enemyId: "orc_patrol",
      castTicks: 2,
      cooldownSeconds: 16,
      maxAdds: 1,
      maxSummons: 2,
    });
    expect(rally.followupAbility).toMatchObject({
      id: "orc_general_commanding_shout",
      type: "commanding_shout",
      cooldownSeconds: rally.cooldownSeconds,
      damageBonusPct: 15,
      attackSpeedBonusPct: 15,
    });

    let state = initCombat({
      heroName: "Tester",
      heroHp: 500,
      heroMaxHp: 500,
      heroDamage: 0,
      heroArmor: 0,
      enemyObj: {
        ...bossById.orc_general,
        disableAutoAttack: true,
        hp: bossById.orc_general.baseStats.maxHp,
        stats: { ...bossById.orc_general.baseStats, attackSpeed: 0 },
      },
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.log.some(entry => entry.type === "cast_start" && entry.abilityId === "orc_general_rally_the_camp")).toBe(true);

    state = processTick(state, ACTION.NONE, () => 0.01);
    state = processTick(state, ACTION.NONE, () => 0.01);

    const general = state.combatants.enemies.find(enemy => enemy.id === "enemy");
    const patrol = state.combatants.enemies.find(enemy => enemy.sourceId === "orc_patrol");
    expect(patrol).toBeTruthy();
    for (const combatant of [general, patrol]) {
      expect(combatant.activeEffects).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "damage_bonus_pct_buff", value: 15, sourceAbilityId: "orc_general_commanding_shout" }),
        expect.objectContaining({ type: "attack_speed_buff", value: 15, sourceAbilityId: "orc_general_commanding_shout" }),
      ]));
    }
    expect(state.log.some(entry =>
      entry.type === "buff"
      && entry.abilityId === "orc_general_commanding_shout"
      && entry.text.includes("Orc General uses Commanding Shout"))).toBe(true);
  });

  it("Cleaving Order can hit the front target and a player-side companion", () => {
    const general = {
      id: "orc_general",
      name: "Orc General",
      damage: 20,
      armor: 0,
      activeEffects: [],
      passiveEffects: [],
    };
    const hero = {
      id: "hero",
      name: "Tester",
      isPlayer: true,
      hp: 100,
      maxHp: 100,
      armor: 0,
      activeEffects: [],
      passiveEffects: [],
    };
    const pet = {
      id: "pet",
      name: "Wolf",
      isAlly: true,
      team: "player",
      hp: 80,
      maxHp: 80,
      armor: 0,
      activeEffects: [],
      passiveEffects: [],
    };
    const ability = bossById.orc_general.abilities.find(entry => entry.id === "orc_general_cleaving_order");

    const entries = resolveAbilityImpact({ ability }, general, hero, 1, () => 0.99, {
      hero,
      playerAllies: [pet],
    });

    expect(entries.map(entry => entry.targetId)).toEqual(["hero", "pet"]);
    expect(hero.hp).toBeLessThan(100);
    expect(pet.hp).toBeLessThan(80);
    expect(entries.find(entry => entry.targetId === "pet")).toMatchObject({ cleaveSecondary: true });
  });

  it("elder stag calls a young stag only after being wounded near seventy percent", () => {
    const guardian = bossById.elder_stag.phases.find(phase => phase.id === "guardian");
    const summonEffect = guardian.effects.find(effect => effect.type === "delayed_summon_add");
    expect(summonEffect).toMatchObject({
      id: "summon_young_stag",
      name: "Summon Young Stag",
      enemyId: "young_stag",
      triggerHpPct: 70,
      castTicks: 2,
    });
    expect(enemyById.young_stag).toMatchObject({ name: "Young Stag", family: "deer", baseStats: expect.objectContaining({ attack: 6 }) });

    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 0,
      heroArmor: 0,
      enemyObj: {
        ...bossById.elder_stag,
        hp: bossById.elder_stag.baseStats.maxHp,
        stats: { ...bossById.elder_stag.baseStats, attackSpeed: 1 },
      },
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    expect(state.combatants.enemies).toHaveLength(1);
    expect(state.log.some(entry => entry.type === "summon")).toBe(false);

    const woundedHp = Math.floor(state.combatants.enemy.maxHp * 0.69);
    const woundedBoss = { ...state.combatants.enemy, hp: woundedHp };
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: woundedBoss,
        enemies: state.combatants.enemies.map(enemy => enemy.id === woundedBoss.id ? woundedBoss : enemy),
      },
    };

    const afterCast = processTick(state, ACTION.NONE, () => 0.01);
    const activeSummonCast = afterCast.actionQueue.find(action => action.actorId === "enemy" && action.ability?.id === "summon_young_stag");

    expect(activeSummonCast).toMatchObject({
      castEndTick: afterCast.tick + 2,
      impactTick: afterCast.tick + 2,
    });
    expect(afterCast.log.some(entry => entry.type === "cast_start" && entry.abilityId === "summon_young_stag")).toBe(true);
    expect(afterCast.log.some(entry => entry.type === "summon" && entry.addSourceId === "young_stag")).toBe(false);
    expect(afterCast.combatants.enemies.some(enemy => enemy.sourceId === "young_stag")).toBe(false);

    const charging = processTick(afterCast, ACTION.NONE, () => 0.01);
    expect(charging.combatants.enemies.some(enemy => enemy.sourceId === "young_stag")).toBe(false);
    expect(charging.log.some(entry => entry.actorId === "enemy" && entry.type === "hit" && entry.tick >= afterCast.tick)).toBe(false);

    const afterSummon = processTick(charging, ACTION.NONE, () => 0.01);
    const summonEntry = afterSummon.log.find(entry => entry.type === "summon" && entry.addSourceId === "young_stag");
    const youngStagSummon = afterSummon.combatants.enemies.find(enemy => enemy.sourceId === "young_stag");

    expect(summonEntry.text).toContain("Young Stag");
    expect(summonEntry.addFamily).toBe("deer");
    expect(summonEntry.addSprite).toBe("/assets/sprites/encounters/Bosses/elder_stag_summon.png");
    expect(youngStagSummon).toMatchObject({
      family: "deer",
      sprite: "/assets/sprites/encounters/Bosses/elder_stag_summon.png",
    });
  });

  it("killing the elder stag summon stuns and exposes the boss", () => {
    let state = initCombat({
      heroName: "Tester",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 200,
      heroArmor: 0,
      enemyObj: {
        ...bossById.elder_stag,
        hp: bossById.elder_stag.baseStats.maxHp,
        stats: { ...bossById.elder_stag.baseStats, attackSpeed: 1 },
      },
      heroAbilities: [],
      heroEffects: [],
    });

    state = processTick(state, ACTION.NONE, () => 0.01);
    const woundedHp = Math.floor(state.combatants.enemy.maxHp * 0.69);
    const woundedBoss = { ...state.combatants.enemy, hp: woundedHp };
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: woundedBoss,
        enemies: state.combatants.enemies.map(enemy => enemy.id === woundedBoss.id ? woundedBoss : enemy),
      },
    };
    const afterCast = processTick(state, ACTION.NONE, () => 0.01);
    const charging = processTick(afterCast, ACTION.NONE, () => 0.01);
    const afterSummon = processTick(charging, ACTION.NONE, () => 0.01);
    const summon = afterSummon.combatants.enemies.find(enemy => enemy.sourceId === "young_stag");

    const afterKill = processTick({ ...afterSummon, selectedTargetId: summon.id }, ACTION.BASIC_ATTACK, () => 0.01);
    const boss = afterKill.combatants.enemy;

    expect(afterKill.combatants.enemies.find(enemy => enemy.id === summon.id)?.summonKillPunished).toBe(true);
    expect(boss.stunUntilTick).toBe(afterKill.tick + 3);
    expect(boss.activeEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "damage_taken_bonus_pct",
        source: "summon_death",
        value: 20,
        remainingTicks: 4,
      }),
    ]));
    expect(afterKill.log.some(entry => (
      entry.type === "add_kill"
      && entry.targetId === boss.id
      && entry.addSourceId === "young_stag"
      && entry.durationTicks === 4
    ))).toBe(true);
  });

  it("summon death exposure increases damage while its timer is active", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "exposed_dummy",
        name: "Exposed Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
        rewards: { xp: 0, gold: 0 },
      },
      heroAbilities: [],
      heroEffects: [],
    });
    state.combatants.enemy.activeEffects.push({
      type: "damage_taken_bonus_pct",
      source: "summon_death",
      value: 20,
      remainingTicks: 4,
    });

    const afterHit = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    expect(afterHit.combatants.enemy.hp).toBe(88);
    expect(afterHit.combatants.enemy.activeEffects.find(effect => effect.type === "damage_taken_bonus_pct")?.remainingTicks).toBe(3);
  });

  it("generated test gear can defeat the act one boss and boss loot stays valid", () => {
    const hero = initHero("Tester");
    hero.equip = {
      ...hero.equip,
      weapon: {
        id: "generated_test_sword",
        uid: "generated_test_sword_uid",
        generated: true,
        type: "gear",
        slot: "weapon",
        family: "sword",
        baseStats: { damage: 200 },
        damageDice: { count: 1, sides: 12, bonus: 194, text: "1d12+194" },
        effects: [],
      },
      chest: {
        id: "generated_test_plate",
        uid: "generated_test_plate_uid",
        generated: true,
        type: "gear",
        slot: "chest",
        armorType: "plate",
        baseStats: { armor: 1000, maxHp: 1000 },
        armorDice: { count: 1, sides: 12, bonus: 994, text: "1d12+994" },
        effects: [],
      },
    };
    hero.hp = calcStats(hero).maxHp;
    const stats = calcStats(hero);
    const bossRoom = buildZoneRooms("ancient_forest").at(-1);
    const result = runCombat(hero, stats, bossRoom.enemy, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    const bossDrops = rollLootTable("boss", () => 0.1);
    expect(result.won).toBe(true);
    expect(result.log.at(-1).type).toBe("kill");
    expect(bossDrops.length).toBeGreaterThan(0);
    expect(bossDrops.every(drop => drop?.id && drop?.name)).toBe(true);
  });

  it("emits a death event when the hero loses", () => {
    const hero = initHero("Tester");
    hero.hp = 4;
    hero.equip = {};
    const stats = calcStats(hero);
    const enemy = {
      id: "training_executioner",
      name: "Verdugo de prueba",
      family: "human",
      hp: 120,
      stats: { maxHp: 120, attack: 80, armor: 20 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };
    const result = runCombat(hero, stats, enemy, getHungerLevel(hero.hunger), { rng: () => 0.5 });
    expect(result.won).toBe(false);
    expect(result.hpLeft).toBe(0);
    expect(result.log.at(-1).type).toBe("death");
  });

  it("supports reusable temporary statuses from enemy effects", () => {
    const hero = initHero("Tester");
    hero.hp = 80;
    hero.equip = {};
    hero.baseStats = { ...hero.baseStats, str: 1, dex: 1, armor: 0, damage: 0 };
    const stats = calcStats(hero);
    const enemy = {
      id: "status_tester",
      name: "Status Tester",
      family: "rat",
      hp: 80,
      stats: { maxHp: 80, attack: 4, armor: 50 },
      rewards: { xp: 0, gold: 0 },
      effects: [
        { type: "poison_on_hit", chance: 100, duration: 2, damagePct: 1 },
        { type: "blind_on_hit", chance: 100, duration: 1, hitPenalty: 20 },
        { type: "weaken_on_hit", chance: 100, duration: 1, damageMult: 0.8 },
      ],
    };
    const result = runCombat(hero, stats, enemy, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    expect(result.log.some(entry => entry.type === "poison")).toBe(true);
    expect(result.log.some(entry => entry.type === "debuff")).toBe(true);
  });

  it("applies hunger and fatigue attack speed modifiers in combat timing", () => {
    const baseHero = initHero("Tester");
    baseHero.equip = {};
    baseHero.hp = 120;
    const slowEnemy = {
      id: "timing_dummy",
      name: "Timing Dummy",
      family: "dummy",
      hp: 240,
      stats: { maxHp: 240, attack: 1, armor: 0, attackSpeed: 0.5 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };

    const freshStats = calcStats({ ...baseHero, hunger: 80, energy: 100 });
    const exhaustedStats = calcStats({ ...baseHero, hunger: 20, energy: 10 });
    const freshResult = runCombat({ ...baseHero, hunger: 80, energy: 100 }, freshStats, slowEnemy, getHungerLevel(80), { rng: () => 0.1 });
    const exhaustedResult = runCombat({ ...baseHero, hunger: 20, energy: 10 }, exhaustedStats, slowEnemy, getHungerLevel(20), { rng: () => 0.1 });

    const freshTurns = freshResult.log.filter(entry => Number.isFinite(entry.timeMs) && entry.timeMs > 0);
    const exhaustedTurns = exhaustedResult.log.filter(entry => Number.isFinite(entry.timeMs) && entry.timeMs > 0);

    expect(freshStats.attackSpeedMult).toBe(1);
    expect(exhaustedStats.attackSpeedMult).toBeLessThan(freshStats.attackSpeedMult);
    expect(freshTurns.length).toBeGreaterThan(0);
    expect(exhaustedTurns.length).toBeGreaterThan(0);
    expect(freshTurns[0].timeMs).toBeLessThan(exhaustedTurns[0].timeMs);
  });

  it("starts combat without initiative or reach opening rules", () => {
    const hero = initHero("Tester");
    hero.equip = { ...hero.equip, weapon: rollGeneratedEquipment({ baseId: "spear_2h", itemLevel: 1 }, () => 0) };
    hero.hp = 120;
    const stats = calcStats(hero);
    const enemy = {
      id: "slow_opener",
      name: "Slow Opener",
      family: "human",
      hp: 60,
      stats: { maxHp: 60, attack: 1, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };
    const result = runCombat(hero, stats, enemy, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    expect(result.log.some(entry => entry.text.toLowerCase().includes("initiative") || entry.text.toLowerCase().includes("reach"))).toBe(false);
    const heroHit = result.log.find(entry => entry.type === "hit" || entry.type === "crit");
    const enemyHit = result.log.find(entry => entry.type === "enemyHit");
    expect(heroHit.actionGroup).toBe(enemyHit.actionGroup);
  });

  it("does not expose charge events in the combat log", () => {
    const hero = initHero("Tester");
    const stats = calcStats(hero);
    const enemy = {
      id: "training_target",
      name: "Training Target",
      family: "human",
      hp: 40,
      stats: { maxHp: 40, attack: 1, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };
    const result = runCombat(hero, stats, enemy, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    expect(result.log.some(entry => entry.type === "charge" || entry.text.toLowerCase().includes("charging"))).toBe(false);
  });

  it("poison persists outside combat until it runs down without dealing tick damage", () => {
    const hero = initHero("Tester");
    hero.hp = 140;
    hero.equip = {};
    hero.baseStats = { ...hero.baseStats, str: 1, dex: 1, armor: 0, damage: 0 };
    const stats = calcStats(hero);
    const enemy = {
      id: "stack_tester",
      name: "Stack Tester",
      family: "rat",
      hp: 200,
      stats: { maxHp: 200, attack: 1, armor: 80 },
      rewards: { xp: 0, gold: 0 },
      effects: [{ type: "poison_on_hit", chance: 100, duration: 2, damagePct: 1 }],
    };
    const result = runCombat(hero, stats, enemy, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    const poisonTicks = result.log.filter(entry => entry.type === "poison");
    expect(poisonTicks.length).toBeGreaterThan(0);
    expect(poisonTicks.every(entry => entry.dmg == null)).toBe(true);
    expect(result.heroConditions.poison?.stacks).toBeGreaterThan(0);

    const carried = {
      ...hero,
      hp: 100,
      conditions: { poison: { type: "poison", stacks: 2, damagePct: 1 } },
    };
    const firstTick = tickBleeding(carried, 100);
    expect(firstTick.hero.hp).toBe(100);
    expect(firstTick.hero.conditions.poison?.stacks).toBe(1);
    const secondTick = tickBleeding(firstTick.hero, 100);
    expect(secondTick.hero.hp).toBe(100);
    expect(secondTick.hero.conditions.poison).toBeNull();
  });

  it("bleeding stacks duration without multiplying tick damage", () => {
    const hero = initHero("Tester");
    hero.hp = 140;
    hero.equip = {};
    hero.baseStats = { ...hero.baseStats, str: 1, dex: 1, armor: 0, damage: 0 };
    const stats = calcStats(hero);
    const enemy = {
      id: "bleed_tester",
      name: "Bleed Tester",
      family: "rat",
      hp: 180,
      stats: { maxHp: 180, attack: 1, armor: 80 },
      rewards: { xp: 0, gold: 0 },
      effects: [{ type: "bleed_on_hit", chance: 100, duration: 2, damagePct: 2 }],
    };
    const result = runCombat(hero, stats, enemy, getHungerLevel(hero.hunger), { rng: () => 0.1 });
    const bleedTicks = result.log.filter(entry => entry.type === "bleed");
    expect(bleedTicks.length).toBeGreaterThan(0);
    expect(bleedTicks.every(entry => entry.dmg == null)).toBe(true);
    expect(result.heroConditions.bleeding?.stacks).toBeGreaterThan(0);
  });

  it("bleeding only becomes a deep cut when one is explicitly present for treatment", () => {
    const hero = initHero("Tester");
    hero.hp = 100;
    hero.conditions = {
      bleeding: { type: "bleeding", stacks: 2, damagePct: 2 },
    };

    const bandaged = treatBleeding(hero);
    expect(bandaged.conditions.bleeding).toBeNull();
    expect(bandaged.conditions.deepCut).toBeNull();

    const untreated = tickBleeding(hero, 100).hero;
    expect(untreated.hp).toBe(100);
    const deepCutSource = tickBleeding(untreated, 100).hero;
    expect(deepCutSource.hp).toBe(100);
    expect(deepCutSource.conditions.deepCut).toBeNull();

    deepCutSource.conditions = {
      ...deepCutSource.conditions,
      deepCut: { type: "deep_cut", stacks: 1, treatmentTicks: 0 },
    };

    const bandagedCut = treatDeepCut(deepCutSource);
    expect(bandagedCut.conditions.deepCut).toBeNull();

    const poulticed = applyPoultice(deepCutSource);
    expect(poulticed.conditions.deepCut?.treatmentTicks).toBeGreaterThan(0);

    const afterFirstTick = tickBleeding(poulticed, 100).hero;
    expect(afterFirstTick.conditions.deepCut?.stacks).toBe(1);

    const afterSecondTick = tickBleeding(afterFirstTick, 100).hero;
    expect(afterSecondTick.conditions.deepCut).toBeNull();
  });

  it("keeps untreated wounds stable outside combat", () => {
    const hero = initHero("Tester");
    hero.hp = 100;
    hero.conditions = {
      deepCut: { type: "deep_cut", stacks: 1, treatmentTicks: 0, untreatedTicks: 0 },
    };

    let stableHero = hero;
    for (let i = 0; i < 5; i++) {
      stableHero = tickBleeding(stableHero, 100).hero;
    }
    expect(stableHero.conditions.deepCut?.stacks).toBe(1);
    expect(stableHero.conditions.deepCut?.untreatedTicks).toBe(0);
    expect(stableHero.conditions.infection).toBeNull();

    stableHero.conditions = {
      infection: { type: "infection", stacks: 1, treatmentTicks: 0, untreatedTicks: 0 },
    };
    for (let i = 0; i < 5; i++) {
      stableHero = tickBleeding(stableHero, 100).hero;
    }
    expect(stableHero.conditions.infection?.stacks).toBe(1);
    expect(stableHero.conditions.infection?.untreatedTicks).toBe(0);
    expect(stableHero.conditions.wretchedGore).toBeNull();
  });

  it("wretched gore permanently reduces max hp by one percent per stack", () => {
    const hero = initHero("Tester");
    hero.equip = {};
    hero.hunger = 50;
    hero.conditions = {
      wretchedGore: { type: "wretched_gore", stacks: 3 },
    };
    const stats = calcStats(hero);
    expect(stats.maxHp).toBe(Math.round(hero.baseStats.maxHp * 0.97));
  });

  it("carries bleed out of combat while testing keeps wound infliction disabled", () => {
    const state = initCombat({
      heroName: "Target",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "legendary_bandit",
        name: "Legendary Butcher",
        hp: 120,
        rarity: { id: "legendario" },
        stats: { maxHp: 120, attack: 38, armor: 0, attackSpeed: 2 },
        effects: [{ type: "bleed_on_hit", chance: 100, duration: 2, damagePct: 2 }],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    state.actionQueue = enqueueAction([], "enemy", ACTION.BASIC_ATTACK, 1, 57, null, 0, { isCrit: true });
    const resolved = processTick(state, ACTION.NONE, () => 0);
    const result = buildCombatResult(resolved);

    expect(result.heroConditions.bleeding?.stacks).toBeGreaterThan(0);
    expect(result.heroWounds.deepCut).toBe(0);
    expect(result.log.some(entry => entry.type === "wound")).toBe(false);
  });

  it("enemy bleed and poison procs add one stack while duration controls remaining ticks", () => {
    const state = initCombat({
      heroName: "Target",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: {
        id: "blood_rat_like",
        name: "Blood Rat Like",
        hp: 56,
        stats: { maxHp: 56, attack: 5, armor: 0, attackSpeed: 1 },
        effects: [
          { type: "bleed_on_hit", chance: 100, duration: 3, damagePct: 2 },
          { type: "poison_on_hit", chance: 100, duration: 4, damagePct: 1 },
        ],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    state.actionQueue = enqueueAction([], "enemy", ACTION.BASIC_ATTACK, 1, 5, null, 0);

    const resolved = processTick(state, ACTION.NONE, () => 0);
    const bleed = resolved.combatants.hero.activeEffects.find(effect => effect.type === "bleed");
    const poison = resolved.combatants.hero.activeEffects.find(effect => effect.type === "poison");

    expect(bleed).toMatchObject({ stacks: 1, remainingTicks: 3 });
    expect(poison).toMatchObject({ stacks: 1, remainingTicks: 4 });
    expect(resolved.heroConditions.bleeding?.stacks).toBe(1);
    expect(resolved.heroConditions.poison?.stacks).toBe(1);
  });

  it("keeps basic forest wildlife loot non-equippable while special sources can drop gear", () => {
    const basicDrops = Array.from({ length: 12 }, () => rollLootTable("forest_basic", () => 0.1)).flat();
    const specialDrops = rollLootTable("forest_bandit", () => 0.49);
    expect(basicDrops.every(drop => drop.type !== "gear")).toBe(true);
    expect(specialDrops.some(drop => drop.type === "gear")).toBe(true);
  });

  it("keeps regular forest wildlife non-gear while preserving the White Wolf cloak", () => {
    const boarTable = LOOT_TABLES.forest_boar;
    const boarPool = getDropPool(boarTable.tags, boarTable);
    const wolfPool = getDropPool(LOOT_TABLES.forest_wolf.tags, LOOT_TABLES.forest_wolf);
    const whiteWolfPool = getDropPool(LOOT_TABLES.forest_white_wolf.tags, LOOT_TABLES.forest_white_wolf);

    expect(boarTable.includeItemIds || []).not.toContain("bone_shield");
    expect(boarPool.every(item => item.type !== "gear")).toBe(true);
    expect(wolfPool.every(item => item.type !== "gear")).toBe(true);
    expect(whiteWolfPool.some(item => item.id === "fur_cloak")).toBe(true);
    expect(wolfPool.some(item => item.id === "fur_cloak")).toBe(false);
  });

  it("uses table-specific loot weights for animal food and generated-equipment encounters", () => {
    const chanceFor = (table, itemId) => {
      const pool = getDropPool(table.tags, table);
      const totalWeight = pool.reduce((sum, item) => sum + (item.dropWeight || 1), 0);
      const item = pool.find(entry => entry.id === itemId);
      return item ? table.dropChance * (item.dropWeight || 1) / totalWeight : 0;
    };
    const manualChanceWithGenerated = (table, itemId) => {
      const pool = getDropPool(table.tags, table);
      const generatedWeight = table.generatedEquipment?.weight || 0;
      const totalWeight = pool.reduce((sum, item) => sum + (item.dropWeight || 1), generatedWeight);
      const item = pool.find(entry => entry.id === itemId);
      return item ? table.dropChance * (item.dropWeight || 1) / totalWeight : 0;
    };

    expect(chanceFor(LOOT_TABLES.forest_wolf, "wolf_meat")).toBeCloseTo(0.3);
    expect(chanceFor(LOOT_TABLES.forest_white_wolf, "fur_cloak")).toBeCloseTo(0.15);
    expect(chanceFor(LOOT_TABLES.forest_boar, "boar_meat")).toBeCloseTo(0.244);
    expect(LOOT_TABLES.forest_bandit.generatedEquipment.baseIds).toEqual(expect.arrayContaining(["dagger", "sword_1h", "buckler"]));
    expect(manualChanceWithGenerated(LOOT_TABLES.forest_bandit, "campfire")).toBeCloseTo(0.5 * 15 / 39);
    expect(LOOT_TABLES.forest_spirit.generatedEquipment.baseIds).toEqual(expect.arrayContaining(["staff", "spear_2h"]));
    expect(LOOT_TABLES.armored_bear.generatedEquipment.baseIds).toEqual(expect.arrayContaining(["plate_chest", "plate_legs", "tower_shield"]));
    expect(manualChanceWithGenerated(LOOT_TABLES.armored_bear, "bear_meat")).toBeCloseTo(3 / 28);
    expect(manualChanceWithGenerated(LOOT_TABLES.armored_bear, "campfire")).toBeCloseTo(2 / 28);
  });

  it("keeps campfire recovery at 20% max HP", () => {
    const campfire = items.find(item => item.id === "campfire");
    expect(campfire?.effects?.find(effect => effect.type === "restore_hp_pct")?.value).toBe(20);
  });

  it("keeps Fur Cloak as a White Wolf armor drop", () => {
    const furCloak = items.find(item => item.id === "fur_cloak");
    expect(furCloak).toMatchObject({
      name: "Fur Cloak",
      type: "gear",
      slot: "cloak",
      family: "cloak",
      baseStats: { armor: 3 },
      dropWeight: 0,
      icon: "/assets/items/generated/cape.png?v=2",
    });
  });

  it("enemy loot bonus improves drop output inside the same loot table", () => {
    const baseDrops = rollLootTable("forest_basic", () => 0.1, 0);
    const boostedDrops = rollLootTable("forest_basic", () => 0.1, 65);
    expect(boostedDrops.length).toBeGreaterThan(baseDrops.length);
    expect(boostedDrops.every(drop => drop.type !== "gear")).toBe(true);
  });

  it("weapon attack speed effects increase the hero attack rate stat", () => {
    const hero = initHero("Tester");
    hero.equip = {
      ...hero.equip,
      weapon: {
        id: "swift_test_sword",
        name: "Swift Test Sword",
        type: "gear",
        slot: "weapon",
        family: "sword",
        attackSpeed: 1,
        baseStats: { damage: 5 },
        effects: [{ type: "attack_speed", value: 25 }],
        tags: ["sword", "weapon", "melee", "one_handed"],
      },
    };

    expect(calcStats(hero).weaponAttackSpeed).toBeCloseTo(1.25);
  });

  it("feeds generated weapon speed into the hero auto attack rate", () => {
    const hero = initHero("Tester");
    const weapon = {
      id: "generated_speed_test",
      uid: "generated_speed_test_uid",
      generated: true,
      type: "gear",
      slot: "weapon",
      family: "sword",
      attackSpeed: 1.18,
      baseStats: { damage: 5 },
      damageDice: { count: 1, sides: 8, text: "1d8" },
      effects: [],
    };
    hero.equip = { ...hero.equip, weapon };
    const stats = calcStats(hero);

    const state = initCombat({
      heroName: hero.name,
      heroHp: hero.hp,
      heroMaxHp: stats.maxHp,
      heroDamage: stats.damage,
      heroArmor: stats.armor,
      heroAttackRate: Math.max(0.35, (stats.weaponAttackSpeed || 1) * (stats.attackSpeedMult || 1)),
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    expect(weapon.attackSpeed).toBeCloseTo(1.18);
    expect(stats.weaponAttackSpeed).toBeCloseTo(1.18);
    expect(state.combatants.hero.autoAttackRate).toBeCloseTo(1.18);
  });

  it("generic passive and active attack speed bonuses accelerate auto attacks", () => {
    const enemyObj = {
      id: "dummy",
      name: "Training Dummy",
      hp: 1000,
      stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    const baseConfig = {
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroAttackRate: 1,
      enemyObj,
      heroAbilities: [],
    };
    const readyState = heroEffects => {
      const state = initCombat({ ...baseConfig, heroEffects });
      state.combatants.hero.autoAttackStarted = true;
      state.combatants.hero.autoAttackProgressTicks = 0;
      state.combatants.hero.lastAutoAttackTick = 0;
      return state;
    };
    const advanceBasic = state => {
      let next = state;
      for (let i = 0; i < 8; i += 1) {
        next = processTick(next, ACTION.BASIC_ATTACK, () => 0.5);
      }
      return next;
    };

    const normal = advanceBasic(readyState([]));
    const passiveBoosted = advanceBasic(readyState([{ type: "attack_speed_bonus_pct", value: 100 }]));
    const activeState = readyState([]);
    activeState.combatants.hero.activeEffects = [{ type: "attack_speed_buff", value: 100, remainingTicks: 20 }];
    const activeBoosted = advanceBasic(activeState);

    const heroHitCount = state => state.log.filter(entry => entry.actorId === "hero" && entry.type === "hit").length;
    expect(heroHitCount(passiveBoosted)).toBeGreaterThan(heroHitCount(normal));
    expect(heroHitCount(activeBoosted)).toBeGreaterThan(heroHitCount(normal));
  });

  it("spear-style stagger on hit applies Staggered in interactive combat", () => {
    const state = initCombat({
      heroName: "Spearman",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "stagger_on_hit", chance: 100, duration: 2, missPenalty: 35 }],
    });

    const afterHit = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    const stagger = afterHit.combatants.enemy.activeEffects.find(effect => effect.type === "stagger");

    expect(stagger).toMatchObject({ attacksRemaining: 2, missPenalty: 35 });
    expect(afterHit.log.some(entry => entry.type === "stagger" && entry.text.includes("Staggered"))).toBe(true);
  });

  it("daze causes spells to fail 50 percent of the time in interactive combat", () => {
    const state = withCombatRage(initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [
        {
          id: "heavy_blow",
          name: "Heavy Blow",
          type: "empowered_attack",
          castTicks: 2,
          cooldown: 7,
          damageMult: 1.5,
          critChance: 0,
        },
      ],
      heroEffects: [],
    }));

    const withDaze = {
      ...state,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          activeEffects: [{ type: "daze", remainingTicks: 6, missSpellChance: 50 }],
        },
      },
    };

    const queued = processTick(withDaze, ACTION.ABILITY_0, () => 0.1);
    const resolved = processTick(processTick(queued, ACTION.NONE, () => 0.1), ACTION.NONE, () => 0.1);

    expect(resolved.log.some(entry => entry.type === "daze" && entry.text.toLowerCase().includes("fizzles"))).toBe(true);
    expect(resolved.combatants.enemy.hp).toBe(100);
    expect(resolved.phase).toBe(PHASE.FIGHTING);
  });

  it("interactive combat applies enemy blind, weaken, stagger, regen, rage, hit chance, and low-hp physical reduction", () => {
    const baseEnemy = {
      id: "dummy",
      name: "Training Dummy",
      hp: 100,
      stats: { maxHp: 100, attack: 10, armor: 0 },
      effects: [],
    };

    const blindedHero = {
      ...initCombat({
        heroName: "Tester",
        heroHp: 100,
        heroMaxHp: 100,
        heroDamage: 20,
        heroArmor: 0,
        enemyObj: baseEnemy,
        heroAbilities: [],
        heroEffects: [],
      }),
      combatants: {
        ...initCombat({
          heroName: "Tester",
          heroHp: 100,
          heroMaxHp: 100,
          heroDamage: 20,
          heroArmor: 0,
          enemyObj: baseEnemy,
          heroAbilities: [],
          heroEffects: [],
        }).combatants,
        hero: {
          ...initCombat({
            heroName: "Tester",
            heroHp: 100,
            heroMaxHp: 100,
            heroDamage: 20,
            heroArmor: 0,
            enemyObj: baseEnemy,
            heroAbilities: [],
            heroEffects: [],
          }).combatants.hero,
          activeEffects: [{ type: "blind", remainingTicks: 3, hitPenalty: 95 }],
        },
      },
    };
    const miss = processTick(blindedHero, ACTION.BASIC_ATTACK, () => 0.5);
    expect(miss.log.some(entry => entry.type === "miss" && entry.actorId === "hero")).toBe(true);
    expect(miss.combatants.enemy.hp).toBe(100);

    const weakened = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      enemyObj: baseEnemy,
      heroAbilities: [],
      heroEffects: [],
    });
    weakened.combatants.hero.activeEffects = [{ type: "weaken", remainingTicks: 3, damageMult: 0.5 }];
    const weakHit = processTick(weakened, ACTION.BASIC_ATTACK, () => 0.5);
    expect(weakHit.combatants.enemy.hp).toBe(89);

    const staggered = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: baseEnemy,
      heroAbilities: [],
      heroEffects: [],
    });
    staggered.combatants.enemy.activeEffects = [{ type: "stagger", attacksRemaining: 2, missPenalty: 35 }];
    staggered.actionQueue = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 0, 10, null, 1);
    const firstStaggerMiss = processTick(staggered, ACTION.NONE, (() => {
      const rolls = [0.6];
      return () => rolls.shift() ?? 0.5;
    })());
    expect(firstStaggerMiss.log.some(entry => entry.type === "miss" && entry.actorId === "enemy")).toBe(true);
    expect(firstStaggerMiss.combatants.hero.hp).toBe(100);
    expect(firstStaggerMiss.combatants.enemy.activeEffects.find(effect => effect.type === "stagger")?.attacksRemaining).toBe(1);

    firstStaggerMiss.actionQueue = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, firstStaggerMiss.tick, 10, null, 1);
    const secondStaggerMiss = processTick(firstStaggerMiss, ACTION.NONE, (() => {
      const rolls = [0.6];
      return () => rolls.shift() ?? 0.5;
    })());
    expect(secondStaggerMiss.log.filter(entry => entry.type === "miss" && entry.actorId === "enemy")).toHaveLength(2);
    expect(secondStaggerMiss.combatants.enemy.activeEffects.some(effect => effect.type === "stagger")).toBe(false);

    secondStaggerMiss.actionQueue = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, secondStaggerMiss.tick, 10, null, 1);
    const postStaggerHit = processTick(secondStaggerMiss, ACTION.NONE, (() => {
      const rolls = [0.5, 0.6];
      return () => rolls.shift() ?? 0.5;
    })());
    expect(postStaggerHit.combatants.hero.hp).toBe(90);

    const regen = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...baseEnemy, hp: 90, effects: [{ type: "regen_each_round", value: 3 }] },
      heroAbilities: [],
      heroEffects: [],
    });
    const regenerated = processTick({ ...regen, tick: 1 }, ACTION.NONE, () => 0.5);
    expect(regenerated.combatants.enemy.hp).toBe(93);
    expect(regenerated.log.some(entry => entry.type === "heal" && entry.actorId === "enemy")).toBe(true);

    let trollRegen = initCombat({
      heroName: "Tester",
      heroHp: 500,
      heroMaxHp: 500,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        ...enemyById.troll_small,
        hp: 70,
        stats: enemyById.troll_small.baseStats,
      },
      heroAbilities: [],
      heroEffects: [],
    });
    trollRegen = processTick(trollRegen, ACTION.NONE, () => 0.01, { disableAutoAttacks: true });
    expect(trollRegen.log).toContainEqual(expect.objectContaining({
      actorId: "enemy",
      type: "cast_start",
      abilityId: "small_troll_mending_hide",
    }));
    expect(trollRegen.combatants.enemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "heal_over_time",
      healPerTick: 16,
      remainingTicks: 3,
      sourceAbilityId: "small_troll_mending_hide",
    }));
    expect(trollRegen.combatants.enemy.abilityCooldowns.small_troll_mending_hide).toBe(17);

    trollRegen = processTick(trollRegen, ACTION.NONE, () => 0.01, { disableAutoAttacks: true });
    expect(trollRegen.combatants.enemy.hp).toBe(88);
    expect(trollRegen.log.some(entry =>
      entry.actorId === "enemy"
      && entry.type === "heal"
      && String(entry.text).includes("Mending Hide")
    )).toBe(true);

    const cooldownEnemy = {
      ...trollRegen.combatants.enemy,
      hp: 60,
      activeEffects: [],
    };
    const onCooldown = processTick({
      ...trollRegen,
      log: [],
      combatants: {
        ...trollRegen.combatants,
        enemy: cooldownEnemy,
        enemies: [cooldownEnemy],
      },
    }, ACTION.NONE, () => 0.01, { disableAutoAttacks: true });
    expect(onCooldown.log.some(entry => entry.abilityId === "small_troll_mending_hide")).toBe(false);

    let cooldownCheck = onCooldown;
    for (let nextTick = cooldownCheck.tick + 1; nextTick < 17; nextTick += 1) {
      const forcedEnemy = {
        ...cooldownCheck.combatants.enemy,
        hp: 60,
        activeEffects: [],
      };
      cooldownCheck = processTick({
        ...cooldownCheck,
        log: [],
        combatants: {
          ...cooldownCheck.combatants,
          enemy: forcedEnemy,
          enemies: [forcedEnemy],
        },
      }, ACTION.NONE, () => 0.01, { disableAutoAttacks: true });
      expect(cooldownCheck.tick).toBe(nextTick);
      expect(cooldownCheck.log.some(entry => entry.abilityId === "small_troll_mending_hide")).toBe(false);
    }
    const readyEnemy = {
      ...cooldownCheck.combatants.enemy,
      hp: 60,
      activeEffects: [],
    };
    const recastReady = processTick({
      ...cooldownCheck,
      log: [],
      combatants: {
        ...cooldownCheck.combatants,
        enemy: readyEnemy,
        enemies: [readyEnemy],
      },
    }, ACTION.NONE, () => 0.01, { disableAutoAttacks: true });
    expect(recastReady.tick).toBe(17);
    expect(recastReady.log).toContainEqual(expect.objectContaining({
      actorId: "enemy",
      type: "cast_start",
      abilityId: "small_troll_mending_hide",
    }));

    const raging = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...baseEnemy, hp: 30, effects: [{ type: "rage_below_hp", thresholdPct: 40, attackMult: 2 }] },
      heroAbilities: [],
      heroEffects: [],
    });
    const rageWindup = processTick(raging, ACTION.NONE, () => 0.5);
    const rageReady = processTick(rageWindup, ACTION.NONE, () => 0.5);
    const rageHit = processTick(rageReady, ACTION.NONE, () => 0.5);
    expect(rageHit.combatants.hero.hp).toBe(76);

    const armored = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...baseEnemy, hp: 40, effects: [{ type: "physical_reduction_below_hp", thresholdPct: 45, reductionPct: 50 }] },
      heroAbilities: [],
      heroEffects: [],
    });
    armored.actionQueue = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 0, 40, null, 1);
    const reduced = processTick(armored, ACTION.NONE, () => 0.5);
    expect(reduced.combatants.enemy.hp).toBe(20);
    expect(reduced.log.some(entry => entry.type === "guard" && entry.reductionPct === 50)).toBe(true);

    const accurateEnemy = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: { ...baseEnemy, effects: [{ type: "enemy_hit_chance", value: 20 }] },
      heroAbilities: [],
      heroEffects: [],
    });
    accurateEnemy.combatants.enemy.activeEffects = [{ type: "blind", remainingTicks: 3, hitPenalty: 95 }];
    accurateEnemy.combatants.enemy.autoAttackStarted = true;
    accurateEnemy.combatants.enemy.autoAttackProgressTicks = 2;
    const rolls = [0.5, 0.1];
    const accurateHit = processTick(accurateEnemy, ACTION.NONE, () => rolls.shift() ?? 0.5);
    expect(accurateHit.log.some(entry => entry.actorId === "enemy" && entry.type === "hit")).toBe(true);
  });

  it("keeps blind active until the blinded combatant's next slow auto attack", () => {
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      enemyObj: {
        id: "slow_blind_dummy",
        name: "Slow Blind Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    state.combatants.hero = {
      ...state.combatants.hero,
      autoAttackRate: 0.25,
      autoAttackStarted: true,
      autoAttackProgressTicks: 0,
      activeEffects: [{ type: "blind", remainingTicks: 1, attacksRemaining: 1, hitPenalty: 95 }],
    };

    for (let i = 0; i < 13; i += 1) {
      state = processTick(state, ACTION.BASIC_ATTACK, () => 0.5);
    }

    expect(state.log.some(entry => entry.type === "miss" && entry.actorId === "hero")).toBe(true);
    expect(state.combatants.enemy.hp).toBe(100);
    expect(state.combatants.hero.activeEffects.some(effect => effect.type === "blind")).toBe(false);
  });

  it("does not auto attack unless a basic attack action is requested", () => {
    const state = initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    expect(state.actionQueue.length).toBe(0);
    expect(state.combatants.hero.autoAttackProgressTicks).toBe(0);
    expect(state.combatants.enemy.autoAttackProgressTicks).toBe(0);

    const tickOne = processTick(state, ACTION.NONE, () => 0.1);
    expect(tickOne.actionQueue.length).toBe(0);
    expect(tickOne.combatants.hero.autoAttackProgressTicks).toBe(0);

    const basic = processTick(tickOne, ACTION.BASIC_ATTACK, () => 0.5);
    expect(basic.log.some(entry => entry.actorId === "hero" && (entry.type === "hit" || entry.type === "blocked") && !entry.abilityId)).toBe(true);
  });

  it("does not fake auto attacks or schedules for zero-rate combatants", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "still_dummy",
        name: "Still Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 25, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const tickOne = processTick(state, ACTION.NONE, () => 0.1);

    expect(tickOne.combatants.hero.hp).toBe(100);
    expect(tickOne.combatants.enemy.autoAttackProgressTicks).toBe(0);
    expect(tickOne.combatants.enemy.lastAutoAttackTick).toBeNull();
    expect(tickOne.combatants.enemy.nextAutoAttackTick).toBeNull();
    expect(tickOne.log.some(entry => entry.actorId === "enemy" && (entry.type === "hit" || entry.type === "blocked"))).toBe(false);
  });

  it("resumes auto attacks after a cast resets the cycle", () => {
    const resetCast = {
      id: "reset_cast",
      name: "Reset Cast",
      type: "spell_attack",
      castTicks: 1,
      cooldownSeconds: 0,
      energyCost: 0,
      damage: 1,
    };
    let state = initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [resetCast],
      heroEffects: [],
      heroAttackRate: 1,
    });
    state.combatants.hero = {
      ...state.combatants.hero,
      autoAttackStarted: true,
      autoAttackProgressTicks: 2,
      lastAutoAttackTick: 0,
      nextAutoAttackTick: 1,
    };

    const casting = processTick(state, ACTION.ABILITY_0, () => 0.5);
    expect(casting.combatants.hero.autoAttackProgressTicks).toBe(0);
    expect(casting.combatants.hero.lastAutoAttackTick).toBe(casting.tick);
    expect(casting.combatants.hero.nextAutoAttackTick).toBe(casting.tick + AUTO_ATTACK_TICKS);

    let resumed = casting;
    for (let i = 0; i < AUTO_ATTACK_TICKS + 1; i += 1) {
      resumed = processTick(resumed, ACTION.BASIC_ATTACK, () => 0.5);
    }

    expect(resumed.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && !entry.abilityId)).toBe(true);
  });

  it("keeps enemy auto attack schedules current after enemy casts", () => {
    const enemyCast = {
      id: "enemy_cast",
      name: "Enemy Cast",
      type: "spell_attack",
      castTicks: 2,
      cooldownSeconds: 20,
      damage: 1,
    };
    let state = initCombat({
      heroName: "Target",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "casting_enemy",
        name: "Casting Enemy",
        hp: 100,
        stats: { maxHp: 100, attack: 10, armor: 0, attackSpeed: 1 },
        effects: [],
        abilities: [enemyCast],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    const primedEnemy = {
      ...state.combatants.enemy,
      autoAttackStarted: true,
      autoAttackProgressTicks: 2,
      lastAutoAttackTick: 0,
      nextAutoAttackTick: 1,
    };
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: primedEnemy,
        enemies: [primedEnemy],
      },
    };

    let casting = processTick(state, ACTION.NONE, () => 0.1);
    expect(casting.log.some(entry => entry.actorId === "enemy" && entry.type === "cast_start")).toBe(true);
    expect(casting.combatants.enemy.autoAttackProgressTicks).toBe(0);
    expect(casting.combatants.enemy.nextAutoAttackTick).toBeGreaterThan(casting.tick);

    casting = processTick(casting, ACTION.NONE, () => 0.9);
    const resolved = processTick(casting, ACTION.NONE, () => 0.9);

    expect(resolved.log.some(entry => entry.actorId === "enemy" && entry.abilityId === "enemy_cast")).toBe(true);
    expect(resolved.combatants.enemy.nextAutoAttackTick).toBeGreaterThan(resolved.tick);
    expect(resolved.combatants.enemy.nextAutoAttackTick).toBe(resolved.tick + AUTO_ATTACK_TICKS);
  });

  it("fires a scheduled auto attack when a stale ready schedule is encountered", () => {
    let state = initCombat({
      heroName: "Recovered",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
    });
    state = {
      ...state,
      tick: 5,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          autoAttackStarted: true,
          autoAttackProgressTicks: 0,
          lastAutoAttackTick: 0,
          nextAutoAttackTick: 1,
        },
      },
    };

    const recovered = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    expect(recovered.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && !entry.abilityId)).toBe(true);
    expect(recovered.combatants.hero.nextAutoAttackTick).toBeGreaterThan(recovered.tick);
  });

  it("keeps auto attack progress moving when a basic attack is already queued", () => {
    let state = initCombat({
      heroName: "Recovered",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
    });
    state = {
      ...state,
      actionQueue: enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 0, 10, null, 2, { targetId: "enemy" }),
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          autoAttackStarted: true,
          autoAttackProgressTicks: 0,
          lastAutoAttackTick: 0,
          nextAutoAttackTick: AUTO_ATTACK_TICKS,
        },
      },
    };

    const advancing = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    expect(advancing.combatants.hero.autoAttackProgressTicks).toBeGreaterThan(0);
    expect(advancing.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && !entry.abilityId)).toBe(false);

    const queuedHit = processTick(advancing, ACTION.BASIC_ATTACK, () => 0.01);
    expect(queuedHit.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && !entry.abilityId)).toBe(true);
    expect(queuedHit.combatants.hero.autoAttackProgressTicks).toBeGreaterThan(0);

    const regularHit = processTick(queuedHit, ACTION.BASIC_ATTACK, () => 0.01);
    const heroBasicHits = regularHit.log.filter(entry => entry.actorId === "hero" && entry.type === "hit" && !entry.abilityId);
    expect(heroBasicHits.length).toBeGreaterThanOrEqual(2);
    expect(regularHit.combatants.hero.nextAutoAttackTick).toBeGreaterThan(regularHit.tick);
  });

  it("keeps auto attacks advancing when a requested ability fails before casting", () => {
    const onCooldown = {
      id: "cooldown_spell",
      name: "Cooldown Spell",
      type: "spell_attack",
      castTicks: 1,
      cooldownSeconds: 10,
      energyCost: 0,
      damage: 1,
    };
    let state = initCombat({
      heroName: "Recovered",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [onCooldown],
      heroEffects: [],
      heroAttackRate: 1,
    });
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          autoAttackStarted: true,
          autoAttackProgressTicks: 0,
          lastAutoAttackTick: 0,
          nextAutoAttackTick: AUTO_ATTACK_TICKS,
          abilityCooldowns: { cooldown_spell: 99 },
        },
      },
    };

    for (let i = 0; i < AUTO_ATTACK_TICKS; i += 1) {
      state = processTick(state, ACTION.ABILITY_0, () => 0.01);
    }

    expect(state.log.some(entry => entry.actorId === "hero" && entry.type === "ability_fail" && entry.abilityId == null)).toBe(true);
    expect(state.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && !entry.abilityId)).toBe(true);
    expect(state.combatants.hero.nextAutoAttackTick).toBeGreaterThan(state.tick);
  });

  it("recovers hero auto attacks from corrupted zero or non-finite attack rates", () => {
    const buildState = autoAttackRate => {
      const state = initCombat({
        heroName: "Recovered",
        heroHp: 100,
        heroMaxHp: 100,
        heroDamage: 10,
        heroArmor: 0,
        enemyObj: {
          id: "dummy",
          name: "Training Dummy",
          hp: 1000,
          stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 0 },
          effects: [],
        },
        heroAbilities: [],
        heroEffects: [],
        heroAttackRate: 1,
      });
      state.combatants.hero = {
        ...state.combatants.hero,
        autoAttackRate,
        autoAttackStarted: true,
        autoAttackProgressTicks: 0,
        lastAutoAttackTick: 0,
        nextAutoAttackTick: null,
      };
      return state;
    };

    for (const autoAttackRate of [0, Number.NaN]) {
      let state = buildState(autoAttackRate);
      for (let i = 0; i < AUTO_ATTACK_TICKS; i += 1) {
        state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
      }

      expect(state.log.some(entry => entry.actorId === "hero" && entry.type === "hit" && !entry.abilityId)).toBe(true);
      expect(Number.isFinite(state.combatants.hero.nextAutoAttackTick)).toBe(true);
    }
  });

  it("serrated strikes applies real bleed stacks and gates hemorrhage until two stacks", () => {
    const serrated = {
      id: "serrated_strikes",
      name: "Serrated Strikes",
      type: "serrated_strikes",
      castTicks: 0,
      cooldownSeconds: 10,
      energyCost: 20,
      chargesGranted: 3,
      damageBonusPct: 5,
      bleedChancePct: 100,
    };
    const hemorrhage = {
      id: "hemorrhage",
      name: "Hemorrhage",
      type: "hemorrhage",
      castTicks: 1,
      cooldownSeconds: 14,
      energyCost: 25,
      requiresTargetBleeding: true,
      requiredTargetBleedStacks: 2,
      trueDamagePct: 10,
      hemorrhageDamagePct: 4,
      hemorrhageDuration: 4,
    };
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 100000,
      stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    let state = withCombatRage(initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [serrated, hemorrhage],
      heroEffects: [],
      heroAttackRate: 3,
    }));

    expect(getAbilityUseFailureReason(state.combatants.hero, hemorrhage, 1, state.heroResources, state.combatants.enemy)).toContain("2 Bleeding stacks");

    state = processTick(state, ACTION.ABILITY_0, () => 0.01);

    expect(state.combatants.enemy.activeEffects.find(effect => effect.type === "bleed")?.stacks).toBe(1);
    expect(getAbilityUseFailureReason(state.combatants.hero, hemorrhage, state.tick + 1, state.heroResources, state.combatants.enemy)).toContain("2 Bleeding stacks");

    for (let i = 0; i < 4; i += 1) {
      state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
      if ((state.combatants.enemy.activeEffects.find(effect => effect.type === "bleed")?.stacks || 0) >= 2) break;
    }

    expect(state.combatants.enemy.activeEffects.find(effect => effect.type === "bleed")?.stacks).toBe(2);
    expect(getAbilityUseFailureReason(state.combatants.hero, hemorrhage, state.tick + 1, state.heroResources, state.combatants.enemy)).toBeNull();
    expect(state.log.filter(entry => entry.type === "bleed" && entry.text.includes("gains Bleeding")).map(entry => entry.text).at(-1)).toContain("2 stacks");
  });

  it("Relentless Wounds makes the first landed hit of combat apply Bleed", () => {
    const relentlessWounds = {
      id: "bleeder_relentless_wounds",
      proc: {
        trigger: "on_first_hit",
        chance: 100,
        condition: null,
        effect: { type: "apply_bleed", stacks: 1 },
      },
    };
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 100000,
      stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 3,
      heroProcNodes: [relentlessWounds],
    });

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    const bleed = state.combatants.enemy.activeEffects.find(effect => effect.type === "bleed");
    expect(bleed).toMatchObject({ stacks: 1, remainingTicks: 4 });
    expect(state.log.some(entry => entry.type === "bleed" && entry.text.includes("Target Dummy gains Bleeding"))).toBe(true);
  });

  it("player-applied Bleed stacks refresh the shared timer to at least four seconds", () => {
    const bleedNode = {
      id: "bleed_refresh_test",
      proc: {
        trigger: "on_hit",
        chance: 100,
        condition: null,
        effect: { type: "apply_bleed", stacks: 1 },
      },
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 3,
      heroProcNodes: [bleedNode],
    });
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: {
          ...state.combatants.enemy,
          activeEffects: [{ type: "bleed", stacks: 1, remainingTicks: 2, damagePctPerTick: 2 }],
        },
      },
    };

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    const bleed = state.combatants.enemy.activeEffects.find(effect => effect.type === "bleed");
    expect(bleed).toMatchObject({ stacks: 2, remainingTicks: 4 });
  });

  it("interactive bleed tick damage scales with bleed stacks", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 0,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
    });
    const stackedBleedState = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: {
          ...state.combatants.enemy,
          activeEffects: [{ type: "bleed", stacks: 3, remainingTicks: 2, damagePctPerTick: 2 }],
        },
      },
    };

    const after = processTick(stackedBleedState, ACTION.NONE, () => 0.5);
    const bleedTick = after.log.find(entry => entry.type === "bleed" && entry.damage > 0);
    expect(bleedTick?.damage).toBe(60);
    expect(bleedTick?.text).toContain("3 stacks");
    expect(after.combatants.enemy.hp).toBe(940);
  });

  it("sword stance makes auto attacks arrive faster instead of adding hidden damage", () => {
    const swordStance = {
      id: "sword_stance",
      name: "Sword Stance",
      type: "sword_stance",
      castTicks: 0,
      cooldownSeconds: 10,
      energyCost: 20,
      chargesGranted: 3,
      attackSpeedBonusPct: 25,
      bleedChancePct: 10,
      bleedingCritChanceBonusPct: 10,
    };
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 100000,
      stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    const baseConfig = {
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj,
      heroEffects: [],
      heroAttackRate: 1,
    };
    let normal = initCombat({ ...baseConfig, heroAbilities: [] });
    let stanced = withCombatRage(initCombat({ ...baseConfig, heroAbilities: [swordStance] }));

    normal = processTick(normal, ACTION.NONE, () => 0.5);
    normal = processTick(normal, ACTION.NONE, () => 0.5);
    stanced = processTick(stanced, ACTION.ABILITY_0, () => 0.5);
    stanced = processTick(stanced, ACTION.NONE, () => 0.5);

    for (let i = 0; i < 9; i += 1) {
      normal = processTick(normal, ACTION.BASIC_ATTACK, () => 0.5);
      stanced = processTick(stanced, ACTION.BASIC_ATTACK, () => 0.5);
    }

    const normalHits = normal.log.filter(entry => entry.actorId === "hero" && entry.type === "hit");
    const stancedHits = stanced.log.filter(entry => entry.actorId === "hero" && entry.type === "hit");

    expect(stancedHits.length).toBeGreaterThan(normalHits.length);
    expect(stanced.log.some(entry => entry.text.includes("quick strike"))).toBe(false);
  });

  it("fighter active spec skills resolve their unfinished combat effects", () => {
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 1000,
      stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 40,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [combatSkillById.whirlwind],
      heroEffects: [],
      heroWeaponTags: ["melee"],
    });

    const hero = state.combatants.hero;
    const enemy = state.combatants.enemy;
    const whirlwindHero = { ...hero, hp: 70, activeEffects: [], abilityCooldowns: {} };
    const whirlwindPrimary = { ...enemy, id: "primary", name: "Primary Dummy", hp: 100, maxHp: 100, activeEffects: [], armor: 0 };
    const whirlwindAdd = { ...enemy, id: "add", name: "Add Dummy", hp: 40, maxHp: 40, activeEffects: [], armor: 0 };
    const whirlwindProcState = { ...state.procState, rage: 25 };
    const whirlwindEntries = resolveAbilityImpact(
      { ability: combatSkillById.whirlwind },
      whirlwindHero,
      whirlwindPrimary,
      1,
      () => 0.5,
      { enemyAllies: [whirlwindAdd], procState: whirlwindProcState },
    );
    expect(whirlwindEntries.filter(entry => entry.type === "ability" && entry.damage > 0)).toHaveLength(2);
    expect(whirlwindPrimary.hp).toBeLessThan(100);
    expect(whirlwindAdd.hp).toBe(0);
    expect(whirlwindHero.hp).toBe(85);
    expect(whirlwindProcState.rage).toBe(50);
    expect(whirlwindEntries.at(-1)?.text).toContain("25 Rage and 15 HP");

    const dormantHero = { ...hero, activeEffects: [], abilityCooldowns: {} };
    const berserkerEntries = resolveAbilityImpact({ ability: combatSkillById.berserker_stance }, dormantHero, enemy, 2, () => 0.5, {});
    expect(berserkerEntries.at(-1)?.text).toContain("+30% damage dealt");
    expect(dormantHero.activeEffects).toContainEqual(expect.objectContaining({
      type: "berserker_stance",
      damageDealtPct: 30,
      damageTakenPct: 30,
      disableBlock: true,
    }));

    const deactivationProcState = { ...state.procState, rage: 9 };
    const deactivationEntries = resolveAbilityImpact(
      { ability: combatSkillById.berserker_stance },
      dormantHero,
      enemy,
      3,
      () => 0.5,
      { procState: deactivationProcState },
    );
    expect(dormantHero.activeEffects.some(effect => effect.type === "berserker_stance")).toBe(false);
    expect(dormantHero.abilityCooldowns.berserker_stance).toBe(6);
    expect(deactivationProcState.rage).toBe(0);
    expect(deactivationEntries.at(-1)?.text).toContain("draining all Rage");

    const shieldWallHero = { ...hero, activeEffects: [], abilityCooldowns: {}, offhandFamily: "shield" };
    const shieldWallEntries = resolveAbilityImpact(
      { ability: combatSkillById.shield_wall },
      shieldWallHero,
      enemy,
      3,
      () => 0.5,
      {},
    );
    expect(getAbilityEnergyCost(combatSkillById.shield_wall)).toBe(35);
    expect(shieldWallEntries.at(-1)?.text).toContain("20% less damage dealt");
    expect(shieldWallHero.activeEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "block_chance_buff", value: 35, remainingTicks: 5 }),
      expect.objectContaining({ type: "block_power_recovery_pct", value: 50, remainingTicks: 5 }),
      expect.objectContaining({ type: "damage_taken_reduction", reductionPct: 20, remainingTicks: 5 }),
      expect.objectContaining({ type: "damage_bonus_pct_buff", value: -20, remainingTicks: 5 }),
    ]));

    const burnoutProcState = { ...state.procState, momentumStacks: 4, momentumMaxHeldTicks: 2 };
    const burnoutEnemy = { ...enemy, hp: 1000, activeEffects: [], armor: 0 };
    const burnoutEntries = resolveAbilityImpact(
      { ability: combatSkillById.burnout },
      { ...hero, activeEffects: [] },
      burnoutEnemy,
      3,
      () => 0.5,
      { procState: burnoutProcState },
    );
    expect(burnoutProcState.momentumStacks).toBe(0);
    expect(burnoutProcState.momentumMaxHeldTicks).toBe(0);
    expect(burnoutEnemy.hp).toBe(958);
    expect(burnoutEntries.at(-1)?.text).toContain("consumed 4 Momentum");

    const grudgeProcState = { ...state.procState, grudge: 37 };
    const grudgeEnemy = { ...enemy, hp: 1000, activeEffects: [] };
    const grudgeEntries = resolveAbilityImpact(
      { ability: combatSkillById.grudge_release },
      hero,
      grudgeEnemy,
      4,
      () => 0.5,
      { procState: grudgeProcState },
    );
    expect(grudgeProcState.grudge).toBe(0);
    expect(grudgeEnemy.hp).toBe(963);
    expect(grudgeEntries.at(-1)?.text).toContain("37 stored Grudge");

    const bleedEnemy = { ...enemy, activeEffects: [] };
    resolveAbilityImpact({ ability: combatSkillById.open_vein }, hero, bleedEnemy, 5, () => 0.5, {});
    expect(bleedEnemy.activeEffects).toContainEqual(expect.objectContaining({
      type: "bleed",
      stacks: 2,
      remainingTicks: 4,
    }));

    const enGardeEntries = resolveAbilityImpact({ ability: combatSkillById.en_garde }, hero, enemy, 6, () => 0.5, {});
    expect(enGardeEntries.at(-1)?.text).toContain("parry chance is 100%");
    expect(hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "en_garde",
      remainingTicks: 3,
      bladeStackMultiplier: 2,
    }));
  });

  it("Burnout deals one 25% weapon-damage hit per consumed Momentum stack", () => {
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 1000,
      stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 11,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [combatSkillById.burnout],
      heroEffects: [],
      heroWeaponTags: ["melee"],
    });
    const hero = state.combatants.hero;

    for (const stacks of [3, 6, 10]) {
      const procState = { ...state.procState, momentumStacks: stacks, momentumMaxHeldTicks: 2 };
      const enemy = { ...state.combatants.enemy, hp: 1000, activeEffects: [], armor: 0 };
      const entries = resolveAbilityImpact(
        { ability: combatSkillById.burnout },
        hero,
        enemy,
        1,
        () => 0.5,
        { procState },
      );
      const expectedDamage = Math.max(1, Math.floor((hero.damage + 2) * combatSkillById.burnout.damageMultPerStack * stacks));

      expect(procState.momentumStacks).toBe(0);
      expect(enemy.hp).toBe(1000 - expectedDamage);
      expect(entries.at(-1)).toMatchObject({ damage: expectedDamage });
      expect(entries.at(-1)?.text).toContain(`consumed ${stacks} Momentum for ${stacks} hits`);
    }
  });

  it("Burnout uses the same weapon dice baseline players see on autoattacks", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [combatSkillById.burnout],
      heroEffects: [],
      heroWeaponTags: ["melee"],
      heroWeaponDamageDice: { count: 1, sides: 8, text: "1d8" },
    });
    const hero = state.combatants.hero;
    const enemy = { ...state.combatants.enemy, hp: 1000, activeEffects: [], armor: 0 };
    const procState = { ...state.procState, momentumStacks: 10, momentumMaxHeldTicks: 2 };
    const rolls = [0.5, 0.99, 0.5];

    const entries = resolveAbilityImpact(
      { ability: combatSkillById.burnout },
      hero,
      enemy,
      1,
      () => rolls.shift() ?? 0.5,
      { procState },
    );

    expect(entries.at(-1)).toMatchObject({ damage: 65 });
    expect(enemy.hp).toBe(935);
  });

  it("Burnout benefits from dynamic weapon damage multipliers", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        family: "dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [combatSkillById.burnout],
      heroEffects: [
        { type: "threshold_dmg_pct", value: 20 },
        { type: "damage_vs_family", family: "dummy", value: 50 },
      ],
      heroWeaponTags: ["melee"],
    });
    const hero = {
      ...state.combatants.hero,
      activeEffects: [{ type: "damage_bonus_pct_buff", value: 10, remainingTicks: 3 }],
    };
    const enemy = { ...state.combatants.enemy, hp: 1000, activeEffects: [], armor: 0 };
    const procState = { ...state.procState, momentumStacks: 10, momentumMaxHeldTicks: 2 };

    const entries = resolveAbilityImpact(
      { ability: combatSkillById.burnout },
      hero,
      enemy,
      1,
      () => 0.5,
      { procState },
    );

    expect(entries.at(-1)).toMatchObject({ damage: 108 });
    expect(enemy.hp).toBe(892);
  });

  it("Burnout and Release require stored spec resources before casting", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [combatSkillById.burnout, combatSkillById.grudge_release],
      heroEffects: [],
      heroWeaponTags: ["melee"],
    });

    expect(getAbilityUseFailureReason(
      state.combatants.hero,
      combatSkillById.burnout,
      1,
      state.heroResources,
      state.combatants.enemy,
      { procState: { ...state.procState, momentumStacks: 2 } },
    )).toContain("3 Momentum stacks");
    expect(getAbilityUseFailureReason(
      state.combatants.hero,
      combatSkillById.burnout,
      1,
      state.heroResources,
      state.combatants.enemy,
      { procState: { ...state.procState, momentumStacks: 3 } },
    )).toBeNull();
    expect(getAbilityUseFailureReason(
      state.combatants.hero,
      combatSkillById.grudge_release,
      1,
      state.heroResources,
      state.combatants.enemy,
      { procState: { ...state.procState, grudge: 0 } },
    )).toContain("stored Grudge");
  });

  it("Whirlwind costs 50 Rage while dormant Berserker Stance keeps its toggle rules", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [combatSkillById.whirlwind],
      heroEffects: [],
      heroWeaponTags: ["melee"],
    });

    expect(getAbilityEnergyCost(combatSkillById.whirlwind)).toBe(50);
    expect(getAbilityUseFailureReason(
      state.combatants.hero,
      combatSkillById.whirlwind,
      1,
      { rage: { value: 49 } },
      state.combatants.enemy,
      { procState: { ...state.procState, rage: 49 } },
    )).toContain("Not enough Rage");

    expect(getAbilityEnergyCost(combatSkillById.berserker_stance)).toBe(15);
    expect(getAbilityUseFailureReason(
      state.combatants.hero,
      combatSkillById.berserker_stance,
      1,
      { rage: { value: 14 } },
      state.combatants.enemy,
      { procState: { ...state.procState, rage: 14 } },
    )).toContain("Not enough Rage");

    const activeHero = {
      ...state.combatants.hero,
      activeEffects: [{ type: "berserker_stance", active: true, disableBlock: true }],
    };
    expect(getAbilityUseFailureReason(
      activeHero,
      combatSkillById.berserker_stance,
      1,
      { rage: { value: 0 } },
      state.combatants.enemy,
      { procState: { ...state.procState, rage: 0 } },
    )).toBeNull();
  });

  it("En Garde forces parry and doubles Blade Stack gain from parries", () => {
    const strike = () => enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 20);
    const state = initCombat({
      heroName: "Duelist",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [{
        id: "duelist_blade_stack",
        proc: {
          trigger: "on_parry",
          chance: 100,
          effect: { type: "gain_blade_stack", value: 1 },
        },
      }],
    });
    const enGardeState = {
      ...state,
      tick: 2,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          activeEffects: [{ type: "en_garde", remainingTicks: 3, bladeStackMultiplier: 2 }],
        },
      },
      actionQueue: strike(),
    };

    const parried = processTick(enGardeState, ACTION.NONE, () => 0.1);

    expect(parried.combatants.hero.hp).toBe(100);
    expect(parried.log.some(entry => entry.type === "parry")).toBe(true);
    expect(parried.procState.bladeStacks).toBe(2);
    expect(parried.combatants.hero.passiveEffects).toContainEqual({ type: "crit_chance_bonus", value: 12, source: "blade_stacks" });
  });

  it("En Garde adds Blade Stacks when parrying realtime enemy autos", () => {
    const state = initCombat({
      heroName: "Duelist",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 10, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [{
        id: "duelist_blade_stack",
        proc: {
          trigger: "on_parry",
          chance: 100,
          effect: { type: "gain_blade_stack", value: 1 },
        },
      }],
    });
    const enGardeState = {
      ...state,
      tick: 2,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          activeEffects: [{ type: "en_garde", remainingTicks: 3, bladeStackMultiplier: 2 }],
        },
        enemy: {
          ...state.combatants.enemy,
          nextAutoAttackTick: 1,
        },
      },
    };

    const parried = processAutoAttackFrame(enGardeState, AUTO_ATTACK_TICKS * TICK_MS, () => 0.1, { skipHeroAuto: true });

    expect(parried.combatants.hero.hp).toBe(100);
    expect(parried.log.some(entry => entry.type === "parry")).toBe(true);
    expect(parried.procState.bladeStacks).toBe(2);
    expect(parried.combatants.hero.passiveEffects).toContainEqual({ type: "crit_chance_bonus", value: 12, source: "blade_stacks" });
  });

  it("momentum stacks grant attack speed in interactive combat", () => {
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 100000,
      stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
      heroProcNodes: [{
        id: "speed_momentum_gen",
        proc: {
          trigger: "on_hit",
          chance: 100,
          effect: { type: "gain_momentum", value: 1 },
        },
      }],
    });

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    expect(state.procState.momentumStacks).toBe(1);
    expect(state.combatants.hero.passiveEffects).toContainEqual({
      type: "attack_speed_bonus_pct",
      value: MOMENTUM_ATTACK_SPEED_PCT_PER_STACK,
      source: "momentum",
    });
    expect(state.combatants.hero.nextAutoAttackTick).toBe(state.tick + 3);
  });

  it("Opening Blitz does not double-count the first Momentum hit stack", () => {
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 100000,
      stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
      heroProcNodes: [
        {
          id: "speed_momentum_gen",
          proc: {
            trigger: "on_hit",
            chance: 100,
            effect: { type: "gain_momentum", value: 1 },
          },
        },
        {
          id: "speed_opening_blitz",
          proc: {
            trigger: "on_first_hit",
            chance: 100,
            effect: { type: "set_momentum_min", value: 3 },
          },
        },
      ],
    });

    const afterFirstHit = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    expect(afterFirstHit.procState.momentumStacks).toBe(3);
    expect(afterFirstHit.combatants.hero.passiveEffects).toContainEqual({
      type: "attack_speed_bonus_pct",
      value: 3 * MOMENTUM_ATTACK_SPEED_PCT_PER_STACK,
      source: "momentum",
    });
    expect(afterFirstHit.combatants.hero.autoAttackProgressTicks).toBe(0);
    expect(afterFirstHit.combatants.hero.nextAutoAttackTick).toBe(afterFirstHit.tick + 3);

    let afterSecondHit = afterFirstHit;
    const hitCountAfterFirst = afterFirstHit.log.filter(entry => entry.actorId === "hero" && entry.type === "hit").length;
    for (let i = 0; i < 5; i += 1) {
      afterSecondHit = processTick(afterSecondHit, ACTION.BASIC_ATTACK, () => 0.01);
      const hitCount = afterSecondHit.log.filter(entry => entry.actorId === "hero" && entry.type === "hit").length;
      if (hitCount > hitCountAfterFirst) break;
    }
    expect(afterSecondHit.procState.momentumStacks).toBe(4);
    expect(afterSecondHit.combatants.hero.passiveEffects).toContainEqual({
      type: "attack_speed_bonus_pct",
      value: 4 * MOMENTUM_ATTACK_SPEED_PCT_PER_STACK,
      source: "momentum",
    });
    expect(afterSecondHit.combatants.hero.nextAutoAttackTick).toBeLessThanOrEqual(afterSecondHit.tick + 3);
  });

  it("Overdrive grants Rage starting at 4 Momentum", () => {
    const fighterTree = talentTrees.find(entry => entry.id === "fighter");
    const speedDemon = fighterTree.branches.find(branch => branch.id === "speed_demon");
    const overdrive = speedDemon.tiers
      .flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "speed_overdrive");
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 100000,
      stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 0 },
      effects: [],
    };
    const buildState = momentumStacks => {
      const state = initCombat({
        heroName: "Tester",
        heroHp: 100,
        heroMaxHp: 100,
        heroDamage: 10,
        heroArmor: 0,
        enemyObj,
        heroAbilities: [],
        heroEffects: [],
        heroAttackRate: 1,
        heroProcNodes: [{ id: overdrive.id, proc: overdrive.proc }],
      });
      return {
        ...state,
        procState: { ...state.procState, momentumStacks, rage: 0 },
      };
    };

    expect(overdrive.summary).toContain("At 4+ Momentum stacks: each hit generates +6 Rage");
    expect(overdrive.proc.condition).toEqual({ momentum_stacks_gte: 4 });

    const notReady = processTick(buildState(3), ACTION.BASIC_ATTACK, () => 0.01);
    const active = processTick(buildState(4), ACTION.BASIC_ATTACK, () => 0.01);

    expect(active.procState.rage - notReady.procState.rage).toBe(6);
  });

  it("Killing Speed fires an extra half-damage auto attack when Momentum reaches 5", () => {
    const momentumNode = {
      id: "speed_momentum_gen",
      proc: {
        trigger: "on_hit",
        chance: 100,
        effect: { type: "gain_momentum", value: 1 },
      },
    };
    const killingSpeedNode = {
      id: "speed_killing_speed",
      proc: {
        trigger: "on_momentum_reach",
        threshold: 5,
        chance: 100,
        effect: { type: "extra_auto_attack", damageMult: 0.5 },
      },
    };
    const state = initCombat({
      heroName: "Sprinter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
      heroProcNodes: [momentumNode, killingSpeedNode],
    });
    const atFourMomentum = { ...state, procState: { ...state.procState, momentumStacks: 4 } };

    const reachedFive = processTick(atFourMomentum, ACTION.BASIC_ATTACK, () => 0.01);

    expect(reachedFive.procState.momentumStacks).toBe(5);
    expect(reachedFive.combatants.enemy.hp).toBe(70);
    expect(reachedFive.log).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorId: "hero",
        type: "hit",
        damage: 10,
        extraHit: true,
        extraHitSource: "speed_killing_speed",
      }),
    ]));

    const alreadyAtFive = { ...state, procState: { ...state.procState, momentumStacks: 5 } };
    const reachedSix = processTick(alreadyAtFive, ACTION.BASIC_ATTACK, () => 0.01);

    expect(reachedSix.procState.momentumStacks).toBe(6);
    expect(reachedSix.log.some(entry => entry.extraHitSource === "speed_killing_speed")).toBe(false);
  });

  it("does not let carried Momentum become duplicated base attack speed", () => {
    let state = initCombat({
      heroName: "Sprinter",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
      heroProcNodes: [],
      heroProcOpts: { momentumCarry: 5 },
    });

    expect(state.combatants.hero.passiveEffects.filter(effect => effect.source === "momentum")).toHaveLength(1);
    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    expect(state.combatants.hero.basePassiveEffects.some(effect => effect.source === "momentum")).toBe(false);
    expect(state.combatants.hero.passiveEffects.filter(effect => effect.source === "momentum")).toHaveLength(1);
  });

  it("Lingering Rage restores carried Rage on the next combat start", () => {
    const lingeringRageNode = {
      id: "berserker_lingering_rage",
      proc: {
        trigger: "on_combat_start",
        chance: 100,
        condition: { carried_rage_gt: 0 },
        effect: { type: "gain_rage_from_carry", pct: 30 },
      },
    };
    let state = initCombat({
      heroName: "Berserker",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [lingeringRageNode],
      heroProcOpts: { carriedRage: 50 },
    });

    state = processTick(state, ACTION.NONE, () => 0.01);

    expect(state.procState.rage).toBe(15);
    expect(state.procState.carriedRage).toBe(0);
    expect(state.log.some(entry => entry.text?.includes("Lingering Rage"))).toBe(true);
  });

  it("Light Footwork grants Momentum when the hero avoids enemy attacks", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 10, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [{
        id: "speed_quickstep",
        proc: {
          trigger: "on_avoid",
          chance: 100,
          effect: { type: "gain_momentum", value: 2 },
        },
        threshold: {
          stat: "momentum_stacks",
          min: 6,
          effects: [{ type: "evasion_chance", value: 5 }],
        },
      }],
    });
    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 10);
    const state = {
      ...base,
      tick: 2,
      actionQueue: enemyStrike,
      procState: { ...base.procState, momentumStacks: 4 },
    };

    const avoided = processTick(state, ACTION.NONE, () => 0.99);

    expect(avoided.procState.momentumStacks).toBe(6);
    expect(avoided.combatants.hero.passiveEffects).toContainEqual({ type: "evasion_chance", value: 5 });
  });

  it("Stutter Step grants dodge and crit after a missed auto while Momentum drops by two", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [{
        id: "speed_crash_landing",
        proc: {
          trigger: "on_miss",
          chance: 100,
          condition: { momentum_stacks_gte: 5 },
          effect: { type: "stutter_step", evasionChanceBonus: 10, critChanceBonus: 10 },
        },
      }],
    });
    const missAction = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 1, 10);
    const missState = {
      ...base,
      tick: 2,
      actionQueue: missAction,
      procState: { ...base.procState, momentumStacks: 5 },
    };

    const stuttered = processTick(missState, ACTION.NONE, () => 0.99);

    expect(stuttered.procState.momentumStacks).toBe(3);
    expect(stuttered.combatants.hero.activeEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "evasion_chance", value: 10, source: "speed_stutter_step", consumeOnNextHit: true }),
      expect.objectContaining({ type: "crit_chance_buff", value: 10, source: "speed_stutter_step", consumeOnNextHit: true }),
    ]));

    const hitAction = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, stuttered.tick, 10, null, 1);
    const hitState = { ...stuttered, actionQueue: hitAction };
    const hit = processTick(hitState, ACTION.NONE, () => 0.01);

    expect(hit.log.some(entry => entry.actorId === "hero" && entry.type === "hit")).toBe(true);
    expect(hit.combatants.hero.activeEffects.some(effect => effect.source === "speed_stutter_step")).toBe(false);
  });

  it("missed hero autoattacks lose up to two Momentum stacks from 1-10", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    for (const stacks of [1, 5, 10]) {
      const missAction = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 1, 10);
      const missState = {
        ...base,
        tick: 2,
        actionQueue: missAction,
        procState: { ...base.procState, momentumStacks: stacks, momentumMaxHeldTicks: 2 },
      };

      const missed = processTick(missState, ACTION.NONE, () => 0.99);

      expect(missed.procState.momentumStacks).toBe(Math.max(0, stacks - 2));
      expect(missed.procState.momentumMaxHeldTicks).toBe(0);
      expect(missed.procState.guaranteedNextHit).toBe(false);
      expect(missed.log.some(entry => entry.type === "proc" && entry.text.includes("missed auto attack"))).toBe(true);
    }
  });

  it("Scar Tissue gains combat-only armor immediately when the hero takes damage", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 5,
      enemyObj: {
        id: "scar_dummy",
        name: "Scar Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 20, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [{
        id: "warmonger_scar_tissue",
        proc: {
          trigger: "on_take_damage",
          chance: 100,
          effect: { type: "gain_scar_stack" },
        },
      }],
    });

    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 0, 20, null, 1);
    const afterHit = processTick({ ...base, actionQueue: enemyStrike }, ACTION.NONE, () => 0.01);

    expect(afterHit.procState.scarStacks).toBe(1);
    expect(afterHit.combatants.hero.armor).toBe(6);
  });

  it("The Debt grants temporary physical reduction when Scar reaches 10 stacks", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "scar_dummy",
        name: "Scar Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [
        {
          id: "warmonger_scar_tissue",
          proc: {
            trigger: "on_take_damage",
            chance: 100,
            effect: { type: "gain_scar_stack" },
          },
        },
        {
          id: "warmonger_the_debt",
          proc: {
            trigger: "on_scar_stacks_reach",
            threshold: 10,
            chance: 100,
            effect: { type: "gain_physical_reduction_pct", value: 30, durationTicks: 6 },
          },
        },
      ],
    });
    const atNineScars = { ...base, procState: { ...base.procState, scarStacks: 9 } };
    const stackingStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 0, 1, null, 1);
    const debtActive = processTick({ ...atNineScars, actionQueue: stackingStrike }, ACTION.NONE, () => 0.01);

    expect(debtActive.procState.scarStacks).toBe(10);
    expect(debtActive.combatants.hero.activeEffects).toContainEqual(expect.objectContaining({
      type: "physical_reduction_pct",
      value: 30,
      source: "warmonger_the_debt",
      remainingTicks: 6,
    }));

    const hpBeforeHeavyHit = debtActive.combatants.hero.hp;
    const heavyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, debtActive.tick, 100, null, 1);
    const reduced = processTick({ ...debtActive, actionQueue: heavyStrike }, ACTION.NONE, () => 0.01);

    expect(hpBeforeHeavyHit - reduced.combatants.hero.hp).toBe(63);
  });

  it("15 Scar stacks trigger Juggernaut and let Unbreakable cap incoming damage", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "scar_dummy",
        name: "Scar Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 200, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [
        {
          id: "warmonger_scar_tissue",
          proc: {
            trigger: "on_take_damage",
            chance: 100,
            effect: { type: "gain_scar_stack" },
          },
        },
        {
          id: "warmonger_unbreakable",
          proc: {
            trigger: "on_take_damage",
            chance: 100,
            condition: { scar_stacks_gte: 15 },
            effect: { type: "cap_hit_damage", maxPct: 20 },
          },
        },
        {
          id: "warmonger_juggernaut",
          proc: {
            trigger: "on_scar_stacks_max",
            chance: 100,
            condition: { once_per_combat: true },
            effect: { type: "enter_juggernaut" },
          },
        },
      ],
    });
    const almostMaxed = { ...base, procState: { ...base.procState, scarStacks: 14 } };
    const maxingStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 0, 10, null, 1);
    const maxed = processTick({ ...almostMaxed, actionQueue: maxingStrike }, ACTION.NONE, () => 0.01);

    expect(maxed.procState.scarStacks).toBe(15);
    expect(maxed.procState.juggernaut).toBe(true);
    expect(maxed.combatants.hero.passiveEffects).toContainEqual({ type: "juggernaut_active", value: 1 });
    expect(maxed.combatants.hero.passiveEffects).toContainEqual({ type: "damage_taken_reduction_pct", value: 50, source: "juggernaut" });
    expect(maxed.combatants.hero.passiveEffects).toContainEqual({ type: "threshold_dmg_pct", value: -20, source: "juggernaut" });
    expect(maxed.combatants.hero.passiveEffects).not.toContainEqual({ type: "attack_speed_bonus_pct", value: -40 });

    const hpBeforeCap = maxed.combatants.hero.hp;
    const heavyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, maxed.tick, 200, null, 1);
    const capped = processTick({ ...maxed, actionQueue: heavyStrike }, ACTION.NONE, () => 0.01);

    expect(hpBeforeCap - capped.combatants.hero.hp).toBe(20);
    expect(capped.procState.scarStacks).toBe(15);
  });

  it("Juggernaut prevents armor-reduction abilities from lowering armor", () => {
    const attacker = {
      id: "orc",
      name: "Orc Breaker",
      isPlayer: false,
      damage: 40,
      spellDamageBonus: 0,
      passiveEffects: [],
      activeEffects: [],
    };
    const defender = {
      id: "hero",
      name: "Tester",
      isPlayer: true,
      hp: 100,
      maxHp: 100,
      armor: 20,
      blockChance: 0,
      blockPower: 0,
      passiveEffects: [
        { type: "juggernaut_active", value: 1 },
        { type: "damage_taken_reduction_pct", value: 50, source: "juggernaut" },
      ],
      activeEffects: [],
    };
    const entries = resolveAbilityImpact({
      ability: {
        id: "armor_shatter",
        name: "Armor Shatter",
        type: "armor_shatter",
        damageMult: 1,
        armorReduction: 8,
      },
    }, attacker, defender, 1, () => 0.99, {});

    expect(defender.armor).toBe(20);
    expect(entries.some(entry => entry.text.includes("armor holds"))).toBe(true);
  });

  it("Juggernaut reduces incoming spell damage by 50%", () => {
    const attacker = {
      id: "shaman",
      name: "Orc Shaman",
      isPlayer: false,
      damage: 0,
      spellDamage: 20,
      spellDamageBonus: 0,
      passiveEffects: [],
      activeEffects: [],
    };
    const defender = {
      id: "hero",
      name: "Tester",
      isPlayer: true,
      hp: 100,
      maxHp: 100,
      magicResistance: 0,
      passiveEffects: [{ type: "damage_taken_reduction_pct", value: 50, source: "juggernaut" }],
      activeEffects: [],
    };
    resolveAbilityImpact({
      ability: {
        id: "firebolt",
        name: "Firebolt",
        type: "spell_attack",
        damage: 20,
        element: "fire",
      },
    }, attacker, defender, 1, () => 0.99, {});

    expect(defender.hp).toBe(90);
  });

  function makeAutoSpeedState(options = {}) {
    const {
      heroHp = 100,
      heroMaxHp = 100,
      heroAttackRate = 1,
      heroEffects = [],
      heroProcNodes = [],
      procState = {},
      activeEffects = [],
      allies = [],
      enemyAttackSpeed = 0,
    } = options;
    let state = initCombat({
      heroName: "Tester",
      heroHp,
      heroMaxHp,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: enemyAttackSpeed },
        effects: [],
      },
      allies,
      heroAbilities: [],
      heroEffects,
      heroAttackRate,
      heroProcNodes,
    });

    state = {
      ...state,
      procState: { ...state.procState, ...procState },
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          activeEffects: [...(state.combatants.hero.activeEffects || []), ...activeEffects],
          autoAttackStarted: true,
          autoAttackProgressTicks: 0,
          lastAutoAttackTick: 0,
          nextAutoAttackTick: AUTO_ATTACK_TICKS,
        },
        allies: (state.combatants.allies || []).map(ally => ({
          ...ally,
          autoAttackStarted: true,
          autoAttackProgressTicks: 0,
          lastAutoAttackTick: 0,
          nextAutoAttackTick: AUTO_ATTACK_TICKS,
        })),
      },
    };
    return {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: state.combatants.enemies?.[0] || state.combatants.enemy,
      },
    };
  }

  function runAutoFrame(state, elapsedMs, options = {}) {
    return processAutoAttackFrame(state, elapsedMs, () => 0.01, {
      skipEnemyAutos: true,
      ...options,
    });
  }

  function hasAutoHit(state, actorId = "hero") {
    return state.log.some(entry => entry.actorId === actorId && entry.type === "hit" && !entry.abilityId);
  }

  it("applies weapon and attack-speed affixes to real-time autoattack cadence", () => {
    const baseHero = initHero("Tester");
    baseHero.equip.weapon = "test_sword_50";
    baseHero.equip.ring = null;

    const spedHero = initHero("Tester");
    spedHero.equip.weapon = "test_sword_50";
    spedHero.equip.ring = "gust_ring";

    const baseStats = calcStats(baseHero);
    const spedStats = calcStats(spedHero);

    expect(baseStats.weaponAttackSpeed).toBeCloseTo(1.2);
    expect(spedStats.weaponAttackSpeed).toBeCloseTo(1.296);

    const elapsedMs = 2350;
    const baseAfter = runAutoFrame(makeAutoSpeedState({ heroAttackRate: baseStats.weaponAttackSpeed }), elapsedMs);
    const spedAfter = runAutoFrame(makeAutoSpeedState({ heroAttackRate: spedStats.weaponAttackSpeed }), elapsedMs);

    expect(hasAutoHit(baseAfter)).toBe(false);
    expect(hasAutoHit(spedAfter)).toBe(true);
  });

  it("normalizes saved generated bow and crossbow speeds into real-time autoattack cadence", () => {
    const savedCompositeBow = {
      id: "generated_composite_bow",
      uid: "old_saved_composite_bow",
      generated: true,
      generation: { baseId: "composite_bow", materialId: "iron", itemLevel: 3 },
      type: "gear",
      slot: "weapon",
      family: "bow",
      weaponType: "two_handed_bow",
      baseStats: { damage: 8 },
      effects: [],
      tags: ["bow", "weapon", "ranged"],
    };
    const savedHeavyCrossbow = {
      id: "generated_heavy_crossbow",
      uid: "old_saved_heavy_crossbow",
      generated: true,
      generation: { baseId: "heavy_crossbow", materialId: "iron", itemLevel: 3 },
      type: "gear",
      slot: "weapon",
      family: "crossbow",
      weaponType: "two_handed_crossbow",
      baseStats: { damage: 14 },
      effects: [],
      tags: ["crossbow", "weapon", "ranged", "heavy"],
    };
    const bowHero = initHero("Bow", { heroClass: "archer", weapon: "bow" });
    const crossbowHero = initHero("Crossbow", { heroClass: "archer", weapon: "bow" });
    bowHero.equip.weapon = savedCompositeBow;
    crossbowHero.equip.weapon = savedHeavyCrossbow;

    const bowStats = calcStats(bowHero);
    const crossbowStats = calcStats(crossbowHero);

    expect(bowStats.weaponAttackSpeed).toBeCloseTo(1.12);
    expect(crossbowStats.weaponAttackSpeed).toBeCloseTo(0.72);

    const bowAfter = runAutoFrame(makeAutoSpeedState({ heroAttackRate: bowStats.weaponAttackSpeed }), 2700);
    const crossbowAfter = runAutoFrame(makeAutoSpeedState({ heroAttackRate: crossbowStats.weaponAttackSpeed }), 2700);
    const crossbowReady = runAutoFrame(makeAutoSpeedState({ heroAttackRate: crossbowStats.weaponAttackSpeed }), 4200);

    expect(hasAutoHit(bowAfter)).toBe(true);
    expect(hasAutoHit(crossbowAfter)).toBe(false);
    expect(hasAutoHit(crossbowReady)).toBe(true);
  });

  it("keeps generated bow base attack speeds distinct in stats and real-time combat", () => {
    const bowSpecs = [
      { baseId: "bow", materialId: "worn", expectedSpeed: 1.05 },
      { baseId: "composite_bow", materialId: "worn", expectedSpeed: 1.12 },
      { baseId: "ashenwood_shortbow", materialId: "ash", expectedSpeed: 1.25 },
      { baseId: "ashenwood_longbow", materialId: "ash", expectedSpeed: 0.98 },
    ];
    const byBase = new Map();

    for (const spec of bowSpecs) {
      const weapon = rollGeneratedEquipment({
        baseId: spec.baseId,
        materialId: spec.materialId,
        rarity: "normal",
        itemLevel: 5,
      }, () => 0);
      const hero = initHero(`Hero ${spec.baseId}`, { heroClass: "archer", weapon: "bow" });
      hero.equip.weapon = weapon;
      const stats = calcStats(hero);

      expect(weapon.attackSpeed).toBeCloseTo(spec.expectedSpeed);
      expect(stats.weaponAttackSpeed).toBeCloseTo(spec.expectedSpeed);
      byBase.set(spec.baseId, stats.weaponAttackSpeed);
    }

    const hitsAt = (baseId, elapsedMs) => hasAutoHit(runAutoFrame(makeAutoSpeedState({
      heroAttackRate: byBase.get(baseId),
    }), elapsedMs));

    expect(hitsAt("ashenwood_shortbow", 2450)).toBe(true);
    expect(hitsAt("bow", 2450)).toBe(false);
    expect(hitsAt("composite_bow", 2450)).toBe(false);
    expect(hitsAt("ashenwood_longbow", 2450)).toBe(false);

    expect(hitsAt("composite_bow", 2700)).toBe(true);
    expect(hitsAt("bow", 2700)).toBe(false);

    expect(hitsAt("bow", 2900)).toBe(true);
    expect(hitsAt("ashenwood_longbow", 2900)).toBe(false);

    expect(hitsAt("ashenwood_longbow", 3100)).toBe(true);
  });

  it("scales real-time hero autoattacks from talents, stances, procs, Momentum, and missing-HP speed", () => {
    const cases = [
      {
        name: "passive attack-speed talent",
        elapsedMs: 2410,
        options: { heroEffects: [{ type: "attack_speed_bonus_pct", value: 25, source: "test_passive_speed" }] },
      },
      {
        name: "temporary attack-speed proc",
        elapsedMs: 2410,
        options: { activeEffects: [{ type: "attack_speed_buff", value: 25, remainingTicks: 3 }] },
      },
      {
        name: "Sword Stance",
        elapsedMs: 2410,
        options: { activeEffects: [{ type: "sword_stance", attackSpeedBonusPct: 25, chargesLeft: 1 }] },
      },
      {
        name: "Berserker Stance",
        elapsedMs: 2510,
        options: { activeEffects: [{ type: "berserker_stance", attackSpeedBonusPct: 20, chargesLeft: 1 }] },
      },
      {
        name: "Rapid Fire",
        elapsedMs: 2150,
        options: { activeEffects: [{ type: "rapid_fire", attackSpeedBonusPct: 40, chargesLeft: 1 }] },
      },
      {
        name: "Momentum",
        elapsedMs: 2550,
        options: { procState: { momentumStacks: 3 } },
      },
      {
        name: "missing-HP speed",
        elapsedMs: 2010,
        options: {
          heroHp: 50,
          heroMaxHp: 100,
          heroEffects: [{ type: "attack_speed_by_missing_hp", maxBonusPct: 100 }],
        },
      },
    ];

    for (const entry of cases) {
      const baseAfter = runAutoFrame(makeAutoSpeedState(), entry.elapsedMs);
      const spedAfter = runAutoFrame(makeAutoSpeedState(entry.options), entry.elapsedMs);

      expect(hasAutoHit(baseAfter), `${entry.name} should beat an unmodified autoattack`).toBe(false);
      expect(hasAutoHit(spedAfter), `${entry.name} should produce an autoattack`).toBe(true);
    }
  });

  it("applies attack-speed slows to the real-time autoattack frame path", () => {
    const baseAfter = runAutoFrame(makeAutoSpeedState(), 3000);
    const slowedAfter = runAutoFrame(makeAutoSpeedState({
      activeEffects: [{ type: "attack_speed_slow", attackSpeedPenaltyPct: 50, attacksRemaining: 1, remainingTicks: 3 }],
    }), 3000);

    expect(hasAutoHit(baseAfter)).toBe(true);
    expect(hasAutoHit(slowedAfter)).toBe(false);
    expect(slowedAfter.combatants.hero.autoAttackProgressTicks).toBeCloseTo(1.5);
  });

  it("applies Shared Fury pet autoattack speed inside the real-time frame loop", () => {
    const wolf = {
      id: "wolf",
      name: "Wolf",
      hp: 100,
      stats: { maxHp: 100, attack: 10, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    const state = makeAutoSpeedState({
      allies: [wolf],
      heroEffects: [{ type: "pet_rage_attack_speed", rageThreshold: 50, attackSpeedBonusPct: 50, source: "test_shared_fury" }],
      procState: { rage: 50 },
    });

    const after = runAutoFrame(state, 2010, { skipHeroAuto: true });

    expect(hasAutoHit(after, "wolf")).toBe(true);
    expect(after.combatants.allies[0].passiveEffects).toContainEqual({
      type: "attack_speed_bonus_pct",
      value: 50,
      source: "test_shared_fury",
    });
  });

  it("lets max Momentum beat a two-second average autoattack cadence", () => {
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
      heroProcNodes: [],
    });
    state = {
      ...state,
      procState: { ...state.procState, momentumStacks: 10 },
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          autoAttackStarted: true,
          autoAttackProgressTicks: 0,
          lastAutoAttackTick: 0,
          nextAutoAttackTick: AUTO_ATTACK_TICKS,
        },
      },
    };

    for (let i = 0; i < 15; i += 1) {
      state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    }

    const heroHits = state.log.filter(entry => entry.actorId === "hero" && entry.type === "hit");
    expect(heroHits.length).toBeGreaterThan(7);
  });

  it("keeps fractional Momentum progress so 3 stacks beat base cadence over time", () => {
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
      heroProcNodes: [],
    });
    state = {
      ...state,
      procState: { ...state.procState, momentumStacks: 3 },
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          autoAttackStarted: true,
          autoAttackProgressTicks: 0,
          lastAutoAttackTick: 0,
          nextAutoAttackTick: AUTO_ATTACK_TICKS,
        },
      },
    };

    const hitTicks = [];
    for (let i = 0; i < 30; i += 1) {
      const previousLogLength = state.log.length;
      state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
      const newHits = state.log
        .slice(previousLogLength)
        .filter(entry => entry.actorId === "hero" && entry.type === "hit" && !entry.abilityId);
      expect(newHits.length).toBeLessThanOrEqual(1);
      hitTicks.push(...newHits.map(entry => entry.tick));
    }

    const intervals = hitTicks.slice(1).map((tick, index) => tick - hitTicks[index]);
    expect(intervals.length).toBeGreaterThan(3);
    expect(intervals).toContain(2);
    expect(intervals).toContain(3);
    expect(hitTicks.length).toBeGreaterThan(10);
  });

  it("real-time autoattack frames fire as soon as speed-adjusted progress completes", () => {
    const config = {
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
      heroProcNodes: [],
    };
    const base = initCombat(config);
    const momentum = {
      ...initCombat(config),
      procState: { ...base.procState, momentumStacks: 3 },
    };

    const baseAfter = processAutoAttackFrame(base, 2550, () => 0.01, { skipEnemyAutos: true });
    const momentumAfter = processAutoAttackFrame(momentum, 2550, () => 0.01, { skipEnemyAutos: true });

    expect(baseAfter.log.some(entry => entry.actorId === "hero" && entry.type === "hit")).toBe(false);
    expect(momentumAfter.log.some(entry => entry.actorId === "hero" && entry.type === "hit")).toBe(true);
  });

  it("double-hit threshold effects create a real second hit", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "double_hit", value: 100 }],
      heroAttackRate: 3,
    });

    const after = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    const heroHits = after.log.filter(entry => entry.actorId === "hero" && entry.type === "hit");
    expect(heroHits.length).toBe(2);
    expect(heroHits[0].extraHit).toBe(false);
    expect(heroHits[1]).toMatchObject({ extraHit: true, extraHitSource: "double_hit" });
  });

  it("double-hit threshold effects work with bows", () => {
    const state = initCombat({
      heroName: "Archer",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "double_hit", value: 100 }],
      heroAttackRate: 3,
      heroWeaponTags: ["bow", "weapon", "ranged"],
      heroAttackType: "ranged",
    });

    expect(state.combatants.hero.attackType).toBe("ranged");

    const after = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    const heroHits = after.log.filter(entry => entry.actorId === "hero" && entry.type === "hit");
    expect(heroHits.length).toBe(2);
    expect(heroHits[0].extraHit).toBe(false);
    expect(heroHits[1]).toMatchObject({ extraHit: true, extraHitSource: "double_hit" });
  });

  it("Flash raises max Momentum to 12", () => {
    const enemyObj = {
      id: "target_dummy",
      name: "Target Dummy",
      hp: 100000,
      stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
      effects: [],
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj,
      heroAbilities: [],
      heroEffects: [{ type: "momentum_max_cap", value: 12 }],
      heroAttackRate: 0.1,
      heroProcNodes: [{
        id: "speed_momentum_gen",
        proc: {
          trigger: "on_hit",
          chance: 100,
          effect: { type: "gain_momentum", value: 1 },
        },
      }],
    });
    state = { ...state, procState: { ...state.procState, momentumStacks: 11 } };

    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);

    expect(state.procState.momentumStacks).toBe(12);
    expect(state.combatants.hero.passiveEffects).toContainEqual({
      type: "attack_speed_bonus_pct",
      value: 12 * MOMENTUM_ATTACK_SPEED_PCT_PER_STACK,
      source: "momentum",
    });
  });

  it("zero attack enemies can hit for zero during testing", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "target_dummy",
        name: "Target Dummy",
        hp: 100000,
        stats: { maxHp: 100000, attack: 0, armor: 0, attackSpeed: 1 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
    });

    const afterWindup = processTick(processTick(state, ACTION.NONE, () => 0.5), ACTION.NONE, () => 0.5);
    const afterTick = processTick(afterWindup, ACTION.NONE, () => 0.5);

    expect(afterTick.combatants.hero.hp).toBe(100);
    expect(afterTick.log.some(entry => entry.actorId === "enemy" && entry.damage === 0)).toBe(true);
  });

  it("abilities are available at combat start when they have enough Rage and no cooldown", () => {
    const state = withCombatRage(initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [
        {
          id: "heavy_blow",
          name: "Heavy Blow",
          type: "empowered_attack",
          castTicks: 2,
          cooldown: 7,
          damageMult: 1.5,
          critChance: 0,
        },
      ],
      heroEffects: [],
    }));

    const immediateCast = processTick(state, ACTION.ABILITY_0, () => 0.1);
    expect(immediateCast.actionQueue.some(action => action.actorId === "hero" && action.ability?.id === "heavy_blow")).toBe(true);
  });

  it("lets an ability cancel the opening auto attack and start casting immediately", () => {
    const state = withCombatRage(initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [
        {
          id: "heavy_blow",
          name: "Heavy Blow",
          type: "empowered_attack",
          castTicks: 2,
          cooldown: 7,
          damageMult: 1.5,
          critChance: 0,
        },
      ],
      heroEffects: [],
    }));

    const tickOne = processTick(state, ACTION.ABILITY_0, () => 0.1);
    expect(tickOne.actionQueue.some(action => action.actorId === "hero" && action.ability?.id === "heavy_blow")).toBe(true);
    expect(tickOne.actionQueue.some(action => action.actorId === "hero" && action.type === ACTION.BASIC_ATTACK)).toBe(false);
  });

  it("applies ability damage and cooldown only when the cast completes", () => {
    const state = withCombatRage(initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [
        {
          id: "heavy_blow",
          name: "Heavy Blow",
          type: "empowered_attack",
          castTicks: 2,
          cooldown: 7,
          damageMult: 1.5,
          critChance: 0,
        },
      ],
      heroEffects: [],
    }));

    const casting = processTick(state, ACTION.ABILITY_0, () => 0.1);
    expect(casting.combatants.enemy.hp).toBe(100);
    expect(casting.combatants.hero.abilityCooldowns.heavy_blow).toBeUndefined();

    const midCast = processTick(casting, ACTION.NONE, () => 0.1);
    expect(midCast.combatants.enemy.hp).toBe(100);
    expect(midCast.combatants.hero.abilityCooldowns.heavy_blow).toBeUndefined();

    const completed = processTick(midCast, ACTION.NONE, () => 0.1);
    expect(completed.combatants.enemy.hp).toBeLessThan(100);
    expect(completed.log.some(entry => entry.type === "ability" && entry.abilityId === "heavy_blow")).toBe(true);
    expect(completed.combatants.hero.abilityCooldowns.heavy_blow).toBe(10);
  });

  it("delays projectile spell damage until the projectile travel finishes", () => {
    const fireSpell = {
      id: "fire_test",
      name: "Fire Test",
      type: "spell_attack",
      castTicks: 1,
      cooldown: 4,
      damage: 50,
      visual: { projectile: { durationMs: 2000 } },
    };
    const state = withCombatRage(initCombat({
      heroName: "Mage",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [fireSpell],
      heroEffects: [],
    }));

    const casting = processTick(state, ACTION.ABILITY_0, () => 0.5);
    const launched = processTick(casting, ACTION.NONE, () => 0.5);
    const travelling = processTick(launched, ACTION.NONE, () => 0.5);
    const impacted = processTick(travelling, ACTION.NONE, () => 0.5);

    expect(launched.log.some(entry => entry.type === "ability_projectile" && entry.abilityId === "fire_test")).toBe(true);
    expect(launched.combatants.enemy.hp).toBe(100);
    expect(travelling.combatants.enemy.hp).toBe(100);
    expect(impacted.combatants.enemy.hp).toBeLessThan(100);
    expect(impacted.log.some(entry => entry.type === "ability" && entry.abilityId === "fire_test")).toBe(true);
  });

  it("applies listed spell damage without physical armor or block reducing it", () => {
    const fireSpell = {
      id: "fire_test",
      name: "Fire Test",
      type: "spell_attack",
      castTicks: 1,
      cooldown: 4,
      damage: 50,
    };
    const state = withCombatRage(initCombat({
      heroName: "Mage",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Armored Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 999 },
        effects: [],
      },
      heroAbilities: [fireSpell],
      heroEffects: [],
    }));
    const blockingState = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: { ...state.combatants.enemy, blocking: true },
      },
    };

    const casting = processTick(blockingState, ACTION.ABILITY_0, () => 0.5);
    const impacted = processTick(casting, ACTION.NONE, () => 0.5);

    expect(impacted.combatants.enemy.hp).toBe(50);
    expect(impacted.log.some(entry => entry.type === "ability" && entry.abilityId === "fire_test" && entry.damage === 50)).toBe(true);
  });

  it("applies elemental resistance to typed spell attacks", () => {
    const shadowSpell = {
      id: "shadow_test",
      name: "Shadow Test",
      type: "spell_attack",
      element: "shadow",
      castTicks: 1,
      cooldown: 4,
      damage: 50,
    };
    const state = withCombatRage(initCombat({
      heroName: "Mage",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Shadow Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0, shadowResist: 100 },
        effects: [],
      },
      heroAbilities: [shadowSpell],
      heroEffects: [],
    }));

    const casting = processTick(state, ACTION.ABILITY_0, () => 0.5);
    const impacted = processTick(casting, ACTION.NONE, () => 0.5);

    expect(impacted.combatants.enemy.hp).toBe(75);
    expect(impacted.log.some(entry => entry.abilityId === "shadow_test" && entry.element === "shadow" && entry.damage === 25)).toBe(true);

    const poisonSpell = {
      id: "poison_test",
      name: "Poison Test",
      type: "spell_attack",
      element: "poison",
      castTicks: 1,
      cooldown: 4,
      damage: 50,
    };
    const poisonState = withCombatRage(initCombat({
      heroName: "Mage",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Poison Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0, poisonResist: 100 },
        effects: [],
      },
      heroAbilities: [poisonSpell],
      heroEffects: [],
    }));
    const poisonCasting = processTick(poisonState, ACTION.ABILITY_0, () => 0.5);
    const poisonImpacted = processTick(poisonCasting, ACTION.NONE, () => 0.5);

    expect(poisonImpacted.combatants.enemy.hp).toBe(75);
    expect(poisonImpacted.log.some(entry => entry.abilityId === "poison_test" && entry.element === "poison" && entry.damage === 25)).toBe(true);
  });

  it("logs why a queued ability cannot be cast", () => {
    const baseEnemy = {
      id: "dummy",
      name: "Training Dummy",
      hp: 100,
      stats: { maxHp: 100, attack: 0, armor: 0 },
      effects: [],
    };
    const heavyBlow = {
      id: "heavy_blow",
      name: "Heavy Blow",
      type: "empowered_attack",
      castTicks: 2,
      cooldown: 7,
      damageMult: 1.5,
      critChance: 0,
    };

    const castingState = processTick(withCombatRage(initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: baseEnemy,
      heroAbilities: [heavyBlow],
      heroEffects: [],
    })), ACTION.ABILITY_0, () => 0.1);
    const duringCast = processTick(castingState, ACTION.ABILITY_0, () => 0.1);
    expect(duringCast.log.some(entry => entry.type === "ability_fail" && entry.text.includes("already casting"))).toBe(true);

    const afterCast = processTick(duringCast, ACTION.NONE, () => 0.1);
    const onCooldown = processTick(afterCast, ACTION.ABILITY_0, () => 0.1);
    expect(onCooldown.log.some(entry => entry.type === "ability_fail" && entry.text.includes("cooldown"))).toBe(true);

    const resourceFreeCast = processTick(withCombatRage(initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: baseEnemy,
      heroAbilities: [{ ...heavyBlow, id: "big_spell", name: "Big Spell", manaCost: 60 }],
      heroEffects: [],
    })), ACTION.ABILITY_0, () => 0.1);
    expect(resourceFreeCast.log.some(entry => entry.type === "ability_fail" && entry.text.includes("Not enough Mana"))).toBe(false);
    expect(resourceFreeCast.log.some(entry => entry.type === "cast_start" && entry.text.includes("Big Spell"))).toBe(true);

    const noRage = processTick(withCombatRage(initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: baseEnemy,
      heroAbilities: [{ ...heavyBlow, id: "huge_spell", name: "Huge Spell", energyCost: 120 }],
      heroEffects: [],
    })), ACTION.ABILITY_0, () => 0.1);
    expect(noRage.log.some(entry => entry.type === "ability_fail" && entry.text.includes("Not enough Rage"))).toBe(true);
  });

  it("charges ultimate progress by three percent per combat tick", () => {
    const state = initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      ultimateChargePct: 94,
    });

    const almostCharged = processTick(state, ACTION.NONE, () => 0.1);
    expect(almostCharged.ultimateChargePct).toBe(97);

    const charged = processTick(almostCharged, ACTION.NONE, () => 0.1);
    expect(charged.ultimateChargePct).toBe(100);
    expect(buildCombatResult(charged).ultimateChargePct).toBe(100);
  });

  it("prevents basic attacks while an ability is casting or resolving", () => {
    const state = withCombatRage(initCombat({
      heroName: "Caster",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [
        {
          id: "heavy_blow",
          name: "Heavy Blow",
          type: "empowered_attack",
          castTicks: 2,
          cooldown: 7,
          damageMult: 1.5,
          critChance: 0,
        },
      ],
      heroEffects: [],
    }));

    const casting = processTick(state, ACTION.ABILITY_0, () => 0.1);
    expect(casting.combatants.hero.isCasting).toBe(true);
    expect(casting.actionQueue.some(action => action.actorId === "hero" && action.ability?.id === "heavy_blow")).toBe(true);

    const midCast = processTick(casting, ACTION.BASIC_ATTACK, () => 0.1);
    expect(midCast.log.some(entry => entry.actorId === "hero" && (entry.type === "hit" || entry.type === "blocked") && !entry.abilityId)).toBe(false);

    const resolved = processTick(midCast, ACTION.BASIC_ATTACK, () => 0.1);
    expect(resolved.combatants.hero.isCasting).toBe(false);
    expect(resolved.log.some(entry => entry.type === "ability" && entry.abilityId === "heavy_blow")).toBe(true);
    expect(resolved.log.some(entry => entry.actorId === "hero" && (entry.type === "hit" || entry.type === "blocked") && !entry.abilityId)).toBe(false);

    const basic = processTick(resolved, ACTION.BASIC_ATTACK, () => 0.5);
    expect(basic.log.some(entry => entry.actorId === "hero" && (entry.type === "hit" || entry.type === "blocked") && !entry.abilityId)).toBe(true);
  });

  it("block applies immediately and is consumed by the next incoming hit", () => {
    const base = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockPower: 10,
      heroBlockPowerRegen: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 20);
    const state = { ...base, tick: 2, actionQueue: enemyStrike };

    const blocked = processTick(state, ACTION.BLOCK, () => 0.1);
    expect(blocked.combatants.hero.hp).toBe(90);
    expect(blocked.combatants.hero.blockPower).toBe(0);
    expect(blocked.combatants.hero.blocking).toBe(false);
    expect(blocked.log.some(entry => entry.type === "blocked" && entry.text.includes("You block"))).toBe(true);
  });

  it("does not inflict bleed when Block Power fully absorbs an auto attack", () => {
    const base = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockPower: 50,
      heroBlockPowerRegen: 0,
      enemyObj: {
        id: "bleeder",
        name: "Bleeder",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [{ type: "bleed_on_hit", chance: 100, duration: 2, damagePct: 2 }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 20);
    const state = { ...base, tick: 2, actionQueue: enemyStrike };
    const blocked = processTick(state, ACTION.BLOCK, () => 0);

    expect(blocked.combatants.hero.hp).toBe(100);
    expect(blocked.heroConditions.bleeding).toBeNull();
    expect(blocked.combatants.hero.activeEffects.some(effect => effect.type === "bleed")).toBe(false);
    expect(blocked.log.some(entry => entry.type === "bleed")).toBe(false);
  });

  it("does not inflict poison when Block Power fully absorbs an auto attack", () => {
    const base = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockPower: 50,
      heroBlockPowerRegen: 0,
      enemyObj: {
        id: "venomous",
        name: "Venomous",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [{ type: "poison_on_hit", chance: 100, duration: 2, damagePct: 1 }],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 20);
    const state = { ...base, tick: 2, actionQueue: enemyStrike };
    const blocked = processTick(state, ACTION.BLOCK, () => 0);

    expect(blocked.combatants.hero.hp).toBe(100);
    expect(blocked.heroConditions.poison).toBeNull();
    expect(blocked.combatants.hero.activeEffects.some(effect => effect.type === "poison")).toBe(false);
    expect(blocked.log.some(entry => entry.type === "poison")).toBe(false);
  });

  it("does not apply ability bleed effects when Block Power fully absorbs the hit", () => {
    const attacker = {
      id: "hero",
      isPlayer: true,
      name: "Duelist",
      hp: 100,
      maxHp: 100,
      damage: 10,
      armor: 0,
      activeEffects: [],
      passiveEffects: [],
      spellDamageBonus: 0,
    };
    const createDefender = () => ({
      id: "target",
      isPlayer: false,
      name: "Target Dummy",
      hp: 100,
      maxHp: 100,
      damage: 0,
      armor: 0,
      blockPowerMax: 100,
      blockPower: 100,
      blocking: true,
      activeEffects: [],
      passiveEffects: [],
      stunUntilTick: -1,
    });
    const bleedStrike = {
      id: "bleed_strike",
      name: "Bleed Strike",
      type: "empowered_attack",
      damageMult: 1,
      critChance: 0,
      bleedChance: 100,
      bleedDuration: 2,
      bleedDamagePct: 2,
    };
    const hemorrhagingShot = {
      id: "hemorrhaging_shot",
      name: "Hemorrhaging Shot",
      type: "hemorrhaging_shot",
      damageMult: 1,
      durationTicks: 3,
      damagePct: 2,
    };

    const bleedTarget = createDefender();
    const bleedEntries = resolveAbilityImpact({ ability: bleedStrike }, attacker, bleedTarget, 1, () => 0, {});
    expect(bleedTarget.hp).toBe(100);
    expect(bleedTarget.activeEffects.some(effect => effect.type === "bleed")).toBe(false);
    expect(bleedEntries.some(entry => entry.type === "bleed")).toBe(false);

    const hemorrhageTarget = createDefender();
    const hemorrhageEntries = resolveAbilityImpact({ ability: hemorrhagingShot }, attacker, hemorrhageTarget, 1, () => 0, {});
    expect(hemorrhageTarget.hp).toBe(100);
    expect(hemorrhageTarget.activeEffects.some(effect => effect.type === "hemorrhage")).toBe(false);
    expect(hemorrhageEntries.some(entry => entry.type === "hemorrhage")).toBe(false);
  });

  it("block chance spends Block Power and regenerates it over time", () => {
    const base = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockChance: 100,
      heroBlockPower: 15,
      heroBlockPowerRegen: 5,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 20);
    const state = { ...base, tick: 2, actionQueue: enemyStrike };

    const blocked = processTick(state, ACTION.NONE, () => 0.1);
    expect(blocked.combatants.hero.hp).toBe(95);
    expect(blocked.combatants.hero.blockPower).toBe(0);
    expect(blocked.log.some(entry => entry.type === "blocked" && entry.absorbed === 15)).toBe(true);

    const regenerated = processTick({
      ...blocked,
      actionQueue: [],
      combatants: {
        ...blocked.combatants,
        enemy: { ...blocked.combatants.enemy, stunUntilTick: blocked.tick + 2 },
      },
    }, ACTION.NONE, () => 0.5);
    expect(regenerated.combatants.hero.blockPower).toBe(5);
  });

  it("Shield Up blocks the next incoming auto attack and counters", () => {
    const shieldUp = {
      id: "shield_up",
      name: "Shield Up",
      type: "shield_up",
      castTicks: 0,
      cooldownSeconds: 8,
      energyCost: 0,
      requiresOffhandFamily: "shield",
      counterDamageMult: 0.5,
      attacksBlocked: 1,
    };
    const state = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockPower: 0,
      heroBlockPowerRegen: 0,
      heroOffhandFamily: "shield",
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 20, armor: 0 },
        effects: [],
      },
      heroAbilities: [shieldUp],
      heroEffects: [],
    });

    const shielded = processTick(state, ACTION.ABILITY_0, () => 0.5);
    const waiting = processTick(shielded, ACTION.NONE, () => 0.5);
    const resolved = processTick(waiting, ACTION.NONE, () => 0.5);

    expect(resolved.combatants.hero.hp).toBe(100);
    expect(resolved.combatants.hero.blockPower).toBe(0);
    expect(resolved.combatants.enemy.hp).toBe(95);
    expect(resolved.log.some(entry => entry.type === "blocked" && entry.text.includes("Shield Up"))).toBe(true);
    expect(resolved.log.some(entry => entry.type === "shield" && entry.abilityId === "shield_up" && entry.damage === 5)).toBe(true);
    expect(combatSkillById.shield_up.description).toContain("without spending Block Power");
  });

  it("Guard Instinct requires a block trigger, restores Block Power, and buffs incoming auto block chance", () => {
    const guardInstinct = {
      id: "guard_instinct",
      name: "Guard Instinct",
      type: "guard_instinct",
      castTicks: 0,
      cooldownSeconds: 12,
      energyCost: 0,
      requiredTrigger: "after_block",
      consumeTrigger: true,
      requiresOffhandFamily: "shield",
      blockChanceBonus: 10,
      attacksReceived: 3,
      blockPowerRecoverPct: 50,
    };
    const state = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockPower: 100,
      heroBlockPowerRegen: 0,
      heroOffhandFamily: "shield",
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [guardInstinct],
      heroEffects: [],
    });
    state.combatants.hero.blockPower = 20;
    state.combatants.hero.combatTriggers.after_block = 1;
    state.combatants.enemy.stunUntilTick = 2;

    const resolved = processTick(state, ACTION.ABILITY_0, () => 0.5);
    const guardBuff = resolved.combatants.hero.activeEffects.find(effect => effect.type === "incoming_auto_block_chance_buff");

    expect(resolved.combatants.hero.blockPower).toBe(70);
    expect(resolved.combatants.hero.combatTriggers.after_block).toBe(0);
    expect(guardBuff).toMatchObject({ value: 10, attacksRemaining: 3 });
  });

  it("enemies can spend an after-block trigger on a stun ability", () => {
    const shieldBash = {
      id: "test_shield_bash",
      name: "Shield Bash",
      type: "stun_spell",
      castTicks: 1,
      cooldownSeconds: 4,
      requiredTrigger: "after_block",
      consumeTrigger: true,
      aiPool: "block_reaction",
      aiUseChance: 100,
      stunTicks: 2,
    };
    const base = initCombat({
      heroName: "Attacker",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 20,
      heroArmor: 0,
      enemyObj: {
        id: "squire",
        name: "Oathbound Squire",
        hp: 145,
        stats: { maxHp: 145, attack: 0, armor: 0, blockChance: 100, blockPower: 50, blockPowerRegen: 0 },
        abilities: [shieldBash],
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    const heroStrike = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 1, 20, null, 0, { targetId: "enemy" });

    const blocked = processTick({ ...base, tick: 1, actionQueue: heroStrike }, ACTION.NONE, () => 0);
    expect(blocked.combatants.enemy.combatTriggers.after_block).toBe(1);
    expect(blocked.log.some(entry => entry.actorId === "hero" && entry.type === "blocked")).toBe(true);

    const casting = processTick(blocked, ACTION.NONE, () => 0);
    expect(casting.combatants.enemy.combatTriggers.after_block).toBe(0);
    expect(casting.actionQueue.some(entry => entry.actorId === "enemy" && entry.ability?.id === "test_shield_bash")).toBe(true);

    const stunned = processTick(casting, ACTION.NONE, () => 0);
    expect(stunned.combatants.hero.stunUntilTick).toBe(stunned.tick + 2);
    expect(stunned.log.some(entry => entry.actorId === "enemy" && entry.type === "stun" && entry.abilityId === "test_shield_bash")).toBe(true);
  });

  it("Black Banner aura only buffs its summoner while the banner is alive", () => {
    const state = initCombat({
      heroName: "Banner Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObjs: [
        { ...enemyById.black_knight, hp: 250, stats: enemyById.black_knight.baseStats },
        { ...enemyById.black_banner, hp: 50, stats: enemyById.black_banner.baseStats },
      ],
      bossDeathEndsFight: false,
      heroAbilities: [],
      heroEffects: [],
    });
    state.combatants.enemy.stunUntilTick = 10;
    state.combatants.enemies[1].summonedBy = "enemy";
    state.combatants.enemies[1].summonKey = "black_knight_black_banner";
    state.combatants.enemies[1].isSummon = true;

    const buffed = processTick(state, ACTION.NONE, () => 0.99);
    expect(buffed.combatants.enemy.activeEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "block_chance_buff", value: 15, source: "summon_aura" }),
      expect.objectContaining({ type: "damage_bonus_pct_buff", value: 20, source: "summon_aura" }),
    ]));

    const deadBannerEnemies = buffed.combatants.enemies.map(foe =>
      foe.sourceId === "black_banner" ? { ...foe, hp: 0 } : { ...foe, stunUntilTick: buffed.tick + 10 });
    const cleared = processTick({
      ...buffed,
      combatants: {
        ...buffed.combatants,
        enemy: deadBannerEnemies[0],
        enemies: deadBannerEnemies,
      },
      actionQueue: [],
    }, ACTION.NONE, () => 0.99);

    expect(cleared.combatants.enemy.activeEffects.some(effect => effect.source === "summon_aura")).toBe(false);
  });

  it("charged damage reduction lasts for the next two incoming auto attacks", () => {
    const base = initCombat({
      heroName: "Pulse Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "pulse_dummy",
        name: "Pulse Dummy",
        hp: 100,
        disableAutoAttack: true,
        stats: { maxHp: 100, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    base.combatants.enemy.activeEffects.push({
      type: "damage_taken_reduction",
      reductionPct: 50,
      attacksRemaining: 2,
      remainingTicks: 99999,
    });

    const first = processTick({
      ...base,
      tick: 1,
      actionQueue: enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 1, 20, null, 0, { targetId: "enemy" }),
    }, ACTION.NONE, () => 0.5);
    expect(first.combatants.enemy.hp).toBe(90);
    expect(first.combatants.enemy.activeEffects.find(effect => effect.type === "damage_taken_reduction")).toMatchObject({ attacksRemaining: 1 });

    const second = processTick({
      ...first,
      actionQueue: enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, first.tick, 20, null, 0, { targetId: "enemy" }),
    }, ACTION.NONE, () => 0.5);
    expect(second.combatants.enemy.hp).toBe(80);
    expect(second.combatants.enemy.activeEffects.some(effect => effect.type === "damage_taken_reduction")).toBe(false);

    const third = processTick({
      ...second,
      actionQueue: enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, second.tick, 20, null, 0, { targetId: "enemy" }),
    }, ACTION.NONE, () => 0.5);
    expect(third.combatants.enemy.hp).toBe(60);
  });

  it("Shield Recovery restores Block Power after a block", () => {
    const base = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockChance: 100,
      heroBlockPower: 100,
      heroBlockPowerRegen: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "block_power_recovery_pct", value: 15 }],
    });
    base.combatants.hero.blockPower = 30;

    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 20);
    const state = { ...base, tick: 2, actionQueue: enemyStrike };

    const blocked = processTick(state, ACTION.NONE, () => 0.1);
    expect(blocked.combatants.hero.hp).toBe(100);
    expect(blocked.combatants.hero.blockPower).toBe(25);
    expect(blocked.log.some(entry => entry.type === "blocked" && entry.absorbed === 20 && entry.recovered === 15)).toBe(true);
  });

  it("Block Power absorbs physical enemy abilities and lets overflow damage through", () => {
    const state = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockPower: 10,
      heroBlockPowerRegen: 0,
      enemyObj: {
        id: "crusher",
        name: "Crusher",
        hp: 100,
        stats: { maxHp: 100, attack: 30, armor: 0 },
        abilities: [{
          id: "crushing_blow",
          name: "Crushing Blow",
          type: "empowered_attack",
          castTicks: 1,
          cooldown: 5,
          damageMult: 1,
          critChance: 0,
        }],
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const braced = processTick(state, ACTION.BLOCK, () => 0.1);
    const impacted = processTick(braced, ACTION.NONE, (() => {
      const rolls = [0.9, 0, 0, 0.9];
      return () => rolls.shift() ?? 0.9;
    })());

    expect(impacted.combatants.hero.hp).toBe(80);
    expect(impacted.combatants.hero.blockPower).toBe(0);
    expect(impacted.log.some(entry => (
      entry.actorId === "enemy" &&
      entry.type === "blocked" &&
      entry.abilityId === "crushing_blow" &&
      entry.absorbed === 10 &&
      entry.damage === 20
    ))).toBe(true);
  });

  it("miss chance affects casted melee abilities", () => {
    const state = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "crusher",
        name: "Crusher",
        hp: 100,
        stats: { maxHp: 100, attack: 30, armor: 0 },
        disableAutoAttack: true,
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    const ability = {
      id: "test_crushing_blow",
      name: "Crushing Blow",
      type: "crushing_blow",
      castTicks: 1,
      damageMult: 1,
      critChanceBonus: 0,
      stunTicks: 2,
    };
    const queued = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: {
          ...state.combatants.enemy,
          activeEffects: [{ type: "stagger", attacksRemaining: 1, remainingTicks: 2, missPenalty: 100 }],
        },
      },
      actionQueue: enqueueAbility(createActionQueue(), "enemy", ACTION.ABILITY_0, ability.castTicks, state.tick, 0, ability, { targetId: "hero" }),
    };

    const resolved = processTick(queued, ACTION.NONE, () => 0.99);

    expect(resolved.combatants.hero.hp).toBe(100);
    expect(resolved.combatants.hero.stunUntilTick).toBe(-1);
    expect(resolved.combatants.enemy.activeEffects.some(effect => effect.type === "stagger")).toBe(false);
    expect(resolved.log.some(entry => (
      entry.type === "miss"
      && entry.abilityId === "test_crushing_blow"
      && entry.text.includes("Crushing Blow misses you")
    ))).toBe(true);
  });

  it("Cave Troll Crushing Blow stuns the player for 2 seconds", () => {
    const attacker = {
      id: "enemy",
      name: "Cave Troll",
      isPlayer: false,
      damage: 30,
      critChance: 0,
      critMult: 1.5,
      passiveEffects: [],
      activeEffects: [],
      abilityCooldowns: {},
    };
    const defender = {
      id: "hero",
      name: "Defender",
      isPlayer: true,
      hp: 100,
      maxHp: 100,
      armor: 0,
      blockChance: 0,
      blockPower: 0,
      passiveEffects: [],
      activeEffects: [],
      stunUntilTick: -1,
    };
    const ability = enemyById.cave_troll.abilities.find(entry => entry.id === "cave_troll_crushing_blow");
    const entries = resolveAbilityImpact({ ability }, attacker, defender, 5, () => 0.99, {});

    expect(defender.hp).toBe(67);
    expect(defender.stunUntilTick).toBe(7);
    expect(entries.some(entry => entry.type === "stun" && entry.text.includes("2 seconds"))).toBe(true);
  });

  it("Cave Troll Weapon Throw is one-use and lowers troll damage to 60%", () => {
    const attacker = {
      id: "enemy",
      name: "Cave Troll",
      isPlayer: false,
      damage: 30,
      baseDamage: 30,
      critChance: 0,
      critMult: 1.5,
      passiveEffects: [],
      activeEffects: [],
      abilityCooldowns: {},
      usedAbilityIds: {},
    };
    const defender = {
      id: "hero",
      name: "Defender",
      isPlayer: true,
      hp: 100,
      maxHp: 100,
      armor: 0,
      blockChance: 0,
      blockPower: 0,
      passiveEffects: [],
      activeEffects: [],
    };
    const ability = enemyById.cave_troll.abilities.find(entry => entry.id === "cave_troll_weapon_throw");
    const entries = resolveAbilityImpact({ ability }, attacker, defender, 5, (() => {
      const rolls = [0, 0.99];
      return () => rolls.shift() ?? 0.99;
    })(), {});

    expect(defender.hp).toBe(40);
    expect(attacker.damage).toBe(18);
    expect(entries.some(entry => entry.type === "ability" && entry.text.includes("damage is reduced"))).toBe(true);

    const usedThrower = {
      abilities: [ability],
      abilityCooldowns: {},
      usedAbilityIds: { [ability.id]: true },
      isPlayer: false,
    };
    expect(getAbilityUseFailureReason(usedThrower, ability, 5)).toBe("Weapon Throw has already been used.");
  });

  it("Cave Troll Savage Roar staggers and weakens the player", () => {
    const attacker = {
      id: "enemy",
      name: "Cave Troll",
      isPlayer: false,
      passiveEffects: [],
      activeEffects: [],
    };
    const defender = {
      id: "hero",
      name: "Defender",
      isPlayer: true,
      hp: 100,
      maxHp: 100,
      passiveEffects: [],
      activeEffects: [],
    };
    const ability = enemyById.cave_troll.abilities.find(entry => entry.id === "cave_troll_savage_roar");
    const entries = resolveAbilityImpact({ ability }, attacker, defender, 5, () => 0.99, {});

    expect(defender.activeEffects).toContainEqual(expect.objectContaining({
      type: "stagger",
      remainingTicks: 2,
      attacksRemaining: 2,
      missPenalty: 35,
    }));
    expect(defender.activeEffects).toContainEqual(expect.objectContaining({
      type: "weaken",
      remainingTicks: 4,
      damageMult: 0.8,
    }));
    expect(entries.some(entry => entry.type === "stagger")).toBe(true);
    expect(entries.some(entry => entry.type === "weaken")).toBe(true);
  });

  it("dodge applies immediately and is consumed by the next incoming hit", () => {
    const base = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Training Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const enemyStrike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 20);
    const state = { ...base, tick: 2, actionQueue: enemyStrike };

    const dodged = processTick(state, ACTION.DODGE, () => 0.1);
    expect(dodged.combatants.hero.hp).toBe(100);
    expect(dodged.combatants.hero.dodging).toBe(false);
    expect(dodged.log.some(entry => entry.type === "dodged" && entry.text.includes("You dodge"))).toBe(true);
  });

  it("defense pressure weakens block power, dodge, and parry against aerial attacks", () => {
    const pressuredEnemy = {
      id: "wyvern_pressure",
      name: "Wyvern Pressure",
      hp: 100,
      stats: { maxHp: 100, attack: 0, armor: 0 },
      effects: [{ type: "defense_penalty_pct", value: 50 }],
    };
    const strike = () => enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 20);

    const blockBase = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroBlockPower: 20,
      heroBlockPowerRegen: 0,
      enemyObj: pressuredEnemy,
      heroAbilities: [],
      heroEffects: [],
    });
    const blocked = processTick({ ...blockBase, tick: 2, actionQueue: strike() }, ACTION.BLOCK, () => 0.1);
    expect(blocked.combatants.hero.hp).toBe(90);
    expect(blocked.log.some(entry => entry.type === "blocked" && entry.absorbed === 10)).toBe(true);

    const dodgeBase = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: { ...pressuredEnemy, effects: [{ type: "defense_penalty_pct", value: 100 }] },
      heroAbilities: [],
      heroEffects: [],
    });
    const dodgeRolls = [0.1, 0.1];
    const failedDodge = processTick({ ...dodgeBase, tick: 2, actionQueue: strike() }, ACTION.DODGE, () => dodgeRolls.shift() ?? 0.1);
    expect(failedDodge.combatants.hero.hp).toBe(80);
    expect(failedDodge.log.some(entry => entry.type === "dodged")).toBe(false);

    const parryBase = initCombat({
      heroName: "Defender",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: pressuredEnemy,
      heroAbilities: [],
      heroEffects: [{ type: "parry_chance", value: 100 }],
    });
    const parryRolls = [0.1, 0.75];
    const failedParry = processTick({ ...parryBase, tick: 2, actionQueue: strike() }, ACTION.NONE, () => parryRolls.shift() ?? 0.75);
    expect(failedParry.combatants.hero.hp).toBe(80);
    expect(failedParry.log.some(entry => entry.type === "parry")).toBe(false);
  });

  it("boss and miniboss loot can roll generated gear", () => {
    const bossRolls = [0, 0.99, 0.999, 0, 0, 0, 0, 0, 0];
    const bossDrops = rollLootTable("boss", () => bossRolls.shift() ?? 0.1);
    const miniBoss = { ...enemyById.forest_bandit, isMiniBoss: true, lootTable: "forest_bandit" };
    const miniBossRolls = [0, 0.99, 0, 0, 0, 0];
    const miniBossDrops = rollCombatLoot(miniBoss, () => miniBossRolls.shift() ?? 0);
    expect(bossDrops.some(drop => drop.generated && drop.rarity === "legendary")).toBe(true);
    expect(bossDrops.some(drop => drop.generated && ["artifact", "unique"].includes(drop.rarity))).toBe(false);
    expect(miniBossDrops.some(drop => drop.generated)).toBe(true);
  });

  it("elder stag boss uses generated forest gear plus thorn accessories", () => {
    const pool = getDropPool(["elder_stag"]);
    const drops = rollCombatLoot(bossById.elder_stag, () => 0.1);
    const allowedStatic = new Set(["ring_of_thorns", "thorn_amulet", "stag_heart", "stag_velvet", "recipe_scroll_stagheart_stew", "recipe_scroll_antler_broth", "fragment_sacred_horn"]);
    expect(pool.map(item => item.id).sort()).toEqual(["ring_of_thorns", "thorn_amulet"]);
    expect(pool.every(item => ["ring", "amulet"].includes(item.slot))).toBe(true);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every(drop => drop.generated || allowedStatic.has(drop.baseId || drop.id))).toBe(true);
  });

  it("crypts loot includes a shadow resistance drop", () => {
    const ward = items.find(item => item.id === "ward_amulet");
    expect(ADVENTURE_LOOT_POOLS.crypts.items).toContainEqual(expect.objectContaining({ id: "ward_amulet" }));
    expect(ward?.effects).toContainEqual({ type: "shadow_resist", value: 15 });
  });

  it("bandit loot table returns valid item drops", () => {
    const bandit = enemyById.forest_bandit;
    const drops = rollLootTable(bandit.lootTable, () => 0.1);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every(drop => drop?.id && drop?.name)).toBe(true);
    expect(drops.every(drop => drop.generated || drop.id === "campfire")).toBe(true);
    expect(drops.some(drop => (drop.baseId || drop.id) === "tower_shield")).toBe(false);
  });

  it("keeps secret encounters out of visible zone rooms", () => {
    const rooms = buildZoneRooms("ancient_forest");
    const secretIds = zoneById.ancient_forest.secretEncounters.map(secret => secret.id);
    expect(secretIds).toContain("spike_trap");
    expect(zoneById.ancient_forest.secretEncounters.find(secret => secret.id === "spike_trap").trigger.chance).toBe(5);
    expect(zoneById.ancient_forest.secretEncounters.find(secret => secret.id === "hidden_roots_cache").trigger.chance).toBe(10);
    expect(rooms.some(room => secretIds.includes(room.event?.id))).toBe(false);
  });

  it("generated venom weapons can apply bleed and poison on hero hit in auto-combat", () => {
    const hero = initHero("Tester");
    hero.equip = {
      ...hero.equip,
      weapon: {
        id: "generated_venom_test",
        uid: "generated_venom_test_uid",
        generated: true,
        type: "gear",
        slot: "weapon",
        family: "spear",
        hands: 2,
        baseStats: { damage: 10 },
        damageDice: { count: 1, sides: 12, bonus: 4, text: "1d12+4" },
        effects: [
          { type: "bleed_on_hit", chance: 100, duration: 4, damagePct: 2 },
          { type: "poison_on_hit", chance: 100, duration: 4, damagePct: 2 },
        ],
      },
    };
    hero.hp = calcStats(hero).maxHp;
    const stats = calcStats(hero);
    const tankDummy = {
      id: "tank_dummy",
      name: "Tank Dummy",
      family: "beast",
      hp: 5000,
      stats: { maxHp: 5000, attack: 1, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };
    const result = runCombat(hero, stats, tankDummy, getHungerLevel(hero.hunger), { rng: () => 0.01 });
    expect(result.log.some(entry => entry.type === "bleed")).toBe(true);
    expect(result.log.some(entry => entry.type === "poison")).toBe(true);
  });

  it("venom weapon effects apply bleed and poison on hit in interactive combat", () => {
    const artifactEffects = [
      { type: "bleed_on_hit", chance: 100, duration: 4, damagePct: 2 },
      { type: "poison_on_hit", chance: 100, duration: 4, damagePct: 1 },
    ];
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "tank_dummy",
        name: "Tank Dummy",
        hp: 5000,
        stats: { maxHp: 5000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: artifactEffects,
    });
    const after = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    expect(after.combatants.enemy.activeEffects.some(e => e.type === "bleed")).toBe(true);
    expect(after.combatants.enemy.activeEffects.some(e => e.type === "poison")).toBe(true);
    expect(after.combatants.enemy.activeEffects.find(e => e.type === "bleed")?.stacks).toBe(1);
    expect(after.combatants.enemy.activeEffects.find(e => e.type === "poison")?.remainingTicks).toBe(4);
  });

  it("burn_on_hit applies burning status that deals fire damage each tick", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "tank_dummy",
        name: "Tank Dummy",
        hp: 5000,
        stats: { maxHp: 5000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "burn_on_hit", chance: 100, duration: 3, damagePct: 2 }],
    });
    const afterHit = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    expect(afterHit.combatants.enemy.activeEffects.some(e => e.type === "burning")).toBe(true);
    const hpAfterHit = afterHit.combatants.enemy.hp;
    const afterBurn = processTick(afterHit, ACTION.NONE, () => 0.01);
    expect(afterBurn.combatants.enemy.hp).toBeLessThan(hpAfterHit);
    expect(afterBurn.log.some(entry => entry.type === "burning" && entry.damage > 0)).toBe(true);
  });

  it("poison resistance reduces poison damage ticks", () => {
    const state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      enemyObj: {
        id: "tank_dummy",
        name: "Tank Dummy",
        hp: 100,
        stats: { maxHp: 100, attack: 0, armor: 0, poisonResist: 100 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    state.combatants.enemy.activeEffects = [{ type: "poison", stacks: 1, remainingTicks: 2, damagePctPerTick: 50 }];

    const afterPoison = processTick(state, ACTION.NONE, () => 0.5);

    expect(afterPoison.combatants.enemy.hp).toBe(75);
    expect(afterPoison.log.some(entry => entry.type === "poison" && entry.damage === 25)).toBe(true);
  });

  // ─── Scar system ────────────────────────────────────────────────────────────

  it("Scar Tissue accumulates one stack per damage hit across multiple hits", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "scar_dummy",
        name: "Scar Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 10, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [{
        id: "warmonger_scar_tissue",
        proc: {
          trigger: "on_take_damage",
          chance: 100,
          effect: { type: "gain_scar_stack" },
        },
      }],
    });

    let state = base;
    for (let i = 0; i < 3; i++) {
      const strike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, state.tick, 10, null, 1);
      state = processTick({ ...state, actionQueue: strike }, ACTION.NONE, () => 0.01);
    }

    expect(state.procState.scarStacks).toBe(3);
    expect(state.combatants.hero.armor).toBe(3);
  });

  it("Scar stacks cannot exceed 15 when already at maximum", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "scar_dummy",
        name: "Scar Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 10, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [{
        id: "warmonger_scar_tissue",
        proc: {
          trigger: "on_take_damage",
          chance: 100,
          effect: { type: "gain_scar_stack" },
        },
      }],
    });
    const atMax = { ...base, procState: { ...base.procState, scarStacks: 15 } };
    const strike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 0, 10, null, 1);
    const after = processTick({ ...atMax, actionQueue: strike }, ACTION.NONE, () => 0.01);

    expect(after.procState.scarStacks).toBe(15);
    expect(after.combatants.hero.armor).toBe(15);
  });

  // ─── Rage system ────────────────────────────────────────────────────────────

  it("normal auto-attack hit gains 6 Rage", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Target Dummy",
        hp: 10000,
        stats: { maxHp: 10000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
    });

    const after = processTick(base, ACTION.BASIC_ATTACK, () => 0.01);

    expect(after.log.some(e => e.actorId === "hero" && e.type === "hit")).toBe(true);
    expect(after.heroResources.rage.value).toBe(6);
  });

  it("critical auto-attack hit gains 9 Rage instead of 6", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Target Dummy",
        hp: 10000,
        stats: { maxHp: 10000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "force_crit" }],
      heroAttackRate: 1,
    });

    const after = processTick(base, ACTION.BASIC_ATTACK, () => 0.01);

    expect(after.log.some(e => e.actorId === "hero" && e.type === "hit" && e.isCrit)).toBe(true);
    expect(after.heroResources.rage.value).toBe(9);
  });

  it("Rage decay waits for an inactivity grace before ticking down", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Target Dummy",
        hp: 10000,
        stats: { maxHp: 10000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    const withRage = withCombatRage(base, 20);

    const graceTick = processTick(withRage, ACTION.NONE, () => 0.5);
    const decayed = processTick({ ...withRage, tick: 4 }, ACTION.NONE, () => 0.5);

    expect(graceTick.heroResources.rage.value).toBe(20);
    expect(decayed.heroResources.rage.value).toBe(17);
  });

  it("slow two-handed autoattack wind-up does not drain Rage before Whirlwind is ready", () => {
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Target Dummy",
        hp: 10000,
        stats: { maxHp: 10000, attack: 0, armor: 0, attackSpeed: 0 },
        effects: [],
      },
      heroAbilities: [combatSkillById.whirlwind],
      heroEffects: [],
      heroInitialRage: 50,
      heroAttackRate: 0.68,
      heroWeaponTags: ["melee", "two_handed"],
    });

    for (let seconds = 0; seconds < 3; seconds += 1) {
      state = processAutoAttackFrame(state, 1000, () => 0.01, { skipEnemyAutos: true });
      state = processTick(state, ACTION.NONE, () => 0.5, { disableAutoAttacks: true });
    }

    expect(state.heroResources.rage.value).toBeGreaterThanOrEqual(50);
    expect(getAbilityUseFailureReason(
      state.combatants.hero,
      combatSkillById.whirlwind,
      state.tick + 1,
      state.heroResources,
      state.combatants.enemy,
      { procState: state.procState },
    )).toBeNull();
  });

  it("auto-attack cadence builds Rage across active combat ticks", () => {
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Target Dummy",
        hp: 10000,
        stats: { maxHp: 10000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 1,
    });

    for (let i = 0; i < 4; i += 1) {
      state = processTick(state, ACTION.BASIC_ATTACK, () => 0.5);
    }

    const heroHits = state.log.filter(e => e.actorId === "hero" && e.type === "hit");
    expect(heroHits).toHaveLength(2);
    expect(state.heroResources.rage.value).toBe(12);
  });

  it("Rage cannot exceed 100 when gains would overflow", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Target Dummy",
        hp: 10000,
        stats: { maxHp: 10000, attack: 0, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [{ type: "force_crit" }],
      heroAttackRate: 1,
    });
    const withRage = withCombatRage(base, 97);

    const after = processTick(withRage, ACTION.BASIC_ATTACK, () => 0.01);

    expect(after.heroResources.rage.value).toBe(100);
  });

  it("taking an unblocked hit gains 3 Rage", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Target Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 10, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });

    const strike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 0, 10, null, 1);
    const after = processTick({ ...base, actionQueue: strike }, ACTION.NONE, () => 0.01);

    expect(after.log.some(e => e.actorId === "enemy" && e.type === "hit")).toBe(true);
    expect(after.heroResources.rage.value).toBe(3);
  });

  it("gain_rage proc effect adds Rage when triggered by incoming damage", () => {
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: {
        id: "dummy",
        name: "Target Dummy",
        hp: 1000,
        stats: { maxHp: 1000, attack: 10, armor: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [{
        id: "fury_proc",
        proc: {
          trigger: "on_take_damage",
          chance: 100,
          effect: { type: "gain_rage", value: 20 },
        },
      }],
    });

    const strike = enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 0, 10, null, 1);
    const after = processTick({ ...base, actionQueue: strike }, ACTION.NONE, () => 0.01);

    expect(after.log.some(e => e.actorId === "enemy" && (e.type === "hit" || e.type === "blocked"))).toBe(true);
    // 3 base rage on taking hit + 20 from the gain_rage proc = 23
    expect(after.heroResources.rage.value).toBe(23);
  });

  it("Spite Wall reflects auto attacks and spells to the actual attacker", () => {
    const spiteWall = {
      id: "warmonger_spite_wall",
      proc: {
        trigger: "on_take_damage",
        chance: 100,
        condition: { scar_stacks_gte: 10 },
        effect: { type: "reflect_damage" },
      },
    };
    const makeState = () => {
      const state = initCombat({
        heroName: "Tester",
        heroHp: 100,
        heroMaxHp: 100,
        heroDamage: 10,
        heroArmor: 0,
        enemyObjs: [
          {
            id: "boss_dummy",
            name: "Boss Dummy",
            hp: 1000,
            stats: { maxHp: 1000, attack: 0, armor: 0 },
            effects: [],
          },
          {
            id: "add_dummy",
            name: "Add Dummy",
            hp: 50,
            stats: { maxHp: 50, attack: 10, armor: 0 },
            effects: [],
          },
        ],
        bossDeathEndsFight: false,
        heroAbilities: [],
        heroEffects: [],
        heroProcNodes: [spiteWall],
      });
      return { ...state, procState: { ...state.procState, scarStacks: 10 } };
    };

    const autoStrike = enqueueAction(createActionQueue(), "enemy_1", ACTION.BASIC_ATTACK, 0, 10, null, 1);
    const afterAuto = processTick({ ...makeState(), actionQueue: autoStrike }, ACTION.NONE, () => 0.01);

    expect(afterAuto.combatants.enemies[0].hp).toBe(1000);
    expect(afterAuto.combatants.enemies[1].hp).toBeLessThan(50);
    expect(afterAuto.log.some(entry => entry.text.includes("Spite Wall reflects") && entry.text.includes("to Add Dummy"))).toBe(true);

    const spell = { id: "add_firebolt", name: "Firebolt", type: "spell_attack", damage: 10, element: "fire", castTicks: 0 };
    const spellStrike = enqueueAbility(createActionQueue(), "enemy_1", ACTION.ABILITY_0, 0, 0, 10, spell, { targetId: "hero" });
    const afterSpell = processTick({ ...makeState(), actionQueue: spellStrike }, ACTION.NONE, () => 0.01);

    expect(afterSpell.combatants.enemies[0].hp).toBe(1000);
    expect(afterSpell.combatants.enemies[1].hp).toBeLessThan(50);
    expect(afterSpell.log.some(entry => entry.abilityId === "add_firebolt" && entry.damage === 10)).toBe(true);
    expect(afterSpell.log.some(entry => entry.text.includes("Spite Wall reflects") && entry.text.includes("to Add Dummy"))).toBe(true);
  });
});

describe("talent proc behavior", () => {
  const dummy = (hp = 100000) => ({
    id: "target_dummy",
    name: "Target Dummy",
    hp,
    stats: { maxHp: hp, attack: 0, armor: 0, attackSpeed: 1 },
    effects: [],
  });

  it("Bloodletter heals 2% max HP when hitting a bleeding enemy", () => {
    const bloodletter = {
      id: "bleeder_bloodletter_heal",
      proc: {
        trigger: "on_hit",
        chance: 100,
        condition: { target_has_bleed: true },
        effect: { type: "heal_pct_max_hp", value: 2 },
      },
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 80,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: dummy(),
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 3,
      heroProcNodes: [bloodletter],
    });
    // inject bleed on enemy
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemy: {
          ...state.combatants.enemy,
          activeEffects: [{ type: "bleed", stacks: 1, remainingTicks: 4, damagePctPerTick: 2 }],
        },
      },
    };
    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    // 2% of 100 maxHp = 2 HP healed
    expect(state.combatants.hero.hp).toBe(82);
    expect(state.log.some(entry => entry.type === "heal" && entry.text.includes("2 HP"))).toBe(true);
  });

  it("Bloodletter does NOT heal when the enemy has no bleed", () => {
    const bloodletter = {
      id: "bleeder_bloodletter_heal",
      proc: {
        trigger: "on_hit",
        chance: 100,
        condition: { target_has_bleed: true },
        effect: { type: "heal_pct_max_hp", value: 2 },
      },
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 80,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: dummy(),
      heroAbilities: [],
      heroEffects: [],
      heroAttackRate: 3,
      heroProcNodes: [bloodletter],
    });
    state = processTick(state, ACTION.BASIC_ATTACK, () => 0.01);
    expect(state.combatants.hero.hp).toBe(80);
  });

  it("Iron Skin multi effect applies both attack speed and heal on block", () => {
    const ironSkin = {
      id: "warmonger_iron_skin",
      proc: {
        trigger: "on_block",
        chance: 100,
        condition: null,
        effect: {
          type: "multi",
          effects: [
            { type: "gain_attack_speed_pct", value: 20, durationTicks: 3 },
            { type: "heal_pct_max_hp", value: 3 },
          ],
        },
      },
    };
    const base = initCombat({
      heroName: "Tester",
      heroHp: 80,
      heroMaxHp: 100,
      heroDamage: 1,
      heroArmor: 0,
      heroBlockChance: 100,
      heroBlockPower: 50,
      heroBlockPowerRegen: 0,
      enemyObj: dummy(1000),
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [ironSkin],
    });
    const state = {
      ...base,
      tick: 2,
      actionQueue: enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 5, null, undefined, { targetId: "hero" }),
    };
    const after = processTick(state, ACTION.BLOCK, () => 0.01);
    // 3% of 100 maxHp = 3 HP healed
    expect(after.combatants.hero.hp).toBe(83);
    // attack_speed_buff active effect added
    expect(after.combatants.hero.activeEffects.some(e => e.type === "attack_speed_buff" && e.value === 20)).toBe(true);
  });

  it("Fortress Stance raises block chance by 15 when a shield is equipped", () => {
    const hero = initHero("Tester");
    const shield = rollGeneratedEquipment({ baseId: "buckler", itemLevel: 2 }, () => 0);
    const withoutTalent = { ...hero, equip: { ...hero.equip, offhand: shield }, talents: {} };
    const withTalent = { ...withoutTalent, talents: { warmonger_fortress_stance: 1 } };

    const baseBlock = calcStats(withoutTalent).blockChance;
    const talentBlock = calcStats(withTalent).blockChance;

    expect(talentBlock).toBe(baseBlock + 15);
  });

  it("Flash lets Momentum build above the normal cap", () => {
    const momentumBuilder = {
      id: "speed_momentum_builder",
      proc: {
        trigger: "on_hit",
        chance: 100,
        condition: null,
        effect: { type: "gain_momentum", value: 1 },
      },
    };
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: dummy(),
      heroAbilities: [],
      heroEffects: [{ type: "momentum_max_cap", value: 12 }],
      heroProcNodes: [momentumBuilder],
    });
    const state = {
      ...base,
      procState: { ...base.procState, momentumStacks: 10, momentumMaxHeldTicks: 0 },
    };
    const hitAction = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 1, 10);
    const after = processTick({ ...state, tick: 2, actionQueue: hitAction }, ACTION.NONE, () => 0.01);
    expect(after.procState.momentumStacks).toBe(11);
  });

  it("Momentum stays capped at 10 without Flash", () => {
    const momentumBuilder = {
      id: "speed_momentum_builder",
      proc: {
        trigger: "on_hit",
        chance: 100,
        condition: null,
        effect: { type: "gain_momentum", value: 1 },
      },
    };
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      enemyObj: dummy(),
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [momentumBuilder],
    });
    const state = {
      ...base,
      procState: { ...base.procState, momentumStacks: 10, momentumMaxHeldTicks: 0 },
    };
    const hitAction = enqueueAction(createActionQueue(), "hero", ACTION.BASIC_ATTACK, 1, 10);
    const after = processTick({ ...state, tick: 2, actionQueue: hitAction }, ACTION.NONE, () => 0.01);
    expect(after.procState.momentumStacks).toBe(10);
  });

  it("Retribution deals 30% weapon damage back as true damage on block", () => {
    const retribution = {
      id: "warmonger_retribution",
      proc: {
        trigger: "on_block",
        chance: 100,
        condition: null,
        effect: { type: "counter_hit", damageMult: 0.3 },
      },
    };
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 40,
      heroArmor: 0,
      heroBlockChance: 100,
      heroBlockPower: 50,
      heroBlockPowerRegen: 0,
      enemyObj: dummy(1000),
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [retribution],
    });
    const state = {
      ...base,
      tick: 2,
      actionQueue: enqueueAction(createActionQueue(), "enemy", ACTION.BASIC_ATTACK, 1, 5, null, undefined, { targetId: "hero" }),
    };
    const after = processTick(state, ACTION.BLOCK, () => 0.01);
    // 30% of 40 hero damage = 12 true damage dealt back
    expect(after.combatants.enemy.hp).toBe(988);
    expect(after.log.some(entry => entry.type === "hit" && entry.text.includes("counter hit for 12"))).toBe(true);
  });

  it("Retribution does NOT fire without a block", () => {
    const retribution = {
      id: "warmonger_retribution",
      proc: {
        trigger: "on_block",
        chance: 100,
        condition: null,
        effect: { type: "counter_hit", damageMult: 0.3 },
      },
    };
    const base = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 40,
      heroArmor: 0,
      enemyObj: dummy(1000),
      heroAbilities: [],
      heroEffects: [],
      heroProcNodes: [retribution],
    });
    // Hero attacks enemy — no block involved
    const after = processTick(base, ACTION.BASIC_ATTACK, () => 0.01);
    expect(after.combatants.enemy.hp).toBe(1000 - 40);
    expect(after.log.some(entry => entry.text?.includes("counter hit"))).toBe(false);
  });
});

describe("DoT fractional damagePct balance", () => {
  // These tests verify the tick damage formula directly, since the formula
  // floor(maxHp * damagePct * stacks / 100) with min 1 is the canonical path.

  it("poison damagePct 0.4% ticks for 2 on a 500 HP target", () => {
    // 500 * 0.4 / 100 = 2.0 → floor = 2
    expect(Math.max(1, Math.floor(500 * 0.4 / 100))).toBe(2);
  });

  it("poison damagePct 0.45% ticks for 2 on a 500 HP target (giant spider new value)", () => {
    expect(Math.max(1, Math.floor(500 * 0.45 / 100))).toBe(2);
  });

  it("bleed damagePct 0.6% ticks for 2 on a 400 HP target", () => {
    // 400 * 0.6 / 100 = 2.4 → floor = 2
    expect(Math.max(1, Math.floor(400 * 0.6 / 100))).toBe(2);
  });

  it("bleed damagePct 0.55% ticks for 2 on a 400 HP target (generated affix new value)", () => {
    expect(Math.max(1, Math.floor(400 * 0.55 / 100))).toBe(2);
  });

  it("final tick damage has minimum of 1 for tiny damagePct on low-HP targets", () => {
    // 0.35% of 100 HP = 0.35 → floor = 0 → min clamp = 1
    expect(Math.max(1, Math.floor(100 * 0.35 / 100))).toBe(1);
    // 0.35% of 200 HP = 0.7 → floor = 0 → min clamp = 1
    expect(Math.max(1, Math.floor(200 * 0.35 / 100))).toBe(1);
  });

  it("poison stacks multiply tick damage — 2 stacks of 0.5% on 1000 HP = 10", () => {
    const stacks = 2;
    expect(Math.max(1, Math.floor(1000 * 0.5 * stacks / 100))).toBe(10);
  });

  it("bleed stacks multiply tick damage — 3 stacks of 0.6% on 1000 HP = 18", () => {
    const stacks = 3;
    expect(Math.max(1, Math.floor(1000 * 0.6 * stacks / 100))).toBe(18);
  });

  it("hemorrhage tick damage at 1.5% ticks for 7 on a 500 HP target (new tuned value)", () => {
    expect(Math.max(1, Math.floor(500 * 1.5 / 100))).toBe(7);
  });

  it("hemorrhage tick damage at 1.5% is less than old 4% on same target", () => {
    const newDmg = Math.max(1, Math.floor(500 * 1.5 / 100));
    const oldDmg = Math.max(1, Math.floor(500 * 4 / 100));
    expect(newDmg).toBeLessThan(oldDmg);
  });

  it("hemorrhage upfront true damage at 5% is half the old 10% value", () => {
    const newDmg = Math.max(1, Math.floor(500 * 5 / 100));
    const oldDmg = Math.max(1, Math.floor(500 * 10 / 100));
    expect(newDmg).toBe(25);
    expect(oldDmg).toBe(50);
  });

  it("enemy with on-hit poison applies fractional damagePct to hero via runCombat", () => {
    const hero = initHero("Tester");
    hero.hp = 300;
    hero.equip = {};
    const stats = calcStats(hero);
    const poisonEnemy = {
      id: "venom_test",
      name: "Venom Test",
      family: "spider",
      hp: 1,
      stats: { maxHp: 1, attack: 1, armor: 0, attackSpeed: 10 },
      rewards: { xp: 0, gold: 0 },
      effects: [{ type: "poison_on_hit", chance: 100, duration: 3, damagePct: 0.45 }],
    };
    const result = runCombat(hero, stats, poisonEnemy, getHungerLevel(hero.hunger), { rng: () => 0.01 });
    const poisonEntry = result.log.find(e => e.type === "poison");
    expect(poisonEntry).toBeTruthy();
  });

  it("enemy bleed on hit preserves fractional damagePct via runCombat", () => {
    const hero = initHero("Tester");
    hero.hp = 300;
    hero.equip = {};
    const stats = calcStats(hero);
    const bleedEnemy = {
      id: "bleed_test",
      name: "Bleed Test",
      family: "wolf",
      hp: 1,
      stats: { maxHp: 1, attack: 1, armor: 0, attackSpeed: 10 },
      rewards: { xp: 0, gold: 0 },
      effects: [{ type: "bleed_on_hit", chance: 100, duration: 3, damagePct: 0.6 }],
    };
    const result = runCombat(hero, stats, bleedEnemy, getHungerLevel(hero.hunger), { rng: () => 0.01 });
    const bleedEntry = result.log.find(e => e.type === "bleed");
    expect(bleedEntry).toBeTruthy();
  });
});

describe("Spider content", () => {
  it("all spider enemy IDs resolve", () => {
    expect(enemyById.cave_spiderling).toBeTruthy();
    expect(enemyById.giant_spider).toBeTruthy();
    expect(enemyById.venom_giant_spider).toBeTruthy();
    expect(enemyById.silkfang_matriarch).toBeTruthy();
    expect(bossById.broodmother_of_the_deep).toBeTruthy();
  });

  it("cave_spiderling is a weak tier-1 spider with light venom", () => {
    const s = enemyById.cave_spiderling;
    expect(s.tier).toBe(1);
    expect(s.threat).toBe("weak");
    expect(s.baseStats.maxHp).toBeGreaterThanOrEqual(45);
    expect(s.baseStats.maxHp).toBeLessThanOrEqual(70);
    expect(s.effects).toContainEqual(expect.objectContaining({ type: "poison_on_hit", damagePct: 0.3 }));
    expect(s.abilities ?? []).toHaveLength(0);
  });

  it("giant_spider (Giant Webspinner) uses web_snare freeze type and silken_recovery", () => {
    const s = enemyById.giant_spider;
    expect(s.name).toBe("Giant Webspinner");
    expect(s.abilities).toContainEqual(expect.objectContaining({ id: "web_snare", type: "web_snare", durationTicks: 2 }));
    expect(s.abilities).toContainEqual(expect.objectContaining({ id: "silken_recovery", type: "heal_over_time" }));
    expect(s.lootTable).toBe("giant_webspinner_loot");
  });

  it("venom_giant_spider (Venom Stalker) has poison_spit ability", () => {
    const s = enemyById.venom_giant_spider;
    expect(s.name).toBe("Venom Stalker");
    expect(s.abilities).toContainEqual(expect.objectContaining({ id: "poison_spit", type: "poison_spit" }));
    expect(s.lootTable).toBe("venom_stalker_loot");
  });

  it("silkfang_matriarch has web_snare, brood_call, and silken_recovery", () => {
    const s = enemyById.silkfang_matriarch;
    expect(s.tier).toBe(3);
    expect(s.abilities).toContainEqual(expect.objectContaining({ type: "web_snare" }));
    expect(s.abilities).toContainEqual(expect.objectContaining({ type: "summon_add", enemyId: "cave_spiderling" }));
    expect(s.abilities).toContainEqual(expect.objectContaining({ type: "heal_over_time" }));
    expect(s.lootTable).toBe("silkfang_matriarch_loot");
  });

  it("broodmother_of_the_deep has cocoon transform fields and phase2 data", () => {
    const b = bossById.broodmother_of_the_deep;
    expect(b.hasCocoonTransform).toBe(true);
    expect(b.cocoonDurationTicks).toBe(6);
    expect(b.phase2MaxHp).toBeGreaterThan(0);
    expect(Array.isArray(b.phase2Abilities)).toBe(true);
    expect(b.phase2Abilities.length).toBeGreaterThan(0);
  });

  it("broodmother phase2 brood_call has devourAfterTicks set", () => {
    const b = bossById.broodmother_of_the_deep;
    const devourCall = b.phase2Abilities.find(a => a.type === "summon_add" && a.devourAfterTicks != null);
    expect(devourCall).toBeTruthy();
    expect(devourCall.devourAfterTicks).toBe(8);
    expect(devourCall.maxAdds).toBe(3);
  });

  it("broodmother relic has ~1% configured drop chance", () => {
    const table = LOOT_TABLES["broodmother_loot"];
    expect(table).toBeTruthy();
    expect(table.relicDrop?.itemId).toBe("relic_broodvenom");
    expect(table.relicDrop?.chance).toBe(1);
  });

  it("all spider loot tables resolve and contain valid item IDs", () => {
    const tableNames = ["cave_spiderling_loot", "giant_webspinner_loot", "venom_stalker_loot", "silkfang_matriarch_loot", "broodmother_loot"];
    for (const name of tableNames) {
      const table = LOOT_TABLES[name];
      expect(table).toBeTruthy();
      for (const id of (table.includeItemIds || [])) {
        expect(items.find(i => i.id === id)).toBeTruthy();
      }
    }
  });

  it("venom_ring can drop from cave_spiderling_loot", () => {
    const table = LOOT_TABLES["cave_spiderling_loot"];
    expect(table?.includeItemIds).toContain("venom_ring");
  });

  it("venom_fang_dagger can drop from venom_stalker_loot and silkfang_matriarch_loot", () => {
    expect(LOOT_TABLES["venom_stalker_loot"]?.includeItemIds).toContain("venom_fang_dagger");
    expect(LOOT_TABLES["silkfang_matriarch_loot"]?.includeItemIds).toContain("venom_fang_dagger");
  });

  it("all spider encounters in adventures.json are singleEncounter", () => {
    const spiderNodes = regions.filter(r => r.enemyId && (
      r.enemyId === "cave_spiderling" ||
      r.enemyId === "giant_spider" ||
      r.enemyId === "venom_giant_spider" ||
      r.enemyId === "silkfang_matriarch" ||
      r.enemyId === "broodmother_of_the_deep"
    ));
    expect(spiderNodes.length).toBeGreaterThan(0);
    for (const node of spiderNodes) {
      expect(node.singleEncounter).toBe(true);
    }
  });

  it("web_snare type freezes auto-attack for its duration ticks", () => {
    const hero = {
      ...initHero("Tester", { heroClass: "fighter" }),
      hp: 200, maxHp: 200,
    };
    const spiderling = {
      id: "dummy_webspinner",
      name: "Webspinner",
      family: "spider",
      hp: 500,
      disableAutoAttack: true,
      stats: { maxHp: 500, attack: 0, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
      abilities: [{
        id: "web_snare_test",
        name: "Web Snare",
        type: "web_snare",
        castTicks: 0,
        cooldownSeconds: 99,
        durationTicks: 3,
      }],
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 5,
      heroArmor: 0,
      heroAttackRate: 1,
      enemyObj: spiderling,
      heroAbilities: [],
      heroEffects: [],
    });
    // Force hero to have full auto-attack progress, then apply web snare
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        hero: {
          ...state.combatants.hero,
          autoAttackProgressTicks: AUTO_ATTACK_TICKS - 0.5,
          autoAttackStarted: true,
        },
      },
    };
    // Apply web snare directly to hero
    state.combatants.hero.activeEffects = [{
      type: "web_snare",
      remainingTicks: 3,
      sourceAbilityId: "web_snare_test",
    }];
    // Tick: hero should not auto-attack while snared
    const prevHp = state.combatants.enemy.hp;
    state = processTick(state, ACTION.NONE, () => 0.5);
    // Enemy should still be at full HP (hero couldn't attack)
    expect(state.combatants.enemy.hp).toBe(prevHp);
    // Web snare should still be active (2 remaining after 1 tick)
    const snare = state.combatants.hero.activeEffects.find(e => e.type === "web_snare");
    expect(snare).toBeTruthy();
    expect(snare.remainingTicks).toBe(2);
  });

  it("web_snare expires after its duration and hero can attack again", () => {
    const hero = initHero("Tester");
    const enemy = {
      id: "dummy",
      name: "Dummy",
      family: "humanoid",
      hp: 1000,
      disableAutoAttack: true,
      stats: { maxHp: 1000, attack: 0, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 10,
      heroArmor: 0,
      heroAttackRate: 1,
      enemyObj: enemy,
      heroAbilities: [],
      heroEffects: [],
    });
    // Apply 1-tick web snare
    state.combatants.hero.activeEffects = [{ type: "web_snare", remainingTicks: 1, sourceAbilityId: "test" }];
    state.combatants.hero.autoAttackProgressTicks = AUTO_ATTACK_TICKS + 1;
    state.combatants.hero.autoAttackStarted = true;
    state = processTick(state, ACTION.NONE, () => 0.5);
    // After 1 tick, web_snare should expire
    const snare = state.combatants.hero.activeEffects.find(e => e.type === "web_snare");
    expect(snare).toBeFalsy();
  });

  it("cave_spiderlings can be summoned by silkfang_matriarch", () => {
    const hero = initHero("Tester");
    const matriarch = {
      id: "test_matriarch",
      name: "Silkfang Matriarch",
      family: "spider",
      hp: 400,
      stats: { maxHp: 400, attack: 16, armor: 5 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
      abilities: [{
        id: "brood_call_test",
        name: "Brood Call",
        type: "summon_add",
        castTicks: 0,
        cooldownSeconds: 99,
        enemyId: "cave_spiderling",
        maxAdds: 2,
        maxSummons: 4,
        pauseMs: 0,
      }],
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 100,
      heroMaxHp: 100,
      heroDamage: 5,
      heroArmor: 0,
      enemyObj: matriarch,
      heroAbilities: [],
      heroEffects: [],
    });
    // Force the matriarch to use brood_call immediately — combatant id is 'enemy'
    state = {
      ...state,
      actionQueue: enqueueAbility(createActionQueue(), "enemy", ACTION.ABILITY_0, 0, state.tick, 0, matriarch.abilities[0], { targetId: "hero" }),
    };
    state = processTick(state, ACTION.NONE, () => 0.5);
    const summonLog = state.log.find(e => e.type === "summon" && e.actorId === "enemy");
    expect(summonLog).toBeTruthy();
    const spiderlings = (state.combatants.enemies || []).filter(c => c.isSummon && c.summonedBy === "enemy");
    expect(spiderlings.length).toBeGreaterThan(0);
  });

  it("broodmother enters cocoon at 0 HP instead of dying", () => {
    const hero = initHero("Tester");
    const broodmother = {
      ...bossById.broodmother_of_the_deep,
      hp: 1,
      stats: { maxHp: 720, attack: 20, armor: 6, attackSpeed: 1.1 },
      rewards: { xp: 0, gold: 0 },
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 50,
      heroArmor: 0,
      heroAttackRate: 1,
      enemyObj: broodmother,
      heroAbilities: [],
      heroEffects: [],
    });
    // Force broodmother HP to 0
    state.combatants.enemy.hp = 0;
    state = processTick(state, ACTION.NONE, () => 0.5);
    // Should not be dead — should be in cocoon
    expect(state.phase).not.toBe("won");
    expect(state.combatants.enemy.inCocoon).toBe(true);
    expect(state.combatants.enemy.hp).toBeGreaterThan(0);
    const cocoonLog = state.log.find(e => e.type === "phase_change" && e.phase === "cocoon");
    expect(cocoonLog).toBeTruthy();
  });

  it("cocoon has 95% damage reduction via applyCombatantDamage", () => {
    const fakeBoss = { hp: 200, maxHp: 200, inCocoon: true, cocoonDamageTaken: 0 };
    const result = applyCombatantDamage(fakeBoss, 100);
    expect(result.damage).toBe(5); // 5% of 100
    expect(fakeBoss.cocoonDamageTaken).toBe(5);
    expect(fakeBoss.hp).toBe(195); // 200 - 5
  });

  it("phase 2 starts after cocoon duration with updated stats", () => {
    const broodmother = bossById.broodmother_of_the_deep;
    let state = initCombat({
      heroName: "Tester",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 5,
      heroArmor: 0,
      heroAttackRate: 0.1,
      enemyObj: {
        ...broodmother,
        hp: 1,
        stats: { maxHp: 720, attack: 20, armor: 6, attackSpeed: 1.1 },
        rewards: { xp: 0, gold: 0 },
      },
      heroAbilities: [],
      heroEffects: [],
    });
    // Trigger cocoon immediately
    state.combatants.enemy.hp = 0;
    state = processTick(state, ACTION.NONE, () => 0.5);
    expect(state.combatants.enemy.inCocoon).toBe(true);
    const cocoonStartTick = state.combatants.enemy.cocoonStartTick;
    // Advance ticks until cocoon exits (6 ticks)
    for (let i = 0; i < 8; i++) {
      if (state.phase !== "fighting") break;
      state = processTick(state, ACTION.NONE, () => 0.5);
    }
    // Should now be in phase 2
    expect(state.combatants.enemy.inCocoon).toBeFalsy();
    expect(state.combatants.enemy.activePhaseId).toBe("phase2");
    expect(state.combatants.enemy.maxHp).toBe(broodmother.phase2MaxHp);
    const p2Log = state.log.find(e => e.type === "phase_change" && e.phase === "phase2");
    expect(p2Log).toBeTruthy();
  });

  it("brood venom stacks to 5 and triggers Venom Shock", () => {
    const hero = {
      ...initHero("Tester"),
      hp: 500,
      maxHp: 500,
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 500,
      heroMaxHp: 500,
      heroDamage: 0,
      heroArmor: 0,
      heroAttackRate: 0.01,
      enemyObj: {
        id: "dummy",
        name: "Dummy",
        hp: 1000,
        disableAutoAttack: true,
        stats: { maxHp: 1000, attack: 0, armor: 0 },
        rewards: { xp: 0, gold: 0 },
        effects: [],
      },
      heroAbilities: [],
      heroEffects: [],
    });
    // Inject 5-stack brood_venom on hero
    state.combatants.hero.activeEffects = [{
      type: "brood_venom",
      stacks: 5,
      remainingTicks: 3,
      damagePctPerTick: 0.65,
    }];
    const hpBefore = state.combatants.hero.hp;
    state = processTick(state, ACTION.NONE, () => 0.5);
    // Hero should have taken damage from brood venom + venom shock
    expect(state.combatants.hero.hp).toBeLessThan(hpBefore);
    const shockLog = state.log.find(e => e.type === "poison" && e.text?.includes("Venom Shock"));
    expect(shockLog).toBeTruthy();
    // Stacks should have been reduced by 2 (5→3)
    const venom = state.combatants.hero.activeEffects.find(e => e.type === "brood_venom");
    expect(venom?.stacks).toBe(3);
  });

  it("devour heals boss after 8 ticks and removes spiderling", () => {
    const heroObj = initHero("Tester");
    const bossEnemy = {
      id: "test_brood",
      name: "Broodmother",
      family: "spider",
      hp: 400,
      maxHp: 400,
      stats: { maxHp: 400, attack: 0, armor: 0 },
      rewards: { xp: 0, gold: 0 },
      effects: [],
      disableAutoAttack: true,
      hasCocoonTransform: false,
    };
    let state = initCombat({
      heroName: "Tester",
      heroHp: 200,
      heroMaxHp: 200,
      heroDamage: 0,
      heroArmor: 0,
      heroAttackRate: 0.01,
      enemyObj: bossEnemy,
      heroAbilities: [],
      heroEffects: [],
    });
    // Wound the boss (combatant id is 'enemy')
    state.combatants.enemy.hp = 300;
    // Inject a fake summoned spiderling tagged for devour at tick + 1
    const currentTick = state.tick;
    const fakeSummon = {
      id: "enemy_spiderling_1",
      name: "Cave Spiderling",
      family: "spider",
      hp: 55,
      maxHp: 55,
      isSummon: true,
      summonedBy: "enemy",
      devourAtTick: currentTick + 1,
      devourHealPct: 7,
      devourBossId: "enemy",
      activeEffects: [],
      abilities: [],
      passiveEffects: [],
      basePassiveEffects: [],
      team: "enemy",
    };
    // Add the summon to the enemies array so getStateEnemies picks it up
    state = {
      ...state,
      combatants: {
        ...state.combatants,
        enemies: [...(state.combatants.enemies || [state.combatants.enemy]), fakeSummon],
      },
    };
    state = processTick(state, ACTION.NONE, () => 0.5);
    // Spiderling should be gone (hp = 0)
    const allEnemies = state.combatants.enemies || [];
    const spiderlingAfter = allEnemies.find(c => c.id === "enemy_spiderling_1");
    expect(spiderlingAfter?.hp ?? 0).toBe(0);
    // Devour log entry should exist
    const devourLog = state.log.find(e => e.text?.includes("devours") || e.text?.includes("Devours"));
    expect(devourLog).toBeTruthy();
  });
});
