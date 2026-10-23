'use strict';

/**
 * The **command-line recipes** for each council floor —— the only place in the council room that
 * touches each CLI's details.
 *
 * Every recipe records three things: how to hand the prompt over, **how to guarantee it is read-only**,
 * and how to read what it spits out (the body plus best-effort model/token metadata). The first two
 * are the focus here, and each floor below documents how that was verified (1F/4F/7F/8F measured
 * locally on 2026-10-01; 2F/3F/6F measured on 2026-10-19 where noted, otherwise per the CLI's own
 * documentation).
 *
 * About "read-only" (the criterion the user set, and the prerequisite for entering the council room):
 *   · 1F CodeBuddy / 4F Claude Code —— `--tools ""` disables all built-in tools (both help texts say
 *     `Use "" to disable all tools`).
 *   · 7F Kilo / 8F OpenCode —— neither has a tool switch (`kilo --pure` only disables **external
 *     plugins**, nothing to do with tools; do not be fooled by the name). They rely on **injecting a
 *     config where every permission is deny**:
 *       - kilo uses `KILO_CONFIG_CONTENT`; measured with `kilo debug config`, permission turned into
 *         deny;
 *       - opencode uses `OPENCODE_CONFIG_CONTENT`; an A/B test was run: unlocked it could read a
 *         marker file inside the temp directory, locked, tool calls were refused outright and the
 *         marker file could not be read.
 *   · 8F additionally keeps directories outside HOME out via `external_directory` (its default is
 *     ask, not allow, so stacking deny makes sure nothing escapes).
 *   · 2F Cline —— no tool switch; `--plan` is Cline's own read-only mode (measured 2026-10-19: a write
 *     was refused while `read_files` worked). Its guarantee is weaker than `--tools`: read-only shell
 *     commands may still run.
 *   · 3F Codex —— `codex exec` runs non-interactively without approval and defaults to a **read-only
 *     sandbox**; `--sandbox read-only` pins it (commands may run, but cannot write to disk or reach
 *     the network).
 *   · 6F Qoder —— headless `--print` mode has nobody to answer a permission prompt, and Qoder's docs
 *     state anything requiring confirmation is **denied by default**; no `--permission-mode` is passed
 *     on purpose (the default deny is the read-only posture we want). Not yet verified on a real device
 *     (the CLI is not installed on the dev machine) —— see the note on the 6F recipe.
 *
 * One more **mandatory** step: 7F needs `"plugin": []` to strip plugins. Kilo's global config carries
 * WorkGremlin's own reporting plugin (`packages/reporter/src/plugin/index.js`); leaving it in means
 * council participants get reported into the office —— a direct violation of "isolated, visible only
 * in the council room". `--pure` **cannot remove it** (measured); only `plugin: []` in the config
 * works.
 *
 * One more rule running through this whole file: **say it when you cannot parse**. A model switching
 * formats or a CLI changing its output must land in status='unparsed' with the raw text kept —— never
 * guess "probably agree".
 */

const { spawnSync } = require('node:child_process');

const { DEFAULTS } = require('@workgremlin/shared');

/**
 * Turn off WorkGremlin's **own** reporting —— injected by every recipe.
 *
 * Why it is mandatory: when the user supplies a workspace, cwd is the user's real project, and the
 * reporting hooks installed in `~/.claude/settings.json` / `~/.codebuddy/settings.json` would report
 * with the real project path —— the participant would turn into "one of the members in your project",
 * a direct violation of "visible only in the council room". When no workspace is given, cwd falls back
 * to a throwaway temp directory (the office filters that out by project), but the flag is still injected
 * uniformly. The hook (packages/reporter/src/hook.js) and the plugin
 * (packages/reporter/src/plugin/index.js) both honor this flag and exit in place when they see it.
 */
const QUIET_ENV = Object.freeze({ WORKGREMLIN_DISABLE: '1' });

