'use strict';

/**
 * sessionRegistry.js —— 全局活跃会话表。
 *
 * 一张表管所有智能体（楼层）在所有工程里开着的会话，跟当前打开哪个工程无关。
 * 表里每条记录 = 一个会话，按**楼层**（受监控产品）分组，超时就剔除：
 *
 *   3F CodeBuddy 插件 —— 结构化落盘（genie-history / todos / message-queue / file-changes），
 *                        拿得到运行态、待办清单、改动文件（见 sessions.js）
 *   1F CodeBuddy CLI、
 *   2F WorkBuddy CLI   —— 落盘目录里的 *.jsonl 会话文件，只有文件时间可靠；
 *                        工程名要看首行里有没有 cwd，读不到就留空（不猜）
 *
 * 超时：一个会话 60 分钟没有事件（最后更新时间没往前走）就从表里移除。
 * 它被移除只是"不再活跃"，下次它又有动静会被当成新会话重新登记。
 *
 * 纪律（docs/requirements.md §P0-6「绝不编造」）：会话里没有职务 / 进度 / 耗时，
 * 一行都不补；阶段一律是推断值，带 inferred: true。
 */

const fs = require('node:fs');
const path = require('node:path');
const { listSessions } = require('./sessions');
const { detectProducts } = require('./products');
const { resolveProjectName } = require('./project');

/** 超过这么久没有事件 → 从表里移除 */
const TIMEOUT_MS = 60 * 60_000;
/** 扫盘缓存（扫一次要读十几个小文件 + 走一遍目录树） */
const TTL = 5_000;

/** @type {Map<string, any>} key（`<楼层>:<会话id>`）-> 会话 */
const table = new Map();

let lastScanAt = 0;
let lastSnapshot = null;

const SKIP = new Set(['node_modules', '.git', '.svn', 'cache', 'Cache', 'logs']);

function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/** 只读文件开头一小段 —— 会话 jsonl 可能很大，别整读 */
function headText(p, bytes = 8192) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, Math.max(0, n)).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * CLI 落盘里的会话文件（*.jsonl）：一个文件算一个会话。
 * 只有文件时间可靠，别的字段读不到就留空。
 */
function scanCliSessions(dataPath, limit = 200) {
  if (!dataPath) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4 || out.length >= limit) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= limit) return;
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!/\.jsonl$/i.test(e.name)) continue;
      const at = mtime(p);
      // 首行里可能有 cwd（工程路径）；读不到就留空，不猜
      let cwd = '';
      const first = headText(p)
        .split(/\r?\n/)
        .find(Boolean);
      if (first) {
        try {
          const j = JSON.parse(first);
          if (j && typeof j.cwd === 'string') cwd = j.cwd;
        } catch {
          /* 首行不是 JSON，跳过 */
        }
      }
      out.push({
        id: path.relative(dataPath, p),
        project: cwd ? resolveProjectName(cwd) || path.basename(cwd) : '',
        projectPath: cwd,
        lastEventAt: at || Date.now(),
      });
    }
  };
  walk(dataPath, 0);
  return out;
}

/** 登记 / 更新一条会话 */
function upsert(entry) {
  const key = `${entry.floor}:${entry.id}`;
  const prev = table.get(key);
  const now = Date.now();
  // 拿不到事件时间（插件没给最后更新）就沿用上次登记的时间；
  // 用"现在"冒充事件的话，这种会话永远超时不了，会一直挂在表里。
  const lastEventAt = Number(entry.lastEventAt) || (prev ? prev.lastEventAt : now);
  table.set(key, {
    ...entry,
    key,
    lastEventAt,
    firstSeenAt: prev ? prev.firstSeenAt : now,
    active: now - lastEventAt < TIMEOUT_MS,
  });
}

