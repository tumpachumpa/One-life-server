'use strict';

// Phase 4: authoritative server-side run HP.
//
// adventure_sessions.run_hp = { hp, at } is the trusted current HP for an
// active run. The server credits passive hunger regen for the wall-clock time
// elapsed since `at`, matching the client's 5s survival-tick regen
// (getPassiveRegenFromHunger). This is intentionally GENEROUS — it ignores the
// client's "bleed/poison blocks regen" rule and never knows about AFK vs active
// time — because passive regen only ever heals UP toward maxHp; it is never a
// reward/anti-cheat exploit, so over-crediting it costs nothing. The cheat
// surface (fake refills, direct hp writes) is closed by carrying run_hp +
// routing item heals through the server, not by being stingy with regen.

const REGEN_INTERVAL_MS = 5000; // client survival tick cadence

// runHp: { hp, at } | null
// maxHp: number (caller computes via calcStats)
// hunger: hero.hunger (drives regen rate)
// now: Date.now()
// getPassiveRegenFromHunger: the ESM survival helper (caller passes it in)
function serverRunHp(runHp, maxHp, hunger, now, getPassiveRegenFromHunger) {
  if (!runHp || !Number.isFinite(runHp.hp)) return null;
  const cap = Math.max(1, Math.floor(Number(maxHp) || runHp.hp));
  const base = Math.max(0, Math.min(cap, Math.floor(runHp.hp)));
  const at = Number(runHp.at) || now;
  const ticks = Math.max(0, Math.floor((now - at) / REGEN_INTERVAL_MS));
  let regen = 0;
  if (ticks > 0 && typeof getPassiveRegenFromHunger === 'function') {
    const perTick = getPassiveRegenFromHunger({ hunger }, cap) || 0;
    regen = ticks * perTick;
  }
  return Math.min(cap, base + regen);
}

module.exports = { serverRunHp, REGEN_INTERVAL_MS };
