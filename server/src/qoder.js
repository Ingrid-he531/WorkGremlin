'use strict';

/**
 * 6F Qoder（CLI 与插件合并单楼层）楼层模块 —— 把插件形态的**数据源**与**任务同步器**
 * （原 lingma.js / qoderPluginTasks.js）合并到这一个文件。
 *
 * 6F 只有一种上报身份 qoder（CLI 与插件分不出，共用同一 client），三路来源：
 *   · cli    —— 扫 ~/.qoder/projects transcript 产会话（与 4F Claude 同款）
 *   · lingma —— 轮询 Qoder CN 扩展自己的 SQLite（local.db），插件形态专用
 *   · hook   —— 实时相位兜底
 *
 * 这一文件只负责其中"插件形态"那一路：lingma.js 读落盘、qoderPluginTasks.js 写台账。
 * 详细纪律（只读打开 / 短超时 / 缓存 / 相位是推断不是上报）见各函数上方注释。
 *
 * 统一接口（见 floors.js 的 FLOOR_CONTRACT）：
 *   id / client   楼层身份
 *   listSessions  插件这一路的会话（= listLingmaSessions）
 *   readRounds    = readLingmaRounds
 *   readPhase     = readLingmaPhase
 *   readDone      = readLingmaDone
 *   syncTasks     = syncQoderPluginTasks
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clientOf } = require('@workgremlin/shared');
const { openReadonly, readOne } = require('./dbReadonly');
const { resolveProjectName } = require('./project');

const HOME = os.homedir();

/**
 * 6F Qoder 楼层元数据（原 products.js 的 6F 条目）。CLI 与插件合并楼层。
 */
const meta = {
  id: '6F',
  name: 'Qoder',
  kind: 'cli',
  cmd: 'qoder',
  altCmd: 'qoder-cn',
  agent: 'qoder',
  plugin: false,
  altPluginRe: /tongyi-lingma/i,
  sources: [
    { kind: 'cli', label: 'CLI', client: clientOf('qoder', false), dirs: [path.join(HOME, '.qoder'), path.join(HOME, '.qoder-cn')] },
    {
      kind: 'lingma',
      label: 'Plugin',
      client: clientOf('qoder', false),
      note: '这一路读的是 Qoder CN 编辑器插件自己的 local.db（SQLite，chat_session / chat_record）：扩展没有 hook 子系统、也不写 ~/.qoder 的 transcript，所以会话与相位只能由服务端轮询它这份落盘（相位是推断值）',
    },
    { kind: 'hook' },
  ],
  hookSource: true,
  dataKind: clientOf('qoder', false),
  // Qoder CLI 自己的安装目录（PATH 查不到时兜底；两个入口都试）
  cliBinDirs: [path.join(HOME, '.qoder', 'entry'), path.join(HOME, '.qoder-cn', 'entry')],
  // CLI 会话文件（Claude Code 同款格式）落在 <dataRoot>/projects/<工程>/ 下，文件名即 session_id
  sessionSubtree: 'projects',
  sessionIdOfFile: (name) => String(name).replace(/\.jsonl$/i, ''),
};

/* ───────────── 原 lingma.js ───────────── */




/** 打开只读连接的超时：被扩展的写事务占住时立刻放弃（见文件头纪律 2） */
const OPEN_TIMEOUT_MS = 3_000;
/** 会话表缓存时长 */
const TTL = 5_000;
/** 一次最多带出多少条会话（倒序取最新的，剩下的由"最近"口径兜底） */
const SESSION_LIMIT = 50;

/** 扩展的库文件；WORKGREMLIN_LINGMA_DB 是自检用的（指到临时造的库上） */
function lingmaDbPath() {
  const explicit = String(process.env.WORKGREMLIN_LINGMA_DB || '').trim();
  const p = explicit
    ? path.resolve(explicit)
    : path.join(HOME, '.lingma', 'vscode', 'sharedClientCache', 'cache', 'db', 'local.db');
  try {
    return fs.statSync(p).isFile() ? p : '';
  } catch {
    return '';
  }
}

