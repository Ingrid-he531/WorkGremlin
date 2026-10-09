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
 *   最新事件 part.type=patch                        → 调用工具（正在落盘改动）
 *   最新事件 part.type=text                          → 待命（刚吐完一段文字）
 *   step-start / step-finish / 工具 completed         → **不是相位**，跳过继续往更旧处找
 *
 * 为什么 step-* 不映射成「规划中 / 汇总中」：实测一个会话里 step-start 363 次、
 * step-finish 361 次（对照 tool 2677 次、text 463 次），基本是每轮 assistant 输出前后各一条
 * —— 那是「一步」的边界**记账**，不是 agent 在规划或在收尾。硬套的后果是：每次工具刚跑完、
 * 最新事件恰好落在 step-finish 上时，控制台就一直卡在「汇总中」—— 而那恰恰是
 * "这一步跑完了、正要进入下一步"的时刻。推不出来就别推（见下方 step 分支的注释）。
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
const { clientBase, DEFAULTS, clientOf } = require('@workgremlin/shared');
const { openReadonly, readOne } = require('./dbReadonly');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

/**
 * 7F Kilo Code 楼层元数据（原 products.js 的 7F 条目）。CLI 与 IDE 扩展合并楼层。
 */
const meta = {
  id: '7F',
  name: 'Kilo Code',
  kind: 'cli',
  cmd: 'kilo',
  agent: 'kilo',
  plugin: false,
  // 同 3F/4F：VS Code 扩展 kilocode.kilo-code-* 也是这一层的安装证据。
  altPluginRe: /^kilocode\./i,
  sources: [
    {
      kind: 'kilo',
      label: 'CLI/Plugin',
      client: clientOf('kilo', false),
      dirs: [kiloHome()],
      note: '这一路读的是数据根里的 kilo.db（SQLite），不是可扫的会话文件；文件数/体积是数据根的落盘统计，不是会话数',
    },
    // hook 那一路：装了 WorkGremlin 插件时的真相位一路（client = kilo-plugin）。
    { kind: 'hook', client: clientOf('kilo', true) },
  ],
  hookSource: true,
  dataKind: clientOf('kilo', false),
  // Kilo CLI 自己的安装目录（PATH 查不到时兜底）
  cliBinDirs: [path.join(HOME, '.kilo', 'bin')],
};

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

/**
 * 会话标题（7F Kilo Code）：SQLite session.title。
 * 原 sessionTitle.js 的 kiloTitleOf 搬到这里 —— 调试 7F 标题不必碰中央文件。
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function sessionTitle(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const db = openReadonly(kiloDbPath());
  if (!db) return '';
  try {
    const row = readOne(db, 'SELECT title FROM session WHERE id = ?', id);
    return String((row && row.title) || '').trim();
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

/**
 * 库里到底有没有这些表 —— 用来给前端一句"这一路读不出会话"的说明 */
function hasCoreTables() {
  return query((db) => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','event','message')")
      .all()
      .map((r) => r.name);
    return names.length === 3;
  }) === true;
}

/**
 * part.text 的剥壳：实测 Kilo 存进去的值带一层 JSON 引号（`'"…"'`），
 * 先按 JSON 剥一层，剥不掉就用原文。
 *
 * 压空白与截断留给调用方 —— 各处上限不同（屏上那句 80 字，台账的收尾自述 4000 字）。
 * @param {string} raw
 * @returns {string}
 */
function unquoteText(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const un = JSON.parse(s);
    if (typeof un === 'string') return un.trim();
  } catch {
    /* 不是 JSON 包裹的，原样用 */
  }
  return s;
}

/**
 * 这一轮**用户说的话**（「思考中」时主控制台屏上显示的那句）。
 *
 * 取法：event 里 role=user 的 text part，按 seq 倒序取最新一条 —— 用户原话就在
 * `part.text` 里（实测值带一层 JSON 引号，要剥掉），这与插件那一路
 * （plugin/index.js 的 role==='user' 分支）是同一个信号，只是这里从库里读而不是从事件流收。
 *
 * 为什么轮询这一路也要有它：早先 `readKiloPhase` 每个分支都写死 `prompt: ''`，
 * 于是 7F 的「思考中」屏上**一个字都没有**。别的楼层不空，是因为它们的 hook 把
 * 用户原话以 `taskTitle` 写进状态文件，服务端 `readReporterPhase` 读出来当 prompt
 * （见 sessions.js 的 winPrompt）。7F 没装插件时没有那份状态文件，就只能自己从库里取 ——
 * 取的是用户自己的原话，不是编的。
 *
 * 取不到（表缺 / 没有用户消息 / JSON 坏了）一律回空串：宁可空屏，不拿会话标题顶替。
 * @param {string} sessionId
 * @returns {string}
 */
function readRoundPrompt(sessionId) {
  const rows = query((db) =>
    db
      .prepare(
        `SELECT e.data AS data
           FROM event e
           JOIN message m ON m.id = JSON_extract(e.data,'$.part.messageID')
                              AND m.session_id = e.aggregate_id
          WHERE e.aggregate_id = ?
            AND JSON_extract(e.data,'$.part.type') = 'text'
            AND JSON_extract(m.data,'$.role') = 'user'
          ORDER BY e.seq DESC LIMIT 1`
      )
      .all(String(sessionId))
  );
  if (!Array.isArray(rows) || !rows.length) return '';
  try {
    const d = JSON.parse(String(rows[0].data || ''));
    const said = unquoteText((d && d.part && d.part.text) || '');
    if (!said) return '';
    return said.replace(/\s+/g, ' ').trim().slice(0, 80);
  } catch {
    return '';
  }
}

/* ------------------------------ 逐轮清单（7F 台账用） ------------------------------ */

