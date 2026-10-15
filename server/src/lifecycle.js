'use strict';

/**
 * Server lifecycle hooks: replace the hand-written chaining in start() with explicit
 * registration, order = registration order.
 *   - onWorkspaceSwitch: fires after every project switch (restore / manual switch / demo
 *     switch all go through it)
 *   - onClose: fires before the server closes (for resources other than timers)
 * An error inside a hook must not block the other hooks, hence the one-by-one try/catch.
 */
const log = require('./log');

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
          log.warn('[workgremlin] afterWorkspaceSwitch 钩子失败：', err && err.message);
        }
      }
    },
    beforeClose() {
      for (const fn of closeHooks) {
        try {
          fn();
        } catch (err) {
          log.warn('[workgremlin] beforeClose 钩子失败：', err && err.message);
        }
      }
    },
  };
}

module.exports = { createLifecycle };