/**
 * Fixed session title for 7F / 8F / 6F participants —— unlike 1F/4F these have no "do not persist"
 * switch, so sessions are always recorded in their **global** store (`session.directory` = the cwd at
 * the time). When the user supplies a workspace, cwd is the user's project, and unguarded participants
 * would show up directly on the office's 7F/8F/6F. The guard is "give it a fixed title", which
 * server/src/floorKilo.js and server/src/floorOpencode.js skip when listing sessions —— reasoning and
 * trade-offs are written on COUNCIL_SESSION_TITLE in shared/index.js.
 *
 * 6F Qoder takes this title via `--name`; whether its CLI transcript also carries it (and thus whether
 * the office filters it out) is not yet verified on a real device —— see the 6F recipe below.
 * 3F Codex does not need a title at all: `--ephemeral` writes no session.
 */
const SESSION_TITLE = DEFAULTS.COUNCIL_SESSION_TITLE;

/** The 7F / 8F permission tables have to be spelled out item by item (`*` is the catch-all; listing the rest keeps it readable and easy to assert) */
const PERMISSION_KEYS = Object.freeze([
  'bash', 'edit', 'write', 'read', 'glob', 'grep', 'list',
  'webfetch', 'websearch', 'task', 'skill', 'todowrite', 'external_directory',
]);

/**
 * Permission table handed to 7F / 8F (the council is always read-only): **only** read-type tools are
 * allowed, everything else stays denied.
 *
 * 7F Kilo / 8F OpenCode have no `--tools` switch like 1F/4F (`kilo --pure` only disables external
 * plugins, nothing to do with tools), so "read-only" can only be achieved by feeding this config.
 * Two entries **must** stay denied:
 *   · `bash` / `write` / `edit` —— participants may not modify the user's code nor run commands on
 *     his machine;
 *   · `external_directory` —— participants may look inside the workspace only. Its default is ask,
 *     and since nobody answers council participants' permission prompts, ask turns into "stuck until
 *     timeout"; writing deny explicitly is deterministic behavior.
 */
const READ_PERMISSION = Object.freeze(
  Object.fromEntries([
    ['*', 'deny'],
    ...PERMISSION_KEYS.map((k) => [k, ['read', 'glob', 'grep', 'list'].includes(k) ? 'allow' : 'deny']),
  ])
);

/**
 * Read-only tool whitelist for 1F / 4F. The **same list** goes to `--tools` and `--allowedTools`:
 *   · `--tools`        —— limits which built-in tools it **can use** (the rest never appear);
 *   · `--allowedTools` —— lets those tools be used **without asking**.
 * `-p` is non-interactive, nobody answers permission prompts, so giving only the former means reading
 * a file gets refused (it asks at every step) and participants can only stare blankly —— that is not
 * read-only, it is read-nothing.
 */
const READ_TOOLS = 'Read,Grep,Glob';

/**
 * Turn every MCP server in the user's Codex config **off by name**, instead of refusing the whole
 * config with `--ignore-user-config`.
 *
 * Why the whole config must stay loaded: `--ignore-user-config` also drops `model_provider` /
 * `base_url`, so a machine whose Codex reaches the model through a local proxy silently falls back to
 * `api.openai.com`, prints `Reconnecting... (request timed out)` until the 60s preflight kills it, and
 * 3F can never take part in a meeting. Measured on 2026-10-23: with the flag the probe never answered;
 * without it, 12s and `OK`. 4F already has the precise switch for this (`--strict-mcp-config`); Codex
 * has none, so we ask Codex itself what its config defines and override each server.
 *
 * Two near-misses were measured and must not be used instead:
 *   · `-c mcp_servers={}` does **not** clear the table — Codex merges it, and the server still started;
 *   · a quoted key (`mcp_servers."name".enabled=false`) is rejected as `invalid transport`.
 * Plain dotted names are the only accepted form, hence `CODEX_CONFIG_KEY`.
 *
 * `-c notify=[]` is part of the same deal: with the user config loaded, a configured `notify` command
 * would run outside the sandbox on every turn.
 */

/** A server name that can be addressed as a bare dotted `-c` key. */
const CODEX_CONFIG_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * @param {Array<{name?:string, enabled?:boolean}>} servers `codex mcp list --json` output
 * @returns {string[]|null} extra args, or null when the list cannot be honoured safely
 */
