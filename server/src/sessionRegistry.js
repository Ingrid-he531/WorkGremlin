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
 *                        工程名从文件**头部若干行**里找 cwd，读不到就留空（不猜）。
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
// 7F Kilo Code：Kilo 没有 hook、没有会话 jsonl，会话/相位/完成标记由这里轮询它的 SQLite 推导
const { listKiloSessions, readKiloPhase, readKiloDone } = require('./kilo');
// 8F OpenCode：与 7F 同类（轮询 SQLite），但读的是 session_message 而不是 event 表
const { listOpencodeSessions, readOpencodePhase, readOpencodeDone } = require('./opencode');
const { detectProducts } = require('./products');
const { resolveProjectName } = require('./project');
// clientOf：7F 那支要按上报身份去问真相位（kilo-plugin / kilo 两个都试，见 kilo 分支的注释）
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
function sessionIdOfFile(name, kind) {
  // Claude Code 与 Qoder 的 transcript 都叫 `<session_id>.jsonl`：去扩展名即是
  // （Qoder 是 Claude Code 同款格式，文件名即 hook payload 的 session_id，三处实测一致）。
  if (kind === 'claude' || kind === 'qoder') return name.replace(/\.jsonl$/i, '');
  if (kind === 'codex') {
    const m = String(name).match(
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    );
    return m ? m[1] : '';
  }
  // CodeBuddy CLI：transcript 同样叫 `<session_id>.jsonl`（2026-09-27 实测：
  // ~/.codebuddy/projects/<工程>/01a0e136-9b12-75d9-a218-f6bd35e168aa.jsonl 与 hook 状态文件
  // codebuddy__…_01a0e136-9b12-75d9-a218-f6bd35e168aa.json 里的 sessionId 一字不差）。
  // 老版本给的是 32 位十六进制（无连字符，见 hooks 目录里那几份旧状态文件），一并认。
  // 形状对不上（history.jsonl 之类）→ 回空，退回老行为。
  if (kind === 'codebuddy') {
    const stem = name.replace(/\.jsonl$/i, '');
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (isUuid.test(stem) || /^[0-9a-f]{32}$/i.test(stem)) return stem;
    return '';
  }
  return '';
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
  // 只扫真正放会话文件的那棵子树：Codex 在 sessions/ 下，Claude Code 与 CodeBuddy 在 projects/ 下。
  // 根目录里还有 history.jsonl / settings.json 这类不是会话的文件，扫进来全是噪声
  // （顺带也少走一遍 cache / plugins 那些大目录）。
  // CodeBuddy 这一条是实测补的（2026-09-27）：它漏了，于是 root 退回整个 ~/.codebuddy，
  // 把 CLI 的**输入历史** history.jsonl（每行 {"display":"…","project":"…"}，你每敲一次回车
  // 它就更新、还总是最新）当成一条会话列进下拉。
  // 目录不存在时退回整棵（下面的 isDir 判定），老安装的行为不变。
  const SUBTREE = { codex: 'sessions', claude: 'projects', qoder: 'projects', codebuddy: 'projects' };
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
      // 文件头部里可能有 cwd（工程路径）；读不到就留空，不猜（解析规则见 cwdOfHead）
      const cwd = cwdOfHead(p);
      out.push({
        id: path.relative(root, p),
        // 轴 2：这条落盘属于哪条会话（解析规则与实测依据见 sessionIdOfFile）
        sessionId: sessionIdOfFile(e.name, kind),
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
   * 两种来源之间有个例外（见下面的 cli 分支）：CLI 的会话 jsonl 与 reporter 状态文件
   * 说的是同一批会话，但 jsonl 那条路拿不到会话 id —— 两路一起列，同一条会话会显示成两条。
   * 所以**jsonl 优先，但只算"还活着的"**：这一层的 CLI 落盘扫到了 60 分钟窗口内还动过的
   * 会话，hook 那一路才整层跳过；一条活会话都没扫到（CodeBuddy CLI 的常见形态：只留 hook
   * 状态文件；或只剩陈旧 jsonl）就用状态文件兜底。
   */
  const products = detectProducts({});
  const seen = new Set();
  /** 这一层的 CLI 落盘到底扫出【活】会话没有（决定 hook 那一路要不要兜底，见上面的说明） */
  const cliLandingSeen = new Set();
  const claim = (floor, sessionId) => {
    if (!sessionId) return true;
    const k = `${floor}:${sessionId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  for (const p of products) {
    for (const src of p.sources) {
      // 只作落盘展示的那几路（kind 'dir'，如 5F 的 ~/.trae-cn 与 ~/.marscode）不产会话：
      // 目录里有东西，但读不出会话索引 —— 它们只进楼层悬浮提示，不进会话表。
      if (src.sessions === false) continue;

      // ---- 插件那一路：编辑器 globalStorage 的结构化落盘（genie-history / todos / …）----
      if (src.kind === 'plugin') {
        const st = listSessions({ workspacePath, force, client: src.client, pluginRe: p.pluginRe });
        if (!st.sessions || !st.sessions.length) continue;
        for (const s of st.sessions) {
          // 轴 2：插件的会话 id 就是 hook payload 的 session_id（实测 genie-history 的
          // conversationId 与状态文件里的 sessionId 一字不差）。带上它，同一层里多条会话
          // （CLI + Plugin 同时跑）才能各取各的实时相位 / 完成标记，不"谁最新显示谁"。
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
            // 只有它才配叠加实时相位，其余 current=true 的工程当前会话只用自己工程的上报，
            // 绝不借别人的相位冒充（否则切回旧会话会误显别的工程的"调用工具"）。
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
            // 这一轮是被打断（Interrupt）收掉的 → UI 亮「任务取消」，不亮「任务完成」
            doneCancelled: Boolean(s.doneCancelled),
            // 真值 / 推断由 sessions.js 的 sessionInfo 判定（reported → false），这里照搬，
            // 别写死 true——否则 reporter 上报的相位也会被 UI 当成「推断」灰显。
            inferred: Boolean(s.inferred),
            lastEventAt: s.lastUpdated || 0,
          });
        }
        continue;
      }

      // ---- hook 那一路：由 reporter 状态文件构成会话表 ----
      // 两个用途：① 5F TraeCode 两个形态都没有可扫的会话落盘，它是唯一来源；
      // ② 1F CodeBuddy CLI 的兜底 —— CLI 常常只留 hook 状态文件。
      // 但只要有 jsonl 可扫就不走这条（同一条会话两路都看得到时，只有 jsonl 那路拿不到
      // 会话 id，混着列会把一条会话显示成两条，见上面 refresh 的说明）。
      if (src.kind === 'hook') {
        if (cliLandingSeen.has(p.id)) continue;
      }

      // ---- Kilo 那一路（7F）：轮询 Kilo 自己的 SQLite 库 ----
      // Kilo 没有 hook 子系统，也没有可扫的会话 jsonl，会话 / 相位 / 完成标记都由
      // server/src/kilo.js 读 kilo.db 推导（与 8F OpenCode 同属轮询路线，取法不同：
      // 8F 的 event 表是空的，改读 session_message —— 各自认各自的 kind）。
      // 它与 cli / hook 两路形状不同（带真的相位与模型），所以单独一支，不塞进下面的
      // `rows` 三元里 —— 那两路只有"文件时间"这一个证据。
      if (src.kind === 'kilo') {
        for (const s of listKiloSessions()) {
          if (!claim(p.id, s.id)) continue;
          // "活着"用同一把尺子（TIMEOUT_MS），与 cli / hook 两路完全一致
          if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
          const ph = readKiloPhase(s.id) || null;
          // ---- 装了 WorkGremlin 插件吗？装了就用它上报的**真值** ----
          //
          // 7F 有两路：轮询（这一支，永远在场）与插件写的状态文件。真相位要压过轮询推导，
          // 但**不靠 sources 的顺序**（claim 先到先得，hook 那一支沿用老约定只报
          // 'unreported'，让它先 claim 反而信息更少），而是这一支自己去问一句。
          //
          // 两个 client 都要试：插件装在 VS Code 扩展上判出来是 kilo-plugin，
          // 装在 CLI / TUI 上判出来是 **kilo**（见 plugin/index.js 的 resolveClient）——
          // 只试前者的话「CLI 装了插件」这个组合的真相位就白写了。
          const wsOfSession = s.projectPath || workspacePath;
          const truth =
            reporterMainPhase(wsOfSession, clientOf('kilo', true), s.id) ||
            reporterMainPhase(wsOfSession, clientOf('kilo', false), s.id) ||
            null;
          // 完成标记同理：插件那份带改动文件清单（还带"被打断"标记），轮询那份只有计数。
          // 与相位同样两个 client 都试 —— 插件装在 CLI / TUI 上时上报身份是 kilo（不是 kilo-plugin），
          // 只问后者会把"CLI 装了插件"这条路的完成标记整条漏掉。
          const doneTruth =
            readReporterDone(wsOfSession, clientOf('kilo', true), s.id) ||
            readReporterDone(wsOfSession, clientOf('kilo', false), s.id);
          const donePoll = readKiloDone(s.id, s);
          upsert({
            floor: p.id,
            id: s.id,
            // 轴 2：Kilo 的 ses_xxx 就是它自己的 session_id（与 message.session_id、
            // event.aggregate_id、文件名 ses_f2261460….json 三处一致）
            sessionId: s.id,
            source: truth ? 'kilo-plugin' : 'kilo',
            /** 这一行来自哪一路：让"jsonl 优先"那套撤行逻辑认得出它不是 hook 行 */
            sourceKind: 'kilo',
            project: s.project,
            projectPath: s.projectPath,
            mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
            current: false,
            // Kilo 没有 hook 心跳；"活着"只看它自己的时间戳在 60 分钟窗口内
            live: true,
            // 相位：插件在 → 用它的真值（不标 inferred，UI 不灰显）；不在 → 用轮询推导的
            phase: truth ? truth.phase : ph ? ph.phase : 'unreported',
            action: truth ? truth.action || '' : ph ? ph.action : '',
            target: truth ? truth.target || '' : ph ? ph.target : '',
            tool: truth ? truth.tool || '' : ph ? ph.tool : '',
            context: truth ? truth.context || [] : ph ? ph.context : [],
            // 「思考中」屏上显示的那句用户原话。轮询这一路**也要给**（kilo.js 自己从库里取，
            // 见 readRoundPrompt）—— 早先这里只透传插件那份、轮询一律空串，于是没装插件时
            // 7F 的「思考中」一个字都没有（别的楼层都有，因为它们的 hook 写了 taskTitle）。
            prompt: truth ? truth.prompt || '' : ph ? ph.prompt || '' : '',
            // **只有轮询推导才标 inferred**（我们是轮询，不是它主动报的）；
            // 插件上报的是真值，标 true 会让 UI 把上报也灰显掉。
            inferred: !truth,
            // 完成标记：插件那份带 files 清单（还有 cancelled），没有才用轮询那份。
            // 原始 done 要转成会话行形状，否则 doneAt / doneCancelled 取不到（见 doneFieldsFromReporter）。
            ...(doneTruth && doneTruth.at ? doneFieldsFromReporter(doneTruth) : donePoll),
            lastEventAt: s.lastEventAt,
          });
        }
        continue;
      }

      // ---- OpenCode 那一路（8F）：轮询 OpenCode 自己的 SQLite 库 ----
      // 与 7F 同一类（不靠上报、单独一支、不塞进下面的 rows 三元），但**取法不同**：
      // OpenCode 2.0.18 的 event 表是空的（事件不落盘），所以 opencode.js 读的是
      // session_message 的 content[]，见那个文件头的分叉实测。
      //
      // 与 7F 的一个**能力差**（不是 bug，是 OpenCode 的落盘里根本没有这个信号）：
      // 轮询推不出「等待授权」—— 它的 tool 状态只有 completed/error/running。
      // 装了 WorkGremlin 插件时真相位由 hook 那一路补上（见 products.js 的 8F sources）。
      if (src.kind === 'opencode') {
        for (const s of listOpencodeSessions()) {
          if (!claim(p.id, s.id)) continue;
          // "活着"用同一把尺子（TIMEOUT_MS），与 cli / hook / kilo 四路完全一致
          if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
          const ph = readOpencodePhase(s.id) || null;
          // 完成标记：插件那一路写状态文件（带改动文件清单 + "被打断"标记），轮询那一路只有计数。
          // 两个 client 都试 —— 插件装在 CLI / TUI 上时身份是 opencode（不是 opencode-plugin）。
          const doneTruth =
            readReporterDone(s.projectPath || workspacePath, clientOf('opencode', true), s.id) ||
            readReporterDone(s.projectPath || workspacePath, clientOf('opencode', false), s.id);
          upsert({
            floor: p.id,
            id: s.id,
            // 轴 2：OpenCode 的 ses_xxx 就是它自己的 session_id（与 session_message.session_id、
            // 事件流 data.sessionID 三处一致）
            sessionId: s.id,
            source: 'opencode',
            /** 这一行来自哪一路：让"jsonl 优先"那套撤行逻辑认得出它不是 hook 行 */
            sourceKind: 'opencode',
            project: s.project,
            projectPath: s.projectPath,
            mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
            current: false,
            // OpenCode 没有 hook 心跳；"活着"只看它自己的时间戳在 60 分钟窗口内
            live: true,
            // 相位来自 opencode.js 对 session_message 的推导（见那里的新鲜度口径）——
            // 它是**推断**（我们是轮询，不是它主动报的），所以 inferred 一律 true。
            phase: ph ? ph.phase : 'unreported',
            action: ph ? ph.action : '',
            target: ph ? ph.target : '',
            tool: ph ? ph.tool : '',
            context: ph ? ph.context : [],
            // 「思考中」屏上那句用户原话（opencode.js 从 user 消息的 data.text 取；没有就空）
            prompt: (ph && ph.prompt) || '',
            // 模型从会话表取（真实值，取不到留空不猜）
            model: s.model || '',
            inferred: true,
            // 完成标记：插件那份（带 cancelled）优先，没有才用轮询那份
            // （轮询等价于"assistant 消息 finish=stop"，被打断的那轮见 opencode.js 的 idle.outcome）
            ...(doneTruth && doneTruth.at ? doneFieldsFromReporter(doneTruth) : readOpencodeDone(s.id, s)),
            lastEventAt: s.lastEventAt,
          });
        }
        continue;
      }

      // 两路产出的会话行同构（都只有文件时间 / 心跳时间，没有运行态）：
      // jsonl 路给出 projectPath（从文件头部的 cwd 解析，读不到就空）；
      // hook 路给出 workspacePath（hook payload 实测值）。
      const rows =
        src.kind === 'cli'
          ? scanCliSessions(src.dataPath, { kind: p.agent })
          : listReporterSessions(src.client).map((s) => ({
              id: s.sessionId,
              sessionId: s.sessionId,
              project: s.workspacePath ? resolveProjectName(s.workspacePath) || path.basename(s.workspacePath) : '',
              projectPath: s.workspacePath,
              lastEventAt: s.lastEventAt,
            }));
      // 判据得是"这一路扫到了【还活着】的会话"，而不是"扫到了任何行"。
      // 陈旧 jsonl（早已超过 60min 超时、马上要被 prune() 剔除）也算数会把 hook 兜底那一路
      // 整层让位，导致只有 hook 状态文件的正在跑会话连表都进不去、整层显示 0 会话
      // （见 mergedFloors.test.js [A4] 复现）。
      // "活着"与 prune / snapshot 用同一把尺子（TIMEOUT_MS = 60 分钟）；陈旧行本来也会被
      // prune 掉（snapshot 只列 active 的），所以连登记都不登记它们 —— 顺带避免它用
      // 会话 id 去 claim（那会让同名 id 的活会话在 claim 那一步被顶掉）。
      const live = rows.filter((r) => now - (Number(r.lastEventAt) || 0) < TIMEOUT_MS);
      // `cliLandingSeen` / 撤 hook 行**只由 CLI 落盘那一路决定**，判据挂在具体的 kind 上：
      //   · hook 那一路自己不是判据来源 —— 挂在通用的 rows/live 上，它每轮都会先把自己那几行
      //     删掉再重新 upsert（firstSeenAt 也跟着重置），语义上更是"让位给自己"；
      //   · 按 kind 判定与声明顺序无关：哪天把 sources 写成 ['hook', 'cli']，结论不变
      //     （hook 先登记、cli 那一趟再把它们撤掉；cli 没有活会话时 hook 正常留着）。
      if (src.kind === 'cli' && live.length) {
        cliLandingSeen.add(p.id);
        // 这一层以前可能正靠 hook 兜底列会话（见上面那段说明）：CLI 落盘现在有【活】会话了，
        // 就把那些 hook 行撤掉 —— 表按 `楼层:id` 存，一条会话的两路 id 不同，不会自动重合，
        // 不撤就会同一会话挂两行（一行 hook、一行 jsonl）。
        for (const [k, v] of table) if (v.floor === p.id && v.sourceKind === 'hook') table.delete(k);
      }

      for (const s of live) {
        const sessionId = s.sessionId || '';
        if (!claim(p.id, sessionId)) continue;
        const lastEventAt = s.lastEventAt;
        upsert({
          floor: p.id,
          id: s.id,
          // 轴 2：会话 id —— Claude 取 transcript 文件名、Codex 取 rollout 文件名的尾段、
          // TraeCode / CodeBuddy CLI 的 hook 那一路取状态文件里的 sessionId。
          // 渲染层拿它去问 `/api/v1/reporter-phase?session=`，就能只取这条会话的实时相位，
          // 不再"同一个 client 里谁最新就显示谁"。取不到（CodeBuddy CLI 的 jsonl 文件名不含 id）
          // → 空串，退回旧行为。
          sessionId,
          source: 'cli',
          /** 这一行具体来自哪一路（cli / hook）：让"jsonl 优先"规则能撤掉旧的 hook 行 */
          sourceKind: src.kind,
          project: s.project,
          projectPath: s.projectPath,
          mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
          current: false,
          live: true,
          // 相位不在这里造（项目铁律：绝不编造）：实时相位由 /reporter-phase 快轮询单独拉，
          // 这里老实报 phase:'unreported'（未上报），让渲染层在没有相位时显示「待命」。
          // CLI 落盘只有文件时间，于是把"文件多久前动过"写进 context —— 那是观测到的事实。
          phase: 'unreported',
          action: '',
          context:
            src.kind === 'cli' ? [`会话文件${formatAge(now - lastEventAt)}（本层未接 hook，不推断动作）`] : [],
          inferred: true,
          // 完成标记只认**这一路自己的 client**（CLI 那路 codebuddy、插件那路 codebuddy-plugin）：
          // 拿整层的 client 列表去查会把另一路刚收的工搬到这条头上（同工程、无会话 id 时尤其）。
          ...doneFieldsOf(s.projectPath, src.client, sessionId),
          lastEventAt,
        });
      }
    }
  }

  // 兜底合成的"取消"标记：去重后补发一次 task/end(cancelled)，把台账里卡在「进行中」的任务收掉。
  // cancels 由 readReporterDones 合成，来源是**用户真按了停止**的信号（Claude / Qoder：
  // transcript 尾部的打断标记，或 Claude 自己那份会话状态文件说 idle）—— 这些产品按停止时
  // 一个 hook 事件都不发，台账那行会一直挂在「进行中」。doneScans 在 refresh 开头已清空、
  // 本轮回填完，正好遍历它收集到的 cancels。
  flushSynthesizedCancels(doneScans, now);

  prune(now);
  lastScanAt = now;
  lastSnapshot = null;
}

/**
 * 把 readReporterDones 兜底合成的"打断"标记，去重后各发一次 task/end(cancelled)。
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
      const key = `${c.sessionId}|${c.taskId}|${c.workspacePath}|${c.at}`;
      if (postedCancels.get(key) > now) continue;
      /* 归属**从台账那行任务上取**，别拿状态文件里的字面量顶：bus.endTask 收的是
         工程 id + 成员 id（`<名字>@<工程id>`，见 bus.memberIdOf），而状态文件里只有
         工程**路径**（c.workspacePath）和客户端名（c.client）—— 直接传过去会算成
         `claude@/home/yinghui/work/WorkGremlin` 这种不存在的成员，endTask 当场返回
         unknown_member（不抛错），取消照旧收不了尾：任务永远挂在「进行中」、
         产出与改动文件整块丢。实测 2026-09-29：所有 cancelled 行 ended_at 全是 NULL。
         拿不到这一行（老数据 / 任务已被清）就不发 —— 绝不编造一个工程去写。 */
      const task = repo && repo.getTask ? repo.getTask.get(c.taskId) : null;
      if (!task) continue;
      postedCancels.set(key, now + 10 * 60_000);
      try {
        bus.endTask({
          project: task.project_id,
          memberId: task.member_id,
          taskId: c.taskId,
          state: 'cancelled',
          model: '',
          // 取消只是"没干完"，不是"没产出"：这一轮改过的文件与已经吐出来的收尾自述照常带上
          // （与 reporter 直接上报的取消标记同口径，见 sessions.js readReporterDones 的合成那段）。
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

module.exports = { snapshot, refresh, prune, TIMEOUT_MS, table, setBackend };
