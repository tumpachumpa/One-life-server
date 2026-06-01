// Shared runemark (runeforge) definitions — single source of truth.
//
// Both the forge UI (RuneforgeTab.jsx) and combat effect collection
// (effectEngine.js → collectItemEffects) read from this pool. Effect
// collection recomputes a mark's value from its tier here (see
// runemarkValueFor) instead of trusting the value stored on the item, so
// rebalancing a tier value automatically applies to ALREADY-forged items —
// on both the client (stat/display) and the authoritative server combat.
//
// Mirrored to onelife-server/src/game/logic/runemarks.js (keep in sync).

export const RUNEMARK_POOL = [
  { type: "damage_bonus_pct",       label: "Damage",        tiers: [1, 2, 3, 4],     unit: "%" },
  { type: "crit_chance",            label: "Crit Chance",   tiers: [1, 2, 3, 5],     unit: "%" },
  { type: "crit_damage",            label: "Crit Damage",   tiers: [2, 4, 6, 8],     unit: "%" },
  { type: "xp_bonus_pct",           label: "XP Gain",       tiers: [4, 11, 18, 25],  unit: "%" },
  { type: "max_hp",                 label: "Max HP",        tiers: [20, 40, 60, 80], unit: "" },
  { type: "gold_find_pct",          label: "Gold Find",     tiers: [6, 14, 22, 30],  unit: "%" },
  { type: "magic_find",             label: "Magic Find",    tiers: [2, 4, 7, 10],    unit: "" },
  { type: "stat_bonus_str",         label: "Strength",      tiers: [2, 3, 4, 6],     unit: "" },
  { type: "stat_bonus_dex",         label: "Dexterity",     tiers: [2, 3, 4, 6],     unit: "" },
  { type: "parry_chance",           label: "Parry Chance",  tiers: [2, 4, 6, 8],     unit: "%" },
  { type: "lifesteal_pct",          label: "Lifesteal",     tiers: [1, 2, 3, 5],     unit: "%" },
  { type: "all_elemental_resist",   label: "Elem. Resist",  tiers: [5, 12, 18, 25],  unit: "" },
];

const RUNEMARK_BY_TYPE = new Map(RUNEMARK_POOL.map(m => [m.type, m]));

// Authoritative value for a runemark at a given tier (1-4). Recomputed from the
// pool so rebalancing tier values updates already-forged items. Returns null for
// an unknown type so callers can fall back to a stored value.
export function runemarkValueFor(type, tier) {
  const def = RUNEMARK_BY_TYPE.get(type);
  if (!def) return null;
  const idx = Math.max(1, Math.min(def.tiers.length, tier || 1)) - 1;
  const val = def.tiers[idx];
  return val == null ? null : val;
}
