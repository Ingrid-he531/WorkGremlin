'use strict';

/**
 * 8F OpenCode 的数据源 —— 读它自己落盘的 SQLite（轮询那一路）。
 *
 * **为什么 8F 与 7F 不能照抄**：Kilo 与 OpenCode 同源（Kilo Code CLI 就是 OpenCode 的 fork），
 * 但**它们的 V2 schema 已经分叉**了。实测 2026-09-26（Kilo Code 7.8.1 / OpenCode 2.0.18）：
 *
 *                        Kilo 7.8.1            OpenCode 2.0.18
 *   事件流 event 表       2288 行（落盘）        **0 行**（只在内存里推流，不落盘）
 *   消息                 message(135)+part(650)  session_message(119)，无 part 表
 *   会话表               session                 session_v2（多 time_idle/idle_outcome/time_suspended）
 *   独有表               todo / kilo_board / …   session_inbox / session_pending / instruction_* / permission
 *
 * 所以 7F 那套"从 `event` 表的 part 推导相位"（见 kilo.js 的 readKiloPhase）**在 OpenCode 上
 * 根本没有数据可读** —— 它的 `event` 表是空的（`event_sequence` 里有计数，但事件本身不落盘）。
 * 8F 改从 `session_message` 的 `content[]` 取 part，形状与 Kilo 的 part **同构**：
 *
 *   session_message(id, session_id, type, seq, time_created, time_updated, data)
 *     type  ∈ assistant | user | idle | synthetic
 *     data  = { time:{created,streamed,completed}, agent, model, content:[part], finish, cost, tokens, snapshot }
 *     part  ∈ { type:'tool',     name, state:{ status, input } }
 *            { type:'reasoning', text }
 *            { type:'text',      text }          ← 全库实测就这三种，没有 patch
 *     tool 的 state.status ∈ **completed | error | running**（全库 114 条 assistant 消息实测）
 *
 * **一个必须写下来的实测结论**：Kilo 的 `state.status` 有 `pending`（= 等授权），**OpenCode 没有** ——
 * 全库只出现过 completed / error / running。所以**纯轮询永远推不出「等待授权」**：
 * OpenCode 把授权做成了独立事件（实测事件流里有 `permission.asked` / `permission.replied`，
 * 载荷 `{ id, sessionID, action, resources[], source:{type,messageID,id} }`），那个信号只在
 * 内存事件流里、不进库。这就是 8F 额外挂一路**插件**的硬理由（见 packages/reporter/src/plugin/）：
 * 装了插件，相位是**上报真值**（不标 inferred、UI 不灰显），并且能显示「等待授权」；
 * 没装插件就退回下面这套轮询推导，代价是相位按推断灰显、且没有「等待授权」。
 *
 * 相位推导（从最新一条消息的 content[] 往后找第一条有信号的 part）：
 *   tool + running   → 调用工具（工具名/命令从 part.state.input 取）
 *   tool + error     → 调用工具但报错了
 *   reasoning        → 思考中
 *   text             → 待命（刚吐完一段文字）
 *   finish=stop      → 待命（这一轮说完了）
 *   type=idle 行     → 待命（**显式**空闲标记，data.outcome ∈ succeeded | interrupted）
 *   都对不上 / 事件过旧 → 待命
 *
 * **纪律（对齐 requirements.md §P0-6「绝不编造」）**：轮询这一路的一切相位都带 `inferred: true`。
 * 我们是**轮询**读它的库，不是它主动上报的，"上一条消息长什么样"只能推断"现在大致在干嘛"。
 * UI 按"推断"灰显，与 5F / CLI 落盘楼层同等待遇。
 *
 * 读法上三条纪律（与 kilo.js 一致）：
 *   1) **一律只读打开**（readonly + fileMustExist）。OpenCode 正在写这个库（WAL 模式，实测
 *      它跑着的时候读没问题），只读连接不阻塞它、也不会被它写坏；读不到就当"没数据"，绝不写。
 *   2) **短超时**（3s）。被它的 checkpoint / 迁移占住时立刻放弃 —— 宁可这一轮没有相位，
 *      也不能把 /api/v1/sessions 拖死（渲染层 1.5s 轮询一次）。
 *   3) **扫表失败不许冒泡**。这是别的产品的私有存储，OpenCode 改版换表名是迟早的事（Kilo →
 *      OpenCode 就已经换过一次：session → session_v2）；读不出来就回空，让 8F 显示"没接上"，
 *      而不是把接口打成 500。
 *
 * 缓存：会话表 5s（与 sessions.js / sessionRegistry 的 TTL 同量级）。
 * 相位与完成标记**不缓存** —— 渲染层 1.5s 拉一次，宁可每次多读一次库。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, clientOf } = require('@workgremlin/shared');
const { openReadonly, readOne } = require('./dbReadonly');
const { resolveProjectName } = require('./project');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

/**
 * 8F OpenCode 楼层元数据（原 products.js 的 8F 条目）。CLI 与桌面端/网页端合并楼层。
 */
const meta = {
  id: '8F',
  name: 'OpenCode',
  kind: 'cli',
  cmd: 'opencode',
  agent: 'opencode',
  plugin: false,
  sources: [
    {
      kind: 'opencode',
      label: 'CLI/Desktop',
      client: clientOf('opencode', false),
      dirs: [opencodeHome()],
      note: '这一路读的是数据根里的 opencode.db（SQLite，session_message 表），不是可扫的会话文件；文件数/体积是数据根的落盘统计，不是会话数',
    },
    // hook 那一路：装了 WorkGremlin 插件时的真相位一路（client = opencode-plugin）。
    { kind: 'hook', client: clientOf('opencode', true) },
  ],
  hookSource: true,
  dataKind: clientOf('opencode', false),
  // OpenCode CLI 自己的安装目录（PATH 查不到时兜底）
  cliBinDirs: [path.join(HOME, '.opencode', 'bin')],
};

/** 打开只读连接的超时；被 OpenCode 占住就放弃这一轮 */
const OPEN_TIMEOUT_MS = 3_000;
/** 会话表缓存（会话变化比相位慢，5s 足够；与 sessionRegistry 的 TTL 同量级） */
const TTL = 5_000;

let cache = { at: 0, key: '', value: null };

/* ------------------------------ 定位落盘 ------------------------------ */

/**
 * OpenCode 的数据根（XDG 规范，平台标准目录，不是 ~/.opencode 那种隐藏目录）。
 *
 * 认三个来源，优先级从高到低：
 *   1. `WORKGREMLIN_OPENCODE_HOME` —— 显式指定（测试 / 非标准安装 / 用户自己挪过盘）
 *   2. `XDG_DATA_HOME/opencode`   —— XDG 标准位置
 *   3. 平台默认（见下）
 *
 * `~/.opencode` **不是**数据根：实测那个目录下只有 `bin/opencode`（可执行文件本体），
 * 会话、日志、快照、SQLite 全都在数据根下。把它当落盘会显示成"装了但 0 个会话"。
 */
