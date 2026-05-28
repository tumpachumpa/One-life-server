export const MAX_BLEEDING_STACKS = 6;
export const BLEEDING_DAMAGE_PCT = 2;
export const MAX_DEEP_CUTS = 3;
export const DEEP_CUT_TREATMENT_TICKS = 2;
export const DEEP_CUT_MAX_HP_PENALTY_PCT = 2;
export const DEEP_CUT_TO_INFECTION_TICKS = 3;
export const INFECTION_DAMAGE_PCT = 1;
export const INFECTION_TREATMENT_TICKS = 2;
export const INFECTION_TO_GORE_TICKS = 4;
export const INFECTION_HIT_CHANCE_PENALTY = 4;
export const INFECTION_ATTACK_SPEED_MULT = 0.92;
export const GORE_MAX_HP_PENALTY_PCT = 1;
export const PASSIVE_REGEN_SOFT_CAP_PCT = 100;
export const MAX_FATIGUE = 100;
const ENABLE_TIER3_WOUNDS = true;
const ENABLE_INCURABLE_WOUNDS = false;

const DOT_CONDITIONS = {
  bleeding: { label: "Bleeding" },
  poison: { label: "Poison" },
};

export const FATIGUE_LEVELS = [
  { id: "exhausted", name: "Exhausted", threshold: 0, attackSpeedMult: 0.65, hitChance: -18, canFight: false },
  { id: "spent", name: "Spent", threshold: 25, attackSpeedMult: 0.8, hitChance: -10, canFight: true },
  { id: "tired", name: "Tired", threshold: 50, attackSpeedMult: 0.9, hitChance: 0, canFight: true },
  { id: "fresh", name: "Fresh", threshold: 75, attackSpeedMult: 1, hitChance: 0, canFight: true },
];

export function normalizeConditions(conditions = {}) {
  const normalizeDot = (condition, key) => {
    if ((condition?.stacks || 0) <= 0) return null;
    return {
      type: key,
      stacks: Math.max(0, Math.min(MAX_BLEEDING_STACKS, condition.stacks || 0)),
      damagePct: condition.damagePct || BLEEDING_DAMAGE_PCT,
    };
  };
  const normalizeDeepCut = (condition) => {
    if ((condition?.stacks || 0) <= 0) return null;
    return {
      type: "deep_cut",
      stacks: Math.max(0, Math.min(MAX_DEEP_CUTS, condition.stacks || 0)),
      treatmentTicks: Math.max(0, condition.treatmentTicks || 0),
      untreatedTicks: Math.max(0, condition.untreatedTicks || 0),
    };
  };
  const normalizeInfection = (condition) => {
    if ((condition?.stacks || 0) <= 0) return null;
    return {
      type: "infection",
      stacks: Math.max(0, condition.stacks || 0),
      treatmentTicks: Math.max(0, condition.treatmentTicks || 0),
      untreatedTicks: Math.max(0, condition.untreatedTicks || 0),
    };
  };
  const normalizeGore = (condition) => {
    if ((condition?.stacks || 0) <= 0) return null;
    return {
      type: "wretched_gore",
      stacks: Math.max(0, condition.stacks || 0),
    };
  };
  return {
    ...conditions,
    bleeding: normalizeDot(conditions.bleeding, "bleeding"),
    poison: normalizeDot(conditions.poison, "poison"),
    deepCut: normalizeDeepCut(conditions.deepCut),
    infection: normalizeInfection(conditions.infection),
    wretchedGore: normalizeGore(conditions.wretchedGore),
  };
}

export function getFatigueLevel(value = 100) {
  for (let i = FATIGUE_LEVELS.length - 1; i >= 0; i--) {
    if (value >= FATIGUE_LEVELS[i].threshold) return FATIGUE_LEVELS[i];
  }
  return FATIGUE_LEVELS[0];
}

