'use strict';

/**
 * Static subagent metadata engine (product-agnostic).
 *
 * The render layer is a sandbox (it cannot read the file system), so both "is this member a
 * user-level or a project-level subagent" and "what does it do" have to be read by the server and
 * shipped with the member card. The criteria match CodeBuddy / Codex / Claude / Cline:
 *   · project level: <workspacePath>/<dot directory>/agents/<name>.(md|toml|yaml|yml)
 *   · user level:    <home directory>/<dot directory>/agents/<name>.(md|toml|yaml|yml)
 * In neither place -> level null (an ordinary member / demo data, wearing no level badge) and an
 * empty description.
 *
 * This file **does not know any specific product**: it only walks "a set of candidate directories
 * given by the caller" to find agent definition files, read their description, and determine the
 * level. Where each floor keeps its own static subagents is declared by that floor's
 * `agentDirs(workspacePath)` (see server/src/floor<X>.js), and floors.js aggregates the floors'
 * directories into a unified interface —— exactly the principle of pushing "find the static
 * subagent" from the central agentLevel down into the floors (same thinking as floor-ifying
 * refresh: the center does generic dispatch + aggregation, product knowledge lives in floor files).
 *
 * A directory entry may carry per-floor options:
 *   · `recursive`     — nested definitions are allowed; the agent ID keeps the relative path
 *                       (`agents/team/reviewer.md` → `team/reviewer`)
 *   · `onlySubagents` — read the definition's `mode` and skip `mode: primary` agents
 *   · `defaultMode`   — the mode to assume when the file has no `mode` (e.g. OpenCode V2 treats
 *                       both `agents/` and `agent/` as primary unless a definition says otherwise)
 *   · `primaryOnly`   — claim the name (shadowing lower-priority dirs) but never expose the agent
 *
 * The functional description is **static data** from the agent definition file ("what this
 * subagent is for"), not runtime state —— that is what belongs on the card, rather than state
 * phrasing like "project subagent · idle".
 *
 * Results are cached by "name + workspacePath + candidate dirs" / file mtime (agent definitions
 * rarely change within a session).
 */

const fs = require('node:fs');
const path = require('node:path');
const { isFile } = require('../roots');

/**
 * Resolve an agent definition file. The direct candidates cover the documented lowercase names; the
 * final directory scan keeps the lookup consistent with `listAgentFiles`, whose extension match is
 * case-insensitive (a file such as `NAME.MD` must still yield its `mode` on case-sensitive systems).
 */
function fileOf(dir, name) {
  const base = String(name || '').trim();
  if (!base) return '';
  const cands = [
    `${base}.md`,
    `${base.toLowerCase()}.md`,
    `${base}.toml`,
    `${base.toLowerCase()}.toml`,
    `${base}.yaml`,
    `${base.toLowerCase()}.yaml`,
    `${base}.yml`,
    `${base.toLowerCase()}.yml`,
  ];
  for (const f of cands) {
    const p = path.join(dir, f);
    try {
      if (isFile(p)) return p;
    } catch {
      /* try the next candidate */
    }
  }
  const nested = path.dirname(base);
  const leaf = path.basename(base);
  const scanDir = nested === '.' ? dir : path.join(dir, nested);
  try {
    const hit = fs.readdirSync(scanDir).find((f) => {
      if (!/\.(md|toml|ya?ml)$/i.test(f)) return false;
      return f.slice(0, f.lastIndexOf('.')).toLowerCase() === leaf.toLowerCase();
    });
    if (hit) return path.join(scanDir, hit);
  } catch {
    /* directory unreadable -> no definition */
  }
  return '';
}

/**
 * Find this subagent's agent definition file among a set of candidate directories (project level
 * first, then user level). Order is priority: return the first one that exists.
 * @param {string} name
 * @param {Array<{dir: string, level: 'project'|'user'}>} dirs
 * @returns {{ path: string, level: 'project'|'user' }|null}
 */
function findAgentFile(name, dirs) {
  for (const { dir, level } of dirs || []) {
    const p = fileOf(dir, name);
    if (p) return { path: p, level };
  }
  return null;
}

/**
 * List the agent file names in a directory (stripping the definition suffix); empty when the directory
 * cannot be read. With `opts.recursive`, nested definitions are returned as relative IDs with
 * forward slashes (`team/reviewer`), matching the path-derived agent ID convention.
 * @param {string} dir
 * @param {{recursive?: boolean}} [opts]
 * @returns {string[]}
 */
function listAgentFiles(dir, opts) {
  const out = [];
  const seen = new Set();
  const visitedDirs = new Set();
  const recursive = Boolean(opts && opts.recursive);
  const walk = (base, prefix) => {
    // OpenCode scans with `symlink: true`, so directory symlinks are part of the agent tree. Resolve
    // the real path and walk each real directory once; this follows links without looping on cycles.
    let real;
    try {
      real = fs.realpathSync(base);
    } catch {
      return;
    }
    if (visitedDirs.has(real)) return;
    visitedDirs.add(real);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(base, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // dangling link
        }
      }
      if (isDir) {
        if (recursive) walk(full, `${prefix}${ent.name}/`);
        continue;
      }
      if (!isFile) continue;
      if (!/\.(md|toml|ya?ml)$/i.test(ent.name)) continue;
      const name = `${prefix}${ent.name.replace(/\.(md|toml|ya?ml)$/i, '')}`;
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  };
  walk(dir, '');
  return out;
}

