import { describe, expect, it } from "vitest";
import {
  createStarterEquipment,
  formatDice,
  getGeneratedEquipmentBases,
  rollEquipmentAffixes,
  rollDice,
  rollGeneratedEquipment,
} from "./equipmentGenerator.js";
import { calcStats, initHero } from "./hero.js";
import { getItem } from "./content.js";

function isCasterArmorEffect(effect) {
  return effect?.type === "spell_damage" || (effect?.type === "stat_bonus" && effect.stat === "int");
}

describe("generated equipment", () => {
  it("creates a one-handed weapon with dice metadata and usable average damage", () => {
    const item = rollGeneratedEquipment({
      baseId: "sword_1h",
      materialId: "iron",
      rarity: "normal",
      itemLevel: 1,
    }, () => 0);

    expect(item).toMatchObject({
      generated: true,
      type: "gear",
      slot: "weapon",
      family: "sword",
      hands: 1,
      weaponType: "one_handed_sword",
      damageDice: { count: 1, sides: 8, text: "1d8" },
    });
    expect(item.baseStats.damage).toBe(5);
    expect(item.tags).toEqual(expect.arrayContaining(["generated", "dice_v1", "one_handed"]));
  });

  it("creates armor from armor dice and preserves slot semantics", () => {
    const item = rollGeneratedEquipment({
      baseId: "plate_boots",
      materialId: "steel",
      rarity: "rare",
      itemLevel: 4,
    }, () => 0.25);

    expect(item).toMatchObject({
      generated: true,
      slot: "boots",
      family: "armor",
      armorType: "heavy",
      armorDice: { count: 1, sides: 6 },
    });
    expect(item.armorDice.text).toMatch(/^1d6/);
    expect(item.baseStats.armor).toBeGreaterThanOrEqual(4);
    expect(item.effects.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps rare combat affixes from rolling tiny hit or crit values", () => {
    const affixes = rollEquipmentAffixes({
      id: "test_balanced_weapon",
      family: "sword",
      affixPools: ["balanced"],
      effects: [],
    }, "rare", () => 0);

    expect(affixes).toHaveLength(2);
    expect(affixes).toEqual(expect.arrayContaining([
      { type: "hit_chance", value: 4 },
      { type: "crit_chance", value: 2 },
    ]));
  });

  it("uses one hit chance scaling profile across affix pools", () => {
    const rolls = [0.99, 0.99, 0, 0, 0, 0, 0, 0];
    const affixes = rollEquipmentAffixes({
      id: "test_precision_weapon",
      family: "sword",
      affixPools: ["precision"],
      effects: [],
    }, "legendary", () => rolls.shift() ?? 0);

    expect(affixes).toEqual(expect.arrayContaining([
      { type: "hit_chance", value: 12 },
    ]));
  });

  it("uses the all elemental resist scaling profile from data", () => {
    const rolls = [0.99, 0.99, 0, 0, 0, 0, 0, 0];
    const affixes = rollEquipmentAffixes({
      id: "test_treasure_item",
      family: "armor",
      affixPools: ["treasure"],
      effects: [],
    }, "unique", () => rolls.shift() ?? 0);

    expect(affixes).toEqual(expect.arrayContaining([
      { type: "all_elemental_resist", value: 22 },
    ]));
  });

  it("keeps INT and spell damage on cloth armor and capes instead of leather or heavy armor", () => {
    const clothAffixes = rollEquipmentAffixes({
      id: "test_cloth_armor",
      family: "armor",
      armorType: "cloth",
      tags: ["cloth", "light", "armor_light"],
      affixPools: ["arcane"],
      effects: [],
    }, "artifact", () => 0);
    const leatherAffixes = rollEquipmentAffixes({
      id: "test_leather_armor",
      family: "armor",
      armorType: "medium",
      tags: ["leather", "medium", "armor_medium"],
      affixPools: ["arcane"],
      effects: [],
    }, "artifact", () => 0);
    const heavyAffixes = rollEquipmentAffixes({
      id: "test_heavy_armor",
      family: "armor",
      armorType: "heavy",
      tags: ["plate", "heavy", "armor_heavy"],
      affixPools: ["arcane"],
      effects: [],
    }, "artifact", () => 0);
    const cloakAffixes = rollEquipmentAffixes({
      id: "test_light_cloak",
      family: "cloak",
      slot: "cloak",
      armorType: "light",
      tags: ["cloak", "cape", "light", "armor_light"],
      affixPools: ["arcane"],
      effects: [],
    }, "artifact", () => 0);

    expect(clothAffixes.some(isCasterArmorEffect)).toBe(true);
    expect(leatherAffixes.some(isCasterArmorEffect)).toBe(false);
    expect(heavyAffixes.some(isCasterArmorEffect)).toBe(false);
    expect(cloakAffixes.some(isCasterArmorEffect)).toBe(true);
  });

  it("lets every generated sword base roll dueling parry affixes", () => {
    const swordBases = getGeneratedEquipmentBases({ family: "sword" });
    const duelingAffixes = rollEquipmentAffixes({
      id: "test_dueling_sword",
      family: "sword",
      affixPools: ["dueling"],
      effects: [],
    }, "uncommon", () => 0);

    expect(swordBases.map(base => base.id)).toEqual(expect.arrayContaining(["sword_1h", "rapier", "greatsword_2h"]));
    expect(swordBases.every(base => base.affixPools?.includes("dueling"))).toBe(true);
    expect(duelingAffixes).toEqual(expect.arrayContaining([
      { type: "parry_chance", value: 3 },
    ]));
  });

  it("lets one-handed weapons roll modest block chance but not block power", () => {
    const swordAffixes = rollEquipmentAffixes({
      id: "test_guard_sword",
      slot: "weapon",
      family: "sword",
      hands: 1,
      affixPools: ["weapon_guard"],
      effects: [],
    }, "rare", () => 0);
    const twoHandedAffixes = rollEquipmentAffixes({
      id: "test_guard_greatsword",
      slot: "weapon",
      family: "sword",
      hands: 2,
      affixPools: ["weapon_guard"],
      effects: [],
    }, "rare", () => 0);

    expect(swordAffixes).toEqual([{ type: "block_chance", value: 3 }]);
    expect(swordAffixes.some(effect => effect.type === "block_power")).toBe(false);
    expect(twoHandedAffixes).toEqual([]);
  });

  it("lets the Guard Ring roll block chance without opening block power to rings", () => {
    const rolls = [0.6, 0, 0, 0];
    const affixes = rollEquipmentAffixes({
      id: "ring_of_thorns",
      slot: "ring",
      family: "ring",
      affixPools: ["guard"],
      effects: [],
    }, "rare", () => rolls.shift() ?? 0);

    expect(affixes).toContainEqual({ type: "block_chance", value: 3 });
    expect(affixes.some(effect => effect.type === "block_power")).toBe(false);
  });

  it("rolls rapier base parry from 3-5 and scales it with rarity", () => {
    const normal = rollGeneratedEquipment({
      baseId: "rapier",
      materialId: "iron",
      rarity: "normal",
      itemLevel: 1,
    }, (() => {
      const rolls = [0, 0.99];
      return () => rolls.shift() ?? 0;
    })());
    const legendary = rollGeneratedEquipment({
      baseId: "rapier",
      materialId: "steel",
      rarity: "legendary",
      itemLevel: 5,
    }, (() => {
      const rolls = [0, 0.99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      return () => rolls.shift() ?? 0;
    })());

    expect(normal.effects).toEqual([{ type: "parry_chance", value: 5 }]);
    expect(legendary.effects.find(effect => effect.type === "parry_chance")).toEqual({ type: "parry_chance", value: 10 });
    expect(normal.effects.some(effect => effect.type === "crit_chance")).toBe(false);
    expect(legendary.effects).not.toContainEqual({ type: "crit_chance", value: 2 });
  });

  it("lets Duskrunner boots roll dueling parry affixes", () => {
    const boots = rollGeneratedEquipment({
      baseId: "duskrunner_boots",
      materialId: "ash",
      rarity: "uncommon",
      itemLevel: 5,
    }, (() => {
      const rolls = [0, 0.5, 0];
      return () => rolls.shift() ?? 0;
    })());

    expect(boots.effects).toEqual(expect.arrayContaining([
      { type: "parry_chance", value: 3 },
    ]));
  });

  it("keeps generated crit damage affixes capped at ten percent", () => {
    const rolls = [0.5, 0.99, 0, 0, 0, 0, 0, 0];
    const affixes = rollEquipmentAffixes({
      id: "test_precision_weapon",
      family: "sword",
      affixPools: ["precision"],
      effects: [],
    }, "artifact", () => rolls.shift() ?? 0);
    const critDamage = affixes.find(effect => effect.type === "crit_damage");

    expect(critDamage).toEqual({ type: "crit_damage", value: 10 });
  });

  it("gives uncommon generated items one green affix", () => {
    const item = rollGeneratedEquipment({
      baseId: "sword_1h",
      materialId: "iron",
      rarity: "uncommon",
      itemLevel: 2,
    }, () => 0);

    expect(item).toMatchObject({
      rarity: "uncommon",
      rarityColor: "#2ecc71",
      name: "Uncommon Iron Sword",
    });
    expect(item.effects).toHaveLength(1);
  });

  it("keeps regular generated armor bonuses limited to rolled affixes", () => {
    const leather = rollGeneratedEquipment({
      baseId: "leather_boots",
      materialId: "cured",
      rarity: "normal",
      itemLevel: 2,
    }, () => 0);
    const mail = rollGeneratedEquipment({
      baseId: "mail_chest",
      materialId: "iron",
      rarity: "normal",
      itemLevel: 2,
    }, () => 0);
    const plate = rollGeneratedEquipment({
      baseId: "plate_chest",
      materialId: "iron",
      rarity: "normal",
      itemLevel: 2,
    }, () => 0);
    const rareMail = rollGeneratedEquipment({
      baseId: "mail_chest",
      materialId: "bone",
      rarity: "rare",
      itemLevel: 4,
    }, () => 0);

    expect(leather.effects).toHaveLength(0);
    expect(leather).toMatchObject({
      armorType: "medium",
      tags: expect.arrayContaining(["medium", "leather", "armor_medium"]),
    });
    expect(leather.icon).toBe("/assets/items/generated/Leather%20boots.png?v=2");
    expect(mail.effects).toHaveLength(0);
    expect(plate.effects).toHaveLength(0);
    expect(rareMail.effects).toHaveLength(2);
    expect(rareMail.effects).not.toEqual(expect.arrayContaining([
      { type: "crit_chance", value: 1 },
      { type: "hit_chance", value: 2 },
    ]));
  });

  it("keeps percent armor and percent damage out of regular generated affixes but allows them on special rarities", () => {
    const regularArmorRolls = Array.from({ length: 20 }, (_, index) =>
      rollGeneratedEquipment({
        baseId: "tower_shield",
        materialId: "iron",
        rarity: "legendary",
        itemLevel: 6,
      }, () => index / 19),
    );
    const regularDamageRolls = Array.from({ length: 20 }, (_, index) =>
      rollGeneratedEquipment({
        baseId: "greataxe_2h",
        materialId: "iron",
        rarity: "legendary",
        itemLevel: 6,
      }, () => index / 19),
    );
    const artifactArmor = rollGeneratedEquipment({
      baseId: "tower_shield",
      materialId: "iron",
      rarity: "artifact",
      itemLevel: 6,
    }, () => 0.25);
    const artifactWeapon = rollGeneratedEquipment({
      baseId: "greataxe_2h",
      materialId: "iron",
      rarity: "artifact",
      itemLevel: 6,
    }, () => 0);

    expect(regularArmorRolls.every(item => !(item.effects || []).some(effect => effect.type === "armor_pct"))).toBe(true);
    expect(regularDamageRolls.every(item => !(item.effects || []).some(effect => effect.type === "damage_bonus_pct"))).toBe(true);
    expect(artifactArmor.effects.some(effect => effect.type === "armor_pct")).toBe(true);
    expect(artifactWeapon.effects.some(effect => effect.type === "damage_bonus_pct")).toBe(true);
  });

  it("prevents arcane materials from adding INT or spell damage to leather and heavy armor", () => {
    const duskrunner = rollGeneratedEquipment({
      baseId: "duskrunner_hood",
      materialId: "ash",
      rarity: "artifact",
      itemLevel: 9,
    }, () => 0);
    const oathbound = rollGeneratedEquipment({
      baseId: "oathbound_plate_helm",
      materialId: "ancient",
      rarity: "artifact",
      itemLevel: 9,
    }, () => 0);

    expect(duskrunner).toMatchObject({
      armorType: "medium",
      tags: expect.arrayContaining(["medium", "leather", "armor_medium"]),
    });
    expect(duskrunner.effects.some(isCasterArmorEffect)).toBe(false);
    expect(oathbound.effects.some(isCasterArmorEffect)).toBe(false);
  });

  it("normalizes saved placeholder icons for leather boots and fur cloak", () => {
    const savedBoots = getItem({
      id: "old_boots_uid",
      baseId: "leather_boots",
      generation: { baseId: "leather_boots" },
      icon: "/assets/items/generated/leather_chausses.png",
    });
    const oldGeneratedBoots = getItem({
      id: "generated_leather_boots",
      baseId: "generated_leather_boots",
      name: "Worn Leather Boots",
      slot: "boots",
      tags: ["boots", "light", "leather", "armor_light", "generated"],
      icon: "/assets/items/generated/leather_chausses.png",
    });
    const oldGeneratedPlateBoots = getItem({
      id: "generated_plate_boots",
      baseId: "generated_plate_boots",
      name: "Bloodforged Plate Sabatons",
      slot: "boots",
      tags: ["boots", "heavy", "plate", "armor_heavy", "generated"],
      icon: "/assets/items/generated/plate_legguards.png",
    });
    const savedCloak = getItem({
      id: "fur_cloak",
      baseId: "fur_cloak",
      icon: "/assets/items/generated/leather_chausses.png",
    });

    expect(savedBoots.icon).toBe("/assets/items/generated/Leather%20boots.png?v=2");
    expect(oldGeneratedBoots.icon).toBe("/assets/items/generated/Leather%20boots.png?v=2");
    expect(oldGeneratedPlateBoots.icon).toBe("/assets/items/generated/Leather%20boots.png?v=2");
    expect(savedCloak.icon).toBe("/assets/items/generated/cape.png?v=2");
  });

  it("normalizes old saved generic armor base passives away", () => {
    const savedMail = getItem({
      id: "old_mail_uid",
      baseId: "generated_mail_chest",
      generation: { baseId: "mail_chest" },
      effects: [
        { type: "crit_chance", value: 1 },
        { type: "hit_chance", value: 2 },
        { type: "armor", value: 5 },
        { type: "max_hp", value: 12 },
      ],
    });

    expect(savedMail.effects).toEqual([
      { type: "armor", value: 5 },
      { type: "max_hp", value: 12 },
    ]);
  });

  it("does not apply hidden light armor passives to hero stats", () => {
    const weapon = rollGeneratedEquipment({
      baseId: "sword_1h",
      materialId: "iron",
      rarity: "normal",
      itemLevel: 1,
    }, () => 0);
    const chest = rollGeneratedEquipment({
      baseId: "leather_chest",
      materialId: "cured",
      rarity: "normal",
      itemLevel: 2,
    }, () => 0);
    const boots = rollGeneratedEquipment({
      baseId: "leather_boots",
      materialId: "cured",
      rarity: "normal",
      itemLevel: 2,
    }, () => 0);
    const hero = initHero("Tester");
    hero.equip.weapon = weapon;
    hero.equip.chest = chest;
    hero.equip.boots = boots;

    const stats = calcStats(hero);

    expect(stats.dodgeChance).toBe(0);
    expect(stats.weaponAttackSpeed).toBeCloseTo(weapon.attackSpeed, 5);
  });

  it("can generate bone shields from shield bases", () => {
    const buckler = rollGeneratedEquipment({
      baseId: "buckler",
      materialId: "bone",
      rarity: "normal",
      itemLevel: 2,
    }, () => 0);
    const tower = rollGeneratedEquipment({
      baseId: "tower_shield",
      materialId: "bone",
      rarity: "normal",
      itemLevel: 2,
    }, () => 0);

    expect(buckler).toMatchObject({
      generated: true,
      family: "shield",
      armorType: "shield",
      generation: { materialId: "bone" },
    });
    expect(tower).toMatchObject({
      generated: true,
      family: "shield",
      armorType: "shield",
      generation: { materialId: "bone" },
    });
    expect(buckler.effects).toEqual(expect.arrayContaining([
      { type: "block_chance", value: 4 },
      { type: "block_power", value: 12 },
    ]));
  });

  it("generates Bloodforged heavy war gear for late martial loot pools", () => {
    const item = rollGeneratedEquipment({
      baseId: "greataxe_2h",
      materialId: "bloodiron",
      rarity: "rare",
      itemLevel: 5,
    }, () => 0.2);

    expect(item).toMatchObject({
      generated: true,
      name: expect.stringContaining("Bloodforged"),
      family: "axe",
      generation: { materialId: "bloodiron" },
    });
    expect(item.tags).toContain("bloodiron");
    expect(item.damageDice.average).toBeGreaterThan(rollGeneratedEquipment({
      baseId: "greataxe_2h",
      materialId: "steel",
      rarity: "rare",
      itemLevel: 5,
    }, () => 0.2).damageDice.average);
  });

  it("does not duplicate the Ashen label on Ashenwood bows", () => {
    const shortbow = rollGeneratedEquipment({
      baseId: "ashenwood_shortbow",
      materialId: "ash",
      rarity: "normal",
      itemLevel: 5,
    }, () => 0);
    const longbow = rollGeneratedEquipment({
      baseId: "ashenwood_longbow",
      materialId: "ash",
      rarity: "normal",
      itemLevel: 5,
    }, () => 0);

    expect(shortbow.name).toBe("Runed Ashenwood Shortbow");
    expect(longbow.name).toBe("Runed Ashenwood Longbow");
    expect(shortbow.name).not.toMatch(/^Ashen Ashenwood/);
    expect(longbow.name).not.toMatch(/^Ashen Ashenwood/);
  });

  it("can roll and format dice independently", () => {
    expect(formatDice({ count: 2, sides: 12, bonus: 3 })).toBe("2d12+3");
    expect(rollDice({ count: 2, sides: 12, bonus: 3 }, () => 0)).toBe(5);
  });

  it("is compatible with hero equipment stats", () => {
    const weapon = rollGeneratedEquipment({
      baseId: "dagger",
      materialId: "iron",
      rarity: "normal",
      itemLevel: 1,
    }, () => 0);
    const hero = initHero("Tester");
    hero.equip.weapon = weapon;
    hero.equip.offhand = null;

    const stats = calcStats(hero);

    expect(stats.damage).toBeGreaterThanOrEqual(weapon.baseStats.damage);
    expect(stats.weaponAttackSpeed).toBe(weapon.attackSpeed);
  });

  it("gives generated spears a beast-hunting passive", () => {
    const spear = rollGeneratedEquipment({
      baseId: "spear_2h",
      materialId: "iron",
      rarity: "normal",
      itemLevel: 1,
    }, () => 0);

    expect(spear.effects).toContainEqual({ type: "damage_vs_tag", tag: "beast", value: 15 });
  });

  it("generates Rootspire accessories without forcing armor dice and applies magic-find resist stats", () => {
    const ring = rollGeneratedEquipment({
      baseId: "emberglass_ring",
      materialId: "ancient",
      rarity: "normal",
      itemLevel: 9,
    }, () => 0);
    const hero = initHero("Tester");
    hero.equip.ring = {
      ...ring,
      effects: [
        ...(ring.effects || []),
        { type: "all_elemental_resist", value: 6 },
        { type: "magic_find", value: 5 },
      ],
    };

    const stats = calcStats(hero);

    expect(ring).toMatchObject({
      generated: true,
      slot: "ring",
      family: "ring",
      generation: { baseId: "emberglass_ring", materialId: "ancient" },
    });
    expect(ring.armorDice).toBeUndefined();
    expect(ring.baseStats.armor).toBeUndefined();
    expect(stats.fireResist).toBeGreaterThanOrEqual(14);
    expect(stats.coldResist).toBeGreaterThanOrEqual(6);
    expect(stats.shadowResist).toBeGreaterThanOrEqual(6);
    expect(stats.magicFind).toBe(5);
  });

  it("rolls treasure affixes for magic find and rare all-elemental resistance", () => {
    const magicFindAffixes = rollEquipmentAffixes({ affixPools: ["treasure"], effects: [] }, "uncommon", () => 0);
    const allResistAffixes = rollEquipmentAffixes({ affixPools: ["treasure"], effects: [] }, "uncommon", () => 0.99);

    expect(magicFindAffixes).toContainEqual(expect.objectContaining({ type: "magic_find" }));
    expect(allResistAffixes).toContainEqual(expect.objectContaining({ type: "all_elemental_resist" }));
  });

  it("exposes filtered base pools for loot tables", () => {
    const bases = getGeneratedEquipmentBases({ slots: ["weapon"], tags: ["two_handed"] });

    expect(bases.length).toBeGreaterThan(0);
    expect(bases.every(base => base.slot === "weapon")).toBe(true);
    expect(bases.every(base => base.tags.includes("two_handed"))).toBe(true);
  });

  it("creates starter loadouts for sword, mace, spear, and bow", () => {
    const expected = {
      sword: ["Crude Sword", "sword", "1d8-1"],
      mace: ["Crude Mace", "mace", "1d8-1"],
      spear: ["Crude Spear", "spear", "1d12-2"],
      bow: ["Worn Bow", "bow", "1d4"],
    };

    for (const [loadoutId, [name, family, diceText]] of Object.entries(expected)) {
      const starter = createStarterEquipment(loadoutId, () => 0);

      expect(starter.weapon).toMatchObject({
        generated: true,
        starter: true,
        name,
        family,
        damageDice: { text: diceText },
      });
      expect(starter.chest).toMatchObject({
        generated: true,
        starter: true,
        name: "Threadbare Tunic",
        armorType: "cloth",
        armorDice: { text: "1d2" },
      });
    }
  });

  it("uses the generated Crude Sword when new character creation requests sword", () => {
    const hero = initHero("Tester", { characterCreated: true, weapon: "sword" });

    expect(hero.equip.weapon).toMatchObject({
      generated: true,
      starter: true,
      name: "Crude Sword",
      family: "sword",
      damageDice: { text: "1d8-1" },
    });
    expect(hero.equip.weapon.id).toBe("generated_sword_1h");
  });
});
