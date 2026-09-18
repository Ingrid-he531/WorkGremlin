'use strict';

/**
 * 用户级 / 工程级 subagent 定义扫描器 → 常驻成员（小怪物，占工位）。
 *
 * 对齐"小怪物 = 用户级 / 工程级 subagent"的映射：
 *   用户级：~/.codebuddy/agents/*.md、~/.workbuddy/agents/*.md
 *   工程级：<workspace>/.codebuddy/agents/*.md
 * 每个 .md 是一个 subagent 定义，frontmatter 取 name / description / tools。
 *
 * 与 subagentFeed（运行期实例 → 幽灵）区分：这里是"定义"，常驻、占工位；
 * 那边是"正在跑的实例"，飘在空中。两者都是 subagent，只是生命周期不同。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 极简 YAML frontmatter：--- 之间 key: value */
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (mm) out[mm[1].toLowerCase()] = mm[2].trim();
  }
  return out;
}

function scanDir(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!/\.md$/i.test(f)) continue;
    const fp = path.join(dir, f);
    let text = '';
    try {
      text = fs.readFileSync(fp, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    const id = f.replace(/\.md$/i, '');
    out.push({
      id,
      name: fm.name || id,
      description: fm.description || '',
      tools: fm.tools || '',
    });
  }
  return out;
}

/**
 * @param {{bus: any, team: string, homeDir: string, getWorkspacePath?: () => string, intervalMs?: number}} opts
 */
function createAgentScanner({ bus, team, homeDir, getWorkspacePath, intervalMs = 5000 }) {
  const userDirs = [
    path.join(homeDir, '.codebuddy', 'agents'),
    path.join(homeDir, '.workbuddy', 'agents'),
  ];

  let lastSig = '';

  function sync() {
    const all = [];
    for (const d of userDirs) for (const a of scanDir(d)) all.push({ ...a, level: 'user' });
    const wp = getWorkspacePath && getWorkspacePath();
    if (wp) for (const a of scanDir(path.join(wp, '.codebuddy', 'agents'))) all.push({ ...a, level: 'project' });

    for (const a of all) {
      const memberId = `agent-${a.level}-${a.id}`;
      bus.registerMember({
        team,
        memberId,
        name: a.name,
        role: a.description || (a.level === 'user' ? '用户级 subagent' : '工程级 subagent'),
        sessionId: null,
        ephemeral: false,
        reported: 0,
        // 必须带上 workspacePath：bus 里按它判定"工程级 subagent"，缺了工程级会被判成普通成员（灰牌）
        workspacePath: a.level === 'project' ? wp : '',
        project: a.level === 'project' && wp ? path.basename(wp) : null,
      });
    }

    // 只在集合变化时打印，避免每 5s 刷屏
    const sig = JSON.stringify(all.map((a) => `${a.level}:${a.id}`));
    if (sig !== lastSig) {
      lastSig = sig;
      if (all.length) {
        console.log(`[workgremlin] subagent 定义（小怪物）：${all.map((a) => a.name).join('、')}`);
      }
    }
    return all.length;
  }

  let timer = null;
  function start() {
    sync();
    timer = setInterval(sync, intervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  return { start, stop, sync };
}

module.exports = { createAgentScanner, scanDir, parseFrontmatter };
