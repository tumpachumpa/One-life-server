import { describe, expect, it } from "vitest";
import { canPlayNode, clearAdventureProcCarry, completeNode, continueFromCompletedNode, createInitialAdventureProgress, finishAdventureRunProgress, getActiveAdventureDifficulty, getAdventureChoiceNodes, getAdventureEncounterCap, getAdventureRunDifficulty, getAdventureStatus, getChoiceRunEnemyPoolIds, getNodeEncounterPool, getSelectedAdventureDifficulty, getUnlockedAdventureDifficulty, getWaypointReachableNodeIds, hasAdventureProcCarry, hasAdventureRunProgress, isNodeCompleted, isNodeKnown, isWaypointNode, normalizeAdventureProcCarry, normalizeAdventureProgress, resetAdventureProgress, resolveAdventureNode, selectNode, selectRoute, setAdventureProcCarry, startAdventureProgress, syncLinkedAdventureDifficultyProgress, transferAdventureProcCarry } from "./adventure.js";
import { adventureById, bossById, enemyById, regionById } from "./content.js";
import { getCampfireHealingPct } from "./campfires.js";
import {
  DEFAULT_DODGE_REVEAL_EXTENSION_MS,
  DEFAULT_DODGE_REVEAL_MS,
  DODGE_GRID_COLS,
  DODGE_GRID_ROWS,
  buildFireTiles,
  createDodgeSequence,
  getDodgeSequenceWave,
  normalizeDodgeWaves,
} from "../arena/dodgePatterns.js";

