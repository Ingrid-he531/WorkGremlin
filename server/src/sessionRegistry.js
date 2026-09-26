'use strict';

/**
 * sessionRegistry.js —— 全局活跃会话表。
 *
 * 一张表管所有智能体（楼层）在所有工程里开着的会话，跟当前打开哪个工程无关。
 * 表里每条记录 = 一个会话，按**楼层**（受监控产品）分组，超时就剔除：
 *
 *   3F CodeBuddy Plugin —— 结构化落盘（genie-history / todos / message-queue / file-changes），
 *                        拿得到运行态、待办清单、改动文件（见 sessions.js）
 *   1F CodeBuddy CLI、
 *   2F WorkBuddy CLI、
 *   4F Codex CLI、
 *   5F Claude Code CLI —— 落盘目录里的 *.jsonl 会话文件，只有文件时间可靠；
 *                        工程名从文件**头部若干行**里找 cwd，读不到就留空（不猜）。
 *                        注意不是"首行"：Claude 的首行是 mode / queue-operation 这类
 *                        元记录，压根没有 cwd，cwd 从第 3 行的 user 记录才有（见 cwdOfHead）
 *                        （Codex 的 cwd 藏在 payload.cwd 里，同样由 cwdOfHead 覆盖）
 *
 * 超时：一个会话 60 分钟没有事件（最后更新时间没往前走）就从表里移除。
 * 它被移除只是"不再活跃"，下次它又有动静会被当成新会话重新登记。
 *
 * 纪律（docs/requirements.md §P0-6「绝不编造」）：会话里没有职务 / 进度 / 耗时，
 * 一行都不补；阶段一律是推断值，带 inferred: true。
 */

const fs = require('node:fs');
const path = require('node:path');
const { listSessions, listReporterSessions, readReporterDones } = require('./sessions');
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
/** 本次扫盘里 (工程|客户端) -> readReporterDones 的结果；每次 refresh 重建。
 *  一个 CLI 楼层一次能扫出上百个历史会话文件，逐个去扫 hooks 目录太浪费，所以按 client 读一次盘。 */
let doneScans = new Map();

const SKIP = new Set(['node_modules', '.git', '.svn', 'cache', 'Cache', 'logs']);

function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
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
 * 老实现只读第一行，于是 5F **每一条**会话的工程都是空 —— 一个空值同时引出三个症状：
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
 *     取到 id 的收益是让 4F 的"完成"从"该工程最新"变成按会话精确（见 doneFieldsOf），
 *     渲染层的快轮询也会开始带 ?session=（相位同样受益）。
 *     失败是安全的：形状对不上就回空串 → 退回老行为，不会张冠李戴。
 *   - 其余产品（CodeBuddy / WorkBuddy CLI）：文件名不含会话 id，留空。
 * @param {string} name 文件名（含扩展名）
 * @param {string} kind 产品基名（products 的 agent：claude / codex / codebuddy …）
 * @returns {string} 会话 id；取不到回空串
 */
function sessionIdOfFile(name, kind) {
  if (kind === 'claude') return name.replace(/\.jsonl$/i, '');
  if (kind === 'codex') {
    const m = String(name).match(
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    );
    return m ? m[1] : '';
  }
  return '';
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
        // 子代理的 transcript 不是独立会话：它们住在 `<会话 id>/subagents/agent-<agentId>.jsonl`，
        // 和父会话共享同一个 sessionId（首行也带 cwd，所以"读首行判工程"会把它当成一条会话）。
        // 收进来的后果：一条会话配上多少个 subagent 就多出多少条"会话"，全是噪声。
        if (e.name === 'subagents') continue;
        walk(p, depth + 1);
        continue;
      }
      if (!/\.jsonl$/i.test(e.name)) continue;
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