function codexMcpArgs(servers) {
  if (!Array.isArray(servers)) return null;
  const names = servers
    .filter((s) => s && s.enabled !== false)
    .map((s) => String(s.name || ''))
    .filter(Boolean);
  // A name we cannot address would silently stay enabled — fall back to ignoring the whole config
  // rather than let one MCP server (and its network access) into the meeting.
  if (names.some((n) => !CODEX_CONFIG_KEY.test(n))) return null;
  const args = ['-c', 'notify=[]'];
  for (const name of names) args.push('-c', `mcp_servers.${name}.enabled=false`);
  return args;
}

/**
 * Read the user's MCP list with the CLI's own parser (a hand-written TOML reader would drift from the
 * real syntax) and shape it into `-c` overrides. Any failure falls back to `--ignore-user-config`:
 * keeping MCP tools out of the meeting matters more than honouring a custom endpoint.
 *
 * `cwd` is passed so a project-level `.codex/config.toml` is seen by the same listing the turn uses.
 */
function codexMcpOffArgs(bin, cwd) {
  let stdout;
  try {
    const r = spawnSync(bin, ['mcp', 'list', '--json'], {
      cwd: cwd || undefined,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.status !== 0 || typeof r.stdout !== 'string') return ['--ignore-user-config'];
    stdout = r.stdout;
  } catch {
    return ['--ignore-user-config'];
  }
  // Tolerate stray log lines around the JSON array
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) return ['--ignore-user-config'];
  let servers;
  try {
    servers = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return ['--ignore-user-config'];
  }
  return codexMcpArgs(servers) || ['--ignore-user-config'];
}

/**
 * One recipe per floor.
 *
 * build({ bin, prompt, model }) → { bin, args, env, stdin }
 *   · `model` is optional and comes from the seat's stored `council_participants.model`. When present
 *     it is passed through the product's own model flag. Empty means "whatever that CLI is configured
 *     with"; the preflight probe reports the real failure when that default is broken.
 *   · The council is **always read-only**: every recipe narrows the participant to read-type tools
 *     (see READ_TOOLS / READ_PERMISSION and each recipe's own note above) —— no writes, no network, and
 *     command execution only where a CLI cannot turn it off (see 2F / 3F).
 *   · env is **layered on top of** process.env (not a replacement) —— each CLI's login credentials
 *     live in ~/.claude, ~/.config/kilo, etc. and are found via HOME. Blocking HOME blocks the login,
 *     so isolation relies on cwd + read-only narrowing + QUIET_ENV, not on rewriting environment
 *     variables.
 *   · When stdin is not null the prompt travels through a pipe (not argv): long text never hits
 *     ARG_MAX and never shows up in `ps` output for other processes on the machine. 2F Cline refuses to
 *     read the prompt from stdin, so it is the one recipe that passes the prompt as a positional
 *     argument (bounded by COUNCIL_MATERIAL_TOTAL_MAX_BYTES).
 *
 * Both 1F and 4F carry `--no-session-persistence` (documented in both help texts, valid under
 * `--print` only): participant conversations are **not persisted**. 3F Codex uses `--ephemeral` for the
 * same effect. That matters when cwd is the user's real project —— persisted, each CLI records
 * participants under **that project path** into its own history (`~/.claude/projects/<project>/`), and
 * the global session list grows a few "active sessions in your project". 2F Cline and 6F Qoder have no
 * such switch: their guards are the prompt marker / `--name` (see shared/index.js COUNCIL_PROMPT_MARKER
 * and COUNCIL_SESSION_TITLE).
 *
 * `--strict-mcp-config` without `--mcp-config`: do not load MCP servers from the user config.
 * `--tools` limits the **built-in** tool set, and MCP tools are not part of it —— leaving that open
 * would let a participant use a tool we never whitelisted.
 */
