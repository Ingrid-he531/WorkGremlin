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
 * Each recipe also declares the permission modes the new-session dialog may offer. 8F OpenCode only
 * has `auto`; Claude Code exposes its own permission modes.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectProducts } = require('../floors');

/**
 * Claude Code's `--output-format stream-json` is one JSON event per line. Turn only the assistant's
 * text deltas into transcript output; keep a `result` fallback for versions/configurations that do
 * not emit partial messages.
 */
function claudeStreamParser() {
  let buffer = '';
  let sawText = false;

  const emit = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    if (obj.type === 'stream_event') {
      const ev = obj.event;
      if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        sawText = true;
        return String(ev.delta.text || '');
      }
      return '';
    }
    if (obj.type === 'assistant' && !sawText && obj.message && Array.isArray(obj.message.content)) {
      const text = obj.message.content
        .filter((part) => part && part.type === 'text')
        .map((part) => String(part.text || ''))
        .join('');
      if (text) {
        sawText = true;
        return text;
      }
      return '';
    }
    if (obj.type === 'result' && !sawText && typeof obj.result === 'string') {
      sawText = true;
      return obj.result;
    }
    return '';
  };

  const drain = (line) => {
    const text = line.trim();
    if (!text) return '';
    try {
      return emit(JSON.parse(text));
    } catch {
      return '';
    }
  };

  return {
    push(chunk) {
      buffer += String(chunk || '');
      let out = '';
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        out += drain(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      return out;
    },
    flush() {
      const tail = buffer;
      buffer = '';
      return drain(tail);
    },
  };
}

const CLAUDE_PERMISSIONS = Object.freeze(['auto', 'acceptEdits', 'bypassPermissions', 'plan']);

/** Claude Code stores its model picker in `~/.claude/settings.json` (CLAUDE_CONFIG_DIR overrides). */
function claudeSettingsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/**
 * Claude Code has no `models` command. Use the model picker the CLI itself configured, so the
 * remote-task picker offers the same provider/model refs the terminal does.
 * @param {string} [file]
 * @returns {{models: string[], labels: Record<string,string>, error: string}}
 */
function claudeModelsFromFile(file = claudeSettingsFile()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A missing settings file only means "no catalog"; it is not a failure of the dispatch.
    return { models: [], labels: {}, error: '' };
  }
  const options =
    raw && raw.modelPicker && Array.isArray(raw.modelPicker.options) ? raw.modelPicker.options : [];
  const seen = new Set();
  const models = [];
  const labels = {};
  for (const option of options) {
    const id = String((option && option.model) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    const label = String((option && option.label) || '').trim();
    if (label) labels[id] = label;
  }
  return { models, labels, error: '' };
}

const RECIPES = Object.freeze({
  '4F': {
    floor: '4F',
    client: 'claude',
    name: 'Claude Code',
    permissions: CLAUDE_PERMISSIONS,
    defaultPermission: 'auto',
    mintSessionId: () => crypto.randomUUID(),
    /** `claude models` does not exist; read the CLI's own model picker instead. */
    fetchModels: async () => claudeModelsFromFile(),
    build({ prompt, model, sessionId, permission, resume }) {
      const mode = CLAUDE_PERMISSIONS.includes(permission) ? permission : 'auto';
      const args = ['-p'];
      // Put the session flag first: `--permission-prompts` is option-heavy in some CLI versions
      // and a trailing --session-id was observed to be ignored.
      if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId);
      args.push(
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-prompts',
        'none'
      );
      if (model) args.push('--model', model);
      if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
      else args.push('--permission-mode', mode);
      return { args, stdin: prompt, parser: claudeStreamParser };
    },
  },

  '8F': {
    floor: '8F',
    client: 'opencode',
    name: 'OpenCode',
    permissions: Object.freeze(['auto']),
    defaultPermission: 'auto',
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
 * @returns {{floor: string, client: string, name: string, permissions: string[], defaultPermission: string,
 *   build: Function, mintSessionId?: Function, fetchModels?: Function}|null}
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

module.exports = {
  RECIPES,
  recipeOf,
  binOf,
  claudeStreamParser,
  claudeModelsFromFile,
  CLAUDE_PERMISSIONS,
};
