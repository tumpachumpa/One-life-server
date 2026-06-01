import { describe, expect, it } from "vitest";
import { getItem } from "./content.js";
import { migrateInventoryItemRef, migrateSavedItemRef } from "./itemRefs.js";
import { rollGeneratedEquipment } from "./equipmentGenerator.js";

function isCasterArmorEffect(effect) {
  return effect?.type === "spell_damage" || (effect?.type === "stat_bonus" && effect.stat === "int");
}

describe("saved item references", () => {
  it("preserves rolled quiver rarity and effects during save migration", () => {
    const legendaryQuiver = {
      ...getItem("quiver"),
      uid: "legendary_quiver_1",
      baseId: "quiver",
      name: "Legendary Quiver",
      rarity: "legendary",
      effects: [
        { type: "crit_chance", value: 8 },
        { type: "pet_damage_pct", value: 12 },
      ],
    };
    const migrated = migrateSavedItemRef(legendaryQuiver);
    const inventoryEntry = migrateInventoryItemRef({ itemId: legendaryQuiver, x: 1, y: 2, qty: 1 });

    expect(migrated).toBe(legendaryQuiver);
    expect(migrated).toMatchObject({
      uid: "legendary_quiver_1",
      baseId: "quiver",
      rarity: "legendary",
      effects: [
        { type: "crit_chance", value: 8 },
        { type: "pet_damage_pct", value: 12 },
      ],
    });
    expect(inventoryEntry.itemId).toBe(legendaryQuiver);
    expect(inventoryEntry.itemId).not.toBe("quiver");
  });

  it("preserves generated item payloads instead of collapsing them to base IDs", () => {
    const generatedSword = rollGeneratedEquipment({ baseId: "sword_1h", materialId: "iron", rarity: "epic", itemLevel: 4 }, () => 0);

    expect(migrateSavedItemRef(generatedSword)).toBe(generatedSword);
    expect(migrateInventoryItemRef({ itemId: generatedSword, x: 0, y: 0 }).itemId).toBe(generatedSword);
  });

  it("migrates saved generated leather armor to the medium category", () => {
    const oldLeatherBoots = {
      ...rollGeneratedEquipment({ baseId: "leather_boots", materialId: "cured", rarity: "rare", itemLevel: 4 }, () => 0),
      uid: "old_light_leather_boots",
      armorType: "light",
      tags: ["boots", "light", "leather", "armor_light", "generated", "dice_v1", "cured", "ilvl_4"],
    };

    const migrated = migrateInventoryItemRef({ itemId: oldLeatherBoots, x: 0, y: 0 }).itemId;

    expect(migrated).not.toBe(oldLeatherBoots);
    expect(migrated.armorType).toBe("medium");
    expect(migrated.tags).toEqual(expect.arrayContaining(["boots", "leather", "generated", "medium", "armor_medium"]));
    expect(migrated.tags).not.toContain("light");
    expect(migrated.tags).not.toContain("armor_light");
  });

  it("migrates saved generated plate boots to the boot sprite", () => {
    const oldPlateBoots = {
      id: "generated_plate_boots",
      baseId: "generated_plate_boots",
      uid: "old_plate_boots",
      name: "Bloodforged Plate Sabatons",
      slot: "boots",
      icon: "/assets/items/generated/plate_legguards.png",
    };
    const migrated = migrateInventoryItemRef({ itemId: oldPlateBoots, x: 0, y: 0 });

    expect(migrated.itemId).not.toBe(oldPlateBoots);
    expect(migrated.itemId.icon).toBe("/assets/items/generated/Leather%20boots.png?v=2");
  });

  it("adds newly introduced base passives to older generated item objects when read", () => {
    const oldBoneSpear = {
      ...rollGeneratedEquipment({ baseId: "spear_2h", materialId: "bone", rarity: "rare", itemLevel: 4 }, () => 0),
      uid: "old_bone_spear",
      effects: [{ type: "crit_chance", value: 4 }],
    };
    const normalized = getItem(oldBoneSpear);

    expect(normalized).toMatchObject({
      uid: "old_bone_spear",
      rarity: "rare",
      generation: { baseId: "spear_2h", materialId: "bone" },
    });
    expect(normalized.effects).toContainEqual(expect.objectContaining({ type: "damage_vs_tag", tag: "beast" }));
    expect(normalized.effects).toContainEqual({ type: "crit_chance", value: 4 });
  });

  it("only removes dormant legacy combat effects from item objects", () => {
    const oldDagger = {
      ...rollGeneratedEquipment({ baseId: "dagger", materialId: "iron", rarity: "rare", itemLevel: 2 }, () => 0),
      effects: [
        { type: "initiative", value: 2 },
        { type: "reach", value: 1 },
        { type: "crit_chance", value: 6 },
      ],
    };
    const migrated = migrateSavedItemRef(oldDagger);

    expect(migrated).toMatchObject({
      uid: oldDagger.uid,
      rarity: "rare",
      effects: [{ type: "crit_chance", value: 6 }],
    });
  });

  it("removes legacy food buffs from saved dry rations", () => {
    const oldRation = {
      ...getItem("ration"),
      effects: [
        { type: "restore_hunger", value: 20 },
        { type: "food_buff", combats: 3, stats: { str: 2 } },
      ],
    };
    const migrated = migrateInventoryItemRef({ itemId: oldRation, x: 0, y: 0 });

    expect(migrated.itemId.effects).toEqual([{ type: "restore_hunger", value: 20 }]);
  });

  it("migrates saved legacy ring metadata without changing their effects", () => {
    const savedGuardRing = {
      id: "ring_of_thorns",
      name: "Rare Guarding Ring",
      rarity: "rare",
      baseStats: { armor: 3 },
      effects: [{ type: "armor", value: 5 }],
    };
    const savedVampireRing = {
      id: "vampire_ring",
      name: "Blood Ring",
      effects: [{ type: "lifesteal", value: 5 }],
    };
    const savedGustRing = {
      id: "gust_ring",
      name: "Gust Ring",
      effects: [{ type: "attack_speed", value: 8 }],
    };

    expect(migrateSavedItemRef(savedGuardRing)).toMatchObject({
      name: "Rare Guard Ring",
      rarityAffixPools: ["guard", "survival"],
      effects: [{ type: "armor", value: 5 }],
    });
    expect(migrateSavedItemRef(savedVampireRing)).toMatchObject({
      rarityAffixPools: ["blood", "survival"],
      effects: [{ type: "lifesteal", value: 5 }],
    });
    expect(migrateInventoryItemRef({ itemId: savedGustRing, x: 0, y: 0 }).itemId).toMatchObject({
      rarityAffixPools: ["speed", "precision"],
      effects: [{ type: "attack_speed", value: 8 }],
    });
  });

  it("clamps crit damage on saved generated items", () => {
    const oldRapier = {
      ...rollGeneratedEquipment({ baseId: "rapier", materialId: "steel", rarity: "legendary", itemLevel: 8 }, () => 0),
      uid: "old_rapier",
      effects: [
        { type: "parry_chance", value: 10 },
        { type: "crit_chance", value: 2 },
        { type: "crit_damage", value: 34 },
      ],
    };
    const oldQuiver = {
      ...getItem("quiver"),
      uid: "old_quiver",
      baseId: "quiver",
      name: "Old Crit Quiver",
      rarity: "epic",
      effects: [
        { type: "crit_damage", value: 26 },
        { type: "hit_chance", value: 6 },
      ],
    };
    const migrated = migrateInventoryItemRef({ itemId: oldRapier, x: 0, y: 0 });
    const migratedQuiver = migrateSavedItemRef(oldQuiver);

    expect(migrated.itemId).not.toBe(oldRapier);
    expect(migrated.itemId.effects).toContainEqual({ type: "parry_chance", value: 10 });
    expect(migrated.itemId.effects).not.toContainEqual({ type: "crit_chance", value: 2 });
    expect(migrated.itemId.effects).toContainEqual({ type: "crit_damage", value: 9 });
    expect(migratedQuiver).not.toBe(oldQuiver);
    expect(migratedQuiver.effects).toContainEqual({ type: "crit_damage", value: 8 });
    expect(migratedQuiver.effects).toContainEqual({ type: "hit_chance", value: 6 });
  });

  it("raises saved generated rapier parry to the current rarity floor", () => {
    const oldRapier = {
      ...rollGeneratedEquipment({ baseId: "rapier", materialId: "steel", rarity: "legendary", itemLevel: 8 }, () => 0),
      uid: "low_parry_rapier",
      effects: [
        { type: "parry_chance", value: 4 },
        { type: "crit_damage", value: 8 },
      ],
    };

    const migrated = migrateInventoryItemRef({ itemId: oldRapier, x: 0, y: 0 });

    expect(migrated.itemId).not.toBe(oldRapier);
    expect(migrated.itemId.effects).toContainEqual({ type: "parry_chance", value: 7 });
    expect(migrated.itemId.effects).toContainEqual({ type: "crit_damage", value: 8 });
  });

  it("rerolls deprecated elemental affixes on saved generated armor", () => {
    const oldCowl = {
      ...rollGeneratedEquipment({ baseId: "spireweave_cowl", materialId: "ash", rarity: "rare", itemLevel: 9 }, () => 0),
      uid: "old_resist_cowl",
      effects: [
        { type: "spell_damage", value: 2 },
        { type: "magic_defense", value: 2 },
        { type: "fire_resist", value: 10 },
        { type: "max_hp", value: 12 },
      ],
    };

    const migrated = migrateInventoryItemRef({ itemId: oldCowl, x: 0, y: 0 });
    const effectTypes = migrated.itemId.effects.map(effect => effect.type);

    expect(migrated.itemId).not.toBe(oldCowl);
    expect(migrated.itemId.effects).toHaveLength(oldCowl.effects.length);
    expect(effectTypes).not.toContain("fire_resist");
    expect(effectTypes).not.toContain("cold_resist");
    expect(effectTypes).not.toContain("lightning_resist");
    expect(effectTypes).not.toContain("shadow_resist");
    expect(effectTypes).not.toContain("poison_resist");
    expect(effectTypes).not.toContain("all_elemental_resist");
    expect(migrated.itemId.effects).toContainEqual({ type: "max_hp", value: 12 });
  });

  it("rerolls deprecated caster affixes on saved generated leather and heavy armor", () => {
    const oldLeather = {
      ...rollGeneratedEquipment({ baseId: "duskrunner_hood", materialId: "ash", rarity: "rare", itemLevel: 9 }, () => 0),
      uid: "old_caster_leather",
      effects: [
        { type: "dodge_chance", value: 2 },
        { type: "spell_damage", value: 11 },
        { type: "stat_bonus", stat: "int", value: 4 },
      ],
    };
    const oldHeavy = {
      ...rollGeneratedEquipment({ baseId: "oathbound_plate_helm", materialId: "ancient", rarity: "rare", itemLevel: 9 }, () => 0),
      uid: "old_caster_plate",
      effects: [
        { type: "armor", value: 2 },
        { type: "spell_damage", value: 9 },
        { type: "stat_bonus", stat: "int", value: 3 },
      ],
    };
    const migratedLeather = migrateSavedItemRef(oldLeather);
    const migratedHeavy = migrateInventoryItemRef({ itemId: oldHeavy, x: 0, y: 0 }).itemId;

    expect(migratedLeather).not.toBe(oldLeather);
    expect(migratedLeather.effects.some(isCasterArmorEffect)).toBe(false);
    expect(migratedLeather.effects).toContainEqual({ type: "dodge_chance", value: 2 });
    expect(migratedHeavy).not.toBe(oldHeavy);
    expect(migratedHeavy.effects.some(isCasterArmorEffect)).toBe(false);
    expect(migratedHeavy.effects).toContainEqual({ type: "armor", value: 2 });
  });

  it("normalizes deprecated caster armor rolls when generated objects are read directly", () => {
    const oldLeather = {
      ...rollGeneratedEquipment({ baseId: "duskrunner_hood", materialId: "ash", rarity: "rare", itemLevel: 9 }, () => 0),
      uid: "direct_old_caster_leather",
      effects: [
        { type: "dodge_chance", value: 2 },
        { type: "spell_damage", value: 11 },
        { type: "stat_bonus", stat: "int", value: 4 },
      ],
    };

    const normalized = getItem(oldLeather);

    expect(normalized.effects.some(isCasterArmorEffect)).toBe(false);
    expect(normalized.effects).toContainEqual({ type: "dodge_chance", value: 2 });
  });

  it("rerolls caster stats on older generated armor without modern generation metadata", () => {
    const oldLegs = {
      id: "generated_old_leather_chausses",
      name: "Rare Relic Leather Chausses",
      type: "gear",
      slot: "legs",
      family: "armor",
      armorType: "medium",
      generated: true,
      rarity: "rare",
      tags: ["legs", "leather", "medium", "armor_medium", "generated", "dice_v1", "ancient"],
      baseStats: { armor: 8, int: 4, spellDamage: 9 },
      effects: [
        { type: "spell_damage", value: 10 },
        { type: "stat_bonus", stat: "int", value: 3 },
      ],
    };

    const migrated = migrateSavedItemRef(oldLegs);

    expect(migrated).not.toBe(oldLegs);
    expect(migrated.baseStats.int).toBeUndefined();
    expect(migrated.baseStats.spellDamage).toBeUndefined();
    expect(migrated.baseStats.armor).toBe(8);
    expect(migrated.effects.some(isCasterArmorEffect)).toBe(false);
    expect(migrated.effects.length).toBeGreaterThan(0);
  });

  it("keeps saved generated cloth caster affixes", () => {
    const oldCloth = {
      ...rollGeneratedEquipment({ baseId: "spireweave_cowl", materialId: "ash", rarity: "rare", itemLevel: 9 }, () => 0),
      uid: "old_caster_cloth",
      effects: [
        { type: "spell_damage", value: 2 },
        { type: "magic_defense", value: 2 },
        { type: "stat_bonus", stat: "int", value: 3 },
      ],
    };

    expect(migrateSavedItemRef(oldCloth)).toBe(oldCloth);
  });

  it("keeps saved generated cape caster affixes", () => {
    const oldCloak = {
      ...rollGeneratedEquipment({ baseId: "nightfall_cape", materialId: "ancient", rarity: "rare", itemLevel: 9 }, () => 0),
      uid: "old_caster_cloak",
      effects: [
        { type: "shadow_resist", value: 8 },
        { type: "spell_damage", value: 7 },
        { type: "stat_bonus", stat: "int", value: 2 },
      ],
    };

    expect(migrateSavedItemRef(oldCloak)).toBe(oldCloak);
  });

  it("keeps elemental rolls on saved generated accessories", () => {
    const oldRing = {
      ...rollGeneratedEquipment({ baseId: "emberglass_ring", materialId: "ash", rarity: "rare", itemLevel: 9 }, () => 0),
      uid: "old_resist_ring",
      effects: [
        { type: "fire_resist", value: 8 },
        { type: "all_elemental_resist", value: 6 },
      ],
    };

    expect(migrateSavedItemRef(oldRing).effects).toEqual(oldRing.effects);
  });
});
