#!/usr/bin/env node
'use strict';

/**
 * Install WorkGremlin's reporting hook into each monitored product's user-level config
 * (CodeBuddy CLI+Plugin / Codex / Claude Code / TraeCode / Qoder).
 *
 * By default it installs **everything**: without --targets it walks every non-optional target in `all`
 * below, each doing "write only if installed, skip if not" (the check is looksInstalled). To add a new
 * product, add one entry to `all`.
 *
 * Usage:
 *   node scripts/install-hooks.js                       install (user-level: ~/.codebuddy + ~/.codex + ~/.claude + ~/.trae-cn/hooks.json)
 *   node scripts/install-hooks.js --targets=codex        install only some (codebuddy / codex / claude / trae / qoder / qoder-cn / project)
 *   node scripts/install-hooks.js --project              also write a project-level <repo>/.codebuddy/settings.json
 *   node scripts/install-hooks.js --uninstall            remove (only the entries we added; others' config untouched)
 *   node scripts/install-hooks.js --dry-run              only print what would be written, no disk writes
 *
 * Notes:
 *   - CodeBuddy Plugin and CodeBuddy CLI share one user-level config (~/.codebuddy/settings.json), so the
 *     `codebuddy` entry covers both; the matcher includes both CLI-style (Write/Edit) and IDE-style
 *     (write_to_file/replace_in_file), so either side matches.
 *   - Merge-write, re-runnable: first strip the entries we added last time (identified by our reporter
 *     hook's **repo-relative** path in the command — any checkout, so cloning/moving the repo self-heals
 *     instead of leaving a second, dead-or-double registration), then append; others' hooks are untouched.
 *     Before the first change it backs up to <file>.bak-workgremlin.
 *   - CLI-side changes do not take effect immediately: hooks are snapshotted at startup, so external
 *     changes must be reviewed once in the /hooks panel (a security design). Plugin-side: just reopen the session.
 *   - **7F Kilo Code is not in this list**: Kilo has no hook subsystem (no hooks.json, no attachable event
 *     point), so there is no hook to install. Its data is polled from Kilo's own SQLite by the server
 *     (see server/src/floorKilo.js); no config should be written here.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'packages', 'reporter', 'src', 'hook.js');
/**
 * WorkGremlin's own OpenCode / Kilo plugin (the one reporting true phase + ledger).
 * 7F Kilo / 8F OpenCode have no hook subsystem to attach to, so they are registered as a "plugin" in
 * their config instead.
 */
const PLUGIN_ENTRY_FILE = path.join(REPO_ROOT, 'packages', 'reporter', 'src', 'plugin', 'index.js');

/**
 * Repo-relative signatures of our own files. Entries are matched by these **suffixes**, never by the
 * absolute HOOK_SCRIPT / PLUGIN_ENTRY_FILE: when the repo is cloned to / run from another directory,
 * an entry written by an earlier install still carries the OLD absolute path. Matching the current
 * absolute path would not recognize it, so the merge would keep it and append a second entry — the
 * same event then fires our hook **twice** (measured: every event twice, two same-title tasks in one
 * session with the earlier one cancelled by endStaleTasksOfSession).
 */
const HOOK_SCRIPT_REL = 'packages/reporter/src/hook.js';
const PLUGIN_ENTRY_REL = 'packages/reporter/src/plugin/index.js';
function normSlash(s) {
  return String(s || '').replace(/\\/g, '/');
}

/**
 * A null matcher means the event takes no matcher (UserPromptSubmit / Stop).
 * Only write / edit tools record file_activity; read tools do not (which files were read does not matter,
 * and it avoids flooding).
 *
 * The PostToolUse allow-list **must include Task**: the subagent's "finished" signal originally relied on
 * it, and with Task missing from the list CodeBuddy never called our hook for it, so ghosts were only ever
 * added, never removed (measured: 5 PreToolUse for Task, 0 PostToolUse; write-class tools are the ones that
 * pair up). SubagentStop is registered as the second end signal for the same reason (the hook side only
 * collects ghosts, it does not touch main-session tasks).
 */