const RECIPES = {
  '1F': {
    agent: 'codebuddy',
    name: 'CodeBuddy',
    // Measured: `-p` with no message reads the pipe (help text: "useful for pipes")
    build({ bin, prompt, model }) {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
      // Model goes before the variadic --allowedTools, which would otherwise swallow it.
      if (model) args.push('--model', model);
      args.push('--tools', READ_TOOLS, '--allowedTools', READ_TOOLS);
      return { bin, args, env: { ...QUIET_ENV }, stdin: prompt };
    },
  },

  '2F': {
    agent: 'cline',
    name: 'Cline',
    /**
     * Cline's CLI has no `--tools` whitelist and no `--no-session-persistence`. `--plan` is its **own
     * read-only plan mode** (measured 2026-10-19: asking it to create a file was refused while
     * `read_files` on the same directory worked), which is the closest thing it offers.
     *
     * Unlike 1F/4F, the guarantee is weaker: plan mode still allows read-only shell commands
     * (measured: `whoami` ran). It cannot write files, which is the property the council actually needs.
     *
     * The prompt goes as a **positional argument**: `cline --plan --json` refuses to read stdin
     * (measured: "JSON output mode requires a prompt argument or piped stdin" even when stdin was piped).
     * The council prompt is bounded by COUNCIL_MATERIAL_TOTAL_MAX_BYTES, so ARG_MAX is not a concern.
     *
     * Session persistence cannot be turned off (`--data-dir` would move the store but takes the login
     * with it —— measured: `Unauthorized` with an isolated data dir), so the participant's session lands
     * in `~/.cline/data`. The office lock is therefore the **prompt marker**: Cline stores the prompt
     * itself as the session title, and floorCline.js skips titles containing COUNCIL_PROMPT_MARKER.
     */
    build({ bin, prompt, model }) {
      const args = ['--plan', '--json'];
      if (model) args.push('-m', model);
      args.push(prompt);
      return { bin, args, env: { ...QUIET_ENV }, stdin: null };
    },
  },

  '3F': {
    agent: 'codex',
    name: 'Codex',
    /**
     * `codex exec` is non-interactive and, per its own docs, runs in read-only mode by default with no
     * approval prompt; `--sandbox read-only` pins that (it uses the OS sandbox: commands may run, but
     * cannot write to disk or reach the network).
     *
     * `--ephemeral` is the exact equivalent of 1F/4F's `--no-session-persistence`: the participant's
     * rollout is **not** written under `~/.codex/sessions`, so it can never surface on the office's 3F.
     * That is why 3F, unlike 2F/7F/8F, needs no title marker.
     *
     * `--skip-git-repo-check` — isolated mode's cwd is a throwaway temp dir, which is not a git repo.
     * The user's `config.toml` **is** loaded (the model may only be reachable through a provider/base_url
     * defined there), but every MCP server it defines is switched off one by one — see
     * `codexMcpOffArgs`. `--ignore-user-config` remains the fallback when that list cannot be read.
     * `-c web_search="disabled"` — no web search.
     * `-` reads the prompt from stdin (the pipe the runner sets up).
     */
    build({ bin, prompt, model, cwd }) {
      const args = [
        'exec', '--json', '--sandbox', 'read-only', '--ephemeral',
        '--skip-git-repo-check',
        ...codexMcpOffArgs(bin, cwd),
        '-c', 'web_search="disabled"',
      ];
      if (model) args.push('-m', model);
      args.push('-');
      return { bin, args, env: { ...QUIET_ENV }, stdin: prompt };
    },
  },

  '4F': {
    agent: 'claude',
    name: 'Claude Code',
    build({ bin, prompt, model }) {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
      if (model) args.push('--model', model);
      // `--permission-prompts none` = refuse when nobody answers (rather than "hang and wait"). It
      // goes **before** `--allowedTools`: that switch takes variadic arguments and would swallow it
      // if placed later.
      args.push('--permission-prompts', 'none', '--tools', READ_TOOLS, '--allowedTools', READ_TOOLS);
      return { bin, args, env: { ...QUIET_ENV }, stdin: prompt };
    },
  },

  '6F': {
    agent: 'qoder',
    name: 'Qoder',
    /**
     * Qoder's headless `--print` mode: nobody is there to answer a permission prompt, and per Qoder's
     * docs any operation that would normally need a confirmation is **denied by default**. No
     * `--permission-mode` is passed on purpose —— the default (deny) is exactly the read-only posture the
     * council wants; passing `accept_edits` / `--yolo` would let the participant write.
     *
     * `--name SESSION_TITLE` stamps the same fixed title 7F/8F use, so the participant is recognizable in
     * Qoder's own session history. **Not yet verified on a real device** (the Qoder CLI is not installed
     * on the dev machine): whether its CLI transcript (scanned by 6F) also carries this name, and thus
     * whether the office keeps the participant out in workspace mode, still has to be confirmed on a
     * machine with Qoder installed. See docs/requirements.md §15.3.
     *
     * The prompt arrives over stdin (Qoder reads it when `-p` gets no argument).
     */
    build({ bin, prompt, model }) {
      const args = ['-p', '--output-format', 'json', '--name', SESSION_TITLE];
      if (model) args.push('-m', model);
      return { bin, args, env: { ...QUIET_ENV }, stdin: prompt };
    },
  },

  '7F': {
    agent: 'kilo',
    name: 'Kilo Code',
    // The prompt goes as a positional argument (kilo run <message>): neither of these reads stdin.
    // Our prompt always starts with our own template block and never begins with '-', so there is no
    // need to add a '--' separator (adding it risks yargs eating it as a separator, doing more harm
    // than good).
    build({ bin, prompt, model }) {
      const args = ['run', prompt, '--format', 'json', '--title', SESSION_TITLE];
      if (model) args.push('--model', model);
      return {
        bin,
        args,
        env: {
          KILO_CONFIG_CONTENT: JSON.stringify({
            plugin: [], // strip WorkGremlin's own reporting plugin (otherwise participants get reported into the office)
            permission: READ_PERMISSION,
          }),
          ...QUIET_ENV,
        },
        stdin: null,
      };
    },
  },

  '8F': {
    agent: 'opencode',
    name: 'OpenCode',
    build({ bin, prompt, model }) {
      const args = ['run', prompt, '--format', 'json', '--standalone', '--title', SESSION_TITLE];
      if (model) args.push('--model', model);
      return {
        bin,
        /**
         * `--standalone` runs with a **private server** instead of the user's long-lived
         * `opencode serve` daemon, and it is mandatory here for two reasons:
         *   1. the private server is a child of this process, so it inherits QUIET_ENV and the reporting
         *      plugin's `WORKGREMLIN_DISABLE` early-return actually fires. Without it the participant runs
         *      inside the shared daemon, where the plugin was loaded with the **user's own env** hours
         *      earlier —— the flag never reaches it and participants leak in as real 8F sessions / tasks /
         *      phases (measured 2026-10-18: exactly that happened).
         *   2. it also keeps the participant from touching (or being polluted by) the user's server.
         * OpenCode has no `plugin: []`-style config switch that would help here (unlike 7F Kilo): the shared
         * daemon ignores per-run config for plugins it already loaded.
         */
        args,
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: READ_PERMISSION }),
          ...QUIET_ENV,
        },
        stdin: null,
      };
    },
  },
};

