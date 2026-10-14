'use strict';

/**
 * 静态 subagent 元信息引擎（产品无关）。
 *
 * 渲染层是沙箱（读不了文件系统），所以"这个成员是用户级还是项目级 subagent"与"它是干什么的"
 * 都必须由服务端读出来、随成员卡下发。判定口径与 CodeBuddy / Codex / Claude 一致：
 *   · 项目级：<workspacePath>/<点目录>/agents/<name>.(md|toml)
 *   · 用户级：<家目录>/<点目录>/agents/<name>.(md|toml)
 * 都不在 -> 级别 null（普通成员 / 演示数据，不戴级别牌）、描述空串。
 *
 * 本文件**不认识任何具体产品**：它只按"调用方给的一组候选目录"去找 agent 定义文件、读描述、
 * 判级别。各楼层在哪放自己的静态 subagent，由各自的 `agentDirs(workspacePath)` 声明
 * （见 server/src/floor<X>.js），floors.js 负责把各楼层的目录聚合成统一接口 —— 这正是把
 * "找静态 subagent"从中央 agentLevel 下放到楼层的原则（与 refresh 的楼层化同思路：
 * 中央只做通用派发 + 聚合，产品知识全在楼层文件里）。
 *
 * 功能描述是 agent 定义文件里的**静态数据**（"这个子代理是干什么的"），不是运行状态 ——
 * 卡片上要显示的是它，而不是"项目子代理 · 空闲"这种状态话术。
 *
 * 结果按 "name + workspacePath" / 文件 mtime 缓存（agent 定义一个会话内很少变）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { isFile } = require('../roots');

/** 文件名大小写兼容：文档要求小写连字符，但保险起见两种都试 */
function fileOf(dir, name) {
  const base = String(name || '').trim();
  if (!base) return '';
  const cands = [`${base}.md`, `${base.toLowerCase()}.md`, `${base}.toml`, `${base.toLowerCase()}.toml`];
  for (const f of cands) {
    const p = path.join(dir, f);
    try {
      if (isFile(p)) return p;
    } catch {
      /* 试下一个候选 */
    }
  }
  return '';
}

/**
 * 从一组候选目录里找这个 subagent 的 agent 定义文件本身（项目级优先，其次用户级）。
 * 顺序即优先级：命中第一个存在的就返回。
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

/** 列出目录下的 agent 文件名（去 .md/.toml 后缀），目录不可读返回空 */
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
 * 去掉 description 尾巴上那句**给模型看的**英文触发说明（"（use PROACTIVELY …）"）。
 * agent 定义的 description 是给 LLM 路由用的，末句常带这句；卡片上要的是"能干什么"，
 * 那句是噪声。只裁含 `use PROACTIVELY` 的结尾括号 —— 别的括号（哪怕是英文）一律不动。
 */
function cleanDescription(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) s = s.slice(1, -1).trim();
  s = s.replace(/[（(][^（()）]*use\s+PROACTIVELY[^（()）]*[)）][。.！!]?\s*$/i, '').trim();
  return s;
}

/** 从一个 agent 定义文件里取 description（.md 读 YAML frontmatter，.toml 读 `description = …`） */
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
  // .md：只看文件头那段 frontmatter（没有 --- 包裹就用整个文件头）
  const fm = txt.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  const head = fm ? fm[1] : txt;
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*description\s*:/.test(l));
  if (at < 0) return '';
  const inline = lines[at].replace(/^\s*description\s*:\s*/, '').trim();
  // 块标量（description: > / |）：把后面缩进的几行并成一行
  if (/^[>|][+-]?$/.test(inline)) {
    const out = [];
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) {
        if (out.length) out.push('');
        continue;
      }
      if (!/^\s/.test(line)) break; // 回到顶格 = 描述结束
      out.push(line.trim());
    }
    return cleanDescription(out.join(' '));
  }
  return cleanDescription(inline);
}

const levelCache = new Map(); // "name workspacePath" -> level

/**
 * 按给定目录判级别（项目级 / 用户级）。取不到回 null。按 name+workspacePath 缓存。
 * @param {string} name
 * @param {string} workspacePath
 * @param {Array<{dir:string, level:'project'|'user'}>} dirs 顺序即优先级
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

const descCache = new Map(); // 文件路径 -> { mtimeMs, size, value }

/**
 * subagent 的功能描述（静态数据，来自它的 agent 定义文件）。取不到回空串 —— 渲染层据此隐藏那一栏，
 * 不拿"项目子代理 · 空闲"之类的状态话术顶替。
 * @param {string} name subagent 名（成员名，如 leo）
 * @param {string} workspacePath 当前工程路径（项目级 agent 在这里找）
 * @param {Array<{dir:string, level:'project'|'user'}>} dirs 候选目录（顺序即优先级）
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
 * 通用：由"agent 家目录列表"推出项目级 / 用户级 agent 目录。
 *   · 项目级 = <workspacePath>/<家目录基名>/agents
 *   · 用户级 = <家目录>/agents
 * 各楼层若落盘点不遵循这个规律（如 Codex 认 CODEX_HOME、Claude 认 CLAUDE_CONFIG_DIR，
 * 或 subagent 根本不是单文件而是内嵌在别处），在自己的 `agentDirs` 里显式给目录 /
 * 自定义逻辑即可，不必走这里。
 * @param {string[]} homeDirs agent 家目录（如 [path.join(HOME, '.codebuddy')]）
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
