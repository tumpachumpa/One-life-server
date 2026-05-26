import { equipmentSets, getItem, getTalentNode, talentTrees } from "./content.js";

const SPECIALIZATION_REQUIREMENTS = {
  two_handed_weapons: {
    weaponTags: ["two_handed", "melee"],
    excludedWeaponFamilies: ["knuckles"],
    excludedWeaponTags: ["ranged"],
  },
  ranged_weapons: { weaponTags: ["ranged"] },
  sharpshooter: { weaponTags: ["ranged"] },
  ranger: { weaponTags: ["ranged"] },
  one_handed_swords: { weaponFamily: "sword", excludedWeaponTags: ["two_handed", "ranged"] },
  one_handed_maces: { weaponFamily: "mace", excludedWeaponTags: ["two_handed", "ranged"] },
  one_handed_axes: { weaponFamily: "axe", excludedWeaponTags: ["two_handed", "ranged"] },
  shield: { offhandFamily: "shield" },
};

export function normalizeEffects(effects = []) {
  return effects.map(effect => ({ ...effect }));
}

function getTalentEquipmentRequirement(talentId) {
  for (const tree of talentTrees) {
    for (const branch of tree.branches || []) {
      for (const tier of branch.tiers || []) {
        if ((tier.choices || []).some(choice => choice.id === talentId)) {
          return SPECIALIZATION_REQUIREMENTS[branch.id] || null;
        }
      }
    }
  }
  return null;
}

function matchesEquipmentRequirement(hero, requirement) {
  if (!requirement) return true;
  const weapon = getItem(hero?.equip?.weapon);
  const offhand = getItem(hero?.equip?.offhand);
  const weaponFamily = weapon?.family || hero?.weaponFamily || null;
  const offhandFamily = offhand?.family || hero?.offhandFamily || null;
  const weaponTags = weapon?.tags || hero?.weaponTags || [];
  if (requirement.weaponFamily && weaponFamily !== requirement.weaponFamily) return false;
  if (requirement.offhandFamily && offhandFamily !== requirement.offhandFamily) return false;
  if (requirement.weaponTags && !requirement.weaponTags.every(tag => weaponTags.includes(tag))) return false;
  if (requirement.excludedWeaponFamilies?.includes(weaponFamily)) return false;
  if (requirement.excludedWeaponTags?.some(tag => weaponTags.includes(tag))) return false;
  return true;
}

function isRangedWeaponItem(item) {
  const tags = item?.tags || [];
  return item?.attackType === "ranged"
    || item?.family === "ranged"
    || item?.weaponFamily === "ranged"
    || tags.includes("ranged");
}

function isQuiverItem(item) {
  const tags = item?.tags || [];
  return item?.family === "quiver"
    || item?.id === "quiver"
    || item?.baseId === "quiver"
    || item?.generation?.baseId === "quiver"
    || tags.includes("quiver");
}

export function isQuiverInactiveForHero(hero, slot, item) {
  if (slot !== "bag" || !isQuiverItem(item)) return false;
  return !isRangedWeaponItem(getItem(hero?.equip?.weapon));
}

export function collectItemEffects(hero) {
  const effects = [];
  const talentEffects = collectTalentEffects(hero);
  const canDualWield = talentEffects.some(effect => effect.type === "dual_wield" && (effect.value || 0) > 0);
  for (const [slot, itemRef] of Object.entries(hero.equip || {})) {
    if (!itemRef) continue;
    const item = getItem(itemRef);
    if (slot === "offhand" && item?.slot === "weapon" && !canDualWield) continue;
    if (isQuiverInactiveForHero(hero, slot, item)) continue;
    if (item?.effects) effects.push(...normalizeEffects(item.effects).map(e => ({ ...e, source: item.uid || item.id })));
    if (item?.enchantment?.effect?.type === 'passive_lifesteal') {
      effects.push({ type: 'lifesteal', value: item.enchantment.effect.lifestealPct || 0, source: item.uid || item.id });
    }
  }
  return effects;
}