/* ---------------------------------- Output parsing ---------------------------------- */

/** Dig the body text out of whatever field might hold it. CLIs differ; only observed shapes are recognized, unknown ones return '' */
function textOf(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) {
    return obj.map(textOf).filter(Boolean).join('\n');
  }
  if (typeof obj !== 'object') return '';
  // Codex `exec --json` wraps each event's payload in `item`. Only the agent's closing message is speech;
  // reading `item` generically would mistake reasoning / command_execution / error items (all of which
  // carry a text-ish field) for the answer, so recognize exactly the one shape that is the answer.
  if (obj.type === 'item.completed' && obj.item && typeof obj.item === 'object') {
    return obj.item.type === 'agent_message' && typeof obj.item.text === 'string' ? obj.item.text : '';
  }
  // Top-level error events (`{"type":"error","message":…}`) are logs, not speech: Codex and Cline both
  // emit them (reconnect notices, config warnings, auth failures) and the `message` field must never be
  // read as the answer. (Genuine results carry `type:'result'` / `type:'run_result'` / no `type` at all.)
  if (obj.type === 'error') return '';
  // Try keys in the order "most likely to be the body". `result` is claude/codebuddy's closing text;
  // `text` / `content` are fragments in kilo/opencode's event streams.
  //
  // `part` is **the shape opencode actually produced** (real-device smoke test, 2026-10-01):
  //   {"type":"text","sessionID":"...","part":{"type":"text","text":"body…"}}
  // The body is not at the top level, it is inside part. It is **singular** and not the same thing as
  // `parts` (plural) —— initially only `parts` was written from a guessed shape, so every 8F round came
  // back as "content could not be parsed" in real runs, while unit tests written against the same guess
  // were all green. Lesson: writing unit tests against a guessed wire format tests nothing.
  for (const key of ['result', 'text', 'content', 'message', 'parts', 'part', 'output']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') {
      const nested = textOf(v);
      if (nested) return nested;
    }
  }
  return '';
}