export function getSurvivalStatModifiers(hero) {
  const hunger = Math.max(0, hero?.hunger ?? 100);
  const fatigue = getFatigueLevel(hero?.energy ?? 100);
  const lowHunger = hunger < 25;
  const mediumHunger = hunger < 50;
  const wellFed = hunger >= 75;
  const fresh = fatigue.id === "fresh";
  return {
    str: lowHunger ? -3 : mediumHunger ? -1 : 0,
    hitChance: fatigue.hitChance,
    attackSpeedMult: fatigue.attackSpeedMult * (lowHunger ? 0.8 : 1),
    damageMult: fresh ? 1.05 : 1,
    maxHpMult: wellFed ? 1.05 : 1,
    canFight: fatigue.canFight && hunger > 0,
  };
}

const FOOD_BUFF_STAT_LABELS = {
  str: "STR",
  dex: "DEX",
  int: "INT",
  maxHp: "max HP",
  armor: "armor",
  lifesteal: "lifesteal",
  attackSpeedPct: "atk speed",
};

function formatFoodBuffStats(stats = {}) {
  const entries = Object.entries(stats).filter(([, value]) => Number(value) !== 0);
  return entries.length
    ? entries.map(([stat, value]) => {
        const label = FOOD_BUFF_STAT_LABELS[stat] || stat;
        const suffix = stat === "attackSpeedPct" ? "%" : "";
        return `+${value}${suffix} ${label}`;
      }).join(" / ")
    : "no stats";
}

function getActiveFoodBuffLines(hero) {
  const now = Date.now();
  return (hero?.activeBuffs || [])
    .filter(buff => buff.expiresAt && buff.expiresAt > now)
    .map(buff => {
      const secsLeft = Math.max(0, Math.ceil((buff.expiresAt - now) / 1000));
      const timeStr = secsLeft < 60 ? `${secsLeft}s` : `${Math.ceil(secsLeft / 60)}m`;
      return `${buff.name || "Food"}: ${formatFoodBuffStats(buff.stats)} (${timeStr} left)`;
    });
}

export function getHungerSummary(hero) {
  const hunger = Math.max(0, hero?.hunger ?? 100);
  const foodBuffs = getActiveFoodBuffLines(hero);
  if (hunger <= 0) {
    return {
      state: "Starving",
      severity: "danger",
      effects: ["Cannot continue safely", "-3 STR", "Slower attacks", ...foodBuffs],
    };
  }
  if (hunger < 25) {
    return {
      state: "Low hunger",
      severity: "danger",
      effects: ["-3 STR", "Slower attacks", ...foodBuffs],
    };
  }
  if (hunger < 50) {
    return {
      state: "Hungry",
      severity: "warning",
      effects: ["-1 STR", ...foodBuffs],
    };
  }
  return {
    state: "Well Fed",
    severity: "ok",
    effects: ["No penalties", "+5% max HP", "Restores HP and fatigue over time outside combat", ...foodBuffs],
  };
}

export function getPassiveRegenFromHunger(hero, maxHp) {
  const hunger = Math.max(0, hero?.hunger ?? 100);
  if (hunger < 50) return 0;
  const pct = hunger >= 75 ? 4 : 2;
  return Math.max(1, Math.round(maxHp * pct / 100));
}

export function getPassiveFatigueRegenFromHunger(hero) {
  return getPassiveRegenFromHunger(hero, MAX_FATIGUE);
}

export function getFatigueSummary(hero) {
  const fatigue = getFatigueLevel(hero?.energy ?? 100);
  const effects = [];
  if (fatigue.attackSpeedMult < 1) effects.push(`Attack speed x${fatigue.attackSpeedMult}`);
  if (fatigue.hitChance) effects.push(`${fatigue.hitChance} hit chance`);
  if (fatigue.id === "fresh") effects.push("+5% damage");
  if (!fatigue.canFight) effects.push("Cannot fight");
  return {
    state: fatigue.name,
    severity: !fatigue.canFight ? "danger" : fatigue.attackSpeedMult < 0.9 ? "warning" : "ok",
    effects: effects.length ? effects : ["No penalties"],
  };
}