function opencodeHome() {
  const env = String(process.env.WORKGREMLIN_OPENCODE_HOME || '').trim();
  if (env) return path.resolve(env);
  const xdg = String(process.env.XDG_DATA_HOME || '').trim();
  if (xdg) return path.join(path.resolve(xdg), 'opencode');
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'opencode');
  }
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'opencode');
  }
  return path.join(HOME, '.local', 'share', 'opencode');
}

/** 会话库的绝对路径；文件不存在回空串（OpenCode 没装 / 没跑过） */
function opencodeDbPath() {
  const explicit = String(process.env.WORKGREMLIN_OPENCODE_DB || '').trim();
  const p = explicit ? path.resolve(explicit) : path.join(opencodeHome(), 'opencode.db');
  try {
    return fs.statSync(p).isFile() ? p : '';
  } catch {
    return '';
  }
}

/**
 * 会话标题（8F OpenCode）：SQLite session 的 title 列（OpenCode 各版本列名不一，自适应）。
 * 原 sessionTitle.js 的 opencodeTitleOf 搬到这里 —— 调试 8F 标题不必碰中央文件。
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function sessionTitle(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const db = openReadonly(opencodeDbPath());
  if (!db) return '';
  try {
    let titleCol = '"title"';
    const cols = readOne(db, "PRAGMA table_info('session')");
    const hasTitle = Array.isArray(cols) ? cols.some((c) => String(c.name || '').toLowerCase() === 'title') : false;
    if (!hasTitle) {
      const row = readOne(db, 'SELECT * FROM session WHERE id = ? LIMIT 1', id);
      if (row && typeof row === 'object') {
        const keys = Object.keys(row).filter((k) => /title/i.test(k));
        if (keys.length) titleCol = `"${keys[0]}"`;
      }
    }
    const row = readOne(db, `SELECT ${titleCol} AS t FROM session WHERE id = ?`, id);
    return String((row && row.t) || '').trim();
  } catch {
    return '';
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** 把绝对路径缩成 ~ 开头（UI 里好读） */
function shorten(p) {
  if (!p) return '';
  if (HOME && p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}

/* ------------------------------ 只读连接 ------------------------------ */

/**
 * 开一个**只读**连接；拿不到（没装 / 没跑过 / 库被锁 / 表结构变了）一律回 null。
 *
 * 只读是硬要求，不是省事：OpenCode 正在写这个库，我们绝不能因为一个监控端去锁它、
 * 也绝不能把它写坏。WAL 模式下只读连接不阻塞写入方，两者可以并存（实测它跑着时读没问题）。
 */
function openDb() {
  const file = opencodeDbPath();
  if (!file) return null;
  let Database;
  try {
    // better-sqlite3 是 server 的既有依赖（见 server/src/db/index.js），走工作区那份，
    // 不在适配器里自己编译一份原生模块。
    Database = require('better-sqlite3');
  } catch {
    return null; // 原生模块没编出来：8F 读不了，其余楼层照常
  }
  try {
    return new Database(file, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * 在只读连接上跑一个回调；表不存在 / SQL 不对（改版换表）都回 null。
 * @param {(db: any) => any} fn
 * @returns {any|null}
 */
function query(fn) {
  const db = openDb();
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null; // 读不出来就是"没数据"，不冒泡（见文件头纪律 3）
  } finally {
    try {
      db.close();
    } catch {
      /* 关不掉无所谓，已经拿到结果 */
    }
  }
}

/**
 * 会话表叫 `session_v2`（2.0.18 实测），但老版本是 `session`，Kilo 至今还是 `session` ——
 * 两个都认，按优先级探，谁存在用谁。写死一个名字就等于把 8F 绑死在某个版本上。
 * @param {any} db
 * @returns {string} 表名；一个都没有回空串
 */
function sessionTable(db) {
  let names = [];
  try {
    names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => String(r.name || ''))
    );
  } catch {
    return '';
  }
  for (const t of ['session_v2', 'session']) if (names.has(t)) return t;
  return '';
}

/** 库里到底有没有这些表 —— 用来给前端一句"这一路读不出会话"的说明 */
function hasCoreTables() {
  return (
    query((db) => {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session','session_message')")
        .all()
        .map((r) => String(r.name || ''));
      const hasSession = names.includes('session_v2') || names.includes('session');
      return hasSession && names.includes('session_message');
    }) === true
  );
}

/* ------------------------------ 会话清单 ------------------------------ */

/** 库里 model 字段是 JSON 字符串，取出 id 给人看（取不到就留空，不猜） */
function modelIdOf(raw) {
  try {
    const j = JSON.parse(String(raw || ''));
    return String((j && (j.id || j.modelID)) || '');
  } catch {
    return '';
  }
}

/**
 * OpenCode 的全部会话（未归档、未挂起），按最近更新倒序。
 *
 * 过滤口径：
 *   `time_archived IS NULL` —— 归档掉的会话不算"在跑"（用户手动归档之后会打这个时间戳）。
 *   `parent_id IS NULL`    —— 子代理会话不是独立会话：它们 parent_id 指向父会话，和父会话
 *                            同属一个"工位"。收进来的话，一个主会话配 N 个子代理就多出 N 条
 *                            会话，全是噪声（与 sessionRegistry 的 scanCliSessions 跳过
 *                            `<会话 id>/subagents/` 同一个道理）。
 *
 * **刻意不过滤 `time_suspended`**（实测这个列会有值，会话被暂停/恢复时打上）：挂起是**临时**状态，
 * 恢复后 time_updated 会继续推进、这条会话本来就该重新出现在办公室里。用它当过滤条件等于
 * 让一条真实会话被永久藏起来 —— 宁可让它以"待命"出现，也不要假装它不存在。
 * （7F 的 kilo.js 同样只过滤 time_archived，两层口径保持一致。）
 *
 * 字段映射（→ sessionRegistry 的会话行）：
 *   id → 会话 id（轴 2，`ses_xxx` 就是 hook 意义上的 session_id）
 *   directory → 工程路径（每条会话都记了自己的工作目录，比 project.worktree 更准 ——
 *               worktree 子会话跑在别处时 directory 才是真的）
 *   time_updated → 最后活动时间（每写一条消息都推进它，比翻文件时间准）
 *
 * 列是**探测**着拼的（下面 pickSessionColumns）：少一列不该让整条查询失败、也不该让整层 500。
 *
 * **议事厅的参与者不进这张表**（`title = COUNCIL_SESSION_TITLE` 的直接跳过）：理由与
 * 7F 那边一字不差，见 kilo.js 同名过滤上方的说明。这里多一条：title 列也是探测着用的，
 * 老库没有 title 列时**不过滤**（宁可多列出一条真会话，也不能因为少一列就把整层清空）。
 *
 * @returns {Array<{id,title,directory,project,projectPath,lastEventAt,agent,model,fileCount,additions,deletions}>}
 */
function listOpencodeSessions() {
  const now = Date.now();
  const file = opencodeDbPath();
  // 缓存按**库文件路径**分键：换 OPENCODE_HOME / 换库时不会把上一处的会话端上来。
  // 读不出来（没装 / 被锁 / 表结构变了）时缓存空清单，别让每 1.5s 的轮询都去撞一次锁。
  if (cache.value && cache.key === file && now - cache.at < TTL) return cache.value;
  const value = listOpencodeSessionsUncached();
  cache = { at: now, key: file, value };
  return value;
}

function listOpencodeSessionsUncached() {
  const rows = query((db) => {
    const table = sessionTable(db);
    if (!table) return null;
    const cols = pickSessionColumns(db, table);
    if (!cols.has('id')) return null;

    const want = ['id', 'title', 'directory', 'agent', 'model', 'time_updated', 'summary_files', 'summary_additions', 'summary_deletions'];
    const sel = want.filter((c) => cols.has(c)).map((c) => `"${c}"`).join(', ');

    const where = [];
    if (cols.has('time_archived')) where.push('"time_archived" IS NULL');
    if (cols.has('parent_id')) where.push('"parent_id" IS NULL');
    // 议事厅参与者：老库没有 title 列时不做这个过滤（宁可多列出一条，也不清空整层）。
    // 它排在最后，所以下面的参数数组只放这一个值。
    const skipCouncil = cols.has('title');
    if (skipCouncil) where.push('("title" IS NULL OR "title" <> ?)');
    const params = skipCouncil ? [DEFAULTS.COUNCIL_SESSION_TITLE] : [];
    const order = cols.has('time_updated') ? '"time_updated" DESC' : 'rowid DESC';

    return db
      .prepare(`SELECT ${sel} FROM "${table}"${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`)
      .all(...params);
  });

  return (Array.isArray(rows) ? rows : []).map((r) => {
    const dir = String(r.directory || '');
    return {
      id: String(r.id || ''),
      title: String(r.title || ''),
      directory: dir,
      project: dir ? resolveProjectName(dir) || path.basename(dir) : '',
      projectPath: dir,
      lastEventAt: Number(r.time_updated) || 0,
      agent: String(r.agent || ''),
      model: modelIdOf(r.model),
      fileCount: Number(r.summary_files) || 0,
      additions: Number(r.summary_additions) || 0,
      deletions: Number(r.summary_deletions) || 0,
    };
  });
}

/** 这个会话表实际有哪些列（少列不该让整层 500，见函数说明） */
function pickSessionColumns(db, table) {
  try {
    return new Set(
      db
        .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
        .all()
        .map((r) => String(r.name || ''))
    );
  } catch {
    return new Set();
  }
}

/* ------------------------------ 相位推导 ------------------------------ */

/**
 * 一条会话的**当前相位**（轮询推导，带 inferred）。
 *
 * 取这条会话最后几条消息（`session_message` 按 (session_id, seq) 有唯一索引，取尾部很便宜），
 * 从新往旧找**第一条带信号的**：
 *
 *   tool + running → 调用工具（工具名/实际命令从 part.state.input 取）
 *   tool + error   → 调用工具但报错了
 *   reasoning      → 思考中
 *   text           → 待命（刚吐完一段文字）
 *   finish=stop    → 待命（这一轮说完了）
 *   type=idle 行   → 待命（**显式**空闲标记；data.outcome ∈ succeeded | interrupted）
 *   对不上 / 过旧  → 待命
 *
 * **没有「等待授权」**：OpenCode 的 tool 状态实测只有 completed / error / running，授权是独立的
 * `permission.asked` 事件、只在内存事件流里。轮询这一路给不出等待授权 —— 那一相位由插件补
 * （见文件头）。宁可少一个相位，也不拿 tool+running 冒充"在等授权"。
 *
 * **只认"新鲜"证据**：一轮对话结束后最后那条消息会一直躺在库里，不看新鲜度就会把三天前
 * 收工的那句回复永远显示成"刚刚在说话"。要求时间落在 `PHASE_FRESH_MS`（2 分钟，与
 * sessions.js 的 FRESH_MS 同量级）之内，超了就是待命。
 *
 * @param {string} sessionId
 * @returns {{phase:string,action:string,target:string,tool:string,context:string[],prompt:string,model:string,inferred:boolean}|null}
 */
const PHASE_FRESH_MS = 2 * 60_000;
/** 往回看多少条消息够用（一轮对话末尾最多 tool→reasoning→text 几条，64 条极宽裕） */
const PHASE_LOOKBACK = 64;
/**
 * 会**写文件**的 OpenCode 工具名。实测（2.0.18）它家工具是 read / grep / glob / shell /
 * edit / subagent —— 写文件的就叫 `edit`（入参 `state.input.path`）。只认这些，读类不算改动。
 */
const OPENCODE_WRITE_TOOL_RE = /edit|write|patch|create|apply|insert|replace/i;

function readOpencodePhase(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  // 「思考中」屏上那句用户说的话：OpenCode 把原话放在 user 消息的 data.text（**不在** content[] 里，
  // content[] 只有 assistant 的 reasoning/text/tool）。以前一律回空串，所以主控制台只有
  // "思考中"、一个字都没有（实测 2026-09-28）。
  const prompt = lastUserText(id);
  const out = (r) => (r && !r.prompt ? { ...r, prompt } : r);
  const rows = query((db) =>
    db
      .prepare(
        `SELECT type, time_created, data FROM session_message
          WHERE session_id = ?
          ORDER BY seq DESC LIMIT ?`
      )
      .all(id, PHASE_LOOKBACK)
  );
  if (!Array.isArray(rows) || !rows.length) return null;

  const now = Date.now();
  for (const row of rows) {
    // **显式空闲标记**：OpenCode 每轮结束会写一行 type='idle'（data = {time, outcome}）。
    // 它比"从 part 猜"更直接：有它就是待命，不用再看更旧的行。
    if (String(row.type || '') === 'idle') {
      const at = idleAt(row);
      if (at && now - at > PHASE_FRESH_MS) break;
      return out(idle());
    }
    // 轮次刚开跑：最新一条是 **user** 消息（assistant 行还没写出来），或者 assistant 行还没
    // 写出内容 —— 那都是"模型正在想"，不是待命。实测 2026-09-28：缺了这条，用户发完消息后
    // 那十几秒主控制台是"待命"，整轮看不到"思考中"（采样区间只有 tool → idle 在来回切）。
    // 注意它是"新到旧"扫的：真收工的轮次会先撞到更新的 idle 行，不会走到这里。
    if (String(row.type || '') === 'user') return out(thinking());

    let data = {};
    try {
      data = JSON.parse(String(row.data || ''));
    } catch {
      data = {}; // 半截 / 非 JSON：跳过这一条，不猜
    }
    if (!data || typeof data !== 'object') continue;

    // 这一条消息的时间：优先 completed（说完了），其次 streamed（正在流），最后 created。
    // 正在跑工具的那条只有 created/streamed，没有 completed —— 别因为缺 completed 就当陈旧。
    const tm = data.time && typeof data.time === 'object' ? data.time : {};
    const at = Number(tm.completed) || Number(tm.streamed) || Number(tm.created) || Number(row.time_created) || 0;
    // 从新到旧，第一条过期的就说明这一轮早收工了（更旧的更没意义）
    if (at && now - at > PHASE_FRESH_MS) break;

    const parts = Array.isArray(data.content) ? data.content : [];
    // 这条 assistant 消息**写完了没有**（time.completed 落了才算写完）。
    // 它决定 text part 的含义，见下面 text 分支。
    const completed = Boolean(tm.completed);
    const finish = String(data.finish || '');
    // 从后往前找第一条有信号的 part（同一条消息里既有 reasoning 也有 tool 时，
    // 越靠后的越是"现在正在做的"）
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type || '');
      if (type === 'text') {
        // 还没写完（没有 completed）= 正在往外吐字 → **思考中**，不是待命。
        // 实测 2026-09-28：把流中的 text 当待命，主控制台会一直停在"任务完成"上，
        // 整轮都看不到"思考中"（这一轮 parts 是 [reasoning, text]，从后往前先撞到 text）。
        // 与 7F 那次同一个坑（见 kilo.js 的 readKiloPhase）。
        if (!completed) return out(thinking());
        // 写完了但还要接着调工具（finish=tool-calls）→ 这一条不算收口，继续看更早的 part / 行
        if (finish === 'tool-calls') continue;
        return out(idle());
      }
      if (type === 'reasoning') return out(thinking());
      if (type !== 'tool') continue;

      // OpenCode 的工具块：工具名在 part.name（不是 Kilo 的 part.tool），入参在 state.input
      const tool = String(part.name || '');
      const status = String((part.state && part.state.status) || '');
      const input = part.state && part.state.input && typeof part.state.input === 'object' ? part.state.input : {};
      /**
       * 这一段算不算"正在用工具"：
       *   · status=running          → 无疑（工具还在跑）
       *   · status=completed 且这一步 finish=tool-calls → **也算**
       *     OpenCode 是一步一条 assistant 消息：模型这一步以"要调工具"收尾（finish=tool-calls），
       *     然后它去跑工具、再开下一步。而工具块落盘时常常已经跑完（`read` 这种毫秒级），
       *     所以只认 running 会几乎永远看不到"调用工具"（实测 2026-09-28：一整轮 10 次工具调用，
       *     1.5s 采样只撞到 1 帧）。"这一步以调工具收尾、下一步还没出现" = 就是在用工具。
       */
      const stepCallsTool = finish === 'tool-calls' && status !== 'error';
      if (status === 'running' || (status === 'completed' && stepCallsTool)) {
        return out({
          phase: 'tool',
          action: commandOf(input) || `调用 ${tool || '工具'}`,
          target: fileOf(input),
          tool,
          context: tool ? [`工具：${tool}`] : [],
          prompt: '',
          model: '',
          inferred: true,
        });
      }
      if (status === 'error') {
        return out({
          phase: 'tool',
          action: tool ? `调用 ${tool} 报错` : '调用工具报错',
          target: fileOf(input),
          tool,
          context: ['上一支工具执行失败'],
          prompt: '',
          model: '',
          inferred: true,
        });
      }
      // completed：这一支跑完了，看同一条消息里更早的 part（可能还有下一个工具）
    }

    // 这条消息的 part 都对不上 → 看它有没有"说完了"（finish=stop 是正常收尾）
    if (finish && finish !== 'tool-calls') return out(idle());
  }
  return out(idle());
}