/** usage field names differ per product; normalize as far as possible; anything unavailable is null (**not 0**, per the iron rule) */
function tokensOf(obj) {
  const usage = (obj && (obj.usage || (obj.message && obj.message.usage) || obj.tokens)) || null;
  if (!usage || typeof usage !== 'object') return null;
  const num = (...keys) => {
    for (const k of keys) {
      const v = usage[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  const out = {
    input: num('input_tokens', 'prompt_tokens', 'input', 'inputTokens'),
    output: num('output_tokens', 'completion_tokens', 'output', 'outputTokens'),
    cacheRead: num('cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens', 'cached_input_tokens', 'cacheReadTokens'),
    cacheWrite: num('cache_creation_input_tokens', 'cache_write_tokens', 'cacheWriteTokens'),
  };
  // All four unavailable = this product gave no usage at all, so return null rather than an all-zero object
  return Object.values(out).some((v) => v != null) ? out : null;
}

/**
 * Best-effort model id. Each CLI uses a different field name; anything unrecognized stays null so the UI
 * shows "—" rather than a guessed model. This is display metadata only — never used for routing.
 */
function modelOf(obj) {
  if (obj == null) return null;
  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i -= 1) {
      const m = modelOf(obj[i]);
      if (m) return m;
    }
    return null;
  }
  if (typeof obj !== 'object') return null;
  for (const key of ['model', 'model_id', 'modelId', 'modelID', 'modelName', 'model_name']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const key of ['message', 'part', 'item', 'metadata', 'session']) {
    const v = obj[key];
    if (v && typeof v === 'object') {
      const m = modelOf(v);
      if (m) return m;
    }
  }
  return null;
}

/** Is this event an echo from "the user side" (the question itself / a system prompt). The body must never pick it up */
function isUserEcho(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.role === 'user') return true;
  const inner = e.part || e.message;
  return Boolean(inner && typeof inner === 'object' && inner.role === 'user');
}

/**
 * Pick "the part it actually said" out of a **full conversation transcript**.
 *
 * That is what 1F CodeBuddy `--output-format json` really gives (2026-10-01): an array recording the
 * whole path —— `user message → file-history-snapshot → reasoning → assistant message → result`.
 * Concatenating every content the old way makes **the question itself (including the memory system
 * prompt the CLI injects) pass as its speech**, and repeats the answer once more at the end —— so on
 * screen the first half of every speech card is our own prompt. In the measured run only the last 1KB
 * of a 16KB body was what it actually said.
 *
 * So only two things are accepted here, ordered by reliability:
 *   1. The `result` field of the closing event (both CodeBuddy and Claude Code provide it, and **it
 *      alone** is the final answer);
 *   2. Failing that, the output of the last assistant message.
 * Neither found → null: better to say "cannot parse" than to serve the prompt as if it were its words.
 *
 * @param {Array} list
 * @returns {{text:string, tokens:object|null}|null}
 */
function pickFromTranscript(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.result === 'string' && e.result.trim()) {
      return { text: e.result, tokens: tokensOf(e) };
    }
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (e && typeof e === 'object' && e.role === 'assistant') {
      const t = textOf(e);
      if (t) return { text: t, tokens: tokensOf(e) };
    }
  }
  return null;
}

/**
 * Parse the complete object prefix of a truncated transcript array.
 *
 * CodeBuddy occasionally exits 0 with a transcript such as `[{...},{...},{...` and no closing
 * bracket. The complete entries are still valid evidence, so parse those individually and ignore the
 * unfinished tail. A malformed complete entry stops the scan; later text is not trusted.
 *
 * @param {string} text
 * @returns {Array<object>|null}
 */
