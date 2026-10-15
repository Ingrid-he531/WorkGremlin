'use strict';

/**
 * Clock abstraction (aligned with the Clock contract in test strategy v0.3):
 *   - Timeout/interval checks all go through Clock.now(); tests can inject a FakeClock
 *     to make deterministic assertions;
 *   - Business code must not use Date.now() directly — always now().
 *
 * M0 ships only the system clock implementation; the FakeClock is injected from the
 * test side (createTestApp).
 */

const systemClock = {
  /** @returns {number} millisecond timestamp */
  now() {
    return Date.now();
  },
  /** @returns {number} monotonic clock (ms), for timeout / elapsed-time checks */
  monotonic() {
    return Number(process.hrtime.bigint() / 1000n) / 1000;
  },
};

let current = systemClock;

module.exports = {
  now: () => current.now(),
  monotonic: () => current.monotonic(),
  __setClock(c) {
    current = c || systemClock;
  },
  __resetClock() {
    current = systemClock;
  },
  systemClock,
};