/**
 * 会话标题（6F Qoder / Lingma）：SQLite chat_session.session_title。
 * 原 sessionTitle.js 的 lingmaTitleOf 搬到这里 —— 调试 6F 标题不必碰中央文件。
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function sessionTitle(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const db = openReadonly(lingmaDbPath());
  if (!db) return '';
  try {
    const row = readOne(db, 'SELECT session_title FROM chat_session WHERE session_id = ?', id);
    return String((row && row.session_title) || '').trim();
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

let Database = null;
let DatabaseTried = false;
/** 开一个只读连接；拿不到（没装 / 被锁 / 原生模块没编出来）一律回 null */
function openDb() {
  const file = lingmaDbPath();
  if (!file) return null;
  if (!DatabaseTried) {
    DatabaseTried = true;
    try {
      // better-sqlite3 是 server 的既有依赖（见 server/src/db/index.js），走工作区那份
      Database = require('better-sqlite3');
    } catch {
      Database = null;
    }
  }
  if (!Database) return null;
  try {
    return new Database(file, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/** 在只读连接上跑查询；表不存在 / SQL 不对（扩展改版）都回 null，不冒泡 */
function query(fn) {
  const db = openDb();
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* 关不掉无所谓，结果已经拿到了 */
    }
  }
}

const cache = { at: 0, key: '', value: null };

/**
 * 插件里聊过的会话（**只认对话会话**）。
 *
 * 只看 `session_type = 'assistant'`：实测对话会话就是这个值、`mode = 'agent'`；
 * 行内补全（code completion）那些不是任务，不能进台账。没有工程路径的会话也跳过
 * （归不到任何工程上去）。
 *
 * @returns {Array<{id: string, title: string, project: string, projectPath: string,
 *                  lastEventAt: number, createdAt: number, mode: string, rounds: number}>}
 */
function listLingmaSessions() {
  const now = Date.now();
  const file = lingmaDbPath();
  if (cache.value && cache.key === file && now - cache.at < TTL) return cache.value;
  const rows = query((db) =>
    db
      .prepare(
        `SELECT s.session_id, s.session_title, s.project_uri, s.session_type, s.mode,
                s.gmt_create, s.gmt_modified,
                (SELECT COUNT(1) FROM chat_record r WHERE r.session_id = s.session_id) AS rounds
           FROM chat_session s
          WHERE s.session_type = 'assistant'
          ORDER BY s.gmt_modified DESC
          LIMIT ${SESSION_LIMIT}`
      )
      .all()
  );
  const value = (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const projectPath = String(r.project_uri || '').trim();
      return {
        id: String(r.session_id || ''),
        title: String(r.session_title || ''),
        projectPath,
        project: projectPath ? resolveProjectName(projectPath) || path.basename(projectPath) : '',
        lastEventAt: Number(r.gmt_modified) || 0,
        createdAt: Number(r.gmt_create) || 0,
        mode: String(r.mode || ''),
        rounds: Number(r.rounds) || 0,
      };
    })
    .filter((s) => s.id && s.projectPath);
  cache.at = now;
  cache.key = file;
  cache.value = value;
  return value;
}

/** extra 是 JSON：`originalContent` 就是用户敲的那句话（明文）。认不出回空，不猜 */
function promptOf(extra) {
  try {
    const j = JSON.parse(String(extra || '') || '{}');
    return String((j && j.originalContent) || '').trim();
  } catch {
    return '';
  }
}

/**
 * 这一轮用的模型：extra.modelConfig.key（用户选的模型）。
 *
 * `'auto'` 不算 —— 那是"让插件自己挑"，不是一个模型名，如实留空比在卡片上写个
 * "auto" 有用地少。键缺失/认不出也回空（同 promptOf 的纪律：认不出就不猜）。
 */
