import { describe, expect, it } from "vitest";
import { bossById, enemyById, itemById } from "./content.js";
import {
  ADVENTURE_LOOT_POOLS,
  LOOT_TABLES,
  ITEM_RARITIES,
  ITEM_RARITY_TABLES,
  applyItemRarity,
  getAdventureDropPool,
  rollAdventureLootPool,
  rollCombatLoot,
  rollEventLootEffect,
  rollItemRarity,
  rollLootTable,
} from "./loot.js";

describe("adventure loot pools", () => {
  it("uses the adventure pool for normal combat enemies", () => {
    const adventure = {
      id: "test_pool_adventure",
      lootPool: {
        rolls: 1,
        dropChance: 1,
        items: [
          { id: "wild_berries", weight: 10 },
        ],
      },
    };
    const enemy = { ...enemyById.forest_bandit, lootTable: "forest_basic" };

    const drops = rollCombatLoot(enemy, () => 0.1, { adventure });

    expect(drops).toHaveLength(1);
    expect(drops[0].id).toBe("wild_berries");
  });

  it("makes weak enemies much less likely to roll high-tier adventure-pool items", () => {
    const pool = {
      rolls: 1,
      dropChance: 1,
      items: [
        { id: "wild_berries", weight: 10 },
        { id: "protection_amulet", weight: 10 },
      ],
      itemTiers: {
        protection_amulet: 3,
      },
    };

    const weakPool = getAdventureDropPool(pool, enemyById.wolf);
    const strongPool = getAdventureDropPool(pool, enemyById.troll_small);
    const weightFor = (entries, id) => entries.find(item => item.id === id)?.dropWeight || 0;

    expect(weightFor(weakPool, "wild_berries")).toBe(10);
    expect(weightFor(weakPool, "protection_amulet")).toBeLessThan(1);
    expect(weightFor(strongPool, "protection_amulet")).toBe(10);
  });

  it("keeps boss and special enemy loot manually authored", () => {
    const adventure = {
      id: "test_manual_override",
      lootPool: {
        rolls: 1,
        dropChance: 1,
        items: [{ id: "wild_berries", weight: 10 }],
      },
    };

    const bossDrops = rollCombatLoot(bossById.elder_stag, () => 0.1, { adventure });
    const specialDrops = rollCombatLoot(enemyById.armored_bear, () => 0.2, { adventure });

    const elderStagAllowed = new Set(["ring_of_thorns", "thorn_amulet", "stag_heart", "stag_velvet", "recipe_scroll_stagheart_stew", "recipe_scroll_antler_broth", "fragment_sacred_horn"]);
    expect(bossDrops.every(drop => drop.generated || elderStagAllowed.has(drop.baseId || drop.id))).toBe(true);
    const armoredBearAllowed = new Set(["bear_meat", "campfire", "boar_stock", "cured_boar_meat"]);
    expect(specialDrops.every(drop => drop.generated || armoredBearAllowed.has(drop.baseId || drop.id))).toBe(true);
  });

  it("rolls enchantment stones from the combat loot path", () => {
    const enemy = { ...enemyById.orc_berserker, tier: 4 };
    const drops = rollCombatLoot(enemy, () => 0, {
      adventure: { id: "orc_war_camp" },
      difficultyStars: 5,
    });

    expect(drops).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stone_ember_rare", type: "enchantment_stone" }),
    ]));
  });

  it("rolls boss relics and configured boss stones from combat loot", () => {
    const drops = rollCombatLoot(bossById.orc_shaman, () => 0, {
      adventure: { id: "orc_war_camp" },
      difficultyStars: 4,
    });

    expect(drops).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "relic_shaman_mark", type: "relic" }),
      expect.objectContaining({ id: "stone_ember_common", type: "enchantment_stone" }),
    ]));
  });

  it("does not drop a relic the hero already owns", () => {
    const drops = rollCombatLoot(bossById.orc_shaman, () => 0, {
      adventure: { id: "orc_war_camp" },
      difficultyStars: 4,
      hero: { relicSlots: ["relic_shaman_mark"], inventory: [] },
    });

    expect(drops.some(drop => drop.id === "relic_shaman_mark")).toBe(false);
  });

  it("uses per-enemy relic tables for special encounters that keep generic base loot", () => {
    const drops = rollCombatLoot(enemyById.stone_golem, () => 0, {
      adventure: { id: "rootspire_floor_3" },
      difficultyStars: 4,
    });

    expect(drops).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "relic_stone_core", type: "relic" }),
    ]));
  });

  it("gives Armored Bear generated armor, bear meat, or campfire at configured weights", () => {
    const table = LOOT_TABLES.armored_bear;
    const rollBearDrop = pickRoll => {
      const rolls = [0, pickRoll, 0];
      const [drop] = rollCombatLoot(enemyById.armored_bear, () => rolls.shift() ?? 0);
      return drop.generated ? "generated" : (drop.baseId || drop.id);
    };

    expect(table.dropChance).toBe(1);
    expect(table.includeItemIds).toEqual(expect.arrayContaining(["bear_meat", "campfire", "boar_stock", "cured_boar_meat"]));
    expect(table.itemWeights).toMatchObject({ bear_meat: 3, campfire: 2, boar_stock: 2, cured_boar_meat: 3 });
    expect(table.generatedEquipment).toMatchObject({ weight: 18, itemLevel: 4 });
    expect(rollBearDrop(0.10)).toBe("bear_meat");
    expect(rollBearDrop(0.14)).toBe("campfire");
    expect(rollBearDrop(0.40)).toBe("generated");
  });

  it("ships adventure pools for the mapped adventures", () => {
    expect(ADVENTURE_LOOT_POOLS.ancient_forest.items.length).toBeGreaterThan(0);
    expect(ADVENTURE_LOOT_POOLS.crypts.items.length).toBeGreaterThan(0);
    expect(ADVENTURE_LOOT_POOLS.orc_war_camp.items.length).toBeGreaterThan(0);
    expect(ADVENTURE_LOOT_POOLS.rootspire_tower.items.length).toBeGreaterThan(0);
  });

  it("lets event loot roll directly from an adventure loot pool", () => {
    const rolls = [0.1, 0.99, 0.1, 0.1, 0.1, 0.1];
    const [drop] = rollEventLootEffect({
      type: "grant_loot",
      lootPoolId: "orc_war_camp",
      rolls: 1,
    }, () => rolls.shift() ?? 0.1);

    expect(drop?.generated).toBe(true);
    expect(drop?.generation?.baseId || drop?.baseId || drop?.id).toBeTruthy();
  });

  it("uses only created items in adventure pools", () => {
    for (const pool of Object.values(ADVENTURE_LOOT_POOLS)) {
      for (const entry of pool.items || []) {
        if (entry.id) expect(itemById[entry.id], entry.id).toBeTruthy();
      }
    }
  });

  it("moves Ancient Forest weapons and armor to generated equipment", () => {
    const itemIds = ADVENTURE_LOOT_POOLS.ancient_forest.items.map(entry => entry.id);
    const config = ADVENTURE_LOOT_POOLS.ancient_forest.generatedEquipment;
    const banditTable = LOOT_TABLES.forest_bandit;

    expect(itemIds).not.toContain("yarrow");
    expect(itemIds).not.toContain("wooden_spear");
    expect(itemIds).not.toEqual(expect.arrayContaining(["dagger", "sword", "hunter_spear", "buckler", "chain_mail"]));
    expect(itemIds).toEqual(expect.arrayContaining(["ration", "campfire", "small_bag", "quiver"]));
    expect(itemIds).not.toContain("wolf_meat");
    expect(itemIds).not.toContain("boar_meat");
    expect(config).toMatchObject({ enabled: true });
    expect(config.weight).toBeGreaterThan(20);
    expect(config.slots).toEqual(expect.arrayContaining(["weapon", "offhand", "helmet", "chest", "legs", "boots", "gloves"]));
    expect(config.baseIds).toContain("crossbow");
    expect(banditTable.generatedEquipment.baseIds).toEqual(expect.arrayContaining(["sword_1h", "rapier"]));
  });

  it("keeps food buffs exclusive to crafted meals", () => {
    for (const id of ["ration", "hearty_stew", "wolf_meat", "cooked_wolf_meat", "boar_meat", "cooked_boar_meat", "warg_meat", "cooked_warg_meat", "bear_meat", "cooked_bear_meat"]) {
      expect(itemById[id]?.effects?.some(effect => effect.type === "food_buff")).toBe(false);
    }
    expect(itemById.wolf_skewer.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "food_buff" })]));
    expect(itemById.boar_stew.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "food_buff" })]));
    for (const id of ["foragers_broth", "herbal_berry_tea", "root_hash", "honeyed_roots", "hunters_feast", "bear_stew"]) {
      expect(itemById[id]?.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "food_buff" })]));
    }
  });

  it("keeps raw meat low, cooked meat better, and recipes best for hunger", () => {
    const hunger = id => itemById[id]?.effects?.find(effect => effect.type === "restore_hunger")?.value ?? 0;
    const meatPairs = [
      ["wolf_meat", "cooked_wolf_meat"],
      ["boar_meat", "cooked_boar_meat"],
      ["warg_meat", "cooked_warg_meat"],
      ["bear_meat", "cooked_bear_meat"],
    ];
    const rawValues = meatPairs.map(([raw]) => hunger(raw));
    const cookedValues = meatPairs.map(([, cooked]) => hunger(cooked));
    const recipeValues = Object.values(itemById)
      .filter(item => item.tags?.includes("recipe_food"))
      .map(item => hunger(item.id));

    expect(rawValues).toEqual([6, 8, 10, 12]);
    expect(cookedValues).toEqual([18, 22, 26, 28]);
    for (let index = 0; index < meatPairs.length; index += 1) {
      expect(cookedValues[index]).toBeGreaterThan(rawValues[index]);
    }
    expect(Math.min(...recipeValues)).toBeGreaterThan(Math.max(...cookedValues));
  });

  it("keeps beast meat on beast-specific manual loot tables", () => {
    expect(enemyById.wolf).toMatchObject({ lootTable: "forest_wolf", manualLoot: true });
    expect(enemyById.boar).toMatchObject({ lootTable: "forest_boar", manualLoot: true });
    expect(enemyById.warg).toMatchObject({ lootTable: "orc_warg", manualLoot: true });

    const wargDrops = rollCombatLoot(enemyById.warg, () => 0.2, { adventure: { lootPool: ADVENTURE_LOOT_POOLS.orc_war_camp } });
    expect(wargDrops.map(drop => drop.id)).toContain("warg_meat");
  });

  it("gives Ancient Forest chests a guaranteed generated-equipment roll chance with boosted rarity odds", () => {
    const table = LOOT_TABLES.forest_chest_equipment;
    const nonNormalWeight = tableName => ITEM_RARITY_TABLES[tableName]
      .filter(([id]) => id !== "normal")
      .reduce((sum, [, weight]) => sum + weight, 0);
    const [drop] = rollLootTable("forest_chest_equipment", () => 0.99);

    expect(table).toMatchObject({ rolls: 1, dropChance: 1, rarityTable: "forestChest" });
    expect(table.tags).toEqual([]);
    expect(table.generatedEquipment.weight).toBeGreaterThan(20);
    expect(table.includeItemIds).toEqual(expect.arrayContaining(["campfire", "small_bag", "quiver", "fur_cloak"]));
    expect(table.includeItemIds.every(id => itemById[id])).toBe(true);
    expect(nonNormalWeight("forestChest")).toBeGreaterThan(nonNormalWeight("specialChest"));
    expect(drop.generated).toBe(true);
    expect(drop.damageDice || drop.armorDice).toBeTruthy();
  });

  it("keeps uncommon, epic, and legendary outcomes reachable from regular combat rarity rolls", () => {
    expect(rollItemRarity("normal", () => 0.7).id).toBe("uncommon");
    expect(rollItemRarity("normal", () => 0.93).id).toBe("epic");
    expect(rollItemRarity("normal", () => 0.99).id).toBe("legendary");
  });

  it("does not fold disabled artifact odds into random legendary equipment", () => {
    const rolls = [0, 0.99, 0.99, 0, 0, 0, 0, 0, 0];
    const drops = rollLootTable("boss", () => rolls.shift() ?? 0);
    const generated = drops.find(drop => drop.generated);

    expect(ITEM_RARITY_TABLES.boss.find(([id]) => id === "artifact")).toBeUndefined();
    expect(ITEM_RARITY_TABLES.wyvern.find(([id]) => id === "artifact")).toBeUndefined();
    expect(generated?.rarity).toBe("legendary");
    expect(generated?.name).toContain("Legendary");
    expect(generated?.name).not.toContain("Artifact");
  });

  it("generates spear drops from the new base table", () => {
    const [drop] = rollAdventureLootPool({
      rolls: 1,
      dropChance: 1,
      generatedEquipment: {
        enabled: true,
        weight: 1,
        baseIds: ["spear_2h"],
        materials: ["iron"],
        itemLevel: 1,
      },
      tags: ["generated_only_test"],
      items: [],
    }, enemyById.wolf, () => 0.1);

    expect(drop).toMatchObject({
      generated: true,
      family: "spear",
      hands: 2,
      damageDice: { count: 1, sides: 12 },
    });
  });

  it("keeps Crypts drops themed and moves weapons and armor to generated bases", () => {
    const itemIds = ADVENTURE_LOOT_POOLS.crypts.items.map(entry => entry.id);
    const config = ADVENTURE_LOOT_POOLS.crypts.generatedEquipment;

    expect(itemIds).not.toContain("yarrow");
    expect(itemIds).not.toContain("comfrey_leaf");
    expect(itemIds).toEqual(expect.arrayContaining(["bone", "bandage", "campfire", "small_bag", "ward_amulet", "protection_amulet", "ring_of_thorns"]));
    expect(itemIds).not.toContain("quiver");
    expect(itemIds).not.toEqual(expect.arrayContaining(["orcish_axe", "heavy_mace", "plate_helm", "iron_chest"]));
    expect(config.baseIds).toEqual(expect.arrayContaining(["sword_1h", "rapier", "greataxe_2h", "staff", "composite_bow", "plate_chest", "tower_shield"]));
  });

  it("keeps Orc War Camp loot in the heavy bloodforged war category", () => {
    const itemIds = ADVENTURE_LOOT_POOLS.orc_war_camp.items.map(entry => entry.id);
    const config = ADVENTURE_LOOT_POOLS.orc_war_camp.generatedEquipment;
    const bossTable = LOOT_TABLES.orc_shaman_boss;

    expect(itemIds).toEqual(expect.arrayContaining(["ration", "campfire", "warg_meat", "warg_fat"]));
    expect(ADVENTURE_LOOT_POOLS.orc_war_camp.itemTiers.warg_meat).toBe(2);
    expect(ADVENTURE_LOOT_POOLS.orc_war_camp.itemTiers.warg_fat).toBe(2);
    expect(config.baseIds).toEqual(expect.arrayContaining(["axe_1h", "mace_1h", "greataxe_2h", "heavy_crossbow", "plate_chest", "tower_shield"]));
    expect(config.materials).toEqual(expect.arrayContaining(["iron", "steel", "bone", "bloodiron"]));
    expect(config.materials).not.toContain("ancient");
    expect(bossById.orc_shaman.lootTable).toBe("orc_shaman_boss");
    expect(bossTable.generatedEquipment.baseIds).toContain("heavy_crossbow");
    expect(bossTable.generatedEquipment.materials).toEqual(expect.arrayContaining(["steel", "bone", "bloodiron"]));
    expect(bossTable.generatedEquipment.materials).not.toContain("ancient");

    const orcPool = getAdventureDropPool(ADVENTURE_LOOT_POOLS.orc_war_camp, enemyById.orc_berserker);
    const totalWeight = orcPool.reduce((sum, item) => sum + (item.dropWeight || 1), config.weight);
    const wargMeatWeight = orcPool.find(item => item.id === "warg_meat")?.dropWeight || 0;
    expect(ADVENTURE_LOOT_POOLS.orc_war_camp.dropChance * wargMeatWeight / totalWeight).toBeCloseTo(0.55 * 3 / 46);
  });

  it("uses a Crypts-specific chest loot table", () => {
    const table = LOOT_TABLES.crypts_chest_equipment;
    const [drop] = rollLootTable("crypts_chest_equipment", () => 0.99);

    expect(table).toMatchObject({ dropChance: 1, rarityTable: "specialChest" });
    expect(table.tags).toEqual([]);
    expect(table.generatedEquipment.itemLevel).toBe(4);
    expect(table.generatedEquipment.baseIds).toEqual(expect.arrayContaining(["rapier", "staff", "composite_bow", "plate_chest", "tower_shield"]));
    expect(table.includeItemIds).toEqual(expect.arrayContaining(["campfire", "small_bag", "ward_amulet", "protection_amulet", "ring_of_thorns"]));
    expect(table.includeItemIds).not.toContain("quiver");
    expect(table.includeItemIds).not.toContain("focus_hat");
    expect(table.includeItemIds).not.toContain("yarrow");
    expect(table.includeItemIds).not.toContain("comfrey_leaf");
    expect(table.includeItemIds.every(id => itemById[id])).toBe(true);
    expect(drop.generated).toBe(true);
    expect(drop.damageDice || drop.armorDice).toBeTruthy();
  });

  it("adds Composite Bow to tier 1 and tier 2 generated dungeon pools", () => {
    const forestBases = ADVENTURE_LOOT_POOLS.ancient_forest.generatedEquipment.baseIds;
    const cryptBases = ADVENTURE_LOOT_POOLS.crypts.generatedEquipment.baseIds;

    expect(forestBases).toContain("composite_bow");
    expect(cryptBases).toContain("composite_bow");
    expect(LOOT_TABLES.forest_chest_equipment.generatedEquipment.baseIds).toContain("composite_bow");
    expect(LOOT_TABLES.crypts_chest_equipment.generatedEquipment.baseIds).toContain("composite_bow");
    expect(LOOT_TABLES.elder_stag_boss.generatedEquipment.baseIds).toContain("composite_bow");
    expect(LOOT_TABLES.lich_boss.generatedEquipment.baseIds).toContain("composite_bow");
    expect(forestBases).not.toContain("heavy_crossbow");
    expect(cryptBases).not.toContain("heavy_crossbow");

    const [drop] = rollAdventureLootPool({
      rolls: 1,
      dropChance: 1,
      generatedEquipment: {
        enabled: true,
        weight: 1,
        baseIds: ["composite_bow"],
        materials: ["ash"],
        itemLevel: 2,
      },
      items: [],
    }, enemyById.wolf, () => 0.1);

    expect(drop).toMatchObject({
      generated: true,
      generation: { baseId: "composite_bow" },
      family: "bow",
      weaponType: "two_handed_bow",
      hands: 2,
      attackSpeed: 1.12,
      icon: "/assets/items/generated/Composite%20bow.png",
    });
    expect(drop.tags).toEqual(expect.arrayContaining(["bow", "weapon", "ranged", "two_handed"]));
  });

  it("adds a regular Crossbow to Ancient Forest without using the heavy orc version", () => {
    const forestBases = ADVENTURE_LOOT_POOLS.ancient_forest.generatedEquipment.baseIds;
    const forestChestBases = LOOT_TABLES.forest_chest_equipment.generatedEquipment.baseIds;

    expect(forestBases).toContain("crossbow");
    expect(forestChestBases).toContain("crossbow");
    expect(forestBases).not.toContain("heavy_crossbow");
    expect(forestChestBases).not.toContain("heavy_crossbow");

    const [drop] = rollAdventureLootPool({
      rolls: 1,
      dropChance: 1,
      generatedEquipment: {
        enabled: true,
        weight: 1,
        baseIds: ["crossbow"],
        materials: ["iron"],
        itemLevel: 2,
      },
      items: [],
    }, enemyById.wolf, () => 0.1);

    expect(drop).toMatchObject({
      generated: true,
      generation: { baseId: "crossbow" },
      family: "crossbow",
      weaponType: "two_handed_crossbow",
      hands: 2,
      damageDice: { count: 1, sides: 10 },
      attackSpeed: 0.72,
      icon: "/assets/items/generated/Heavy%20crossbow.png",
    });
    expect(drop.tags).toEqual(expect.arrayContaining(["crossbow", "weapon", "ranged", "two_handed"]));
    expect(drop.tags).not.toContain("heavy");
  });

  it("reserves Heavy Crossbow for tier 3 orc generated pools", () => {
    const forestBases = ADVENTURE_LOOT_POOLS.ancient_forest.generatedEquipment.baseIds;
    const cryptBases = ADVENTURE_LOOT_POOLS.crypts.generatedEquipment.baseIds;
    const orcBases = ADVENTURE_LOOT_POOLS.orc_war_camp.generatedEquipment.baseIds;

    expect(orcBases).toContain("heavy_crossbow");
    expect(LOOT_TABLES.orc_basic.generatedEquipment.baseIds).toContain("heavy_crossbow");
    expect(LOOT_TABLES.orc_shaman_boss.generatedEquipment.baseIds).toContain("heavy_crossbow");
    expect(LOOT_TABLES.orc_general_boss.generatedEquipment.baseIds).toContain("heavy_crossbow");
    expect(forestBases).not.toContain("heavy_crossbow");
    expect(cryptBases).not.toContain("heavy_crossbow");
    expect(LOOT_TABLES.forest_chest_equipment.generatedEquipment.baseIds).not.toContain("heavy_crossbow");
    expect(LOOT_TABLES.crypts_chest_equipment.generatedEquipment.baseIds).not.toContain("heavy_crossbow");

    const [drop] = rollAdventureLootPool({
      rolls: 1,
      dropChance: 1,
      generatedEquipment: {
        enabled: true,
        weight: 1,
        baseIds: ["heavy_crossbow"],
        materials: ["bloodiron"],
        itemLevel: 5,
      },
      items: [],
    }, enemyById.orc_patrol, () => 0.1);

    expect(drop).toMatchObject({
      generated: true,
      generation: { baseId: "heavy_crossbow" },
      family: "crossbow",
      weaponType: "two_handed_crossbow",
      hands: 2,
      attackSpeed: 0.72,
      icon: "/assets/items/generated/Heavy%20crossbow.png",
    });
    expect(drop.tags).toEqual(expect.arrayContaining(["crossbow", "weapon", "ranged", "two_handed", "heavy"]));
  });

  it("keeps adventure base drop chances aligned while Rootspire item quality scales up", () => {
    const rootspirePool = ADVENTURE_LOOT_POOLS.rootspire_tower;

    expect(Object.values(ADVENTURE_LOOT_POOLS).every(pool => pool.dropChance === 0.55)).toBe(true);
    expect(rootspirePool.rarityTable).toBe("rootspire");
    expect(rootspirePool.generatedEquipment.itemLevelBonus).toBeGreaterThan(ADVENTURE_LOOT_POOLS.orc_war_camp.generatedEquipment.itemLevelBonus);
    expect(rootspirePool.generatedEquipment.baseIds).toEqual(expect.arrayContaining([
      "wyvernbone_arbalest",
      "oathbound_longsword",
      "spireweave_robe",
      "duskrunner_jacket",
      "oathbound_plate_cuirass",
      "tower_shield",
    ]));
    expect(rootspirePool.generatedEquipment.materials).toEqual(expect.arrayContaining(["ancient", "bloodiron"]));
    expect(LOOT_TABLES.rootspire_armory.generatedEquipment.itemLevel).toBeGreaterThan(LOOT_TABLES.crypts_chest_equipment.generatedEquipment.itemLevel);
    expect(LOOT_TABLES.rootspire_elite.rarityTable).toBe("rootspireElite");
    expect(LOOT_TABLES.rootspire_elite.rolls).toBe(1);
    expect(LOOT_TABLES.rootspire_elite.dropChance).toBe(0.87);
    expect(LOOT_TABLES.rootspire_armory.dropChance).toBe(0.87);
    expect(ITEM_RARITY_TABLES.rootspireElite).toEqual([
      ["uncommon", 15],
      ["rare", 45],
      ["epic", 20],
      ["legendary", 7],
    ]);
    expect(LOOT_TABLES.wyvern_boss.rarityTable).toBe("wyvern");
    expect(LOOT_TABLES.wyvern_boss.rolls).toBe(2);
    expect(LOOT_TABLES.wyvern_boss.minimumRarity).toBeUndefined();
    expect(LOOT_TABLES.wyvern_boss.includeItemIds).not.toContain("fang_of_the_red_viper");
    expect(LOOT_TABLES.fallen_knight_boss.rarityTable).toBe("wyvern");
    expect(LOOT_TABLES.fallen_knight_boss.rolls).toBe(2);
    expect(LOOT_TABLES.fallen_knight_boss.minimumRarity).toBe("epic");
    expect(LOOT_TABLES.fallen_knight_boss.relicDrop).toEqual({
      itemId: "relic_spectral_echo",
      chance: 8,
    });
    expect(LOOT_TABLES.fallen_knight_boss.includeItemIds).toContain("fang_of_the_red_viper");
    expect(LOOT_TABLES.fallen_knight_boss.itemWeights.fang_of_the_red_viper).toBe(1);
    const fallenKnightPoolWeight = LOOT_TABLES.fallen_knight_boss.includeItemIds.reduce(
      (sum, id) => sum + (LOOT_TABLES.fallen_knight_boss.itemWeights[id] || itemById[id]?.dropWeight || 1),
      LOOT_TABLES.fallen_knight_boss.generatedEquipment.weight,
    );
    const fangPerRoll = LOOT_TABLES.fallen_knight_boss.itemWeights.fang_of_the_red_viper / fallenKnightPoolWeight;
    const fangPerKill = 1 - ((1 - fangPerRoll) ** LOOT_TABLES.fallen_knight_boss.rolls);
    expect(fangPerKill).toBeCloseTo(0.0296, 3);
    expect(itemById.fang_of_the_red_viper).toMatchObject({
      name: "Fang of the Red Viper",
      rarity: "artifact",
      family: "spear",
      slot: "weapon",
    });
    expect(ITEM_RARITY_TABLES.wyvern.find(([id]) => id === "legendary")?.[1]).toBeGreaterThan(ITEM_RARITY_TABLES.boss.find(([id]) => id === "legendary")?.[1]);
  });

  it("guarantees high-end boss loot has at least one epic item and uses the Wyvern rarity table", () => {
    const artifactRolls = [0, 0, 0, 0];
    const artifactDrops = rollLootTable("fallen_knight_boss", () => artifactRolls.shift() ?? 0);

    expect(artifactDrops[0]).toMatchObject({
      id: "fang_of_the_red_viper",
      name: "Fang of the Red Viper",
      rarity: "artifact",
      family: "spear",
    });

    const rareRolls = [0, 0, 0];
    const rareDrops = rollLootTable("fallen_knight_boss", () => rareRolls.shift() ?? 0);

    expect(rareDrops.some(drop => ["epic", "legendary", "artifact"].includes(drop?.rarity))).toBe(true);

    const wyvernRolls = [0, 0.99, 0.99];
    const [, wyvernDrop] = rollCombatLoot(bossById.wyvern, () => wyvernRolls.shift() ?? 0.1);

    expect(wyvernDrop).toMatchObject({
      generated: true,
      rarity: "legendary",
    });
  });

  it("adds Rootspire generated accessories and lets magic find boost combat loot", () => {
    const rootspirePool = ADVENTURE_LOOT_POOLS.rootspire_tower;
    const basicEnemy = { ...enemyById.wolf, lootTable: "forest_basic", lootBonus: 0 };

    expect(rootspirePool.generatedEquipment.baseIds).toEqual(expect.arrayContaining([
      "emberglass_ring",
      "veilstone_ring",
      "cinderward_amulet",
      "umbralward_amulet",
      "emberward_cape",
      "nightfall_cape",
    ]));

    const [arbalest] = rollAdventureLootPool({
      rolls: 1,
      dropChance: 1,
      generatedEquipment: {
        enabled: true,
        weight: 1,
        baseIds: ["wyvernbone_arbalest"],
        materials: ["bone"],
        itemLevel: 6,
      },
      items: [],
    }, enemyById.wyvern || enemyById.wolf, () => 0.1);

    expect(arbalest).toMatchObject({
      generation: { baseId: "wyvernbone_arbalest" },
      attackSpeed: 0.65,
    });

    expect(rollCombatLoot(basicEnemy, () => 0.6, { lootBonus: 0 })).toEqual([]);
    expect(rollCombatLoot(basicEnemy, () => 0.6, { lootBonus: 10 }).length).toBeGreaterThan(0);
  });

  it("keeps bags from rolling rarity affixes", () => {
    const bag = itemById.small_bag;
    const rolled = applyItemRarity(bag, ITEM_RARITIES.legendary, () => 0);

    expect(rolled).toBe(bag);
    expect(rolled.rarity).toBeUndefined();
    expect(rolled.effects).toEqual([{ type: "campfire_carry_limit", value: 1 }]);
  });

  it("adds quivers as bag-slot gear with archer and wolf affixes", () => {
    const quiver = itemById.quiver;
    const ancientForestIds = ADVENTURE_LOOT_POOLS.ancient_forest.items.map(entry => entry.id);
    const cryptIds = ADVENTURE_LOOT_POOLS.crypts.items.map(entry => entry.id);
    const rolled = applyItemRarity(quiver, ITEM_RARITIES.legendary, () => 0.99);

    expect(quiver).toMatchObject({
      slot: "bag",
      family: "quiver",
      icon: "/assets/items/generated/Quiver.png",
      iconScale: 1.35,
      rarityAffixPools: ["quiver"],
    });
    expect(ancientForestIds).toContain("quiver");
    expect(cryptIds).not.toContain("quiver");
    expect(rolled).toMatchObject({
      baseId: "quiver",
      name: "Legendary Quiver",
      rarity: "legendary",
    });
    expect(rolled.effects.map(effect => effect.type)).toContain("pet_damage_pct");
  });

  it("turns the former thorn amulet into a rarity-scaling elemental amulet", () => {
    const amulet = itemById.thorn_amulet;
    const elementalEffects = ["fire_resist", "cold_resist", "lightning_resist", "shadow_resist", "poison_resist"];

    expect(amulet.name).toBe("Prismatic Amulet");
    for (const type of elementalEffects) {
      expect(amulet.effects).toContainEqual({ type, value: 5 });
    }

    const rolled = applyItemRarity(amulet, ITEM_RARITIES.rare, () => 0);

    expect(rolled).toMatchObject({
      baseId: "thorn_amulet",
      name: "Rare Prismatic Amulet",
      rarity: "rare",
    });
    expect(rolled.uid).toBeTruthy();
    for (const type of elementalEffects) {
      expect(rolled.effects).toContainEqual({ type, value: 6 });
    }
    expect(rolled.effects.length).toBeGreaterThan(elementalEffects.length);
  });

  it("lets legacy rings roll rarity affixes while keeping their base identity", () => {
    const guardRing = itemById.ring_of_thorns;
    const vampireRing = itemById.vampire_ring;
    const gustRing = itemById.gust_ring;

    expect(guardRing).toMatchObject({
      name: "Guard Ring",
      rarityAffixPools: ["guard", "survival"],
    });
    expect(vampireRing.effects).toContainEqual(expect.objectContaining({ type: "lifesteal", value: 3 }));
    expect(vampireRing.rarityAffixPools).toEqual(["blood", "survival"]);
    expect(gustRing.effects).toContainEqual(expect.objectContaining({ type: "attack_speed", value: 4 }));
    expect(gustRing.rarityAffixPools).toEqual(["speed", "precision"]);

    const rareGuard = applyItemRarity(guardRing, ITEM_RARITIES.rare, () => 0);
    const epicVampire = applyItemRarity(vampireRing, ITEM_RARITIES.epic, () => 0);
    const legendaryGust = applyItemRarity(gustRing, ITEM_RARITIES.legendary, () => 0);

    expect(rareGuard).toMatchObject({
      baseId: "ring_of_thorns",
      name: "Rare Guard Ring",
      rarity: "rare",
      baseStats: { armor: 3 },
    });
    expect(rareGuard.effects.length).toBeGreaterThan(0);
    expect(epicVampire).toMatchObject({
      baseId: "vampire_ring",
      name: "Epic Blood Ring",
      rarity: "epic",
    });
    expect(epicVampire.effects).toContainEqual(expect.objectContaining({ type: "lifesteal", value: 6 }));
    expect(epicVampire.effects.length).toBeGreaterThan(vampireRing.effects.length);
    expect(legendaryGust).toMatchObject({
      baseId: "gust_ring",
      name: "Legendary Gust Ring",
      rarity: "legendary",
    });
    expect(legendaryGust.effects).toContainEqual(expect.objectContaining({ type: "attack_speed", value: 8 }));
    expect(legendaryGust.effects.length).toBeGreaterThan(gustRing.effects.length);
  });

  it("rolls one affix on uncommon rarity-scaling gear", () => {
    const amulet = itemById.thorn_amulet;
    const rolled = applyItemRarity(amulet, ITEM_RARITIES.uncommon, () => 0);

    expect(rolled).toMatchObject({
      baseId: "thorn_amulet",
      name: "Uncommon Prismatic Amulet",
      rarity: "uncommon",
      rarityColor: "#2ecc71",
    });
    expect(rolled.effects).toHaveLength((amulet.effects || []).length + 1);
  });

  it("adds Whitefang Dagger as a beast-slayer dagger dropping from White Wolf", () => {
    const item = itemById.whitefang_dagger;

    expect(item).toMatchObject({
      slot: "weapon",
      family: "dagger",
      weaponType: "one_handed_dagger",
      hands: 1,
      attackSpeed: 1.42,
      damageDice: { count: 1, sides: 4 },
      dropWeight: 0,
      icon: "/assets/items/generated/dagger.png",
    });
    expect(item.baseStats.damage).toBe(3);
    expect(item.effects).toEqual([]);
    expect(item.rarityAffixPools).toEqual(expect.arrayContaining(["precision", "speed", "predator"]));
    expect(item.tags).toEqual(expect.arrayContaining(["dagger", "weapon", "rogue", "wolf", "beast", "ancient_forest"]));
    expect(item.dropWeight).toBe(0);

    const table = LOOT_TABLES.forest_white_wolf;
    expect(table.independentDrops).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "whitefang_dagger", dropChance: 0.04 }),
    ]));

    const withDrop = rollLootTable("forest_white_wolf", () => 0.01);
    expect(withDrop.some(d => d.id === "whitefang_dagger")).toBe(true);

    const withoutDrop = rollLootTable("forest_white_wolf", () => 0.5);
    expect(withoutDrop.some(d => d.id === "whitefang_dagger")).toBe(false);
  });

  it("adds Bandit's Stiletto as a precision dagger dropping from Forest Bandit", () => {
    const item = itemById.bandits_stiletto;

    expect(item).toMatchObject({
      slot: "weapon",
      family: "dagger",
      weaponType: "one_handed_dagger",
      hands: 1,
      attackSpeed: 1.38,
      damageDice: { count: 1, sides: 4 },
      dropWeight: 0,
      icon: "/assets/items/generated/dagger.png",
    });
    expect(item.baseStats.damage).toBe(5);
    expect(item.effects).toContainEqual({ type: "crit_chance", value: 3 });
    expect(item.effects).toContainEqual({ type: "hit_chance", value: 3 });
    expect(item.rarityAffixPools).toEqual(expect.arrayContaining(["precision", "speed", "dueling"]));
    expect(item.tags).toEqual(expect.arrayContaining(["dagger", "weapon", "rogue", "bandit", "ancient_forest"]));
    expect(item.dropWeight).toBe(0);

    const table = LOOT_TABLES.forest_bandit;
    expect(table.independentDrops).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "bandits_stiletto", dropChance: 0.04 }),
    ]));

    const withDrop = rollLootTable("forest_bandit", () => 0.01);
    expect(withDrop.some(d => d.id === "bandits_stiletto")).toBe(true);

    const withoutDrop = rollLootTable("forest_bandit", () => 0.5);
    expect(withoutDrop.some(d => d.id === "bandits_stiletto")).toBe(false);
  });

  it("does not define Ratfang Shiv in items or any loot table", () => {
    expect(itemById.ratfang_shiv).toBeUndefined();
    for (const [tableId, table] of Object.entries(LOOT_TABLES)) {
      const ids = [
        ...(table.includeItemIds || []),
        ...(table.independentDrops || []).map(d => d.itemId),
        ...(table.generatedEquipment?.baseIds || []),
      ];
      expect(ids, `ratfang_shiv found in table ${tableId}`).not.toContain("ratfang_shiv");
    }
  });

  it("adds Bonefletch Quiver as a crypt-themed item with undead and warding affixes", () => {
    const item = itemById.bonefletch_quiver;
    const rolled = applyItemRarity(item, ITEM_RARITIES.legendary, () => 0);

    expect(item).toMatchObject({
      slot: "bag",
      family: "quiver",
      icon: "/assets/items/generated/Quiver.png",
      iconScale: 1.35,
      rarityAffixPools: ["quiver", "warding"],
    });
    expect(item.effects).toContainEqual({ type: "damage_vs_tag", tag: "undead", value: 8 });
    expect(item.effects).toContainEqual({ type: "magic_defense", value: 3 });
    expect(item.tags).toEqual(expect.arrayContaining(["quiver", "undead", "crypts"]));
    expect(item.dropWeight).toBe(0);
    expect(rolled).toMatchObject({ baseId: "bonefletch_quiver", name: "Legendary Bonefletch Quiver", rarity: "legendary" });
  });

  it("drops Bonefletch Quiver independently at 4% from Skeleton Warrior", () => {
    const table = LOOT_TABLES.crypts_warrior;

    expect(table.independentDrops).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "bonefletch_quiver", dropChance: 0.04 }),
    ]));

    // rng < 0.04 → independent drop fires
    const withDrop = rollLootTable("crypts_warrior", () => 0.01);
    expect(withDrop.some(d => d.id === "bonefletch_quiver")).toBe(true);

    // rng > 0.04 → independent drop does not fire
    const withoutDrop = rollLootTable("crypts_warrior", () => 0.5);
    expect(withoutDrop.some(d => d.id === "bonefletch_quiver")).toBe(false);
  });

  it("rolls Animated Armor special drops independently at 2% each", () => {
    // rng always 0.5: skips main roll (0.5 > 0), skips generated equipment (0.5 > 0.14), skips both independent drops (0.5 > 0.02)
    const noDrops = rollLootTable("animated_armor", () => 0.5);
    expect(noDrops.some(d => d.id === "living_armblade")).toBe(false);
    expect(noDrops.some(d => d.id === "hollowguard_visor")).toBe(false);

    // rng always 0.01: passes generated equipment (0.01 <= 0.14) and both independent drops (0.01 <= 0.02)
    const allDrops = rollLootTable("animated_armor", () => 0.01);
    expect(allDrops.some(d => d.id === "living_armblade")).toBe(true);
    expect(allDrops.some(d => d.id === "hollowguard_visor")).toBe(true);

    // Items are correctly defined
    expect(itemById.living_armblade).toMatchObject({
      slot: "weapon",
      weaponType: "one_handed_sword",
      hands: 1,
      attackSpeed: 0.9,
    });
    expect(itemById.hollowguard_visor).toMatchObject({
      slot: "helmet",
      armorType: "heavy",
    });

    // Old black knight drops are gone from animated_armor
    expect(LOOT_TABLES.animated_armor.equipmentDrops).toBeUndefined();
    expect(LOOT_TABLES.animated_armor.independentDrops).toHaveLength(2);
  });
});