export function getConditionSummary(hero) {
  const conditions = normalizeConditions(hero?.conditions);
  const entries = [];
  for (const [key, meta] of Object.entries(DOT_CONDITIONS)) {
    const condition = conditions[key];
    if (!condition?.stacks) continue;
    entries.push({
      id: key,
      name: meta.label,
      severity: "danger",
      effects: [
        `${condition.stacks} stack${condition.stacks === 1 ? "" : "s"}`,
        "Blocks natural HP recovery while active",
        "Intensity reduces by 1 each tick",
      ],
    });
  }
  if (conditions.deepCut?.stacks) {
    entries.push({
      id: "deepCut",
      name: "Deep Cut",
      severity: conditions.bleeding?.stacks ? "danger" : "warning",
      effects: [
        `${conditions.deepCut.stacks} wound${conditions.deepCut.stacks === 1 ? "" : "s"}`,
        `-${conditions.deepCut.stacks * DEEP_CUT_MAX_HP_PENALTY_PCT}% max HP until healed`,
        conditions.bleeding?.stacks
          ? "Needs a bandage before any wrap can be applied"
          : conditions.deepCut.treatmentTicks > 0
            ? `Treatment working (${conditions.deepCut.treatmentTicks} tick${conditions.deepCut.treatmentTicks === 1 ? "" : "s"} left)`
            : "Stable wound: use a bandage to close it or a wrap to treat it",
      ],
    });
  }
  if (conditions.infection?.stacks) {
    entries.push({
      id: "infection",
      name: "Infection",
      severity: "danger",
      effects: [
        `${conditions.infection.stacks} stack${conditions.infection.stacks === 1 ? "" : "s"}`,
        "Blocks natural HP recovery while active",
        `-${conditions.infection.stacks * INFECTION_HIT_CHANCE_PENALTY} hit chance`,
        conditions.infection.treatmentTicks > 0
          ? `Vinegar wash working (${conditions.infection.treatmentTicks} tick${conditions.infection.treatmentTicks === 1 ? "" : "s"} left)`
          : "Stable infection: negative effect only until treated",
      ],
    });
  }
  if (ENABLE_TIER3_WOUNDS && conditions.wretchedGore?.stacks) {
    entries.push({
      id: "wretchedGore",
      name: "Wretched Gore",
      severity: "danger",
      effects: [
        `${conditions.wretchedGore.stacks} critical wound${conditions.wretchedGore.stacks === 1 ? "" : "s"}`,
        `-${conditions.wretchedGore.stacks * GORE_MAX_HP_PENALTY_PCT}% max HP`,
        "Needs a stitched case to close safely",
      ],
    });
  }
  return entries;
}

export function addDeepCutCondition(hero, stacks = 1) {
  const conditions = normalizeConditions(hero.conditions);
  let deepCutStacks = conditions.deepCut?.stacks || 0;
  for (let i = 0; i < Math.max(1, stacks); i++) {
    deepCutStacks = Math.min(MAX_DEEP_CUTS, deepCutStacks + 1);
  }
  return {
    ...hero,
    conditions: {
      ...conditions,
      deepCut: deepCutStacks > 0 ? {
        type: "deep_cut",
        stacks: deepCutStacks,
        treatmentTicks: conditions.deepCut?.treatmentTicks || 0,
        untreatedTicks: conditions.deepCut?.untreatedTicks || 0,
      } : null,
      wretchedGore: ENABLE_TIER3_WOUNDS ? (conditions.wretchedGore || null) : null,
    },
  };
}

export function addInfectionCondition(hero, stacks = 1) {
  const conditions = normalizeConditions(hero.conditions);
  const current = conditions.infection?.stacks || 0;
  return {
    ...hero,
    conditions: {
      ...conditions,
      infection: {
        type: "infection",
        stacks: current + Math.max(1, stacks),
        treatmentTicks: conditions.infection?.treatmentTicks || 0,
        untreatedTicks: conditions.infection?.untreatedTicks || 0,
      },
    },
  };
}

export function addBleedingCondition(hero, stacks = 1, damagePct = BLEEDING_DAMAGE_PCT) {
  const conditions = normalizeConditions(hero.conditions);
  const current = conditions.bleeding?.stacks || 0;
  return {
    ...hero,
    conditions: {
      ...conditions,
      bleeding: {
        type: "bleeding",
        stacks: Math.min(MAX_BLEEDING_STACKS, current + Math.max(1, stacks)),
        damagePct,
      },
    },
  };
}