function modelOf(extra) {
  try {
    const j = JSON.parse(String(extra || '') || '{}');
    const key = String((j && j.modelConfig && j.modelConfig.key) || '').trim();
    return !key || key === 'auto' ? '' : key;
  } catch {
    return '';
  }
}

/**
 * "这一轮还在跑"的判据：这是本会话最后一轮、且距今 LIVE_MS 内还有落盘。
 *
 * 为什么可以用新鲜度：插件一轮里每吐一条消息 / 每跑一次工具都会写 chat_message
 * （实测一轮 2 分钟里写了 8 条），所以"一分半没动静"基本就等于收工了。反过来定太短
 * （比如 30 秒）会把"模型正在长时间思考、还没有任何消息落盘"的那一轮判成已收工。
 * 定 90 秒：实测最长的静默间隔（一次回答的生成）在 30 秒以内，留三倍余量。
 *
 * 台账（qoderPluginTasks.js）与会话表（sessionRegistry.js 的 lingma 那一支）共用这一把尺子 ——
 * 两边对"这一轮还在不在跑"必须给同一个答案，否则主控制台与任务记录会互相打架。
 */
const LIVE_MS = 90_000;

/**
 * 这一条会话里**每一轮**插件的落盘（按 gmt_create 升序 = 真实先后）。
 *
 * ⚠️ 源里**没有**"这一轮跑完了没有"的真值：`finish_status` 实测常驻 0（跑完的也是 0），
 * 逐字 answer 又是密文。所以这里只给"最后一次更新"（updatedAt），"还在跑还是已收工"
 * 交给调用方按新鲜度判（见 qoderPluginTasks.js 的 LIVE_MS），并且必须如实标成推断。
 *
 * @param {string} sessionId
 * @returns {Array<{index: number, requestId: string, prompt: string, summary: string,
 *                  model: string, startedAt: number, updatedAt: number, files: string[]}>}
 */
function readLingmaRounds(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  const rows = query((db) =>
    db
      .prepare(
        `SELECT request_id, extra, summary, gmt_create, gmt_modified
           FROM chat_record
          WHERE session_id = ?
          ORDER BY gmt_create`
      )
      .all(id)
  );
  if (!Array.isArray(rows)) return [];
  const filesOf = filesByRecord(id);
  return rows.map((r, i) => {
    const requestId = String(r.request_id || '');
    return {
      index: i,
      requestId,
      prompt: promptOf(r.extra),
      summary: String(r.summary || '').trim(),
      model: modelOf(r.extra),
      startedAt: Number(r.gmt_create) || 0,
      updatedAt: Number(r.gmt_modified) || 0,
      files: filesOf.get(requestId) || [],
    };
  });
}

/**
 * 每一轮改过哪些文件：快照表把快照挂到轮次上（chat_record_id），文件表挂在快照上。
 *
 * 没有轮次归属的快照（`chat_record_id` 为空，实测是会话当前**正在写**的那一个）
 * 整个跳过 —— 挂错轮次比少记几个文件糟得多（这一条与 7F 的 session.diff 教训同一个道理）。
 *
 * @returns {Map<string, string[]>} request_id → 绝对路径清单（去重、保持先后）
 */
function filesByRecord(sessionId) {
  const out = new Map();
  const snaps = query((db) =>
    db.prepare('SELECT snapshot_id, chat_record_id FROM chat_snapshot WHERE session_id = ?').all(sessionId)
  );
  for (const s of Array.isArray(snaps) ? snaps : []) {
    const recordId = String(s.chat_record_id || '');
    const snapshotId = String(s.snapshot_id || '');
    if (!recordId || !snapshotId) continue;
    const files = query((db) =>
      db.prepare('SELECT file_id FROM chat_working_space_file WHERE snapshot_id = ?').all(snapshotId)
    );
    const list = out.get(recordId) || [];
    for (const f of Array.isArray(files) ? files : []) {
      const p = String((f && f.file_id) || '').trim();
      if (p && !list.includes(p)) list.push(p);
    }
    out.set(recordId, list);
  }
  return out;
}

