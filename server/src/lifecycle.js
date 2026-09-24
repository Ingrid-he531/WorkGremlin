'use strict';

/**
 * 服务生命周期钩子：把 start() 里手写的串联改成显式注册，顺序即注册顺序。
 *   - onWorkspaceSwitch：每次切换工程后触发（恢复 / 手动切 / 演示切换都走它）
 *   - onClose：服务关闭前触发（停定时器之外的资源）
 * 钩子内部出错不应阻断其他钩子，因此逐个 try/catch。
 */
function createLifecycle() {
  const switchHooks = [];
  const closeHooks = [];

  return {
    onWorkspaceSwitch(fn) {
      switchHooks.push(fn);
    },
    onClose(fn) {
      closeHooks.push(fn);
    },
    afterWorkspaceSwitch() {
      for (const fn of switchHooks) {
        try {
          fn();
        } catch (err) {
          console.warn('[workgremlin] afterWorkspaceSwitch 钩子失败：', err && err.message);
        }
      }
    },
    beforeClose() {
      for (const fn of closeHooks) {
        try {
          fn();
        } catch (err) {
          console.warn('[workgremlin] beforeClose 钩子失败：', err && err.message);
        }
      }
    },
  };
}

module.exports = { createLifecycle };