const CODEX_EVENTS = [
  ['SessionStart', ''],
  ['UserPromptSubmit', null],
  ['PreToolUse', ''],
  ['PostToolUse', ''],
  ['PermissionRequest', null],
  ['SubagentStart', null],
  ['SubagentStop', null],
  ['Stop', null],
  ['Interrupt', null],
  ['SessionEnd', ''],
];

/**
 * Claude Code's (2.1, measured) event table.
 *
 * The differences from CodeBuddy are why this **cannot reuse EVENTS directly**:
 *   - it has an explicit PermissionRequest (payload carries tool_name / tool_input), so waiting for
 *     permission no longer relies on "PreToolUse marks pending, timeout without clearing means guess";
 *     same tier as Codex;
 *   - PostToolUse is emitted for **all** tools (including Read/Grep/Bash), so the matcher is left empty
 *     instead of using an allow-list like EVENTS;
 *   - the subagent tool is called **Agent** (not Task); the hook's isSubagentTool matches it case-insensitively.
 *
 * Deliberately **does not register SubagentStart**: PreToolUse(Agent) already gets the real tool_use_id and
 * registers the ghost; registering SubagentStart too would register two ghosts for one subagent.
 *
 * SubagentStop is still registered, but Claude treats it as a non-finish signal
 * (`subagentStopMatchesSpawn: false`). Claude's real event names only the child `agent_id` and sends an empty
 * `tool_use_id`, while the ghost is keyed by the spawning PreToolUse's tool_use_id. PostToolUse(Agent) retires
 * it by the spawn id instead. The flag also prevents an old or malformed stop event with no instance identity
 * from falling back to `arr[0]` and retiring the wrong concurrent ghost. If PostToolUse never arrives, the
 * session sweeps catch the ghost (Stop / UserPromptSubmit / SessionEnd), followed by the poller's gcGhosts.
 *
 * Do **not** delete the SubagentStop entry to tidy this up: QODER_EVENTS below is this same table, and Qoder
 * keeps the default `subagentStopMatchesSpawn: true`, so it still needs the event.
 */
const CLAUDE_EVENTS = [
  ['SessionStart', ''],
  ['UserPromptSubmit', null],
  ['PreToolUse', ''],
  ['PostToolUse', ''],
  ['PermissionRequest', null],
  ['Notification', null],
  ['SubagentStop', null],
  ['Stop', null],
  ['SessionEnd', ''],
];

const EVENTS = [
  ['SessionStart', ''],
  ['UserPromptSubmit', null],
  ['PreToolUse', ''],
  ['PostToolUse', '^(Write|Edit|MultiEdit|NotebookEdit|write_to_file|replace_in_file|Task|Agent)$'],
  // Notification, like UserPromptSubmit / Stop / SubagentStop, **takes no matcher**
  // (extension source: EVENTS_WITHOUT_MATCHER is exactly these four) — giving it a matcher may disable it entirely
  ['Notification', null],
  ['Stop', null],
  ['SubagentStop', null],
  ['SessionEnd', ''],
];

/**
 * CodeBuddy event table = EVENTS + `FinalStop`.
 *
 * `FinalStop` is the CodeBuddy family's **round end-state** event; the payload carries
 * `final_stop_reason ∈ completed | cancelled | failed | interrupted`
 * (measured 2026-09-29: the dist's `executeFinalStopHooks(sessionId, reason)` emits it).
 * 1F uses it to recognize "the user pressed stop" — previously the server guessed (taskId stuck + last
 * transcript round state='running'), which misjudged a long round (pure reasoning over 2 minutes with no
 * tool events in between) as cancelled; that fallback was removed (see server/src/sessions.js /
 * server/src/ingest/hookCommon.js `finishCancelled`).
 *
 * **Trae is not merged in**: it is another vendor's VS Code fork; don't force this event name on it (stick with EVENTS).
 */
const CODEBUDDY_EVENTS = [...EVENTS, ['FinalStop', null]];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split('=');
    const next = argv[i + 1];
    if (inline !== undefined) args[key] = inline;
    else if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else args[key] = true;
  }
  return args;
}