/* ------------------------------ 相位 / 完成标记（会话表用） ------------------------------ */

/**
 * 最后一轮是不是"还在跑"（判据与理由见 LIVE_MS）。
 *
 * 与 qoderPluginTasks.js 的 isLive 同一个式子：**本会话最后一轮** + 90 秒内还有落盘。
 * 会话自己的 gmt_modified（meta.lastEventAt）也一起取最大值 —— 扩展不一定把每一次
 * 消息落盘都反映到 chat_record.gmt_modified 上，会话行那个时间同样是它写的。
 */
function lastRoundLive(rounds, meta = {}, now = Date.now()) {
  const last = rounds[rounds.length - 1];
  if (!last) return false;
  return now - Math.max(Number(last.updatedAt) || 0, Number((meta && meta.lastEventAt) || 0)) <= LIVE_MS;
}

/**
 * 这条插件会话**此刻的相位**（**推断**，不是它上报的）。
 *
 * 源里没有"这一轮跑完了没有"的真值（finish_status 常驻 0、answer 是密文），只有
 * "最后一次落盘的时刻"，所以只能二选一：最后一轮还新鲜 → thinking，否则 idle。
 * 拿不到更细的东西（在调哪个工具、等不等授权），**一个字都不补** —— 宁可只给
 * 「思考中 / 待命中」，也不拿时间窗去编造"调用工具 xxx"。
 *
 * @param {string} sessionId
 * @param {Array|null} rounds 调用方已经读过就传进来（免得同一轮里重复查库）
 * @param {{lastEventAt?: number}} meta 会话行自己的最后更新时刻
 * @returns {{phase:string,action:string,target:string,tool:string,context:string[],prompt:string,model:string,inferred:boolean}|null}
 */
function readLingmaPhase(sessionId, rounds = null, meta = {}, now = Date.now()) {
  const rs = Array.isArray(rounds) ? rounds : readLingmaRounds(sessionId);
  if (!rs.length) return null;
  const last = rs[rs.length - 1];
  return {
    phase: lastRoundLive(rs, meta, now) ? 'thinking' : 'idle',
    // 工具 / 目标：源里没有，不猜（见上面"一个字都不补"）
    action: '',
    target: '',
    tool: '',
    context: [],
    // 「思考中」屏上那句用户原话（extra.originalContent 是明文）
    prompt: String(last.prompt || ''),
    model: String(last.model || ''),
    inferred: true,
  };
}

/** 完成标记的新鲜期：只有这么久之内收工的才算"刚发生"，否则一开页面就重播上一轮（与 kilo.js 同口径） */
const DONE_TTL_MS = 10 * 60_000;
/**
 * 完成标记缺省值（没有就是"没有"，不臆造）。
 * doneCancelled 恒 false：扩展的落盘里**没有**"用户按了停止"这个信号（连逐字正文都是密文，
 * 更没有 interrupt 痕迹），所以不亮红色「任务取消」—— 与 9F Copilot 同口径。
 */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false, doneSaid: '' };

/**
 * 这条插件会话的"完成"标记 —— 对应 hook 那边 Stop 落下的 done。
 *
 * 判据只有一条：**最后一轮已经收工**，凭据是扩展自己写的 `summary`（明文对话总结，
 * 一轮跑完它才写）。还在飞（90 秒内还有落盘）不算；没写总结的不算（那是"没跑完
 * 或扩展还没总结"，不是"完成了"）。收工时刻取那一轮最后一次落盘 —— 源里没有更准的。
 *
 * @param {string} sessionId
 * @param {Array|null} rounds
 * @param {{lastEventAt?: number, projectPath?: string}} meta
 * @returns {{doneAt:number,doneTitle:string,doneCount:number,doneFiles:Array,doneCancelled:boolean,doneSaid:string}}
 */
