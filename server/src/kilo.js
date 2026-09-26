'use strict';

/**
 * 7F Kilo Code 的数据源 —— 读 Kilo 自己落盘的 SQLite，不接 hook。
 *
 * **Kilo Code 没有 hook 子系统**（实测 7.8.1）：`kilo --help` 只有 acp / mcp / session /
 * serve / plugin 等命令，既没有 `hooks.json` 这种配置文件，也没有任何可挂命令的事件点。
 * 所以 7F 与 1F~4F / 6F 的 hook 上报路线**在结构上就不同**：没有上报、没有心跳，
 * 只能由服务端**轮询**它的落盘。
 *
 * 好在 Kilo 的落盘比 Qoder（6F）丰富得多 —— 它是一份 **event-sourced SQLite**
 * （`~/.local/share/kilo/kilo.db`，WAL 模式），而不是"只有文件 mtime"的 jsonl：
 *
 *   session        id / project_id / directory（工程路径）/ title / agent / model
 *                  / time_updated / summary_additions|deletions|files / cost / tokens_*
 *   event          append-only 事件流，aggregate_id = 会话 id、seq 单调递增、data 存 JSON：
 *                  part.type ∈ tool|text|reasoning|step-start|step-finish|patch，
 *                  part.tool、part.state.status ∈ running|pending|completed|error、
 *                  part.time.start|end
 *   message        role ∈ user|assistant，data JSON 里带 path.cwd（工程路径）、
 *                  time.created|completed、finish ∈ stop|tool-calls|length|content-filter
 *   project        id / worktree（工程路径）；project_directory 另记了 worktree 子目录
 *   todo           session_id / content / status / priority / position
 *
 * 因此 7F 的相位是**推导出来的真值**，不是像 5F TraeCode 那样拿文件时间瞎猜：
 *   最新事件 part.type=tool 且 state.status=running  → 调用工具（带 part.tool）
 *   最新事件 part.type=tool 且 state.status=pending  → 等待授权（工具还没放行）
 *   最新事件 part.type=tool 且 state.status=error    → 出错了
 *   最新事件 part.type=reasoning                    → 思考中
 *   最新事件 part.type=step-finish                  → 汇总中
 *   最新事件 part.type=text / 长时间没事件           → 待命
 *
 * **纪律（对齐 requirements.md §P0-6「绝不编造」）**：一切相位都带 `inferred: true`。
 * 我们是**轮询**读它的库，不是它主动上报的，所以"上一条事件长什么样"只能推断"现在大致在干嘛"，
 * 中间可能有轮询间隔内已经开始的新一轮。UI 按"推断"灰显，与 5F / CLI 落盘楼层同等待遇。
 *
 * 读法上三条纪律：
 *   1) **一律只读打开**（readonly + fileMustExist）。Kilo 的 daemon 正在写这个库，
 *      只读连接在 WAL 下不阻塞它、也不会被它写坏；读不到就当"没数据"，绝不写。
 *   2) **短超时**（3s）。被 Kilo 的 checkpoint / 迁移占住时立刻放弃 —— 宁可这轮
 *      没有相位，也不能把整个会话表（渲染层 1.5s 轮询一次）拖死。
 *   3) **扫表失败不许冒泡**。这个库是别的产品的私有存储，Kilo 改版换表名是迟早的事；
 *      读不出来就回空，让 7F 显示"没接上"，而不是把 /api/v1/sessions 打成 500。
 *
 * 缓存：会话表 5s（与 sessions.js / sessionRegistry 的 TTL 同量级）。
 * 相位与完成标记**不缓存** —— 渲染层 1.5s 拉一次，宁可每次多读一次库。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProjectName } = require('./project');
const { clientBase } = require('@workgremlin/shared');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

/** 打开只读连接的超时；被 Kilo 占住就放弃这一轮 */
const OPEN_TIMEOUT_MS = 3_000;
/** 会话表缓存（会话变化比相位慢，5s 足够；与 sessionRegistry 的 TTL 同量级） */
const TTL = 5_000;

let cache = { at: 0, key: '', value: null };

/* ------------------------------ 定位落盘 ------------------------------ */

/**
 * Kilo 的数据根（XDG 规范，Kilo 用的是平台标准目录，不是 ~/.kilo 那种隐藏目录）。
 *
 * 认三个来源，优先级从高到低：
 *   1. `WORKGREMLIN_KILO_HOME` —— 显式指定（测试 / 非标准安装 / 用户自己挪过盘）
 *   2. `XDG_DATA_HOME/kilo`   —— XDG 标准位置
 *   3. 平台默认（见下）
 * `~/.kilo` **不**是数据根：实测那个目录只有安装期留下的 `bin/`（还常常是空的），
 * 会话、日志、快照、SQLite 全都在数据根下。把它当落盘会显示成"装了但 0 个会话"。
 */
