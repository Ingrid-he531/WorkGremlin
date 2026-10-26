'use strict';

/**
 * Remote dispatch recipes — how to ask one floor to do one task **as if the user typed it in the CLI**.
 *
 * This is deliberately not the council's recipe set:
 *   · the council is read-only and hides its sessions (`WORKGREMLIN_DISABLE`, `--no-session-persistence`,
 *     `--ephemeral`, `--standalone` + the council title marker);
 *   · dispatch wants the opposite: a **normal, persistent session** in the target directory, so the
 *     existing hooks/poller attribute it to the project exactly like a manual run. The office and the
 *     task ledger are therefore written by the product itself; this module writes no rows.
 *
 * Only 8F OpenCode is wired up so far. `--auto` approves tool permissions the user has not explicitly
 * denied, which is what makes a headless run actually able to work (there is no TTY to answer prompts).
 * Do **not** add `--standalone`: that is the council's way of keeping the session out of the office.
 */

const { detectProducts } = require('../floors');

const RECIPES = Object.freeze({
  '8F': {
    floor: '8F',
    client: 'opencode',
    build({ prompt, model, sessionId }) {
      const args = ['run', prompt, '--auto'];
      // Continue the same OpenCode session for every turn: the office/ledger then sees one long
      // conversation instead of one session per prompt.
      if (sessionId) args.push('--session', sessionId);
      if (model) args.push('-m', model);
      return { args, stdin: null };
    },
  },
});

/**
 * @param {string} floor
 * @returns {{floor: string, client: string, build: Function}|null}
 */
function recipeOf(floor) {
  return RECIPES[String(floor || '')] || null;
}

/**
 * Executable for a floor, from the same product detection the floor readers use.
 * @param {string} floor
 * @returns {string|null}
 */
function binOf(floor) {
  try {
    const product = detectProducts().find((p) => p.id === floor);
    return (product && product.cliInstallPath) || null;
  } catch {
    return null;
  }
}

module.exports = { RECIPES, recipeOf, binOf };