function readLingmaDone(sessionId, rounds = null, meta = {}, now = Date.now()) {
  const rs = Array.isArray(rounds) ? rounds : readLingmaRounds(sessionId);
  if (!rs.length) return NO_DONE;
  const last = rs[rs.length - 1];
  if (lastRoundLive(rs, meta, now)) return NO_DONE;
  const summary = String(last.summary || '').trim();
  if (!summary) return NO_DONE;
  const at = Number(last.updatedAt) || 0;
  if (!at || now - at > DONE_TTL_MS) return NO_DONE;
  const projectPath = String((meta && meta.projectPath) || '');
  // 改动文件：扩展记的是绝对路径，转工程相对（与台账那一路口径一致）；工程外的留绝对路径
  const files = (Array.isArray(last.files) ? last.files : []).slice(0, 6).map((abs) => {
    if (!projectPath) return String(abs || '');
    const rel = path.relative(projectPath, String(abs || ''));
    return rel && !rel.startsWith('..') ? rel : String(abs || '');
  });
  return {
    doneAt: at,
    doneTitle: String(last.prompt || ''),
    doneCount: Array.isArray(last.files) ? last.files.length : 0,
    doneFiles: files.map((name) => ({ name })),
    doneCancelled: false,
    // 收尾自述：扩展自己写的对话总结（明文）—— 主控制台那句"说了什么"就是它
    doneSaid: summary.replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

/** 库里到底有没有这些表 —— 给前端一句"这一路读不出会话"的说明（与 kilo.js 的 hasCoreTables 同款） */
function hasCoreTables() {
  return (
    query((db) => {
      const names = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_session','chat_record','chat_snapshot','chat_working_space_file')"
        )
        .all()
        .map((r) => r.name);
      return names.length;
    }) === 4
  );
}

/** 自检 / 调试用：把缓存清掉（换了库、或自检里刚写了新行） */
function resetLingmaCache() {
  cache.at = 0;
  cache.key = '';
  cache.value = null;
}


/* ───────────── 原 qoderPluginTasks.js ───────────── */

// LIVE_MS（"这一轮还在跑"的判据）与会话表那一支共用同一把尺子，定义在 lingma.js ——
// 两边对"这一轮还在不在跑"必须给同一个答案，否则主控制台与任务记录会互相打架。


const SYNC_INTERVAL_MS = 5_000;

/** task id 前缀：认人用（我们自己写的行都是这个前缀，hook 那一路是 `t_*`），也避免撞 id */
const TASK_ID_PREFIX = 'qoder-plugin:';
/** 这一路的 client：与 6F 的 CLI 同一个（products.js：CLI 与插件合并单楼层） */
const CLIENT = 'qoder';
/** 形态列：插件那一路（任务列表里显示 "Qoder Plugin" 而不是 "Qoder CLI"） */
const FORM = 'plugin';
/** 产出摘要的长度上限（与 hook.js 的 RESULT_MAX 同量级） */
const RESULT_MAX = 4_000;
/** hook（CLI）那一路的心跳多久算"还活着"—— 活着就让位，不碰状态栏 */
const HOOK_FRESH_MS = 60_000;

/** 工程名（工程 id）：与 CLI 那一路用同一条解析（hook 报的是 package.json 里的名字，
 *  实测 `qoder@workgremlin`），否则插件与 CLI 会各自建一个成员、同一层里两个工位 */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  if (!projectPath) return '';
  return resolveProjectName(projectPath) || path.basename(projectPath);
}