/** 超时（60 分钟没事件）的会话移出表 */
function prune(now = Date.now()) {
  let removed = 0;
  for (const [key, s] of table) {
    if (now - s.lastEventAt >= TIMEOUT_MS) {
      table.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 扫一遍所有数据源，更新表。
 * @param {{workspacePath?: string, force?: boolean}} o
 */
function refresh({ workspacePath = '', force = false } = {}) {
  const now = Date.now();
  if (!force && lastScanAt && now - lastScanAt < TTL) return;

  // 3F 插件：结构化落盘
  const plugin = listSessions({ workspacePath, force });
  for (const s of plugin.sessions || []) {
    upsert({
      floor: '3F',
      id: s.id,
      source: 'plugin',
      project: s.project || '',
      projectPath: s.projectPath || '',
      mine: Boolean(s.mine),
      current: Boolean(s.current),
      // 全局唯一"正在真实活动"的那条（freshest reporter 所在工程当前会话）；
      // 只有它才配叠加 1.5s 快轮询的全局实时相位，其余 current=true 的工程当前会话
      // 只用自己工程的上报，绝不借别人的相位冒充（否则切回旧会话会误显新工程的"调用工具"）。
      fresh: s.id === plugin.current,
      live: Boolean(s.live),
      runtime: s.runtime,
      pending: s.pending || 0,
      todos: s.todos,
      files: s.files,
      phase: s.phase,
      action: s.action,
      target: s.target || '',
      tool: s.tool || '',
      context: s.context || [],
      prompt: s.prompt || '',
      // reporter 在 Stop 时落的"完成"标记：唯一真源，绝不靠相位回落到空闲来猜。
      doneAt: s.doneAt || 0,
      doneTitle: s.doneTitle || '',
      doneCount: s.doneCount || 0,
      doneFiles: s.doneFiles || [],
      // 真值 / 推断由 sessions.js 的 sessionInfo 判定（reported → false），这里照搬，
      // 别写死 true——否则 reporter 上报的相位也会被 UI 当成「推断」灰显。
      inferred: Boolean(s.inferred),
      lastEventAt: s.lastUpdated || 0,
    });
  }

  // 1F / 2F CLI：落盘目录里的 jsonl
  for (const p of detectProducts({})) {
    if (p.kind !== 'cli') continue;
    for (const s of scanCliSessions(p.dataPath)) {
      const lastEventAt = s.lastEventAt;
      upsert({
        floor: p.id,
        id: s.id,
        source: 'cli',
        project: s.project,
        projectPath: s.projectPath,
        mine: Boolean(workspacePath && s.projectPath === path.resolve(workspacePath)),
        current: false,
        // CLI 落盘里没有运行态，只有文件时间：近期动过就当在干活
        live: true,
        phase: now - lastEventAt < 5 * 60_000 ? 'tool' : 'idle',
        action: now - lastEventAt < 5 * 60_000 ? `改 ${path.basename(s.id)}` : '会话空闲',
        context: [],
        inferred: true,
        lastEventAt,
      });
    }
  }

  prune(now);
  lastScanAt = now;
  lastSnapshot = null;
}

/**
 * 全局活跃会话表（按楼层分组）。
 * @param {{workspacePath?: string, force?: boolean}} o
 * @returns {{ok: true, floors: Array, sessions: Array, defaultFloor: string,
 *            workspacePath: string, timeoutMs: number, updatedAt: number, reason?: string}}
 */
function snapshot({ workspacePath = '', force = false } = {}) {
  refresh({ workspacePath, force });
  const now = Date.now();

  const products = detectProducts({});
  const floors = products.map((p) => {
    const sessions = [...table.values()]
      .filter((s) => s.floor === p.id && s.active)
      .sort((a, b) => {
        if (a.mine !== b.mine) return a.mine ? -1 : 1;
        return b.lastEventAt - a.lastEventAt;
      });
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      installed: Boolean(p.installed),
      installPathLabel: p.installPathLabel || '',
      dataPathLabel: p.dataPathLabel || '',
      stats: p.stats || null,
      /** 这一层有几个活跃会话 —— 左侧状态点绿/灰就看它 */
      activeCount: sessions.length,
      sessions,
    };
  });

  const sessions = floors.flatMap((f) => f.sessions);
  // 默认楼层：优先有活跃会话的层；都没有就退到装了的层；再没有就第一层
  const hot = floors.find((f) => f.activeCount > 0);
  const on = floors.find((f) => f.installed);
  const pick = hot || on || floors[0];
  const defaultFloor = pick ? pick.id : '1F';

  return {
    ok: true,
    floors,
    sessions,
    /** 没有活跃会话时给个兜底楼层：办公室照常显示，只是下拉为空 */
    defaultFloor,
    workspacePath,
    timeoutMs: TIMEOUT_MS,
    updatedAt: now,
    ...(sessions.length ? {} : { reason: 'no-open-project' }),
  };
}

module.exports = { snapshot, refresh, prune, TIMEOUT_MS, table };