export function addPoisonCondition(hero, stacks = 1, damagePct = BLEEDING_DAMAGE_PCT) {
  const conditions = normalizeConditions(hero.conditions);
  const current = conditions.poison?.stacks || 0;
  return {
    ...hero,
    conditions: {
      ...conditions,
      poison: {
        type: "poison",
        stacks: Math.min(MAX_BLEEDING_STACKS, current + Math.max(1, stacks)),
        damagePct,
      },
    },
  };
}

export function applyCombatBleeding(hero, combatConditions = {}) {
  let next = hero;
  const bleeding = combatConditions.bleeding;
  const poison = combatConditions.poison;
  if (bleeding?.stacks) next = addBleedingCondition(next, bleeding.stacks, bleeding.damagePct || BLEEDING_DAMAGE_PCT);
  if (poison?.stacks) next = addPoisonCondition(next, poison.stacks, poison.damagePct || BLEEDING_DAMAGE_PCT);
  return next;
}

export function tickBleeding(hero, maxHp, label = "Bleeding") {
  const conditions = normalizeConditions(hero.conditions);
  const nextConditions = { ...conditions };
  const notes = [];
  let nextHp = hero.hp || 0;
  let nextEnergy = Math.min(MAX_FATIGUE, Math.max(0, hero.energy ?? MAX_FATIGUE));
  let changed = false;

  for (const [key, meta] of Object.entries(DOT_CONDITIONS)) {
    const condition = conditions[key];
    if (!condition?.stacks) continue;
    const nextStacks = Math.max(0, condition.stacks - 1);
    nextConditions[key] = nextStacks > 0 ? { ...condition, stacks: nextStacks } : null;
    notes.push(`${meta.label} fades (${nextStacks} stack${nextStacks === 1 ? "" : "s"} left).`);
    changed = true;
  }

  if (nextConditions.deepCut?.stacks) {
    if (!nextConditions.bleeding?.stacks && (nextConditions.deepCut.treatmentTicks || 0) > 0) {
      const remaining = Math.max(0, nextConditions.deepCut.treatmentTicks - 1);
      if (remaining === 0) {
        const healedStacks = Math.max(0, nextConditions.deepCut.stacks - 1);
        nextConditions.deepCut = healedStacks > 0 ? {
          type: "deep_cut",
          stacks: healedStacks,
          treatmentTicks: 0,
          untreatedTicks: 0,
        } : null;
        notes.push("One Deep Cut closes under treatment.");
      } else {
        nextConditions.deepCut = { ...nextConditions.deepCut, treatmentTicks: remaining };
        notes.push(`Deep Cut treatment progresses (${remaining} tick${remaining === 1 ? "" : "s"} left).`);
      }
      changed = true;
    }
  }

  if (nextConditions.infection?.stacks) {
    if ((nextConditions.infection.treatmentTicks || 0) > 0) {
      changed = true;
      const remaining = Math.max(0, nextConditions.infection.treatmentTicks - 1);
      if (remaining === 0) {
        const healedStacks = Math.max(0, nextConditions.infection.stacks - 1);
        nextConditions.infection = healedStacks > 0 ? {
          type: "infection",
          stacks: healedStacks,
          treatmentTicks: 0,
          untreatedTicks: 0,
        } : null;
        notes.push("The infection starts to clear.");
      } else {
        nextConditions.infection = { ...nextConditions.infection, treatmentTicks: remaining };
        notes.push(`Vinegar wash bites through the infection (${remaining} tick${remaining === 1 ? "" : "s"} left).`);
      }
    }
  }

  if (ENABLE_TIER3_WOUNDS && nextConditions.wretchedGore?.stacks) {
    if (ENABLE_INCURABLE_WOUNDS) {
      notes.push("Wretched Gore remains unstable.");
      changed = true;
    }
  }

  const passiveRegenCap = maxHp;
  const regenBlocked = !!(nextConditions.bleeding?.stacks || nextConditions.poison?.stacks || nextConditions.infection?.stacks);
  const regenAmount = regenBlocked ? 0 : getPassiveRegenFromHunger(hero, maxHp);
  if (regenAmount > 0 && nextHp < passiveRegenCap) {
    const healed = Math.min(regenAmount, passiveRegenCap - nextHp);
    if (healed > 0) {
      nextHp = Math.min(passiveRegenCap, nextHp + healed);
      notes.push(`Well-fed recovery: +${healed} HP.`);
      changed = true;
    }
  }
  const fatigueRegenAmount = getPassiveFatigueRegenFromHunger(hero);
  if (fatigueRegenAmount > 0 && nextEnergy < MAX_FATIGUE) {
    const recovered = Math.min(fatigueRegenAmount, MAX_FATIGUE - nextEnergy);
    if (recovered > 0) {
      nextEnergy = Math.min(MAX_FATIGUE, nextEnergy + recovered);
      notes.push(`Well-fed fatigue recovery: +${recovered}.`);
      changed = true;
    }
  }

  if (!changed) return { hero: { ...hero, conditions }, notes: [] };
  return {
    hero: {
      ...hero,
      hp: nextHp,
      energy: nextEnergy,
      conditions: nextConditions,
    },
    notes: label ? notes.map(note => note.replace(/^Bleeding/, label)) : notes,
  };
}