/**
 * Hook command: `node <hook.js> --agent <name>` — one line per product, differing only in the --agent name.
 *
 * `name` is the **product family base name** (codebuddy / codex / claude / trae / qoder), not
 * a throwaway label:
 *   · the hook uses it to pick the event/tool vocabulary (the server dispatches by --agent; see
 *     server/src/ingest/hookCommon.js), and the default workstation name too — each floor gets its own
 *     desk card, no fighting with others;
 *   · some products **cannot be told apart at runtime**: trae and codebuddy both report client:'vscode',
 *     so only the identity injected at install time distinguishes them; a typo here (e.g. writing codebuddy
 *     for everything) would book 5F's work against 1F;
 *   · the codebuddy family shares ~/.codebuddy/settings.json between cli / plugin, so one entry is enough:
 *     the hook then splits cli (1F) / plugin (3F) by the payload's client.
 */
function hookCommand(name) {
  return `node "${HOOK_SCRIPT}" --agent ${name}`;
}

/**
 * Qoder CLI (6F): the hook config lives in ~/.qoder/settings.json (same shape as Claude / CodeBuddy, hooks
 * nested in settings.json). Qoder's real hook event names are not yet confirmed, so this **defaults to the
 * widest-coverage Claude-style event table** (PreToolUse / PostToolUse fire for all tools, plus
 * PermissionRequest / Notification / SubagentStop): whatever Qoder's tool names look like, our hook catches
 * at least session start/end, tool before/after, and permission events. If Qoder's actual event names differ,
 * just swap QODER_EVENTS for EVENTS / CODEX_EVENTS or a custom table — hook.js logic is not involved
 * (hook.js takes the generic path via --agent qoder, neither codex nor claude).
 */
const QODER_EVENTS = CLAUDE_EVENTS;

/** Is this one of our hook commands? Path-independent: our reporter hook suffix + a product --agent. */
function isOurCommand(command) {
  const c = normSlash(command);
  return c.includes(HOOK_SCRIPT_REL) && c.includes('--agent');
}

/** The entries we add: identified by whether the command points at our reporter hook (**any checkout**) */
function isOurs(group) {
  return !!group && Array.isArray(group.hooks) && group.hooks.some((h) => h && isOurCommand(h.command));
}

/** Whether this config already has our hook (decides whether to back up) */
function hasOurs(settings) {
  const groups = Object.values((settings && settings.hooks) || {}).flatMap((g) => (Array.isArray(g) ? g : []));
  return groups.some(isOurs);
}