/**
 * 一轮"算不算收工"的窗口。
 *
 * **不要和 `PHASE_FRESH_MS`（2 分钟）混用**：那个管"屏上现在显什么相位"，
 * 这个管"这一轮完了没有"。实测这条会话的同一轮里有过 **780 秒**的生成间隔
 * （慢速 free 模型：一条 assistant 消息 06:17:37 → 06:30:37 才写完），
 * 拿 2 分钟当收工窗口会把正在跑的轮判成"没干完就断了"。
 * 窗口短了会翻转（运行中↔已取消），长了会让中断的轮多挂一会儿 —— 取 10 分钟。
 */
const ROUND_IDLE_MS = 10 * 60_000;

/** part.data.files 是 JSON 数组（Kilo 自己记的改动文件，实测绝对路径）；形状不对就当没有 */
function filesOf(raw) {
  if (!raw) return [];
  let arr = null;
  try {
    arr = JSON.parse(String(raw));
  } catch {
    return []; // 半截 / 非 JSON：不猜
  }
  if (typeof arr === 'string') arr = [arr];
  if (!Array.isArray(arr)) return [];
  return arr.map((f) => String(f || '').trim()).filter(Boolean);
}

/**
 * 这条会话**逐轮**的用户任务清单（7F 台账按「每一轮一条」记账用，口径与 8F 的
 * `readOpencodeTurns` 对齐）。
 *
 * 轮的边界：`message` 表里 `role='user'` 的消息起一轮，`startedAt` 取它的 `time_created`
 * —— 这个值**不可变**，所以 9F Copilot 那条"起点被insertTask的 COALESCE 钉住、
 * 只好删行重建"的补丁 7F 不需要。
 *
 * 轮的收口：复用 `turnIsOver`（与 `readKiloDone` 判完成、插件判收工同一口径）。
 * 有终态 finish 的按 finish 映射（stop → done，length / content-filter → cancelled），
 * **没有终态又不是最后一轮**的按 cancelled 记 —— 那一轮要么是用户按了 ESC（插件那一路
 * 才写得出取消标记，见 NO_DONE 的说明），要么是进程没了，两种都是"没干完"。
 *
 * 注意 **`session_message` 表在 Kilo 是空的**（实测 0 行）—— 8F OpenCode 的轮次从那张表读，
 * 7F 只能从 `message` + `part` 拼，别照抄。
 *
 * 读不出来（库没装 / 表被改 / JSON 坏了）一律回空数组 —— 绝不冒泡（文件头纪律 3）。
 * `message` 表缺了就真没有轮；`part` 表缺了只是 prompt / files / result 为空，轮还在。
 * @param {string} sessionId
 * @returns {Array<{index:number, prompt:string, startedAt:number, endedAt:number|null,
 *   outcome:'running'|'done'|'cancelled', files:string[], result:string}>}
 */
/**
 * 把一条 assistant 消息的 `data.tokens` 折进本轮的累计。
 *
 * 库里那一项的形状是 `{total, input, output, reasoning, cache:{read,write}}`，语义**与 Claude 一致**
 * （`input` 不含缓存、`reasoning` 单列）：全库实测 `input+output+reasoning+read+write == total`
 * （590 条里 589 条精确成立，1 条差 26 —— Kilo 自己写的，不是我们算的）。
 *
 * 折法只有一处选择：**reasoning 并进 output**。因为对账的另一头 Claude 的 `output_tokens`
 * 本来就含思考（`output_tokens_details.thinking_tokens` 是它的明细），Codex 的 `output_tokens`
 * 同理（`reasoning_output_tokens` 含在里面）。留着单列，同一列在 7F/8F 会凭空少一截。
 * @param {{input:number,output:number,cacheRead:number,cacheWrite:number}} acc 本轮累计（原地改）
 * @param {any} t 一条消息的 data.tokens（形状不对就当没有）
 */
function foldKiloTokens(acc, t) {
  if (!t || typeof t !== 'object') return acc;
  const cache = t.cache && typeof t.cache === 'object' ? t.cache : {};
  acc.input += posNum(t.input);
  acc.output += posNum(t.output) + posNum(t.reasoning);
  acc.cacheRead += posNum(cache.read);
  acc.cacheWrite += posNum(cache.write);
  return acc;
}

/** 非负数才认（与 reporter/src/usage.js 的 num 同口径：缺字段就是没有，不拿别的顶上） */
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 这份累计里真有数吗 —— 四项全 0 就是"没读到"，不是"消耗为零"（见调用处的 return） */
function hasTokens(t) {
  return Boolean(t) && t.input + t.output + t.cacheRead + t.cacheWrite > 0;
}

