'use strict';

/**
 * The **command-line recipes** for the four agents —— the only place in the council room that
 * touches each CLI's details.
 *
 * Every recipe records three things: how to hand the prompt over, **how to guarantee it has no
 * tools**, and how to read what it spits out as "speech + vote". The first two are the focus here,
 * and each floor below documents how that was verified (measured locally on 2026-10-01).
 *
 * About "read-only, no tools" (the criterion the user set, and the prerequisite for entering the
 * council room):
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

const { DEFAULTS } = require('@workgremlin/shared');

/**
 * Turn off WorkGremlin's **own** reporting —— injected by every recipe, in both modes.
 *
 * Why it is mandatory: isolated mode gets by with cwd in /tmp (the project path a participant
 * reports is that temp directory, invisible to the office). **In project mode cwd is the user's real
 * project**, and the reporting hooks installed in `~/.claude/settings.json` /
 * `~/.codebuddy/settings.json` would report with the real project path —— the participant would turn
 * into "one of the members in your project", a direct violation of "visible only in the council
 * room". So stop relying on cwd and explicitly disable reporting instead: the hook
 * (packages/reporter/src/hook.js) and the plugin (packages/reporter/src/plugin/index.js) both honor
 * this flag and exit in place when they see it.
 */
const QUIET_ENV = Object.freeze({ WORKGREMLIN_DISABLE: '1' });

/**
 * Fixed session title for 7F / 8F participants —— unlike 1F/4F these two have no "do not persist"
 * switch, so sessions are always recorded in their **global** SQLite (`session.directory` = the cwd
 * at the time). In isolated mode cwd is under /tmp and the office filters it out by project; in
 * project mode cwd is the user's project, and unguarded participants would show up directly on the
 * office's 7F/8F. The guard is "give it a fixed title", which server/src/kilo.js and
 * server/src/opencode.js skip when listing sessions —— reasoning and trade-offs are written on
 * COUNCIL_SESSION_TITLE in shared/index.js.
 */
const SESSION_TITLE = DEFAULTS.COUNCIL_SESSION_TITLE;

/** The 7F / 8F permission tables have to be spelled out item by item (`*` is the catch-all; listing the rest keeps it readable and easy to assert) */
const PERMISSION_KEYS = Object.freeze([
  'bash', 'edit', 'write', 'read', 'glob', 'grep', 'list',
  'webfetch', 'websearch', 'task', 'skill', 'todowrite', 'external_directory',
]);

/** Permission lockdown shared by 7F / 8F: deny every tool category —— used by isolated mode */
const DENY_ALL_PERMISSION = Object.freeze(
  Object.fromEntries([['*', 'deny'], ...PERMISSION_KEYS.map((k) => [k, 'deny'])])
);

/**
 * Permission table handed to 7F / 8F in project mode (allow='read'): **only** read-type tools are
 * allowed, everything else stays denied.
 *
 * 7F Kilo / 8F OpenCode have no `--tools` switch like 1F/4F (`kilo --pure` only disables external
 * plugins, nothing to do with tools), so "read-only" can only be achieved by feeding this config.
 * Two entries **must** stay denied:
 *   · `bash` / `write` / `edit` —— participants may not modify the user's code nor run commands on
 *     his machine;
 *   · `external_directory` —— project mode allows looking inside the project only. Its default is
 *     ask, and since nobody answers council participants' permission prompts, ask turns into "stuck
 *     until timeout"; writing deny explicitly is deterministic behavior.
 */
const READ_PERMISSION = Object.freeze(
  Object.fromEntries([
    ['*', 'deny'],
    ...PERMISSION_KEYS.map((k) => [k, ['read', 'glob', 'grep', 'list'].includes(k) ? 'allow' : 'deny']),
  ])
);