/**
 * 写一条台账（tasks + task_runs 两行）。6F 插件这一路是**每一轮一条**。
 * @returns {string|null} 这条记录的 files_json（心跳里的 current_files 直接复用）
 */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, title, startedAt, endedAt, state, files, result }) {
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
    form: FORM,
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
    form: FORM,
    // 产出摘要：扩展自己写的 summary（明文）。还在飞的那轮先不写（半截话不算产出），
    // 收工时由下一次同步补上 —— 与 7F/8F 同款。
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  return filesJson;
}

/** 台账 id 里的轮序号（`qoder-plugin:<会话id>:<序号>`）；不是这个形状就回 null */
function turnIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** hook（CLI）那一路此刻是不是正占着这个成员：状态栏挂在一条**不是我们写的**任务上、且心跳新鲜 */
function hookOwnsMember(repo, memberId, now) {
  try {
    const st = repo.getStatus.get(memberId);
    if (!st || !st.task_id) return false;
    if (String(st.task_id).startsWith(TASK_ID_PREFIX)) return false;
    return now - Number(st.last_heartbeat_at || 0) <= HOOK_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
function syncQoderPluginTasks({ bus, repo, now: nowFn = Date.now }) {
  const sessions = listLingmaSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  const roundsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    roundsOf.set(s.id, readLingmaRounds(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }

  /** 这一轮是不是"还在跑"（本会话最后一轮 + 90 秒内还有落盘；判据与理由见 LIVE_MS） */
  const isLive = (s, round) => {
    const rounds = roundsOf.get(s.id) || [];
    if (!rounds.length || rounds[rounds.length - 1] !== round) return false;
    return now - Math.max(Number(round.updatedAt || 0), Number(s.lastEventAt || 0)) <= LIVE_MS;
  };

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程多条插件会话时谁最后写谁赢，所以先选出"该由哪条会话代表这个工程上报"：
   * 活跃里最新的；都不活跃就报最新那条（卡片挂住最后一条任务）。与 7F/8F 同款。
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    if (!(roundsOf.get(s.id) || []).length) continue;
    const pid = projectIdOf(s);
    if (!pid) continue;
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastEventAt || 0) > Number(prevNew.lastEventAt || 0)) newestByProject.set(pid, s);
    const live = (roundsOf.get(s.id) || []).some((r) => isLive(s, r));
    if (!live) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastEventAt || 0) > Number(prevAct.lastEventAt || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    if (!projectId) continue;
    const rounds = roundsOf.get(s.id) || [];
    const prefix = `${TASK_ID_PREFIX}${s.id}`;
    // 工程里没有可写的轮次（只在插件里开了个会话、一句话没说）：不建工程也不建成员，
    // 免得 6F 的工位上凭空多出一个空工位
    if (!rounds.length) continue;

    // 确保工程 & 成员存在（安静写入，不广播；工程名与 CLI 那一路同一条解析）
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `${CLIENT}@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      // 名字只在**新建**成员时生效（repo.upsertMember 的 ON CONFLICT 不更新 name，见 db/index.js
      // 那一句"名字由第一次落库的那一路定"）。CLI 那一路先来的话它叫 'qoder'（hook 上报没带
      // 名字，bus 按 memberId 前缀落），这里不会把它改名。
      name: 'Qoder',
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
    for (const t of rounds) {
      const id = `${prefix}:${t.index}`;
      // 改动文件：扩展记的是绝对路径，统一转工程相对（与 7F/8F 同款）
      const files = (t.files || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p) return '';
          if (!projectPath) return p;
          const rel = path.relative(projectPath, p);
          return rel && !rel.startsWith('..') ? rel : '';
        })
        .filter(Boolean);
      const live = isLive(s, t);
      const title = t.prompt.replace(/\s+/g, ' ').trim() || s.title || '(Qoder 插件会话)';
      hbFilesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: t.model || '',
        title,
        startedAt: t.startedAt || now,
        // 收工时间 = 这一轮最后一次落盘的时刻（源里没有更准的收工信号，见文件头）
        endedAt: live ? null : t.updatedAt || t.startedAt || now,
        state: live ? 'running' : 'done',
        files,
        // 还在飞的那轮不写产出（下一轮开始时它已经在源里定稿，那个时候再补）
        result: live ? '' : String(t.summary || '').slice(0, RESULT_MAX),
      });
      hbId = id;
      running = live;
      count += 1;
    }

    // 收掉"源里已经没有"的轮次（插件里删了会话/清过记录）：那几行永远等不到自己的轮，
    // 会一直挂在 'running' 被 query.js 判成「已取消」。判据是"这一轮还在不在源里"（byIndex）。
    const byIndex = new Set(rounds.map((t) => t.index));
    for (const r of runsOf.get(s.id)) {
      const idx = turnIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

    // 状态栏：只在"这个工程该由本条会话上报"、且 CLI 那一路没占着的时候写。
    // 在跑 = thinking（推断），收工 = idle；槽位指向正在跑的那条（没有就最新那条）。
    const owner = activeByProject.get(projectId) || newestByProject.get(projectId);
    bus.setSessionStatus({
      project: projectId,
      memberId: CLIENT,
      sessionId: s.id,
      state: running ? 'thinking' : 'idle',
      taskId: running ? hbId : null,
      ts: now,
    });
    if (owner === s && hbId && !hookOwnsMember(repo, memberId, now)) {
      repo.upsertStatus.run({
        memberId,
        state: running ? 'thinking' : 'idle',
        stateSince: running ? rounds[rounds.length - 1].startedAt || now : now,
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
function startQoderPluginTaskSyncer(ctx) {
  const tick = () => {
    try {
      syncQoderPluginTasks(ctx);
    } catch {
      /* 插件界面没开过 / 库被占 / 原生模块缺失 → 这轮跳过，其余楼层照常 */
    }
  };
  tick();
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}



/**
 * lingma 来源分支（6F 插件形态）：轮询 Qoder CN 扩展自己的 local.db。
 * 原 sessionRegistry.js 的 lingma 分支整体搬到这里，调试 6F 不再碰中央文件。
 * @param {object} p 楼层元数据
 * @param {object} src 来源规格（kind === 'lingma'）
 * @param {object} ctx 框架提供的共享工具（claim / upsert / now / workspacePath / TIMEOUT_MS …）
 */
function lingmaHandler(p, src, ctx) {
  const { claim, upsert, now, workspacePath, TIMEOUT_MS } = ctx;
  for (const s of listLingmaSessions()) {
    if (!claim(p.id, s.id)) continue;
    if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
    const rounds = readLingmaRounds(s.id);
    if (!rounds.length) continue;
    const ph = readLingmaPhase(s.id, rounds, s, now);
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      source: 'lingma',
      sourceKind: 'lingma',
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
      model: (ph && ph.model) || '',
      inferred: true,
      ...readLingmaDone(s.id, rounds, s, now),
      lastEventAt: s.lastEventAt,
    });
  }
}

const kindHandlers = { lingma: lingmaHandler };

module.exports = {
  // 6F Qoder
  id: '6F',
  client: 'qoder',
  meta,
  kindHandlers,
  sessionTitle,
  // 插件形态数据源（原 lingma.js）
  lingmaDbPath,
  listLingmaSessions,
  readLingmaRounds,
  readLingmaPhase,
  readLingmaDone,
  hasCoreTables,
  resetLingmaCache,
  LIVE_MS,
  TTL,
  SESSION_LIMIT,
  // 插件形态任务同步器（原 qoderPluginTasks.js）
  syncQoderPluginTasks,
  startQoderPluginTaskSyncer,
  SYNC_INTERVAL_MS,
  TASK_ID_PREFIX,
  // 统一接口别名
  listSessions: listLingmaSessions,
  readRounds: readLingmaRounds,
  readPhase: readLingmaPhase,
  readDone: readLingmaDone,
  syncTasks: syncQoderPluginTasks,
};
