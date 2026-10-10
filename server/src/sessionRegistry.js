'use strict';

/**
 * sessionRegistry.js —— 全局活跃会话表。
 *
 * 一张表管所有智能体（楼层）在所有工程里开着的会话，跟当前打开哪个工程无关。
 * 表里每条记录 = 一个会话，按**楼层**（受监控产品）分组，超时就剔除：
 *
 *   1F CodeBuddy —— **合并楼层**：CLI 与 Plugin 是同一产品的两种形态，合成一层。
 *                        插件那路是结构化落盘（genie-history / todos / message-queue /
 *                        file-changes），拿得到运行态、待办清单、改动文件（见 sessions.js）；
 *                        CLI 那路是 ~/.codebuddy 的会话 jsonl + reporter 状态文件。
 *                        两路同时有会话 = 这一层里的两条会话（按 session_id 区分），不是两层。
 *   2F WorkBuddy、
 *   3F Codex CLI、
 *   4F Claude Code CLI —— 落盘目录里的 *.jsonl 会话文件，只有文件时间可靠；
 *                        工程名从文件**头部若干行**里找 cwd（见 cwdOfHead）；
 *                        那儿还没有（第一条对话没落盘）→ 退回 sessions/<pid>.json 里登记的 cwd
 *                        （见 liveSessionCwds）；两处都读不到才留空（不猜）。
 *                        注意不是"首行"：Claude 的首行是 mode / queue-operation 这类
 *                        元记录，压根没有 cwd，cwd 从第 3 行的 user 记录才有（见 cwdOfHead）
 *                        （Codex 的 cwd 藏在 payload.cwd 里，同样由 cwdOfHead 覆盖）
 *   7F Kilo Code —— **轮询路线**：Kilo 没有 hook、也没有会话 jsonl，会话/相位/完成标记
 *                  全部由 server/src/kilo.js 读它自己的 event-sourced SQLite（kilo.db）推导。
 *                  相位带 inferred:true 却又有真相位来源（推导自 event 流）。
 *
 * 超时：一个会话 60 分钟没有事件（最后更新时间没往前走）就从表里移除。
 * 它被移除只是"不再活跃"，下次它又有动静会被当成新会话重新登记。
 *
 * 纪律（docs/requirements.md §P0-6「绝不编造」）：会话里没有职务 / 进度 / 耗时，
 * 一行都不补；阶段一律是推断值，带 inferred: true。
 */

const fs = require('node:fs');
const path = require('node:path');
const { listSessions, listReporterSessions, readReporterDones, readReporterDone, reporterMainPhase } = require('./sessions');
const { detectProducts } = require('./floors');
const { floorOf, floors } = require('./floors');

/**
 * agent 名 → 楼层 meta（只建一次）。各楼层的"会话文件落在哪棵子树 / 文件名怎么解出 sessionId"
 * 已经下放到 meta.sessionSubtree / meta.sessionIdOfFile，本文件只按 meta 做通用派发，不再写
 * 任何具体产品的解析规则（见各 <product>.js）。
 */
const metaByAgent = {};
for (const id of Object.keys(floors)) {
  const m = floors[id] && floors[id].meta;
  if (m && m.agent) metaByAgent[String(m.agent)] = m;
}
const { resolveProjectName } = require('./project');
const { clientOf } = require('@workgremlin/shared');

/** 超过这么久没有事件 → 从表里移除 */
const TIMEOUT_MS = 60 * 60_000;
/** 扫盘缓存（扫一次要读十几个小文件 + 走一遍目录树） */
const TTL = 5_000;

/** @type {Map<string, any>} key（`<楼层>:<会话id>`）-> 会话 */
const table = new Map();

let lastScanAt = 0;
let lastSnapshot = null;
/** 本次扫盘里 (工程|客户端) -> readReporterDones 的结果；每次 refresh 重建。
 *  一个 CLI 楼层一次能扫出上百个历史会话文件，逐个去扫 hooks 目录太浪费，所以按 client 读一次盘。 */
let doneScans = new Map();

/**
 * 台账写入端（bus + repo），由 index.js 装配时注入 —— 见 flushSynthesizedCancels。
 * 为什么必须注入：本模块是被路由层 require 的，而 bus 实例是 index.js 里
 * createIngestBus() 造出来的，模块里 require('./ingest/bus') 只能拿到
 * `{ createIngestBus, projectIdOf, memberIdOf }` 这个**工厂**，`bus.endTask` 压根不存在。
 * 测试（只调 snapshot 的那几个）不注入 → 这一步照旧什么都不做。
 * @type {{bus: any, repo: any}|null}
 */
let backend = null;
function setBackend(next) {
  backend = next && next.bus ? { bus: next.bus, repo: next.repo || null } : null;
}

const SKIP = new Set(['node_modules', '.git', '.svn', 'cache', 'Cache', 'logs']);

function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/** 文件字节数；读不到当 0（0 = 空文件，不算会话，见 scanCliSessions） */
function sizeOf(p) {
  try {
    return fs.statSync(p).size || 0;
  } catch {
    return 0;
  }
}

/**
 * 一行里取工程路径。CodeBuddy 家族 cwd 在顶层；Codex 藏在 payload 里。
 * 这一行 parse 不了（被截断 / 根本不是 JSON）→ 回空，由调用方决定要不要退正则。
 */