function kiloHome() {
  const env = String(process.env.WORKGREMLIN_KILO_HOME || '').trim();
  if (env) return path.resolve(env);
  const xdg = String(process.env.XDG_DATA_HOME || '').trim();
  if (xdg) return path.join(path.resolve(xdg), 'kilo');
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'kilo');
  }
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'kilo');
  }
  return path.join(HOME, '.local', 'share', 'kilo');
}

/** 事件库的绝对路径；文件不存在回空串（Kilo 没装 / 没跑过） */
function kiloDbPath() {
  const explicit = String(process.env.WORKGREMLIN_KILO_DB || '').trim();
  const p = explicit ? path.resolve(explicit) : path.join(kiloHome(), 'kilo.db');
  try {
    return fs.statSync(p).isFile() ? p : '';
  } catch {
    return '';
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
 * 开一个**只读**连接；拿不到（Kilo 没跑过 / 库被锁 / 表结构变了）一律回 null。
 *
 * 只读是硬要求，不是省事：Kilo 的 daemon 正在写这个库，我们绝不能因为一个监控端
 * 去锁它、也绝不能把它写坏。WAL 模式下只读连接不阻塞写入方，两者可以并存。
 */
function openDb() {
  const file = kiloDbPath();
  if (!file) return null;
  let Database;
  try {
    // better-sqlite3 是 server 的既有依赖（见 server/src/db/index.js），走工作区那份，
    // 不在适配器里自己编译一份原生模块。
    Database = require('better-sqlite3');
  } catch {
    return null; // 原生模块没编出来：7F 读不了，其余楼层照常
  }
  try {
    return new Database(file, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * 在只读连接上跑一条查询；表不存在 / SQL 不对（Kilo 改版换表）都回 null。
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

/** 库里到底有没有这些表 —— 用来给前端一句"这一路读不出会话"的说明 */
function hasCoreTables() {
  return query((db) => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','event','message')")
      .all()
      .map((r) => r.name);
    return names.length === 3;
  }) === true;
}

/* ------------------------------ 会话清单 ------------------------------ */

/** 库里 model 字段是 JSON 字符串，取出 id 给人看（取不到就留空，不猜） */
function modelIdOf(raw) {
  try {
    const j = JSON.parse(String(raw || ''));
    return String(j && (j.id || j.modelID) || '');
  } catch {
    return '';
  }
}

/**
 * Kilo 的全部会话（未归档），按最近更新倒序。
 *
 * 过滤口径：`time_archived IS NULL` —— 归档掉的会话不算"在跑"（用户手动 `kilo session delete`
 * 之后 Kilo 会打这个时间戳）。归档列是 7.8.1 才有的，老版本没有这一列时 SQL 会报错，
 * 整条查询回 null（→ 7F 显示"没接上"），而不是悄悄按"全部会话"放行。
 *
 * 字段映射（→ sessionRegistry 的会话行）：
 *   id → 会话 id（轴 2，Kilo 的 ses_xxx 就是 hook 意义上的 session_id）
 *   directory → 工程路径（Kilo 每条会话都记了自己的工作目录，比 project.worktree 更准 ——
 *               worktree 子会话跑在别处时 directory 才是真的）
 *   time_updated → 最后活动时间（Kilo 每写一条消息/事件都推进它，比翻文件时间准）
 *
 * @returns {Array<{id,title,directory,project,projectPath,lastEventAt,agent,model,fileCount}>}
 */
function listKiloSessions() {
  const now = Date.now();
  const file = kiloDbPath();
  // 缓存按**库文件路径**分键：换 KILO_HOME / 换库时不会把上一处的会话端上来。
  // 读不出来（没装 / 被锁 / 表结构变了）时缓存空清单，别让每 1.5s 的轮询都去撞一次锁。
  if (cache.value && cache.key === file && now - cache.at < TTL) return cache.value;
  const rows = query((db) =>
    db
      .prepare(
        `SELECT id, title, directory, agent, model, time_updated,
                summary_files, summary_additions, summary_deletions
           FROM session
          WHERE time_archived IS NULL
          ORDER BY time_updated DESC`
      )
      .all()
  );
  const value = (Array.isArray(rows) ? rows : []).map((r) => {
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
  cache = { at: now, key: file, value };
  return value;
}

/* ------------------------------ 相位推导 ------------------------------ */

/**
 * 一条会话的**当前相位**。
 *
 * 取这条会话最后几条事件（`event` 表按 (aggregate_id, seq) 有唯一索引，取尾部很便宜），
 * 从后往前找**第一条带 part 的**，按 part.type / part.state.status 归相位：
 *
 *   tool + running   → 调用工具（Kilo 正在跑这个工具；工具名/命令从 part 里取）
 *   tool + pending   → 等待授权（工具排着队还没放行 —— Kilo 的 approval 就落在这个状态）
 *   tool + error     → 调用工具但报错了（显示工具名，UI 侧按失败灰显）
 *   reasoning        → 思考中
 *   step-start       → 规划中（新一步刚起头）
 *   step-finish      → 汇总中
 *   patch            → 调用工具（正在落盘改动）
 *   text             → 待命（刚吐完一段文字）
 *   step-finish/step-start/text 都对不上 → 待命
 *
 * **只认"新鲜"证据**：`session.turn` 结束之后那条 text 事件会一直躺在库里，不看新鲜度
 * 就会把三天前收工的那句回复永远显示成"刚刚在说话"。所以要求事件时间落在
 * `PHASE_FRESH_MS`（2 分钟，与 sessions.js 的 FRESH_MS 同量级）之内，超了就是待命。
 * 这是"轮询"相比 hook 的固有差距：轮询只能靠时间窗猜这一轮还在不在，
 * 所以**相位一律带 inferred: true**，UI 按推断灰显。
 *
 * @param {string} sessionId
 * @returns {{phase:string,action:string,target:string,tool:string,context:string[],prompt:string,model:string,inferred:boolean}|null}
 */
const PHASE_FRESH_MS = 2 * 60_000;
/** 往回看多少条事件够用（一轮对话末尾最多 tool→reasoning→text 几条，64 条极宽裕） */
const PHASE_LOOKBACK = 64;

function readKiloPhase(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const events = query((db) =>
    db
      .prepare(
        `SELECT data FROM event
          WHERE aggregate_id = ? AND JSON_extract(data,'$.part.type') IS NOT NULL
          ORDER BY seq DESC LIMIT ?`
      )
      .all(id, PHASE_LOOKBACK)
  );
  if (!Array.isArray(events) || !events.length) return null;

  const now = Date.now();
  for (const ev of events) {
    let part = null;
    try {
      const d = JSON.parse(String(ev.data || ''));
      part = d && typeof d === 'object' ? d.part || null : null;
    } catch {
      part = null; // 半截 / 非 JSON：跳过这一条，不猜
    }
    if (!part || typeof part !== 'object') continue;

    // 事件自身的时间：Kilo 把它放在 part.time.end|start（没有顶层 time 列，见实测）
    const tm = part.time && typeof part.time === 'object' ? part.time : {};
    const at = Number(tm.end) || Number(tm.start) || 0;
    // 上面那些 part 状态（如 running）没有 time；这类"状态事件"要靠库里最新事件的
    // 时间来判断新鲜度，而不是因为 part.time 为空就当成陈旧。
    if (at && now - at > PHASE_FRESH_MS) break; // 从新到旧，第一条过期的就说明这一轮早收工了

    const type = String(part.type || '');
    const tool = String(part.tool || '');
    const status = String(part.state && part.state.status || '');
    const input = part.state && part.state.input && typeof part.state.input === 'object' ? part.state.input : {};

    if (type === 'tool') {
      if (status === 'running') {
        return {
          phase: 'tool',
          action: commandOf(input) || `调用 ${tool || '工具'}`,
          target: fileOf(input),
          tool,
          context: tool ? [`工具：${tool}`] : [],
          prompt: '',
          model: '',
          inferred: true,
        };
      }
      if (status === 'pending') {
        return {
          phase: 'await',
          action: tool ? `申请执行 ${tool}` : '等待用户授权',
          target: fileOf(input),
          tool,
          context: ['等待用户授权后继续', tool && `工具：${tool}`].filter(Boolean),
          prompt: '',
          model: '',
          inferred: true,
        };
      }
      if (status === 'error') {
        return {
          phase: 'tool',
          action: tool ? `调用 ${tool} 报错` : '调用工具报错',
          target: fileOf(input),
          tool,
          context: ['上一支工具执行失败'],
          prompt: '',
          model: '',
          inferred: true,
        };
      }
      continue; // completed：这一支跑完了，看上一条事件（可能还有下一个工具）
    }
    if (type === 'patch') {
      const f = String(part.file || input.file || input.filePath || '');
      return {
        phase: 'tool',
        action: f ? `改 ${f}` : '落盘改动',
        target: f,
        tool: 'patch',
        context: f ? [`目标：${f}`] : [],
        prompt: '',
        model: '',
        inferred: true,
      };
    }
    if (type === 'reasoning') {
      return { phase: 'thinking', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
    }
    if (type === 'step-start') {
      return { phase: 'plan', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
    }
    if (type === 'step-finish') {
      return { phase: 'summarize', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
    }
    if (type === 'text') {
      // 刚吐完一段文字 = 这一轮的输出阶段，往下（更旧）就是上一轮的事了
      return { phase: 'idle', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
    }
  }
  return { phase: 'idle', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
}

/** 工具入参里的可读命令（bash 的 command / 其他工具的 description） */
function commandOf(input) {
  const c = String(input.command || '');
  if (c) return c.replace(/\s+/g, ' ').trim().slice(0, 120);
  const d = String(input.description || '');
  return d.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 工具入参里的目标文件（write/edit/apply_patch 各家的字段名不统一，都认一遍） */
function fileOf(input) {
  const p = input.file || input.filePath || input.file_path || input.path || input.target_file || '';
  return typeof p === 'string' ? p : '';
}

/* ------------------------------ 完成标记 ------------------------------ */

/** 完成标记的新鲜期：只有这么久之内结束的才算"刚发生"，否则页面一开就重播上一轮 */
const DONE_TTL_MS = 10 * 60_000;
/** 完成标记缺省时统一返回（没有就是"没有"，不臆造） */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [] };

/**
 * 这条会话的"完成"标记 —— 对应 hook 那边 Stop 事件落下的 done。
 *
 * Kilo 没有 Stop 事件，但 `message` 表里有等价的东西：一条 `role='assistant'` 且
 * `finish` 不是 `tool-calls` 的消息（实测取值：stop / tool-calls / length / content-filter）。
 * 语义映射（Kilo 的 finish 与 OpenAI 风格一致）：
 *   finish=stop           → 正常说完，**这就是"任务完成"**
 *   finish=tool-calls      → 还要接着调工具，**不是**完成（跳过）
 *   finish=length         → 撞长度上限被截断（是结束，但语义上算"没说完"——当完成会误导）
 *   finish=content-filter → 被内容过滤拦下（同上，不当完成）
 *   finish 为空            → 还在流式输出中，不是完成
 *
 * 只认 `time.completed` 落过且在 DONE_TTL_MS 之内的；没有 completed 的（正在输出的那条）
 * 明确不算完成。标题取会话标题（Kilo 自己起的），文件数取 session.summary_files。
 * @param {string} sessionId
 * @param {{title?:string,fileCount?:number}} meta 会话自身的静态信息
 */
function readKiloDone(sessionId, meta = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return NO_DONE;
  const row = query((db) =>
    db
      .prepare(
        `SELECT time_updated, data FROM message
          WHERE session_id = ? AND JSON_extract(data,'$.role')='assistant'
            AND JSON_extract(data,'$.finish') IS NOT NULL
            AND JSON_extract(data,'$.finish') != 'tool-calls'
            AND JSON_extract(data,'$.finish') != ''
            AND JSON_extract(data,'$.time.completed') IS NOT NULL
          ORDER BY time_updated DESC LIMIT 1`
      )
      .get(id)
  );
  if (!row) return NO_DONE;
  let data = {};
  try {
    data = JSON.parse(String(row.data || ''));
  } catch {
    data = {};
  }
  const finish = String((data && data.finish) || '');
  // 撞长度 / 被内容过滤：算"这条消息结束了"但不该亮"任务完成"，退回空标记
  if (finish === 'length' || finish === 'content-filter') return NO_DONE;
  const at = Number(data && data.time && data.time.completed) || 0;
  if (!at || Date.now() - at > DONE_TTL_MS) return NO_DONE;
  return {
    doneAt: at,
    doneTitle: String(meta.title || ''),
    doneCount: Number(meta.fileCount) || 0,
    doneFiles: [],
  };
}

/* ------------------------------ 对外 ------------------------------ */

/**
 * 这条会话有没有"接上"（Kilo 库里真有它）。
 * 渲染层靠它区分"这个产品根本没在跑"与"在跑但此刻没动作"（同 reporter-phase 的 instrumented）。
 */
function kiloInstrumented(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  return query((db) => Boolean(db.prepare('SELECT 1 FROM session WHERE id = ?').get(id)));
}

/**
 * 7F 的"上报相位"—— 与 reporterMainPhase 同一个形状，
 * 供 /api/v1/reporter-phase 在 client 是 kilo 时走这一路。
 *
 * 没有 client/session 参数时按"最近更新的那条会话"取（与 hook 那侧"同 client 里谁最新显示谁"
 * 的老行为对齐）；传了 session 就只认那一条。
 * @param {string} workspacePath
 * @param {string} session
 * @returns {{sessionId:string,phase:string,action:string,target:string,context:string[],tool:string,prompt:string,model:string}|null}
 */
function kiloMainPhase(workspacePath, session = '') {
  const list = listKiloSessions();
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
  const ph = readKiloPhase(row.id);
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

module.exports = {
  kiloHome,
  kiloDbPath,
  shorten,
  hasCoreTables,
  listKiloSessions,
  readKiloPhase,
  readKiloDone,
  kiloInstrumented,
  kiloMainPhase,
  NO_DONE,
};
