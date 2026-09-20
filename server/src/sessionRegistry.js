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
 *   2F WorkBuddy CLI、
 *   4F Codex CLI、
 *   5F Claude Code CLI —— 落盘目录里的 *.jsonl 会话文件，只有文件时间可靠；
 *                        工程名要看首行里有没有 cwd，读不到就留空（不猜）
 *                        （Codex 的 cwd 藏在首行 payload.cwd 里，见 scanCliSessions）
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

/**
 * 只读第一行（会话 jsonl 可能很大，别整读；按块读直到换行或上限）。
 * 上限给得比较宽（256KB）：Codex 的 session_meta 那一行里塞了整份 base_instructions，
 * 8KB 会把它截断成一个残缺的 JSON，cwd 就读不出来了。
 */
function headLine(p, cap = 262_144) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return '';
  }
  try {
    const CHUNK = 8192;
    let buf = Buffer.alloc(0);
    while (buf.length < cap) {
      const next = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, next, 0, CHUNK, buf.length);
      if (n <= 0) break;
      buf = Buffer.concat([buf, next.subarray(0, n)]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) return buf.subarray(0, nl).toString('utf8');
      if (n < CHUNK) break;
    }
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 关闭失败无所谓 */
    }
  }
}

/** 从首行里取工程路径；读不到就留空，不猜 */
function cwdOfFirstLine(line) {
  if (!line) return '';
  try {
    const j = JSON.parse(line);
    // CodeBuddy 家族：cwd 在顶层
    if (j && typeof j.cwd === 'string') return j.cwd;
    // Codex：{"type":"session_meta","payload":{"cwd":...}} —— cwd 藏在 payload 里
    if (j && j.payload && typeof j.payload.cwd === 'string') return j.payload.cwd;
  } catch {
    /* 首行超长被截断，退到正则 */
  }
  // 兜底：首行被上限截断时，里面这第一个 cwd 就是会话自己的（不是后面事件里的）
  const m = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  try {
    const s = JSON.parse(`"${m[1]}"`);
    return typeof s === 'string' ? s : '';
  } catch {
    return '';
  }
}

/** 人类可读的相对时间（只用于"会话文件多久前动过"这类说明文案） */
function formatAge(ms) {
  const n = Number(ms) || 0;
  if (n < 60_000) return '刚刚有更新';
  if (n < 60 * 60_000) return `${Math.round(n / 60_000)} 分钟前有更新`;
  return `${Math.round(n / (60 * 60_000))} 小时前有更新`;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * CLI 落盘里的会话文件（*.jsonl）：一个文件算一个会话。
 * 只有文件时间可靠，别的字段读不到就留空。
 *
 * 按 kind 只扫真正放会话的那棵子树：Codex 写在 sessions/YYYY/MM/DD/ 下、
 * Claude Code 写在 projects/<工程目录>/ 下；两家根目录都还有 history.jsonl、
 * settings.json 这类不是会话的文件，扫进来全是噪声（顺带也少走一遍 cache / plugins
 * 那些大目录）。
 */
function scanCliSessions(dataPath, { limit = 200, kind = '' } = {}) {
  if (!dataPath) return [];
  // 只扫真正放会话文件的那棵子树：Codex 在 sessions/ 下，Claude Code 在 projects/ 下。
  // 根目录里还有 history.jsonl / settings.json 这类不是会话的文件，扫进来全是噪声
  // （顺带也少走一遍 cache / plugins 那些大目录）。
  const SUBTREE = { codex: 'sessions', claude: 'projects' };
  const sub = SUBTREE[kind] ? path.join(dataPath, SUBTREE[kind]) : '';
  const root = sub && isDir(sub) ? sub : dataPath;
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
      // 首行里可能有 cwd（工程路径）；读不到就留空，不猜（解析规则见 cwdOfFirstLine）
      const cwd = cwdOfFirstLine(headLine(p));
      out.push({
        id: path.relative(root, p),
        project: cwd ? resolveProjectName(cwd) || path.basename(cwd) : '',
        projectPath: cwd,
        lastEventAt: at || Date.now(),
      });
    }
  };
  walk(root, 0);
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

  // 1F / 2F / 4F / 5F CLI：落盘目录里的 jsonl
  for (const p of detectProducts({})) {
    if (p.kind !== 'cli') continue;
    for (const s of scanCliSessions(p.dataPath, { kind: p.dataKind })) {
      const lastEventAt = s.lastEventAt;
      upsert({
        floor: p.id,
        id: s.id,
        source: 'cli',
        project: s.project,
        projectPath: s.projectPath,
        mine: Boolean(workspacePath && s.projectPath === path.resolve(workspacePath)),
        current: false,
        // CLI 落盘里没有运行态，只有文件时间。**不许编造**（项目铁律）：
        // 以前这里写 phase:'tool' + action:'改 xxx.jsonl'，主控制台就会一直显示
        // 「调用工具 · 改 rollout-….jsonl」——那不是观测到的动作，是拿会话文件名冒充的。
        // 现在老实报 phase:'unreported'（未上报），只把"文件多久前动过"写进 context。
        live: true,
        phase: 'unreported',
        action: '',
        context: [`会话文件${formatAge(now - lastEventAt)}（本层未接 hook，不推断动作）`],
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
      // 这一层监控的是哪个客户端（codebuddy / workbuddy / codex / claude）——
      // 办公室按它过滤成员，切到 4F 就不该再看见 CodeBuddy 的小怪物
      client: p.dataKind || '',
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