function cwdOfLine(line) {
  if (!line) return '';
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return '';
  }
  // CodeBuddy 家族：cwd 在顶层
  if (j && typeof j.cwd === 'string') return j.cwd;
  // Codex：{"type":"session_meta","payload":{"cwd":...}} —— cwd 藏在 payload 里
  if (j && j.payload && typeof j.payload.cwd === 'string') return j.payload.cwd;
  return '';
}

/**
 * 从会话文件**头部若干行**里取工程路径；读不到就留空，不猜。
 *
 * 为什么不能只看第一行：**Claude Code 的首行不是对话内容**。实测它的 transcript 开头是
 * `{"type":"queue-operation",...}`（新版）或 `{"type":"mode",...}`（旧版），两样都不带 `cwd`；
 * `cwd` 从第 3 行的 `user` / `attachment` 记录才开始有（顶层字段）。
 * 老实现只读第一行，于是 4F **每一条**会话的工程都是空 —— 一个空值同时引出三个症状：
 * 下拉显示「未知工程」、`mine` 永远 false、连实时相位都叠不上去（渲染层要 `projectPath`
 * 非空才肯用快轮询，见 IsoOfficeView 的 canUseFast）→ 主控制台一直挂在「未上报」。
 *
 * 边读边试、命中就收工：这个函数会被每个会话文件、每几秒调一次，不许为了一行 cwd 读完整棵树。
 * 上限给得宽（512KB / 60 行）：Codex 的 session_meta 那一行里塞了整份 base_instructions，
 * 8KB 会把它截断成残缺 JSON，cwd 就读不出来了。
 * @param {string} p 会话 jsonl 路径
 * @returns {string} 工程绝对路径；读不到回空串
 */
function cwdOfHead(p, { cap = 524_288, maxLines = 60 } = {}) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return '';
  }
  try {
    const CHUNK = 8192;
    // buf 里只留"还没凑成完整一行"的残段（完整的行当场切走并试掉），所以 cap 实际限的是单行长度
    let buf = Buffer.alloc(0);
    let lines = 0;
    while (buf.length < cap && lines < maxLines) {
      const next = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, next, 0, CHUNK, buf.length);
      if (n <= 0) break;
      buf = Buffer.concat([buf, next.subarray(0, n)]);
      let nl = buf.indexOf(0x0a);
      while (lines < maxLines && nl >= 0) {
        const c = cwdOfLine(buf.subarray(0, nl).toString('utf8'));
        buf = buf.subarray(nl + 1);
        lines += 1;
        if (c) return c;
        nl = buf.indexOf(0x0a);
      }
      if (n < CHUNK) break;
    }
    // 走到这儿 buf 没有换行收尾：要么文件就到这里（末尾无换行），要么这条超长行撞上了 cap。
    // 两种情况都先整行 parse，不成再退到正则捞**第一个** cwd —— 它仍是这条会话自己的
    // （后面的事件压根还没读到），同老实现的口径。
    if (lines >= maxLines || !buf.length) return '';
    const tail = buf.toString('utf8');
    const direct = cwdOfLine(tail);
    if (direct) return direct;
    const m = tail.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return '';
    try {
      const s = JSON.parse(`"${m[1]}"`);
      return typeof s === 'string' ? s : '';
    } catch {
      return '';
    }
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

/**
 * 运行中的 CLI 进程自己写的**会话状态文件**：`<产品 home>/sessions/<pid>.json`，一个进程一份。
 * 实测形状（CodeBuddy CLI 2.162.0，本机 2026-10-09）：
 *   { pid, sessionId, cwd, startedAt, kind:'interactive', url, endpoint, mode, updatedAt }
 * Claude Code 2.1.283 的同名文件同样带 cwd（sessions.js 的 claudeSessionStatus 早就在读它）。
 *
 * 它比 transcript **更早**：进程一起来就写，那时 projects/<工程>/<会话>.jsonl 里一条对话都
 * 还没有 —— 正是 cwdOfHead 回空、下拉显示「未知工程」的那段窗口（用户 2026-10-09 问的就是它）。
 *
 * 为什么不用目录名兜底：projects 下那层目录名确实编码了工程路径（`<cwd 去掉分隔符>`），
 * 但分隔符已经丢了，`home-yinghui-work-WorkGremlin` 反解回 `/home/yinghui/work/WorkGremlin`
 * 只能靠猜（"work-gremlin" 到底是一个目录还是两个？）。projectPath 一路喂给 `mine` 判定和
 * 主控制台的快轮询，猜错的代价比显示一串「未知工程」大得多 —— 所以宁可不兜底。
 *
 * 只按 sessionId **精确**匹配；目录不存在 / 解析失败 / 缺 cwd 一律当"没有"，不猜。
 * 一个会话文件会问一次，上百个会话文件就是上百次，所以目录列举与内容都带 2s 缓存。
 * @param {string} dataPath 产品落盘根（如 ~/.codebuddy）
 * @returns {Map<string, string>} sessionId -> cwd
 */
