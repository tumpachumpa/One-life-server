'use strict';

const ONLINE_TIMEOUT_MS = 3 * 60 * 1000;
const lastSeen = new Map();

module.exports = {
  touch(userId) {
    lastSeen.set(String(userId), Date.now());
  },
  isOnline(userId) {
    const t = lastSeen.get(String(userId));
    return t != null && Date.now() - t < ONLINE_TIMEOUT_MS;
  },
};