const modeCache = new Map(); // file path -> { mtimeMs, size, value }

/**
 * Read an agent definition's `mode` (`subagent` / `all` / `primary`); empty string when the file has
 * no mode or cannot be read. TOML reads `mode = "…"`; Markdown only reads its frontmatter; YAML reads
 * the whole document because it has no frontmatter fence.
 * @param {string} file
 * @returns {'primary'|'subagent'|'all'|''}
 */
function readAgentMode(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return '';
  }
  const prev = modeCache.get(file);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev.value;
  let txt = '';
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  let mode = '';
  if (/\.toml$/i.test(file)) {
    const m = txt.match(/^\s*mode\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
    mode = String(m ? m[1] ?? m[2] ?? m[3] ?? '' : '').trim().toLowerCase();
  } else {
    const fm = txt.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
    // A Markdown body is prose: a `mode:` line in it is not configuration. Only the frontmatter counts.
    const head = fm ? fm[1] : /\.md$/i.test(file) ? '' : txt;
    const m = head.match(/^\s*mode\s*:\s*['"]?([A-Za-z-]+)['"]?\s*(?:#.*)?$/m);
    mode = String(m ? m[1] : '').trim().toLowerCase();
  }
  const value = mode === 'primary' || mode === 'subagent' || mode === 'all' ? mode : '';
  modeCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/**
 * Drop the trailing English trigger note aimed at the model —— "(use PROACTIVELY …)".
 * An agent definition's description exists to route the LLM and often ends with that sentence;
 * what belongs on the card is "what it can do" —— the tail is noise. Only a closing parenthesis
 * clause containing `use PROACTIVELY` is trimmed —— every other parenthesis (English ones too)
 * is left alone.
 */
function cleanDescription(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) s = s.slice(1, -1).trim();
  s = s.replace(/[（(][^（()）]*use\s+PROACTIVELY[^（()）]*[)）][。.！!]?\s*$/i, '').trim();
  return s;
}

/**
 * Read the description from an agent definition file. Markdown reads its YAML frontmatter, TOML reads
 * `description = …`, and YAML/YML use the same `description:` line (with or without frontmatter fences).
 */
function readDescription(file) {
  let txt = '';
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  if (/\.toml$/i.test(file)) {
    const m = txt.match(/^\s*description\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m);
    return cleanDescription(m ? m[1] ?? m[2] ?? '' : '');
  }
  // .md: only look at the frontmatter block at the top (without --- wrappers, use the whole file head)
  const fm = txt.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  const head = fm ? fm[1] : txt;
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*description\s*:/.test(l));
  if (at < 0) return '';
  const inline = lines[at].replace(/^\s*description\s*:\s*/, '').trim();
  // Block scalar (description: > / |): fold the following indented lines into one
  if (/^[>|][+-]?$/.test(inline)) {
    const out = [];
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) {
        if (out.length) out.push('');
        continue;
      }
      if (!/^\s/.test(line)) break; // back to column 0 = description ended
      out.push(line.trim());
    }
    return cleanDescription(out.join(' '));
  }
  return cleanDescription(inline);
}

const levelCache = new Map(); // "name workspacePath" -> level

/**
 * Determine the level (project / user) from the given directories. null when unavailable.
 * Cached by name+workspacePath.
 * @param {string} name
 * @param {string} workspacePath
 * @param {Array<{dir:string, level:'project'|'user'}>} dirs order is priority
 * @returns {'project'|'user'|null}
 */
function detectLevelInDirs(name, workspacePath, dirs) {
  const ws = String(workspacePath || '').trim();
  // Include the candidate dirs: two floors (or two config roots) may define the same agent name.
  const key = `${name} ${ws} ${(dirs || []).map((d) => d.dir).join('|')}`;
  if (levelCache.has(key)) return levelCache.get(key);
  const hit = findAgentFile(name, dirs);
  const level = hit ? hit.level : null;
  levelCache.set(key, level);
  return level;
}

const descCache = new Map(); // file path -> { mtimeMs, size, value }

/**
 * A subagent's functional description (static data, from its agent definition file). Empty string
 * when unavailable —— the render layer hides that field accordingly, instead of substituting state
 * phrasing like "project subagent · idle".
 * @param {string} name subagent name (the member name, e.g. leo)
 * @param {string} workspacePath project path (project-level agents are looked for here)
 * @param {Array<{dir:string, level:'project'|'user'}>} dirs candidate directories (order is priority)
 */