const _liveState = { dir: '', at: 0, cwds: new Map() };
function liveSessionCwds(dataPath) {
  const dir = dataPath ? path.join(dataPath, 'sessions') : '';
  const now = Date.now();
  if (dir === _liveState.dir && now - _liveState.at < 2_000) return _liveState.cwds;
  _liveState.dir = dir;
  _liveState.at = now;
  _liveState.cwds = new Map();
  if (!dir || !isDir(dir)) return _liveState.cwds;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.json$/i.test(n));
  } catch {
    return _liveState.cwds;
  }
  /** @type {Map<string, {cwd: string, updatedAt: number}>} */
  const best = new Map();
  for (const name of names.slice(0, 200)) {
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // 进程可能正在写 / 中途被杀→残缺。残缺就算没读到，不猜
    }
    const sid = j && typeof j.sessionId === 'string' ? j.sessionId.trim() : '';
    const cwd = j && typeof j.cwd === 'string' ? j.cwd.trim() : '';
    if (!sid || !cwd) continue;
    // 同一个会话可能留着好几份（老 pid 没清干净）→ 取最新的那份，与 claudeSessionStatus 同口径
    const prev = best.get(sid);
    const at = Number(j.updatedAt || 0);
    if (prev && Number(prev.updatedAt || 0) >= at) continue;
    best.set(sid, { cwd, updatedAt: at });
  }
  for (const [sid, v] of best) _liveState.cwds.set(sid, v.cwd);
  return _liveState.cwds;
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
 * 从会话文件名里取会话 id（拿不到回空串 —— 不猜）。
 *
 *   - Claude Code：transcript 就叫 `<session_id>.jsonl`，去扩展名即是
 *     （hook payload 的 session_id，实测三处 100% 一致）。
 *   - Codex：`rollout-<YYYY-MM-DDTHH-MM-SS>-<session_id>.jsonl` —— id 在**时间戳后面那一段**。
 *     早先这里写的是"形状不同，不猜，留空"，其实是**取法不同**：直接去扩展名拿到的是
 *     `rollout-…-<id>` 整串。本机实测 3/3，尾段 uuid 与 hooks 状态文件里的 session_id
 *     一字不差（rollout-2026-09-26T11-15-56-01a0dbb6-…  ==  codex__…_01a0dbb6-….json）。
 *     取到 id 的收益是让 3F 的"完成"从"该工程最新"变成按会话精确（见 doneFieldsOf），
 *     渲染层的快轮询也会开始带 ?session=（相位同样受益）。
 *     失败是安全的：形状对不上就回空串 → 退回老行为，不会张冠李戴。
 *   - 其余产品（WorkBuddy CLI）：文件名不含会话 id，留空。
 * @param {string} name 文件名（含扩展名）
 * @param {string} kind 产品基名（products 的 agent：claude / codex / codebuddy …）
 * @returns {string} 会话 id；取不到回空串
 */
/**
 * 文件名 → 会话 id。规则由各楼层 meta.sessionIdOfFile 自带（见各 <product>.js），
 * 本文件只按 agent 查 meta 做通用派发；查不到 / 没有该楼层 → 回空串（退老行为，绝不张冠李戴）。
 * @param {string} name 文件名（含扩展名）
 * @param {string} kind 产品基名（楼层 meta.agent：claude / codex / codebuddy …）
 * @returns {string} 会话 id；取不到回空串
 */
function sessionIdOfFile(name, kind) {
  const m = metaByAgent[String(kind)];
  return m && typeof m.sessionIdOfFile === 'function' ? m.sessionIdOfFile(name) : '';
}

/**
 * CLI 落盘里的会话文件（*.jsonl）：一个文件算一个会话。
 * 只有文件时间可靠，别的字段读不到就留空。
 *
 * 按 kind 只扫真正放会话的那棵子树：Codex 写在 sessions/YYYY/MM/DD/ 下、
 * Claude Code 与 CodeBuddy 写在 projects/<工程目录>/ 下；三家根目录都还有 history.jsonl、
 * settings.json 这类不是会话的文件，扫进来全是噪声（顺带也少走一遍 cache / plugins
 * 那些大目录）。
 */