describe("adventure routes", () => {
  it("keeps Fallen Knight separate from the Umbral Key dwarven map tile", () => {
    expect(regionById.fallen_summit_region.name).toBe("Fallen Summit");
    expect(regionById.fallen_summit_region.requiredItemId).toBeUndefined();
    expect(adventureById.fallen_summit.bossId).toBe("fallen_knight");
    expect(adventureById.fallen_summit.requiredItemId).toBeUndefined();

    expect(regionById.sunken_forge_region.name).toBe("The Sunken Forge");
    expect(regionById.sunken_forge_region.requiredItemId).toBe("umbral_key");
    expect(adventureById.sunken_forge.bossId).toBeUndefined();
  });

  const adventure = {
    id: "test_branching_paths",
    zoneId: "ancient_forest",
    regionId: "test_region",
    name: "Branching Test",
    description: "Fixture adventure for route progression.",
    routes: [
      {
        id: "forest_boss_path",
        name: "Hunter's Trail",
        nodes: [
          { id: "trail_wolf", type: "combat", enemyId: "wolf", next: ["trail_rat"] },
          { id: "trail_rat", type: "combat", enemyId: "blood_rat", next: ["trail_spring"] },
          {
            id: "trail_spring",
            type: "event",
            next: ["trail_bandit"],
            event: {
              id: "healing_spring",
              title: "Clear Spring",
              description: "The water restores part of your strength.",
              effects: [{ type: "restore_hp_pct", value: 30 }],
            },
          },
          { id: "trail_bandit", type: "combat", enemyId: "forest_bandit", next: ["trail_wisp_guard"] },
          { id: "trail_wisp_guard", type: "combat", enemyId: "forest_wisp", next: ["trail_elder_stag"] },
          { id: "trail_elder_stag", type: "boss", bossId: "elder_stag", next: [] },
        ],
      },
      {
        id: "forest_cache_path",
        name: "Root Cache",
        nodes: [
          { id: "cache_wisp", type: "combat", enemyId: "forest_wisp", next: ["cache_chest"] },
          {
            id: "cache_chest",
            type: "event",
            next: [],
            event: {
              id: "mossy_chest",
              title: "Moss-Covered Chest",
              description: "An old forgotten chest rests among ancient roots.",
              effects: [{ type: "grant_gold", value: 18 }],
            },
          },
        ],
      },
    ],
  };

  it("starts with both route entrances discovered and the boss hidden", () => {
    const progress = createInitialAdventureProgress(adventure);
    expect(isNodeKnown(progress, "trail_wolf")).toBe(true);
    expect(isNodeKnown(progress, "cache_wisp")).toBe(true);
    expect(isNodeKnown(progress, "trail_elder_stag")).toBe(false);
    expect(getAdventureStatus(adventure, progress).bossKnown).toBe(false);
  });

  it("persists next-combat proc carry in adventure progress until it is consumed", () => {
    const progress = createInitialAdventureProgress(adventure);
    const carried = setAdventureProcCarry(progress, {
      bleedCarry: 2,
      momentumCarry: 12,
      hasTakenDamageLastFight: true,
      carriedRage: 87.8,
    });

    expect(carried.procCarry).toEqual({
      bleedCarry: 2,
      momentumCarry: 10,
      hasTakenDamageLastFight: true,
      carriedRage: 87,
    });
    expect(hasAdventureProcCarry(carried.procCarry)).toBe(true);
    expect(normalizeAdventureProgress(adventure, carried).procCarry).toEqual(carried.procCarry);
    expect(clearAdventureProcCarry(carried).procCarry).toBeUndefined();
    expect(setAdventureProcCarry(carried, { carriedRage: 0, momentumCarry: 0 }).procCarry).toBeUndefined();
  });

  it("moves proc carry between floor progress records without duplicating it", () => {
    const source = setAdventureProcCarry(createInitialAdventureProgress(adventure), { carriedRage: 60 });
    const target = createInitialAdventureProgress(adventure);
    const transferred = transferAdventureProcCarry(source, target);

    expect(transferred.sourceProgress.procCarry).toBeUndefined();
    expect(transferred.targetProgress.procCarry).toEqual(normalizeAdventureProcCarry({ carriedRage: 60 }));
  });

  it("resets an old adventure run back to the starting nodes", () => {
    let progress = createInitialAdventureProgress(adventure);
    progress = completeNode(adventure, progress, "trail_wolf");
    const otherAdventureProgress = { selectedNodeId: "keep" };
    const allProgress = {
      [adventure.id]: progress,
      other_adventure: otherAdventureProgress,
    };

    const reset = resetAdventureProgress(allProgress, adventure);

    expect(reset.other_adventure).toBe(otherAdventureProgress);
    expect(reset[adventure.id]).toEqual(createInitialAdventureProgress(adventure));
    expect(isNodeCompleted(reset[adventure.id], "trail_wolf")).toBe(false);
    expect(isNodeKnown(reset[adventure.id], "trail_rat")).toBe(false);
  });

  it("resets the whole Rootspire Tower run when any floor resets", () => {
    const floor1 = adventureById.rootspire_floor_1;
    const floor2 = adventureById.rootspire_floor_2;
    const floor3 = adventureById.rootspire_floor_3;
    const rooftop = adventureById.rootspire_rooftop;
    const otherAdventureProgress = { selectedNodeId: "keep" };
    const allProgress = {
      rootspire_floor_1: completeNode(floor1, createInitialAdventureProgress(floor1), "rootspire_breach_gargoyles"),
      rootspire_floor_2: completeNode(floor2, createInitialAdventureProgress(floor2), "rootspire_animated_armor"),
      rootspire_floor_3: completeNode(floor3, createInitialAdventureProgress(floor3), "rootspire_ash_imp_nest"),
      rootspire_rooftop: completeNode(rooftop, createInitialAdventureProgress(rooftop), "rootspire_last_campfire"),
      other_adventure: otherAdventureProgress,
    };

    const reset = resetAdventureProgress(allProgress, floor3);

    expect(reset.other_adventure).toBe(otherAdventureProgress);
    expect(reset.rootspire_floor_1).toEqual(createInitialAdventureProgress(floor1));
    expect(reset.rootspire_floor_2).toEqual(createInitialAdventureProgress(floor2));
    expect(reset.rootspire_floor_3).toEqual(createInitialAdventureProgress(floor3));
    expect(reset.rootspire_rooftop).toEqual(createInitialAdventureProgress(rooftop));
    expect(hasAdventureRunProgress(floor1, reset.rootspire_floor_1)).toBe(false);
  });

  it("shares Rootspire Tower difficulty unlocks across every floor after the Wyvern is cleared", () => {
    const floor1 = adventureById.rootspire_floor_1;
    const floor2 = adventureById.rootspire_floor_2;
    const floor3 = adventureById.rootspire_floor_3;
    const rooftop = adventureById.rootspire_rooftop;
    const progress = {
      rootspire_floor_1: createInitialAdventureProgress(floor1),
      rootspire_floor_2: createInitialAdventureProgress(floor2),
      rootspire_floor_3: createInitialAdventureProgress(floor3),
      rootspire_rooftop: startAdventureProgress(rooftop, createInitialAdventureProgress(rooftop), 1),
    };

    const finished = finishAdventureRunProgress(progress, rooftop, { completedDifficultyStars: 1 });

    for (const adventureId of ["rootspire_floor_1", "rootspire_floor_2", "rootspire_floor_3", "rootspire_rooftop"]) {
      expect(getUnlockedAdventureDifficulty(finished[adventureId])).toBe(2);
      expect(getSelectedAdventureDifficulty(finished[adventureId])).toBe(2);
      expect(getActiveAdventureDifficulty(finished[adventureId])).toBe(0);
      expect(hasAdventureRunProgress(adventureById[adventureId], finished[adventureId])).toBe(false);
    }
    expect(finished.rootspire_rooftop.bossCompleted).toBe(true);
    expect(finished.rootspire_floor_1.bossCompleted).toBe(false);
  });

  it("unlocks the lobby-facing Rootspire floor when a legacy one-star tower save clears the Wyvern", () => {
    const floor1 = adventureById.rootspire_floor_1;
    const rooftop = adventureById.rootspire_rooftop;
    const legacyProgress = {
      rootspire_floor_1: createInitialAdventureProgress(floor1),
      rootspire_rooftop: startAdventureProgress(rooftop, createInitialAdventureProgress(rooftop), 1),
    };

    const finished = finishAdventureRunProgress(legacyProgress, rooftop, { completedDifficultyStars: 1 });

    expect(getUnlockedAdventureDifficulty(finished.rootspire_floor_1)).toBe(2);
    expect(getSelectedAdventureDifficulty(finished.rootspire_floor_1)).toBe(2);
    expect(getUnlockedAdventureDifficulty(finished.rootspire_floor_2)).toBe(2);
    expect(getUnlockedAdventureDifficulty(finished.rootspire_floor_3)).toBe(2);
    expect(getUnlockedAdventureDifficulty(finished.rootspire_rooftop)).toBe(2);
    expect(getActiveAdventureDifficulty(finished.rootspire_floor_1)).toBe(0);
    expect(hasAdventureRunProgress(floor1, finished.rootspire_floor_1)).toBe(false);
  });

  it("migrates old linked-floor saves that unlocked difficulty on only the final floor", () => {
    const floor1 = adventureById.rootspire_floor_1;
    const floor2 = adventureById.rootspire_floor_2;
    const floor3 = adventureById.rootspire_floor_3;
    const rooftop = adventureById.rootspire_rooftop;
    const legacy = {
      rootspire_floor_1: createInitialAdventureProgress(floor1),
      rootspire_floor_2: createInitialAdventureProgress(floor2),
      rootspire_floor_3: createInitialAdventureProgress(floor3),
      rootspire_rooftop: {
        ...createInitialAdventureProgress(rooftop),
        bossCompleted: true,
        unlockedDifficultyStars: 2,
        selectedDifficultyStars: 2,
      },
    };

    const migrated = syncLinkedAdventureDifficultyProgress(legacy);

    expect(getUnlockedAdventureDifficulty(migrated.rootspire_floor_1)).toBe(2);
    expect(getSelectedAdventureDifficulty(migrated.rootspire_floor_1)).toBe(2);
    expect(getUnlockedAdventureDifficulty(migrated.rootspire_rooftop)).toBe(2);
    expect(migrated.rootspire_rooftop.bossCompleted).toBe(true);
  });

  it("repairs completed linked-floor saves that missed the next difficulty unlock", () => {
    const floor1 = adventureById.rootspire_floor_1;
    const rooftop = adventureById.rootspire_rooftop;
    const brokenCompletedSave = {
      rootspire_floor_1: createInitialAdventureProgress(floor1),
      rootspire_rooftop: {
        ...createInitialAdventureProgress(rooftop),
        bossCompleted: true,
        unlockedDifficultyStars: 1,
        selectedDifficultyStars: 1,
      },
    };

    const migrated = syncLinkedAdventureDifficultyProgress(brokenCompletedSave);

    expect(getUnlockedAdventureDifficulty(migrated.rootspire_floor_1)).toBe(2);
    expect(getSelectedAdventureDifficulty(migrated.rootspire_floor_1)).toBe(2);
    expect(getUnlockedAdventureDifficulty(migrated.rootspire_rooftop)).toBe(2);
    expect(migrated.rootspire_rooftop.lastCompletedDifficultyStars).toBe(1);
  });

  it("clears linked Crypts floor progress after the lower-floor boss is completed", () => {
    const floor1 = adventureById.crypts;
    const floor2 = adventureById.crypts_floor_2;
    const floor1Run = startAdventureProgress(floor1, createInitialAdventureProgress(floor1), 1);
    const floor2Run = startAdventureProgress(floor2, createInitialAdventureProgress(floor2), 1);
    const progress = {
      crypts: completeNode(floor1, floor1Run, "hellhound_depths"),
      crypts_floor_2: floor2Run,
    };

    const finished = finishAdventureRunProgress(progress, floor2, { completedDifficultyStars: 1 });

    expect(getUnlockedAdventureDifficulty(finished.crypts)).toBe(2);
    expect(getSelectedAdventureDifficulty(finished.crypts)).toBe(2);
    expect(getUnlockedAdventureDifficulty(finished.crypts_floor_2)).toBe(2);
    expect(finished.crypts_floor_2.bossCompleted).toBe(true);
    expect(hasAdventureRunProgress(floor1, finished.crypts)).toBe(false);
    expect(hasAdventureRunProgress(floor2, finished.crypts_floor_2)).toBe(false);
  });

  it("migrates old linked Crypts saves where the lobby floor stayed resumable after completion", () => {
    const floor1 = adventureById.crypts;
    const floor2 = adventureById.crypts_floor_2;
    const legacy = {
      crypts: completeNode(floor1, startAdventureProgress(floor1, createInitialAdventureProgress(floor1), 1), "hellhound_depths"),
      crypts_floor_2: {
        ...createInitialAdventureProgress(floor2),
        bossCompleted: true,
        unlockedDifficultyStars: 2,
        selectedDifficultyStars: 2,
      },
    };

    const migrated = syncLinkedAdventureDifficultyProgress(legacy);

    expect(getUnlockedAdventureDifficulty(migrated.crypts)).toBe(2);
    expect(getSelectedAdventureDifficulty(migrated.crypts)).toBe(2);
    expect(migrated.crypts_floor_2.bossCompleted).toBe(true);
    expect(hasAdventureRunProgress(floor1, migrated.crypts)).toBe(false);
  });

  it("unlocks the next Orc War Camp difficulty after either final boss is cleared", () => {
    const orcAdventure = adventureById.orc_war_camp;
    const progress = startAdventureProgress(orcAdventure, createInitialAdventureProgress(orcAdventure), 1);

    const finished = finishAdventureRunProgress({ orc_war_camp: progress }, orcAdventure, {
      completedDifficultyStars: 1,
    }).orc_war_camp;

    expect(getUnlockedAdventureDifficulty(finished)).toBe(2);
    expect(getSelectedAdventureDifficulty(finished)).toBe(2);
    expect(finished.bossCompleted).toBe(true);
    expect(hasAdventureRunProgress(orcAdventure, finished)).toBe(false);
  });

  it("repairs completed single-adventure saves that missed the next difficulty unlock", () => {
    const orcAdventure = adventureById.orc_war_camp;
    const brokenCompletedSave = {
      orc_war_camp: {
        ...createInitialAdventureProgress(orcAdventure),
        bossCompleted: true,
        unlockedDifficultyStars: 1,
        selectedDifficultyStars: 1,
      },
    };

    const migrated = syncLinkedAdventureDifficultyProgress(brokenCompletedSave).orc_war_camp;

    expect(getUnlockedAdventureDifficulty(migrated)).toBe(2);
    expect(getSelectedAdventureDifficulty(migrated)).toBe(2);
    expect(migrated.lastCompletedDifficultyStars).toBe(1);
    expect(hasAdventureRunProgress(orcAdventure, migrated)).toBe(false);
  });

  it("finishes an adventure run without making the completed boss run resumable", () => {
    let progress = createInitialAdventureProgress(adventure);
    for (const nodeId of ["trail_wolf", "trail_rat", "trail_spring", "trail_bandit", "trail_wisp_guard", "trail_elder_stag"]) {
      progress = completeNode(adventure, progress, nodeId);
    }

    const finished = finishAdventureRunProgress({ [adventure.id]: progress }, adventure)[adventure.id];

    expect(finished.bossCompleted).toBe(true);
    expect(isNodeCompleted(finished, "trail_elder_stag")).toBe(false);
    expect(hasAdventureRunProgress(adventure, finished)).toBe(false);
  });

  it("migrates adventure difficulty stars and unlocks only the next cleared star", () => {
    const migrated = normalizeAdventureProgress(adventure, { selectedRouteId: "legacy" });

    expect(getUnlockedAdventureDifficulty(migrated)).toBe(1);
    expect(getSelectedAdventureDifficulty(migrated)).toBe(1);
    expect(getActiveAdventureDifficulty(migrated)).toBe(0);
    expect(getAdventureRunDifficulty(adventure, migrated)).toBe(0);

    const started = startAdventureProgress(adventure, createInitialAdventureProgress(adventure), 1);
    expect(getActiveAdventureDifficulty(started)).toBe(1);
    expect(getAdventureRunDifficulty(adventure, started)).toBe(1);

    const finished = finishAdventureRunProgress({ [adventure.id]: started }, adventure, {
      completedDifficultyStars: 1,
    })[adventure.id];

    expect(getUnlockedAdventureDifficulty(finished)).toBe(2);
    expect(getSelectedAdventureDifficulty(finished)).toBe(2);
    expect(getActiveAdventureDifficulty(finished)).toBe(0);
    expect(finished.lastCompletedDifficultyStars).toBe(1);
    expect(hasAdventureRunProgress(adventure, finished)).toBe(false);
  });

  it("uses selected difficulty for legacy in-progress runs missing active stars", () => {
    const started = startAdventureProgress(adventure, createInitialAdventureProgress(adventure), 1);
    const { activeDifficultyStars, ...legacyStarted } = started;

    expect(getActiveAdventureDifficulty(legacyStarted)).toBe(0);
    expect(getAdventureRunDifficulty(adventure, legacyStarted)).toBe(1);

    const finished = finishAdventureRunProgress({ [adventure.id]: legacyStarted }, adventure)[adventure.id];

    expect(getUnlockedAdventureDifficulty(finished)).toBe(2);
    expect(getSelectedAdventureDifficulty(finished)).toBe(2);
    expect(getActiveAdventureDifficulty(finished)).toBe(0);
    expect(finished.lastCompletedDifficultyStars).toBe(1);
  });

  it("does not over-unlock when a normal difficulty run records its completed star", () => {
    const started = startAdventureProgress(adventure, createInitialAdventureProgress(adventure), 0);
    const finished = finishAdventureRunProgress({ [adventure.id]: started }, adventure, {
      completedDifficultyStars: 0,
    })[adventure.id];
    const migrated = syncLinkedAdventureDifficultyProgress({ [adventure.id]: finished })[adventure.id];

    expect(getUnlockedAdventureDifficulty(migrated)).toBe(1);
    expect(getSelectedAdventureDifficulty(migrated)).toBe(1);
    expect(migrated.lastCompletedDifficultyStars).toBe(0);
  });

  it("stops offering adventure cards as soon as a boss is completed", () => {
    const bossFinishAdventure = {
      id: "test_boss_finish_cards",
      zoneId: "ancient_forest",
      regionId: "test_region",
      name: "Boss Finish Cards",
      routes: [{
        id: "main",
        nodes: [
          { id: "first", type: "combat", enemyId: "wolf", next: ["optional", "boss"] },
          { id: "optional", type: "combat", enemyId: "boar", next: [] },
          { id: "boss", type: "boss", bossId: "elder_stag", next: ["post_boss"] },
          { id: "post_boss", type: "combat", enemyId: "blood_rat", next: [] },
        ],
      }],
    };

    let progress = createInitialAdventureProgress(bossFinishAdventure);
    progress = completeNode(bossFinishAdventure, progress, "first");
    progress = selectNode(bossFinishAdventure, progress, "boss");
    progress = completeNode(bossFinishAdventure, progress, "boss");

    expect(progress.bossCompleted).toBe(true);
    expect(progress.selectedNodeId).toBeNull();
    expect(progress.unlockedNodes).not.toContain("post_boss");
    expect(getAdventureChoiceNodes(bossFinishAdventure, progress)).toEqual([]);
    expect(hasAdventureRunProgress(bossFinishAdventure, progress)).toBe(false);
    expect(continueFromCompletedNode(bossFinishAdventure, progress, "boss").selectedNodeId).toBeNull();
  });

  it("starts a fresh adventure by selecting the first playable node", () => {
    const progress = createInitialAdventureProgress(adventure);
    const started = startAdventureProgress(adventure, progress);

    expect(started.selectedNodeId).toBe("trail_wolf");
    expect(canPlayNode(getAdventureStatus(adventure, started).activeNode, started)).toBe(true);
  });

  it("detects when an adventure run should be resumed instead of reset", () => {
    const initial = createInitialAdventureProgress(adventure);
    const started = startAdventureProgress(adventure, initial);
    const completed = completeNode(adventure, started, "trail_wolf");

    expect(hasAdventureRunProgress(adventure, initial)).toBe(false);
    expect(hasAdventureRunProgress(adventure, started)).toBe(true);
    expect(hasAdventureRunProgress(adventure, completed)).toBe(true);
  });

  it("does not count an automatic entrance node as a started run", () => {
    const entranceAdventure = {
      id: "test_entrance_resume",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [
          {
            id: "forest_entrance",
            type: "event",
            next: ["first_fight"],
            event: { id: "forest_entrance_event", title: "Forest Entrance", effects: [] },
          },
          { id: "first_fight", type: "combat", enemyId: "wolf", next: [] },
        ],
      }],
    };
    const initial = createInitialAdventureProgress(entranceAdventure);

    expect(initial.completedNodes).toContain("forest_entrance");
    expect(hasAdventureRunProgress(entranceAdventure, initial)).toBe(false);
    expect(hasAdventureRunProgress(entranceAdventure, startAdventureProgress(entranceAdventure, initial))).toBe(true);
  });

  it("starts procedural dungeons from the lobby entry state", () => {
    const dungeonAdventure = { id: "test_dungeon", zoneId: "dungeon", procedural: true };
    const progress = createInitialAdventureProgress(dungeonAdventure);
    const started = startAdventureProgress(dungeonAdventure, progress);

    expect(started.entered).toBe(true);
    expect(started.unlockedNodes.length).toBeGreaterThan(0);
  });

  it("detects entered procedural dungeons as resumable", () => {
    const dungeonAdventure = { id: "test_dungeon", zoneId: "dungeon", procedural: true };
    const progress = createInitialAdventureProgress(dungeonAdventure);

    expect(hasAdventureRunProgress(dungeonAdventure, progress)).toBe(false);
    expect(hasAdventureRunProgress(dungeonAdventure, startAdventureProgress(dungeonAdventure, progress))).toBe(true);
  });

  it("keeps the cache route separate from the boss route", () => {
    let progress = createInitialAdventureProgress(adventure);
    progress = selectRoute(adventure, progress, "forest_cache_path");
    progress = completeNode(adventure, progress, "cache_wisp");
    progress = completeNode(adventure, progress, "cache_chest");
    expect(isNodeKnown(progress, "cache_chest")).toBe(true);
    expect(isNodeKnown(progress, "trail_elder_stag")).toBe(false);
    expect(getAdventureStatus(adventure, progress).bossKnown).toBe(false);
  });

  it("reveals the boss when the previous main-path node is cleared", () => {
    let progress = createInitialAdventureProgress(adventure);
    for (const nodeId of ["trail_wolf", "trail_rat", "trail_spring", "trail_bandit", "trail_wisp_guard"]) {
      progress = completeNode(adventure, progress, nodeId);
    }
    expect(isNodeKnown(progress, "trail_elder_stag")).toBe(true);
    expect(getAdventureStatus(adventure, progress).bossKnown).toBe(true);
  });

  it("does not make completed combat nodes repeatable by default", () => {
    let progress = createInitialAdventureProgress(adventure);
    progress = completeNode(adventure, progress, "trail_wolf");

    expect(isNodeCompleted(progress, "trail_wolf")).toBe(true);
    expect(canPlayNode(adventure.routes[0].nodes[0], progress)).toBe(false);
  });

  it("keeps combat nodes fightable until their rolled encounter pool is exhausted", () => {
    const wolfNode = adventure.routes[0].nodes[0];
    let progress = createInitialAdventureProgress(adventure);

    progress = completeNode(adventure, progress, "trail_wolf", { encounterCap: 3 });
    expect(getNodeEncounterPool(progress, "trail_wolf")).toEqual({ defeated: 1, cap: 3 });
    expect(isNodeKnown(progress, "trail_rat")).toBe(true);
    expect(progress.selectedNodeId).toBe("trail_wolf");
    expect(canPlayNode(wolfNode, progress)).toBe(true);

    progress = completeNode(adventure, progress, "trail_wolf", { encounterCap: 3 });
    expect(getNodeEncounterPool(progress, "trail_wolf")).toEqual({ defeated: 2, cap: 3 });
    expect(canPlayNode(wolfNode, progress)).toBe(true);

    progress = completeNode(adventure, progress, "trail_wolf", { encounterCap: 3 });
    expect(getNodeEncounterPool(progress, "trail_wolf")).toEqual({ defeated: 3, cap: 3 });
    expect(progress.selectedNodeId).toBe("trail_rat");
    expect(canPlayNode(wolfNode, progress)).toBe(false);
  });

  it("keeps forward choices visible after leaving a completed encounter with repeats remaining", () => {
    let progress = createInitialAdventureProgress(adventure);

    progress = completeNode(adventure, progress, "trail_wolf", { encounterCap: 3 });

    expect(progress.selectedNodeId).toBe("trail_wolf");
    expect(getAdventureChoiceNodes(adventure, progress).map(node => node.id)).toEqual(["trail_wolf", "trail_rat"]);
  });

  it("keeps the last defeated encounter stored after a pool is exhausted", () => {
    const wolfNode = adventure.routes[0].nodes[0];
    const defeatedEnemy = {
      id: "wolf",
      name: "Rare Wolf",
      rarity: { id: "raro", label: "Rare", color: "#60a5fa" },
    };
    let progress = createInitialAdventureProgress(adventure);

    progress = completeNode(adventure, progress, "trail_wolf", {
      encounterCap: 1,
      lastEnemy: defeatedEnemy,
      lastEnemies: [defeatedEnemy],
    });
    const pool = getNodeEncounterPool(progress, "trail_wolf");

    expect(pool).toMatchObject({ defeated: 1, cap: 1 });
    expect(pool.lastEnemy).toEqual(defeatedEnemy);
    expect(pool.lastEnemies).toEqual([defeatedEnemy]);
    expect(canPlayNode(wolfNode, progress)).toBe(false);
  });

  it("resolves known adventure nodes to existing encounter shapes", () => {
    const combat = resolveAdventureNode(adventure, adventure.routes[0].nodes[0], 0, () => 0.1);
    const event = resolveAdventureNode(adventure, adventure.routes[1].nodes[1], 0, () => 0.1);
    const boss = resolveAdventureNode(adventure, adventure.routes[0].nodes.at(-1), 0, () => 0.1);
    expect(combat.type).toBe("combat");
    expect(combat.enemy.id).toBe("wolf");
    expect(event.type).toBe("event");
    expect(event.event.id).toBe("mossy_chest");
    expect(boss.type).toBe("boss");
    expect(boss.enemy.id).toBe("elder_stag");
  });

  it("applies configured rarity to campfire event healing", () => {
    const campfireAdventure = {
      id: "test_campfire_rarity",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [{
          id: "camp",
          type: "event",
          next: [],
          event: {
            id: "camp_event",
            title: "Campfire",
            rarity: "epic",
            effects: [{ type: "restore_hp_pct", value: 30 }, { type: "restore_energy", value: 20 }],
          },
        }],
      }],
    };

    const resolved = resolveAdventureNode(campfireAdventure, campfireAdventure.routes[0].nodes[0]);
    const heal = resolved.event.effects.find(effect => effect.type === "restore_hp_pct");

    expect(resolved.event.title).toBe("Epic Campfire");
    expect(resolved.event.rarity).toBe("epic");
    expect(heal).toMatchObject({ baseValue: 30, value: getCampfireHealingPct(30, "epic") });
  });

  it("keeps first adventure encounters at normal rarity", () => {
    const firstMainNode = adventure.routes[0].nodes[0];
    const firstBranchNode = adventure.routes[1].nodes[0];
    const choiceAdventure = {
      id: "test_choice_first_encounter",
      zoneId: "ancient_forest",
      regionId: "test_region",
      name: "Choice First Encounter",
      proceduralChoices: true,
      encounterCount: 3,
    };
    const progress = createInitialAdventureProgress(choiceAdventure);
    choiceAdventure.__progress = progress;
    const firstChoiceNode = getAdventureChoiceNodes(choiceAdventure, progress)[0];

    expect(resolveAdventureNode(adventure, firstMainNode, 0, () => 0.99).enemy.rarity.id).toBe("normal");
    expect(resolveAdventureNode(adventure, firstBranchNode, 0, () => 0.99).enemy.rarity.id).toBe("normal");
    expect(resolveAdventureNode(choiceAdventure, firstChoiceNode, 0, () => 0.99).enemy.rarity.id).toBe("normal");
  });

  it("rolls combat rarity each time a later adventure node is resolved", () => {
    const node = adventure.routes[0].nodes[1];
    const normal = resolveAdventureNode(adventure, node, 0, () => 0.1);
    const rare = resolveAdventureNode(adventure, node, 0, () => 0.91);

    expect(normal.enemy.rarity.id).toBe("normal");
    expect(rare.enemy.rarity.id).toBe("raro");
  });

  it("resolves combat nodes with multiple enemy ids as one simultaneous encounter", () => {
    const groupNode = {
      id: "forest_pack",
      type: "combat",
      enemyIds: ["blood_rat", "crow_swarm"],
      noRarity: true,
      next: [],
    };
    const groupAdventure = {
      id: "test_group_encounter",
      zoneId: "ancient_forest",
      routes: [{ id: "main", nodes: [groupNode] }],
    };

    const combat = resolveAdventureNode(groupAdventure, groupNode, 0, () => 0.1);

    expect(combat.type).toBe("combat");
    expect(combat.enemy.id).toBe("blood_rat");
    expect(combat.enemies.map(enemy => enemy.id)).toEqual(["blood_rat", "crow_swarm"]);
    expect(combat.bossDeathEndsFight).toBe(false);
  });

  it("rolls rarity independently for enemies in the same adventure encounter", () => {
    const introNode = {
      id: "forest_intro",
      type: "combat",
      enemyId: "blood_rat",
      noRarity: true,
      next: ["forest_pack_rarity"],
    };
    const groupNode = {
      id: "forest_pack_rarity",
      type: "combat",
      enemyIds: ["blood_rat", "crow_swarm"],
      stepIndex: 1,
      next: [],
    };
    const groupAdventure = {
      id: "test_group_rarity",
      zoneId: "ancient_forest",
      routes: [{ id: "main", nodes: [introNode, groupNode] }],
    };
    const rolls = [0.91, 0.1];

    const combat = resolveAdventureNode(groupAdventure, groupNode, 0, () => rolls.shift() ?? 0.1);

    expect(combat.enemies.map(enemy => enemy.rarity.id)).toEqual(["raro", "normal"]);
  });

  it("preserves duplicate enemy ids for authored pack encounters", () => {
    const groupNode = {
      id: "orc_patrol_pair",
      type: "combat",
      enemyIds: ["orc_patrol", "orc_patrol"],
      noRarity: true,
      next: [],
    };
    const groupAdventure = {
      id: "test_duplicate_group_encounter",
      zoneId: "orc_war_camp",
      routes: [{ id: "main", nodes: [groupNode] }],
    };

    const combat = resolveAdventureNode(groupAdventure, groupNode, 0, () => 0.1);

    expect(combat.enemies.map(enemy => enemy.id)).toEqual(["orc_patrol", "orc_patrol"]);
    expect(combat.bossDeathEndsFight).toBe(false);
  });

  it("keeps Orc War Camp pack fights and cave troll before the boss", () => {
    const orcAdventure = adventureById.orc_war_camp;
    const nodes = orcAdventure.routes[0].nodes;
    const gate = nodes.find(node => node.id === "orc_gate");
    const cache = nodes.find(node => node.id === "orc_cache");
    const firstWargPack = nodes.find(node => node.id === "warg_pack_1");
    const smallTroll = nodes.find(node => node.id === "small_troll");
    const wargPack = nodes.find(node => node.id === "warg_pack_2");
    const caveTroll = nodes.find(node => node.id === "cave_troll");
    const bossNode = nodes.find(node => node.type === "boss");

    expect(orcAdventure.choiceRun).toBe(false);
    expect(gate.enemyIds).toEqual(["orc_patrol", "orc_patrol"]);
    expect(firstWargPack.next).toEqual(["small_troll"]);
    expect(smallTroll).toMatchObject({
      type: "combat",
      enemyId: "troll_small",
      next: ["warg_pack_2"],
    });
    expect(wargPack.enemyIds).toEqual(["orc_patrol", "warg"]);
    expect(caveTroll).toMatchObject({
      type: "combat",
      enemyId: "cave_troll",
      encounterRole: "special",
      next: ["orc_shaman_boss"],
    });
    expect(nodes.find(node => node.id === "orc_berserker_2").next).toEqual(["cave_troll"]);
    expect(bossNode.bossIds).toEqual(["orc_general", "orc_shaman"]);
    expect(cache.event.effects).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "grant_gold" }),
    ]));
    expect(cache.event.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "grant_loot", lootPoolId: "orc_war_camp", rolls: 1 }),
    ]));
    expect(enemyById.warg.baseStats.attackSpeed).toBeGreaterThan(1);

    const combat = resolveAdventureNode(orcAdventure, gate, 0, () => 0.1);
    expect(combat.enemies.map(enemy => enemy.id)).toEqual(["orc_patrol", "orc_patrol"]);
    const smallTrollCombat = resolveAdventureNode(orcAdventure, smallTroll, 0, () => 0.1);
    expect(smallTrollCombat.enemies.map(enemy => enemy.id)).toEqual(["troll_small"]);

    const initialRun = createInitialAdventureProgress(orcAdventure);
    expect(initialRun.choiceRun).toBeUndefined();
    expect(getAdventureChoiceNodes(orcAdventure, initialRun).map(node => node.id)).toEqual(["orc_gate"]);
  });

  it("repairs old Orc War Camp progress from orc_troll to small_troll", () => {
    const orcAdventure = adventureById.orc_war_camp;
    const normalized = normalizeAdventureProgress(orcAdventure, {
      selectedRouteId: "orc_assault_path",
      selectedNodeId: "orc_troll",
      unlockedNodes: ["orc_gate", "warg_pack_1", "orc_troll"],
      completedNodes: ["orc_gate", "orc_berserker_1", "orc_cache", "warg_pack_1"],
      suppressedNodes: [],
      encounterPools: {
        orc_troll: { cap: 1, defeated: 0 },
      },
      secrets: [],
    });

    expect(normalized.selectedNodeId).toBe("small_troll");
    expect(normalized.unlockedNodes).toContain("small_troll");
    expect(normalized.unlockedNodes).not.toContain("orc_troll");
    expect(normalized.encounterPools.small_troll).toEqual({ cap: 1, defeated: 0 });
  });

  it("rolls either Orc War Camp boss from the shared boss node", () => {
    const orcAdventure = adventureById.orc_war_camp;
    const bossNode = orcAdventure.routes[0].nodes.find(node => node.type === "boss");

    const general = resolveAdventureNode(orcAdventure, bossNode, 0, () => 0.1);
    const shaman = resolveAdventureNode(orcAdventure, bossNode, 0, () => 0.9);
    const selectedOnWalk = resolveAdventureNode({
      ...orcAdventure,
      __progress: { bossRolls: { [bossNode.id]: "orc_shaman" } },
    }, bossNode, 0, () => 0.1);

    expect(general.enemy.id).toBe("orc_general");
    expect(shaman.enemy.id).toBe("orc_shaman");
    expect(selectedOnWalk.enemy.id).toBe("orc_shaman");
    expect(bossById.orc_general.sprite).toBe("/assets/sprites/encounters/Bosses/Orc general.png");
    expect(bossById.orc_shaman).toBeDefined();
  });

  it("treats waypoint connectors as walkable route nodes", () => {
    const waypointAdventure = {
      id: "test_waypoint_paths",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [
          { id: "entry", type: "combat", enemyId: "wolf", next: ["junction"] },
          { id: "junction", type: "waypoint", next: ["ambush", "rat"] },
          { id: "ambush", type: "combat", enemyId: "forest_bandit", next: [] },
          { id: "rat", type: "combat", enemyId: "blood_rat", next: [] },
        ],
      }],
    };

    let progress = createInitialAdventureProgress(waypointAdventure);
    progress = completeNode(waypointAdventure, progress, "entry");
    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("ambush")).toBe(true);
    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("rat")).toBe(true);
    progress = selectNode(waypointAdventure, progress, "junction");

    const junction = waypointAdventure.routes[0].nodes[1];
    expect(resolveAdventureNode(waypointAdventure, junction)?.type).toBe("waypoint");
    expect(progress.selectedNodeId).toBe("junction");
    expect(isNodeCompleted(progress, "junction")).toBe(true);
    expect(isNodeKnown(progress, "ambush")).toBe(true);
    expect(canPlayNode(junction, progress)).toBe(true);
  });

  it("allows encounters connected through a waypoint to be selected directly", () => {
    const waypointAdventure = {
      id: "test_waypoint_encounter_visibility",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [
          { id: "entry", type: "combat", enemyId: "wolf", next: ["junction"] },
          { id: "junction", type: "waypoint", next: ["ambush"] },
          { id: "ambush", type: "combat", enemyId: "forest_bandit", next: [] },
        ],
      }],
    };

    let progress = createInitialAdventureProgress(waypointAdventure);
    progress = completeNode(waypointAdventure, progress, "entry");
    progress = selectNode(waypointAdventure, progress, "ambush");

    expect(progress.selectedNodeId).toBe("ambush");
    expect(isNodeKnown(progress, "ambush")).toBe(true);
  });

  it("reveals encounters behind chained waypoints", () => {
    const waypointAdventure = {
      id: "test_chained_waypoints",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [
          { id: "entry", type: "combat", enemyId: "wolf", next: ["junction_a"] },
          { id: "junction_a", type: "waypoint", next: ["junction_b"] },
          { id: "junction_b", type: "waypoint", next: ["ambush"] },
          { id: "ambush", type: "combat", enemyId: "forest_bandit", next: [] },
        ],
      }],
    };

    let progress = createInitialAdventureProgress(waypointAdventure);
    progress = completeNode(waypointAdventure, progress, "entry");

    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("junction_a")).toBe(true);
    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("junction_b")).toBe(true);
    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("ambush")).toBe(true);
  });

  it("treats waypoint chains as roads even when a waypoint link was drawn backwards", () => {
    const waypointAdventure = {
      id: "test_reversed_waypoint_link",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [
          { id: "entry", type: "combat", enemyId: "wolf", next: ["junction_a"] },
          { id: "junction_a", type: "waypoint", next: [] },
          { id: "junction_b", type: "waypoint", next: ["junction_a"] },
          { id: "ambush", type: "combat", enemyId: "forest_bandit", next: ["junction_b"] },
        ],
      }],
    };

    let progress = createInitialAdventureProgress(waypointAdventure);
    progress = completeNode(waypointAdventure, progress, "entry");
    progress = selectNode(waypointAdventure, progress, "ambush");

    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("junction_b")).toBe(true);
    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("ambush")).toBe(true);
    expect(progress.selectedNodeId).toBe("ambush");
  });

  it("does not reveal nodes beyond an uncompleted combat just because it is selected", () => {
    const waypointAdventure = {
      id: "test_selected_combat_does_not_unlock_road",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [
          { id: "entry", type: "combat", enemyId: "wolf", next: ["junction"] },
          { id: "junction", type: "waypoint", next: ["ambush"] },
          { id: "ambush", type: "combat", enemyId: "forest_bandit", next: ["exit_waypoint"] },
          { id: "exit_waypoint", type: "waypoint", next: ["boss"] },
          { id: "boss", type: "boss", bossId: "elder_stag", next: [] },
        ],
      }],
    };

    let progress = createInitialAdventureProgress(waypointAdventure);
    progress = completeNode(waypointAdventure, progress, "entry");
    progress = selectNode(waypointAdventure, progress, "ambush");

    expect(progress.selectedNodeId).toBe("ambush");
    expect(isNodeCompleted(progress, "ambush")).toBe(false);
    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("exit_waypoint")).toBe(false);
    expect(getWaypointReachableNodeIds(waypointAdventure, progress).has("boss")).toBe(false);
  });

  it("does not treat empty story events as waypoints", () => {
    const storyAdventure = {
      id: "test_empty_story_event",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [
          { id: "entry", type: "combat", enemyId: "wolf", next: ["story"] },
          { id: "story", type: "event", next: ["ambush"], event: { id: "story_event", title: "New Event", description: "", effects: [] } },
          { id: "ambush", type: "combat", enemyId: "forest_bandit", next: [] },
        ],
      }],
    };

    let progress = createInitialAdventureProgress(storyAdventure);
    progress = completeNode(storyAdventure, progress, "entry");

    expect(getWaypointReachableNodeIds(storyAdventure, progress).has("story")).toBe(false);
    expect(getWaypointReachableNodeIds(storyAdventure, progress).has("ambush")).toBe(false);
  });

  it("keeps legacy empty connector events walkable without requiring Explore", () => {
    const legacyConnectorAdventure = {
      id: "test_legacy_connector_paths",
      zoneId: "ancient_forest",
      routes: [{
        id: "main",
        nodes: [
          { id: "entry", type: "combat", enemyId: "wolf", next: ["junction"] },
          {
            id: "junction",
            type: "event",
            next: ["ambush"],
            event: { id: "junction_event", title: "Connector", description: "A mapped path connector.", effects: [] },
          },
          { id: "ambush", type: "combat", enemyId: "forest_bandit", next: [] },
        ],
      }],
    };

    let progress = createInitialAdventureProgress(legacyConnectorAdventure);
    progress = completeNode(legacyConnectorAdventure, progress, "entry");
    progress = selectNode(legacyConnectorAdventure, progress, "junction");

    const junction = legacyConnectorAdventure.routes[0].nodes[1];
    expect(resolveAdventureNode(legacyConnectorAdventure, junction)?.type).toBe("waypoint");
    expect(progress.selectedNodeId).toBe("junction");
    expect(isNodeCompleted(progress, "junction")).toBe(true);
    expect(isNodeKnown(progress, "ambush")).toBe(true);
    expect(canPlayNode(junction, progress)).toBe(true);
  });

  it("keeps entrance and world-exit events separate from waypoints", () => {
    const entrance = {
      id: "forest_entrance",
      type: "event",
      next: ["path"],
      event: { id: "forest_entrance_event", title: "Forest Entrance", description: "Back to the world.", effects: [] },
    };
    const exit = {
      id: "forest_exit",
      type: "event",
      next: [],
      event: { id: "forest_exit_event", title: "Exit", description: "Leave.", effects: [{ type: "leave_adventure", actionLabel: "Exit" }] },
    };
    const progress = { unlockedNodes: ["forest_exit"], completedNodes: ["forest_exit"] };

    expect(isWaypointNode(entrance)).toBe(false);
    expect(isWaypointNode(exit)).toBe(false);
    expect(canPlayNode(exit, progress)).toBe(true);
  });

  it("generates procedural choice runs without a hidden combat difficulty curve", () => {
    const choiceAdventure = {
      id: "test_choice_run",
      proceduralChoices: true,
      zoneId: "ancient_forest",
      lootPoolId: "ancient_forest",
      name: "Choice Run",
      routes: [],
    };

    const progress = createInitialAdventureProgress(choiceAdventure);
    const route = progress.choiceRun.route;
    const layers = new Map();
    for (const node of route.nodes) {
      layers.set(node.stepIndex, [...(layers.get(node.stepIndex) || []), node]);
    }

    expect(progress.choiceRun.stepCount).toBeGreaterThanOrEqual(5);
    expect(layers.size).toBe(progress.choiceRun.stepCount);
    for (const layer of layers.values()) {
      expect(layer.length).toBeGreaterThanOrEqual(1);
      expect(layer.length).toBeLessThanOrEqual(3);
    }

    const earlyCombatNodes = route.nodes.filter(node => node.type === "combat" && node.stepIndex <= 1);
    expect(earlyCombatNodes.length).toBeGreaterThan(0);
    expect(earlyCombatNodes.every(node => node.difficulty === "easy")).toBe(true);
    expect(earlyCombatNodes.every(node => enemyById[node.enemyId]?.threat === "minor")).toBe(true);

    const laterCombatNodes = route.nodes.filter(node => node.type === "combat" && node.stepIndex > 1 && node.encounterRole !== "multi" && node.encounterRole !== "special");
    expect(laterCombatNodes.length).toBeGreaterThan(0);
    expect(laterCombatNodes.every(node => node.difficulty === "medium")).toBe(true);
    expect(laterCombatNodes.every(node => ["minor", "standard"].includes(enemyById[node.enemyId]?.threat))).toBe(true);
    expect(route.nodes.some(node => node.difficulty === "hard" || node.encounterRole === "hard")).toBe(false);

    const multiNodes = route.nodes.filter(node => node.encounterRole === "multi");
    expect(multiNodes).toHaveLength(0);

    const chestNodes = route.nodes.filter(node => node.encounterRole === "chest");
    expect(chestNodes).toHaveLength(1);
    expect(route.nodes.some(node => node.type === "combat" && node.encounterCap == null)).toBe(true);

    const finalLayer = layers.get(progress.choiceRun.stepCount - 1);
    expect(finalLayer).toHaveLength(1);
    expect(finalLayer[0].type).toBe("boss");
  });

  it("keeps Ancient Forest generated combat nodes on the same threat band", () => {
    const progress = createInitialAdventureProgress(adventureById.dungeon_depths);
    const earlyCombatNodes = progress.choiceRun.route.nodes.filter(node => node.type === "combat" && node.stepIndex <= 1);
    const laterCombatNodes = progress.choiceRun.route.nodes.filter(node => node.type === "combat" && node.stepIndex > 1 && node.encounterRole !== "special" && node.encounterRole !== "multi");
    const bossNode = progress.choiceRun.route.nodes.find(node => node.type === "boss");
    const specialNodes = progress.choiceRun.route.nodes.filter(node => node.encounterRole === "special");
    const armoredBearNode = specialNodes.find(node => node.enemyId === "armored_bear");

    expect(progress.choiceRun.stepCount).toBe(10);
    expect(earlyCombatNodes.length).toBeGreaterThan(0);
    expect(earlyCombatNodes.every(node => enemyById[node.enemyId]?.threat === "minor")).toBe(true);
    expect(earlyCombatNodes.every(node => node.difficulty === "easy")).toBe(true);
    expect(laterCombatNodes.length).toBeGreaterThan(0);
    expect(laterCombatNodes.some(node => node.enemyId === "forest_spirit")).toBe(false);
    expect(laterCombatNodes.every(node => ["minor", "standard"].includes(enemyById[node.enemyId]?.threat))).toBe(true);
    expect(laterCombatNodes.every(node => node.difficulty === "medium")).toBe(true);
    expect(armoredBearNode).toBeTruthy();
    expect(armoredBearNode.stepIndex).toBe(bossNode.stepIndex - 1);
    expect(progress.choiceRun.route.nodes.filter(node => node.stepIndex === armoredBearNode.stepIndex)).toHaveLength(1);
  });

  it("includes the full Ancient Forest enemy pool and floor 2 enemies in choice runs", () => {
    const poolIds = getChoiceRunEnemyPoolIds(adventureById.dungeon_depths);

    expect(poolIds).toEqual(expect.arrayContaining([
      "wolf",
      "blood_rat",
      "crow_swarm",
      "boar",
      "forest_bandit",
      "forest_spirit",
      "forest_wisp",
      "white_wolf",
      "armored_bear",
    ]));
  });

  it("keeps Ancient Forest choice-run bosses fixed to Elder Stag", () => {
    const fresh = createInitialAdventureProgress(adventureById.dungeon_depths);
    const bossNode = fresh.choiceRun.route.nodes.find(node => node.type === "boss");
    const resolvedBoss = resolveAdventureNode(adventureById.dungeon_depths, bossNode, 0, () => 0.99);

    expect(bossNode.bossId).toBe("elder_stag");
    expect(resolvedBoss.enemy.id).toBe("elder_stag");
  });

  it("repairs saved Ancient Forest choice runs that still point at Lich", () => {
    const fresh = createInitialAdventureProgress(adventureById.dungeon_depths);
    const stale = {
      ...fresh,
      choiceRun: {
        ...fresh.choiceRun,
        route: {
          ...fresh.choiceRun.route,
          nodes: fresh.choiceRun.route.nodes.map(node => (
            node.type === "boss" ? { ...node, bossId: "lich" } : node
          )),
        },
      },
    };

    const normalized = normalizeAdventureProgress(adventureById.dungeon_depths, stale);
    const bossNode = normalized.choiceRun.route.nodes.find(node => node.type === "boss");
    const resolvedBoss = resolveAdventureNode(adventureById.dungeon_depths, bossNode, 0, () => 0.99);

    expect(bossNode.bossId).toBe("elder_stag");
    expect(resolvedBoss.enemy.id).toBe("elder_stag");
  });

  it("uses Crypts floor 1 skeleton multi-combat and a fixed floor 2 Giant Spider fight", () => {
    const floor1 = createInitialAdventureProgress(adventureById.crypts);
    const floor1Multi = floor1.choiceRun.route.nodes.find(node => node.encounterRole === "multi");
    const floor1Chest = floor1.choiceRun.route.nodes.find(node => node.encounterRole === "chest");
    const floor1ChestLoot = floor1Chest.event.effects.find(effect => effect.type === "grant_loot");
    expect(floor1Multi.sourceEncounterTableId).toBe("crypts_floor_1_multi");
    expect([
      ["skeleton", "skeleton"],
      ["skeleton", "zombie"],
    ]).toContainEqual(floor1Multi.enemyIds);
    expect(floor1ChestLoot).toMatchObject({ lootTable: "crypts_chest_equipment", rolls: 1 });

    const floor2 = createInitialAdventureProgress(adventureById.crypts_floor_2);
    const floor2Route = adventureById.crypts_floor_2.routes[0];
    const floor2Encounter = floor2Route.nodes.find(node => node.id === "crypts_floor_2_encounter");
    const floor2Boss = floor2Route.nodes.find(node => node.type === "boss");
    const resolvedSpider = resolveAdventureNode(adventureById.crypts_floor_2, floor2Encounter, 0, () => 0.1);
    const resolvedSpiderPack = resolveAdventureNode(adventureById.crypts_floor_2, floor2Encounter, 0, () => 0.99);
    const resolvedBoss = resolveAdventureNode(adventureById.crypts_floor_2, floor2Boss, 0, () => 0.1);

    expect(floor2.choiceRun).toBeUndefined();
    expect(getAdventureChoiceNodes(adventureById.crypts_floor_2, floor2).map(node => node.id)).toEqual(["crypts_floor_2_encounter"]);
    expect(resolvedSpider.enemies.map(enemy => enemy.id)).toEqual(["giant_spider"]);
    expect(resolvedSpiderPack.enemies.map(enemy => enemy.id)).toEqual(["giant_spider", "skeleton"]);
    expect(resolvedSpiderPack.bossDeathEndsFight).toBe(false);
    expect(floor2Boss.bossId).toBe("lich");
    expect(resolvedBoss.enemy).toMatchObject({
      id: "lich",
      sprite: "/assets/sprites/encounters/Bosses/Lich_boss.png",
    });
  });

  it("normalizes saved Crypts floor 2 choice runs back to the fixed spider path", () => {
    const stale = {
      selectedRouteId: "crypts_floor_2_choice_run",
      selectedNodeId: "crypts_floor_2_choice_4_0_boss",
      unlockedNodes: ["crypts_floor_2_choice_4_0_boss"],
      completedNodes: [],
      secrets: [],
      choiceRun: {
        schema: 1,
        route: {
          id: "crypts_floor_2_choice_run",
          nodes: [
            { id: "crypts_floor_2_choice_4_0_boss", type: "boss", bossId: "elder_stag", stepIndex: 4, choiceIndex: 0 },
          ],
        },
      },
    };

    const normalized = normalizeAdventureProgress(adventureById.crypts_floor_2, stale);

    expect(normalized.choiceRun).toBeUndefined();
    expect(normalized.selectedRouteId).toBe("crypts_floor_2_path");
    expect(normalized.unlockedNodes).toContain("crypts_floor_2_encounter");
    expect(getAdventureChoiceNodes(adventureById.crypts_floor_2, normalized).map(node => node.id)).toEqual(["crypts_floor_2_encounter"]);
  });

  it("keeps the current procedural choice layer available until combat starts", () => {
    const choiceAdventure = {
      id: "test_choice_progression",
      proceduralChoices: true,
      zoneId: "ancient_forest",
      lootPoolId: "ancient_forest",
      name: "Choice Progression",
      routes: [],
    };
    const route = {
      id: "test_choice_progression_choice_run",
      nodes: [
        { id: "choice_a", type: "combat", stepIndex: 0, choiceIndex: 0, enemyId: "wolf", next: ["choice_c"] },
        { id: "choice_b", type: "combat", stepIndex: 0, choiceIndex: 1, enemyId: "blood_rat", next: ["choice_c"] },
        { id: "choice_d", type: "combat", stepIndex: 0, choiceIndex: 2, enemyId: "boar", next: ["choice_c"] },
        { id: "choice_c", type: "boss", stepIndex: 1, choiceIndex: 0, bossId: "elder_stag", next: [] },
      ],
    };
    let progress = {
      selectedRouteId: route.id,
      selectedNodeId: null,
      unlockedNodes: ["choice_a", "choice_b", "choice_d"],
      completedNodes: [],
      secrets: [],
      bossCompleted: false,
      choiceRun: { schema: 1, seed: 1, stepCount: 2, route },
    };
    let firstChoices = getAdventureChoiceNodes(choiceAdventure, progress);
    const firstChoice = firstChoices[0];

    progress = selectNode(choiceAdventure, progress, firstChoice.id);
    expect(progress.selectedNodeId).toBe(firstChoice.id);
    expect(getAdventureChoiceNodes(choiceAdventure, progress).map(node => node.id)).toEqual(["choice_a", "choice_b", "choice_d"]);

    progress = selectNode(choiceAdventure, progress, "choice_b");
    expect(progress.selectedNodeId).toBe("choice_b");
    firstChoices = getAdventureChoiceNodes(choiceAdventure, progress);
    expect(firstChoices.map(node => node.id)).toEqual(["choice_a", "choice_b", "choice_d"]);
    expect(getAdventureChoiceNodes(choiceAdventure, { ...progress, unlockedNodes: ["choice_b"] }).map(node => node.id)).toEqual(["choice_a", "choice_b", "choice_d"]);

    progress = completeNode(choiceAdventure, progress, "choice_b", { encounterCap: 1 });
    const nextChoices = getAdventureChoiceNodes(choiceAdventure, progress);

    expect(nextChoices.map(node => node.id)).toEqual(["choice_c"]);
    expect(nextChoices.some(node => firstChoices.map(choice => choice.id).includes(node.id))).toBe(false);
  });

  it("lets a choice-run combat continue forward before its repeat pool is depleted", () => {
    const choiceAdventure = {
      id: "test_choice_continue",
      proceduralChoices: true,
      zoneId: "ancient_forest",
      lootPoolId: "ancient_forest",
      name: "Choice Continue",
      routes: [],
    };
    const route = {
      id: "test_choice_continue_choice_run",
      nodes: [
        { id: "choice_a", type: "combat", stepIndex: 0, choiceIndex: 0, enemyId: "wolf", next: ["choice_c"] },
        { id: "choice_c", type: "boss", stepIndex: 1, choiceIndex: 0, bossId: "elder_stag", next: [] },
      ],
    };
    let progress = {
      selectedRouteId: route.id,
      selectedNodeId: "choice_a",
      unlockedNodes: ["choice_a"],
      completedNodes: [],
      secrets: [],
      bossCompleted: false,
      choiceRun: { schema: 1, seed: 1, stepCount: 2, route },
    };

    progress = completeNode(choiceAdventure, progress, "choice_a", { encounterCap: 3 });
    expect(getNodeEncounterPool(progress, "choice_a")).toEqual({ defeated: 1, cap: 3 });
    expect(getAdventureChoiceNodes(choiceAdventure, progress).map(node => node.id)).toEqual(["choice_a"]);

    progress = continueFromCompletedNode(choiceAdventure, progress, "choice_a");

    expect(progress.selectedNodeId).toBeNull();
    expect(getAdventureChoiceNodes(choiceAdventure, progress).map(node => node.id)).toEqual(["choice_c"]);
  });

  it("can unlock and select a hidden follow-up card from an event result", () => {
    const hiddenAdventure = {
      id: "test_hidden_unlock",
      zoneId: "ancient_forest",
      regionId: "test_region",
      name: "Hidden Unlock",
      description: "Fixture adventure for hidden card routing.",
      routes: [
        {
          id: "hidden_path",
          nodes: [
            { id: "nest_event", type: "event", stepIndex: 0, next: ["normal_path"], event: { id: "nest_event_data", title: "Nest", effects: [] } },
            { id: "normal_path", type: "combat", stepIndex: 2, enemyId: "wolf", next: [] },
            { id: "hidden_ambush", type: "combat", stepIndex: 1, enemyId: "blood_rat", next: ["normal_path"] },
          ],
        },
      ],
    };
    let progress = createInitialAdventureProgress(hiddenAdventure);

    progress = completeNode(hiddenAdventure, progress, "nest_event", {
      unlockNodeIds: ["hidden_ambush"],
      selectedNodeId: "hidden_ambush",
    });

    expect(progress.unlockedNodes).toEqual(expect.arrayContaining(["normal_path", "hidden_ambush"]));
    expect(progress.selectedNodeId).toBe("hidden_ambush");
    expect(getAdventureChoiceNodes(hiddenAdventure, progress).map(node => node.id)).toEqual(["hidden_ambush"]);
  });

  it("ships Rootspire Tower as four linked card floors with question, trap, rest, and boss nodes", () => {
    const floor1 = adventureById.rootspire_floor_1;
    const floor2 = adventureById.rootspire_floor_2;
    const floor3 = adventureById.rootspire_floor_3;
    const rooftop = adventureById.rootspire_rooftop;
    const nodesFor = adventure => adventure.routes.flatMap(route => route.nodes);
    const byId = adventure => Object.fromEntries(nodesFor(adventure).map(node => [node.id, node]));

    expect(floor1).toMatchObject({ zoneId: "rootspire_tower", regionId: "rootspire_tower_region", choiceRun: false });
    expect(floor2).toMatchObject({ zoneId: "rootspire_tower", choiceRun: false });
    expect(floor3).toMatchObject({ zoneId: "rootspire_tower", choiceRun: false });
    expect(rooftop).toMatchObject({ bossId: "wyvern", zoneId: "rootspire_tower", choiceRun: false });
    expect(floor1.mapImage).toBeUndefined();

    expect(byId(floor1).rootspire_floor_2_stairs.event.effects).toContainEqual(expect.objectContaining({ type: "enter_adventure", adventureId: "rootspire_floor_2" }));
    expect(byId(floor2).rootspire_floor_3_stairs.event.effects).toContainEqual(expect.objectContaining({ type: "enter_adventure", adventureId: "rootspire_floor_3" }));
    expect(byId(floor3).rootspire_rooftop_stairs.event.effects).toContainEqual(expect.objectContaining({ type: "enter_adventure", adventureId: "rootspire_rooftop" }));
    expect(byId(floor1).rootspire_breach_gargoyles).toMatchObject({
      enemyId: "gargoyle",
      difficulty: "medium",
    });
    expect(byId(floor1).rootspire_breach_gargoyles.enemyIds).toBeUndefined();
    expect(byId(floor1).rootspire_breach_gargoyles.next).toEqual(["rootspire_restless_skeletons"]);
    expect(resolveAdventureNode(floor1, byId(floor1).rootspire_breach_gargoyles, 0, () => 0.1).enemies.map(enemy => enemy.id)).toEqual(["gargoyle"]);
    expect(getAdventureEncounterCap(byId(floor1).rootspire_breach_gargoyles)).toBe(1);
    expect(getAdventureEncounterCap({ generatedChoice: true, repeatPool: "limited" })).toBe(3);
    const repairedGargoyleProgress = normalizeAdventureProgress(floor1, {
      selectedRouteId: "rootspire_breach_path",
      selectedNodeId: "rootspire_breach_gargoyles",
      unlockedNodes: ["rootspire_floor_1_entrance", "rootspire_breach_gargoyles"],
      completedNodes: ["rootspire_floor_1_entrance", "rootspire_breach_gargoyles"],
      encounterPools: {
        rootspire_breach_gargoyles: {
          cap: 2,
          defeated: 1,
          lastEnemies: [{ id: "gargoyle" }, { id: "gargoyle" }],
        },
      },
      secrets: [],
      bossCompleted: false,
    });
    expect(getNodeEncounterPool(repairedGargoyleProgress, "rootspire_breach_gargoyles")).toMatchObject({ cap: 1, defeated: 1 });
    expect(getAdventureChoiceNodes(floor1, repairedGargoyleProgress).map(node => node.id)).toEqual(["rootspire_restless_skeletons"]);
    expect(byId(floor1).rootspire_old_knight_journal.event.sprite).toBe("/assets/sprites/Events/Scroll%20event.png?v=20260508");
    expect(byId(floor1).rootspire_old_knight_journal.next).toEqual(["rootspire_floor_2_stairs"]);
    expect(byId(floor1).rootspire_restless_skeletons).toMatchObject({
      enemyId: "rootspire_restless_skeleton",
      enemyIds: [
        "rootspire_restless_skeleton",
        "rootspire_restless_skeleton",
        "rootspire_restless_skeleton",
      ],
      bossDeathEndsFight: false,
      addsDespawnOnBossDeath: false,
    });
    expect(byId(floor1).rootspire_restless_skeletons.next).toEqual(["rootspire_oathbound_patrol"]);
    expect(byId(floor1).rootspire_oathbound_patrol.next).toEqual(["rootspire_black_knight"]);
    expect(byId(floor1).rootspire_black_knight.next).toEqual(["rootspire_old_knight_journal"]);

    expect(byId(floor2).rootspire_abandoned_barracks.event.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "restore_hp_pct" }),
      expect.objectContaining({ type: "restore_energy" }),
    ]));
    expect(byId(floor2).rootspire_abandoned_barracks.choicePrompt).toEqual({
      title: "Oath Door Question",
      text: "A stone door asks what held the old order together.",
    });
    expect(byId(floor2).rootspire_abandoned_barracks.next).toEqual(["rootspire_answer_oath", "rootspire_answer_blood", "rootspire_answer_mellon"]);
    expect(byId(floor2).rootspire_answer_oath.next).toEqual(["rootspire_spellbound_sentinel"]);
    expect(byId(floor2).rootspire_answer_blood.next).toEqual(["rootspire_oath_guardians"]);
    expect(byId(floor2).rootspire_answer_mellon.next).toEqual(["rootspire_oath_guardians"]);
    expect(enemyById.spellbound_sentinel).toMatchObject({
      disableAutoAttack: true,
      baseStats: { attack: 0, armor: 10, attackSpeed: 0, spellDamage: 12 },
      effects: [],
    });
    expect(enemyById.spellbound_sentinel.abilities?.map(ability => ability.id)).toEqual([
      "spellbound_sentinel_shadow_bolt",
      "spellbound_sentinel_arcane_disruption",
      "spellbound_sentinel_binding_flash",
    ]);
    expect(byId(floor2).rootspire_arcane_wraiths).toMatchObject({
      enemyId: "ashbound_cultist",
      enemyIds: ["ashbound_cultist", "ashbound_cultist"],
    });
    expect([
      byId(floor2).rootspire_answer_oath,
      byId(floor2).rootspire_answer_blood,
      byId(floor2).rootspire_answer_mellon,
    ].map(node => ({
      title: node.event.title,
      description: node.event.description,
      answerOnly: node.answerOnly,
    }))).toEqual([
      { title: "Answer: The Oath", description: "", answerOnly: true },
      { title: "Answer: Blood", description: "", answerOnly: true },
      { title: "Answer: Mellon", description: "", answerOnly: true },
    ]);
    expect(byId(floor3).rootspire_ash_imp_nest.next).toEqual(["rootspire_cinder_salamander"]);
    expect(byId(floor3).rootspire_service_ladder).toBeUndefined();
    expect(byId(floor3).rootspire_cracked_stair).toBeUndefined();
    expect(byId(floor3).rootspire_cinder_salamander).toMatchObject({
      enemyId: "cinder_salamander",
      type: "combat",
      next: ["rootspire_wyvern_whelps_pair"],
    });
    expect(byId(floor3).rootspire_wyvern_whelps_pair.enemyIds).toEqual(["wyvern_whelp", "wyvern_whelp"]);
    expect(byId(floor3).rootspire_wyvern_whelps_pair.next).toEqual(["rootspire_wyvern_nest"]);
    expect(byId(floor3).rootspire_wyvern_nest.next).toEqual(["rootspire_nest_silent", "rootspire_nest_search", "rootspire_nest_break"]);
    expect(byId(floor3).rootspire_abyssal_fiend.enemyId).toBe("abyssal_fiend");
    expect(enemyById.abyssal_fiend).toMatchObject({
      name: "Riftbound Warden",
      threat: "special",
    });
    expect(enemyById.abyssal_fiend.abilities?.map(ability => ability.id)).toEqual([
      "abyssal_fiend_infernal_rend",
      "abyssal_fiend_abyssal_pulse",
    ]);
    expect(byId(floor3).rootspire_nest_silent.event.effects).toContainEqual(expect.objectContaining({
      type: "unlock_node_chance",
      chance: 0,
      targetNodeId: "rootspire_whelp_ambush_3",
      selectOnSuccess: true,
    }));
    expect(byId(floor3).rootspire_nest_search.event.effects).toContainEqual(expect.objectContaining({
      type: "unlock_node_chance",
      chance: 20,
      targetNodeId: "rootspire_whelp_ambush_3",
      selectOnSuccess: true,
    }));
    expect(byId(floor3).rootspire_nest_break.event.effects).toContainEqual(expect.objectContaining({
      type: "unlock_node_chance",
      chance: 100,
      targetNodeId: "rootspire_whelp_ambush_3",
      selectOnSuccess: true,
    }));
    expect(byId(floor3).rootspire_whelp_ambush_3.enemyIds).toEqual(["wyvern_whelp", "wyvern_whelp", "wyvern_whelp"]);
    expect(byId(floor3).rootspire_whelp_ambush_3.exclusiveChoice).toBe(true);
    let nestProgress = startAdventureProgress(floor3, createInitialAdventureProgress(floor3));
    nestProgress = completeNode(floor3, nestProgress, "rootspire_ash_imp_nest");
    nestProgress = selectNode(floor3, nestProgress, "rootspire_cinder_salamander");
    nestProgress = completeNode(floor3, nestProgress, "rootspire_cinder_salamander");
    nestProgress = selectNode(floor3, nestProgress, "rootspire_wyvern_whelps_pair");
    nestProgress = completeNode(floor3, nestProgress, "rootspire_wyvern_whelps_pair");
    expect(getAdventureChoiceNodes(floor3, nestProgress).map(node => node.id)).toEqual(["rootspire_wyvern_nest"]);
    nestProgress = selectNode(floor3, nestProgress, "rootspire_wyvern_nest");
    nestProgress = completeNode(floor3, nestProgress, "rootspire_wyvern_nest");
    expect(getAdventureChoiceNodes(floor3, nestProgress).map(node => node.id)).toEqual(["rootspire_nest_silent", "rootspire_nest_search", "rootspire_nest_break"]);
    const failedSearchProgress = completeNode(floor3, selectNode(floor3, nestProgress, "rootspire_nest_search"), "rootspire_nest_search");
    expect(failedSearchProgress.selectedNodeId).toBe("rootspire_abyssal_fiend");
    expect(failedSearchProgress.unlockedNodes).not.toEqual(expect.arrayContaining(["rootspire_nest_silent", "rootspire_nest_break", "rootspire_whelp_ambush_3"]));
    const failedSearchChoiceIds = getAdventureChoiceNodes(floor3, failedSearchProgress).map(node => node.id);
    expect(failedSearchChoiceIds).toContain("rootspire_abyssal_fiend");
    expect(failedSearchChoiceIds).not.toEqual(expect.arrayContaining(["rootspire_nest_silent", "rootspire_nest_break", "rootspire_whelp_ambush_3"]));
    const breakProgress = selectNode(floor3, nestProgress, "rootspire_nest_break");
    expect(getAdventureChoiceNodes(floor3, breakProgress).map(node => node.id)).toEqual(["rootspire_nest_break"]);
    const forcedAmbushProgress = completeNode(floor3, breakProgress, "rootspire_nest_break", {
      unlockNodeIds: ["rootspire_whelp_ambush_3"],
      selectedNodeId: "rootspire_whelp_ambush_3",
    });
    expect(forcedAmbushProgress.selectedNodeId).toBe("rootspire_whelp_ambush_3");
    expect(getAdventureChoiceNodes(floor3, forcedAmbushProgress).map(node => node.id)).toEqual(["rootspire_whelp_ambush_3"]);
    expect(byId(rooftop).rootspire_wyvern).toMatchObject({ type: "boss", bossId: "wyvern" });
    expect(bossById.wyvern.phases.some(phase => phase.effects.some(effect => effect.type === "defense_penalty_pct"))).toBe(true);
    expect(bossById.wyvern.dodgePhaseConfig.find(config => config.id === "wyvern_dodge_1")).toMatchObject({
      pattern: "fire_sweep_h",
      safeSpotCount: 4,
      waves: [{ safeSpotCount: 4 }],
    });
    expect(bossById.wyvern.dodgePhaseConfig.find(config => config.id === "wyvern_dodge_2")).toMatchObject({
      pattern: "dive_slash",
      safeSpotCount: 3,
      waves: [{ safeSpotCount: 3 }, { safeSpotCount: 2, warningMs: 1100 }],
    });
    expect(bossById.wyvern.dodgePhaseConfig.find(config => config.id === "wyvern_dodge_tail_1")).toMatchObject({
      pattern: "tail_swing", thresholdPct: 60, damageMult: 1.75, stunDurationTicks: 2,
    });
    // wyvern_dodge_tail and wyvern_dodge_tail_3 are guaranteed hits (no dodge grid) — damageMult 1.5
    expect(bossById.wyvern.dodgePhaseConfig.find(config => config.id === "wyvern_dodge_tail")).toBeUndefined();
    expect(bossById.wyvern.dodgePhaseConfig.find(config => config.id === "wyvern_dodge_tail_3")).toBeUndefined();
    expect(bossById.wyvern.dodgePhaseConfig.find(config => config.id === "wyvern_dodge_3")).toMatchObject({
      pattern: "scatter",
      safeSpotCount: 2,
      waves: [{ safeSpotCount: 2 }, { safeSpotCount: 1, warningMs: 900 }, { safeSpotCount: 1, warningMs: 900 }],
    });
    expect(bossById.wyvern.phases.map(phase => phase.stats.armor)).toEqual([56, 50, 42, 30]);
    expect(enemyById.dodge_test_enemy.dodgePhaseConfig.find(config => config.id === "test_dodge_tail")).toMatchObject({
      pattern: "tail_swing", thresholdPct: 100, damageMult: 1.75, stunDurationTicks: 2,
    });
    expect(enemyById.dodge_test_enemy.dodgePhaseConfig.find(config => config.id === "test_dodge_1")).toMatchObject({
      pattern: "fire_sweep_h",
      safeSpotCount: 4,
      waves: [{ safeSpotCount: 4 }],
    });
    expect(enemyById.dodge_test_enemy.dodgePhaseConfig.find(config => config.id === "test_dodge_2")).toMatchObject({
      pattern: "dive_slash",
      safeSpotCount: 3,
      waves: [{ safeSpotCount: 3 }, { safeSpotCount: 2, warningMs: 1100 }],
    });
    expect(enemyById.dodge_test_enemy.dodgePhaseConfig.find(config => config.id === "test_dodge_3")).toMatchObject({
      pattern: "scatter",
      safeSpotCount: 2,
      waves: [{ safeSpotCount: 2 }, { safeSpotCount: 1, warningMs: 900 }, { safeSpotCount: 1, warningMs: 900 }],
    });
    expect(enemyById.abyssal_fiend.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "burn_on_hit" })]));
    expect(enemyById.oathbound_squire).toBeTruthy();
    expect(enemyById.wyvern_whelp.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "burn_on_hit" })]));
  });

  it("keeps default fire patterns broad but escalates Wyvern and dodge-test mechanics into tighter wave sequences", () => {
    const gridTileCount = DODGE_GRID_COLS * DODGE_GRID_ROWS;
    const defaultFire = buildFireTiles("fire_sweep_h", {}, () => 0);
    const defaultScatter = buildFireTiles("scatter", {}, () => 0);
    const wyvernSweepFourSafe = buildFireTiles("fire_sweep_h", { safeSpotCount: 4 }, () => 0);
    const wyvernDiveTwoSafe = buildFireTiles("dive_slash", { safeSpotCount: 2 }, () => 0);
    const dodgeTestSweepFourSafe = buildFireTiles("fire_sweep_h", { safeSpotCount: 4 }, () => 0);
    const wyvernScatterOneSafe = buildFireTiles("scatter", { safeSpotCount: 1 }, () => 0);
    const wyvernWaves = bossById.wyvern.dodgePhaseConfig.map(config => normalizeDodgeWaves(config));
    const dodgeTestWaves = enemyById.dodge_test_enemy.dodgePhaseConfig.map(config => normalizeDodgeWaves(config));
    const wyvernWaveCounts = wyvernWaves.map(waves => waves.map(wave => wave.safeSpotCount));
    const dodgeTestWaveCounts = dodgeTestWaves.map(waves => waves.map(wave => wave.safeSpotCount));
    const extendedRevealMs = DEFAULT_DODGE_REVEAL_MS + DEFAULT_DODGE_REVEAL_EXTENSION_MS;

    // tail_swing: 3 consecutive columns covering all 4 rows (12 fire tiles), position varies by RNG.
    // rng()=0 → startCol=0, so columns 0-2 are fire; columns 3-5 are safe.
    const tailSwingLeft = buildFireTiles("tail_swing", {}, () => 0);
    expect(tailSwingLeft.size).toBe(12);
    expect(tailSwingLeft.has("0,0")).toBe(true);
    expect(tailSwingLeft.has("1,3")).toBe(true);
    expect(tailSwingLeft.has("2,2")).toBe(true);
    expect(tailSwingLeft.has("3,0")).toBe(false); // col 3 is outside the tail
    expect(tailSwingLeft.has("5,1")).toBe(false); // col 5 is safe
    // rng()≈1 → startCol=3, so columns 3-5 are fire; columns 0-2 are safe.
    const tailSwingRight = buildFireTiles("tail_swing", {}, () => 0.99);
    expect(tailSwingRight.size).toBe(12);
    expect(tailSwingRight.has("3,0")).toBe(true);
    expect(tailSwingRight.has("5,3")).toBe(true);
    expect(tailSwingRight.has("0,0")).toBe(false);
    expect(tailSwingRight.has("2,2")).toBe(false);
    // Pattern is always exactly 3 consecutive columns covering all 4 rows.
    for (const rngVal of [0, 0.25, 0.5, 0.75, 0.99]) {
      const fire = buildFireTiles("tail_swing", {}, () => rngVal);
      expect(fire.size).toBe(12);
      const cols = [...new Set([...fire].map(key => Number(key.split(",")[0])))].sort((a, b) => a - b);
      expect(cols).toHaveLength(3);
      expect(cols[1] - cols[0]).toBe(1);
      expect(cols[2] - cols[1]).toBe(1);
    }

    expect(gridTileCount - defaultFire.size).toBe(12);
    expect(gridTileCount - defaultScatter.size).toBe(14);
    expect(gridTileCount - wyvernSweepFourSafe.size).toBe(4);
    expect(gridTileCount - wyvernDiveTwoSafe.size).toBe(2);
    expect(gridTileCount - dodgeTestSweepFourSafe.size).toBe(4);
    expect(gridTileCount - wyvernScatterOneSafe.size).toBe(1);
    // tail_swing phases have undefined safeSpotCount (fixed geometry, not safeSpotCount-driven)
    expect(wyvernWaveCounts).toEqual([[4], [undefined], [3, 2], [2, 1, 1]]);
    expect(dodgeTestWaveCounts).toEqual([[undefined], [4], [3, 2], [2, 1, 1]]);
    expect(wyvernWaves.flat().every(wave => wave.revealMs === extendedRevealMs)).toBe(true);
    expect(dodgeTestWaves.flat().every(wave => wave.revealMs === extendedRevealMs)).toBe(true);
    expect(wyvernWaves[2][1].warningMs - wyvernWaves[2][1].revealMs).toBe(500); // dive_slash wave 2 (now index 2)
    expect(wyvernWaves[3][1].warningMs - wyvernWaves[3][1].revealMs).toBe(300); // scatter wave 2

    const phaseTwoSequence = createDodgeSequence(bossById.wyvern.dodgePhaseConfig.find(config => config.id === "wyvern_dodge_2"));
    const phaseTwoWaveOne = getDodgeSequenceWave(phaseTwoSequence, 0);
    const phaseTwoWaveTwo = getDodgeSequenceWave(phaseTwoSequence, 1);

    expect(phaseTwoSequence.waves).toHaveLength(2);
    expect(phaseTwoWaveOne).toMatchObject({ id: "wyvern_dodge_2_wave_1", safeSpotCount: 3, displayWaveIndex: 0, displayWaveCount: 2, waves: [] });
    expect(phaseTwoWaveTwo).toMatchObject({ id: "wyvern_dodge_2_wave_2", safeSpotCount: 2, displayWaveIndex: 1, displayWaveCount: 2, waves: [] });
    expect(phaseTwoWaveTwo.revealExtensionMs).toBe(0);

    const stalePhaseOne = createDodgeSequence({ id: "wyvern_dodge_1", pattern: "fire_sweep_h", safeSpotCount: [3, 4], warningMs: 1800, damage: 28 });
    const stalePhaseTwo = createDodgeSequence({ id: "wyvern_dodge_2", pattern: "dive_slash", safeSpotCount: [3, 4], warningMs: 1500, damage: 36 });
    const stalePhaseThree = createDodgeSequence({ id: "wyvern_dodge_3", pattern: "scatter", safeSpotCount: [3, 4], warningMs: 1200, damage: 44 });
    const staleDirectPhaseOneFire = buildFireTiles("fire_sweep_h", { id: "wyvern_dodge_1", safeSpotCount: [3, 4] }, () => 0);
    const stalePhaseThreeWaveTwoFire = buildFireTiles("scatter", getDodgeSequenceWave(stalePhaseThree, 1), () => 0);

    expect(stalePhaseOne.waves.map(wave => wave.safeSpotCount)).toEqual([4]);
    expect(stalePhaseTwo.waves.map(wave => wave.safeSpotCount)).toEqual([3, 2]);
    expect(stalePhaseThree.waves.map(wave => wave.safeSpotCount)).toEqual([2, 1, 1]);
    expect(gridTileCount - staleDirectPhaseOneFire.size).toBe(4);
    expect(gridTileCount - stalePhaseThreeWaveTwoFire.size).toBe(1);
  });

  it("exposes a dev Rootspire ability lab with repeatable no-reward mechanic cards", () => {
    const lab = adventureById.rootspire_ability_lab;
    const nodes = Object.fromEntries(lab.routes.flatMap(route => route.nodes).map(node => [node.id, node]));
    let progress = startAdventureProgress(lab, createInitialAdventureProgress(lab));

    expect(lab).toMatchObject({ zoneId: "training_yard", regionId: "rootspire_ability_lab_region", devOnly: true, noRewards: true, choiceLimit: 4 });
    expect(adventureById.dodge_test).toMatchObject({ zoneId: "training_yard", regionId: "dodge_test_region", devOnly: true });
    expect(regionById.fallen_knight_mechanics_lab_region).toMatchObject({
      name: "Fallen Knight Lab",
      x: 29,
      y: 18,
      devOnly: true,
      adventures: ["fallen_knight_mechanics_lab"],
    });
    expect(adventureById.fallen_knight_mechanics_lab).toMatchObject({
      zoneId: "training_yard",
      regionId: "fallen_knight_mechanics_lab_region",
      bossId: "fallen_knight_mechanics_dummy",
      devOnly: true,
      noRewards: true,
    });
    const fallenKnightLab = adventureById.fallen_knight_mechanics_lab;
    const fallenKnightLabNodes = Object.fromEntries(fallenKnightLab.routes.flatMap(route => route.nodes).map(node => [node.id, node]));
    const fallenKnightLabBoss = resolveAdventureNode(fallenKnightLab, fallenKnightLabNodes.fallen_knight_lab_boss, 0, () => 0);
    expect(fallenKnightLabBoss.enemy.id).toBe("fallen_knight_mechanics_dummy");
    expect(fallenKnightLabBoss.enemy.stats.attack).toBe(1);
    expect(fallenKnightLabBoss.enemy.phases.find(phase => phase.id === "called_to_judgment").effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "pillar_intermission", enemyId: "fallen_knight_test_oath_pillar", count: 4 }),
    ]));
    const dodgeTest = adventureById.dodge_test;
    const dodgeTestNodes = Object.fromEntries(dodgeTest.routes.flatMap(route => route.nodes).map(node => [node.id, node]));
    const dodgeTestRoom = resolveAdventureNode(dodgeTest, dodgeTestNodes.dodge_test_combat, 0, () => 0);
    expect(dodgeTestRoom.enemy.dodgePhaseConfig.find(config => config.id === "test_dodge_1")).toMatchObject({
      pattern: "fire_sweep_h",
      safeSpotCount: 4,
      waves: [{ safeSpotCount: 4 }],
    });
    expect(dodgeTestRoom.enemy.dodgePhaseConfig.find(config => config.id === "test_dodge_2")).toMatchObject({
      pattern: "dive_slash",
      safeSpotCount: 3,
      waves: [{ safeSpotCount: 3 }, { safeSpotCount: 2, warningMs: 1100 }],
    });
    expect(dodgeTestRoom.enemy.dodgePhaseConfig.find(config => config.id === "test_dodge_3")).toMatchObject({
      pattern: "scatter",
      safeSpotCount: 2,
      waves: [{ safeSpotCount: 2 }, { safeSpotCount: 1, warningMs: 900 }, { safeSpotCount: 1, warningMs: 900 }],
    });
    expect(getAdventureChoiceNodes(lab, progress).map(node => node.id)).toEqual([
      "rootspire_lab_target_dummy",
      "rootspire_lab_armored_wing",
      "rootspire_lab_fire_wing",
      "rootspire_lab_abyss_wing",
    ]);
    expect(nodes.rootspire_lab_target_dummy).toMatchObject({
      enemyId: "target_dummy",
      repeatable: true,
      noRarity: true,
      noRewards: true,
    });
    expect(dodgeTestNodes.dodge_test_target_dummy).toMatchObject({
      enemyId: "target_dummy",
      repeatable: true,
      noRarity: true,
      noRewards: true,
    });

    progress = selectNode(lab, progress, "rootspire_lab_armored_wing");
    progress = completeNode(lab, progress, "rootspire_lab_armored_wing");

    expect(getAdventureChoiceNodes(lab, progress).map(node => node.id)).toEqual([
      "rootspire_lab_oathbound_squire",
      "rootspire_lab_black_knight",
      "rootspire_lab_stone_golem",
    ]);
    expect(nodes.rootspire_lab_black_knight).toMatchObject({
      enemyId: "black_knight",
      repeatable: true,
      noRarity: true,
      noRewards: true,
    });

    let fireProgress = startAdventureProgress(lab, createInitialAdventureProgress(lab));
    fireProgress = selectNode(lab, fireProgress, "rootspire_lab_fire_wing");
    fireProgress = completeNode(lab, fireProgress, "rootspire_lab_fire_wing");
    expect(getAdventureChoiceNodes(lab, fireProgress).map(node => node.id)).toEqual([
      "rootspire_lab_ash_imp",
      "rootspire_lab_whelp_pair",
      "rootspire_lab_whelp_odds",
    ]);
    const nestChoiceProgress = selectNode(lab, fireProgress, "rootspire_lab_whelp_odds");
    expect(isNodeCompleted(nestChoiceProgress, "rootspire_lab_whelp_odds")).toBe(true);
    expect(getAdventureChoiceNodes(lab, nestChoiceProgress).map(node => node.id)).toEqual([
      "rootspire_lab_whelp_quiet",
      "rootspire_lab_whelp_search",
      "rootspire_lab_whelp_break",
    ]);
    expect([
      nodes.rootspire_lab_whelp_quiet,
      nodes.rootspire_lab_whelp_search,
      nodes.rootspire_lab_whelp_break,
    ].map(node => node.event.effects.find(effect => effect.type === "unlock_node_chance"))).toEqual([
      expect.objectContaining({ chance: 0, targetNodeId: "rootspire_lab_whelp_pack", selectOnSuccess: true }),
      expect.objectContaining({ chance: 20, targetNodeId: "rootspire_lab_whelp_pack", selectOnSuccess: true }),
      expect.objectContaining({ chance: 100, targetNodeId: "rootspire_lab_whelp_pack", selectOnSuccess: true }),
    ]);
    expect([
      nodes.rootspire_lab_whelp_quiet,
      nodes.rootspire_lab_whelp_search,
      nodes.rootspire_lab_whelp_break,
    ].map(node => node.exclusiveChoice)).toEqual([true, true, true]);
    const searchProgress = selectNode(lab, nestChoiceProgress, "rootspire_lab_whelp_search");
    expect(getAdventureChoiceNodes(lab, searchProgress).map(node => node.id)).toEqual(["rootspire_lab_whelp_search"]);
    const failedLabSearchProgress = completeNode(lab, searchProgress, "rootspire_lab_whelp_search");
    expect(failedLabSearchProgress.selectedNodeId).toBe("rootspire_lab_return");
    expect(failedLabSearchProgress.unlockedNodes).not.toEqual(expect.arrayContaining(["rootspire_lab_whelp_quiet", "rootspire_lab_whelp_break", "rootspire_lab_whelp_pack"]));
    expect(getAdventureChoiceNodes(lab, failedLabSearchProgress).map(node => node.id)).toEqual(["rootspire_lab_return"]);
    const ambushProgress = completeNode(lab, searchProgress, "rootspire_lab_whelp_search", {
      unlockNodeIds: ["rootspire_lab_whelp_pack"],
      selectedNodeId: "rootspire_lab_whelp_pack",
    });
    expect(ambushProgress.selectedNodeId).toBe("rootspire_lab_whelp_pack");
    expect(getAdventureChoiceNodes(lab, ambushProgress).map(node => node.id)).toEqual(["rootspire_lab_whelp_pack"]);
    expect(nodes.rootspire_lab_whelp_pack.enemyIds).toEqual(["wyvern_whelp", "wyvern_whelp", "wyvern_whelp"]);
    expect(nodes.rootspire_lab_whelp_pack.exclusiveChoice).toBe(true);
    const clearedAmbushProgress = completeNode(lab, ambushProgress, "rootspire_lab_whelp_pack");
    const repeatSearchProgress = selectNode(lab, clearedAmbushProgress, "rootspire_lab_whelp_search");
    const repeatedAmbushProgress = completeNode(lab, repeatSearchProgress, "rootspire_lab_whelp_search", {
      unlockNodeIds: ["rootspire_lab_whelp_pack"],
      selectedNodeId: "rootspire_lab_whelp_pack",
    });
    expect(isNodeCompleted(repeatedAmbushProgress, "rootspire_lab_whelp_pack")).toBe(true);
    expect(canPlayNode(nodes.rootspire_lab_whelp_pack, repeatedAmbushProgress)).toBe(true);
    expect(getAdventureChoiceNodes(lab, repeatedAmbushProgress).map(node => node.id)).toEqual(["rootspire_lab_whelp_pack"]);

    let eventProgress = startAdventureProgress(lab, createInitialAdventureProgress(lab));
    eventProgress = selectNode(lab, eventProgress, "rootspire_lab_abyss_wing");
    eventProgress = completeNode(lab, eventProgress, "rootspire_lab_abyss_wing");
    expect(getAdventureChoiceNodes(lab, eventProgress).map(node => node.id)).toEqual([
      "rootspire_lab_old_knight_journal",
      "rootspire_lab_oath_door",
      "rootspire_lab_abyssal_fiend",
    ]);
    expect(nodes.rootspire_lab_old_knight_journal.event.description).toContain("Stone remembers the oath");
    expect(nodes.rootspire_lab_old_knight_journal.event.sprite).toBe("/assets/sprites/Events/Scroll%20event.png?v=20260508");
    const journalProgress = completeNode(lab, selectNode(lab, eventProgress, "rootspire_lab_old_knight_journal"), "rootspire_lab_old_knight_journal");
    expect(journalProgress.selectedNodeId).toBe("rootspire_lab_restless_skeletons");
    expect(getAdventureChoiceNodes(lab, journalProgress).map(node => node.id)).toEqual(["rootspire_lab_restless_skeletons"]);
    expect(nodes.rootspire_lab_restless_skeletons).toMatchObject({
      enemyId: "rootspire_restless_skeleton",
      enemyIds: [
        "rootspire_restless_skeleton",
        "rootspire_restless_skeleton",
        "rootspire_restless_skeleton",
      ],
      bossDeathEndsFight: false,
      addsDespawnOnBossDeath: false,
      noRarity: true,
      noRewards: true,
      repeatable: true,
    });

    const questionProgress = selectNode(lab, eventProgress, "rootspire_lab_oath_door");
    expect(isNodeCompleted(questionProgress, "rootspire_lab_oath_door")).toBe(true);
    expect(nodes.rootspire_lab_oath_door.choicePrompt).toEqual({
      title: "Oath Door Question",
      text: "A stone door asks what held the old order together.",
    });
    expect(getAdventureChoiceNodes(lab, questionProgress).map(node => node.id)).toEqual([
      "rootspire_lab_answer_oath",
      "rootspire_lab_answer_blood",
      "rootspire_lab_answer_mellon",
    ]);
    expect([
      nodes.rootspire_lab_answer_oath,
      nodes.rootspire_lab_answer_blood,
      nodes.rootspire_lab_answer_mellon,
    ].map(node => ({
      title: node.event.title,
      description: node.event.description,
      answerOnly: node.answerOnly,
    }))).toEqual([
      { title: "Answer: The Oath", description: "", answerOnly: true },
      { title: "Answer: Blood", description: "", answerOnly: true },
      { title: "Answer: Mellon", description: "", answerOnly: true },
    ]);
    const correctAnswerProgress = completeNode(lab, selectNode(lab, questionProgress, "rootspire_lab_answer_oath"), "rootspire_lab_answer_oath");
    expect(correctAnswerProgress.selectedNodeId).toBe("rootspire_lab_return");

    const wrongAnswerProgress = completeNode(lab, selectNode(lab, questionProgress, "rootspire_lab_answer_blood"), "rootspire_lab_answer_blood");
    expect(wrongAnswerProgress.selectedNodeId).toBe("rootspire_lab_oath_guardians");
    expect(getAdventureChoiceNodes(lab, wrongAnswerProgress).map(node => node.id)).toEqual(["rootspire_lab_oath_guardians"]);
    const mellonAnswerProgress = completeNode(lab, selectNode(lab, questionProgress, "rootspire_lab_answer_mellon"), "rootspire_lab_answer_mellon");
    expect(mellonAnswerProgress.selectedNodeId).toBe("rootspire_lab_oath_guardians");
    expect(nodes.rootspire_lab_oath_guardians.enemyIds).toEqual(["gargoyle", "oathbound_squire"]);
    expect(nodes.rootspire_lab_oath_guardians.noRewards).toBe(true);
    expect(nodes.rootspire_lab_abyssal_fiend.enemyId).toBe("abyssal_fiend");
  });

  it("repairs old Rootspire lab progress so Abyss Mechanics shows new event test cards", () => {
    const lab = adventureById.rootspire_ability_lab;
    const stale = {
      selectedRouteId: "rootspire_ability_lab_path",
      selectedNodeId: "rootspire_lab_abyssal_fiend",
      unlockedNodes: [
        "rootspire_ability_lab_entrance",
        "rootspire_lab_armored_wing",
        "rootspire_lab_fire_wing",
        "rootspire_lab_abyss_wing",
        "rootspire_lab_abyssal_fiend",
      ],
      completedNodes: ["rootspire_ability_lab_entrance", "rootspire_lab_abyss_wing"],
      secrets: [],
      bossCompleted: false,
    };
    const repaired = normalizeAdventureProgress(lab, stale);

    expect(repaired.unlockedNodes).toEqual(expect.arrayContaining([
      "rootspire_lab_old_knight_journal",
      "rootspire_lab_oath_door",
      "rootspire_lab_abyssal_fiend",
    ]));
    expect(getAdventureChoiceNodes(lab, repaired).map(node => node.id)).toEqual([
      "rootspire_lab_old_knight_journal",
      "rootspire_lab_oath_door",
      "rootspire_lab_abyssal_fiend",
    ]);
  });
});