/** @param {string} allow 'none' (default, isolated mode's "no tools") or 'read' (project mode's read-only tools) */
function permissionFor(allow) {
  return allow === 'read' ? READ_PERMISSION : DENY_ALL_PERMISSION;
}

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
 * One recipe per floor.
 *
 * build({ bin, prompt, allow }) → { bin, args, env, stdin }
 *   · `allow` = 'none' (default) | 'read' —— see READ_TOOLS / READ_PERMISSION above.
 *     **Both values must either block tools entirely or narrow them to read-only**; there is no
 *     halfway state.
 *   · env is **layered on top of** process.env (not a replacement) —— each CLI's login credentials
 *     live in ~/.claude, ~/.config/kilo, etc. and are found via HOME. Blocking HOME blocks the login,
 *     so isolation relies on cwd + tool narrowing + QUIET_ENV, not on rewriting environment variables.
 *   · When stdin is not null the prompt travels through a pipe (not argv): long text never hits
 *     ARG_MAX and never shows up in `ps` output for other processes on the machine.
 *
 * Both 1F and 4F carry `--no-session-persistence` (documented in both help texts, valid under
 * `--print` only): participant conversations are **not persisted**. In project mode this flag is an
 * isolation necessity —— persisted, each CLI records participants under **the user's real project
 * path** into its own history (`~/.claude/projects/<project>/`), and the global session list grows a
 * few "active sessions in your project". Isolated mode benefits too: no more `tmp-wg-council-*`
 * one-off project leftovers.
 *
 * `--strict-mcp-config` without `--mcp-config`: do not load MCP servers from the user config.
 * `--tools ""` governs the **built-in** tool set, and MCP tools are not part of it —— leaving that
 * open makes "a participant with no tools" a false statement (for context: this tightens existing
 * behavior, it is not a newly opened hole).
 */