function scanCliSessions(dataPath, { limit = 200, kind = '' } = {}) {
  if (!dataPath) return [];
  // 只扫真正放会话文件的那棵子树 —— 哪棵由本楼层 meta.sessionSubtree 定（见各 <product>.js）：
  // Codex 在 sessions/ 下，Claude / Qoder / CodeBuddy 在 projects/ 下。根目录里还有
  // history.jsonl / settings.json 这类不是会话的文件，扫进来全是噪声（顺带也少走一遍 cache / plugins
  // 那些大目录）。目录不存在时退回整棵（下面的 isDir 判定），老安装的行为不变。
  const meta = metaByAgent[String(kind)] || {};
  const sub = meta.sessionSubtree ? path.join(dataPath, meta.sessionSubtree) : '';
  const root = sub && isDir(sub) ? sub : dataPath;
  // transcript 里还没有第一条对话时（会话刚起），cwd 只能在本产品自己的会话状态文件里找 ——
  // sessionId -> cwd（见 liveSessionCwds）。整趟扫描共用一份，别每个会话文件都重读一遍目录。
  const liveCwds = liveSessionCwds(dataPath);
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
        // 子代理的 transcript 不是独立会话：它们住在 `<会话 id>/subagents/agent-<agentId>.jsonl`，
        // 和父会话共享同一个 sessionId（首行也带 cwd，所以"读首行判工程"会把它当成一条会话）。
        // 收进来的后果：一条会话配上多少个 subagent 就多出多少条"会话"，全是噪声。
        if (e.name === 'subagents') continue;
        walk(p, depth + 1);
        continue;
      }
      if (!/\.jsonl$/i.test(e.name)) continue;
      // 空文件不算会话：会话刚起来、还没写入就被打断，会留下一个 0 字节的 jsonl 占位
      // （实测 ~/.codebuddy/projects/home-yinghui/<会话>.jsonl 就是这样）。
      // 它照样有 mtime、照样落进 60 分钟活跃窗口，于是下拉里凭空多一条「未知工程」。
      if (!sizeOf(p)) continue;
      const at = mtime(p);
      const sid = typeof meta.sessionIdOfFile === 'function' ? meta.sessionIdOfFile(e.name) : sessionIdOfFile(e.name, kind);
      // 工程路径：先看 transcript 头部的 cwd（解析规则见 cwdOfHead）；第一条对话还没落盘时那里
      // 没有，退回正在运行的 CLI 写的会话状态文件（按 sessionId 精确匹配，见 liveSessionCwds）
      const cwd = cwdOfHead(p) || liveCwds.get(sid) || '';
      out.push({
        id: path.relative(root, p),
        // 轴 2：这条落盘属于哪条会话（解析规则与实测依据见 sessionIdOfFile）
        sessionId: sid,
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

/** 完成标记缺失时的统一返回值（没有就是"没有"，不臆造）
 *  doneCancelled：那一轮是被用户打断（ESC / 停止）的，渲染层据此亮红色「任务取消」而不是「任务完成」。 */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false };

/**
 * reporter 状态文件里的**原始** done（`{at,title,files,fileCount,cancelled,workspacePath}`）→
 * 会话行形状（`{doneAt,doneTitle,doneCount,doneFiles,doneCancelled}`）。
 *
 * 为什么要有这一步：7F/8F 的会话行以前直接把原始 done 摊进来（`...doneTruth`），字段名
 * （`at` / `files`）与会话行约定的（`doneAt` / `doneFiles`）对不上 —— 渲染层读 `sel.doneAt`
 * 拿不到值，装了插件反而比轮询那一份还少信息。统一在这里转一次，顺带把 `cancelled` 透传成
 * `doneCancelled`（主控制台据此亮红色「任务取消」）。
 * @param {{at?:number,title?:string,files?:Array,fileCount?:number,cancelled?:boolean}} done
 */
function doneFieldsFromReporter(done) {
  const files = Array.isArray(done.files) ? done.files : [];
  const count = Number(done.fileCount);
  return {
    doneAt: Number(done.at) || 0,
    doneTitle: done.title || '',
    doneCount: Number.isFinite(count) ? count : files.length,
    // 带 size 的保留 size（插件那一路有），只有路径的退回 name（与 doneFieldsOf 同形）
    doneFiles: files.slice(0, 6).map((f) =>
      typeof f === 'string'
        ? { name: f }
        : { name: (f && (f.path || f.name)) || '', ...(f && Number.isFinite(f.size) ? { size: f.size } : {}) }
    ),
    doneCancelled: Boolean(done.cancelled),
  };
}

/**
 * CLI / hookSource 楼层的"完成标记"，字段名与 plugin 分支完全一致。
 *
 * 以前只有 plugin 楼层在会话表里带 doneAt（插件落盘那条路算的），CLI 楼层只能等渲染层的
 * 1.5s 快轮询把完成标记带回来 —— 于是"完成"这件事在 UI 上有两套来源，切楼层时还因此
 * 误弹过「任务完成」（渲染层拿不到会话快照里的 doneAt，只能把快轮询第一次见到的当成新事件）。
 * 时间戳来源统一了：CLI / hookSource 楼层走本函数（读 reporter 在 Stop 时落盘的 done），
 * 不再依赖渲染层 1.5s 快轮询第一次见到才算"新事件"，所以渲染层不再需要按楼层分叉判断。
 * 但"同源"只对了时间戳来源、没对归属：**有会话 id 的按 bySession 精确命中，没有 id 的
 * 只能退回 (工程+client) 的 latest** —— 同层跑多条会话时，后者仍可能把"别人刚收工"
 * 算到当前这条头上。这是已知残留，不是本次回归。
 * 现在拿得到 id 的是：Claude CLI（文件名）、Codex（rollout 文件名，见 sessionIdOfFile）、
 * 5F TraeCode（listReporterSessions 本来就只列得出有 sessionId 的）、以及 1F CodeBuddy 的
 * hook 那一路。剩下 1F（CLI 的 jsonl）/ 2F 两个 CLI 楼层的文件名不含 id，退回该工程内的 latest；
 * plugin 那一路的会话行现在也带 sessionId 了，但它们的 doneAt 另走 sessions.js 的 sessionInfo，
 * 不经过本函数。
 *
 * 文件清单只有路径：hook 不做 diff，没有 +/- 行数（那是 plugin 落盘的 file-changes 才有的）。
 * @param {string} projectPath 会话所属工程（读状态文件时按它过滤）；**可能为空**，见下面的守卫
 * @param {string} client 客户端身份（**这一路来源**的 client，如 codex / trae / codebuddy）
 * @param {string} sessionId 会话 id；拿不到才退回"该（工程 + client）最新的一份"
 */
function doneFieldsOf(projectPath, client, sessionId = '') {
  /**
   * 守卫：工程归属不明的会话**不许走兜底**。
   * readReporterDones 在没有 projectPath 时不做工程过滤，那份 latest 可能来自别的工程 ——
   * 会把别工程的收工（连同文件名）当成这条会话的"任务完成"显示出来。
   *
   * 但只砍**兜底**这一支，**不砍有会话 id 的精确命中**（两者安全性不同：id 唯一，精确命中
   * 与工程无关）。一刀砍掉会误伤两条真实路径：
   *   · 5F TraeCode（会话只能靠 hook 状态文件）—— 会话一 Stop，hook 就把 sessionPhase 与
   *     taskWorkspacePath 一起清空（实测 sessionPhase:null、taskWorkspacePath:""），于是
   *     "有完成标记"与"工程归属非空"按构造互斥：守卫一开，5F 的「任务完成」永远不亮，
   *     反而要等下一轮开工、工程回来了才突然亮起上一轮的完成（假弹）。
   *   · Claude 会话的 cwd 没解析出来时工程也是空，但它有会话 id，精确命中照样是对的。
   * 反过来，没有会话 id 的（1F/2F）行为不变：仍返回空标记（合"绝不编造"纪律）。
   *
   * 守卫只加在这里，别加进 readReporterDone：/reporter-phase 在 freshestReporterWs
   * 返回空时也会调它，那样会连快轮询的精确标记一起废掉。
   */
  if (!projectPath && !sessionId) return NO_DONE;
  // projectPath 为空时 key 塌成 `|client`，与 readReporterDones 的"空串 = 不过滤"是同一语义：
  // 这类会话只可能靠下面的精确命中取到东西，走不到 latest（守卫已拦）。
  const key = `${projectPath || ''}|${client || ''}`;
  if (!doneScans.has(key)) doneScans.set(key, readReporterDones(projectPath, client));
  const { latest, bySession } = doneScans.get(key);
  // 有会话 id 就必须精确命中：命中不了就是"这条会话没完成过"，
  // 不能退回 latest —— 那会把同层别的会话的收工搬到它头上（错误归因）。
  const done = sessionId ? bySession.get(String(sessionId)) || null : latest;
  if (!done) return NO_DONE;
  const files = Array.isArray(done.files) ? done.files : [];
  const count = Number(done.fileCount);
  return {
    doneAt: Number(done.at) || 0,
    doneTitle: done.title || '',
    doneCount: Number.isFinite(count) ? count : files.length,
    doneFiles: files.slice(0, 6).map((f) => ({ name: typeof f === 'string' ? f : (f && f.path) || '' })),
    // reporter 的 done.cancelled（Interrupt 落的那一枚）：原样透传，不猜、不补
    doneCancelled: Boolean(done.cancelled),
  };
}

/**
 * 扫一遍所有数据源，更新表。
 * @param {{workspacePath?: string, force?: boolean}} o
 */
function refresh({ workspacePath = '', force = false } = {}) {
  const now = Date.now();
  if (!force && lastScanAt && now - lastScanAt < TTL) return;
  doneScans = new Map();

  /**
   * 会话来源：每个楼层按自己的 sources 逐路取 —— 普通楼层一路，合并楼层多路
   * （1F CodeBuddy = CLI 落盘 + 插件结构化落盘 + reporter 状态文件，见 products.js 的 sources）。
   *
   * 每一路都带上**这一路自己的 client**：插件那路是 codebuddy-plugin，CLI / hook 那路是 codebuddy。
   * 于是每条会话的相位、完成标记、活跃窗口都只认自己那一路的落盘 ——
   * 同一个产品同时开着 CLI 与 Plugin 时，两条会话各显示各的，不会互相串味。
   *
  * CLI 的 JSONL 与 hook 状态文件可能描述同一会话。两路都提供 sessionId 时只对同一 id 去重；
  * SessionEnd 的 reporter 标记会同时排除旧 hook 行与对应 JSONL。CLI 新会话即使还没有 transcript，
  * 仍由 SessionStart 的 hook 状态列出，不会被同楼层另一条近期 JSONL 屏蔽。
   */
  const products = detectProducts({});
  const seen = new Set();
  const cliLandingSessions = new Map();
  const claim = (floor, sessionId) => {
    if (!sessionId) return true;
    const k = `${floor}:${sessionId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  // 框架把共享工具打包成 ctx 交给每个楼层的来源分支（标准 handler 见下方 DEFAULT_KIND_HANDLERS，
  // 楼层特有的在各自文件 modules/kindHandlers）—— 调试一个楼层不可能碰到别的楼层。
  const ctx = {
    now, workspacePath, force,
    table, backend, TIMEOUT_MS,
    seen, claim, cliLandingSessions, doneScans,
    resolveProjectName, clientOf, formatAge,
    upsert, doneFieldsOf, doneFieldsFromReporter,
    scanCliSessions, liveSessionCwds, listReporterSessions,
    listSessions, reporterMainPhase, readReporterDone,
  };

  for (const p of products) {
    const mod = floorOf(p.id);
    ctx.product = p;
    for (const src of p.sources) {
      // 只作落盘展示的那几路（kind 'dir'，如 5F 的 ~/.trae-cn 与 ~/.marscode）不产会话：
      // 目录里有东西，但读不出会话索引 —— 它们只进楼层悬浮提示，不进会话表。
      if (src.sessions === false) continue;

      // ---- kilo / opencode / lingma 三路（7F / 8F / 6F-插件）----
      // 这几路不是"扫文件"，而是轮询各产品自己的落盘库（kilo.db / opencode.db / 灵码 local.db），
      // 形状与 cli/hook 不同（带真相位与模型）。它们的实现已搬到各自的楼层文件
      // （kilo.js / opencode.js / qoder.js 的 kindHandlers），由下面的通用派发按 src.kind 调用，
      // 调试 6F/7F/8F 不再需要碰本文件。

      // 通用派发：楼层特有的来源分支（kilo / opencode / lingma）优先用楼层自己的 handler；
      // 否则用框架内置的标准 handler（plugin / cli / hook）。这一行就是"每个楼层的东西
      // 限定到自己的文件"的落地 —— 新增 / 调整一个楼层只改它的文件 + floors.js，本文件不变。
      const handler = (mod && mod.kindHandlers && mod.kindHandlers[src.kind]) || DEFAULT_KIND_HANDLERS[src.kind];
      if (handler) handler(p, src, ctx);
    }
    // 楼层自己的后台 flush（如 5F Trae 的 endTask / 金额补发）：必须在通用 flush 之前跑，
    // 否则 superseded 会把 Trae 正常完成的 running 任务先改成 cancelled。
    if (mod && typeof mod.flushBackend === 'function') mod.flushBackend(ctx);
  }

  // 通用 flush（与楼层无关，操作 doneScans）：把"用户真按了停止"的合成取消 / 被顶掉的上一轮收尾。
  // （Trae 自己的 endTask / 金额补发由 trae.js 的 flushBackend 在上面楼层循环里已经跑过。）
  flushSynthesizedCancels(doneScans, now);
  // 被新一轮顶掉的上一轮（同会话一个结束事件都没到的那行）：也补一刀 cancelled。
  // 注意：Trae 的 flushBackend 已先把有 DoneHandler 的任务改成 done/cancelled，
  // superseded 只会碰"连 DoneHandler 都没的" running 任务（极少数极端情况）。
  flushSupersededTasks(doneScans);

  prune(now);
  lastScanAt = now;
  lastSnapshot = null;
}

/* ------------------------------ 标准来源分支（框架内置，所有楼层共用） ------------------------------ */

// 插件那一路：编辑器 globalStorage 的结构化落盘（genie-history / todos / …）。
// 1F/9F 的 plugin 来源走这里；逻辑原样保留，只是从 refresh 的巨 switch 里抽出来。
function handlePlugin(p, src, ctx) {
  const { workspacePath, force, table, claim, upsert, listSessions, listReporterSessions, doneFieldsOf, doneScans } = ctx;
  /**
   * 合并楼层（1F CodeBuddy）的**插件来源**也会产出「取消」标记：插件按停止一个 hook 事件都不发，
   * 唯一真信号在 message-queue 的 `pauseReason:'cancel'`（见 floorCodebuddy.synthMarks），由
   * readReporterDones 合成、挂在 doneScans 上。flushSynthesizedCancels / flushSupersededTasks
   * 只扫 doneScans，而 handlePlugin 自己不调 doneFieldsOf（done* 字段走 listSessions 那条独立路径算），
   * 于是 codebuddy-plugin 的 doneScan 永远是空，插件取消永远扫不到 → task_runs 一直挂 running，
   * 滚动屏幕 / 任务列表收不到「已取消」，只能等新一轮开工（endStaleTasksOfSession）把上一轮顶掉。
   * 这里把这一份 doneScan 建出来（与 doneFieldsOf 同一把缓存键），让 flush 能补刀 task/end(cancelled)。
   */
  const scanKey = `${workspacePath || ''}|${src.client || ''}`;
  if (!doneScans.has(scanKey)) doneScans.set(scanKey, readReporterDones(workspacePath, src.client));
  const st = listSessions({ workspacePath, force, client: src.client, pluginRe: p.pluginRe });
  const reporterSessions = listReporterSessions(src.client, { includeEnded: true });
  const endedSessionIds = new Set(reporterSessions.filter((s) => s.endedAt).map((s) => s.sessionId));
  if (endedSessionIds.size) {
    for (const [key, session] of table) {
      if (session.floor === p.id && endedSessionIds.has(session.sessionId)) table.delete(key);
    }
  }
  const pluginSessions = (st.sessions || []).filter(
    (s) =>
      !endedSessionIds.has(s.id) &&
      !(src.client === 'codebuddy-plugin' && s.runtime && s.runtime.paused && String(s.runtime.pauseReason || '').toLowerCase() === 'cancel')
  );
  if (!pluginSessions.length) return;
  for (const s of pluginSessions) {
    if (!claim(p.id, s.id)) continue;
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      source: 'plugin',
      project: s.project || '',
      projectPath: s.projectPath || '',
      mine: Boolean(s.mine),
      current: Boolean(s.current),
      // 该层全局唯一"正在真实活动"的那条（freshest reporter 所在工程当前会话）；
      // 只有它才配叠加实时相位，其余 current=true 的工程当前会话只用自己工程的上报。
      fresh: s.id === st.current,
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
      doneCancelled: Boolean(s.doneCancelled),
      inferred: Boolean(s.inferred),
      lastEventAt: s.lastUpdated || 0,
    });
  }
}

// cli / hook 两路共用：扫 jsonl 或读 reporter 状态文件，按 src.kind 区分。
// 1F~5F、9F 的 cli/hook 来源都走这里（标准形状：只有文件时间 / 心跳时间，没有运行态）。
function handleCliHook(p, src, ctx) {
  const {
    workspacePath, table, claim, upsert, now, TIMEOUT_MS,
    scanCliSessions, listReporterSessions, doneFieldsOf, formatAge, resolveProjectName, cliLandingSessions,
  } = ctx;
  const reporterSessions = src.kind === 'cli' ? listReporterSessions(src.client, { includeEnded: true }) : [];
  const endedSessionIds = new Set(reporterSessions.filter((s) => s.endedAt).map((s) => s.sessionId));
  for (const [key, session] of table) {
    if (session.floor === p.id && endedSessionIds.has(session.sessionId) && ['cli', 'hook'].includes(session.sourceKind)) {
      table.delete(key);
    }
  }
  const rows =
    src.kind === 'cli'
      ? scanCliSessions(src.dataPath, { kind: p.agent }).filter((s) => !s.sessionId || !endedSessionIds.has(s.sessionId))
      : listReporterSessions(src.client).map((s) => ({
          id: s.sessionId,
          sessionId: s.sessionId,
          project: s.workspacePath ? resolveProjectName(s.workspacePath) || path.basename(s.workspacePath) : '',
          projectPath: s.workspacePath,
          lastEventAt: s.lastEventAt,
        }));
  // 判据得是"这一路扫到了【还活着】的会话"，而不是"扫到了任何行"（与 prune / snapshot 同尺 TIMEOUT_MS）。
  const live = rows.filter((r) => now - (Number(r.lastEventAt) || 0) < TIMEOUT_MS);
  // CLI JSONL 与 hook 可能描述同一会话：只按真实 sessionId 去重；cli 路扫到活会话时，撤掉旧的 hook 行。
  if (src.kind === 'cli' && live.length) {
    const ids = new Set(live.map((s) => s.sessionId).filter(Boolean));
    cliLandingSessions.set(p.id, ids);
    for (const sessionId of ids) {
      const oldHookKey = `${p.id}:${sessionId}`;
      const oldHook = table.get(oldHookKey);
      if (oldHook && oldHook.sourceKind === 'hook') table.delete(oldHookKey);
    }
  }
  for (const s of live) {
    const sessionId = s.sessionId || '';
    if (src.kind === 'hook' && sessionId && cliLandingSessions.get(p.id)?.has(sessionId)) continue;
    if (!claim(p.id, sessionId)) continue;
    const lastEventAt = s.lastEventAt;
    upsert({
      floor: p.id,
      id: s.id,
      sessionId,
      source: 'cli',
      /** 这一行具体来自哪一路（cli / hook）：让"jsonl 优先"规则能撤掉旧的 hook 行 */
      sourceKind: src.kind,
      project: s.project,
      projectPath: s.projectPath,
      mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
      current: false,
      live: true,
      // 相位不在这里造（项目铁律：绝不编造）—— 实时相位由 /reporter-phase 快轮询单独拉。
      phase: 'unreported',
      action: '',
      context: src.kind === 'cli' ? [`会话文件${formatAge(now - lastEventAt)}（本层未接 hook，不推断动作）`] : [],
      inferred: true,
      // 完成标记只认**这一路自己的 client**（见 refresh 的说明）。
      ...doneFieldsOf(s.projectPath, src.client, sessionId),
      lastEventAt,
    });
  }
}

/**
 * 标准来源分支表：key 是来源 kind。楼层文件可以用自己的 kindHandlers 覆盖任意一种
 * （见 kilo.js / opencode.js / qoder.js）。'dir' 不产会话，refresh 里已提前跳过。
 */
const DEFAULT_KIND_HANDLERS = {
  plugin: handlePlugin,
  cli: handleCliHook,
  hook: handleCliHook,
};

/**
 * 去重键含 taskStartedAt（at），同一轮只要补发一次；新一轮（at 变了）照常再发。
 * @param {Map<string, {cancels?: Array}>} doneScans
 * @param {number} now
 */
const postedCancels = new Map(); // key -> 过期时间戳（避免进程存活期间反复补发）
function flushSynthesizedCancels(doneScans, now) {
  const { bus, repo } = backend || {};
  if (!bus || typeof bus.endTask !== 'function') return;
  for (const scan of doneScans.values()) {
    for (const c of scan.cancels || []) {
      // taskId 可能为空（Trae：取消信号来自 renderer.log，hook 状态文件的 taskId 永远是新一轮的）。
      // 用 cancelAt 参与去重 key，避免同一取消反复补发。
      const key = `${c.sessionId}|${c.taskId || ''}|${c.workspacePath}|${c.at}`;
      if (postedCancels.get(key) > now) continue;
      let task = null;
      if (c.taskId) {
        // Claude / Qoder / CodeBuddy 插件：taskId 直接可取（hook 状态文件里存的是被取消那一轮的）
        task = repo && repo.getTask ? repo.getTask.get(c.taskId) : null;
      }
      if (!task && repo && repo.listStaleRunningBySession && c.sessionId) {
        // Trae：taskId 为空，从 task_runs 里找这条会话里"cancelAt 之前开始、
        // 至今还挂 running"的那条（它就是被取消的上一轮；新一轮 startedAt > cancelAt，
        // 不会被误取）。按 started_at DESC 取最新一条。
        const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(c.workspacePath || '')) : null;
        if (proj) {
          const all = repo.listStaleRunningBySession.all(proj.id, c.sessionId);
          const atC = Number(c.at) || 0;
          // 最新开始的那条 <= cancelAt —— 那就是被取消的
          const match = all
            .filter((r) => Number(r.startedAt) && (!atC || Number(r.startedAt) <= atC))
            .sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0];
          if (match) task = repo.getTask ? repo.getTask.get(match.id) : null;
        }
      }
      if (!task) continue;
      postedCancels.set(key, now + 10 * 60_000);
      try {
        bus.endTask({
          project: task.project_id,
          memberId: task.member_id,
          taskId: task.id,
          state: 'cancelled',
          model: '',
          result: String(c.result || ''),
          files: Array.isArray(c.files) ? c.files : [],
          fileCount: Number.isFinite(Number(c.fileCount)) ? Number(c.fileCount) : (Array.isArray(c.files) ? c.files.length : 0),
          form: c.form || '',
          sessionId: c.sessionId,
          ts: c.at,
        });
      } catch {
        /* 补发失败不影响会话表 */
      }
    }
  }
  for (const [k, v] of postedCancels) if (v <= now) postedCancels.delete(k);
}

/**
 * 收掉**被新一轮顶掉的上一轮**：同一会话里比"当前这一轮"更早开始、却至今挂着 running 的任务。
 * 收掉**被新一轮顶掉的上一轮**：同一会话里比"当前这一轮"更早开始、却至今挂着 running 的任务。
 *
 * 判据是硬的：一个会话不可能同时跑两轮。它之所以还挂着，是因为这一轮的结束事件永远到不了 ——
 * CodeBuddy 插件按停止时一个 hook 事件都不发，而 hook 的状态文件按**会话**一份，新一轮的
 * /task/start 会把 taskId / taskStartedAt 整份覆盖，上一轮连兜底扫描（上面的 cancels，
 * 它只认状态文件里"当前那个" taskId）都够不着，于是永远停在「进行中」。
 * 用户看到的就是：取消了任务 → 屏上还是「进行中」，主控制台却已经「待命中」。
 *
 * 与 flushSynthesizedCancels 的分工：那里靠"用户真按了停止"的落盘信号（越早越好，取消当场就能亮）；
 * 这里是**不依赖任何产品信号**的硬兜底 —— 被顶掉的上一轮，无论它是被掐了还是事件丢了，都得收尾。
 * @param {Map<string, {rounds?: Array}>} doneScans key 是 `${工程路径}|${client}`
 */
function flushSupersededTasks(doneScans) {
  const { bus, repo } = backend || {};
  if (!bus || typeof bus.endStaleTasksOfSession !== 'function' || !repo) return;
  for (const [key, scan] of doneScans) {
    const ws = String(key || '').split('|')[0];
    if (!ws || !scan.rounds || !scan.rounds.length) continue;
    // 工程 id 只能从路径换：bus 收的是工程 id（`<名字>@<工程id>`），传路径会算出不存在的成员
    const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(ws)) : null;
    if (!proj) continue;
    for (const r of scan.rounds) {
      if (!r.sessionId || !Number(r.taskStartedAt)) continue;
      try {
        // excludeTaskId = 当轮自己的 taskId：扫尾只收"被顶掉的上一轮"，
        // 绝不能把状态文件里指向的当前轮收掉（startedAt >= ts 判界之外的双保险）。
        bus.endStaleTasksOfSession({ project: proj.id, sessionId: r.sessionId, ts: Number(r.taskStartedAt), excludeTaskId: r.taskId || '', client: r.client });
      } catch {
        /* 台账补发失败不影响会话表 */
      }
    }
  }
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
      // 办公室按它过滤成员，切到 3F 就不该再看见 CodeBuddy 的小怪物
      // （成员过滤按 **基名** 认：1F 的 codebuddy 也收 codebuddy-plugin 的小怪物，
      //  见 renderer/src/lib/clientMatch.js 的 floorAcceptsClient）
      client: p.dataKind || '',
      // 这一层接纳的全部客户端（合并楼层多个，如 1F = codebuddy + codebuddy-plugin）：
      // 前端按它过滤实时相位（/reporter-phase?client=a,b）与任务记录里的楼层归属
      clients: p.clients && p.clients.length ? p.clients : p.dataKind ? [p.dataKind] : [],
      installed: Boolean(p.installed),
      installPathLabel: p.installPathLabel || '',
      // 安装位置逐形态清单（CLI / 插件各一条，见 products.js 的 detectOne）：
      // 楼层胶囊 tooltip 照它逐行显示"安装 CLI / 安装 插件"。**必须显式透传** ——
      // 这里只挑字段下发，漏了它前端就拿不到、退回单行兜底，合并楼层（1F CodeBuddy）
      // 的插件扩展目录会被吞掉。
      installPaths: Array.isArray(p.installPaths) ? p.installPaths : [],
      dataPathLabel: p.dataPathLabel || '',
      stats: p.stats || null,
      // 落盘来源（合并楼层多路，含每路的落盘目录与统计）—— 楼层悬浮提示按它逐路显示
      sources: (p.sources || []).map((s) => ({
        kind: s.kind,
        // 显示名（'IDE' / 'plugin' …）：同 kind 可能有两路（5F 的 IDE 与插件都是 'dir'）
        label: s.label || '',
        // 这一路产不产会话：false = 只作落盘展示（悬浮提示里说明"读不出会话"）
        sessions: s.sessions !== false,
        client: s.client,
        dataPathLabel: s.dataPathLabel || '',
        stats: s.stats || null,
        // 这一路取不到会话时的说明（如 TraeCode 的插件落盘没有会话索引）——
        // 前端悬浮提示照它显示，让"没数据"和"读不到"分得清
        note: s.note || '',
      })),
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

module.exports = { snapshot, refresh, prune, TIMEOUT_MS, table, setBackend, scanCliSessions, liveSessionCwds };