export function collectTalentEffects(hero) {
  const effects = [];
  for (const [talentId, rank] of Object.entries(hero.talents || {})) {
    if (!rank) continue;
    const requirement = getTalentEquipmentRequirement(talentId);
    if (!matchesEquipmentRequirement(hero, requirement)) continue;
    const node = getTalentNode(talentId);
    if (!node) continue;
    if (node.effects) effects.push(...normalizeEffects(node.effects).map(e => ({ ...e, source: talentId })));
    if (node.effectsPerRank) {
      for (const effect of node.effectsPerRank) {
        effects.push({ ...effect, value: (effect.value || 0) * rank, source: talentId });
      }
    }
  }
  return effects;
}

export function collectActiveFoodBuffEffects(hero) {
  const effects = [];
  for (const buff of hero.activeBuffs || []) {
    for (const [stat, value] of Object.entries(buff.stats || {})) {
      if (stat === "attackSpeedPct") {
        effects.push({ type: "attack_speed_pct", value, source: `food_${buff.itemId}` });
      } else if (stat === "maxHpPct") {
        effects.push({ type: "max_hp_pct", value, source: `food_${buff.itemId}` });
      } else {
        effects.push({ type: "stat_bonus", stat, value, source: `food_${buff.itemId}` });
      }
    }
  }
  return effects;
}

export function collectSetBonuses(hero) {
  const effects = [];
  const equippedBaseIds = new Set();
  for (const itemRef of Object.values(hero.equip || {})) {
    if (!itemRef) continue;
    const item = getItem(itemRef);
    const baseId = item?.generation?.baseId || item?.baseId || item?.id;
    if (baseId) equippedBaseIds.add(baseId);
  }
  for (const [setId, setDef] of Object.entries(equipmentSets)) {
    const count = setDef.pieces.filter(p => equippedBaseIds.has(p)).length;
    if (count === 0) continue;
    for (const [threshold, bonusEffects] of Object.entries(setDef.bonuses)) {
      if (count >= Number(threshold)) {
        effects.push(...bonusEffects.map(e => ({ ...e, source: `set_${setId}_${threshold}` })));
      }
    }
  }
  return effects;
}

export function getEquippedSetInfo(hero) {
  const result = [];
  const equippedBaseIds = new Set();
  for (const itemRef of Object.values(hero.equip || {})) {
    if (!itemRef) continue;
    const item = getItem(itemRef);
    const baseId = item?.generation?.baseId || item?.baseId || item?.id;
    if (baseId) equippedBaseIds.add(baseId);
  }
  for (const [setId, setDef] of Object.entries(equipmentSets)) {
    const count = setDef.pieces.filter(p => equippedBaseIds.has(p)).length;
    if (count === 0) continue;
    result.push({ setId, name: setDef.name, count, total: setDef.pieces.length, bonuses: setDef.bonuses });
  }
  return result;
}

export function collectEffects(hero) {
  return [...collectItemEffects(hero), ...collectTalentEffects(hero), ...collectActiveFoodBuffEffects(hero), ...collectSetBonuses(hero)];
}

export function collectProcNodes(hero) {
  const nodes = [];
  for (const [talentId, rank] of Object.entries(hero?.talents || {})) {
    if (!rank) continue;
    const requirement = getTalentEquipmentRequirement(talentId);
    if (!matchesEquipmentRequirement(hero, requirement)) continue;
    const node = getTalentNode(talentId);
    if (!node) continue;
    if (node.proc) nodes.push({ id: talentId, proc: node.proc });
    if (node.threshold) nodes.push({ id: talentId, threshold: node.threshold });
  }
  return nodes;
}

export function sumEffect(effects, type) {
  return effects.filter(e => e.type === type).reduce((sum, effect) => sum + (effect.value || 0), 0);
}

export function maxEffect(effects, type, fallback = 0) {
  const matches = effects.filter(e => e.type === type);
  return matches.length ? Math.max(...matches.map(e => e.value || 0)) : fallback;
}

export function effectsOfType(effects, type) {
  return effects.filter(e => e.type === type);
}