const RECIPES = {
  '1F': {
    agent: 'codebuddy',
    name: 'CodeBuddy',
    // Measured: `-p` with no message reads the pipe (help text: "useful for pipes")
    build({ bin, prompt, allow }) {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
      if (allow === 'read') args.push('--tools', READ_TOOLS, '--allowedTools', READ_TOOLS);
      else args.push('--tools', '');
      return { bin, args, env: { ...QUIET_ENV }, stdin: prompt };
    },
  },

  '4F': {
    agent: 'claude',
    name: 'Claude Code',
    build({ bin, prompt, allow }) {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
      if (allow === 'read') {
        // `--permission-prompts none` = refuse when nobody answers (rather than "hang and wait"). It
        // goes **before** `--allowedTools`: that switch takes variadic arguments and would swallow it
        // if placed later.
        args.push('--permission-prompts', 'none', '--tools', READ_TOOLS, '--allowedTools', READ_TOOLS);
      } else {
        args.push('--tools', '');
      }
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
    build({ bin, prompt, allow }) {
      return {
        bin,
        args: ['run', prompt, '--format', 'json', '--title', SESSION_TITLE],
        env: {
          KILO_CONFIG_CONTENT: JSON.stringify({
            plugin: [], // strip WorkGremlin's own reporting plugin (otherwise participants get reported into the office)
            permission: permissionFor(allow),
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
    build({ bin, prompt, allow }) {
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
        args: ['run', prompt, '--format', 'json', '--standalone', '--title', SESSION_TITLE],
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: permissionFor(allow) }),
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
    input: num('input_tokens', 'prompt_tokens', 'input'),
    output: num('output_tokens', 'completion_tokens', 'output'),
    cacheRead: num('cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens'),
    cacheWrite: num('cache_creation_input_tokens', 'cache_write_tokens'),
  };
  // All four unavailable = this product gave no usage at all, so return null rather than an all-zero object
  return Object.values(out).some((v) => v != null) ? out : null;
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
 * Parse the stdout of one invocation.
 *
 * Both shapes have to be consumed:
 *   · **A single JSON** (1F/4F's `--output-format json`) —— the whole stdout is one object;
 *   · **A JSONL event stream** (7F/8F's `--format json`) —— one event per line, the body assembled
 *     from several lines.
 *
 * Approach: try it as one block of JSON first, then line by line. **Both failing = cannot parse**, in
 * which case the text stays empty and the raw stdout is carried back untouched (troubleshooting needs
 * it), never pretending that content was read.
 *
 * @param {string} stdout
 * @returns {{ok:boolean, text:string, tokens:object|null, events:number}}
 */
function parseOutput(stdout) {
  const raw = String(stdout == null ? '' : stdout);
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, text: '', tokens: null, events: 0 };

  // First as one block of JSON
  try {
    const one = JSON.parse(trimmed);
    if (Array.isArray(one)) {
      // A whole array = a full transcript; take only the part it said (see pickFromTranscript)
      const got = pickFromTranscript(one);
      if (got) return { ok: true, text: got.text, tokens: got.tokens, events: one.length };
      return { ok: false, text: '', tokens: null, events: one.length };
    }
    const text = textOf(one);
    if (text) return { ok: true, text, tokens: tokensOf(one), events: 1 };
  } catch {
    /* not a single JSON, fall through to JSONL */
  }

  // Then as JSONL: parse line by line, concatenate body pieces in order of appearance, take usage from
  // the **last** non-empty occurrence (usage usually hangs off the closing line in a stream; summing
  // would double-count across retries)
  let events = 0;
  const parts = [];
  let tokens = null;
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
  }
  if (events > 0 && parts.length) return { ok: true, text: parts.join('\n'), tokens, events };
  // Events present but not a single line of body read —— that also counts as "cannot parse" (maybe all
  // status events, or the field names changed again)
  return { ok: false, text: '', tokens: tokens || null, events };
}

/* ---------------------------------- Vote parsing ---------------------------------- */

/**
 * Participants must attach a structured vote at the end of their speech. Agreed shape (pinned down in
 * the prompt):
 *
 * ```json
 * {"vote":"agree|disagree|abstain","reason":"one sentence","proposal":"(a revision when voting disagree)","second":"4F"}
 * ```
 *
 * Parsing strategy (lenient in, strict out):
 *   1. Find the **last** ```json fenced block (models love giving examples mid-text; the last block is
 *      their conclusion);
 *   2. With no fence, look for the last {...} fragment containing `"vote"` in the whole text;
 *   3. Failing that, accept a line like `VOTE: agree`;
 *   4. Nothing recognizable → return vote=null (**no position expressed**), never guess from tone.
 *
 * @param {string} text
 * @returns {{vote:string|null, reason:string|null, proposal:string|null, second:string|null}}
 */
function parseVoteBlock(text) {
  const empty = { vote: null, reason: null, proposal: null, second: null };
  const s = String(text == null ? '' : text);
  if (!s.trim()) return empty;

  const obj = lastJsonBlock(s, (o) => 'vote' in o);
  if (obj) {
    const vote = normalizeVoteToken(obj.vote);
    if (vote) {
      return {
        vote,
        reason: strOrNull(obj.reason),
        // Revisions are accepted as-is (the prompt only requires disagreeing votes to include one, but
        // agreeing while attaching a version keeps it too —— picking next round's proposal follows
        // consensus.js's rules, no selection is made here)
        proposal: strOrNull(obj.proposal),
        second: strOrNull(obj.second || obj.second_floor || obj.endorse),
      };
    }
  }

  // Fallback: a line like `VOTE: agree` / `立场：反对`
  const line = s.match(/(?:^|\n)\s*(?:VOTE|立场|投票)\s*[:：]\s*([^\n]{1,40})/i);
  if (line) {
    const vote = normalizeVoteToken(line[1]);
    if (vote) return { vote, reason: null, proposal: null, second: null };
  }
  return empty;
}

/** The vote vocabulary stays in one set with council/consensus.js (that is the authority; this only normalizes the same way) */
function normalizeVoteToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(abstain|neutral|none|弃权|中立|不表态|无所谓)$/.test(s)) return 'abstain';
  if (/^(agree|yes|approve|accept|同意|赞成|支持|通过)$/.test(s)) return 'agree';
  if (/^(disagree|no|reject|oppose|反对|不同意|否决)$/.test(s)) return 'disagree';
  return null;
}

function strOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/* ---------------------------------- Analysis parsing ---------------------------------- */

/**
 * The structured tail block for analysis mode. Agreed shape (pinned down in the prompt, see
 * ANALYSIS_PROTOCOL in prompt.js):
 *
 * ```json
 * {"stance":"support|oppose|unsure","points":[…],"risks":[…],"questions":[…]}
 * ```
 *
 * Two rules shared with vote parsing:
 *   · Leave null when unrecognized —— a `stance` that cannot be read after all is "no position
 *     expressed", never guessed from tone;
 *   · `findings` being null and being an empty object are **not the same thing**: null = the whole
 *     tail block failed to parse, `{points:[],risks:[],questions:[]}` = it answered, just with all
 *     three empty. The UI renders those two differently.
 *
 * @param {string} text
 * @returns {{stance:string|null, findings:{points:string[],risks:string[],questions:string[]}|null}}
 */
function parseAnalysisBlock(text) {
  const empty = { stance: null, findings: null };
  const s = String(text == null ? '' : text);
  if (!s.trim()) return empty;
  const obj = lastJsonBlock(
    s,
    (o) => 'stance' in o || 'points' in o || 'risks' in o || 'questions' in o
  );
  if (!obj) return empty;
  return { stance: normalizeStanceToken(obj.stance), findings: findingsOf(obj) };
}

/** Stance vocabulary. Same normalization approach as normalizeVoteToken: recognized ones normalize, unknown ones return null */
function normalizeStanceToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(support|yes|pro|for|agree|赞成|支持|可行|同意)$/.test(s)) return 'support';
  if (/^(oppose|no|against|con|disagree|反对|不可行|不同意)$/.test(s)) return 'oppose';
  if (/^(unsure|unknown|maybe|unclear|不确定|存疑|拿不准|说不准|待定)$/.test(s)) return 'unsure';
  return null;
}

/**
 * The three list fields. **None provided** (or not arrays) → null (= failed to parse); once any one of
 * them is an array, return an object with all three keys (the missing ones being empty arrays).
 * Only non-empty strings are accepted as elements —— models occasionally slip in a `{"point":"…"}`,
 * which is not the shape we want, so drop it.
 */
function findingsOf(obj) {
  const listOf = (v) =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
  if (!['points', 'risks', 'questions'].some((k) => Array.isArray(obj[k]))) return null;
  return { points: listOf(obj.points), risks: listOf(obj.risks), questions: listOf(obj.questions) };
}

/**
 * Find the **last** JSON object satisfying the predicate in a piece of text.
 * Try ```json fences first (from the back), then fall back to scanning the whole text for balanced
 * braces. Vote blocks and analysis blocks share this machinery (different predicates: one recognizes
 * `vote`, the other `stance`/`points`).
 *
 * @param {string} s
 * @param {(obj:object)=>boolean} ok
 */
function lastJsonBlock(s, ok) {
  const fenced = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const obj = tryParseJsonObject(fenced[i], ok);
    if (obj) return obj;
  }
  // No fence: walk back from every '{' with brace matching, take the last one satisfying the predicate
  for (let i = s.lastIndexOf('{'); i >= 0; i = s.lastIndexOf('{', i - 1)) {
    const obj = tryParseJsonObject(extractBalanced(s, i), ok);
    if (obj) return obj;
    if (i === 0) break;
  }
  return null;
}

function tryParseJsonObject(chunk, ok) {
  if (!chunk) return null;
  try {
    const obj = JSON.parse(chunk.trim());
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && ok(obj)) return obj;
  } catch {
    /* cannot parse it, try the next candidate */
  }
  return null;
}

/** From s[from]=='{', take a brace-balanced slice (braces inside strings are skipped) */
function extractBalanced(s, from) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i += 1) {
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
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  return '';
}

module.exports = {
  RECIPES,
  DENY_ALL_PERMISSION,
  READ_PERMISSION,
  READ_TOOLS,
  QUIET_ENV,
  parseOutput,
  parseVoteBlock,
  normalizeVoteToken,
  parseAnalysisBlock,
  normalizeStanceToken,
};