/** 完成标记缺失时的统一返回值（没有就是"没有"，不臆造） */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [] };

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
 * 7F hookSource（listReporterSessions 本来就只列得出有 sessionId 的）。剩下 1F / 2F 两个
 * CLI 楼层的文件名不含 id；plugin 楼层（3F/6F）的会话行不带 sessionId（且它们的 doneAt
 * 另走 sessions.js 的 sessionInfo，不经过本函数）。
 *
 * 文件清单只有路径：hook 不做 diff，没有 +/- 行数（那是 plugin 落盘的 file-changes 才有的）。
 * @param {string} projectPath 会话所属工程（读状态文件时按它过滤）；**可能为空**，见下面的守卫
 * @param {string} client 客户端身份（楼层 dataKind，如 codex / trae）
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
   *   · 7F TraeCode IDE（hookSource）—— 会话一 Stop，hook 就把 sessionPhase 与
   *     taskWorkspacePath 一起清空（实测 sessionPhase:null、taskWorkspacePath:""），于是
   *     "有完成标记"与"工程归属非空"按构造互斥：守卫一开，7F 的「任务完成」永远不亮，
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

  // 插件楼层：每个 plugin 楼层各自读自己的落盘（client 不同，不能混）。
  // 以前这里写死 3F + 全局 PLUGIN_CLIENT（已删除）；现在遍历所有 plugin 楼层，
  // 6F TraeCode-Plugin 因此也有会话来源，未来加 Codex-Plugin 同理（只改 products.js）。
  const products = detectProducts({});
  for (const p of products) {
    if (p.kind !== 'plugin') continue;
    const st = listSessions({ workspacePath, force, client: p.dataKind, pluginRe: p.pluginRe });
    if (!st.sessions || !st.sessions.length) continue;
    for (const s of st.sessions) {
      upsert({
        floor: p.id,
        id: s.id,
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
        // 真值 / 推断由 sessions.js 的 sessionInfo 判定（reported → false），这里照搬，
        // 别写死 true——否则 reporter 上报的相位也会被 UI 当成「推断」灰显。
        inferred: Boolean(s.inferred),
        lastEventAt: s.lastUpdated || 0,
      });
    }
  }

  // 1F / 2F / 4F / 5F CLI：落盘目录里的 jsonl
  for (const p of products) {
    if (p.kind !== 'cli' || p.hookSource) continue;
    for (const s of scanCliSessions(p.dataPath, { kind: p.agent })) {
      const lastEventAt = s.lastEventAt;
      upsert({
        floor: p.id,
        id: s.id,
        // 轴 2：会话 id（`~/.claude/projects/<slug>/<session_id>.jsonl` 的文件名）。
        // 渲染层拿它去问 `/api/v1/reporter-phase?session=`，就能只取这条会话的实时相位，
        // 不再"同一个 client 里谁最新就显示谁"。Codex 拿不到（形状不同）→ 空串，退回旧行为。
        sessionId: s.sessionId || '',
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
        ...doneFieldsOf(s.projectPath, p.dataKind, s.sessionId || ''),
        lastEventAt,
      });
    }
  }

  // 只认 hook 的楼层（7F TraeCode IDE）：没有可扫的会话落盘，会话来源就是 reporter
  // 状态文件本身 —— sessionId 与工程路径都是 hook payload 的实测值（见 listReporterSessions）。
  for (const p of products) {
    if (!p.hookSource) continue;
    for (const s of listReporterSessions(p.dataKind)) {
      upsert({
        floor: p.id,
        id: s.sessionId,
        sessionId: s.sessionId,
        // 按 CLI 楼层对待：渲染层正是靠 `source === 'cli'` + 非空 projectPath 才肯叠加
        // hook 上报的实时相位（见 IsoOfficeView 的 canUseFast）。
        source: 'cli',
        project: s.workspacePath ? resolveProjectName(s.workspacePath) || path.basename(s.workspacePath) : '',
        projectPath: s.workspacePath,
        mine: Boolean(workspacePath && s.workspacePath && path.resolve(s.workspacePath) === path.resolve(workspacePath)),
        current: false,
        live: true,
        // 相位不在这里造：实时相位由 /reporter-phase 快轮询单独拉（1.5s），
        // 这里只报"未上报"，让渲染层在没有相位时老实显示「待命」。
        phase: 'unreported',
        action: '',
        context: [],
        inferred: true,
        ...doneFieldsOf(s.workspacePath, p.dataKind, s.sessionId),
        lastEventAt: s.lastEventAt,
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