function readSettings(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/* ------------------------------ plugin form (7F Kilo / 8F OpenCode) ------------------------------ */

/**
 * The plugin entry we write into Kilo / OpenCode config.
 *
 * These two products have **no hook subsystem** (measured on Kilo 7.8.1: no hook subcommand in `--help`,
 * no `hooks.json`), so reporting can only go through their own **plugin** mechanism: the plugin subscribes
 * to the agent's in-memory event stream, writes the phase / completion markers into the reporter state file,
 * and reports members / tasks / conversations / file activity to the ledger
 * (see packages/reporter/src/plugin/index.js). Without this entry, 7F/8F only have polling — the phase is
 * always inferred (greyed out) and there is **no task ledger at all** (polling is read-only; a monitoring
 * side must not fabricate reports).
 *
 * `options.client` pins the **product** (here `kilo`), **not the form**: the form is decided by the plugin
 * from the environment (see plugin/index.js's resolveClient / resolveForm — a VS Code extension carries
 * KILO_CLIENT=vscode → form `vscode`; a terminal CLI has no KILO_* at all → form `cli`). The reported
 * `client` is always the bare floor base name `kilo` either way. Hardcoding a form in the option is wrong:
 * this entry lives in `kilo.jsonc`, and **the CLI and the VS Code extension read the same config**, so
 * pinning one form would invert the other half.
 */

/**
 * **The key is `plugin` (singular), not `plugins`** — measured the hard way; it must be recorded here.
 *
 * Earlier this wrote `plugins: [{ package, options }]`. Kilo 7.8.1 does not recognize it: when it downgrades
 * the config **to V1** it logs a WARN for `plugins` and then **drops the whole section** —
 *   WARN configuration compatibility diagnostic source=~/.config/kilo/kilo.jsonc
 *        path="[\"plugins\"]" kind=unsupported
 *        action="Omitted native setting that cannot be represented in V1"
 * The symptom is "the plugin looks installed and the entry is really in the config, but not a single state
 * file is written and the 7F task ledger is forever empty", with **no error** — only that WARN (you have to
 * dig into ~/.local/share/kilo/log/opencode.log to see it).
 *
 * The real shape (in the binary: `plugin: J.optional(J.Array(Spec))`, `Spec = String | [String, Record]`):
 *   "plugin": [ ["/abs/path/index.js", { "client": "kilo" }] ]
 * Measured (Kilo 7.8.1 `kilo debug config`): only this form makes it into the parse result (and gets
 * normalized to a file:// URL); a probe plugin actually received session.created / message.part.updated etc.
 * The path must be **absolute** (a relative path is resolved against the config file's dir, which breaks across machines).
 * @param {string} client report identity
 * @returns {[string, {client:string}]} one plugin entry
 */
function pluginEntry(client) {
  return [PLUGIN_ENTRY_FILE, { client }];
}

/**
 * Does the project dir still have **our own** zero-config entry (`.kilo/{plugin,plugins}/*.{ts,js}`)?
 *
 * 7F **may only be registered in one place**. Kilo has two sources — `{plugin,plugins}/*.{ts,js}` under each
 * config dir, and the `plugin` array in the config file — and with both, the same process runs **two plugin
 * instances**: the same round is reported twice (measured 2026-09-30: two ledger rows with the same session
 * and title, `started_at` 5ms apart), and its de-dup is by **spec string** (an absolute path and the shim's
 * relative path count as two), so both survive.
 *
 * The installer only **reports**, never deletes: that is a file in the user's project; whether to delete it
 * is their call.
 * @returns {string[]} conflicting file paths
 */
function projectPluginEntryFiles(dir) {
  const hits = [];
  for (const cfg of ['.kilo', '.kilocode']) {
    for (const sub of ['plugin', 'plugins']) {
      const d = path.join(dir, cfg, sub);
      let names = [];
      try {
        names = fs.readdirSync(d);
      } catch {
        continue; // the dir not existing means this is a non-issue
      }
      for (const n of names) {
        if (!/\.(ts|js)$/.test(n)) continue;
        const f = path.join(d, n);
        let body = '';
        try {
          body = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        // Count it if the name or content mentions us — a shim only forwards, so matching content is more reliable than the filename
        if (/workgremlin/i.test(n) || body.includes(PLUGIN_ENTRY_REL) || /workgremlin/i.test(body)) hits.push(f);
      }
    }
  }
  return hits;
}

/** The package path inside one plugin entry (accepts a string form / a [path, options] tuple) */
function pluginPathOf(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) return String(entry[0] || '');
  if (entry && typeof entry === 'object') return String(entry.package || entry.path || '');
  return '';
}

/** Is this one of our plugin entries? Path-independent (any checkout's PLUGIN_ENTRY_REL). */
function isOurPluginPath(p) {
  return normSlash(p).includes(PLUGIN_ENTRY_REL);
}

/** Whether this config already has our plugin entry (identified by the package path, not by name) */
function hasPluginEntry(settings, client) {
  const list = Array.isArray(settings && settings.plugin) ? settings.plugin : [];
  return list.some((p) => isOurPluginPath(pluginPathOf(p)));
}

/**
 * Idempotent merge of the plugin array: strip the entry we wrote last time (same package path), then append.
 * Others' plugins are untouched; `uninstall` removes only ours.
 *
 * Also clears the `plugins` section left by an earlier wrong key: Kilo never recognized it, and keeping it
 * only adds an "Omitted native setting" WARN on every startup (and makes people think the plugin is installed).
 */
function mergePlugins(existing, client, uninstall) {
  const list = Array.isArray(existing.plugin) ? existing.plugin : [];
  const kept = list.filter((p) => !isOurPluginPath(pluginPathOf(p)));
  const out = { ...existing };
  delete out.plugins;
  const next = uninstall ? kept : [...kept, pluginEntry(client)];
  if (next.length) out.plugin = next;
  else delete out.plugin;
  return out;
}

function writeSettings(file, settings, dryRun) {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  if (dryRun) return text;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return text;
}

/**
 * @param {object} existing
 * @param {object} ours event -> group array
 * @param {boolean} uninstall
 */
function merge(existing, ours, uninstall) {
  const hooks = { ...(existing.hooks || {}) };
  for (const event of Object.keys(ours)) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((g) => !isOurs(g));
    const next = uninstall ? kept : [...kept, ...ours[event]];
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  const out = { ...existing };
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

/**
 * Does this target look installed? **If not, don't write**.
 *
 * The check aligns with server/src/floors.js: only the "install location" counts —
 *   · CLI: an executable is found in PATH or a common bin dir;
 *   · plugin: found in the editor extension dir (covering "only the plugin is installed, no CLI, ~/.codebuddy
 *     has no data yet").
 * Plus a fallback: the config dir has data besides our own settings.json (the product really uses this dir).
 * (An early version treated "the config dir exists" as evidence and was fooled by dirs our own install script
 *  created; now floors.js only uses install location for installed, so creating a config dir here does not
 *  make it look installed.)
 *
 * Note: this only decides "whether to write"; "whether our hook is already there, and if so don't rewrite it"
 * is guaranteed by the merge + before===after skip below (i.e. "skip if present, install if not").
 */

const HOME = os.homedir();

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a PATH command to an absolute path */
function resolveCommand(cmd) {
  try {
    const out = execSync(`command -v ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, encoding: 'utf8' });
    return String(out || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

/** Fallback common CLI install dirs (when PATH does not have it) */
const CLI_BIN_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'bin'),
  path.join(HOME, '.codebuddy', 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
];
function findCliBin(cmd) {
  const names = process.platform === 'win32' ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd];
  for (const dir of CLI_BIN_DIRS) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (isFile(p)) return p;
    }
  }
  return '';
}

/** Editor extension dirs (plugin install location) */
function extensionRoots() {
  // .trae-cn is TraeCode (China edition)'s extension root; the coding-copilot extension installs under it
  return ['.vscode', '.vscode-insiders', '.cursor', '.trae', '.trae-cn', '.windsurf', '.vscode-server']
    .map((d) => path.join(HOME, d, 'extensions'))
    .filter(isDir);
}
const RE_PLUGIN = [/codebuddy/i, /tencent/i, /ingram/i, /code-?buddy/i];
function pluginMatchIn(root, res) {
  // res may be a single regex (a product's pluginRe, e.g. /trae/i) or an array: normalize to an array, then .some
  const list = res instanceof RegExp ? [res] : res || [];
  try {
    for (const name of fs.readdirSync(root)) {
      if (list.some((re) => re.test(name))) return path.join(root, name);
    }
  } catch {
    /* skip if unreadable */
  }
  return '';
}
function findPluginDir(res = RE_PLUGIN) {
  for (const r of extensionRoots()) {
    const hit = pluginMatchIn(r, res);
    if (hit) return hit;
  }
  return '';
}

function looksInstalled(t) {
  // CLI: an executable is found in PATH or a common install dir
  if (t.cmd && (resolveCommand(t.cmd) || findCliBin(t.cmd))) return true;
  // Plugin: found in the editor extension dir (CodeBuddy Plugin and CLI share ~/.codebuddy)
  if (t.plugin && findPluginDir(t.pluginRe || RE_PLUGIN)) return true;
  // Fallback: the config dir has data besides our own settings.json
  const ours = new Set(['settings.json', 'settings.json.bak-workgremlin']);
  try {
    return fs.readdirSync(t.dir).some((n) => !ours.has(n));
  } catch {
    return false;
  }
}

/**
 * Install / uninstall hooks. Callable as a function (auto-hooked at server startup) or via the CLI (see the end of the file).
 * @param {Record<string, any>} [args] same as the CLI args (targets / dry-run / uninstall / project)
 * @returns {{installed: string[], unchanged: string[], skipped: string[], failed: string[], files: string[]}}
 */
function installHooks(args = parseArgs(process.argv.slice(2))) {
  /** @type {{installed: string[], unchanged: string[], skipped: string[], failed: string[], files: string[]}} */
  const result = { installed: [], unchanged: [], skipped: [], failed: [], files: [] };
  const dryRun = args['dry-run'] === true;
  const uninstall = args.uninstall === true;
  const wanted = String(args.targets || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const buildOurs = (events, agent) => {
    const hookCmd = hookCommand(agent);
    const out = {};
    for (const [event, matcher] of events) {
      const entry = { type: 'command', command: hookCmd, timeout: 10 };
      out[event] = [matcher === null ? { hooks: [entry] } : { matcher, hooks: [entry] }];
    }
    return out;
  };
  const codebuddyOurs = buildOurs(CODEBUDDY_EVENTS, 'codebuddy');
  const codexOurs = buildOurs(CODEX_EVENTS, 'codex');
  const traeOurs = buildOurs(EVENTS, 'trae');
  const claudeOurs = buildOurs(CLAUDE_EVENTS, 'claude');
  const qoderOurs = buildOurs(QODER_EVENTS, 'qoder');

  const all = [
    {
      id: 'codebuddy',
      label: 'CodeBuddy Plugin / CodeBuddy CLI',
      file: path.join(os.homedir(), '.codebuddy', 'settings.json'),
      cmd: 'codebuddy',
      dir: path.join(os.homedir(), '.codebuddy'),
      plugin: true,
      ours: codebuddyOurs,
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      // Measured (Codex 0.151.0): the user-level hooks file is under the codex home, same structure as CodeBuddy's settings.json
      file: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'),
      cmd: 'codex',
      dir: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      ours: codexOurs,
    },
    {
      id: 'claude',
      label: 'Claude Code CLI',
      // Claude Code's hooks are the same shape as CodeBuddy's (settings.json + hooks events + matcher);
      // the user level is ~/.claude/settings.json. Note it has an extra "workspace trust" gate (see the hint at the end of the file).
      file: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'),
      cmd: 'claude',
      dir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
      ours: claudeOurs,
    },
    {
      id: 'trae',
      label: 'TraeCode global Hook',
      // Official docs (docs.trae.cn "Hook configuration"): on Linux/macOS the global hook lands in
      // ~/.trae-cn/hooks.json, shaped { version: 1, hooks: { <event>: [ { matcher, hooks:[{type,command,timeout}] } ] } }
      // — not CodeBuddy's settings.json, and not ~/.trae/. Only the project level is <project>/.trae/hooks.json.
      file: path.join(os.homedir(), '.trae-cn', 'hooks.json'),
      cmd: 'trae',
      dir: path.join(os.homedir(), '.trae-cn'),
      plugin: true,
      // In the editor extension dir it is tencent-cloud.coding-copilot (the TraeCode core), not "trae"
      pluginRe: /trae|coding-copilot/i,
      version: 1,
      ours: traeOurs,
    },
    { id: 'project', label: `CodeBuddy project level (${path.basename(REPO_ROOT)})`, file: path.join(REPO_ROOT, '.codebuddy', 'settings.json'), ours: codebuddyOurs, optional: true },
    {
      id: 'qoder',
      label: 'Qoder CLI (international)',
      // Qoder's hooks are the same shape as Claude / CodeBuddy: hooks nested in ~/.qoder/settings.json.
      file: path.join(os.homedir(), '.qoder', 'settings.json'),
      cmd: 'qoder',
      dir: path.join(os.homedir(), '.qoder'),
      ours: qoderOurs,
    },
    {
      // Qoder (China edition): the command is qoder-cn, the config home is ~/.qoder-cn (same settings.json shape).
      // The report identity is still --agent qoder (the product family base name, see 6F's agent); only the on-disk home differs.
      id: 'qoder-cn',
      label: 'Qoder CLI (China edition)',
      file: path.join(os.homedir(), '.qoder-cn', 'settings.json'),
      cmd: 'qoder-cn',
      dir: path.join(os.homedir(), '.qoder-cn'),
      ours: qoderOurs,
    },
    {
      // 7F Kilo Code: **there is no hook to install**; what we install is our own plugin.
      // Kilo 7.8.1 was measured to have no hook subcommand and no hooks.json, so reporting goes through its
      // `plugin` mechanism (**singular key**, the entry is [absolute path, options], see pluginEntry).
      // Without the plugin, 7F still **has** a task ledger — the server's poller writes one row per round
      // (read-only inference, server/src/floorKilo.js); the plugin path fills in what polling cannot reach:
      // the true phase (not greyed out), "awaiting permission", the closing summary and conversation / file
      // activity, and the **form** (CLI / VS Code plugin).
      id: 'kilo-plugin',
      label: 'Kilo Code plugin (true phase + task ledger)',
      kind: 'plugin',
      file: path.join(os.homedir(), '.config', 'kilo', 'kilo.jsonc'),
      // Installed-or-not check: the same ruler as other floors (kilo in PATH / the data root exists)
      cmd: 'kilo',
      dir: (() => {
        const explicit = String(process.env.WORKGREMLIN_KILO_HOME || '').trim();
        if (explicit) return path.resolve(explicit);
        const xdg = String(process.env.XDG_DATA_HOME || '').trim();
        if (xdg) return path.join(path.resolve(xdg), 'kilo');
        return path.join(os.homedir(), '.local', 'share', 'kilo');
      })(),
      // Report identity is the floor base name; the form (CLI / VS Code) is decided by the plugin itself
      client: 'kilo',
    },
  ];
  const targets = all.filter((t) => (t.optional ? args.project === true || wanted.includes(t.id) : !wanted.length || wanted.includes(t.id)));

  if (!fs.existsSync(HOOK_SCRIPT)) {
    // Throw rather than process.exit: auto-hooking at server startup calls this function; exiting would take the server down
    throw new Error(`hook script not found: ${HOOK_SCRIPT}`);
  }

  console.log(`[workgremlin] hook command: ${hookCommand('codebuddy')}`);
  if (!wanted.length || wanted.includes('codex')) console.log(`[workgremlin] Codex command: ${hookCommand('codex')}`);
  if (!wanted.length || wanted.includes('trae')) console.log(`[workgremlin] TraeCode command: ${hookCommand('trae')}`);
  if (!wanted.length || wanted.includes('claude')) console.log(`[workgremlin] Claude Code command: ${hookCommand('claude')}`);
  if (dryRun) console.log('[workgremlin] --dry-run: not writing to disk');

  // 7F **may only be registered in one place**. The global entry (the plugin array in kilo.jsonc) is enough;
  // if the project dir keeps a zero-config entry too, Kilo loads both → two instances in one process → one
  // round lands as two ledger rows. Report only, don't delete: that is a file in the user's project (this
  // repo hit this itself, measured 2026-09-30).
  if (!uninstall && targets.some((t) => t.id === 'kilo-plugin')) {
    const dirs = [...new Set([process.cwd(), REPO_ROOT])];
    const conflicts = dirs.flatMap((d) => projectPluginEntryFiles(d));
    if (conflicts.length) {
      console.warn('[workgremlin] ⚠ Kilo Code: this project still has another zero-config plugin entry:');
      for (const f of conflicts) console.warn(`[workgremlin]     ${f}`);
      console.warn('[workgremlin]   Two registrations start two plugin instances in one Kilo process, so one round is reported twice (one ledger row becomes two).');
      console.warn('[workgremlin]   The global entry (kilo.jsonc) is enough; consider deleting the one above (we do not touch your files automatically).');
    }
  }

  for (const t of targets) {
    // Don't write for a product that isn't installed: writing would fabricate "installed" evidence for it
    if (!uninstall && !t.optional && !looksInstalled(t)) {
      console.log(
        `[workgremlin] · ${t.label}: looks not installed (no ${t.cmd} in PATH, no other data in ${t.dir}), skipping (if you're sure it's installed, force with --targets=${t.id})`
      );
      result.skipped.push(t.label);
      continue;
    }

    const exists = fs.existsSync(t.file);
    const existing = exists ? readSettings(t.file) : null;
    if (exists && existing === null) {
      console.error(`[workgremlin] ✗ ${t.label}: ${t.file} is not valid JSON; fix it before installing (left untouched)`);
      result.failed.push(t.label);
      continue;
    }

    const isPlugin = t.kind === 'plugin';
    const next = isPlugin ? mergePlugins(existing || {}, t.client, uninstall) : merge(existing || {}, t.ours, uninstall);
    // The hooks.json protocol (TraeCode) carries a schema version by default: ensure it on create/existing, don't overwrite an existing one
    if (!uninstall && t.version) next.version = next.version || t.version;
    const before = JSON.stringify(existing || {});
    const after = JSON.stringify(next);

    if (!uninstall && before === after) {
      console.log(`[workgremlin] · ${t.label}: already up to date ${t.file}`);
      result.unchanged.push(t.label);
      continue;
    }
    if (uninstall && before === after) {
      console.log(`[workgremlin] · ${t.label}: was not installed ${t.file}`);
      result.unchanged.push(t.label);
      continue;
    }

    // dry-run must not write a single byte: earlier this did not check dryRun, so previewing really wrote a .bak-workgremlin
    // The plugin form checks its own entry (by package path); don't ask hasOurs about hooks — that only looks at hooks
    if (!dryRun && exists && !(isPlugin ? hasPluginEntry(existing, t.client) : hasOurs(existing))) {
      fs.copyFileSync(t.file, `${t.file}.bak-workgremlin`);
      console.log(`[workgremlin]   backup -> ${t.file}.bak-workgremlin`);
    }

    writeSettings(t.file, next, dryRun);
    // On dry-run say "will write" honestly — otherwise the preview output would falsely claim it already wrote
    const verb = uninstall ? 'removed' : 'written';
    console.log(`[workgremlin] ✓ ${t.label}: ${dryRun ? (uninstall ? 'would remove' : 'would write') : verb} ${t.file}`);
    if (!dryRun) result.installed.push(t.label);
    result.files.push(t.file);
  }

  if (!uninstall) {
    console.log('');
    console.log('[workgremlin] · Codex CLI: hooks need "trust" to run — approve once via /hooks in a new session;');
    console.log('                       for automation you can temporarily add --dangerously-bypass-hook-trust');
    console.log('[workgremlin] How it takes effect:');
    console.log('  · TraeCode: first confirm the global hooks.json is enabled in Settings > Hooks (external writes have a security gate), then reopen the session');
    console.log('  · CodeBuddy Plugin: reopen the session');
    console.log('  · CodeBuddy CLI: changes do not take effect immediately; run /hooks to review them (external changes need approval)');
    console.log('  · Claude Code: a newly started session after writing takes effect directly (measured with claude --print, no approval);');
    console.log('                if it looks like "installed but nothing happens", review it once in the /hooks panel');
    console.log('  · The main agent identity comes from the install target (codebuddy / codex / trae / claude / qoder), already written into the hook command\'s --agent; it cannot and need not be specified again');
    console.log('  · 7F Kilo Code: **no hook** (measured 7.8.1: no hook subcommand / hooks.json), so we install the plugin;');
    console.log('                changes to kilo.jsonc need a **Kilo session reopen** to load. Without the plugin there is still a task ledger —');
    console.log('                the server\'s poller writes one row per round (read-only inference: phase greyed out, no closing summary);');
    console.log('                with the plugin it is the true value (phase not greyed out, "awaiting permission", conversation records and file activity)');
    console.log('[workgremlin] · To opt out of auto-hooking: WORKGREMLIN_NO_AUTO_HOOKS=1');
  }
  return result;
}

module.exports = { installHooks, HOOK_SCRIPT, EVENTS, CODEBUDDY_EVENTS, CODEX_EVENTS, CLAUDE_EVENTS };

if (require.main === module) {
  try {
    installHooks();
  } catch (err) {
    console.error(`[workgremlin] ${err && err.message}`);
    process.exit(1);
  }
}