function readKiloRounds(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  // 两条语句走**同一次** query()（只读连接开一次就够；part 表在 session_id 上没有索引，
  // 整表扫一次约 5ms，别开第二条连接再扫一遍）。
  const data = query((db) => {
    const out = { msgs: [], parts: [] };
    // 各自 try/catch：part 表缺了轮还在，message 表缺了才是真没有
    try {
      out.msgs = db
        .prepare(
          `SELECT id, time_created AS createdAt, time_updated AS updatedAt, data AS data
             FROM message WHERE session_id = ? ORDER BY time_created, id`
        )
        .all(id);
    } catch {
      out.msgs = [];
    }
    try {
      // 只 json_extract、不整行 parse：tool part 的 data 里塞着几 KB 的工具输出
      out.parts = db
        .prepare(
          `SELECT p.message_id AS messageId,
                  JSON_extract(p.data,'$.type')  AS type,
                  JSON_extract(p.data,'$.text')  AS text,
                  JSON_extract(p.data,'$.files') AS files,
                  MAX(p.time_updated,
                      COALESCE(JSON_extract(p.data,'$.time.end'), 0),
                      COALESCE(JSON_extract(p.data,'$.time.start'), 0)) AS at
             FROM part p WHERE p.session_id = ?`
        )
        .all(id);
    } catch {
      out.parts = [];
    }
    return out;
  });
  const msgs = Array.isArray(data && data.msgs) ? data.msgs : [];
  if (!msgs.length) return [];

  const partsByMsg = new Map();
  for (const p of Array.isArray(data && data.parts) ? data.parts : []) {
    const k = String(p.messageId || '');
    if (!k) continue;
    if (!partsByMsg.has(k)) partsByMsg.set(k, []);
    partsByMsg.get(k).push(p);
  }

  /** 这一轮里各条 part 的时间也要算进 lastAt（工具跑完的时刻比消息的 time_updated 更贴） */
  const foldAt = (round, own) => {
    for (const p of own) round.lastAt = Math.max(round.lastAt, Number(p.at) || 0);
  };

  const rounds = [];
  let cur = null;
  for (const m of msgs) {
    let md = null;
    try {
      md = JSON.parse(String(m.data || ''));
    } catch {
      md = null; // 坏 JSON：这条消息的 role/finish 读不出，但它的 part 仍然算时间
    }
    if (!md || typeof md !== 'object') md = {};
    const own = partsByMsg.get(String(m.id)) || [];
    const at = Number(m.updatedAt) || Number(m.createdAt) || 0;

    if (String(md.role || '') === 'user') {
      // 这一轮用户说的话：它的 text part（Kilo 可能拆成多条，取第一条非空的）
      let prompt = '';
      for (const p of own) {
        if (String(p.type || '') !== 'text') continue;
        const said = unquoteText(p.text);
        if (said) {
          prompt = said.replace(/\s+/g, ' ').trim().slice(0, 80);
          break;
        }
      }
      // **没有 text part 的 user 消息不是新任务**，是 Kilo 自己的 compaction 注入
      // （全库实测只有一条，紧跟在被打断的那一轮之后）—— 折进当前轮，不新起 index。
      // 真的连一轮都还没开始（会话头就是它）才拿它当一轮，免得这几条消息无处安放。
      if (!prompt && cur) {
        cur.lastAt = Math.max(cur.lastAt, at);
        foldAt(cur, own);
        continue;
      }
      if (cur) rounds.push(cur);
      cur = {
        index: rounds.length,
        prompt,
        startedAt: Number(m.createdAt) || at,
        lastAt: at,
        finish: '',
        over: false,
        files: new Set(),
        result: '',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      foldAt(cur, own);
      continue;
    }

    if (!cur) continue; // 会话开头不是 user 消息的，不编一轮
    cur.lastAt = Math.max(cur.lastAt, at);
    foldAt(cur, own);
    // 本轮的 token 消耗：assistant 消息的 data.tokens 逐条累加（user 消息没有这一项）
    foldKiloTokens(cur.tokens, md.tokens);
    if (turnIsOver(m.data)) cur.over = true;
    const fin = String(md.finish || '');
    if (fin) cur.finish = fin;
    for (const p of own) {
      const t = String(p.type || '');
      if (t === 'text') {
        // 这一轮的收尾自述：后面的消息会覆盖前面的，最终留下"最后那条消息说的话"
        // （与 8F:opencode.js 和插件那一路同口径）
        const said = unquoteText(p.text);
        if (said) cur.result = said.replace(/\s+/g, ' ').trim().slice(0, 4_000);
      } else if (t === 'patch') {
        // 改动文件只认 patch part —— **不认工具入参**：read / grep 这些只读工具也带
        // filePath，拿它当"改动"会把只读过的文件算进「本轮改动」
        for (const f of filesOf(p.files)) cur.files.add(f);
      }
    }
  }
  if (cur) rounds.push(cur);

  const now = Date.now();
  return rounds.map((r, i) => {
    const next = rounds[i + 1];
    const isLast = i === rounds.length - 1;
    // "还在飞" = 最后一轮 + 没有终态 finish + 窗口内还有动静。
    // 非最后一轮的必然已收工（后面已经开了新的一轮），不看窗口。
    const running = isLast && !r.over && now - r.lastAt < ROUND_IDLE_MS;
    const outcome = running ? 'running' : r.over ? (r.finish === 'stop' ? 'done' : 'cancelled') : 'cancelled';
    // 收工时刻夹一下：流式 assistant 消息的 time_updated 可能晚于下一条用户消息的时间
    const endedAt =
      outcome === 'running'
        ? null
        : Math.max(r.startedAt, Math.min(r.lastAt || r.startedAt, next ? next.startedAt : Infinity));
    return {
      index: r.index,
      prompt: r.prompt,
      startedAt: r.startedAt,
      endedAt,
      outcome,
      files: [...r.files],
      result: r.result,
      // 本轮消耗的 token（语义见 foldKiloTokens）。四项全 0 = 这一轮库里一条 tokens 都没有
      // （Kilo 老版本不写这一项、或这一轮还没跑完一次请求）→ **null**，让台账留空，
      // 而不是写 4 个 0 冒充"消耗为零"。
      tokens: hasTokens(r.tokens) ? r.tokens : null,
    };
  });
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
 * **议事厅的参与者不进这张表**（`title = COUNCIL_SESSION_TITLE` 的直接跳过）：
 * 工程模式下参与者的 cwd 就是用户的工程，会话会带着真实工程路径落进这个库 ——
 * 不挡的话它当场变成办公室 7F 上多出来的一个"会话"，而 requirements.md §15.2 白纸黑字写着
 * 「一场会开完，办公室那页看不出任何痕迹」。挡的**依据是标题**（参与者是我们自己拉起来的，
 * 标题由 council/agents.js 指定），不改库、不必知道议事厅的状态，所以这条过滤在
 * "这一场会还在不在跑"之外也成立。
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
            AND (title IS NULL OR title <> ?)
          ORDER BY time_updated DESC`
      )
      .all(DEFAULTS.COUNCIL_SESSION_TITLE)
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
 *   patch            → 调用工具（正在落盘改动）
 *   text             → **看这条 text 属于哪条消息**（见下面那段，改过两次）
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
  // 这一轮用户说的话（「思考中」屏上第二/第三层显示的就是它）。
  // 取一次就够：整个 readKiloPhase 里所有返回分支共用同一个值。
  const prompt = readRoundPrompt(id);
  // 顺带把这条 part 归属的 message 一起带出来（LEFT JOIN）：判 text 是不是"这一轮的收尾"
  // 要看那条消息的 finish，单独再查一次 message 表是多余的往返（见下面 text 分支的注释）。
  const events = query((db) =>
    db
      .prepare(
        `SELECT e.data AS data, m.data AS mdata
           FROM event e
           LEFT JOIN message m ON m.id = JSON_extract(e.data,'$.part.messageID')
          WHERE e.aggregate_id = ? AND JSON_extract(e.data,'$.part.type') IS NOT NULL
          ORDER BY e.seq DESC LIMIT ?`
      )
      .all(id, PHASE_LOOKBACK)
  );
  if (!Array.isArray(events) || !events.length) return null;

  const now = Date.now();
  for (const ev of events) {
    let part = null;
    let envTime = 0;
    try {
      const d = JSON.parse(String(ev.data || ''));
      part = d && typeof d === 'object' ? d.part || null : null;
      // 信封上的 `time`（**每一条都有**，实测是一条 number，见下）
      envTime = Number(d && d.time) || 0;
    } catch {
      part = null; // 半截 / 非 JSON：跳过这一条，不猜
    }
    if (!part || typeof part !== 'object') continue;

    // 事件自身的时间。**三处都认，缺一不可**（实测统计见下面注释）：
    //   part.time.end | part.time.start —— reasoning / 已完成的 text 有
    //   信封 time（number）              —— **每一条都有**
    // 早先只读 part.time，于是 tool / patch / step-start / 正在流式吐字的 text
    // （part.time 为 undefined）算出 at=0，`if (at && ...)` 直接跳过新鲜度判定 ——
    // 收工几小时的会话照样按"最新那条"给相位。这是个**早就存在的洞**，只是原先
    // `text → 待命` 恰好把它盖住了：轮询把这类会话显示成待命，看上去"对"。
    // 改成"轮中文字 → 思考中"之后，洞就露出来了：一个 50 分钟前收工、
    // 最后一条是无 part.time 的 text 的会话，会永远显示「思考中」。
    // 实测真机统计（一个真实会话最近 400 条 part 事件）：
    //   text 26 条 / reasoning 38 条 / step-finish 30 条 有 part.time；
    //   tool 270 条 / step-start 30 条 / patch 5 条 / 流式 text 1 条 **没有** part.time。
    // 所以信封 time 才是可靠的兜底。
    const tm = part.time && typeof part.time === 'object' ? part.time : {};
    const at = Number(tm.end) || Number(tm.start) || envTime;
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
          prompt,
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
          prompt,
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
          prompt,
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
        prompt,
        model: '',
        inferred: true,
      };
    }
    if (type === 'reasoning') {
      return { phase: 'thinking', action: '', target: '', tool: '', context: [], prompt, model: '', inferred: true };
    }
    // step-start / step-finish **不是相位**，跳过继续往更旧的事件找。
    //
    // 它们是「一步」的边界标记：实测一个会话里 step-start 363 次 / step-finish 361 次
    // （对照 tool 2677 次、text 463 次）—— 基本是每轮 assistant 输出前后各一条。
    // 早先这里把 step-start 映射成「规划中」、step-finish 映射成「汇总中」，后果是：
    // 每次工具刚跑完、最新事件恰好落在 step-finish 上时，控制台就一直卡在「汇总中」
    // （恰恰是"这一步跑完了、正要进入下一步"的时刻）。「规划中 / 汇总中」在相位词汇表里
    // 指的是 agent 真的在规划 / 真的在收尾汇总，从这两个记账标记里**推不出来** ——
    // 硬套就是编造相位（见 requirements.md §P0-6）。
    //
    // 跳过之后落到的那条才是真相位：下一条多半是 reasoning（思考中）或
    // text（待命）；工具 completed 本身也走上面的 continue，同样往更旧处找。
    if (type === 'step-start' || type === 'step-finish') {
      continue;
    }
    if (type === 'text') {
      // **text 不等于"待命"** —— 这里改过一次，实测踩的坑记在下面。
      //
      // 早先一律 `text → 待命`，理由是"刚吐完一段文字 = 这一轮的输出阶段"。
      // 但 Kilo 在**一轮之内**会多次吐文字（每次工具调用前后都可能来一段），
      // 而轮询只看得到"最新那条 part"：模型在两次工具调用之间说话时，最新 part 正是 text，
      // 于是控制台在**任务明明还在跑**的时候闪回「待命中」，过几秒又被下一条 tool 事件
      // 顶回「调用工具」。用户看到的现象就是"主 agent 状态在待命 / 调用工具之间来回跳"。
      //
      // 判据用**这条 text 归属的那条 message 的 finish**（message 表，part.messageID 对得上）：
      //   finish='stop'（且 time.completed）→ 这一轮真的说完了 → 待命
      //   finish='tool-calls'              → 到工具调用处断了，**整轮还没完** → 思考中
      //   还没有 finish（正在流式吐字）      → 整轮还没完 → 思考中
      // 实测分布（本机 Kilo 7.8.1 一个真实会话）：assistant 的 text part 里
      // finish=stop 只有 2 条，finish=tool-calls 14 条，还在流式 2 条 —— 绝大多数是"轮中"。
      //
      // 口径与 readKiloDone 判"完成"一致（那里也是 finish!=='tool-calls' 才算收工），
      // 也与插件那一路同源（plugin/index.js 的 message.updated 分支同样按 finish 分流）。
      if (turnIsOver(ev.mdata)) {
        return { phase: 'idle', action: '', target: '', tool: '', context: [], prompt, model: '', inferred: true };
      }
      return { phase: 'thinking', action: '', target: '', tool: '', context: [], prompt, model: '', inferred: true };
    }
  }
  return { phase: 'idle', action: '', target: '', tool: '', context: [], prompt, model: '', inferred: true };
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

/**
 * 这条消息是不是"整轮说完了"（读 event 时 LEFT JOIN message 带出来的那一列 `mdata`）。
 *
 * 口径与 readKiloDone 判完成、插件 message.updated 分支判收工**完全一致**：
 * `finish` 存在、`time.completed` 存在、且 `finish !== 'tool-calls'`。
 * `tool-calls` 只是"这条消息到工具调用处断了"，整轮还在继续。
 *
 * 取不到 message 行（LEFT JOIN 落空 / JSON 坏了）时返回 false —— 也就是**偏向"还在想"**：
 * 宁可显示「思考中」也不要把一个还在跑的任务说成「待命中」（那是在把进行中报成空闲）。
 * @param {any} mdata message.data 那一列（原始 JSON 字符串）
 * @returns {boolean}
 */
function turnIsOver(mdata) {
  if (!mdata) return false;
  let m = null;
  try {
    m = JSON.parse(String(mdata));
  } catch {
    return false;
  }
  if (!m || typeof m !== 'object') return false;
  const finish = String(m.finish || '');
  if (!finish || finish === 'tool-calls') return false;
  return Boolean(m.time && m.time.completed);
}

/* ------------------------------ 完成标记 ------------------------------ */

/** 完成标记的新鲜期：只有这么久之内结束的才算"刚发生"，否则页面一开就重播上一轮 */
const DONE_TTL_MS = 10 * 60_000;
/** 完成标记缺省时统一返回（没有就是"没有"，不臆造）。
 *  doneCancelled：这一轮是被用户打断（ESC / 停止）收掉的 → 主控制台亮红色「任务取消」。
 *  Kilo 的**轮询**这一路读不出"被打断"（`message.finish` 只有 stop / tool-calls / length /
 *  content-filter，没有 interrupted），所以这里恒为 false —— 不臆造取消。装了 WorkGremlin
 *  插件时，由插件的 `session.idle` 那一路上报取消标记（见 packages/reporter/src/plugin）。 */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false };

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
    doneCancelled: false,
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

/* ===================== 任务同步器（原 kiloTasks.js，已合并进本楼层文件） ===================== */
const SYNC_INTERVAL_MS = 5_000;

/**
 * 插件那一路"还活着"的两个时间参数（见下面的 yieldsOf / coveredBy）。
 *
 * PLUGIN_GRACE_MS —— 一轮刚起的头几秒先不抢：插件收到用户消息就写台账（本地回环，实测
 *   30~90 毫秒就落库），所以"这一轮已经跑了几秒、插件还没为它写行"基本就等于它哑了。
 *   这个值**必须短**，因为它量的是"插件还没写上来"这段窗口，而这段窗口里轮询是**不写**的
 *   —— 窗口多长，用户的这一轮就在列表里消失多久。实测（2026-09-30 13:42）：一条 8 秒的
 *   任务（13:42:44 → 13:42:52），按 60 秒算的时候整轮都落在宽限期里，用户看着它跑完、
 *   又等了 52 秒才在列表里看到那行（报的是"输入 Prompt 后没看到任务，任务结束后一会才
 *   看到"）。3 秒是本地回环的宽裕余量，同时把消失窗口压到一次轮询（5s）以内。
 * PLUGIN_COVER_MS —— 判"这一轮插件报过没有"时，插件那行的 started_at 与轮次起点允许差
 *   多少。两边记的是同一个事件的两端：插件记它**看到消息**的时刻，轮次表记消息**落库**
 *   的时刻，实测差在 ±90ms 内且方向不定（+34 / -87 / -14ms 三例）。判漏了会与插件的行
 *   并排多写一条（孪生行，而且它自己好不了）；判重了会把"两秒内连开两轮"当成同一轮。
 */
const PLUGIN_GRACE_MS = 3_000;
const PLUGIN_COVER_MS = 2_000;

/** task id 前缀，避免跟 reporter hook 写的 task 撞 id */
const TASK_ID_PREFIX = 'kilo:';

/** 这一层的上报身份：轮询这一路（7F 由 sources 反推得到 ["kilo","kilo-plugin"]，前者是它） */
const CLIENT = 'kilo';

/** 这个工程名（工程 id）—— 成员 / 台账都按它归组 */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'Kilo Code');
}

/**
 * 写一条台账（tasks + task_runs 两行）。7F 是**每一轮一条**，口径照抄 opencodeTasks.js 的同名函数
 * （它接受显式 state 与 result —— Kilo 两样都要：分辨 done / cancelled，以及这一轮的收尾自述）。
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
    // 产出摘要：这一轮最后一条 assistant 说的话（见 kilo.js 的 readKiloRounds）；
    // 还没收工的那轮先不写（半截话不算产出），收工时再补。
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  /* 本轮消耗的 token（readKiloRounds 从 message.data.tokens 折出来，语义见 kilo.js）。
     这条语句是**覆盖写**而不是 COALESCE：这一轮还在跑时每次轮询都会重算，数值是长出来的，
     用 COALESCE 会把第一次读到的那个偏小的值钉死。tokens 为 null 时如实写 NULL。 */
  repo.setTaskRunTokens.run({
    id,
    inputTokens: tokens ? tokens.input : null,
    outputTokens: tokens ? tokens.output : null,
    cacheReadTokens: tokens ? tokens.cacheRead : null,
    cacheWriteTokens: tokens ? tokens.cacheWrite : null,
  });
  return filesJson;
}

/** 台账 id 里的轮序号（`kilo:<会话id>:<序号>`）；不是这个形状就回 null */
function roundIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
function syncKiloTasks({ bus, repo, now: nowFn = Date.now }) {
  const sessions = listKiloSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  // 每条会话的逐轮清单**和**它现有的台账行各只读一次：让位判定、owner 选择、写台账三处都复用
  // （逐轮清单要扫 message/part 表，别读两遍）。
  // "这一层现在算不算在跑"也直接由它推出（有没有 outcome==='running' 的轮）——
  // 收工窗口只留在 kilo.js 一处（ROUND_IDLE_MS），这里不再自己算时间窗。
  const roundsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    roundsOf.set(s.id, readKiloRounds(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }
  const isActiveOf = (s) => (roundsOf.get(s.id) || []).some((r) => r.outcome === 'running');

  /** 插件给这条会话写的那些行（服务端发的 `k_*`）各自报的轮次起点；没写过 → [] */
  const pluginStartsOf = (s) =>
    runsOf.get(s.id).filter((r) => !String(r.id).startsWith(TASK_ID_PREFIX)).map((r) => Number(r.started_at || 0));

  /** 插件**为这一轮**写过行没有：按轮次起点对齐（容许 PLUGIN_COVER_MS 的误差，理由见常量） */
  const coveredBy = (starts, at) => starts.some((p) => Math.abs(p - Number(at || 0)) <= PLUGIN_COVER_MS);

  /**
   * 这条会话是不是已经有**插件写的**行了（插件写的是服务端发的 `k_*`，轮询写的是 `kilo:*`）——
   * 有就整条让位。判据用 id 前缀而不是 client，因为这里要问的是"这行是不是我写的"（见下面循环）。
   *
   * **让位只在插件还在报的时候成立**（2026-09-30 修：用户实测一轮任务在列表里凭空消失）。
   * "这条会话有插件行"只证明它**曾经**在报 —— 插件跟着 agent 进程活，通道断了它自己不知道，
   * 也什么都发不出去。实测那一回：Kilo CLI 进程 11:00 起（那个进程里的插件还没有"重读
   * server.json"那版），WorkGremlin 11:29 重启换了随机 token（server/src/config.js 每次启动
   * 随机生成）→ 从那以后这个进程的每条上报都 401，而且**完全无声**：状态文件照写
   * （所以相位/状态正常显示）、台账一条不来。于是 12:46 与 12:48 用户跑的两轮，
   * 插件写不了、轮询又整条让位 → **两条任务都查不到**（用户报的"状态有，但看不到任务"）。
   *
   * 所以让位的判据改成"插件**这一轮**也写了没有"：它最新那一行落在源里最新这一轮起点之后
   * （容许 PLUGIN_COVER_MS 的误差）→ 让位；否则这一轮刚起就再等 PLUGIN_GRACE_MS（本地回环，
   * 正常 1 秒内落库），过了还不见它的行 → 认定通道断了，把这条会话收回来（补记见 ②b）。
   * 插件活着时每轮开跑就写一条，所以正常情况下这条永远不命中；万一它只是慢了（注册重试中），
   * 等它写上来那一刻让位又成立 —— 轮询自己写的行会被收掉（见下面循环里的让位分支），自愈。
   * 宽限期**从这一轮的起点算**（不是"插件沉默多久"）：插件两轮之间本来就不写东西，沉默是常态。
   */
  const yieldsOf = (s) => {
    const starts = pluginStartsOf(s);
    if (!starts.length) return false;
    const rounds = roundsOf.get(s.id) || [];
    const last = rounds[rounds.length - 1];
    const roundStart = last ? Number(last.startedAt || 0) : 0;
    // 比的是"最新那行是否落在这一轮起点之后"：插件那行可能比轮次起点早几十毫秒（实测 -87ms），
    // 也可能晚（它自己取 Date.now()，agent 忙的时候迟一会儿）—— 两边都要容，所以减一个 COVER。
    const newestTheirs = starts.reduce((m, p) => Math.max(m, p), 0);
    if (newestTheirs >= roundStart - PLUGIN_COVER_MS) return true;
    return now - roundStart <= PLUGIN_GRACE_MS;
  };

  /**
   * 让位给插件的那条会话，插件是不是**冒我们这个身份、而且现在正跑着**？
   * CLI 形态的插件（`kilo run`，没有 VS Code 环境变量）报的就是裸 `kilo` —— 同一个成员
   * `kilo@<工程>`，见 plugin/index.js 的 resolveClient；只有 VS Code 扩展起的才是 `kilo-plugin`。
   * 是的话这条工程的成员状态就先归插件写：轮询这一路连心跳都不碰 —— 否则 5s 一次轮询会把
   * 插件刚写的相位覆盖成轮询视角下的旧状态（agent_status 谁最后写谁赢），现场就是相位来回跳。
   * 只在那轮**还没收工**时让位（isActiveOf）：插件那条停下来了就把这一栏交回轮询，
   * 否则同工程另一条（没装插件的老会话）真在跑时永远拿不到心跳，被判成「已取消」。
   */
  const pluginOwnsMember = new Set();
  for (const s of sessions) {
    if (!yieldsOf(s) || !isActiveOf(s)) continue;
    if (runsOf.get(s.id).some((r) => String(r.client) === CLIENT)) pluginOwnsMember.add(projectIdOf(s));
  }

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程有多条会话时（Kilo 的工作树会话、历史会话都在），谁最后写谁赢 —— 结果是
   * "正在跑的那条任务在 agent_status 里找不到对应心跳"，任务列表按 query.js 的 CASE
   * 把它算成「已取消」，运行中的任务就不显示了（实测 2026-09-28 就是这个症状）。
   * 所以先选出这个工程该报的那条：活跃里最新的；都不活跃就报最新那条（卡片挂住最后一条任务）。
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    // 让位的会话**不参与** owner 选择：它这一路根本不写心跳（见下面那个 continue），
    // 把它算进来就会让同工程另一条真在跑的会话永远选不上 owner ——
    // 那条任务在 agent_status 里找不到心跳，又被 query.js 的 CASE 判成「已取消」。
    // 实测 2026-09-30：插件那条会话一出现（它比老会话新），老会话的状态就冻在上一次
    // 写下的那一行上再也不刷新（成员卡心跳过期灰显、老会话里再开一轮就显示「已取消」）。
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

    // 装了 WorkGremlin 插件时，plugin 那一路上报的是**真值**：每轮用户任务一条，
    // 带 taskTitle（用户那句话）、form（形态）、result（收尾自述）、收工时间。
    // 轮询这一路只是"没装插件"时的兜底，不能跟它抢同一条会话 —— 抢的结果是同一个
    // 会话在任务列表里出现两行（轮询的会话级 + 插件的任务级），而且轮询那行每 5s
    // 还会把插件写的相位/成员状态覆盖回 thinking（收工了还显示"思考中"）。
    // 所以：这条会话已经有 plugin 行 → 整条跳过；自己上一轮抢在 plugin 前面写下的
    // 兜底行 → 收掉（只删自己前缀的 id，插件的行一根汗毛都不动）。
    // 判据是"这个会话已经有插件写的行了"，不是"有没有 client === kilo-plugin 的行"。
    // 插件写的 id 是 `k_*`，轮询写的是 `kilo:*` —— 用 id 前缀认，比认身份稳：
    // 身份是插件**上报**的，而这里要问的是"这行是不是我写的"。早先按 client 判，
    // 而插件那份的身份在修好之前根本不是 kilo-plugin（判出的是 kilo）→ 从不让位 →
    // 同一个会话轮询与插件各写各的，同一轮在任务列表里出现两行（2026-09-30 实测）。
    // runsOf 是上面读的那一份（那时还没写这一轮，所以下面 ③ 定稿不会误伤 lastId）
    const sessionRuns = runsOf.get(s.id);
    if (yieldsOf(s)) {
      for (const r of sessionRuns) if (String(r.id).startsWith(TASK_ID_PREFIX)) repo.deleteTaskRun(r.id);
      continue;
    }

    // ① 过渡期清扫：早先是"一条会话一行"，id 就是 `kilo:<会话id>`（没有轮序号）。
    // 让位那条路在上面自己就把这类行删了（它也带 `kilo:` 前缀）；走到这里的是没让位的会话，
    // 所以这一步必须在这里做 —— 否则那些没有用户轮的会话（Kilo 一启动就落一条空会话）
    // 会把自己那条旧台账永远留在列表里。
    if (repo.getTaskRun.get(prefix)) repo.deleteTaskRun(prefix);

    const rounds = roundsOf.get(s.id) || [];
    if (!rounds.length) continue; // 没有用户轮（一句话都没说过）的会话不算任务，不落台账
    // 轮序号 → 那一轮。**认 index 而不是数组下标**：id 里的序号是 kilo.js 落下的 `r.index`，
    // 两者平时相等，但拿 index 问"源里还有没有这一轮"才是准的（见下面 ③b）。
    const byIndex = new Map(rounds.map((r) => [r.index, r]));

    // 确保工程 & 成员存在（安静写入，不广播）
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `kilo@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'Kilo Code',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      lastSeenAt: now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    // 改动文件：Kilo 存的是绝对路径，统一转工程相对；工程外的（`..`）不进这一栏
    const relFiles = (list) =>
      (list || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : '';
        })
        .filter(Boolean);

    // ② 只写**最后一轮**：正在飞的那轮（state=running、ended_at=null），
    // 或它收工后留下的那轮。标题优先用**这一轮用户说的话**（和其它楼层「标题 = 用户那句话」
    // 同一口径）；取不到才退回会话标题 —— Kilo 的会话标题只在一轮开始时定一次，
    // 同一会话里再跑任务不会变，拿它当标题用户会以为"新任务没记上"。
    const last = rounds[rounds.length - 1];
    const running = last.outcome === 'running';
    const lastId = `${prefix}:${last.index}`;
    const filesJson = writeTurnRun(repo, {
      id: lastId,
      projectId,
      memberId,
      sessionId: s.id || null,
      model: s.model || '',
      title: last.prompt || s.title || '(Kilo 会话)',
      startedAt: last.startedAt || now,
      endedAt: last.endedAt || null,
      state: last.outcome,
      files: relFiles(last.files),
      result: last.endedAt ? last.result || '' : '',
      tokens: last.tokens,
    });
    count += 1;

    // ②b 从插件手里收回来时（它的通道断了，见 yieldsOf），把它断线期间漏掉的轮次补上：
    // 判据是"这一轮插件没报过"（按轮次起点对齐，见 coveredBy）—— 它报过的轮次轮询不回溯
    // （见文件头"只记当前这一轮"）；只有这里补，因为这是"本该有行、却一直没等到"的那几轮。
    // 已经写过行的（含上面刚写的最后一轮、以及插件亲手写的那几行）不动一根汗毛。
    const starts = pluginStartsOf(s);
    if (starts.length) {
      for (const r of rounds.slice(0, -1)) {
        if (coveredBy(starts, r.startedAt)) continue;
        const rid = `${prefix}:${r.index}`;
        if (sessionRuns.some((x) => String(x.id) === rid)) continue;
        writeTurnRun(repo, {
          id: rid,
          projectId,
          memberId,
          sessionId: s.id || null,
          model: s.model || '',
          title: r.prompt || s.title || '(Kilo 会话)',
          startedAt: r.startedAt || now,
          endedAt: r.endedAt || null,
          state: r.outcome,
          files: relFiles(r.files),
          result: r.endedAt ? r.result || '' : '',
          tokens: r.tokens,
        });
        count += 1;
      }
    }

    // ③ 定稿上一轮：上一轮在我们这儿是 running，现在后面已经开了新的一轮 ——
    // 用它的真实收工时刻/结果把那一行补成 done / cancelled。
    // 不做这一步，它会永远停在 'running'，被 query.js 的 CASE 判成「已取消」。
    // sessionRuns 是上面写最后一条**之前**读的，所以不含 lastId，不会误伤。
    for (const r of sessionRuns) {
      const idx = roundIndexOf(r.id, prefix);
      if (idx === null || idx >= last.index) continue;
      const old = byIndex.get(idx);
      if (!old) continue;
      writeTurnRun(repo, {
        id: r.id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: s.model || '',
        title: old.prompt || s.title || '(Kilo 会话)',
        startedAt: old.startedAt || now,
        endedAt: old.endedAt || null,
        state: old.outcome,
        files: relFiles(old.files),
        result: old.endedAt ? old.result || '' : '',
        tokens: old.tokens,
      });
      count += 1;
    }

    // ③b 收掉"源里已经没有"的那几轮：轮次表缩短时（Kilo 清了消息 / 压过上下文），
    // 那几行永远等不到自己的轮 —— 一直挂着 'running'，被 query.js 的 CASE 判成「已取消」，
    // 在列表里当一条假任务躺着（老口径"一条会话一行"自己会盖掉，改成一轮一条之后不会了）。
    // 判据是**这一轮还在不在源里**（byIndex），不是"序号比最后一轮小"—— 中间那几轮被删掉时
    // 序号照样对得上，只有按 index 问才问得准。
    // `rounds` 整个读空的情况上面已经 continue 了（不在这里删）：库改版读不出来时
    // （见 kiloFloor 的 D1 用例）宁可留旧行，也不拿"读不出来"当"源里没有"把历史删掉。
    for (const r of sessionRuns) {
      const idx = roundIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

    // ④ 心跳：活跃 → thinking，停下 → idle；task_id 必须指向**最后一轮**那条，
    // 否则 query.js 的 CASE 找不到心跳，会把正在跑的那条判成「已取消」。
    // 和 copilot.js 同理：只在活跃时写 thinking，会话停掉后旧值会一直挂在库里，
    // 成员卡永远「思考中」。非活跃时补一条 idle，让状态跟着会话走。
    // 另外：**只由这个工程选中的那条会话写**（见上面 activeByProject 的说明），
    // 否则同工程别的会话会把心跳指到自己的任务上，运行中的那条被判成「已取消」。
    // 插件正冒我们这个身份在报、且那轮还没收工 → 这一栏整个让给它（见 pluginOwnsMember）。
    const owner = pluginOwnsMember.has(projectId)
      ? null
      : activeByProject.get(projectId) || newestByProject.get(projectId);
    bus.setSessionStatus({
      project: projectId,
      memberId: 'kilo',
      sessionId: s.id,
      state: isActiveOf(s) ? 'thinking' : 'idle',
      taskId: isActiveOf(s) ? lastId : null,
      ts: now,
    });
    if (owner === s) {
      repo.upsertStatus.run({
        memberId,
        state: running ? 'thinking' : 'idle',
        stateSince: running ? last.startedAt || now : now,
        taskId: lastId,
        progress: null,
        currentFiles: filesJson,
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
function startKiloTaskSyncer(ctx) {
  const tick = () => {
    try {
      syncKiloTasks(ctx);
    } catch {
      /* Kilo 没装 / 库被占 → 这轮跳过 */
    }
  };
  tick();
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

/**
 * kilo 来源分支（7F）：轮询 Kilo 自己的 event-sourced SQLite（kilo.db）。
 * 原 sessionRegistry.js 的 kilo 分支整体搬到这里，调试 7F 不再碰中央文件。
 * @param {object} p 楼层元数据
 * @param {object} src 来源规格（kind === 'kilo'）
 * @param {object} ctx 框架提供的共享工具
 */
function kiloHandler(p, src, ctx) {
  const { claim, upsert, now, workspacePath, TIMEOUT_MS, reporterMainPhase, readReporterDone, clientOf, doneFieldsFromReporter } = ctx;
  for (const s of listKiloSessions()) {
    if (!claim(p.id, s.id)) continue;
    if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
    const ph = readKiloPhase(s.id) || null;
    const wsOfSession = s.projectPath || workspacePath;
    const truth =
      reporterMainPhase(wsOfSession, clientOf('kilo', true), s.id) ||
      reporterMainPhase(wsOfSession, clientOf('kilo', false), s.id) ||
      null;
    const doneTruth =
      readReporterDone(wsOfSession, clientOf('kilo', true), s.id) ||
      readReporterDone(wsOfSession, clientOf('kilo', false), s.id);
    const donePoll = readKiloDone(s.id, s);
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      source: truth ? 'kilo-plugin' : 'kilo',
      sourceKind: 'kilo',
      project: s.project,
      projectPath: s.projectPath,
      mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
      current: false,
      live: true,
      phase: truth ? truth.phase : ph ? ph.phase : 'unreported',
      action: truth ? truth.action || '' : ph ? ph.action : '',
      target: truth ? truth.target || '' : ph ? ph.target : '',
      tool: truth ? truth.tool || '' : ph ? ph.tool : '',
      context: truth ? truth.context || [] : ph ? ph.context : [],
      prompt: truth ? truth.prompt || '' : ph ? ph.prompt || '' : '',
      inferred: !truth,
      ...(doneTruth && doneTruth.at ? doneFieldsFromReporter(doneTruth) : donePoll),
      lastEventAt: s.lastEventAt,
    });
  }
}

const kindHandlers = { kilo: kiloHandler };

module.exports = {
  kiloHome,
  kiloDbPath,
  shorten,
  hasCoreTables,
  listKiloSessions,
  readKiloPhase,
  readKiloDone,
  readKiloRounds, // 逐轮清单（7F 台账按「每一轮一条」记账用，见本文件任务同步器）
  readRoundPrompt, // 这一轮用户说的话（「思考中」屏上那句；比 readKiloRounds 便宜得多）
  kiloInstrumented,
  kiloMainPhase,
  NO_DONE,
  // ---- 7F 任务同步器（原 kiloTasks.js）----
  syncKiloTasks,
  startKiloTaskSyncer,
  SYNC_INTERVAL_MS,
  meta,
  kindHandlers,
  sessionTitle,
};
