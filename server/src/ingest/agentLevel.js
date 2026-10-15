'use strict';

/**
 * Static subagent metadata engine (product-agnostic).
 *
 * The render layer is a sandbox (it cannot read the file system), so both "is this member a
 * user-level or a project-level subagent" and "what does it do" have to be read by the server and
 * shipped with the member card. The criteria match CodeBuddy / Codex / Claude:
 *   · project level: <workspacePath>/<dot directory>/agents/<name>.(md|toml)
 *   · user level:    <home directory>/<dot directory>/agents/<name>.(md|toml)
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
 * The functional description is **static data** from the agent definition file ("what this
 * subagent is for"), not runtime state —— that is what belongs on the card, rather than state
 * phrasing like "project subagent · idle".
 *
 * Results are cached by "name + workspacePath" / file mtime (agent definitions rarely change
 * within a session).
 */

const fs = require('node:fs');
const path = require('node:path');
const { isFile } = require('../roots');

/** Filename case tolerance: the docs ask for lowercase hyphenated names, but try both just in case */
function fileOf(dir, name) {
  const base = String(name || '').trim();
  if (!base) return '';
  const cands = [`${base}.md`, `${base.toLowerCase()}.md`, `${base}.toml`, `${base.toLowerCase()}.toml`];
  for (const f of cands) {
    const p = path.join(dir, f);
    try {
      if (isFile(p)) return p;
    } catch {
      /* try the next candidate */
    }
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

/** List the agent file names in a directory (stripping the .md/.toml suffix); empty when the directory cannot be read */
function listAgentFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(md|toml)$/i.test(f))
      .map((f) => f.replace(/\.(md|toml)$/i, ''));
  } catch {
    return [];
  }
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

/** Read the description from an agent definition file (.md reads YAML frontmatter, .toml reads `description = …`) */
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
  const key = `${name} ${ws}`;
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
 * @param {string} workspacePath current project path (project-level agents are looked for here)
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
 * @param {Array<{dir: string, level: 'project'|'user'}>} dirs
 * @returns {Array<{name: string, level: 'project'|'user'}>}
 */
function listAgentsInDirs(dirs) {
  const seen = new Map();
  for (const { dir, level } of dirs || []) {
    for (const n of listAgentFiles(dir)) {
      if (!seen.has(n)) seen.set(n, { name: n, level });
    }
  }
  return [...seen.values()];
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
}

module.exports = {
  fileOf,
  findAgentFile,
  listAgentFiles,
  readDescription,
  cleanDescription,
  detectLevelInDirs,
  descriptionInDirs,
  genericAgentDirs,
  listAgentsInDirs,
  makeAgentSync,
  clearCache,
};
