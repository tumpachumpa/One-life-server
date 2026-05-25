import { getItem } from "./content.js";
import { INV_COLS } from "../constants.js";

export { INV_COLS };

function getRawItemRef(itemRef) {
  return itemRef && typeof itemRef === "object" && Object.prototype.hasOwnProperty.call(itemRef, "itemId")
    ? itemRef.itemId
    : itemRef;
}

function getItemBaseId(itemRef) {
  const ref = getRawItemRef(itemRef);
  return typeof ref === "object" ? ref?.baseId || ref?.id : ref;
}

function isCampfireStackItem(itemRef, item) {
  const baseId = getItemBaseId(itemRef);
  return baseId === "campfire"
    || item?.baseId === "campfire"
    || item?.id === "campfire"
    || item?.family === "camp_supply"
    || item?.tags?.includes("campfire");
}

function stableVariant(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(stableVariant);
  if (typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((next, key) => {
    next[key] = stableVariant(value[key]);
    return next;
  }, {});
}

export function getItemStackKey(itemRef) {
  const ref = getRawItemRef(itemRef);
  const item = getItem(ref);
  if (!item?.stackable) return null;
  const baseId = getItemBaseId(ref);
  if (isCampfireStackItem(ref, item)) {
    const rarity = typeof ref === "object" ? ref.rarity || "normal" : "normal";
    return `${baseId}:campfire:${rarity}`;
  }
  if (ref && typeof ref === "object") {
    if (ref.uid) return `${baseId}:uid:${ref.uid}`;
    const variant = {
      rarity: ref.rarity || null,
      effects: ref.effects || null,
      baseStats: ref.baseStats || null,
      price: ref.price ?? null,
      name: ref.name || null,
    };
    if (Object.values(variant).some(value => value != null)) {
      // If the object is just the unmodified base item definition (e.g. a plain loot drop),
      // treat it the same as its plain string ID so recipe ingredient counts work correctly.
      const baseItem = getItem(baseId);
      if (baseItem) {
        const baseVariant = {
          rarity: baseItem.rarity || null,
          effects: baseItem.effects || null,
          baseStats: baseItem.baseStats || null,
          price: baseItem.price ?? null,
          name: baseItem.name || null,
        };
        if (JSON.stringify(stableVariant(variant)) === JSON.stringify(stableVariant(baseVariant))) {
          return baseId;
        }
      }
      return `${baseId}:variant:${JSON.stringify(stableVariant(variant))}`;
    }
  }
  return baseId;
}

export function sameItemRef(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const stackA = getItemStackKey(a);
  const stackB = getItemStackKey(b);
  if (stackA || stackB) return !!stackA && stackA === stackB;
  const refA = getRawItemRef(a);
  const refB = getRawItemRef(b);
  if (typeof refA === "object" || typeof refB === "object") {
    if (refA?.uid || refB?.uid) return !!refA?.uid && refA.uid === refB?.uid;
  }
  return getItemBaseId(refA) === getItemBaseId(refB);
}

export function itemGridSize(itemRef) {
  return getItem(itemRef)?.size ?? [1, 1];
}

function buildOccupied(items, excludeIdx = -1) {
  const cells = new Set();
  for (let i = 0; i < items.length; i++) {
    if (i === excludeIdx) continue;
    const { itemId, x, y } = items[i];
    const [w, h] = itemGridSize(itemId);
    for (let dx = 0; dx < w; dx++)
      for (let dy = 0; dy < h; dy++)
        cells.add(`${x + dx},${y + dy}`);
  }
  return cells;
}

export function canPlace(items, itemRef, x, y, rows, excludeIdx = -1, cols = INV_COLS) {
  const [w, h] = itemGridSize(itemRef);
  if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false;
  const occ = buildOccupied(items, excludeIdx);
  for (let dx = 0; dx < w; dx++)
    for (let dy = 0; dy < h; dy++)
      if (occ.has(`${x + dx},${y + dy}`)) return false;
  return true;
}

export function autoPlace(items, itemRef, rows, cols = INV_COLS) {
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      if (canPlace(items, itemRef, x, y, rows, -1, cols)) return { x, y };
  return null;
}

export function addToGrid(items, itemRef, rows, qty = 1, cols = INV_COLS) {
  const item = getItem(itemRef);
  if (!item) return null;
  if (item.stackable) {
    const idx = items.findIndex(p => sameItemRef(p.itemId, itemRef));
    if (idx >= 0) {
      return items.map((p, i) => i === idx ? { ...p, qty: (p.qty || 1) + qty } : p);
    }
  }
  const pos = autoPlace(items, itemRef, rows, cols);
  if (!pos) return null;
  return [...items, { itemId: itemRef, x: pos.x, y: pos.y, qty }];
}

export function removeFromGrid(items, idx, qty = 1) {
  const p = items[idx];
  if (!p) return items;
  const newQty = (p.qty || 1) - qty;
  if (newQty <= 0) return items.filter((_, i) => i !== idx);
  return items.map((p2, i) => i === idx ? { ...p2, qty: newQty } : p2);
}

export function removeFirstFromGrid(items, itemRef) {
  const idx = items.findIndex(p => sameItemRef(p.itemId, itemRef));
  if (idx < 0) return items;
  return removeFromGrid(items, idx, 1);
}

export function removeManyFromGrid(items, itemRef, count) {
  const idx = items.findIndex(p => sameItemRef(p.itemId, itemRef));
  if (idx < 0) return items;
  return removeFromGrid(items, idx, count);
}

export function countInGrid(items, itemRef) {
  return items.reduce((sum, p) => sum + (sameItemRef(p.itemId, itemRef) ? (p.qty || 1) : 0), 0);
}

export function addQuantityToGrid(items, itemRef, rows, qty = 1) {
  const item = getItem(itemRef);
  if (!item) return null;
  const count = Math.max(1, Math.floor(Number(qty || 1)));
  if (item.stackable) return addToGrid(items, itemRef, rows, count);
  let next = items;
  for (let moved = 0; moved < count; moved += 1) {
    const added = addToGrid(next, itemRef, rows, 1);
    if (!added) return null;
    next = added;
  }
  return next;
}

export function transferGridQuantity(sourceItems = [], targetItems = [], sourceIdx = -1, itemRef = null, targetRows = 6, qty = 1) {
  const fallbackIdx = itemRef == null ? -1 : sourceItems.findIndex(p => sameItemRef(p.itemId, itemRef));
  const idx = Number.isInteger(sourceIdx) && sourceIdx >= 0 && sourceIdx < sourceItems.length
    ? sourceIdx
    : fallbackIdx;
  const sourceEntry = sourceItems[idx];
  if (!sourceEntry) return null;
  const available = Math.max(1, Math.floor(sourceEntry.qty || 1));
  const count = Math.max(1, Math.min(available, Math.floor(Number(qty || 1))));
  const nextTarget = addQuantityToGrid(targetItems, sourceEntry.itemId, targetRows, count);
  if (!nextTarget) return null;
  return {
    source: removeFromGrid(sourceItems, idx, count),
    target: nextTarget,
    moved: count,
  };
}

export function hasSpaceFor(items, itemRef, rows, cols = INV_COLS) {
  const item = getItem(itemRef);
  if (!item) return false;
  if (item.stackable && items.some(p => sameItemRef(p.itemId, itemRef))) return true;
  return autoPlace(items, itemRef, rows, cols) !== null;
}

export function moveItem(items, idx, newX, newY, rows, cols = INV_COLS) {
  if (!items[idx]) return items;
  if (!canPlace(items, items[idx].itemId, newX, newY, rows, idx, cols)) return items;
  return items.map((p, i) => i === idx ? { ...p, x: newX, y: newY } : p);
}

export function unequipToGrid(hero, slot, rows) {
  const equipped = hero?.equip?.[slot];
  if (!equipped) return { ok: true, hero };
  const nextInventory = addToGrid(hero.inventory || [], equipped, rows);
  if (!nextInventory) return { ok: false, reason: "no_space", hero };
  return {
    ok: true,
    hero: {
      ...hero,
      equip: { ...(hero.equip || {}), [slot]: null },
      inventory: nextInventory,
    },
  };
}

export function getUsedCellCount(items) {
  return buildOccupied(items).size;
}

function normalizeGridEntry(rawEntry) {
  if (!rawEntry) return null;
  if (typeof rawEntry === "object" && Object.prototype.hasOwnProperty.call(rawEntry, "itemId")) {
    return {
      itemId: rawEntry.itemId,
      x: Number(rawEntry.x),
      y: Number(rawEntry.y),
      qty: Math.max(1, Math.floor(rawEntry.qty || 1)),
    };
  }
  return { itemId: rawEntry, x: NaN, y: NaN, qty: 1 };
}

export function normalizeGridItems(items = [], rows = 6) {
  let result = [];
  for (const rawEntry of items || []) {
    const entry = normalizeGridEntry(rawEntry);
    if (!entry || !getItem(entry.itemId)) continue;
    const x = Math.floor(entry.x);
    const y = Math.floor(entry.y);
    if (Number.isFinite(x) && Number.isFinite(y) && canPlace(result, entry.itemId, x, y, rows)) {
      result = [...result, { itemId: entry.itemId, x, y, qty: entry.qty }];
      continue;
    }
    result = addToGrid(result, entry.itemId, rows, entry.qty) || result;
  }
  return result;
}

export function normalizeGridItemsWithOverflow(items = [], rows = 6) {
  let result = [];
  const overflow = [];
  for (const rawEntry of items || []) {
    const entry = normalizeGridEntry(rawEntry);
    if (!entry || !getItem(entry.itemId)) continue;
    const x = Math.floor(entry.x);
    const y = Math.floor(entry.y);
    if (Number.isFinite(x) && Number.isFinite(y) && canPlace(result, entry.itemId, x, y, rows)) {
      result = [...result, { itemId: entry.itemId, x, y, qty: entry.qty }];
      continue;
    }
    const added = addToGrid(result, entry.itemId, rows, entry.qty);
    if (added) {
      result = added;
    } else {
      const qty = entry.qty || 1;
      for (let i = 0; i < qty; i++) overflow.push(entry.itemId);
    }
  }
  return { items: result, overflow };
}

export function migrateToGrid(oldInventory, rows = 6) {
  return normalizeGridItems(oldInventory, rows);
}

const _TYPE_SORT_ORDER = { gear: 0, material: 1, enchantment_stone: 2, relic: 3, consumable: 4, resource: 5 };
const _SLOT_SORT_ORDER = { weapon: 0, offhand: 1, helmet: 2, chest: 3, legs: 4, boots: 5, gloves: 6, cloak: 7, ring: 8, ring2: 9, amulet: 10, bag: 11 };
const _RARITY_SORT_ORDER = { artifact: 0, legendary: 1, unique: 2, epic: 3, rare: 4, uncommon: 5, normal: 6 };

export function sortInventory(items, rows) {
  const sorted = [...items].sort((a, b) => {
    const itemA = getItem(a.itemId);
    const itemB = getItem(b.itemId);
    const typeA = _TYPE_SORT_ORDER[itemA?.type] ?? 99;
    const typeB = _TYPE_SORT_ORDER[itemB?.type] ?? 99;
    if (typeA !== typeB) return typeA - typeB;
    const slotA = _SLOT_SORT_ORDER[itemA?.slot] ?? 99;
    const slotB = _SLOT_SORT_ORDER[itemB?.slot] ?? 99;
    if (slotA !== slotB) return slotA - slotB;
    const rarityA = _RARITY_SORT_ORDER[itemA?.rarity || "normal"] ?? 99;
    const rarityB = _RARITY_SORT_ORDER[itemB?.rarity || "normal"] ?? 99;
    if (rarityA !== rarityB) return rarityA - rarityB;
    return (itemA?.name || "").localeCompare(itemB?.name || "");
  });

  let newGrid = [];
  const skipped = [];
  for (const placed of sorted) {
    const pos = autoPlace(newGrid, placed.itemId, rows);
    if (pos) newGrid.push({ ...placed, x: pos.x, y: pos.y });
    else skipped.push(placed);
  }
  for (const placed of skipped) {
    const pos = autoPlace(newGrid, placed.itemId, rows);
    if (pos) newGrid.push({ ...placed, x: pos.x, y: pos.y });
    else newGrid.push(placed);
  }
  return newGrid;
}
