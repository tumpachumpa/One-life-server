export const ADVENTURE_DIFFICULTY_MIN_STAR = 0;
export const ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR = 1;
export const ADVENTURE_DIFFICULTY_MAX_STAR = 6;
export const ADVENTURE_DIFFICULTY_STEP = 0.1;

export function clampAdventureDifficultyStars(value, fallback = ADVENTURE_DIFFICULTY_MIN_STAR) {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(
    ADVENTURE_DIFFICULTY_MIN_STAR,
    Math.min(ADVENTURE_DIFFICULTY_MAX_STAR, Math.floor(safe)),
  );
}

export function clampUnlockedAdventureDifficultyStars(value) {
  return Math.max(
    ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR,
    clampAdventureDifficultyStars(value, ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR),
  );
}

export function clampSelectedAdventureDifficultyStars(value, unlockedStars = ADVENTURE_DIFFICULTY_START_UNLOCKED_STAR) {
  const unlocked = clampUnlockedAdventureDifficultyStars(unlockedStars);
  return Math.min(unlocked, clampAdventureDifficultyStars(value, ADVENTURE_DIFFICULTY_MIN_STAR));
}

export function getAdventureDifficultyMultiplier(stars = ADVENTURE_DIFFICULTY_MIN_STAR) {
  return 1 + clampAdventureDifficultyStars(stars) * ADVENTURE_DIFFICULTY_STEP;
}

export function getAdventureDifficultyBonusPct(stars = ADVENTURE_DIFFICULTY_MIN_STAR) {
  return Math.round((getAdventureDifficultyMultiplier(stars) - 1) * 100);
}
