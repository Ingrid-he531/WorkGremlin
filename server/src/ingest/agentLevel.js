'use strict';

/**
 * subagent 元信息：级别（用户级 vs 项目级）+ 功能描述（description）。
 *
 * 渲染层是沙箱（读不了文件系统），所以"这个成员是用户级还是项目级 subagent"与"它是干什么的"
 * 都必须由服务端读出来、随成员卡下发。判定口径与 CodeBuddy / Codex 一致：
 *   · 项目级：<workspacePath>/.codebuddy/agents/<name>.md、<workspacePath>/.codex/agents/<name>.toml
 *   · 用户级：~/.codebuddy/agents/<name>.md、$CODEX_HOME/agents/<name>.toml
 * 都不在 -> 级别 null（普通成员 / 演示数据，不戴级别牌）、描述空串。
 *
 * 功能描述是 agent 定义文件里的**静态数据**（"这个子代理是干什么的"），不是运行状态 ——
 * 卡片上要显示的是它，而不是"项目子代理 · 空闲"这种状态话术。
 *
 * 结果按 "name + workspacePath" / 文件 mtime 缓存（agent 定义一个会话内很少变）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const USER_AGENTS_DIR = path.join(HOME, '.codebuddy', 'agents');
/** Codex CLI 的 agent 定义目录（实测：codex home 下有 agents/；扩展名以 .md / .toml 都试） */
const USER_CODEX_AGENTS_DIR = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'agents');

/** 文件名大小写兼容：CodeBuddy 文档要求小写连字符，但保险起见两种都试 */
function fileOf(dir, name) {
  const base = String(name || '').trim();
  if (!base) return '';
  const cands = [`${base}.md`, `${base.toLowerCase()}.md`, `${base}.toml`, `${base.toLowerCase()}.toml`];
  for (const f of cands) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 试下一个候选 */
    }
  }
  return '';
}

/**
 * 找出这个 subagent 的 agent 定义文件本身（项目级优先，其次用户级）。
 * @returns {{ path: string, level: 'project'|'user' }|null}
 */
function findAgentFile(name, workspacePath) {
  const ws = String(workspacePath || '').trim();
  const dirs = [];
  if (ws) {
    const root = path.resolve(ws);
    dirs.push([path.join(root, '.codebuddy', 'agents'), 'project']);
    dirs.push([path.join(root, '.codex', 'agents'), 'project']); // Codex CLI
  }
  dirs.push([USER_AGENTS_DIR, 'user']);
  dirs.push([USER_CODEX_AGENTS_DIR, 'user']); // Codex CLI
  for (const [dir, level] of dirs) {
    const p = fileOf(dir, name);
    if (p) return { path: p, level };
  }
  return null;
}

const cache = new Map(); // "name workspacePath" -> level

function detectLevel(name, workspacePath) {
  const ws = String(workspacePath || '').trim();
  const key = `${name} ${ws}`;
  if (cache.has(key)) return cache.get(key);

  const hit = findAgentFile(name, ws);
  const level = hit ? hit.level : null;
  cache.set(key, level);
  return level;
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

const descCache = new Map(); // 文件路径 -> { mtimeMs, size, value }

/**
 * subagent 的功能描述（静态数据，来自它的 agent 定义文件）。取不到回空串 —— 渲染层据此隐藏那一栏，
 * 不拿"项目子代理 · 空闲"之类的状态话术顶替。
 * @param {string} name subagent 名（成员名，如 leo）
 * @param {string} workspacePath 当前工程路径（项目级 agent 在这里找）
 */
function agentDescription(name, workspacePath) {
  const hit = findAgentFile(name, workspacePath);
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

function clearCache() {
  cache.clear();
  descCache.clear();
}

module.exports = { detectLevel, agentDescription, clearCache };