/** 轮询推导的"待命"（统一出口，方便以后加文案只改一处） */
function idle() {
  return { phase: 'idle', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
}

/** 轮询推导的"思考中" */
function thinking() {
  return { phase: 'thinking', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
}

/** type='idle' 那行的时间（data.time.created） */
function idleAt(row) {
  try {
    const d = JSON.parse(String(row.data || ''));
    return Number(d && d.time && d.time.created) || Number(row.time_created) || 0;
  } catch {
    return Number(row.time_created) || 0;
  }
}

/**
 * 这条会话**最后一条用户消息的原话**（`type='user'` 的 `data.text`）。
 * 取不到回空串 —— 宁可空屏，不拿会话标题顶替。
 * @param {string} sessionId
 */
function lastUserText(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const row = query((db) =>
    db
      .prepare(`SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT 1`)
      .get(id)
  );
  if (!row) return '';
  try {
    const d = JSON.parse(String(row.data || ''));
    return String((d && d.text) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch {
    return '';
  }
}

/**
 * 这条会话**逐轮**的任务清单（8F 台账按"每一轮一条"记账用）。
 *
 * OpenCode 的 `session_message` 是顺序消息流：一轮 = 一条 `type='user'`（`data.text` 是用户原话，
 * `time.created` 是这一轮开始）→ 若干 `type='assistant'`（`time.completed` 是它说完的时刻，
 * `content[].state.input.path` 里是它编辑过的文件）→ 一条 `type='idle'`（这一轮显式收工）。
 * 所以：
 *   · 有 idle 行 = 收工（endedAt = 那一轮最后一次活动时刻）
 *   · 没有 idle、但最后活动在 PHASE_FRESH_MS 之外 = 也算收工（避免"永远在跑"）
 *   · 否则 = 还在飞（endedAt = null）—— 和其它楼层同口径，running 由台账同步器写
 *
 * `read_file`/`grep`/`glob`/`shell` 这些**不算改动文件**，只认写工具（OpenCode 实测叫 `edit`）。
 *
 * @param {string} sessionId
 * `outcome`：这一轮怎么结束的 —— OpenCode 的 idle 行写了 `succeeded` / `interrupted`；
 * 没有 idle 行而已经陈旧的，按最后一条 assistant 的 `finish` 判断（`stop` = 正常收尾，
 * 其余 = 被打断/放弃）。台账据此区分「完成」与「已取消」——实测 2026-09-28：用户终止了
 * 一轮（idle.outcome = interrupted），台账却报「完成」。
 *
 * `result`：这一轮的**收尾自述**（这一轮最后一条 assistant 消息里的 text，压空白后截断）——
 * 任务记录里的"产出摘要"就用它（与 hook 那一路同口径，上限 4000）。
 *
 * @returns {Array<{index:number, prompt:string, startedAt:number, endedAt:number|null,
 *                  outcome:string, files:string[], result:string}>}
 */
/** 非负数才认（与 reporter/src/usage.js 的 num 同口径：缺字段就是没有，不拿别的顶上） */
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 这份累计里真有数吗 —— 四项全 0 就是"没读到"，不是"消耗为零"（见调用处的 return） */
function hasTokens(t) {
  return Boolean(t) && t.input + t.output + t.cacheRead + t.cacheWrite > 0;
}

/**
 * 把一条 assistant 消息的 `data.tokens` 折进本轮的累计。
 *
 * 形状与语义**同 7F Kilo**（`{input, output, reasoning, cache:{read,write}}`，`input` 不含缓存、
 * `reasoning` 单列）—— 两家同源，OpenCode 只是没有 `total` 那一项（实测 314 条消息全都没有，
 * 所以这里也没法用它自校验）。会话表 `session_v2.tokens_*` 是这些消息的累加
 * （实测 277,421 vs 消息求和 277,410，差 11：最后一条还没并进会话计数器）。
 *
 * `reasoning` 并进 `output`，与 7F 及 Claude / Codex 保持同一列口径（理由见 kilo.js 同名函数）。
 * @param {{input:number,output:number,cacheRead:number,cacheWrite:number}} acc 本轮累计（原地改）
 * @param {any} t 一条消息的 data.tokens（形状不对就当没有）
 */
function foldOpencodeTokens(acc, t) {
  if (!t || typeof t !== 'object') return acc;
  const cache = t.cache && typeof t.cache === 'object' ? t.cache : {};
  acc.input += posNum(t.input);
  acc.output += posNum(t.output) + posNum(t.reasoning);
  acc.cacheRead += posNum(cache.read);
  acc.cacheWrite += posNum(cache.write);
  return acc;
}

function readOpencodeTurns(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  const rows = query((db) =>
    db
      .prepare(`SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC`)
      .all(id)
  );
  if (!Array.isArray(rows) || !rows.length) return [];

  const turns = [];
  let cur = null;
  for (const row of rows) {
    let d = {};
    try {
      d = JSON.parse(String(row.data || ''));
    } catch {
      d = {};
    }
    if (!d || typeof d !== 'object') d = {};
    const type = String(row.type || '');
    const tm = d.time && typeof d.time === 'object' ? d.time : {};
    const at = Number(tm.completed) || Number(tm.streamed) || Number(tm.created) || Number(row.time_created) || 0;

    if (type === 'user') {
      if (cur) turns.push(cur);
      cur = {
        index: turns.length,
        prompt: String(d.text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        startedAt: Number(tm.created) || at,
        lastAt: at,
        files: new Set(),
        closed: false,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      continue;
    }
    if (!cur) continue; // 会话开头不是 user 行的，不编一轮
    // 这一轮已经收工（idle 行已到）：它之后的 assistant / synthetic 行都**不算它的**，
    // 否则收工时间会被后面那条 synthetic（系统提醒）顶到下一轮的头上（实测把 14:19 收工的
    // 那轮算成了 17:14，凭空多出 3 小时）。
    if (cur.closed) continue;
    if (at) cur.lastAt = Math.max(cur.lastAt, at);
    if (type === 'idle') {
      cur.closed = true;
      cur.outcome = String(d.outcome || 'succeeded');
      continue;
    }
    if (type === 'assistant') {
      const fin = String(d.finish || '');
      if (fin) cur.finish = fin;
      // 本轮的 token 消耗：assistant 消息的 data.tokens 逐条累加（user / idle 行没有这一项）
      foldOpencodeTokens(cur.tokens, d.tokens);
      // 这一轮的收尾自述：取 assistant 消息里的 text（后面的消息会覆盖前面的，
      // 所以最终留下的是"最后那条消息说的话"）。压空白 + 上限 4000，与 hook 那一路同口径。
      const said = (Array.isArray(d.content) ? d.content : [])
        .filter((p) => p && p.type === 'text' && p.text)
        .map((p) => String(p.text))
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();
      if (said) cur.result = said.slice(0, 4_000);
      for (const part of Array.isArray(d.content) ? d.content : []) {
        if (!part || typeof part !== 'object' || String(part.type || '') !== 'tool') continue;
        if (!OPENCODE_WRITE_TOOL_RE.test(String(part.name || ''))) continue;
        const input = (part.state && part.state.input) || {};
        const fp = String(input.path || input.filePath || input.file_path || '').trim();
        if (fp) cur.files.add(fp);
      }
    }
  }
  if (cur) turns.push(cur);

  const now = Date.now();
  return turns.map((t) => {
    const stale = now - t.lastAt > PHASE_FRESH_MS;
    const ended = t.closed || stale;
    // 收工的方式：idle 行说了算；没有 idle 行（陈旧收口）就看最后一条 assistant 的 finish
    const outcome = !ended ? 'running' : t.closed ? t.outcome || 'succeeded' : t.finish === 'stop' ? 'succeeded' : 'interrupted';
    return {
      index: t.index,
      prompt: t.prompt,
      startedAt: t.startedAt || t.lastAt,
      endedAt: ended ? t.lastAt || null : null,
      outcome,
      files: [...t.files],
      result: t.result || '',
      // 本轮消耗的 token（语义见 foldOpencodeTokens）。四项全 0 = 没读到 → null，台账留空
      tokens: hasTokens(t.tokens) ? t.tokens : null,
    };
  });
}

/** 工具入参里的可读命令（OpenCode 的 shell 工具叫 `shell`，入参是 command） */
function commandOf(input) {
  const c = String(input.command || '');
  if (c) return c.replace(/\s+/g, ' ').trim().slice(0, 120);
  const d = String(input.description || '');
  return d.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 工具入参里的目标文件（实测 OpenCode 的 read 工具用 `path`，各家字段名不统一，都认一遍） */
function fileOf(input) {
  const p = input.file || input.filePath || input.file_path || input.path || input.target_file || '';
  return typeof p === 'string' ? p : '';
}

/* ------------------------------ 完成标记 ------------------------------ */

/** 完成标记的新鲜期：只有这么久之内结束的才算"刚发生"，否则页面一开就重播上一轮 */
const DONE_TTL_MS = 10 * 60_000;
/** 完成标记缺省时统一返回（没有就是"没有"，不臆造）。
 *  doneCancelled：这一轮是被用户打断（ESC / 停止）收掉的 → 主控制台亮红色「任务取消」。 */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false };

/**
 * 这条会话的"完成"标记 —— 对应 hook 那边 Stop 事件落下的 done。
 *
 * OpenCode 没有 Stop 事件，但 `session_message` 里有等价的东西：一条 `type='assistant'`、
 * `finish='stop'` 且 `time.completed` 落过的消息。语义映射（与 OpenAI 风格一致，全库实测
 * finish 只出现过 stop / tool-calls / error 三种）：
 *   finish=stop        → 正常说完，**这就是"任务完成"**
 *   finish=tool-calls  → 还要接着调工具，**不是**完成（跳过）
 *   finish=error       → 出错结束，不当完成
 *   finish 为空         → 还在流式输出中，不是完成
 *
 * 只认 `time.completed` 落过且在 DONE_TTL_MS 之内的；没有 completed 的（正在输出的那条）
 * 明确不算完成。标题取会话标题（OpenCode 自己起的），文件数取 session.summary_files。
 * 改动文件**清单**轮询这一路给不出（库里只有 summary_files 一个计数）—— 那一项由插件补
 * （实测 `session.step.ended` 事件的 `data.files` 就是本轮改动的文件路径数组）。
 *
 * @param {string} sessionId
 * @param {{title?:string,fileCount?:number}} meta 会话自身的静态信息
 */
function readOpencodeDone(sessionId, meta = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return NO_DONE;
  const row = query((db) =>
    db
      .prepare(
        `SELECT data FROM session_message
          WHERE session_id = ? AND type = 'assistant'
            AND JSON_extract(data,'$.finish') IS NOT NULL
            AND JSON_extract(data,'$.finish') != ''
            AND JSON_extract(data,'$.finish') != 'tool-calls'
            AND JSON_extract(data,'$.finish') != 'error'
            AND JSON_extract(data,'$.time.completed') IS NOT NULL
          ORDER BY seq DESC LIMIT 1`
      )
      .get(id)
  );
  if (row) {
    let data = {};
    try {
      data = JSON.parse(String(row.data || ''));
    } catch {
      data = {};
    }
    const finish = String((data && data.finish) || '');
    if (finish === 'stop') {
      const at = Number(data && data.time && data.time.completed) || 0;
      if (at && Date.now() - at <= DONE_TTL_MS) {
        return {
          doneAt: at,
          doneTitle: String(meta.title || ''),
          doneCount: Number(meta.fileCount) || 0,
          doneFiles: [],
          doneCancelled: false,
        };
      }
    }
  }
  /**
   * 被打断的那一轮没有 `finish=stop` 的 assistant 消息（OpenCode 每轮结束会写一行
   * `type='idle'`，`data.outcome` 落 `succeeded` / `interrupted`）—— 上面那条路取不到，
   * 但主控制台仍要知道"这一轮是被掐掉的"才能亮红色「任务取消」。
   * 取逐轮清单里最新那一轮：`interrupted` 且刚结束（TTL 内）→ 落一枚取消标记。
   * 与台账同步器（本文件下方）同一口径：绝不把被打断当成完成，也不臆造未发生的取消。
   */
  const turns = readOpencodeTurns(id);
  const last = turns[turns.length - 1];
  if (last && last.endedAt && last.outcome === 'interrupted' && Date.now() - Number(last.endedAt) <= DONE_TTL_MS) {
    return {
      doneAt: Number(last.endedAt) || 0,
      doneTitle: String(meta.title || ''),
      doneCount: Array.isArray(last.files) ? last.files.length : 0,
      doneFiles: [],
      doneCancelled: true,
      // 这一轮已经吐出来的文字照常带上（与「任务完成」同一条线）：取消只是没干完，不是没产出
      doneSaid: String(last.result || ''),
    };
  }
  return NO_DONE;
}

/* ------------------------------ 对外 ------------------------------ */

/**
 * 这条会话有没有"接上"（库里真有它）。
 * 渲染层靠它区分"这个产品根本没在跑"与"在跑但此刻没动作"（同 reporter-phase 的 instrumented）。
 */
function opencodeInstrumented(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  return query((db) => {
    const table = sessionTable(db);
    if (!table) return false;
    return Boolean(db.prepare(`SELECT 1 FROM "${table}" WHERE id = ?`).get(id));
  }) === true;
}

/**
 * 8F 的"上报相位"—— 与 reporterMainPhase 同一个形状，
 * 供 /api/v1/reporter-phase 在 client 是 opencode 时走这一路。
 *
 * 没有 client/session 参数时按"最近更新的那条会话"取（与 hook 那侧"同 client 里谁最新显示谁"
 * 的老行为对齐）；传了 session 就只认那一条。
 * @param {string} workspacePath
 * @param {string} session
 * @returns {{sessionId:string,phase:string,action:string,target:string,context:string[],tool:string,prompt:string,model:string}|null}
 */
function opencodeMainPhase(workspacePath, session = '') {
  const list = listOpencodeSessions();
  if (!list.length) return null;
  const ws = String(workspacePath || '').trim();
  let row = '';
  if (session) {
    row = list.find((s) => s.id === session) || '';
  } else if (ws) {
    // 同一工程多条会话时，取最近更新的那条（没有就别人的工程串味）
    const mine = list.filter((s) => s.projectPath && path.resolve(s.projectPath) === path.resolve(ws));
    row = mine.sort((a, b) => b.lastEventAt - a.lastEventAt)[0] || '';
  } else {
    row = list[0];
  }
  if (!row) return null;
  const ph = readOpencodePhase(row.id);
  if (!ph) return null;
  return {
    /** 这份相位属于哪条会话（渲染层拿它确认"我正在看的那条会话"是不是这份） */
    sessionId: row.id,
    phase: ph.phase,
    action: ph.action,
    target: ph.target,
    context: ph.context,
    tool: ph.tool,
    prompt: ph.prompt,
    // 模型从 session 表取（真实值；取不到留空，不猜）
    model: row.model || '',
  };
}

/* ===================== 任务同步器（原 opencodeTasks.js，已合并进本楼层文件） ===================== */
const SYNC_INTERVAL_MS = 5_000;

/**
 * 插件那一路"还活着"的两个时间参数（与 kilo.js 同名同值，理由见那边的常量注释）。
 *
 * PLUGIN_GRACE_MS —— 一轮刚起的头几秒先不抢（插件本地回环，正常 1 秒内就落库）。
 *   短是必须的：它量的是"插件还没写上来"这段窗口，窗口多长用户那一轮就在列表里消失多久
 *   （实测 60 秒时，一条 8 秒的任务整轮都看不见）。
 * PLUGIN_COVER_MS —— 判"这一轮插件报过没有"时，插件那行的 started_at 与轮次起点允许的差
 *   （实测 ±90ms 内、方向不定；判漏了会多写一条孪生行，判重了会把两秒内连开两轮当同一轮）。
 */
const PLUGIN_GRACE_MS = 3_000;
const PLUGIN_COVER_MS = 2_000;

/** task id 前缀，避免跟 reporter hook 写的 task 撞 id */
const TASK_ID_PREFIX = 'opencode:';
/** 这一层的上报身份：8F 由 sources 反推得到 ["opencode","opencode-plugin"]，轮询这一路是前者 */
const CLIENT = 'opencode';

/** 这个工程名（工程 id）—— 成员 / 台账都按它归组 */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'OpenCode');
}

/**
 * 写一条台账（tasks + task_runs 两行）。8F 是**每一轮一条**。
 * @returns {string|null} 这条记录的 files_json（心跳里的 current_files 直接复用）
 */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, title, startedAt, endedAt, state, files, result, tokens }) {
  const st = state || (endedAt ? 'done' : 'running');
  const running = st === 'running';
  repo.insertTask.run({
    id,
    projectId,
    memberId,
    parentTaskId: null,
    title,
    state: st,
    progress: running ? null : 1,
    startedAt,
    endedAt: endedAt || null,
  });
  repo.upsertTaskRun.run({
    id,
    projectId,
    memberId,
    client: CLIENT,
    sessionId,
    form: null,
    model: model || null,
    title,
    startedAt,
    baselineCommit: null,
  });
  const filesJson = files && files.length ? JSON.stringify(files) : null;
  repo.endTaskRun.run({
    id,
    title,
    model: model || null,
    form: null,
    // 产出摘要：OpenCode 那一轮最后说的话（见 opencode.js 的 readOpencodeTurns）；
    // 还没收工的那轮先不写（半截话不算产出），收工时再补。
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  /* 本轮消耗的 token（readOpencodeTurns 从 session_message.data.tokens 折出来，见 opencode.js）。
     同 7F：**覆盖写**而不是 COALESCE —— 这一轮还在跑时每次轮询都会重算，数值是长出来的。
     tokens 为 null（没读到）时如实写 NULL，不拿上一次的顶。 */
  repo.setTaskRunTokens.run({
    id,
    inputTokens: tokens ? tokens.input : null,
    outputTokens: tokens ? tokens.output : null,
    cacheReadTokens: tokens ? tokens.cacheRead : null,
    cacheWriteTokens: tokens ? tokens.cacheWrite : null,
  });
  return filesJson;
}

/** 台账 id 里的轮序号（`opencode:<会话id>:<序号>`）；不是这个形状就回 null（同 kilo.js） */
function turnIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
function syncOpencodeTasks({ bus, repo, now: nowFn = Date.now }) {
  const sessions = listOpencodeSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  // 每条会话的逐轮清单**和**它现有的台账行各只读一次：让位判定、owner 选择、写台账三处复用
  const turnsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    turnsOf.set(s.id, readOpencodeTurns(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }
  /** 这条会话现在算不算在跑（还有一轮没收工） */
  const isActiveOf = (s) => (turnsOf.get(s.id) || []).some((t) => !t.endedAt);

  /** 插件给这条会话写的那些行（服务端发的 `k_*`）各自报的轮次起点；没写过 → [] */
  const pluginStartsOf = (s) =>
    runsOf.get(s.id).filter((r) => !String(r.id).startsWith(TASK_ID_PREFIX)).map((r) => Number(r.started_at || 0));

  /** 插件**为这一轮**写过行没有：按轮次起点对齐（容许 PLUGIN_COVER_MS 的误差，理由见常量） */
  const coveredBy = (starts, at) => starts.some((p) => Math.abs(p - Number(at || 0)) <= PLUGIN_COVER_MS);

  /**
   * 这条会话是不是已经有**插件写的**行了（插件写的是服务端发的 `k_*`，轮询写的是 `opencode:*`）——
   * 有就整条让位。判据按 id 前缀而不是 client（理由见 kilo.js 同名函数）。
   *
   * **让位只在插件还在报的时候成立**（2026-09-30 起，与 kilo.js 同口径）：插件写的行只
   * 证明它**曾经**在报 —— 它跟着 agent 进程活，通道断了（服务端重启换了随机 token，老进程里
   * 那份插件从此每条上报都 401 且完全无声）时，两路都不写，用户跑的轮次就凭空消失。
   * 判据因此是"插件**这一轮**也写了没有"：它最新那一行落在源里最新这一轮起点之后
   * （容许 PLUGIN_COVER_MS 的误差）→ 让位；这一轮刚起就再等 PLUGIN_GRACE_MS，过了还不见
   * 它的行 → 收回这条会话。插件活着时每轮开跑 1 秒内就写一条，正常永不命中；它只是慢了
   * （注册重试中）就先照旧让位，等它写上来让位重新成立、轮询自己的行被收掉（自愈）。
   * 宽限期**从这一轮的起点算**（不是"插件沉默多久"）：插件两轮之间本来就不写东西，沉默是常态。
   */
  const yieldsOf = (s) => {
    const starts = pluginStartsOf(s);
    if (!starts.length) return false;
    const turns = turnsOf.get(s.id) || [];
    const last = turns[turns.length - 1];
    const turnStart = last ? Number(last.startedAt || 0) : 0;
    const newestTheirs = starts.reduce((m, p) => Math.max(m, p), 0);
    if (newestTheirs >= turnStart - PLUGIN_COVER_MS) return true;
    return now - turnStart <= PLUGIN_GRACE_MS;
  };

  /**
   * 让位给插件的那条会话，插件是不是**冒我们这个身份、而且现在正跑着**？
   * CLI 形态的插件（没有 VS Code 环境变量）报的就是裸 `opencode` —— 同一个成员
   * `opencode@<工程>`，见 plugin/index.js 的 resolveClient。是的话这条工程的成员状态先归
   * 插件写：轮询这一路连心跳都不碰，否则 5s 一次轮询会把插件刚写的相位覆盖成轮询视角下的
   * 旧状态（agent_status 谁最后写谁赢）。收工后交回轮询（与 kilo.js 同款）。
   */
  const pluginOwnsMember = new Set();
  for (const s of sessions) {
    if (!yieldsOf(s) || !isActiveOf(s)) continue;
    if (runsOf.get(s.id).some((r) => String(r.client) === CLIENT)) pluginOwnsMember.add(projectIdOf(s));
  }

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程多条会话时，谁最后写谁赢 —— 会让"正在跑的那条任务"在 agent_status 里找不到心跳，
   * 任务列表按 query.js 的 CASE 把它算成「已取消」。所以先选出这个工程该报的那条：
   * 活跃里最新的；都不活跃就报最新那条（卡片挂住最后一条任务）—— 与 kilo.js 同款。
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    // 让位的会话**不参与** owner 选择：它这一路根本不写心跳，把它算进来就会让同工程另一条
    // 真在跑的会话永远选不上 owner —— 那条任务在 agent_status 里找不到心跳，被判成「已取消」。
    if (yieldsOf(s)) continue;
    const pid = projectIdOf(s);
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastEventAt || 0) > Number(prevNew.lastEventAt || 0)) newestByProject.set(pid, s);
    if (!isActiveOf(s)) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastEventAt || 0) > Number(prevAct.lastEventAt || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    const prefix = `${TASK_ID_PREFIX}${s.id}`;

    // 装了插件就让位（和 kilo.js 同一口径）：插件那一路上报的是每一轮真值，判据是
    // "这个会话有没有插件写的行"（插件写的 id 是 `k_*`，按 id 认而不是按 client 认 ——
    // 7F 那个同款判据按 client 判时从来没命中过，见 kilo.js 的说明）。
    // 但让位只在插件**还在报**时成立（yieldsOf）：通道断了就把会话收回来，
    // 自己上一轮抢写的兜底行同样收掉（只删自己前缀的 id，插件的行一根汗毛都不动）。
    const sessionRuns = runsOf.get(s.id);
    if (yieldsOf(s)) {
      for (const r of sessionRuns) if (String(r.id).startsWith(TASK_ID_PREFIX)) repo.deleteTaskRun(r.id);
      continue;
    }
    const turns = turnsOf.get(s.id) || [];
    if (!turns.length) continue;
    // 从断线插件手里收回来的会话：**插件报过的轮次它自己管**（那些行是 `k_*`），
    // 只补它断线之后的（判据"这一轮插件没报过"，与 kilo.js 的 ②b 同一口径）。
    const starts = pluginStartsOf(s);

    // 确保工程 & 成员存在（安静写入，不广播）
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `opencode@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'OpenCode',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      lastSeenAt: now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    let hbId = '';
    let hbFilesJson = null;
    let running = false;
    for (const t of turns) {
      if (coveredBy(starts, t.startedAt)) continue; // 插件报过的轮次不重复写
      const id = `${prefix}:${t.index}`;
      // 改动文件：只认写工具（edit）碰过的；OpenCode 的输入是绝对路径，统一转工程相对
      const files = (t.files || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : '';
        })
        .filter(Boolean);
      const title = t.prompt || s.title || '(OpenCode 会话)';
      // 收工方式：OpenCode 的 idle 行写 succeeded / interrupted —— 被打断的那轮记「已取消」，
      // 不记「完成」（实测 2026-09-28：用户终止了一轮，台账却报完成）。
      const state = t.endedAt ? (t.outcome === 'interrupted' ? 'cancelled' : 'done') : 'running';
      hbFilesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: s.model || '',
        title,
        startedAt: t.startedAt || now,
        endedAt: t.endedAt || null,
        state,
        files,
        result: t.endedAt ? t.result || '' : '',
        tokens: t.tokens,
      });
      hbId = id;
      running = !t.endedAt;
      count += 1;
    }

    // 收掉"源里已经没有"的那几轮（与 kilo.js 的 ③b 同一口径）：轮次表缩短时
    // （OpenCode 清了消息 / 压过上下文），那几行永远等不到自己的轮 —— 一直挂在 'running'，
    // 被 query.js 的 CASE 判成「已取消」，在列表里当一条假任务躺着。
    // 判据是"这一轮还在不在源里"（byIndex），不认数组下标。turns 整个读空时上面已经
    // continue 了（不在这里删）：读不出来 ≠ 源里没有。
    const byIndex = new Set(turns.map((t) => t.index));
    for (const r of sessionRuns) {
      const idx = turnIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

    // 心跳：只在跑 = thinking，收工 = idle；指向正在跑的那条（没有就最新那条）。
    // **只由这个工程选中的那条会话写**（见上面 activeByProject 的说明）；
    // 插件正冒我们这个身份在报、且那轮还没收工 → 这一栏整个让给它（见 pluginOwnsMember）。
    const owner = pluginOwnsMember.has(projectId)
      ? null
      : activeByProject.get(projectId) || newestByProject.get(projectId);
    bus.setSessionStatus({
      project: projectId,
      memberId: 'opencode',
      sessionId: s.id,
      state: running ? 'thinking' : 'idle',
      taskId: running ? hbId : null,
      ts: now,
    });
    if (owner === s && hbId) {
      const last = turns[turns.length - 1] || {};
      repo.upsertStatus.run({
        memberId,
        state: running ? 'thinking' : 'idle',
        stateSince: running ? last.startedAt || now : now,
        taskId: hbId,
        progress: null,
        currentFiles: hbFilesJson,
        lastHeartbeatAt: now,
        degraded: 0,
        source: 'report',
        updatedAt: now,
      });
    }
  }

  return count;
}

/** 适合 setInterval 的包装：吞异常、不阻断主循环 */
function startOpencodeTaskSyncer(ctx) {
  const tick = () => {
    try {
      syncOpencodeTasks(ctx);
    } catch {
      /* OpenCode 没装 / 库被占 → 这轮跳过 */
    }
  };
  tick();
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

/**
 * opencode 来源分支（8F）：轮询 OpenCode 自己的 SQLite（opencode.db 的 session_message）。
 * 原 sessionRegistry.js 的 opencode 分支整体搬到这里，调试 8F 不再碰中央文件。
 * @param {object} p 楼层元数据
 * @param {object} src 来源规格（kind === 'opencode'）
 * @param {object} ctx 框架提供的共享工具
 */
function opencodeHandler(p, src, ctx) {
  const { claim, upsert, now, workspacePath, TIMEOUT_MS, readReporterDone, clientOf, doneFieldsFromReporter } = ctx;
  for (const s of listOpencodeSessions()) {
    if (!claim(p.id, s.id)) continue;
    if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
    const ph = readOpencodePhase(s.id) || null;
    const doneTruth =
      readReporterDone(s.projectPath || workspacePath, clientOf('opencode', true), s.id) ||
      readReporterDone(s.projectPath || workspacePath, clientOf('opencode', false), s.id);
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      source: 'opencode',
      sourceKind: 'opencode',
      project: s.project,
      projectPath: s.projectPath,
      mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
      current: false,
      live: true,
      phase: ph ? ph.phase : 'unreported',
      action: ph ? ph.action : '',
      target: ph ? ph.target : '',
      tool: ph ? ph.tool : '',
      context: ph ? ph.context : [],
      prompt: (ph && ph.prompt) || '',
      model: s.model || '',
      inferred: true,
      ...(doneTruth && doneTruth.at ? doneFieldsFromReporter(doneTruth) : readOpencodeDone(s.id, s)),
      lastEventAt: s.lastEventAt,
    });
  }
}

const kindHandlers = { opencode: opencodeHandler };

module.exports = {
  opencodeHome,
  meta,
  kindHandlers,
  sessionTitle,
  opencodeDbPath,
  shorten,
  hasCoreTables,
  listOpencodeSessions,
  readOpencodePhase,
  readOpencodeDone,
  readOpencodeTurns, // 逐轮任务清单（8F 台账按"每一轮一条"记账用，见本文件任务同步器）
  opencodeInstrumented,
  opencodeMainPhase,
  NO_DONE,
  // ---- 8F 任务同步器（原 opencodeTasks.js）----
  syncOpencodeTasks,
  startOpencodeTaskSyncer,
  SYNC_INTERVAL_MS,
};
