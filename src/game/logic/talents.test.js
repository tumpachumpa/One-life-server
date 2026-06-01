import { describe, expect, it } from "vitest";
import { initHero } from "./hero.js";
import { talentTrees } from "./content.js";
import { collectEffects, collectProcNodes } from "./effectEngine.js";
import { canLearnTalent, findTalentPosition, getTalentBranches, learnTalent, normalizeTalentSelections, resetTalentSelections } from "./talents.js";

function getFighterTree() {
  return talentTrees.find(entry => entry.id === "fighter");
}

function getArcherTree() {
  return talentTrees.find(entry => entry.id === "archer");
}

describe("fighter talent tree", () => {
  it("loads the rebuilt fighter branches with combat-ready perks", () => {
    const tree = getFighterTree();
    const branches = getTalentBranches(tree);

    expect(branches.map(branch => branch.id)).toEqual([
      "berserker",
      "speed_demon",
      "warmonger",
    ]);
    expect(tree.classId).toBe("fighter");
    expect(branches.every(branch => branch.pointType === "talent")).toBe(true);
    expect(branches.every(branch => branch.tiers.length === 4)).toBe(true);
    expect(branches.every(branch => branch.tiers.every(tier => (tier.choices || []).length > 0))).toBe(true);

    const berserkerFrenzy = branches
      .find(branch => branch.id === "berserker")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "berserker_frenzy_state");

    expect(berserkerFrenzy.threshold.effects).toContainEqual({ type: "attack_speed_bonus_pct", value: 12 });
  });

  it("does not learn removed or not-yet-created talents", () => {
    const tree = getFighterTree();
    const hero = { ...initHero("Tester"), talentPoints: 4, talents: {} };

    expect(findTalentPosition(tree, "ranged_focus")).toBeNull();
    expect(canLearnTalent(hero, tree, "ranged_focus")).toBe(false);
    expect(learnTalent(hero, tree, "ranged_focus")).toBe(hero);
  });

  it("uses the new fighter active skill replacement talents", () => {
    const branches = getTalentBranches(getFighterTree());
    const choices = branches.flatMap(branch => branch.tiers.flatMap(tier => tier.choices || []));
    const byId = Object.fromEntries(choices.map(choice => [choice.id, choice]));

    expect(byId.berserker_stance.name).toBe("Whirlwind");
    expect(byId.berserker_stance.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "whirlwind" }));
    expect(byId.speed_burnout.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "burnout" }));
    expect(byId.speed_flash.effects).toContainEqual({ type: "momentum_max_cap", value: 12 });
    expect(byId.warmonger_shield_wall.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "shield_wall" }));
    expect(byId.warmonger_retribution.name).toBe("Retribution");
    expect(byId.warmonger_retribution.proc).toMatchObject({ trigger: "on_block", effect: { type: "counter_hit", damageMult: 0.3 } });

    expect(byId.berserker_cornered_beast).toBeUndefined();
    expect(byId.speed_afterimage).toBeUndefined();
    expect(byId.duelist_killing_blow).toBeUndefined();
    expect(byId.warmonger_martyrs_rage).toBeUndefined();
    expect(byId.warmonger_spite_wall).toBeUndefined();
    expect(byId.warmonger_release).toBeUndefined();
    expect(byId.bleeder_crimson_frenzy).toBeUndefined();
  });

  it("spends general talent points for fighter branch talents", () => {
    const tree = getFighterTree();
    const hero = { ...initHero("Tester"), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "warmonger_scar_tissue")).toBe(true);

    const learned = learnTalent(hero, tree, "warmonger_scar_tissue");
    expect(learned.talentPoints).toBe(0);
    expect(learned.talents.warmonger_scar_tissue).toBe(1);
  });

  it("keeps fighter talents locked to fighter characters", () => {
    const tree = getFighterTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "warmonger_scar_tissue")).toBe(false);
    expect(learnTalent(hero, tree, "warmonger_scar_tissue")).toBe(hero);
  });

  it("locks higher fighter tiers until the previous tier has two learned choices", () => {
    const tree = getFighterTree();
    const hero = { ...initHero("Tester"), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "warmonger_pain_is_power")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "warmonger_scar_tissue");
    const beforeSecondTierOne = { ...learnedTierOne, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierOne, tree, "warmonger_pain_is_power")).toBe(false);

    const learnedSecondTierOne = learnTalent(beforeSecondTierOne, tree, "warmonger_fortress_stance");
    const withAnotherPoint = { ...learnedSecondTierOne, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "warmonger_pain_is_power")).toBe(true);
  });

  it("requires Frenzy State before Berserk State can be learned", () => {
    const tree = getFighterTree();
    const withoutFrenzy = {
      ...initHero("Tester"),
      talentPoints: 1,
      talents: {
        berserker_battle_high: 1,
        berserker_blood_price: 1,
        berserker_spite: 1,
        berserker_stance: 1,
      },
    };
    const withFrenzy = {
      ...withoutFrenzy,
      talents: {
        berserker_battle_high: 1,
        berserker_blood_price: 1,
        berserker_frenzy_state: 1,
        berserker_spite: 1,
      },
    };

    expect(canLearnTalent(withoutFrenzy, tree, "berserker_berserk_state")).toBe(false);
    expect(canLearnTalent(withFrenzy, tree, "berserker_berserk_state")).toBe(true);
    expect(learnTalent(withFrenzy, tree, "berserker_berserk_state").talents.berserker_berserk_state).toBe(1);
  });

  it("refunds orphaned Berserk State saves that do not have Frenzy State", () => {
    const tree = getFighterTree();
    const hero = {
      ...initHero("Tester"),
      talentPoints: 0,
      talents: {
        berserker_battle_high: 1,
        berserker_blood_price: 1,
        berserker_spite: 1,
        berserker_stance: 1,
        berserker_berserk_state: 1,
      },
    };

    const normalized = normalizeTalentSelections(hero, tree);

    expect(normalized.talents.berserker_berserk_state).toBeUndefined();
    expect(normalized.talentPoints).toBe(1);
  });

  it("locks fighter branching until the first branch has two points", () => {
    const tree = getFighterTree();
    const hero = { ...initHero("Tester"), talentPoints: 1, talents: {} };

    const learnedWarmonger = learnTalent(hero, tree, "warmonger_scar_tissue");
    const withAnotherPoint = { ...learnedWarmonger, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "berserker_battle_high")).toBe(false);
    expect(canLearnTalent(withAnotherPoint, tree, "warmonger_fortress_stance")).toBe(true);

    const committedWarmonger = learnTalent(withAnotherPoint, tree, "warmonger_fortress_stance");
    const canBranch = { ...committedWarmonger, talentPoints: 1 };
    expect(canLearnTalent(canBranch, tree, "berserker_battle_high")).toBe(true);
  });

  it("limits fighter builds to two active branches", () => {
    const tree = getFighterTree();
    let hero = { ...initHero("Tester"), talentPoints: 10, talents: {} };

    hero = learnTalent(hero, tree, "warmonger_scar_tissue");
    hero = learnTalent(hero, tree, "warmonger_fortress_stance");
    hero = learnTalent(hero, tree, "berserker_battle_high");

    expect(canLearnTalent(hero, tree, "speed_opening_blitz")).toBe(false);
    expect(canLearnTalent(hero, tree, "warmonger_iron_will")).toBe(true);
    expect(canLearnTalent(hero, tree, "berserker_blood_price")).toBe(true);
  });

  it("resets learned fighter talents and refunds spent talent points", () => {
    const tree = getFighterTree();
    const hero = {
      ...initHero("Tester"),
      talentPoints: 1,
      talents: {
        warmonger_scar_tissue: 1,
        berserker_battle_high: 1,
      },
    };

    const reset = resetTalentSelections(hero, tree);

    expect(reset.talentPoints).toBe(3);
    expect(reset.talents).toEqual({});
    expect(reset).not.toHaveProperty("weaponSpecializations");
  });
});

