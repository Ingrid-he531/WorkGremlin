'use strict';

/**
 * 6F Qoder 的**插件形态**的数据源 —— 读 Qoder CN 扩展自己的 SQLite，不接 hook。
 *
 * ## 为什么 6F 的插件形态要单独一路
 *
 * Qoder CN 的编辑器插件以通义灵码发布（扩展 id 实测 `alibaba-cloud.tongyi-lingma-2.6.10`，
 * displayName 就是 "Qoder CN (Formerly Lingma)"，~/.vscode 与 ~/.trae-cn 下都装了）。
 * 它**没有 hook 子系统** —— `extension.js` 里连 `SessionStart` / `hook_event_name` /
 * `PreToolUse` 这些字样都搜不到（2026-09-30 实测），所以它不读 ~/.qoder-cn/settings.json 里
 * 那份 hook 配置，也就永远不会往 WorkGremlin 上报。CLI 那条路（hook.js --agent qoder）
 * 对它无效：**重启应用、重新编译都不会改变这一点**（同日实测：插件里聊了两轮，
 * ~/.workgremlin/hooks/events.log 里 qoder 一条事件都没有）。
 *
 * 好在它自己的落盘是可读的 SQLite：
 *   ~/.lingma/vscode/sharedClientCache/cache/db/local.db
 *
 *   chat_session              session_id / session_title / project_uri（工程绝对路径）
 *                             / session_type / mode / gmt_create / gmt_modified
 *   chat_record               一轮一次：request_id / session_id / gmt_create / gmt_modified
 *                             / summary（**明文**产出摘要，扩展自己写的）
 *                             / extra（JSON，`originalContent` 就是用户原话，**明文**）
 *   chat_snapshot              snapshot_id / chat_record_id（哪一轮的快照）/ status
 *   chat_working_space_file    snapshot_id / file_id（改动文件的**绝对路径**）
 *
 * **加密的只有逐字正文**：chat_record.question / answer、chat_message.content 都是密文
 * （同一角色的密文前缀一致，看着是 AES），本模块一个字都不碰 —— 台账的"产出摘要"用
 * 扩展自己写的 `summary`（明文）顶上，正文取不到就如实留空，绝不猜。
 *
 * ## 读法纪律（与 kilo.js / opencode.js 同一套，理由见那两处）
 *   1) 一律**只读**打开（readonly + fileMustExist）—— 扩展正在写这个库，绝不锁它、绝不写它；
 *   2) 短超时（3s）：被扩展的 checkpoint 占住就放弃这一轮，宁可没有相位；
 *   3) 读不出来（没装 / 改版换表名）回空，让 6F 如实显示"这一路读不出"，不把接口打成 500。
 *
 * 缓存：会话表 5s（与 kilo.js / sessions.js 同量级）；逐轮清单不缓存（5s 轮询一次，
 * 数据量很小，宁可每次现读 —— 相位与任务边界都靠它，读旧值会显示上一轮的标题）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProjectName } = require('./project');

/** 打开只读连接的超时：被扩展的写事务占住时立刻放弃（见文件头纪律 2） */
const OPEN_TIMEOUT_MS = 3_000;
/** 会话表缓存时长 */
const TTL = 5_000;
/** 一次最多带出多少条会话（倒序取最新的，剩下的由"最近"口径兜底） */
const SESSION_LIMIT = 50;

const HOME = os.homedir();

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

module.exports = {
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
};