export function treatBleeding(hero) {
  const conditions = normalizeConditions(hero.conditions);
  if (!conditions.bleeding?.stacks) return hero;
  return {
    ...hero,
    conditions: { ...conditions, bleeding: null },
  };
}

export function applyPoultice(hero) {
  const conditions = normalizeConditions(hero.conditions);
  if (conditions.bleeding?.stacks || !conditions.deepCut?.stacks) return hero;
  return {
    ...hero,
    conditions: {
      ...conditions,
      deepCut: {
        ...conditions.deepCut,
        treatmentTicks: Math.max(conditions.deepCut.treatmentTicks || 0, DEEP_CUT_TREATMENT_TICKS),
        untreatedTicks: 0,
      },
    },
  };
}

export function treatDeepCut(hero) {
  const conditions = normalizeConditions(hero.conditions);
  if (conditions.bleeding?.stacks || !conditions.deepCut?.stacks) return hero;
  const healedStacks = Math.max(0, conditions.deepCut.stacks - 1);
  return {
    ...hero,
    conditions: {
      ...conditions,
      deepCut: healedStacks > 0 ? {
        type: "deep_cut",
        stacks: healedStacks,
        treatmentTicks: 0,
        untreatedTicks: 0,
      } : null,
    },
  };
}

export function applyVinegarWash(hero) {
  const conditions = normalizeConditions(hero.conditions);
  if (conditions.bleeding?.stacks || !conditions.infection?.stacks) return hero;
  return {
    ...hero,
    conditions: {
      ...conditions,
      infection: {
        ...conditions.infection,
        treatmentTicks: Math.max(conditions.infection.treatmentTicks || 0, INFECTION_TREATMENT_TICKS),
        untreatedTicks: 0,
      },
    },
  };
}

export function applyHoneySalve(hero) {
  const conditions = normalizeConditions(hero.conditions);
  if (conditions.bleeding?.stacks) return hero;
  const nextConditions = { ...conditions };
  let changed = false;
  if (nextConditions.deepCut?.stacks) {
    nextConditions.deepCut = {
      ...nextConditions.deepCut,
      treatmentTicks: Math.max(1, (nextConditions.deepCut.treatmentTicks || 0) - 1),
      untreatedTicks: 0,
    };
    changed = true;
  }
  if (nextConditions.infection?.stacks) {
    nextConditions.infection = {
      ...nextConditions.infection,
      treatmentTicks: Math.max(1, (nextConditions.infection.treatmentTicks || 0) - 1),
      untreatedTicks: 0,
    };
    changed = true;
  }
  return changed ? { ...hero, conditions: nextConditions } : hero;
}

export function treatWretchedGore(hero) {
  const conditions = normalizeConditions(hero.conditions);
  if (!ENABLE_TIER3_WOUNDS || conditions.bleeding?.stacks || !conditions.wretchedGore?.stacks) return hero;
  const healedStacks = Math.max(0, conditions.wretchedGore.stacks - 1);
  return {
    ...hero,
    conditions: {
      ...conditions,
      wretchedGore: healedStacks > 0 ? { type: "wretched_gore", stacks: healedStacks } : null,
    },
  };
}
