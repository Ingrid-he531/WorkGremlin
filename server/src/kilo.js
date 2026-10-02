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
const { clientBase, DEFAULTS } = require('@workgremlin/shared');

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

module.exports = {
  kiloHome,
  kiloDbPath,
  shorten,
  hasCoreTables,
  listKiloSessions,
  readKiloPhase,
  readKiloDone,
  readKiloRounds, // 逐轮清单（7F 台账按「每一轮一条」记账用，见 kiloTasks.js）
  readRoundPrompt, // 这一轮用户说的话（「思考中」屏上那句；比 readKiloRounds 便宜得多）
  kiloInstrumented,
  kiloMainPhase,
  NO_DONE,
};