function descriptionInDirs(name, workspacePath, dirs) {
  const hit = findAgentFile(name, dirs);
  if (!hit) return '';
  let st = null;
  try {
    st = fs.statSync(hit.path);
  } catch {
    return '';
  }
  const prev = descCache.get(hit.path);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev.value;
  const value = readDescription(hit.path);
  descCache.set(hit.path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/**
 * Generic: derive project-level / user-level agent directories from an "agent home directory list".
 *   · project level = <workspacePath>/<home directory basename>/agents
 *   · user level    = <home directory>/agents
 * Floors whose data does not follow this rule (e.g. Codex honoring CODEX_HOME, Claude honoring
 * CLAUDE_CONFIG_DIR, or subagents that are not single files but embedded elsewhere) can simply
 * give explicit directories / custom logic in their own `agentDirs` instead of going through here.
 * @param {string[]} homeDirs agent home directories (e.g. [path.join(HOME, '.codebuddy')])
 * @param {string} workspacePath
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
function genericAgentDirs(homeDirs, workspacePath) {
  const ws = String(workspacePath || '').trim();
  const root = ws ? path.resolve(ws) : '';
  const out = /** @type {{dir: string, level: 'project'|'user'}[]} */ ([]);
  for (const h of homeDirs || []) {
    const home = String(h);
    if (root) out.push({ dir: path.join(root, path.basename(home), 'agents'), level: 'project' });
    out.push({ dir: path.join(home, 'agents'), level: 'user' });
  }
  return out;
}

/**
 * List the agents defined in a set of candidate dirs (project dirs first — the caller's `agentDirs`
 * already orders them that way). Cross-dir duplicates keep the first hit (project beats user).
 * Entries with `onlySubagents` skip definitions whose effective mode is `primary`; `defaultMode`
 * supplies the mode for files that do not declare one. Entries with `primaryOnly` claim their names
 * but are never returned.
 * @param {Array<{dir: string, level: 'project'|'user', recursive?: boolean,
 *                onlySubagents?: boolean, defaultMode?: 'primary'|'subagent'|'all',
 *                primaryOnly?: boolean}>} dirs
 * @returns {Array<{name: string, level: 'project'|'user'}>}
 */
function listAgentsInDirs(dirs) {
  const claimed = new Set();
  const out = [];
  for (const entry of dirs || []) {
    const { dir, level } = entry;
    for (const n of listAgentFiles(dir, entry)) {
      // Decide ownership before looking at `mode`: a higher-priority definition shadows lower-priority
      // ones even when it is a primary agent. Otherwise a lower-priority subagent would resurrect an
      // agent that the winner (and its description / level lookup) says is not a subagent at all.
      if (claimed.has(n)) continue;
      claimed.add(n);
      if (entry.primaryOnly) continue;
      if (entry.onlySubagents) {
        const file = fileOf(dir, n);
        const mode = (file && readAgentMode(file)) || entry.defaultMode || 'subagent';
        if (mode === 'primary') continue;
      }
      out.push({ name: n, level });
    }
  }
  return out;
}

/**
 * Build a floor's `syncAgents(ctx)` from its own `agentDirs(workspacePath)` + client.
 *
 * The floor owns its scan: this closes over the floor's dirs, diffs the current set against what the
 * floor registered last time **for that project**, and calls the upper layer's `registerAgent` /
 * `unregisterAgent` for the changes. So the server walks the floor registry and the floor decides
 * what "its own user-level / project-level agents" are — no product knowledge in the central code.
 *
 * @param {(workspacePath?: string) => Array<{dir: string, level: 'project'|'user'}>} agentDirs
 * @param {string} client floor base name (kilo / codebuddy / …)
 * @returns {(ctx: { project: string, projectName?: string, workspacePath?: string,
 *                   registerAgent: (a: {name:string, level:string, client:string}) => void,
 *                   unregisterAgent: (name: string) => void }) => void}
 */
function makeAgentSync(agentDirs, client) {
  const lastByProject = new Map(); // project -> Set(agent name)
  return function syncAgents(ctx) {
    const { project, workspacePath, registerAgent, unregisterAgent } = ctx || {};
    if (typeof registerAgent !== 'function' || typeof unregisterAgent !== 'function') return;
    const list = listAgentsInDirs(typeof agentDirs === 'function' ? agentDirs(workspacePath) : []);
    const nowNames = new Set(list.map((a) => a.name));
    const prev = lastByProject.get(project) || new Set();
    for (const a of list) registerAgent({ name: a.name, level: a.level, client });
    for (const n of prev) if (!nowNames.has(n)) unregisterAgent(n);
    lastByProject.set(project, nowNames);
  };
}

function clearCache() {
  levelCache.clear();
  descCache.clear();
  modeCache.clear();
}

module.exports = {
  fileOf,
  findAgentFile,
  listAgentFiles,
  readDescription,
  cleanDescription,
  readAgentMode,
  detectLevelInDirs,
  descriptionInDirs,
  genericAgentDirs,
  listAgentsInDirs,
  makeAgentSync,
  clearCache,
};
