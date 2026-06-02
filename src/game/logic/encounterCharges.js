// Encounter charges are tracked per (node, difficulty) so each difficulty has its
// own pool — depleting charges at one difficulty doesn't carry into another. The
// storage/transport key is `${baseId}@d${difficultyStars}`; the base id (used to look
// up the charge config) is recovered by stripping the suffix. A null/absent difficulty
// keeps the bare base id (single-encounter regions that aren't difficulty-scoped).
const CHARGE_KEY_SEP = "@d";

export function encounterChargeKey(baseId, difficultyStars = null) {
  if (baseId == null) return baseId;
  return difficultyStars == null ? String(baseId) : `${baseId}${CHARGE_KEY_SEP}${difficultyStars}`;
}

export function encounterChargeBaseId(key = "") {
  const s = String(key);
  const i = s.indexOf(CHARGE_KEY_SEP);
  return i >= 0 ? s.slice(0, i) : s;
}

export function getAvailableCharges(chargeConfig, savedState, nowMs) {
  const { max, rechargeSeconds } = chargeConfig;
  const { current, lastRechargeAt } = savedState ?? { current: max, lastRechargeAt: nowMs };
  return Math.min(max, current + Math.floor((nowMs - lastRechargeAt) / (rechargeSeconds * 1000)));
}

export function consumeCharge(chargeConfig, savedState, nowMs) {
  const { max, rechargeSeconds } = chargeConfig;
  const state = savedState ?? { current: max, lastRechargeAt: nowMs };
  const rechargeMs = rechargeSeconds * 1000;
  const elapsed = nowMs - state.lastRechargeAt;
  const recharges = Math.floor(elapsed / rechargeMs);
  // Advance lastRechargeAt only by completed intervals — preserves the partial window already elapsed
  return {
    current: Math.min(max, state.current + recharges) - 1,
    lastRechargeAt: state.lastRechargeAt + recharges * rechargeMs,
  };
}

export function msUntilNextCharge(chargeConfig, savedState, nowMs) {
  const state = savedState ?? { current: chargeConfig.max, lastRechargeAt: nowMs };
  if (getAvailableCharges(chargeConfig, state, nowMs) >= chargeConfig.max) return 0;
  const rechargeMs = chargeConfig.rechargeSeconds * 1000;
  return rechargeMs - ((nowMs - state.lastRechargeAt) % rechargeMs);
}

export function formatMsCountdown(ms) {
  if (ms <= 0) return "Ready";
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