function parseTranscriptPrefix(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s.startsWith('[')) return null;

  const out = [];
  let i = 1;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i += 1;
    if (i >= s.length || s[i] === ']') break;
    if (s[i] !== '{') return out.length ? out : null;

    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let closed = false;
    for (; i < s.length; i += 1) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) break; // The trailing event was cut off; it is not usable evidence.

    try {
      const event = JSON.parse(s.slice(start, i));
      if (event && typeof event === 'object' && !Array.isArray(event)) out.push(event);
      else break;
    } catch {
      break;
    }
  }
  return out.length ? out : null;
}

/**
 * Parse the stdout of one invocation.
 *
 * Both shapes have to be consumed:
 *   · **A single JSON** (1F/4F's `--output-format json`, 6F Qoder's `--output-format json`) —— the whole
 *     stdout is one object (or one transcript array, see pickFromTranscript);
 *   · **A JSONL event stream** (7F/8F's `--format json`, 2F Cline's `--json`, 3F Codex's `exec --json`) ——
 *     one event per line, the body assembled from the lines that carry it.
 *
 * Approach: try it as one block of JSON first, then line by line. **Both failing = cannot parse**, in
 * which case the text stays empty and the raw stdout is carried back untouched (troubleshooting needs
 * it), never pretending that content was read.
 *
 * @param {string} stdout
 * @returns {{ok:boolean, text:string, tokens:object|null, model:string|null, events:number,
 *            truncated:boolean}}
 */
function parseOutput(stdout) {
  const raw = String(stdout == null ? '' : stdout);
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, text: '', tokens: null, model: null, events: 0, truncated: false };
  }

  // First as one block of JSON
  try {
    const one = JSON.parse(trimmed);
    if (Array.isArray(one)) {
      // A whole array = a full transcript; take only the part it said (see pickFromTranscript)
      const got = pickFromTranscript(one);
      const model = modelOf(one);
      if (got) {
        return {
          ok: true,
          text: got.text,
          tokens: got.tokens,
          model,
          events: one.length,
          truncated: false,
        };
      }
      return { ok: false, text: '', tokens: null, model, events: one.length, truncated: false };
    }
    const text = textOf(one);
    if (text) {
      return {
        ok: true,
        text,
        tokens: tokensOf(one),
        model: modelOf(one),
        events: 1,
        truncated: false,
      };
    }
  } catch {
    /* not a single JSON, fall through to JSONL */
  }

  // A transcript cut off before its closing `]` is still usable up to the last complete event.
  const prefix = parseTranscriptPrefix(trimmed);
  if (prefix) {
    const got = pickFromTranscript(prefix);
    const model = modelOf(prefix);
    if (got) {
      return {
        ok: true,
        text: got.text,
        tokens: got.tokens,
        model,
        events: prefix.length,
        truncated: true,
      };
    }
    return {
      ok: false,
      text: '',
      tokens: null,
      model,
      events: prefix.length,
      truncated: true,
    };
  }

  // Then as JSONL: parse line by line, concatenate body pieces in order of appearance, take usage from
  // the **last** non-empty occurrence (usage usually hangs off the closing line in a stream; summing
  // would double-count across retries)
  let events = 0;
  const parts = [];
  let tokens = null;
  let model = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // one broken line does not mean the whole stream is broken (CLIs mix logs into stdout)
    }
    events += 1;
    // Streams can carry user messages (prompt echoes): skip them, do not take the question as its speech
    if (isUserEcho(obj)) continue;
    const t = textOf(obj);
    if (t) parts.push(t);
    const tk = tokensOf(obj);
    if (tk) tokens = tk;
    const m = modelOf(obj);
    if (m) model = m;
  }
  if (events > 0 && parts.length) {
    return { ok: true, text: parts.join('\n'), tokens, model, events, truncated: false };
  }
  // Events present but not a single line of body read —— that also counts as "cannot parse" (maybe all
  // status events, or the field names changed again)
  return { ok: false, text: '', tokens: tokens || null, model, events, truncated: false };
}

module.exports = {
  RECIPES,
  READ_PERMISSION,
  READ_TOOLS,
  QUIET_ENV,
  codexMcpArgs,
  codexMcpOffArgs,
  parseOutput,
};
