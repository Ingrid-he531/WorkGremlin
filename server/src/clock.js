'use strict';

/**
 * 时钟抽象（对齐测试策略 v0.3 的 Clock 契约）：
 *   - 超时/间隔判定统一走 Clock.now()，测试可注入 FakeClock 做确定性断言；
 *   - 业务代码禁止裸用 Date.now()，统一 now()。
 *
 * M0 只有系统时钟实现；FakeClock 由测试侧注入（createTestApp）。
 */

const systemClock = {
  /** @returns {number} 毫秒时间戳 */
  now() {
    return Date.now();
  },
  /** @returns {number} 单调时钟（ms），用于超时/耗时判定 */
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
