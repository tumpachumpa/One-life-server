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