describe("archer talent tree", () => {
  it("loads the Archer branches with combat-ready Beastmaster and ranged perks", () => {
    const tree = getArcherTree();
    const branches = getTalentBranches(tree);
    const beastmaster = branches.find(branch => branch.id === "beastmaster");

    expect(tree.classId).toBe("archer");
    expect(branches.map(branch => branch.id)).toEqual([
      "beastmaster",
      "sharpshooter",
      "ranger",
    ]);
    expect(beastmaster.tiers.find(tier => tier.tier === 1).choices).toHaveLength(3);

    const packLeader = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_pack_leader");
    const rendingBite = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_rending_bite");
    const predatoryLunge = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_predatory_lunge");
    const guardianBond = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_guardian_bond");
    const protectiveInstinct = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_protective_instinct");
    const flanking = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_flanking");
    const howlingStrike = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_howling_strike");
    const undyingWill = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_undying_will");
    const unleash = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_unleash");
    const apexPredator = beastmaster
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "beastmaster_apex_predator");
    const eagleEye = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_eagle_eye");
    const snipersPatience = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_snipers_patience");
    const hairTrigger = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_hair_trigger");
    const optics = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_optics");
    const aimedShot = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_aimed_shot");
    const glassArrow = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_glass_arrow");
    const killzone = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_killzone");
    const coveringFire = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_covering_fire");
    const headshot = branches
      .find(branch => branch.id === "sharpshooter")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "sharpshooter_headshot");
    const venomTips = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_venom_tips");
    const toxicology = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_toxicology");
    const fieldDressing = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_field_dressing");
    const trapper = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_trapper");
    const packBonds = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_pack_bonds");
    const snareSpecialist = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_snare_specialist");
    const emergencyTriage = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_emergency_triage");
    const relentlessPressure = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_relentless_pressure");
    const barbedTrap = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_barbed_trap");
    const wildRenewal = branches
      .find(branch => branch.id === "ranger")
      .tiers.flatMap(tier => tier.choices || [])
      .find(choice => choice.id === "ranger_wild_renewal");

    expect(packLeader.effects.map(effect => effect.type)).toEqual([
      "pet_damage_pct",
      "pet_max_hp_pct",
      "pet_armor",
    ]);
    expect(rendingBite.effects).toContainEqual(expect.objectContaining({
      type: "pet_effect",
      effect: expect.objectContaining({ type: "bleed_on_hit" }),
    }));
    expect(predatoryLunge.effects).toContainEqual(expect.objectContaining({
      type: "pet_unlock_ability",
      ability: expect.objectContaining({
        id: "wolf_lunge",
        type: "stagger_shot",
        castTicks: 1,
        cooldownSeconds: 8,
        damageMult: 1.25,
      }),
    }));
    expect(guardianBond.effects).toContainEqual(expect.objectContaining({ type: "pet_passive_damage_reduction_pct" }));
    expect(protectiveInstinct.effects).toContainEqual(expect.objectContaining({ type: "pet_low_hp_guard" }));
    expect(flanking.effects).toContainEqual(expect.objectContaining({ type: "pet_flanking" }));
    expect(howlingStrike.effects).toContainEqual(expect.objectContaining({
      type: "wolf_lunge_upgrade",
      bleedChance: 100,
      heroCritChanceBonus: 10,
    }));
    expect(undyingWill.effects).toContainEqual(expect.objectContaining({ type: "pet_death_save" }));
    expect(unleash.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "unleash", energyCost: 35 }));
    expect(apexPredator.effects).toContainEqual(expect.objectContaining({
      type: "pet_unlock_ability",
      ability: expect.objectContaining({
        id: "wolf_rend",
        type: "hemorrhaging_shot",
        castTicks: 1,
        cooldownSeconds: 12,
        hemorrhageDuration: 3,
        hemorrhageDamagePct: 1.5,
      }),
    }));
    expect(eagleEye.effects).toContainEqual(expect.objectContaining({ type: "crit_chance" }));
    expect(snipersPatience.effects).toContainEqual(expect.objectContaining({ type: "sniper_patience" }));
    expect(hairTrigger.proc).toMatchObject({
      trigger: "on_crit",
      effect: expect.objectContaining({ type: "extra_arrow" }),
    });
    expect(optics.effects.map(effect => effect.type)).toEqual([
      "first_hit_force_crit",
      "first_hit_crit_damage_bonus_pct",
    ]);
    expect(glassArrow.effects).toContainEqual(expect.objectContaining({ type: "armor_shred_on_hit" }));
    expect(aimedShot.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "aimed_shot", energyCost: 35 }));
    expect(killzone.effects).toContainEqual(expect.objectContaining({ type: "crit_damage_vs_armor_debuff_pct" }));
    expect(coveringFire.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "covering_fire", energyCost: 35 }));
    expect(headshot.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "headshot" }));
    expect(venomTips.effects).toContainEqual(expect.objectContaining({ type: "poison_on_hit" }));
    expect(toxicology.effects.map(effect => effect.type)).toEqual([
      "poison_damage_pct_bonus",
      "poison_duration_bonus_ticks",
    ]);
    expect(fieldDressing.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "mend_companion", energyCost: 25 }));
    expect(trapper.effects).toContainEqual(expect.objectContaining({ type: "unlock_skill", skillId: "bear_trap", energyCost: 25 }));
    expect(packBonds.effects.map(effect => effect.type)).toEqual([
      "mend_companion_self_dodge",
      "pet_hit_next_shot_crit",
    ]);
    expect(snareSpecialist.effects).toContainEqual(expect.objectContaining({ type: "bear_trap_upgrade" }));
    expect(emergencyTriage.effects).toContainEqual(expect.objectContaining({ type: "mend_companion_upgrade" }));
    expect(relentlessPressure.effects).toContainEqual(expect.objectContaining({ type: "relentless_pressure" }));
    expect(barbedTrap.effects).toContainEqual({ type: "unlock_skill", skillId: "barbed_trap" });
    expect(wildRenewal.effects).toContainEqual({ type: "unlock_skill", skillId: "wild_renewal" });
  });

  it("keeps Archer talents locked to Archer characters", () => {
    const tree = getArcherTree();
    const fighter = { ...initHero("Tester", { heroClass: "fighter" }), talentPoints: 1, talents: {} };
    const archer = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(fighter, tree, "beastmaster_rending_bite")).toBe(false);
    expect(canLearnTalent(archer, tree, "beastmaster_rending_bite")).toBe(true);

    const learned = learnTalent(archer, tree, "beastmaster_rending_bite");
    expect(learned.talentPoints).toBe(0);
    expect(learned.talents.beastmaster_rending_bite).toBe(1);
  });

  it("locks Beastmaster Tier 2 until two Tier 1 Beastmaster talents are learned", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "beastmaster_flanking")).toBe(false);
    expect(canLearnTalent(hero, tree, "beastmaster_howling_strike")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "beastmaster_guardian_bond");
    const beforeSecondTierOne = { ...learnedTierOne, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierOne, tree, "beastmaster_flanking")).toBe(false);

    const learnedSecondTierOne = learnTalent(beforeSecondTierOne, tree, "beastmaster_rending_bite");
    const withAnotherPoint = { ...learnedSecondTierOne, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "beastmaster_flanking")).toBe(true);
    expect(canLearnTalent(withAnotherPoint, tree, "beastmaster_howling_strike")).toBe(true);
  });

  it("locks Archer branching until the first specialization has two points", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    const learnedBeastmaster = learnTalent(hero, tree, "beastmaster_rending_bite");
    const withAnotherPoint = { ...learnedBeastmaster, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "sharpshooter_eagle_eye")).toBe(false);
    expect(canLearnTalent(withAnotherPoint, tree, "ranger_venom_tips")).toBe(false);
    expect(canLearnTalent(withAnotherPoint, tree, "beastmaster_guardian_bond")).toBe(true);

    const committedBeastmaster = learnTalent(withAnotherPoint, tree, "beastmaster_guardian_bond");
    const canBranch = { ...committedBeastmaster, talentPoints: 1 };
    expect(canLearnTalent(canBranch, tree, "sharpshooter_eagle_eye")).toBe(true);
    expect(canLearnTalent(canBranch, tree, "ranger_venom_tips")).toBe(true);
  });

  it("locks entry into a third branch when any existing branch is uncommitted", () => {
    const tree = getArcherTree();
    let hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 10, talents: {} };

    hero = learnTalent(hero, tree, "beastmaster_rending_bite");
    hero = learnTalent(hero, tree, "beastmaster_guardian_bond");
    hero = learnTalent(hero, tree, "sharpshooter_eagle_eye");

    // sharpshooter only has 1 point — not committed — so ranger is blocked
    expect(canLearnTalent(hero, tree, "ranger_venom_tips")).toBe(false);
    expect(canLearnTalent(hero, tree, "beastmaster_protective_instinct")).toBe(true);
    expect(canLearnTalent(hero, tree, "sharpshooter_armor_pierce")).toBe(true);
  });

  it("allows a third branch once all existing branches are committed", () => {
    const tree = getArcherTree();
    let hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 10, talents: {} };

    hero = learnTalent(hero, tree, "beastmaster_rending_bite");
    hero = learnTalent(hero, tree, "beastmaster_guardian_bond");
    hero = learnTalent(hero, tree, "sharpshooter_eagle_eye");
    hero = learnTalent(hero, tree, "sharpshooter_armor_pierce");

    // both existing branches committed (2 pts each) → ranger now unlocked
    expect(canLearnTalent(hero, tree, "ranger_venom_tips")).toBe(true);
  });

  it("refunds saved Archer talents that no longer meet branch and tier rules", () => {
    const tree = getArcherTree();
    const hero = {
      ...initHero("Tester", { heroClass: "archer" }),
      talentPoints: 0,
      talents: {
        beastmaster_rending_bite: 1,
        sharpshooter_eagle_eye: 1,
        ranger_field_dressing: 1,
      },
    };

    const normalized = normalizeTalentSelections(hero, tree);

    expect(normalized.talents).toEqual({ beastmaster_rending_bite: 1 });
    expect(normalized.talentPoints).toBe(2);
  });

  it("keeps all three specializations when two existing branches are both committed", () => {
    const tree = getArcherTree();
    const hero = {
      ...initHero("Tester", { heroClass: "archer" }),
      talentPoints: 0,
      talents: {
        beastmaster_rending_bite: 1,
        beastmaster_guardian_bond: 1,
        sharpshooter_eagle_eye: 1,
        sharpshooter_armor_pierce: 1,
        ranger_venom_tips: 1,
      },
    };

    const normalized = normalizeTalentSelections(hero, tree);

    // beastmaster:2 + sharpshooter:2 both committed → ranger entry valid
    expect(normalized.talents).toEqual({
      beastmaster_rending_bite: 1,
      beastmaster_guardian_bond: 1,
      sharpshooter_eagle_eye: 1,
      sharpshooter_armor_pierce: 1,
      ranger_venom_tips: 1,
    });
    expect(normalized.talentPoints).toBe(0);
  });

  it("keeps saved Archer talents that satisfy two-point tier gates", () => {
    const tree = getArcherTree();
    const hero = {
      ...initHero("Tester", { heroClass: "archer" }),
      talentPoints: 0,
      talents: {
        sharpshooter_eagle_eye: 1,
        sharpshooter_armor_pierce: 1,
        sharpshooter_hair_trigger: 1,
        sharpshooter_optics: 1,
        sharpshooter_aimed_shot: 1,
      },
    };

    expect(normalizeTalentSelections(hero, tree)).toBe(hero);
  });

  it("locks Sharpshooter Tier 2 until two Tier 1 Sharpshooter talents are learned", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "sharpshooter_hair_trigger")).toBe(false);
    expect(canLearnTalent(hero, tree, "sharpshooter_optics")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "sharpshooter_eagle_eye");
    const beforeSecondTierOne = { ...learnedTierOne, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierOne, tree, "sharpshooter_hair_trigger")).toBe(false);

    const learnedSecondTierOne = learnTalent(beforeSecondTierOne, tree, "sharpshooter_armor_pierce");
    const withAnotherPoint = { ...learnedSecondTierOne, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "sharpshooter_hair_trigger")).toBe(true);
    expect(canLearnTalent(withAnotherPoint, tree, "sharpshooter_optics")).toBe(true);
  });

  it("locks Sharpshooter Tier 3 until two Tier 2 Sharpshooter talents are learned", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "sharpshooter_aimed_shot")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "sharpshooter_eagle_eye");
    const learnedSecondTierOne = learnTalent({ ...learnedTierOne, talentPoints: 1 }, tree, "sharpshooter_armor_pierce");
    const learnedTierTwo = learnTalent({ ...learnedSecondTierOne, talentPoints: 1 }, tree, "sharpshooter_hair_trigger");
    const beforeSecondTierTwo = { ...learnedTierTwo, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierTwo, tree, "sharpshooter_aimed_shot")).toBe(false);

    const learnedSecondTierTwo = learnTalent(beforeSecondTierTwo, tree, "sharpshooter_optics");
    const withAnotherPoint = { ...learnedSecondTierTwo, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "sharpshooter_aimed_shot")).toBe(true);
  });

  it("locks Ranger Tier 2 until two Tier 1 Ranger talents are learned", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "ranger_field_dressing")).toBe(false);
    expect(canLearnTalent(hero, tree, "ranger_trapper")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "ranger_venom_tips");
    const beforeSecondTierOne = { ...learnedTierOne, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierOne, tree, "ranger_field_dressing")).toBe(false);

    const learnedSecondTierOne = learnTalent(beforeSecondTierOne, tree, "ranger_herbal_remedy");
    const withAnotherPoint = { ...learnedSecondTierOne, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "ranger_field_dressing")).toBe(true);
    expect(canLearnTalent(withAnotherPoint, tree, "ranger_trapper")).toBe(true);
  });

  it("locks Ranger Tier 3 until two Tier 2 Ranger talents are learned", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "ranger_snare_specialist")).toBe(false);
    expect(canLearnTalent(hero, tree, "ranger_emergency_triage")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "ranger_venom_tips");
    const learnedSecondTierOne = learnTalent({ ...learnedTierOne, talentPoints: 1 }, tree, "ranger_herbal_remedy");
    const beforeTierTwo = { ...learnedSecondTierOne, talentPoints: 1 };
    expect(canLearnTalent(beforeTierTwo, tree, "ranger_snare_specialist")).toBe(false);
    expect(canLearnTalent(beforeTierTwo, tree, "ranger_emergency_triage")).toBe(false);

    const learnedTierTwo = learnTalent(beforeTierTwo, tree, "ranger_trapper");
    const beforeSecondTierTwo = { ...learnedTierTwo, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierTwo, tree, "ranger_snare_specialist")).toBe(false);

    const learnedSecondTierTwo = learnTalent(beforeSecondTierTwo, tree, "ranger_field_dressing");
    const withAnotherPoint = { ...learnedSecondTierTwo, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "ranger_snare_specialist")).toBe(true);
    expect(canLearnTalent(withAnotherPoint, tree, "ranger_emergency_triage")).toBe(true);
  });

  it("locks Ranger capstones until a Tier 3 Ranger talent is learned", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "ranger_barbed_trap")).toBe(false);
    expect(canLearnTalent(hero, tree, "ranger_wild_renewal")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "ranger_venom_tips");
    const learnedSecondTierOne = learnTalent({ ...learnedTierOne, talentPoints: 1 }, tree, "ranger_herbal_remedy");
    const learnedTierTwo = learnTalent({ ...learnedSecondTierOne, talentPoints: 1 }, tree, "ranger_trapper");
    const learnedSecondTierTwo = learnTalent({ ...learnedTierTwo, talentPoints: 1 }, tree, "ranger_field_dressing");
    const beforeTierThree = { ...learnedSecondTierTwo, talentPoints: 1 };
    expect(canLearnTalent(beforeTierThree, tree, "ranger_barbed_trap")).toBe(false);

    const learnedTierThree = learnTalent(beforeTierThree, tree, "ranger_snare_specialist");
    const beforeSecondTierThree = { ...learnedTierThree, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierThree, tree, "ranger_barbed_trap")).toBe(false);

    const learnedSecondTierThree = learnTalent(beforeSecondTierThree, tree, "ranger_emergency_triage");
    const withAnotherPoint = { ...learnedSecondTierThree, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "ranger_barbed_trap")).toBe(true);
    expect(canLearnTalent(withAnotherPoint, tree, "ranger_wild_renewal")).toBe(true);
  });

  it("locks Beastmaster Tier 3 until two Tier 2 Beastmaster talents are learned", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "beastmaster_undying_will")).toBe(false);
    expect(canLearnTalent(hero, tree, "beastmaster_unleash")).toBe(false);
    expect(canLearnTalent(hero, tree, "beastmaster_pack_leader")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "beastmaster_rending_bite");
    const learnedSecondTierOne = learnTalent({ ...learnedTierOne, talentPoints: 1 }, tree, "beastmaster_guardian_bond");
    const beforeTierTwo = { ...learnedSecondTierOne, talentPoints: 1 };
    expect(canLearnTalent(beforeTierTwo, tree, "beastmaster_undying_will")).toBe(false);
    expect(canLearnTalent(beforeTierTwo, tree, "beastmaster_pack_leader")).toBe(false);

    const learnedTierTwo = learnTalent(beforeTierTwo, tree, "beastmaster_flanking");
    const beforeSecondTierTwo = { ...learnedTierTwo, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierTwo, tree, "beastmaster_undying_will")).toBe(false);

    const learnedSecondTierTwo = learnTalent(beforeSecondTierTwo, tree, "beastmaster_howling_strike");
    const withAnotherPoint = { ...learnedSecondTierTwo, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "beastmaster_undying_will")).toBe(true);
    expect(canLearnTalent(withAnotherPoint, tree, "beastmaster_unleash")).toBe(true);
    expect(canLearnTalent(withAnotherPoint, tree, "beastmaster_pack_leader")).toBe(true);
  });

  it("locks Beastmaster capstones until two Tier 3 Beastmaster talents are learned", () => {
    const tree = getArcherTree();
    const hero = { ...initHero("Tester", { heroClass: "archer" }), talentPoints: 1, talents: {} };

    expect(canLearnTalent(hero, tree, "beastmaster_apex_predator")).toBe(false);

    const learnedTierOne = learnTalent(hero, tree, "beastmaster_rending_bite");
    const learnedSecondTierOne = learnTalent({ ...learnedTierOne, talentPoints: 1 }, tree, "beastmaster_guardian_bond");
    const learnedTierTwo = learnTalent({ ...learnedSecondTierOne, talentPoints: 1 }, tree, "beastmaster_flanking");
    const learnedSecondTierTwo = learnTalent({ ...learnedTierTwo, talentPoints: 1 }, tree, "beastmaster_howling_strike");
    const beforeTierThree = { ...learnedSecondTierTwo, talentPoints: 1 };
    expect(canLearnTalent(beforeTierThree, tree, "beastmaster_apex_predator")).toBe(false);

    const learnedTierThree = learnTalent(beforeTierThree, tree, "beastmaster_pack_leader");
    const beforeSecondTierThree = { ...learnedTierThree, talentPoints: 1 };
    expect(canLearnTalent(beforeSecondTierThree, tree, "beastmaster_apex_predator")).toBe(false);

    const learnedSecondTierThree = learnTalent(beforeSecondTierThree, tree, "beastmaster_undying_will");
    const withAnotherPoint = { ...learnedSecondTierThree, talentPoints: 1 };
    expect(canLearnTalent(withAnotherPoint, tree, "beastmaster_apex_predator")).toBe(true);
  });

  it("requires a ranged weapon for Sharpshooter and Ranger talent effects", () => {
    const bowArcher = {
      ...initHero("Tester", { heroClass: "archer", weapon: "bow" }),
      talents: { sharpshooter_eagle_eye: 1, sharpshooter_snipers_patience: 1, sharpshooter_hair_trigger: 1, sharpshooter_optics: 1, sharpshooter_glass_arrow: 1, sharpshooter_killzone: 1, sharpshooter_covering_fire: 1, sharpshooter_headshot: 1, ranger_venom_tips: 1, ranger_toxicology: 1, ranger_field_dressing: 1, ranger_trapper: 1, ranger_pack_bonds: 1, ranger_snare_specialist: 1, ranger_emergency_triage: 1, ranger_relentless_pressure: 1, ranger_barbed_trap: 1, ranger_wild_renewal: 1 },
    };
    const swordArcher = {
      ...initHero("Tester", { heroClass: "archer", weapon: "sword" }),
      talents: { sharpshooter_eagle_eye: 1, sharpshooter_snipers_patience: 1, sharpshooter_hair_trigger: 1, sharpshooter_optics: 1, sharpshooter_glass_arrow: 1, sharpshooter_killzone: 1, sharpshooter_covering_fire: 1, sharpshooter_headshot: 1, ranger_venom_tips: 1, ranger_toxicology: 1, ranger_field_dressing: 1, ranger_trapper: 1, ranger_pack_bonds: 1, ranger_snare_specialist: 1, ranger_emergency_triage: 1, ranger_relentless_pressure: 1, ranger_barbed_trap: 1, ranger_wild_renewal: 1 },
    };

    expect(collectEffects(bowArcher)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "crit_chance", source: "sharpshooter_eagle_eye" }),
      expect.objectContaining({ type: "sniper_patience", source: "sharpshooter_snipers_patience" }),
      expect.objectContaining({ type: "first_hit_force_crit", source: "sharpshooter_optics" }),
      expect.objectContaining({ type: "armor_shred_on_hit", source: "sharpshooter_glass_arrow" }),
      expect.objectContaining({ type: "crit_damage_vs_armor_debuff_pct", source: "sharpshooter_killzone" }),
      expect.objectContaining({ type: "unlock_skill", skillId: "covering_fire", source: "sharpshooter_covering_fire" }),
      expect.objectContaining({ type: "unlock_skill", skillId: "headshot", source: "sharpshooter_headshot" }),
      expect.objectContaining({ type: "poison_on_hit", chance: 20, source: "ranger_venom_tips" }),
      expect.objectContaining({ type: "poison_damage_pct_bonus", source: "ranger_toxicology" }),
      expect.objectContaining({ type: "unlock_skill", skillId: "mend_companion", source: "ranger_field_dressing" }),
      expect.objectContaining({ type: "unlock_skill", skillId: "bear_trap", source: "ranger_trapper" }),
      expect.objectContaining({ type: "mend_companion_self_dodge", source: "ranger_pack_bonds" }),
      expect.objectContaining({ type: "bear_trap_upgrade", staggerAttacks: 2, source: "ranger_snare_specialist" }),
      expect.objectContaining({ type: "mend_companion_upgrade", instantHealPct: 10, source: "ranger_emergency_triage" }),
      expect.objectContaining({ type: "relentless_pressure", source: "ranger_relentless_pressure" }),
      expect.objectContaining({ type: "unlock_skill", skillId: "barbed_trap", source: "ranger_barbed_trap" }),
      expect.objectContaining({ type: "unlock_skill", skillId: "wild_renewal", source: "ranger_wild_renewal" }),
    ]));
    expect(collectProcNodes(bowArcher)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "sharpshooter_hair_trigger" }),
    ]));
    expect(collectEffects(swordArcher).some(effect => effect.source === "sharpshooter_eagle_eye")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "sharpshooter_snipers_patience")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "sharpshooter_optics")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "sharpshooter_glass_arrow")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "sharpshooter_killzone")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "sharpshooter_covering_fire")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "sharpshooter_headshot")).toBe(false);
    expect(collectProcNodes(swordArcher).some(node => node.id === "sharpshooter_hair_trigger")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_venom_tips")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_toxicology")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_field_dressing")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_trapper")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_pack_bonds")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_snare_specialist")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_emergency_triage")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_relentless_pressure")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_barbed_trap")).toBe(false);
    expect(collectEffects(swordArcher).some(effect => effect.source === "ranger_wild_renewal")).toBe(false);
  });
});
