const HERO_FALLBACK_SPRITE = "/assets/sprites/Hero_real.png";

const CHARACTER_FRAME_INFERENCE = {
  minRowGap: 1,
  minColGap: 1,
  minBandSpan: 2,
  normalizeToMaxBounds: true,
};

const CHARACTER_VISUALS = {
  fighter: {
    idle: {
      sprite: HERO_FALLBACK_SPRITE,
      scale: 0.96,
    },
    portrait: {
      sprite: HERO_FALLBACK_SPRITE,
      scale: 0.96,
    },
    attacks: [
      {
        sprite: HERO_FALLBACK_SPRITE,
        scale: 0.96,
      },
    ],
    run: {
      sprite: HERO_FALLBACK_SPRITE,
      scale: 0.96,
    },
  },
  monk: {
    idle: {
      scale: 0.7,
      animation: {
        src: "/assets/characters/monk/Monk_Idle.png",
        fps: 6,
        loop: true,
        inference: CHARACTER_FRAME_INFERENCE,
      },
    },
    run: {
      animation: {
        src: "/assets/characters/monk/Run.png",
        fps: 8,
        loop: true,
        inference: CHARACTER_FRAME_INFERENCE,
      },
    },
    attacks: [
      {
        animation: {
          src: "/assets/characters/monk/Heal_Animation.png",
          fps: 10,
          loop: false,
          inference: CHARACTER_FRAME_INFERENCE,
        },
      },
    ],
  },
  archer: {
    idle: {
      sprite: "/assets/sprites/Hero_archer.png",
      scale: 0.96,
    },
    portrait: {
      sprite: "/assets/sprites/Hero_archer.png",
      scale: 0.96,
    },
    attacks: [
      {
        sprite: "/assets/sprites/Hero_archer.png",
        scale: 0.96,
      },
    ],
    run: {
      sprite: "/assets/sprites/Hero_archer.png",
      scale: 0.96,
    },
  },
  lancer: {
    idle: {
      scale: 1.25,
      animation: {
        src: "/assets/characters/lancer/Lancer_Idle.png",
        fps: 6,
        loop: true,
        inference: CHARACTER_FRAME_INFERENCE,
      },
    },
    attacks: [
      {
        scale: 1.25,
        animation: {
          src: "/assets/characters/lancer/Lancer_Right_Attack.png",
          fps: 10,
          loop: false,
          inference: CHARACTER_FRAME_INFERENCE,
        },
      },
    ],
    run: {
      scale: 1.25,
      animation: {
        src: "/assets/characters/lancer/Lancer_Run.png",
        fps: 8,
        loop: true,
        inference: CHARACTER_FRAME_INFERENCE,
      },
    },
  },
};

export function getHeroIdleVisual(heroOrClass) {
  const classId = typeof heroOrClass === "string" ? heroOrClass : heroOrClass?.heroClass;
  return CHARACTER_VISUALS[classId]?.idle || { sprite: HERO_FALLBACK_SPRITE };
}

export function getHeroAttackVisual(heroOrClass, rng = Math.random) {
  const classId = typeof heroOrClass === "string" ? heroOrClass : heroOrClass?.heroClass;
  const attacks = CHARACTER_VISUALS[classId]?.attacks || [];
  if (!attacks.length) return getHeroIdleVisual(classId);
  return attacks[Math.floor(rng() * attacks.length) % attacks.length];
}

export function getHeroRunVisual(heroOrClass) {
  const classId = typeof heroOrClass === "string" ? heroOrClass : heroOrClass?.heroClass;
  return CHARACTER_VISUALS[classId]?.run || getHeroIdleVisual(classId);
}

export function getHeroPortraitVisual(heroOrClass) {
  const classId = typeof heroOrClass === "string" ? heroOrClass : heroOrClass?.heroClass;
  return CHARACTER_VISUALS[classId]?.portrait || getHeroIdleVisual(classId);
}

export function getHeroFallbackSprite() {
  return HERO_FALLBACK_SPRITE;
}
