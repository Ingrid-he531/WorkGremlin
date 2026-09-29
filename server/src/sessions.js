'use strict';

/**
 * 会话（conversation）—— 受监控产品在各个工程下开着的会话。
 *
 * 同一层的 CLI 与 Plugin 两路落盘**不是同一份**，各自有各自的取法，但产出同一种会话行：
 *   · 插件那路（1F CodeBuddy 的插件形态）：就是本文件下面这套结构化落盘
 *     （genie-history / todos / message-queue / file-changes），能拿到运行态；
 *     TraeCode 的插件形态没有这套落盘（实测只有运行时文件），所以它那两路落盘
 *     （~/.trae-cn、~/.marscode）只作展示、不进会话来源（见 products.js 的 sources）。
 *   · CLI 那路（1F CodeBuddy、2F、3F、4F）：会话在各自的会话 jsonl 里，只有文件时间可靠；
 *   · hook 那路（5F TraeCode、1F CodeBuddy CLI 的兜底）：连 jsonl 都没有时，
 *     会话来源就是 reporter 状态文件（listReporterSessions）。
 * 楼层吃哪几路由 server/src/products.js 的 sources 声明（合并楼层可多路）。
 *
 * 真源是插件自己的落盘（不经我们同意也一直在写），四个目录互相索引：
 *   genie-history/{base64(工程目录)}/conversations/{会话id}/   工程 ↔ 会话名单（目录本身是空的）
 *   genie-history/{base64(工程目录)}/current.json              { conversationId, lastUpdated } 该工程当前会话
 *   todos/{会话id}.json                                        { conversationId, todos:[{id,status,content}] }
 *   message-queue/*.json                                       每会话 runtime:{activated,paused,awaitingSessionIdle} + 排队消息
 *   file-changes/{会话id}/*.json                               改动文件（增删行 + diff）
 *
 * 下拉要的是**所有工程里活跃着的会话**（不限当前打开的那个工程），所以这里
 * 遍历 genie-history 下每个工程目录；一个活跃会话都没有 → reason: 'no-open-project'。
 *
 * 纪律（对齐 docs/requirements.md §P0-6「绝不编造」）：
 *   - 会话里**没有**职务 / 进度 / 耗时这些字段，一行都不补，拿不到就是拿不到；
 *   - 主 Agent 的阶段是从 runtime + todos + 文件改动**推**出来的，全部标 `inferred: true`，
 *     UI 侧要按"推断"展示（灰显 + 标注），不能当成上报值。
 *
 * 扫盘便宜（几十个文件），缓存 5 秒足够。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { resolveProjectName } = require('./project');
const { clientBase } = require('@workgremlin/shared');
// 两个适配器同名导出（selectedModelOf），这里必须改名 —— 否则后一个静默盖掉前一个，
// 就会正好造出"某一层取不到模型"这个本次要修的 bug。
const { selectedModelOf: traeModelOf } = require('./traeModels');
const { selectedModelOf: claudeModelOf } = require('./claudeModels');
// Claude 的配置根（认 CLAUDE_CONFIG_DIR）只留在 products.js 那一处定义，这里复用，别另写一份
const { claudeHome } = require('./products');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

/** 插件目录名（腾讯 Coding Copilot、GitHub Copilot、别名兜底） */
const PLUGIN_RE = [/coding-copilot/i, /github\.copilot/i, /github-copilot/i, /^codebuddy/i, /^tencent/i, /^ingram/i, /^copilot/i];

/** GitHub Copilot 的真实会话落盘是 SQLite `session-store.db`，不是 genie-history 目录。 */
function readSqliteSessionRows(storage) {
  const dbFile = path.join(storage, 'session-store.db');
  if (!isFile(dbFile)) return [];
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => String(c.name || '').trim());
      if (!cols.length) return [];
      const idCol = cols.includes('id') ? 'id' : cols[0];
      const cwdCol = cols.includes('cwd') ? 'cwd' : cols.includes('current_directory') ? 'current_directory' : '';
      const repoCol = cols.includes('repository') ? 'repository' : cols.includes('repo') ? 'repo' : '';
      const updatedCol = ['updated_at', 'last_updated', 'created_at', 'modified_at'].find((name) => cols.includes(name)) || '';
      const summaryCol = cols.includes('summary') ? 'summary' : '';
      const selectCols = [idCol, cwdCol, repoCol, updatedCol, summaryCol].filter(Boolean);
      if (!selectCols.length) return [];
      const query = `SELECT ${selectCols.join(', ')} FROM sessions WHERE ${idCol} IS NOT NULL AND TRIM(${idCol}) <> '' ${updatedCol ? `ORDER BY datetime(${updatedCol}) DESC` : ''}`;
      const rows = db.prepare(query).all();

      // turns 表：取每个会话的 turn 数 + 最后一条 user_message（作任务标题/提示语兜底）。
      // session_files 表：取每个会话碰过的文件路径 + 工具名（作文件改动清单）。
      // 两张表不一定在（Copilot 版本可能变），查不到就回空，不冒泡。
      const turnsBySid = readCopilotTurns(db);
      const filesBySid = readCopilotFiles(db);
      // 「这一轮在不在飞」的旁证（VS Code 的 chat 索引，见 readCopilotChatIndex）
      const chatBySid = readCopilotChatIndex();

      return rows
        .map((row) => {
          const id = String(row[idCol] || '').trim();
          if (!id) return null;
          const cwd = cwdCol ? String(row[cwdCol] || '').trim() : '';
          const projectPath = cwd || '';
          const project = resolveProjectName(projectPath) || (projectPath ? path.basename(projectPath) : 'GitHub Copilot');
          const ts = updatedCol ? row[updatedCol] : null;
          // 拿不到真实时间戳 → lastUpdated=0，让下游 freshness 检查正确判过期（idle），
          // 不要用 Date.now() 冒充 —— 一冒充就永远"新鲜"，相位卡死在 thinking。
          const lastUpdated = ts ? (Number(new Date(ts).getTime()) || 0) : 0;
          const summary = summaryCol ? String(row[summaryCol] || '').trim() : '';
          const t = turnsBySid.get(id) || {};
          const rawFiles = filesBySid.get(id) || [];
          // session_files 存的是绝对路径，其他 agent 都用相对路径 —— 统一成相对路径
          const files = rawFiles.map((f) => ({
            ...f,
            path: projectPath && f.path ? path.relative(projectPath, f.path) || f.path : f.path,
          }));
          return {
            id,
            project,
            projectPath,
            lastUpdated,
            summary,
            turnCount: t.turnCount || 0,
            lastUserMessage: t.lastUserMessage || '',
            hasPendingTurn: t.hasPendingTurn || false,
            files,
            turns: Array.isArray(t.turns) ? t.turns : [],
            chat: chatBySid.get(id) || null,
            // 最新那一轮请求（VS Code 会话日志）：在不在飞 + 用户原话 + 起止时间
            live: readCopilotLiveRequest(id),
          };
        })
        .filter(Boolean);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * 读 Copilot `turns` 表：每个会话的 turn 数 + 最后一条 user_message。
 * 表不存在 / 列名变了对上层透明（回空 Map，调用方照常工作）。
 */
function readCopilotTurns(db) {
  const out = new Map();
  try {
    const cols = db.prepare('PRAGMA table_info(turns)').all().map((c) => String(c.name || '').trim());
    if (!cols.length) return out;
    const sidCol = cols.includes('session_id') ? 'session_id' : cols.includes('sid') ? 'sid' : '';
    const msgCol = cols.includes('user_message') ? 'user_message' : '';
    const respCol = cols.includes('assistant_response') ? 'assistant_response' : cols.includes('response') ? 'response' : '';
    const tsCol = cols.includes('timestamp') ? 'timestamp' : '';
    if (!sidCol) return out;
    // 每个 session_id 取 turn 数 + 按 timestamp 倒序的第一条 user_message
    const countRows = db.prepare(`SELECT ${sidCol} as sid, COUNT(*) as cnt FROM turns GROUP BY ${sidCol}`).all();
    for (const r of countRows) {
      const sid = String(r.sid || '').trim();
      if (sid) out.set(sid, { turnCount: r.cnt, lastUserMessage: '', hasPendingTurn: false });
    }
    // 有空 assistant_response 的 turn = AI 还没写完回复 → 这条会话正在跑
    // （Copilot 是批次写入：只在用户发消息时写 turn 行，AI 回复完了才更新 assistant_response。
    //  所以"空回复的 turn"是"正在生成"的硬证据，比看 updated_at 新鲜度准得多。）
    if (respCol) {
      const pendingRows = db.prepare(`SELECT ${sidCol} as sid FROM turns WHERE ${respCol} IS NULL OR TRIM(${respCol}) = ''`).all();
      for (const r of pendingRows) {
        const sid = String(r.sid || '').trim();
        if (sid) {
          const existing = out.get(sid) || { turnCount: 0, lastUserMessage: '', hasPendingTurn: false };
          existing.hasPendingTurn = true;
          out.set(sid, existing);
        }
      }
    }
    // 逐轮清单：任务台账按「每一轮一条」记账要用（轮序号 + 用户原话 + 时间 + 有没有回复）。
    // 列缺失（老版本）就跳过 —— 上层照常工作，只是没有逐轮台账。
    const idxCol = cols.includes('turn_index') ? 'turn_index' : '';
    if (idxCol && msgCol) {
      const tsSel = tsCol ? `, ${tsCol} as ts` : '';
      const pendSel = respCol ? `, (${respCol} IS NULL OR TRIM(${respCol}) = '') as pend` : ', 0 as pend';
      for (const r of db.prepare(`SELECT ${sidCol} as sid, ${idxCol} as idx, ${msgCol} as msg${pendSel}${tsSel} FROM turns`).all()) {
        const sid = String(r.sid || '').trim();
        if (!sid) continue;
        const existing = out.get(sid) || { turnCount: 0, lastUserMessage: '', hasPendingTurn: false };
        if (!Array.isArray(existing.turns)) existing.turns = [];
        existing.turns.push({
          index: Number(r.idx) || 0,
          userMessage: String(r.msg || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          at: r.ts ? Number(new Date(String(r.ts)).getTime()) || 0 : 0,
          pending: Boolean(r.pend),
        });
        out.set(sid, existing);
      }
      for (const v of out.values()) if (Array.isArray(v.turns)) v.turns.sort((a, b) => a.index - b.index);
    }
    if (msgCol && tsCol) {
      const lastRows = db.prepare(`SELECT ${sidCol} as sid, ${msgCol} as msg FROM turns ORDER BY datetime(${tsCol}) DESC`).all();
      for (const r of lastRows) {
        const sid = String(r.sid || '').trim();
        const msg = String(r.msg || '').trim();
        if (sid && msg) {
          const existing = out.get(sid) || { turnCount: 0, lastUserMessage: '', hasPendingTurn: false };
          if (!existing.lastUserMessage) {
            existing.lastUserMessage = msg.slice(0, 200);
            out.set(sid, existing);
          }
        }
      }
    } else if (msgCol) {
      // 没 timestamp 列就取最后一条（靠默认 rowid 顺序）
      const lastRows = db.prepare(`SELECT ${sidCol} as sid, ${msgCol} as msg FROM turns`).all();
      const seen = new Set();
      for (let i = lastRows.length - 1; i >= 0; i--) {
        const sid = String(lastRows[i].sid || '').trim();
        const msg = String(lastRows[i].msg || '').trim();
        if (sid && msg && !seen.has(sid)) {
          seen.add(sid);
          const existing = out.get(sid) || { turnCount: 0, lastUserMessage: '', hasPendingTurn: false };
          existing.lastUserMessage = msg.slice(0, 200);
          out.set(sid, existing);
        }
      }
    }
  } catch {
    /* Copilot 版本变了 turns 表名/列名 → 回空 */
  }
  return out;
}

/**
 * 读 Copilot `session_files` 表：每个会话碰过的文件路径 + 工具名。
 * 表不存在 / 列名变了同样回空 Map。
 */
function readCopilotFiles(db) {
  const out = new Map();
  try {
    const cols = db.prepare('PRAGMA table_info(session_files)').all().map((c) => String(c.name || '').trim());
    if (!cols.length) return out;
    const sidCol = cols.includes('session_id') ? 'session_id' : cols.includes('sid') ? 'sid' : '';
    const pathCol = cols.includes('file_path') ? 'file_path' : cols.includes('path') ? 'path' : '';
    const toolCol = cols.includes('tool_name') ? 'tool_name' : cols.includes('tool') ? 'tool' : '';
    if (!sidCol || !pathCol) return out;
    const turnCol = cols.includes('turn_index') ? 'turn_index' : '';
    const orderCol = cols.includes('first_seen_at') ? 'first_seen_at' : cols.includes('created_at') ? 'created_at' : '';
    const rows = db
      .prepare(
        `SELECT ${sidCol} as sid, ${pathCol} as fp${toolCol ? `, ${toolCol} as tn` : ''}${turnCol ? `, ${turnCol} as ti` : ''} FROM session_files${orderCol ? ` ORDER BY datetime(${orderCol}) DESC` : ''}`
      )
      .all();
    for (const r of rows) {
      const sid = String(r.sid || '').trim();
      const fp = String(r.fp || '').trim();
      if (!sid || !fp) continue;
      // 只要**读**过的文件不算"改动文件"：Copilot 0.65.0 的 session_files 整表都是
      // read_file（实测），拿它当"这一轮改了什么"会把一堆没动过的文件报上去。
      const tool = toolCol ? String(r.tn || '').trim() : '';
      if (tool && !COPILOT_WRITE_TOOL_RE.test(tool)) continue;
      // Copilot 把**它自己的**临时文件也记进 session_files（工具调用的附件、
      // chat-session-resources/.../content.txt 之类，全在 VS Code 的 workspaceStorage /
      // globalStorage 下）。那些不是"这一轮改动的文件"，混进任务记录的文件清单只会误导
      // （实测 9F 的记录里近一半是这种内部文件）。这里按"在编辑器存储目录下"精确剔除，
      // 工程外的真实文件（比如另一个仓库）照旧保留。
      if (/[\\/]User[\\/](?:workspace|global)Storage[\\/]/i.test(fp)) continue;
      const arr = out.get(sid) || [];
      // 去重（同一个文件可能被多轮碰）
      if (!arr.some((f) => f.path === fp)) {
        // turn：这个文件是哪一轮碰的（台账按轮切分时用它）。
        // 拿不准就留 null —— Copilot 0.65.0 实测 turn_index 整列是 NULL（那整张表其实是
        // "这个会话见过的文件"），把它当成 0 会张冠李戴挂到第一轮上，宁可说不知道。
        arr.push({
          path: fp,
          tool: toolCol ? String(r.tn || '').trim() : '',
          turn: turnCol && r.ti != null && r.ti !== '' ? Number(r.ti) : null,
        });
        out.set(sid, arr);
      }
    }
  } catch {
    /* Copilot 版本变了 session_files 表名/列名 → 回空 */
  }
  return out;
}

/**
 * 插件落盘这一路的来源客户端：**按楼层传入**，不再写死。
 * reporter 的状态文件按客户端分开写（同一个工程里 CodeBuddy / Codex / Claude … 各一份），
 * 每个插件楼层（1F CodeBuddy 的插件那一路、5F TraeCode-Plugin、未来的 Codex-Plugin …）只认自己
 * 这一路 —— 否则切到某层会看见别层在敲的命令、收工时还弹别层的「任务完成」。
 * 调用方（sessionRegistry）会把该楼层的 client（例如 'codebuddy-plugin' / 'trae-plugin'）传进来。
 * 合并楼层（1F CodeBuddy）另有一路 CLI 身份：见下面的 clientHit —— 它可以一次收一串 client。
 */

/**
 * 老状态文件（引入 client 字段之前写的）没有 client —— 那时只有 CodeBuddy 家族在写，
 * 所以这类文件按 codebuddy（CLI）归属。新文件一律带 client，不会走到这个兜底。
 * 注意：这只是历史兼容，绝不能当"默认客户端"用——client 必须显式传入。
 */
const LEGACY_STATE_CLIENT = 'codebuddy';

/**
 * 楼层身份匹配（轴 1 的过滤口径，全文件只此一处）。
 *
 * want 既可以是**单个 client**（如 'codebuddy-plugin'），也可以是**逗号分隔的一串** ——
 * 合并楼层（1F CodeBuddy 把 CLI 与 Plugin 合成一层）就是"一个楼层吃两路上报身份"，
 * 它把 clients 列表一起传进来（见 server/src/products.js 的 sources / clients）。
 * 别的楼层一律传单值，行为与改动前逐字一致（精确比对，不做基名放宽）——
 * 合并楼层的两路（如 5F TraeCode = trae + trae-plugin）则一次收一串。
 *
 * got 是状态文件里记的 client；老状态文件没有 client 字段 → 按 codebuddy（CLI）归属。
 * @param {string} want 楼层要求的 client（单个，或逗号分隔多个）；空 = 不限
 * @param {string} got 状态文件里的 client
 */
function clientHit(want, got) {
  if (!want) return true;
  const set = String(want)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!set.length) return true;
  return set.includes(String(got || LEGACY_STATE_CLIENT).toLowerCase());
}

/** 缓存：列表扫盘 + 读十几个小 json，5 秒足够 */
const TTL = 5_000;
let cache = { at: 0, key: '', value: null };

/**
 * 本进程（server）的启动时刻 —— "纪元"起点。
 * reporter 把相位写进本地状态文件、且不会被主动删除；上次运行（尤其被 kill/崩溃、
 * 没走 SessionEnd）留下的相位会在重启后被重新读到，表现为"已关闭的工程又亮了思考中"。
 * 所以只采信"本进程启动之后"写入的相位：重启后一律先回到待命，等下一个新事件再点亮。
 * 用时间戳比较而不是"退出时删文件"，是因为删除依赖干净退出，kill -9 / 崩溃时根本删不到。
 */
const SERVER_STARTED_AT = Date.now();

/** 多久没动静算"不活跃"（插件 runtime 没有心跳，只能用文件时间） */
const IDLE_MS = 10 * 60_000;
/** Copilot 的相位新鲜窗口：2 分钟内有活动 = thinking，超了 = idle。
 *  比 IDLE_MS 短得多 —— IDLE_MS 管"活不活"（10 分钟内都算活跃会话），
 *  这个管"正在不在想"（2 分钟没动静就是待命了）。和 Kilo 的 PHASE_FRESH_MS 同量级。 */
const COPILOT_PHASE_MS = 2 * 60_000;
/** 文件改动在这么久之内 → 认为正在动手 */
const BUSY_MS = 90_000;
/** 落盘在这么久之内 → 认为这一轮对话还在推进（含纯推理、只读工具等拿不到文件/待办证据的情况） */
const FRESH_MS = 2 * 60_000;
/**
 * 会话"还在下拉里"的窗口 —— 与 CLI 楼层对齐（sessionRegistry 的 TIMEOUT_MS = 60 分钟）。
 *
 * 为什么不再用 IDLE_MS(10 分钟) 当在列标准：IDE 里开着但十几分钟没敲字的会话会被整条剔除，
 * 而同样空闲的 CLI 会话（3F Codex）却还在列表里，两边口径不一致（实测：插件那路空、CLI 有 4 条）。
 * 现在 IDLE_MS 只用来判断"相位还热不热"（inferPhase），不再决定会话是否出现。
 */
const LISTED_MS = 60 * 60_000;
/**
 * 完成标记的"新鲜期"：只有这么久之内结束的才算"刚发生"，才会回给界面。
 *
 * 为什么必须有：done 是**持久状态**（为了让一次一进程的 `codex exec` 也能看到完成摘要，
 * 会话结束后不清它），于是页面/楼层一打开就可能读到上一轮（甚至几小时前）的完成标记，
 * 把历史当成新闻重播一遍（现象：一开 3F 就弹「任务完成 · 链路测试完成」）。
 * 渲染层也做了"首次只当基线"的防护，这里是第二道，而且对旧前端也生效。
 */
const DONE_TTL_MS = 10 * 60_000;

/* ------------------------------ 基础工具 ------------------------------ */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readDir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/* ------------------------------ 定位插件落盘 ------------------------------ */

/** 平台级应用数据根目录 */
function dataRoots() {
  const roots = [];
  if (process.platform === 'darwin') {
    roots.push(path.join(HOME, 'Library', 'Application Support'));
  } else if (IS_WIN) {
    if (process.env.APPDATA) roots.push(process.env.APPDATA);
    if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA);
  } else {
    roots.push(path.join(HOME, '.config'), path.join(HOME, '.local', 'share'));
  }
  return roots.filter(isDir);
}

/** 编辑器 globalStorage 目录（插件落盘的地方） */
function globalStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Code', 'Code - Insiders', 'Cursor', 'Trae', 'Windsurf', 'VSCodium']) {
      const p = path.join(r, ed, 'User', 'globalStorage');
      if (isDir(p)) out.push(p);
    }
  }
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'globalStorage');
  if (isDir(srv)) out.push(srv);
  return out;
}

/** 编辑器 workspaceStorage 目录（VS Code 按工作区存 state.vscdb 的地方） */
function workspaceStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Code', 'Code - Insiders', 'Cursor', 'Trae', 'Windsurf', 'VSCodium']) {
      const p = path.join(r, ed, 'User', 'workspaceStorage');
      if (isDir(p)) out.push(p);
    }
  }
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'workspaceStorage');
  if (isDir(srv)) out.push(srv);
  return out;
}

/**
 * Copilot「这一轮在不在飞」的旁证。
 *
 * Copilot 自己的 session-store.db 是**整轮写完**才落的：turns 行带着 assistant_response
 * 一起出现，sessions.updated_at 也是那一刻才动 —— 「正在生成」在那张库里根本看不见。
 * 只看 updated_at 的 2 分钟窗口，就会出现最难看的那种错：**跑着的时候显示待命，
 * 跑完了反倒显示思考中**（实测 2026-09-28）。
 *
 * VS Code 自己有一份更细的索引：`workspaceStorage/<hash>/state.vscdb` 的
 * `chat.ChatSessionStore.index`，每个会话带 `timing.lastRequestStarted / lastRequestEnded`
 * （外加 lastResponseState / hasPendingEdits）。started 晚于 ended（或压根没有 ended）
 * = 这一轮还在飞。这里只读它、不写；读不到就回空 Map，上层退回原来的时间窗推断。
 */
const COPILOT_INDEX_TTL = 2_000;
/** dbFile -> { mtimeMs, size, at, entries }：文件没变就不重复开库（相位 1.5s 一poll） */
let copilotIndexCache = new Map();

function readCopilotChatIndex() {
  const now = Date.now();
  const next = new Map();
  const out = new Map();
  let Database = null;
  try {
    Database = require('better-sqlite3');
  } catch {
    /* 没装原生依赖就退回时间窗推断 */
  }
  for (const root of workspaceStorageRoots()) {
    for (const name of readDir(root)) {
      const dbFile = path.join(root, name, 'state.vscdb');
      if (!isFile(dbFile)) continue;
      let st = null;
      try {
        st = fs.statSync(dbFile);
      } catch {
        continue;
      }
      // 文件没动过、且上次读还在 TTL 内 → 直接用上次的结果（避免每 1.5s 开一次 SQLite）
      const prev = copilotIndexCache.get(dbFile);
      const unchanged = prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && now - prev.at < COPILOT_INDEX_TTL;
      let entries = prev ? prev.entries : null;
      if (Database && !unchanged) {
        let db = null;
        try {
          db = new Database(dbFile, { readonly: true, fileMustExist: true });
          const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get();
          const parsed = row && row.value ? JSON.parse(String(row.value)).entries : null;
          entries = parsed ? Object.entries(parsed) : null;
        } catch {
          /* 这个工作区的库读不到（被占用 / 版本变了）→ 换下一个 */
          entries = prev ? prev.entries : null;
        } finally {
          if (db) {
            try {
              db.close();
            } catch {
              /* 关不掉不影响读取 */
            }
          }
        }
      }
      next.set(dbFile, { mtimeMs: st.mtimeMs, size: st.size, at: now, entries: entries || null });
      for (const [sid, e] of entries || []) {
        const t = (e && e.timing) || {};
        out.set(String(sid), {
          lastRequestStarted: Number(t.lastRequestStarted) || 0,
          lastRequestEnded: Number(t.lastRequestEnded) || 0,
          hasPendingEdits: Boolean(e && e.hasPendingEdits),
          title: String((e && e.title) || ''),
          stats: (e && e.stats) || null,
        });
      }
    }
  }
  copilotIndexCache = next;
  return out;
}

/**
 * 会话行上的"在飞"标记：true 在飞 / false 已收工 / null 没有旁证（退回时间窗推断）。
 *
 * 两份旁证（VS Code 的 chat 索引 / 会话日志）**谁知道的那一轮更新，就听谁**：
 * 索引常滞后（请求开始了它还没写），日志在请求开始就落；反过来日志的完成补丁又会晚一点到，
 * 所以不能简单地"谁说不忙就信谁"。另外 DB 里已经有这一轮的 turn 行 = 铁定收工
 * （Copilot 的 turn 行是整轮写完才落的）。
 */
function copilotInFlight(row) {
  if (!row) return null;
  const c = row.chat || null;
  const live = row.live || null;
  const turns = Array.isArray(row.turns) ? row.turns : [];
  const lastTurnIdx = turns.length ? Number(turns[turns.length - 1].index) : -1;
  // 日志**不早于**索引知道的那一轮就以日志为准。不能要求"严格更新"：实测这个 VS Code
  // 版本把索引的 lastRequestEnded 写成和 lastRequestStarted 一样（永远判不出在飞），
  // 平票时让索引压过日志，就会出现"日志明明说刚开跑、索引说已收工"→ 相位一直待命。
  const logKnowsNewer = Boolean(live && live.startedAt && (!c || live.startedAt >= (c.lastRequestStarted || 0)));
  if (logKnowsNewer) {
    if (live.index != null && lastTurnIdx >= Number(live.index)) return false; // 这一轮的 turn 行已经落了
    if (Date.now() - live.startedAt > 60 * 60_000) return false; // 太旧的"未完成"多半是残留，不算在飞
    return !live.completed;
  }
  if (c) return Boolean(c.lastRequestStarted && c.lastRequestStarted > c.lastRequestEnded);
  return null;
}

/**
 * Copilot 会话"算不算正在跑"：有在途旁证就听它，没有才退回 updated_at 的 2 分钟窗口。
 * @param {{chat?: any, lastUpdated?: number}} row
 * @param {number} now
 */
function copilotInWindow(row, now) {
  const inFlight = copilotInFlight(row);
  if (inFlight !== null) return inFlight;
  return Boolean(row.lastUpdated && now - row.lastUpdated < COPILOT_PHASE_MS);
}

/**
 * 9F 的「任务完成」时刻：会话日志里最新那一轮 request 的 completedAt（超 DONE_TTL_MS 不算）。
 * Copilot 没有 hook 状态文件，完成标记只能从这份日志取 —— 与 kilo.js/opencode.js 的
 * read*Done 同一个口径（不靠"相位回落到空闲"来猜，避免中途误弹）。
 * @param {{live?: any}} row
 * @param {number} now
 * @returns {number} 0 = 没有（或已过期）
 */
function copilotDoneAt(row, now) {
  const live = row && row.live;
  const at = Number((live && live.completed && live.completedAt) || 0);
  if (!at || now - at > DONE_TTL_MS) return 0;
  return at;
}

/** 某条 Copilot 会话的 VS Code 会话日志（chatSessions/<会话>.jsonl） */
function copilotChatLogPath(sessionId) {
  const name = `${sessionId}.jsonl`;
  for (const root of workspaceStorageRoots()) {
    for (const dir of readDir(root)) {
      const p = path.join(root, dir, 'chatSessions', name);
      if (isFile(p)) return p;
    }
  }
  return '';
}

/** sessionId -> { key, value }：日志是 append-only 的，mtime+size 没变就没必要重读 */
const copilotLiveCache = new Map();

/**
 * 会**写文件**的 Copilot 工具（toolId）。只有这些工具碰过的文件才算"这一轮改动的文件"。
 * 实测（0.65.0）toolId 长这样：copilot_readFile / copilot_findTextInFiles / run_in_terminal /
 * copilot_replaceString / copilot_multiReplaceString / manage_todo_list…
 * —— session_files 那张表里**只有 read_file**，拿它当"改动文件"是错的（用户实测抓出来的）。
 */
const COPILOT_WRITE_TOOL_RE =
  /replace|patch|create[_.]?file|write[_.]?file|edit[_.]?file|insert[_.]?edit|apply[_.]?edit|multi[_.]?replace|delete[_.]?file|move[_.]?file/i;

/**
 * 读 Copilot 会话日志的**尾部**，取最新那一轮请求。
 *
 * 这份日志（`workspaceStorage/<hash>/chatSessions/<会话>.jsonl`）是 VS Code 自己的会话状态
 * 补丁流：`{"kind":1,"k":["requests",<n>,"…"],"v":…}` 一条条追加。关键在**时机** ——
 * 最新一轮的 `requests` 数组（含用户原话 message.text 与起始 timestamp）在这一轮**开始**时
 * 就追加进去了（实测那一行里的 modelState 还是 {value:0}，完成时间稍后才以
 * `requests.<n>.modelState.completedAt` 补上）。所以它一次给出三样 Copilot 自己的 sqlite
 * 库给不了的东西：这一轮在不在飞、用户原话、起止时间。
 *
 * @param {string} sessionId
 * @returns {{index: number|null, prompt: string, startedAt: number, completed: boolean,
 *            completedAt: number, reqs: Array<{index: number, startedAt: number, endedAt: number}>,
 *            changed: Array<{index: number, files: string[]}>}|null}
 */
function readCopilotLiveRequest(sessionId) {
  const file = copilotChatLogPath(sessionId);
  if (!file) return null;
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${st.mtimeMs}@@${st.size}`;
  const hit = copilotLiveCache.get(sessionId);
  if (hit && hit.key === key) return hit.value;

  const TAIL = 4 * 1024 * 1024; // 最新那一轮那行可能很大（带整段 response），往上多读一点
  let txt = '';
  try {
    const start = Math.max(0, st.size - TAIL);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      txt = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) txt = txt.slice(txt.indexOf('\n') + 1); // 丢掉可能被截断的首行
  } catch {
    return null;
  }

  let req = null;
  const modelStateByIndex = new Map(); // 轮序号 -> {value, completedAt}
  const elapsedByIndex = new Map(); // 轮序号 -> elapsedMs（起止时间 = completedAt - elapsedMs）
  const changedByIndex = new Map(); // 轮序号 -> Set(写工具碰过的文件：绝对路径)
  let maxIndex = -1;
  for (const line of txt.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let j = null;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const k = j && j.k;
    if (!Array.isArray(k) || k[0] !== 'requests') continue;
    if (k.length === 1) {
      // 整份 requests（滚动窗口）：最后一条就是最新那一轮
      const arr = Array.isArray(j.v) ? j.v : [];
      const last = arr[arr.length - 1];
      if (last && typeof last === 'object') {
        const startedAt = Number(last.timestamp) || 0;
        const prompt = String((last.message || {}).text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (startedAt) req = { index: null, prompt, startedAt, completed: false, completedAt: 0 };
      }
    } else {
      const idx = Number(k[1]);
      if (Number.isFinite(idx)) {
        maxIndex = Math.max(maxIndex, idx);
        if (k[2] === 'modelState' && j.v && typeof j.v === 'object') {
          modelStateByIndex.set(idx, { value: Number(j.v.value) || 0, completedAt: Number(j.v.completedAt) || 0 });
        } else if (k[2] === 'elapsedMs') {
          elapsedByIndex.set(idx, Number(j.v) || 0);
        } else if (k[2] === 'response') {
          // 这一轮的回复流里，**写文件**的工具调用 = 这一轮改动的文件。
          // 路径整个对象里找（invocationMessage / pastTenseMessage / toolSpecificData 都可能带），
          // 只认 file:// URI，去掉 #Lx-y 行号后缀。
          for (const it of Array.isArray(j.v) ? j.v : []) {
            if (!it || typeof it !== 'object' || it.kind !== 'toolInvocationSerialized') continue;
            if (!COPILOT_WRITE_TOOL_RE.test(String(it.toolId || ''))) continue;
            const blob = JSON.stringify(it);
            const files = [...blob.matchAll(/file:\/\/([^\s)\]\\"']+)/g)]
              .map((m) => decodeURIComponent(m[1]).replace(/#.*$/, ''))
              .filter(Boolean);
            if (!files.length) continue;
            if (!changedByIndex.has(idx)) changedByIndex.set(idx, new Set());
            for (const f of files) changedByIndex.get(idx).add(f);
          }
        }
      }
    }
  }
  if (!req) return null;
  /*
   * 完成判定**不能**拿"补丁里的最大轮号"当这一轮的轮号：最新一轮在开始时落的是一整份
   * requests（此时还没有它的 requests.<n>.* 补丁），那一轮号还是上一轮的 —— 拿上一轮的
   * modelState.completedAt 去判定，就会把"刚开始跑"判成"已经收工"（2026-09-28 实测的坑：
   * 用户跑任务时 9F 连"思考中"都没有）。
   * 轮次是顺序的，所以正确判据是：**有没有出现"不早于这一轮起始时间"的完成标记**。
   * 没有（最大的 completedAt 还是上一轮的，必然早于本轮 startedAt）→ 这一轮还在飞。
   */
  let maxCompletedAt = 0;
  let maxCompletedIndex = -1;
  for (const [idx, st] of modelStateByIndex) {
    if (st.completedAt > maxCompletedAt) {
      maxCompletedAt = st.completedAt;
      maxCompletedIndex = idx;
    }
  }
  req.completed = maxCompletedAt >= req.startedAt;
  req.completedAt = req.completed ? maxCompletedAt : 0;
  req.index = req.completed ? maxCompletedIndex : maxCompletedIndex >= 0 ? maxCompletedIndex + 1 : null;
  // 顺带回一份"最近几轮各自的起止时间"（顶部窗口里带 elapsedMs 的都能算出来），
  // 台账按轮记账时用它把每一轮的 started_at 填准（Copilot 自己的库只有完成时刻）。
  req.reqs = [];
  for (const [idx, st] of modelStateByIndex) {
    if (!st.completedAt) continue;
    const el = elapsedByIndex.get(idx) || 0;
    req.reqs.push({ index: idx, startedAt: Math.max(0, st.completedAt - el), endedAt: st.completedAt });
  }
  req.reqs.sort((a, b) => a.index - b.index);
  // 最近几轮各自改动的文件（写工具碰过的），按轮序号给出去
  req.changed = [...changedByIndex]
    .map(([index, set]) => ({ index, files: [...set] }))
    .sort((a, b) => a.index - b.index);
  copilotLiveCache.set(sessionId, { key, value: req });
  return req;
}

/** 插件目录名会带版本号，所以按名字前缀找；要求里面有会话相关子目录才算数 */
function findPluginStorage(re = PLUGIN_RE) {
  // 与 products.js 的 matchIn 保持一致：pluginRe 既可是正则数组，也可是单个正则（如 /trae/i）
  const list = re instanceof RegExp ? [re] : re || [];
  const marks = ['genie-history', 'todos', 'file-changes', 'message-queue', 'session-store.db'];
  const priority = (name) => {
    const n = String(name || '').toLowerCase();
    if (/github\.copilot|github-copilot|^copilot/i.test(n)) return 0;
    if (/coding-copilot|tencent|ingram|codebuddy/i.test(n)) return 1;
    return 2;
  };
  for (const root of globalStorageRoots()) {
    const names = [...readDir(root)].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    for (const name of names) {
      if (!list.some((rx) => rx.test(name))) continue;
      const p = path.join(root, name);
      const hasSessionStore = isFile(path.join(p, 'session-store.db'));
      if (hasSessionStore || marks.some((m) => isDir(path.join(p, m)) || (m === 'session-store.db' ? isFile(path.join(p, m)) : false))) {
        return p;
      }
    }
  }
  return '';
}

/** 目录名是工程路径的 base64；解不出来（不是路径）就返回空 */
function decodeDirName(name) {
  try {
    const s = Buffer.from(String(name), 'base64').toString('utf8');
    if (!s || s.includes('\u0000')) return '';
    if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) return s;
  } catch {
    /* 不是 base64，跳过 */
  }
  return '';
}

/* ------------------------------ 会话数据 ------------------------------ */

/** 每个会话的待办：total / done / doing（第一条 in_progress）/ 前几条的文案 */
function readTodos(storage, id) {
  const file = path.join(storage, 'todos', `${id}.json`);
  const data = readJson(file);
  const list = Array.isArray(data && data.todos) ? data.todos : [];
  const doing = list.find((t) => t && t.status === 'in_progress') || null;
  return {
    total: list.length,
    done: list.filter((t) => t && t.status === 'completed').length,
    doing: doing ? String(doing.content || '') : '',
    items: list.slice(0, 8).map((t) => ({
      status: String((t && t.status) || 'pending'),
      content: String((t && t.content) || '').replace(/\s+/g, ' ').trim(),
    })),
    at: mtime(file),
  };
}

/** 文件当前字节大小（按绝对路径现 stat）。删除类改动的源文件已不存在 → null，绝不编造。 */
function fileSizeOf(fp) {
  if (!fp || typeof fp !== 'string') return null;
  try {
    const s = fs.statSync(fp);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** 改动文件：按最后写入倒序取最近几个 */
function readFileChanges(storage, id) {
  const dir = path.join(storage, 'file-changes', id);
  const out = [];
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const p = path.join(dir, name);
    const j = readJson(p);
    if (!j) continue;
    out.push({
      name: String(j.fileName || path.basename(String(j.filePath || name))),
      op: String(j.changeType || ''),
      added: Number(j.addedLines) || 0,
      removed: Number(j.removedLines) || 0,
      // 字节大小：文件本体（filePath 是绝对路径）现 stat。插件 / IDE 这份落盘只给行数、
      // 不给体积，只能服务端现算；删除类改动的源文件已不在，算不到就留 null。
      size: fileSizeOf(j.filePath),
      at: mtime(p),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return { count: out.length, recent: out.slice(0, 6), lastAt: out.length ? out[0].at : 0 };
}

/**
 * 消息队列里该会话的运行态 + 排队条数。
 * 一个 message-queue 文件里可能装着多个会话，全部扫一遍取自己的那份。
 */
function readRuntime(storage, id) {
  const dir = path.join(storage, 'message-queue');
  let runtime = null;
  let pending = 0;
  let updatedAt = 0;
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    const conv = j && j.conversations ? j.conversations[id] : null;
    if (!conv) continue;
    if (conv.runtime) runtime = { ...(runtime || {}), ...conv.runtime };
    for (const it of conv.items || []) if (it && it.status === 'pending') pending += 1;
    updatedAt = Math.max(updatedAt, Number(conv.updatedAt) || 0, mtime(path.join(dir, name)));
  }
  return {
    runtime: runtime || { activated: false, paused: false, awaitingSessionIdle: false },
    pending,
    hasRuntime: Boolean(runtime),
    updatedAt,
  };
}

/**
 * reporter hook 在"等权限"时会把要执行的工具 + 目标文件写进 ~/.workgremlin/hooks/<工位>.json
 * 的 `await` 字段（见 packages/reporter/src/hook.js）。这里读回来给主控制台用。
 * 多工位时取 workspacePath 匹配且最新的一条；没有匹配工程就取最新一条。
 * 超过新鲜期的（默认 5 分钟）视为过期作废，避免权限已处理却还显示"等待授权"。
 * @returns {{tool: string, file: string}|null}
 */
const AWAIT_TTL_MS = 5 * 60_000;
/**
 * 任务"还在跑"的判定窗口：只有最近**有过 hook 事件**（UserPromptSubmit / PreToolUse /
 * PostToolUse / Notification …）才算这一轮在生成。心跳守护的 `hb.lastEventAt` 不能算——
 * 它只证明 IDE 会话还开着，不证明 agent 在干活。
 *
 * 为什么需要它：CodeBuddy IDE 在「思考中 / 调用工具」时按 ESC 取消，既不发 Stop 也不发
 * Interrupt（实测 events.log 无此事件），但 IDE 会话没关、心跳守护照跳，于是 taskId 一直
 * 占着、sessionPhase 冻在最后一笔（tool / thinking）。旧逻辑拿 hb.lastEventAt 当新鲜度，
 * inWindow / sessionPhase 永远回落不下来 → 主控制台一直显示「调用工具 / 思考中」，实则那
 * 一轮早被掐断了。改成只看 hook 事件时间：取消后没有新事件，超过这个窗口就当这轮结束、回落待命。
 * 窗口与 inferPhase 的 FRESH_MS 对齐（2 分钟）——项目统一口径："近 2 分钟没活动就不当它在忙"。
 *
 * 已知取舍：一次 hook 事件都没有的中途长工具（比如跑了 >2 分钟的 Bash 构建，期间只有
 * PreToolUse 起手、PostToolUse 收尾，中间毫无事件）会被这个窗口误判成"已结束"、短暂回落待命，
 * 等 PostToolUse 一来相位又恢复。属于可接受的小抖动，不比"取消后永远卡在思考中"更糟。
 */
const TASK_RUN_MS = 2 * 60_000;
/**
 * 等授权兜底阈值：本环境实测 CodeBuddy 不发 permission_prompt 通知（events.log 无 Notification 行），
 * 所以靠 hook 留下的 pending 推断——PreToolUse 写 pending + sessionPhase=tool，PostToolUse 才清掉它。
 * 一旦 pending 超过这个时间仍没被清（没有 PostToolUse 来），就认为工具被权限框卡住了 → 标「等待授权」。
 * 设 3.5s：绝大多数工具在 PreToolUse..PostToolUse 之间远小于此值，不会误报；权限框通常一弹就卡住不动。
 */
const AWAIT_PROBE_MS = 3_500;
/**
 * "打断标记"与"最后一个 hook 事件"的先后容差（见 readReporterPhase 里那处作废判定）：
 * 标记的 ts 由 CLI 自己落盘、相位的 ts 由 hook 进程落盘，两者可能差几毫秒 —— 用户正是在
 * 最后一个工具的 hook 还没写完时按的停止。所以标记不比相位"旧过 1s"就算标记更新。
 * 代价：紧接着（<1s）重发一轮时，新相位会被压一小会儿；换来的是"按了停止就永不回弹"。
 */
const INTERRUPT_PHASE_SLACK_MS = 1_000;

/**
 * 这些工具永远不该被标成"等待授权"：
 *  - 只读 / 诊断类（Read/Grep/Glob/...）：本就不弹权限框；且本环境实测它们不发 PostToolUse，
 *    一旦 pending 残留就会误报成 await。
 *  - 命令类（Bash/execute_command）：可能弹 run 权限框，但本环境实测同样不发 PostToolUse，
 *    点了 run 开始执行后 pending 永远清不掉 → 会卡成"等待授权"。所以也不参与兜底推断，
 *    避免出现"点了 run 还在等授权"的误报（需要真信号时再放开，见 hook.js 的 PROBE_TOOLS）。
 */
const NEVER_AWAIT_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'ReadLints', 'read_file', 'search_content', 'search_file', 'read_lints', 'list_dir',
  'RAG_search', 'web_fetch', 'web_search', 'use_skill', 'ask_followup_question', 'read_rules', 'task', 'update_memory', 'todo_write', 'send_message',
  'Bash', 'execute_command',
]);

/**
 * 命令类工具（Bash / execute_command …）：**服务端一律按"调用工具"上报，不做任何特殊化**。
 *
 * 为什么不在这里把 Bash 标成 await（等待授权）或改文案：
 * 本环境实测 CodeBuddy Plugin既不发"等授权"通知、也不发"授权结束"通知，而命令类工具
 * 又不发 PostToolUse —— 于是"到底有没有在等授权"根本没有真信号。以前靠"工具是 Bash"
 * 直接标 await，结果点了 run 之后没有任何事件能把它清掉，主控制台就一路卡在「等待授权」。
 *
 * 现在服务端只如实上报：相位 tool（调用工具）+ 工具名 + 实际命令。
 * 展示层一律写「调用工具」（不再按工具名换文案），这样展示口径改起来不用动服务端。
 * 真正的授权信号（Notification）来时，
 * 仍走下面 rp.phase === 'await' 那条真值分支——那段逻辑保留不动。
 */

function reporterHookHome() {
  return process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
}

/**
 * 这条会话在用什么模型。
 * 各产品模型字段的取法不通用，所以一个产品一个适配器、都从**各自的落盘**里捞：
 * TraeCode 见 traeModels.selectedModelOf，Claude Code 见 claudeModels.selectedModelOf。
 * 两者都是因为 hook payload 里压根没有模型字段才只能读盘。
 * 其余产品（CodeBuddy / Codex）payload 里有，用不着适配器；真取不到就留空（绝不编造）。
 * 这里只做"按 client 分派适配器"这一件事，避免把某个产品的私有存储格式写死进通用读函数，
 * 也保持和 products.js 的表驱动扩展约定一致（加新产品就往 MODEL_SOURCES 挂一条，不必改 this 函数）。
 * @param {string} client 楼层客户端（如 'trae' / 'trae-plugin' / 'claude' / 'codex' …）
 * @param {string} sessionId hook payload 的 session_id
 * @param {string} agentType hook payload 的 agent_type（已落盘）
 */
/** client → 取"这条会话当前模型"的适配器表；没挂的照旧取不到 */
const MODEL_SOURCES = { trae: traeModelOf, claude: claudeModelOf };
function sessionModel(client, sessionId, agentType = '') {
  // 按**基名**查表：同一产品的插件/CLI 两种形态（trae-plugin / claude-plugin …）落盘是同一份，
  // 适配器也只认产品，不该因为客户端带了个后缀就取不到（适配器对不认识的会话 id 一律回空串，
  // 所以这里放宽只会"多给一次机会"，不会给错模型）。
  const fn = MODEL_SOURCES[clientBase(client)];
  return fn ? fn(sessionId, agentType) || '' : '';
}

/**
 * reporter hook 的"主控制台相位"：每次事件都会把当前相位（thinking/tool/await）写进
 * ~/.workgremlin/hooks/<工位>.json 的 `sessionPhase` 字段（见 packages/reporter/src/hook.js）。
 * 这是上报真值，优先级高于从 genie-history 推断出来的相位，UI 按真值展示（不标"推断"）。
 * 超过新鲜期（5 分钟）视为作废，避免 IDE 关掉后残留相位一直挂着。
 * 顺带返回同一份状态文件里的 pending（PreToolUse 写、PostToolUse 清），专供"等授权"兜底推断。
 * @returns {{phase: string, tool: string, file: string, cmd: string, prompt: string, model: string, client: string, pending: {tool: string, file: string, cmd: string, at: number}|null}|null}
 */
function readCopilotPhaseFromSqlite(workspacePath, client = '', session = '') {
  if (clientBase(client) !== 'copilot') return null;
  const storage = findPluginStorage(PLUGIN_RE);
  if (!storage) return null;
  const rowList = readSqliteSessionRows(storage)
    .filter((r) => (!session || String(r.id || '') === String(session)))
    .filter((r) => (!workspacePath || !r.projectPath || path.resolve(r.projectPath) === path.resolve(workspacePath)));
  if (!rowList.length) return null;
  rowList.sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0));
  const row = rowList[0];
  // 相位：优先听 VS Code chat 索引的"这一轮在不在飞"，没有旁证才退回 2 分钟新鲜度窗口。
  // 和 listSessions 同一口径（copilotInWindow）—— 不要让旧会话永远显示 thinking，
  // 更不要在轮正跑着的时候报待命。
  const now = Date.now();
  const fresh = copilotInWindow(row, now);
  // 屏上那句"用户说的话"：正在飞的那一轮用会话日志里的原话（Copilot 自己的库要等整轮写完才有）
  const prompt = String(
    (fresh && row.live && row.live.prompt) || row.lastUserMessage || row.summary || ''
  ).trim();
  return {
    client: String(client || 'copilot-plugin').toLowerCase(),
    phase: fresh ? 'thinking' : 'idle',
    tool: '',
    file: '',
    cmd: '',
    prompt,
    model: '',
    pending: null,
    action: '',
    target: '',
    context: [],
  };
}

function readReporterPhase(workspacePath, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  let win = null;
  let winPending = null;
  let winPrompt = '';
  let winClient = '';
  let winModel = '';
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!sameSession(j, session)) continue;
    // 按客户端过滤。老状态文件（本次改动之前写的）没有 client 字段 —— 那会儿只有 CodeBuddy，
    // 所以按 codebuddy 归属，而不是"对谁都匹配"（否则刚重启、Codex 还没写过状态文件时，
    // 3F 会短暂借到 1F 的相位）。
    if (!clientHit(client, j.client)) continue;
    const sp = j.sessionPhase;
    // 相位新鲜期：默认 AWAIT_TTL_MS（IDE 关掉后残留相位不挂）。
    // 但 taskId 还占着（这轮"在跑"）却很久没新 hook 事件（sessionPhase.ts 冻结）= 这一轮其实
    // 已经结束（CodeBuddy ESC 取消不发事件、心跳照跳），不能还显示"调用工具/思考中"，
    // 按更短的 TASK_RUN_MS 回落待命。
    const staleMs = j.taskId ? TASK_RUN_MS : AWAIT_TTL_MS;
    if (!sp || !sp.ts || now - sp.ts > staleMs) continue;
    // 相位早于本进程启动 → 上次运行留下的残留（已关闭的工程），不采信；重启后等新事件再亮
    if (sp.ts < SERVER_STARTED_AT) continue;
    if (workspacePath && sp.workspacePath && path.resolve(sp.workspacePath) !== path.resolve(workspacePath)) continue;
    /* 用户按了"停止"、但**一个 hook 事件都不发**的产品（Claude Code / Qoder，见 claudeInterruptTail）：
       这口相位没人清 —— taskId 还占着、sp.ts 冻在被打断前最后一个事件那一刻，而服务端照
       新鲜期还能再认它 TASK_RUN_MS（2 分钟）。也就是说"取消标记"与"这口 stale 相位"有一整段
       重叠期：红色「任务取消」亮 10s 退回待命后，1.5s 快轮询又把这口相位喂回来，
       主控制台于是挂回「调用工具 / 思考中」——正是"用户终止了任务，控制台却一直停在取消前那个状态"。
       真值在 transcript 末尾那条 `[Request interrupted by user]`：**标记比相位更新 = 这口相位作废**
       （hook 那条路会写显式 idle，这里补的是"没有 hook 事件"那条路）。
       标记之后用户又发了一轮的话，UserPromptSubmit 写的相位 ts 更新 → 这里不再命中，按新相位走。 */
    if (j.taskId) {
      // 打断成立（transcript 标记 / Claude 自己的会话状态说 idle，见 claudeInterruptOf）且打断时刻
      // 不比这口相位旧 → 这口相位作废，不再喂给控制台（否则红灯亮完 10s 又被喂回来）。
      const iv = claudeInterruptOf(j, Number(j.taskStartedAt) || 0);
      if (iv.hit && (!iv.at || iv.at + INTERRUPT_PHASE_SLACK_MS >= Number(sp.ts))) continue;
    }
    if (!win || sp.ts > win.ts) {
      win = sp;
      winClient = String(j.client || LEGACY_STATE_CLIENT);
      // 同一份状态文件里的 pending：PreToolUse 写、PostToolUse 清掉；迟迟不清 = 工具被权限框卡住
      winPending = j.pending || null;
      // 同一份状态文件里的 taskTitle = 用户那句话（标题），思考中时要顶到屏幕最前显示
      winPrompt = j.taskTitle || '';
      // 模型不在这份状态文件里（多数产品的 hook payload 不带），按会话去 TraeCode 自己的落盘取。
      // 但 Kilo / OpenCode 插件（packages/reporter/src/plugin/）**直接把模型写进状态文件**
      // （它们的 session.created 事件带 data.model，轮询那一路本来也能从库里取到）——
      // 所以先认状态文件里这个值，取不到才退回落盘适配器。
      winModel = String(j.model || "") || sessionModel(winClient, j.sessionId, j.agentType);
    }
  }
  if (!win) {
    const sqlFallback = readCopilotPhaseFromSqlite(workspacePath, client, session);
    if (sqlFallback) return sqlFallback;
    return null;
  }
  return {
    // 这份相位是哪个客户端写的（Codex 有显式 PermissionRequest，不需要 pending 推断）
    client: String(winClient || LEGACY_STATE_CLIENT).toLowerCase(),
    phase: String(win.phase || 'thinking'),
    tool: String(win.tool || ''),
    file: String(win.file || ''),
    // hook 在 PreToolUse 写的"实际调用"可读命令（Read src/main.js / grep ... / Bash ...），
    // 给主控制台 tips 当"工具"显示，比纯工具名更直观
    cmd: String(win.cmd || ''),
    // 用户那句话（思考中时主控制台屏幕第三层顶到最前显示；UI 只在 thinking 相位用）
    prompt: String(winPrompt || ''),
    // 这条会话在用什么模型（只有 TraeCode 取得到；别的楼层留空）。取不到就是空串，不猜。
    model: String(winModel || ''),
    // 这份相位的写入时刻：渲染层拿它跟"收尾标记"比先后 —— 只有**比收尾还新**的实时相位
    // 才算"用户又发了一轮"，取消前那一口 stale 的 thinking / tool 不许把红色「任务取消」盖回去。
    ts: Number(win.ts) || 0,
    pending: winPending
      ? { tool: String(winPending.tool || ''), file: String(winPending.file || ''), cmd: String(winPending.cmd || ''), at: Number(winPending.at) || 0 }
      : null,
  };
}

/** 状态文件名里"这个工程"那一段：`@<工程绝对路径>` 整体 sanitize。 */
function stateFileWs(ws) {
  return `@${path.resolve(ws)}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 会话过滤（轴 2）：这条状态文件是不是 `session` 那条会话写的。
 *
 * `session` 为空 → **不限**（保持老行为：同 client 里取最新那份）。
 * 指定了会话时，老状态文件（没有 sessionId 字段）一律不算 —— 它们属于"还没有会话概念"的时代，
 * 硬算给某条会话会让"看 A 会话"读到 B 会话的数据。
 */
function sameSession(j, session) {
  return !session || String((j && j.sessionId) || '') === String(session);
}

/** 进程还在不在（信号 0 = 只探测不投递）。权限不足也算"在"。 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n < 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但不归我们管；ESRCH = 真没了
    return Boolean(e && e.code === 'EPERM');
  }
}

/**
 * 这个成员**还有没有别的会话在跑**（轴 2）。
 *
 * 为什么需要它：`agent_status` 是**按成员一行**存的（`member_id` 是主键），没有会话维度。
 * 同一个 Claude Code 同时开着 A / B 两条会话时，A 收工（Stop → idle）或退出（SessionEnd → offline）
 * 都会去写那**唯一一行**，于是 B 还在干活、工位卡片已经显示「空闲 / 离线」。
 * 所以降级之前先问一句"这条成员的别的会话还活着吗"，活着就别降。
 *
 * 「活着」的判据（任一）：
 *   - 那份状态文件的**心跳守护进程还在**（`hb.pid` 存活）—— 主判据：会话没退，守护就没退；
 *   - 或者它还有**在飞的相位 / 任务**（`sessionPhase` 或 `taskId` 是新鲜的）——
 *     覆盖"守护没起来 / 刚被杀"的情况。注意 SessionEnd 会把这两样清空，所以干净退出的
 *     会话不会被这条误判成活着。
 *
 * **不能用 `hb.lastEventAt` 当判据**：会话干净退出后它照样是新的（它记的是"最后一次事件"，
 * 不是"最后一次心跳"），拿它判会把已结束的会话当成还在跑 —— 实测的症状是：A 退会话后
 * B 也退了，工位卡片还挂在「思考中」，永远降不下来。
 *
 * 只认**同一个 client + 同一个工程**下、**会话 id 不同**的状态文件；老命名文件（没有会话）
 * 不算"别的会话"（它压根没有会话维度，认了会把单会话场景也拦下来）。
 * @param {{workspacePath?: string, client?: string, session?: string, now?: number}} o
 * @returns {boolean}
 */
function hasOtherLiveSession({ workspacePath = '', client = '', session = '', now = Date.now() } = {}) {
  const ws = String(workspacePath || '').trim();
  // 没有会话标识就无从谈起"别的会话"（老 hook / 别的产品）→ 一律不拦
  if (!ws || !session) return false;
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  for (const name of readDir(dir)) {
    const fileSession = stateFileSession(name, m, dir);
    if (fileSession === null || !fileSession || fileSession === session) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!clientHit(client, j.client)) continue;
    // 判据 1：心跳守护还活着（最可靠）
    if (j.hb && pidAlive(j.hb.pid)) return true;
    // 判据 2：还有在飞的相位 / 任务（见函数说明，**不能**用 hb.lastEventAt）。
    // **idle 相位不算"在飞"**：收尾（Stop / Interrupt / idle_prompt）现在都会写一笔显式 idle，
    // 它只说明"这一轮结束了、在等下一句"，把它当"别的会话还在跑"会让成员卡永远回不到空闲
    // （同层 CLI + 插件混跑时尤其明显）。
    const spPhase = String((j.sessionPhase && j.sessionPhase.phase) || '');
    const phaseTs = Number(j.sessionPhase && j.sessionPhase.ts) || 0;
    if (spPhase && spPhase !== 'idle' && phaseTs && now - phaseTs <= AWAIT_TTL_MS) return true;
    const startedAt = Number(j.taskStartedAt) || 0;
    if (j.taskId && startedAt && now - startedAt <= AWAIT_TTL_MS) return true;
  }
  return false;
}

/** 会话 id 的规范形状：UUID（Claude Code 实测就是这个）。 */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 状态文件的文件名 → 它属于哪个会话（`''` = 老命名，没带会话）。
 * 不认识这个名字（不是这个工程的状态文件 / 根本不是状态文件）→ 返回 `null`。
 *
 * 命名由 hook 的 statePath() 决定：`<agent>@<工程绝对路径>[@<会话>]` 整体 sanitize 成 `[A-Za-z0-9._-]`。
 * **加了会话之后文件名尾巴多一段 `_<会话>`**，所以老的 `endsWith('@<工程>.json')` 会全部匹配不上 ——
 * 两处调用（hasReporterState / reporterStateMeta）都走这里，别退回去用 endsWith。
 *
 * **这个编码是有损的**（`_` 既是分隔符又是合法字符），所以单看文件名分不清
 * "工程 `/a/b` + 会话 `sub`" 和 "工程 `/a/b/sub` + 没有会话"——后者是老命名的文件，
 * 会被前者误认成自己的会话。所以尾巴分两步认：
 *   1. 是 UUID → 直接认（Claude Code 的规范形状，绝大多数情况走这条，不读文件）；
 *   2. 不是 UUID → 回读文件内容，**内容里的 `sessionId` 才是权威**（它是 hook 原样写进去的，
 *      没过 sanitize）。内容对不上就不认 —— 于是上面那个 `/a/b/sub` 的老文件会被正确排除。
 * @param {string} name 文件名
 * @param {string} wsPart stateFileWs() 的结果
 * @param {string} dir hooks 目录（第 2 步回读内容用）
 * @returns {string|null} 会话 id（可为 ''）
 */
function stateFileSession(name, wsPart, dir) {
  if (!/\.json$/i.test(name)) return null;
  const base = name.slice(0, -5);
  if (base.endsWith(wsPart)) return '';
  const i = base.lastIndexOf(wsPart);
  if (i < 0) return null;
  const tail = base.slice(i + wsPart.length);
  // 会话尾巴是一段 `_<id>`。**`_` 本身必须允许出现在 id 里** —— Kilo / OpenCode 的会话 id
  // 形如 `ses_f22614607ffeQV…`（OpenCode 同款），id 内不含 `_`，但**测试夹具与将来任何
  // 带下划线的 id** 都会被这里挡掉：那一份状态文件就被当成"不认识的文件"跳过，
  // `hasReporterState` / `reporterStateMeta` 恒返回 false → UI 一直显示「未上报」，
  // 而不是「接了 hook、当前没事干」。之前这里写的是 `[A-Za-z0-9.-]`（只有 UUID 成立）。
  //
  // 放宽不会引入歧义：这个编码本来就是有损的（`_` 既是分隔符又是合法字符），
  // 下面紧接着就是靠**回读文件内容里的 sessionId** 来定音的 —— 内容对不上照样不认。
  if (!/^_[A-Za-z0-9._-]+$/.test(tail)) return null;
  const cand = tail.slice(1);
  if (SESSION_UUID_RE.test(cand)) return cand;
  const j = readJson(path.join(dir, name));
  return j && String(j.sessionId || '') === cand ? cand : null;
}

/**
 * 这个工程有没有接过 hook（= 有没有对应的 hook 状态文件）。
 *
 * 和"有没有新鲜相位"是两回事：会话结束后 hook 会把 sessionPhase 清空（正确行为），
 * 但此时 CLI 楼层不该退回"按 jsonl mtime 猜"的兜底（那会让 3F 一直显示「调用工具 / 改 xxx.jsonl」），
 * 而应该显示「待命」。渲染层靠这个字段区分"没接 hook"与"接了但当前没事干"。
 *
 * 状态文件名由 hook 的 statePath() 生成：`<member>@<工程绝对路径>[@<会话>]`，非 [A-Za-z0-9._-] 换成 `_`。
 * @param {string} workspacePath
 * @param {string} [client] 来源客户端；空则不限
 */
function hasReporterState(workspacePath, client = '') {
  const ws = String(workspacePath || '').trim();
  if (!ws) return false;
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  for (const name of readDir(dir)) {
    // 注意判 null 而不是判 falsy：老命名文件（不带会话）返回的是空串，那也是**本工程的**状态文件
    if (stateFileSession(name, m, dir) === null) continue;
    if (!client) return true;
    const j = readJson(path.join(dir, name));
    // 老文件没记 client → 按 codebuddy 归属（同上）
    if (clientHit(client, j && j.client)) return true;
  }
  return false;
}

/**
 * 这个工程有没有接过 hook，以及那份状态文件属于**哪条会话**。
 *
 * 为什么要会话 id：hook 是会话级加载的（会话启动时装，之后改配置不影响它），
 * 所以"工程里有状态文件"不等于"你正在看的这条会话在上报"——
 * 实测：13:40 开的旧会话没有 hook，但同工程里跑过 `codex exec`，状态文件存在，
 * 界面就会把这条会话显示成「待命」，看起来像"整轮对话没有状态变化"。
 * @returns {{instrumented: boolean, sessionId: string}}
 */
function reporterStateMeta(workspacePath, client = '', session = '') {
  const ws = String(workspacePath || '').trim();
  if (!ws) return { instrumented: false, sessionId: '' };
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  let best = null;
  let bestTs = -1;
  for (const name of readDir(dir)) {
    const fileSession = stateFileSession(name, m, dir);
    if (fileSession === null) continue;
    // 指定了会话就只认那一条：文件名里的会话是 hook 写的，最可信；
    // 老命名文件（没带会话）在指定会话时一律不算 —— 否则"看会话 B"会借到会话 A 的老文件。
    if (session && fileSession !== session) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    // 老状态文件没记 client → 按 codebuddy 归属（与相位读取同一口径）
    if (!clientHit(client, j.client)) continue;
    const ts = (j.sessionPhase && j.sessionPhase.ts) || j.taskStartedAt || (j.hb && j.hb.lastEventAt) || 0;
    if (ts >= bestTs) {
      bestTs = ts;
      best = j;
    }
  }
  if (!best) return { instrumented: false, sessionId: '' };
  return { instrumented: true, sessionId: String(best.sessionId || '') };
}

function reporterMainPhase(workspacePath, client = '', session = '') {
  const rp = readReporterPhase(workspacePath, client, session);
  if (!rp) return null;
  // 下面每个分支都是**各建各的对象**，不是展开 rp —— 要往外带什么字段，每个分支都得加一遍，
  // 漏了就会静默丢掉（model 就这么丢过一次）。
  if (rp.phase === 'await') {
    return {
      phase: 'await',
      action: rp.tool ? `申请执行 ${rp.tool}` : '等待用户授权',
      target: rp.file || '',
      context: ['等待用户授权后继续', rp.tool && `工具：${rp.tool}`, rp.file && `目标：${rp.file}`].filter(Boolean),
      prompt: rp.prompt || '',
      model: rp.model || '',
      // 相位写入时刻：渲染层拿它跟收尾标记比先后（见 IsoOfficeView 的 consoleLive 守卫）
      ts: Number(rp.ts) || 0,
    };
  }
  // 等授权兜底：本环境实测 CodeBuddy 不发 permission_prompt 通知（events.log 无 Notification 行），
  // 所以靠 hook 留下的 pending 推断——PreToolUse 写了 pending + sessionPhase=tool，
  // 若超过 AWAIT_PROBE_MS 仍无 PostToolUse 来清掉，说明工具被权限框卡住了。
  // 只读 / 命令类工具（NEVER_AWAIT_TOOLS）本就不发 PostToolUse、也不该弹权限框，排除掉避免误报
  // （典型误报：读文件却显示「等待授权」、点了 run 还在「等待授权」）。
  if (
    clientBase(rp.client) !== 'codex' && // Codex 用显式 PermissionRequest，跳过这套推断（codex / codex-plugin 都算）
    rp.phase === 'tool' &&
    rp.pending &&
    rp.pending.at &&
    Date.now() - rp.pending.at > AWAIT_PROBE_MS &&
    !NEVER_AWAIT_TOOLS.has(rp.pending.tool || rp.tool)
  ) {
    const tool = rp.pending.tool || rp.tool;
    const file = rp.pending.file || rp.file;
    return {
      phase: 'await',
      action: tool ? `申请执行 ${tool}` : '等待用户授权',
      target: file || '',
      context: ['等待用户授权后继续', tool && `工具：${tool}`, file && `目标：${file}`].filter(Boolean),
      prompt: rp.prompt || '',
      model: rp.model || '',
      ts: Number(rp.ts) || 0,
    };
  }
  if (rp.phase === 'tool') {
    // 优先显示 hook 报上来的完整命令（Read src/main.js / grep ... / Bash npm run build），
    // 没有再回退到「调用 Xxx」泛化文案。
    // action 是具体在做什么；tool 只显示工具名，不要塞完整命令。
    const cmd = rp.cmd || (rp.tool ? `调用 ${rp.tool}` : '调用工具');
    return {
      phase: 'tool',
      action: cmd,
      tool: rp.tool || '',
      target: rp.file || '',
      context: rp.file ? [`目标：${rp.file}`] : [],
      prompt: rp.prompt || '',
      model: rp.model || '',
      ts: Number(rp.ts) || 0,
    };
  }
  // 其余相位**原样透传**，不要压成 thinking。
  //
  // 早先这里只认 await / tool 两个分支，剩下的全落进最后的 thinking 兜底，于是
  // 「写 idle 的一轮结束了」与「写 done 的任务完成了」在控制台上都显示成「思考中」——
  // 收工了还在显示在思考，是把已完成说成还在忙。相位词汇表里本来就有
  // idle / unreported / plan / dispatch / summarize / done / waiting 这几项
  // （见 renderer/src/iso/mainConsole.js 的 PHASES），透传即可，不必各自再包一层。
  // 真正**不认识**的相位才落 thinking（兜底，且只对未知值生效）。
  if (rp.phase && rp.phase !== 'await' && rp.phase !== 'tool') {
    return { phase: rp.phase, action: '', target: '', context: [], prompt: rp.prompt || '', model: rp.model || '', ts: Number(rp.ts) || 0 };
  }
  // thinking：干净，不堆示意字；但把用户那句话（prompt）一并带出，屏幕第三层顶到最前显示
  return { phase: 'thinking', action: '', target: '', context: [], prompt: rp.prompt || '', model: rp.model || '', ts: Number(rp.ts) || 0 };
}

/**
 * reporter hook 的"活跃窗口"：UserPromptSubmit 落 taskId、Stop 清空。
 * 只有在这个窗口内（用户提交了任务、agent 还没收工）才算"活着"；
 * 会话存在但没有事件时一律待命 —— 主控制台据此决定要不要显示活跃状态。
 *
 * 还要校验"这份状态文件本身是否还活着"：历史遗留 / 已退出的会话会在 hooks 目录里
 * 留下 taskId 不再更新的死文件（例如改「按工位+工程分文件」之前的老命名文件）。
 * 不校验的话，只要有一个死文件的 taskId 跟当前工程匹配，inWindow 就会被永久顶成 true，
 * 于是 Stop 之后仍旧按"还在干活"推出「思考中」。
 * @param {string} workspacePath 当前打开的工程；空则不限工程
 * @param {string} [client] 来源客户端；空则不限客户端
 * @returns {boolean}
 */
function readReporterActiveTask(workspacePath, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j || !j.taskId) continue;
    if (!sameSession(j, session)) continue;
    // 按客户端过滤（口径同 readReporterPhase：老状态文件没记 client → 归 codebuddy）：
    // 同一工程里别的产品在跑时，别把它的任务算成本层"还在干活"的活跃窗口
    if (!clientHit(client, j.client)) continue;
    const ws = j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    // 心跳时间**不能**算"任务在跑"：它只证明 IDE 会话还开着（见 hasOtherLiveSession 的同名纪律），
    // 取消时心跳照跳会让 taskId 永远新鲜、相位卡死在思考中/调用工具。只认 hook 事件时间
    // （taskStartedAt 起轮、sessionPhase.ts 每次事件刷新）：取消后没有新事件，超 TASK_RUN_MS
    // 就当这一轮结束了，inWindow 回落待命。
    const lastAt = Math.max(
      Number(j.taskStartedAt) || 0,
      Number(j.sessionPhase && j.sessionPhase.ts) || 0
    );
    if (!lastAt || now - lastAt > TASK_RUN_MS) continue;
    return true;
  }
  return false;
}

/**
 * reporter hook 在 Stop 时落的"完成"标记（带工程路径），按**工程 + 客户端**一次扫盘取回。
 * 返回 { latest, bySession }：latest = 该 (工程, 客户端) 里最新的一份；bySession = 会话 id -> 该会话最新的一份。
 *
 * 为什么拆成"一次读盘"和"按会话取"两步：会话表扫盘一次能扫出上百个历史会话文件，
 * 若每扫到一条就去调一次 readReporterDone，hooks 目录就要被扫上百遍
 * （消费方见 sessionRegistry 里按 (工程, 客户端) 缓存的 doneScans）。
 */
/**
 * 状态文件里的 `roundFiles`（`{path,op,abs}`）→ 完成标记的 `files` 形状（带 size）。
 * 取消时用它补"取消前已经动了哪些文件"（与 hook.js 的 collectRoundFiles 同口径）：
 * 去重、删除类不给 size、stat 不到就不给（绝不编造）。
 * @param {{roundFiles?: Array<any>}} j 状态文件内容
 */
function roundFilesOf(j) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(j && j.roundFiles) ? j.roundFiles : []) {
    const p = typeof x === 'string' ? x : x && x.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    let size = null;
    const abs = x && typeof x === 'object' ? x.abs : '';
    if (abs && !(x && x.op === 'delete')) {
      try {
        const s = fs.statSync(abs);
        if (s.isFile()) size = s.size;
      } catch {
        /* 文件删了 / 挪了：不给 size，路径照记 */
      }
    }
    out.push(size == null ? { path: p } : { path: p, size });
  }
  return out;
}

/**
 * Claude / Qoder 风格 transcript 的**尾部窗口**：这一轮有没有被用户打断、以及打断前最后说了什么。
 *
 * 为什么必须由服务端来判：这两家（实测 2026-09-29，4F Claude Code 的 VS Code 扩展形态）
 * 用户按"停止"后**一个 hook 事件都不发** —— events.log 里 Stop / SessionEnd / Notification
 * 全无，事件流停在最后一次 PostToolUse，所以 hook 侧的 `turnInterrupted`（跑在 Stop 分支里）
 * 根本没机会执行。唯一权威的痕迹是 transcript 末尾那条 user 消息
 * `[Request interrupted by user]`（工具中途打断带 ` for tool use` 后缀）。
 *
 * 读法：只读文件**最后 128KB**（标记永远写在末尾，长会话不必整份读），按 mtime+size+sinceTs 缓存，
 * 同一个文件在标记落盘后只会被解析一次。逐行 `JSON.parse` 按结构判（`type:'user'` 且正文文本
 * 命中标记），工具结果 / 思考里带同名字符串一律不算。
 *
 * **CLI 与 VS Code 扩展不一样，差别在"什么时候按的停止"**（实测 2026-09-29，同一台机器两边复现）：
 *   · 模型已经吐出东西（工具在跑）再打断 → 两边都落 ` for tool use` 那条标记，本函数认得到。
 *   · 刚提交、模型还没输出就按停止 → **扩展照样落 `[Request interrupted by user]`（认得到）；
 *     终端 CLI 一行都不写**：提示词被还原回输入框，events.log 停在同秒的 UserPromptSubmit，
 *     transcript 停在用户那条 prompt 上 —— 这一种在盘上**没有任何痕迹**，不是读取口径的问题。
 *     真实案例：任务 t_mumetsne_quls1x（"测试 claude code CLI任务取消"，16:24，CLI 形态）。
 *   于是这一种只能等相位新鲜期（TASK_RUN_MS 2 分钟）过期后控制台回待命，红灯不亮、
 *   台账那行的结束时间一直是空 —— 这是**已知缺口**，不是回归。
 *
 * 上面那个缺口**2026-09-29 已接上**（用户明确同意用未公开内部文件）：Claude Code 自己在
 * `<claudeHome>/sessions/<pid>.json` 里记 `{sessionId, entrypoint, status, statusUpdatedAt}` ——
 * `status` 只有 busy / idle，一轮结束就翻 idle、时间戳很准（实测那轮 08:24:00.769 提交、
 * 08:24:03.137 翻 idle，早打断同样对上；且 idle 期间文件不再刷新，所以那个时间戳就是"这轮
 * 什么时候结束的"）。判据与实现见下面 claudeInterruptOf 的 ② 号信号：状态文件里 taskId 还占着 +
 * 没有收工标记 + status=idle 且 statusUpdatedAt ≥ taskStartedAt ⇒ 这一轮被掐了。
 * 已知风险：那是**未公开的内部文件**（格式随时可能变）→ 读不到/字段缺失一律当"没有"，绝不猜。
 *
 * @param {string} transcriptPath
 * @param {number} sinceTs 本轮任务开始时刻（0 = 不过滤）：只认这一轮落的标记，老一轮的不算
 * @returns {{interrupted:boolean, said:string, at:number}}
 */
const TRANSCRIPT_TAIL_BYTES = 128 * 1024;
const _claudeTailCache = new Map();
function claudeInterruptTail(transcriptPath, sinceTs = 0) {
  const miss = { interrupted: false, said: '', at: 0 };
  if (!transcriptPath || !isFile(transcriptPath)) return miss;
  let stat = null;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return miss;
  }
  const cached = _claudeTailCache.get(transcriptPath);
  if (cached && cached.m === stat.mtimeMs && cached.size === stat.size && cached.sinceTs === sinceTs) {
    return cached.res;
  }
  let raw = '';
  try {
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const len = stat.size - start;
    if (len <= 0) return miss;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString('utf8');
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关不上也不影响这次读取 */
      }
    }
  } catch {
    return miss;
  }
  let interrupted = false;
  let said = '';
  let at = 0;
  for (const line of raw.split(/\r?\n/)) {
    // 便宜先行：这一行连关键词、也不是 assistant 正文候选就跳过（尾部第一行多半是被截断的，解析会失败）
    if (!line || !/interrupted|"role"\s*:\s*"assistant"/.test(line)) continue;
    let o = null;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const ts = Date.parse(String(o.timestamp || '')) || 0;
    if (sinceTs && ts && ts < sinceTs) continue;
    const msg = o.message && typeof o.message === 'object' ? o.message : null;
    const content = msg ? msg.content : o.content;
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content
              .filter((x) => x && (x.type === 'text' || x.type === 'output_text') && typeof x.text === 'string')
              .map((x) => x.text)
          : [];
    if (!texts.length) continue;
    // 打断标记：一条 user 消息，正文（text part，不是 tool_result）就是 [Request interrupted by user]
    if (o.type === 'user' && texts.some((t) => /^\s*\[?request interrupted by user/i.test(String(t)))) {
      interrupted = true;
      if (ts) at = Math.max(at, ts);
      continue;
    }
    const role = String((msg && msg.role) || o.role || '');
    if (role === 'assistant') {
      const txt = texts.join('\n').trim();
      if (txt) said = txt; // 取最后一段（覆盖前面的）
    }
  }
  const res = { interrupted, said, at };
  _claudeTailCache.set(transcriptPath, { m: stat.mtimeMs, size: stat.size, sinceTs, res });
  return res;
}

/**
 * Claude Code 自己的**会话状态文件**：`<claudeHome>/sessions/<pid>.json`，
 * 一个运行中的 CLI 进程一个文件。字段实测（2026-09-29，2.1.281/2.1.283）：
 *   { pid, sessionId, cwd, startedAt, kind:'interactive', entrypoint:'cli'|'claude-vscode',
 *     status:'busy'|'idle', updatedAt, statusUpdatedAt }
 *
 * **这是 Claude Code 未公开的内部文件**（用户 2026-09-29 明确同意用它做兜底），格式随时可能变 ——
 * 所以读不到 / 缺字段 / 解析失败一律当"没有"，绝不猜；只按 sessionId **精确**匹配。
 * 关键实测：**idle 期间这个文件不再刷新**（statusUpdatedAt 一直冻在"翻 idle 的那一刻"），
 * 于是它就是"这一轮什么时候结束的"时间戳；反过来 status='busy' = 正在生成。
 *
 * 目录列举缓存 2s、文件按 (mtime,size) 缓存 —— 每个扫盘周期会被问好几次，别每次都重读。
 * @param {string} sessionId
 * @returns {{status:string, statusUpdatedAt:number, updatedAt:number, pid:number, entrypoint:string, kind:string}|null}
 */
const _claudeSessFiles = { at: 0, names: [] };
const _claudeSessData = new Map(); // path -> {m, size, data}
function claudeSessionStatus(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  const dir = path.join(claudeHome(), 'sessions');
  const now = Date.now();
  if (now - _claudeSessFiles.at > 2_000) {
    _claudeSessFiles.names = readDir(dir).filter((n) => /\.json$/i.test(n));
    _claudeSessFiles.at = now;
  }
  let best = null;
  for (const name of _claudeSessFiles.names) {
    const p = path.join(dir, name);
    let stat = null;
    try {
      stat = fs.statSync(p);
    } catch {
      continue; // 进程退出时文件可能被删掉：跳过，不猜
    }
    const cached = _claudeSessData.get(p);
    let data = cached && cached.m === stat.mtimeMs && cached.size === stat.size ? cached.data : null;
    if (!data) {
      data = readJson(p);
      _claudeSessData.set(p, { m: stat.mtimeMs, size: stat.size, data });
    }
    if (!data || String(data.sessionId || '') !== sid) continue;
    // 同一个 sessionId 可能同时有多份（老进程残留）→ 取 updatedAt 最新的那份
    if (!best || Number(data.updatedAt || 0) > Number(best.updatedAt || 0)) best = data;
  }
  return best;
}

/**
 * 这一轮（状态文件 `j`）是不是被用户打断了；是的话给出**打断时刻**。
 *
 * 两个信号（都是"按了停止却一个 hook 事件都不发"那条路的兜底），取先命中的：
 *   ① `claudeInterruptTail`：transcript 尾部那条 `[Request interrupted by user]`
 *      —— 模型已经吐过字 / 正在跑工具时打断，CLI 与 IDE 扩展都会写；
 *   ② `~/.claude/sessions/<pid>.json` 写着 `status='idle'` 且 statusUpdatedAt 晚于本轮开始
 *      —— "刚提交、模型一个字都没吐就按 ESC"：transcript **一行都不写**、hook **一个事件都不发**，
 *         只有这里看得出（2026-09-29 接上；用户明确同意用这个未公开文件）。
 *         ⚠ 只在"本轮已经开始 ≥ CLAUDE_IDLE_GRACE_MS"之后才采信：开轮那一瞬 CLI 可能还写着
 *         idle（还没翻 busy），不设宽限会把刚提交的正常一轮误判成取消。
 *      取消时间用 statusUpdatedAt（**不拿"现在"冒充**）。
 *
 * 另有一条硬前提：这一轮**没有收工标记**（`j.done` 早于本轮开始 = 上一轮残留，不算数）。
 * @param {any} j reporter 状态文件内容
 * @param {number} startedAt 本轮开始时刻
 * @returns {{hit:boolean, at:number, via:'transcript'|'idle'|''}} at=0 表示打断成立但拿不到时刻
 */
const CLAUDE_IDLE_GRACE_MS = 3_000;
function claudeInterruptOf(j, startedAt) {
  const none = { hit: false, at: 0, via: '' };
  if (!j) return none;
  const base = clientBase(j.client);
  if (base !== 'claude' && base !== 'qoder') return none;
  const started = Number(startedAt) || 0;
  const doneAt = Number(j.done && j.done.at) || 0;
  if (doneAt && (!started || doneAt >= started)) return none; // 这一轮已经正常收尾
  const ci = claudeInterruptTail(j.transcriptPath, started);
  if (ci.interrupted) return { hit: true, at: Number(ci.at) || 0, via: 'transcript' };
  const st = claudeSessionStatus(j.sessionId);
  if (!st || String(st.status) !== 'idle') return none;
  const at = Number(st.statusUpdatedAt || st.updatedAt) || 0;
  if (!at || !started || at < started) return none; // idle 是开轮之前翻的 → 那一轮还没结束
  if (Date.now() - started < CLAUDE_IDLE_GRACE_MS) return none; // 刚开轮，别误伤
  return { hit: true, at, via: 'idle' };
}

function readReporterDones(workspacePath, client = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  /** sessionId -> 该会话最新的一份 */
  const bySession = new Map();
  /** 该工程 + 客户端里最新的一份（会话 id 拿不到的楼层用它兜底） */
  let latest = null;
  /** 兜底合成的"取消"标记里、需要服务端补发 task/end(cancelled) 的那些（见 sessionRegistry 的 flush）。
   *  CodeBuddy IDE 这类不收 Stop / Interrupt 的产品，取消只靠这一条兜底漏出来，而它原本只写
   *  内存标记、从不 notify 服务端台账 —— 任务就一直卡在「进行中」。这里把"该补一刀"的会话列出来，
   *  由 sessionRegistry 在 refresh 时去重后发一次 task/end。 */
  const cancels = [];
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!clientHit(client, j.client)) continue;
    const ws = (j.done && j.done.workspacePath) || j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    const id = String(j.sessionId || '');
    // 真·完成标记（Stop 落盘）：取每会话最新的一份
    if (j.done && j.done.at && now - Number(j.done.at) <= DONE_TTL_MS) {
      const done = j.done;
      const prev = id ? bySession.get(id) : null;
      if (id && (!prev || Number(done.at) > Number(prev.at))) bySession.set(id, done);
      if (!latest || Number(done.at) > Number(latest.at)) latest = done;
    }
    /* 兜底合成取消标记。
       **只认"用户真按了停止"的信号**（Claude/Qoder，见 claudeInterruptOf 的两个信号）。
       这里曾经还有一条"任务槽卡死 + transcript 末轮 state='running' ⇒ 判被打断"的兜底
       （CodeBuddy IDE 收不到 Stop / Interrupt 时用），**2026-09-29 去掉了**：它判不出
       "还在慢慢想"和"被打断"—— 长时间不调工具的轮（模型纯推理 > TASK_RUN_MS）会被误判成
       取消，控制台先弹红色「任务取消」+「待命中」，下一条事件回来又跳回「思考中」，
       用户看到的就是"任务没完成却报取消"。宁可这种轮暂时停在旧相位（相位新鲜期到了会回落
       待命），也不误报取消。 */
    if (j.taskId) {
      const startedAtJ = Number(j.taskStartedAt) || 0;
      /* Claude Code / Qoder（4F / 6F，CLI 与 IDE 扩展都一样）：用户按"停止"后**一个 hook
         事件都不发** —— 实测 2026-09-29 的 4F：events.log 里 Stop / SessionEnd / Notification
         全无，事件流停在最后一次 PostToolUse。hook 侧那条 `turnInterrupted` 跑在 Stop 分支里，
         没事件就永远执行不到，于是控制台一直停在「思考中」、也永远不亮红色「任务取消」。
         只能由服务端在轮询时自己认，两个信号见 claudeInterruptOf：
           ① transcript 尾部那条 `[Request interrupted by user]`（模型已输出 / 正在跑工具时打断）；
           ② Claude 自己的会话状态文件 `<claudeHome>/sessions/<pid>.json` 说 idle
              （"刚提交、一个字都没吐就 ESC"——transcript 一行都不写，只有这里看得出）。
         认出来就合成取消标记。
         **不设 TASK_RUN_MS 门槛**：信号一到位就该亮（服务端 5~10s 扫一轮 + 前端 1.5s 快轮询，
         足够"准实时"）；同一轮靠 (会话, 任务, at) 去重，只补发一次。 */
      const base = clientBase(j.client);
      if (base === 'claude' || base === 'qoder') {
        const iv = claudeInterruptOf(j, startedAtJ);
        if (iv.hit) {
          // 收尾自述只有 transcript 那条路有（idle 兜底认出来的早打断，本来就没吐过字）
          const ci = claudeInterruptTail(j.transcriptPath, startedAtJ);
          const filesC = roundFilesOf(j);
          const saidC = String(ci.said || '').replace(/\s+/g, ' ').trim().slice(0, 160);
          const atC = iv.at || Number(j.sessionPhase && j.sessionPhase.ts) || startedAtJ || now;
          const cancelC = {
            at: atC, title: j.taskTitle || '', workspacePath: ws,
            sessionId: id, cancelled: true, files: filesC.slice(0, 8), fileCount: filesC.length, said: saidC,
          };
          const prevC = id ? bySession.get(id) : null;
          if (id && (!prevC || Number(cancelC.at) > Number(prevC.at))) bySession.set(id, cancelC);
          if (!latest || Number(cancelC.at) > Number(latest.at)) latest = cancelC;
          cancels.push({
            sessionId: id,
            taskId: j.taskId,
            client: j.client,
            workspacePath: ws,
            at: atC,
            title: j.taskTitle || '',
            form: j.form || '',
            files: filesC,
            fileCount: filesC.length,
            result: String(ci.said || '').trim().slice(0, 4_000),
          });
        }
      }
    }
  }
  return { latest, bySession, cancels };
}

/** "任务完成"的唯一真源：取**某条会话**的完成标记（不靠相位回落到空闲来猜，避免中途误弹）。
 *  同一个 (工程, 客户端) 下可能有多条会话，各取各的；会话 id 拿不到的楼层（Codex 的
 *  rollout 文件名不含 session_id）退回"该 client 最新的一份"——不猜，只是放宽到这一步。 */
function readReporterDone(workspacePath, client = '', session = '') {
  const { latest, bySession } = readReporterDones(workspacePath, client);
  const hit = session ? bySession.get(String(session)) || null : latest;
  if (hit) return hit;
  // 9F GitHub Copilot 没有 hook：状态文件这条路永远是空的，完成标记得从它自己的会话日志取
  // （最新那一轮 request 的 completedAt，见 readCopilotLiveRequest）——不然 9F 永远没有
  // 「任务完成」那一下（实测 2026-09-28：7F/8F 都有、9F 一直空）。
  if (clientBase(client) === 'copilot') {
    const d = readCopilotDone(session);
    if (d) return d;
  }
  return hit;
}

/**
 * 9F 的完成标记（会话表形状 `{doneAt,doneTitle,doneCount,doneFiles}`，与各产品的 read*Done 同形）。
 * 取会话日志里最新那一轮的 completedAt；超 DONE_TTL_MS 或那一轮还没收工都没有。
 * @param {string} sessionId
 */
function readCopilotDone(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const at = copilotDoneAt({ live: readCopilotLiveRequest(id) }, Date.now());
  if (!at) return null;
  return { doneAt: at, doneTitle: '', doneCount: 0, doneFiles: [] };
}

/**
 * hook 上报的会话清单 —— 给"只认 hook"的楼层当会话来源（见 products.js 的 hookSource）。
 *
 * TraeCode IDE 没有可扫的会话落盘（`~/.trae-cn/memory/*.jsonl` 是它自己的记忆文件，
 * 不是对话会话，拿来当会话就是编造），所以它的会话表直接由 reporter 状态文件构成：
 * sessionId 就是 hook payload 的 `session_id`，工程路径取相位 / 任务里记的 workspacePath ——
 * 两个都是实测值，不猜。老命名文件（没有 sessionId）没有会话维度，不算。
 * @param {string} client 客户端身份（**这一路来源**的 client，如 trae / codebuddy）；空则不限
 * @returns {Array<{sessionId: string, workspacePath: string, lastEventAt: number}>}
 */
function listReporterSessions(client = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const byId = new Map();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!clientHit(client, j.client)) continue;
    const sessionId = String(j.sessionId || '').trim();
    if (!sessionId) continue;
    const sp = j.sessionPhase || {};
    const lastEventAt = Math.max(
      Number(j.hb && j.hb.lastEventAt) || 0,
      Number(sp.ts) || 0,
      Number(j.taskStartedAt) || 0
    );
    if (!lastEventAt) continue;
    const prev = byId.get(sessionId);
    // 同一会话可能有多份状态文件（换过工程 / 老命名残留）：取最新那份的工程
    if (!prev || lastEventAt > prev.lastEventAt) {
      byId.set(sessionId, {
        sessionId,
        workspacePath: String(sp.workspacePath || j.taskWorkspacePath || ''),
        lastEventAt,
      });
    }
  }
  return [...byId.values()];
}

/**
 * 当前"真正在敲"的工程：取 reporter hook 最近一次写相位 / task 的工程路径。
 * reporter 把相位打在 REAL_WS（它实际运行的工程），而不是 office 手工"打开工程"记的那个，
 * 所以这里用最新活动判定，避免 IDE 里直接开新工程时相位错归到旧工程（主控制台对不上下拉）。
 * 超过新鲜期（AWAIT_TTL_MS）视为失效，回落到传入的 fallback（通常是 office 当前打开的工程）。
 * @param {string} fallback 回落值
 * @returns {string}
 */
function freshestReporterWs(fallback, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  let best = '';
  let bestTs = 0;
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!sameSession(j, session)) continue;
    if (!clientHit(client, j.client)) continue;
    const sp = j.sessionPhase;
    const ts = (sp && sp.ts) || (j.taskId ? j.taskStartedAt || 0 : 0);
    const ws = (sp && sp.workspacePath) || j.taskWorkspacePath || '';
    if (!ws || !ts || now - ts > AWAIT_TTL_MS) continue;
    // 同上：只认本进程启动之后写入的相位，避免用上次运行的残留判定"当前工程"
    if (ts < SERVER_STARTED_AT) continue;
    if (ts > bestTs) {
      bestTs = ts;
      best = ws;
    }
  }
  return best ? path.resolve(best) : fallback ? path.resolve(fallback) : '';
}

/**
 * 主 Agent 阶段：会话落盘里没有"阶段"这个字段，只能推。
 * 所以返回值一律带 inferred: true，UI 按推断展示。
 */
function inferPhase({ todos, files, runtime, pending, lastUpdated, now, inWindow }) {
  // 活跃窗口 = reporter hook 的 UserPromptSubmit..Stop（本地状态文件 taskId 非空）。
  // 不在窗口内 → 一律待命：会话存在但没有事件，绝不凭空显示活跃状态。
  if (!inWindow) {
    return { phase: 'idle', action: '', inferred: true };
  }
  // 没有任何线索（没待办、没改文件、没运行态）→ 空闲
  if (!todos.total && !files.count && !runtime.activated) {
    return { phase: 'idle', action: '', inferred: true };
  }
  // 重启纪元：推断用的时间证据（文件改动 / 待办 / 运行态落盘）也必须是**本进程启动之后**的。
  // 否则"上次运行留下的最后一次文件改动"（仍在 BUSY_MS 窗口内）会在重启瞬间被判成「调用工具」，
  // 与"重启后先待命、等下一个新事件"相悖。与 readReporterPhase 用同一把尺子。
  const afterRestart = (ts) => Number(ts) >= SERVER_STARTED_AT;
  // 显式状态也只在"近期真有动静"时采信，避免 IDE 关掉后残留的运行态一直挂着
  if (runtime.paused && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'idle', action: '会话已暂停', inferred: true };
  }
  if (runtime.awaitingSessionIdle && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'summarize', action: '等会话空闲后收尾', inferred: true };
  }

  // 正在干活：必须"新鲜"证据，否则 IDE 关掉后残留的 in_progress 待办 / 文件改动会一直显示「工具中」
  if (todos.doing && afterRestart(todos.at) && now - todos.at < IDLE_MS) {
    return { phase: 'tool', action: todos.doing, inferred: true };
  }
  if (afterRestart(files.lastAt) && now - files.lastAt < BUSY_MS) {
    const f = files.recent[0];
    return { phase: 'tool', action: `改 ${f.name}（+${f.added}/-${f.removed}）`, inferred: true };
  }
  // 运行态极新鲜（插件最近在落盘）→ 这一轮对话真的在推进（含纯推理、只读工具等拿不到文件/待办证据的情况）。
  // 没有"正在调工具"的硬证据，只是知道在动，归到「思考中」——绝不凭空显示「调用工具」。
  if (afterRestart(lastUpdated) && now - lastUpdated < FRESH_MS) {
    return { phase: 'thinking', action: '', inferred: true };
  }

  // 有排队待发消息（且不是陈年残留）→ 规划 / 待处理
  if (pending > 0 && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'plan', action: `${pending} 条待发消息排队中`, inferred: true };
  }

  // 没有新动静：IDE 多半关了 / 在等用户。回空闲，不再凭"激活过"瞎显示「规划中」
  return { phase: 'idle', action: '会话空闲', inferred: true };
}

/** 单个会话的完整信息 */
function sessionInfo(storage, id, { current = false, now = Date.now(), workspacePath = '', inWindow = false, client = '' } = {}) {
  const todos = readTodos(storage, id);
  const files = readFileChanges(storage, id);
  const mq = readRuntime(storage, id);
  const lastUpdated = Math.max(todos.at, files.lastAt, mq.updatedAt) || null;
  // 活跃 = 当前会话且近期有动静 / 运行态新鲜 / 刚改过文件。
  // 关键：关掉 IDE 后插件不再落盘，但 current.json 仍指向它、runtime.activated 也残留为真，
  // 所以不能只靠 current / activated 判定活跃，必须用"近期有写入"确认它真的还活着，
  // 否则关掉窗口的会话会一直卡在列表里、相位还停在「规划中」。
  const active = Boolean(
    (current && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (mq.runtime.activated && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (files.lastAt && now - files.lastAt < BUSY_MS)
  );
  // 还在列表里（宽窗口，60 分钟）；active 仍是"热窗口"，只影响相位推断
  const listed = Boolean(lastUpdated && now - lastUpdated < LISTED_MS);
  const inferred = inferPhase({ todos, files, runtime: mq.runtime, pending: mq.pending, lastUpdated, now, inWindow });

  /** 悬浮屏第三层：任务清单（状态用符号标出来，不做翻译） */
  const mark = { completed: '✓', in_progress: '▶', pending: '·' };
  let phase = inferred.phase;
  let action = inferred.action;
  let target = '';
  let tool = '';
  let context = todos.items.map((t) => `${mark[t.status] || '·'} ${t.content}`);

  // 上报真值：reporter hook 把每个事件的相位（思考中 / 调用工具 / 等待授权）落到本地状态文件。
  // 优先级高于从 genie-history 推断的相位；只在"当前会话"上生效（相位必然出在这只 agent 身上）。
  let reported = false;
  let prompt = '';
  if (current && inWindow) {
    const rp = reporterMainPhase(workspacePath, client);
    if (rp) {
      reported = true;
      phase = rp.phase;
      action = rp.action;
      target = rp.target;
      context = rp.context;
      tool = rp.tool || '';
      prompt = rp.prompt || '';
    }
  }

  // 完成标记：reporter 仅在 Stop 时落盘（按工程 + 客户端区分），是"任务完成"的唯一真源；
  // 比"相位回落到空闲"可靠——任务中途因轮询间隙 / 跨工程串味出现空闲，绝不冒充完成。
  const done = readReporterDone(workspacePath, client) || null;
  const doneAt = done ? done.at : 0;
  const doneTitle = done ? done.title || '' : '';
  // 只挑"本轮任务开始之后"改过的文件：file-changes 是整个会话累积的，
  // 不筛会把上一轮（甚至更早）的改动当成"本次完成"——典型：这一轮只是 push，却显示上一轮改了多少文件。
  // done.startedAt 缺省（老数据）时不过滤，退回原来的"取最近几个"。
  const doneStartedAt = done ? Number(done.startedAt) || 0 : 0;
  const doneAll = done && done.cancelled
    ? [] // 被打断的那一轮常常什么都没改：不把整轮会话的文件改动算成"本次完成"
    : (done
      ? (Array.isArray(files.recent) ? files.recent.filter((f) => !doneStartedAt || Number(f.at) >= doneStartedAt) : [])
      : []);

  return {
    id,
    current,
    active,
    listed,
    // 有 runtime 说明插件还认这个会话；没有就是历史会话（只剩待办/改动的化石）
    live: Boolean(mq.hasRuntime),
    lastUpdated,
    runtime: mq.runtime,
    pending: mq.pending,
    todos: { total: todos.total, done: todos.done, doing: todos.doing, items: todos.items },
    files: { count: files.count, recent: files.recent, lastAt: files.lastAt || null },
    phase,
    action,
    target,
    tool,
    context,
    prompt,
    doneAt,
    doneTitle,
    doneCount: doneAll.length, // 本轮任务改动的文件数（在切片之前算）
    doneFiles: doneAll.slice(0, 6),
    // 这一轮是被打断收掉的（reporter 在 Interrupt 时落的 done.cancelled）：
    // 渲染层据此亮红色「任务取消」，不亮「任务完成」。
    doneCancelled: Boolean(done && done.cancelled),
    inferred: !reported, // 上报真值（reporter hook）不算推断
  };
}

/* ------------------------------ 对外：列会话 ------------------------------ */

/**
 * genie-history 下每个 base64 目录 = 一个工程（目录名解出来就是工程绝对路径）。
 * @returns {Array<{dir: string, path: string, project: string}>}
 */
function collectProjects(storage) {
  const gh = path.join(storage, 'genie-history');
  const out = [];
  for (const name of readDir(gh)) {
    const dir = path.join(gh, name);
    if (!isDir(dir)) continue;
    const ws = decodeDirName(name);
    if (!ws) continue;
    out.push({ dir, path: ws, project: resolveProjectName(ws) || path.basename(ws) });
  }
  return out;
}

/**
 * 列出**所有工程**里的活跃会话（不局限于当前打开的那个工程）。
 * @param {{workspacePath?: string, force?: boolean, client?: string, pluginRe?: RegExp[]}} o
 * @returns {{ok: true, sessions: Array, current: string, workspacePath: string,
 *            storage: string, reason?: string}}
 *   reason: 'no-storage' 没找到插件落盘 / 'no-open-project' 一个活跃会话都没有
 */
function listSessions({ workspacePath = '', force = false, client = '', pluginRe = PLUGIN_RE } = {}) {
  // 会话归属用的"当前工程"跟随 reporter 真实活动的最新工程，
  // 而不是 office 手工"打开工程"记的那个（IDE 里直接开新工程时两者会脱节）。
  // 只认传入的 client 这一路：这份清单属于某个插件楼层，别层（其它产品 / 同一产品的 CLI）
  // 在别的工程里活动不该决定这一层的"当前工程" —— 否则 mine / current / fresh 全被带偏。
  const ws = freshestReporterWs(workspacePath, client);
  const now = Date.now();
  // 缓存键必须覆盖 client / pluginRe / 工程，否则同一工程里的不同插件楼层、或 CLI/Plugin 视图
  // 会复用上一次的旧结果（例如 A5 里 plugin 那路读到先前写入的窗口值、误以为还在全局表里）。
  const key = `${client}@@${ws}@@${String(pluginRe instanceof RegExp ? pluginRe.source : Array.isArray(pluginRe) ? pluginRe.map((r) => (r && r.source) || String(r)).join('|') : String(pluginRe || ''))}`;
  if (!force && cache.value && cache.key === key && now - cache.at < TTL) return cache.value;

  const storage = findPluginStorage(pluginRe);
  if (!storage) {
    cache = {
      at: now,
      key,
      value: { ok: true, sessions: [], current: '', workspacePath: ws, storage: '', reason: 'no-storage' },
    };
    return cache.value;
  }

  /** 会话 id -> 归属（工程名 / 工程路径）。每个工程自己的"当前会话"单独记，
   *  不做成全局唯一 —— 这样多工程时每条工程里的活跃会话都能拿到自己 reporter 的实时相位，
   *  主控制台跟随下拉选中的那条，不再被全局"最后一个 reporter"覆盖。 */
  const meta = new Map();
  const perProjectCurrent = new Map(); // 工程路径 -> 该工程 current.json 指向的会话 id
  let currentId = '';
  for (const p of collectProjects(storage)) {
    const cur = readJson(path.join(p.dir, 'current.json')) || {};
    const cid = cur && cur.conversationId ? String(cur.conversationId) : '';
    if (cid) {
      perProjectCurrent.set(p.path, cid);
      // 全局唯一的"当前会话"仍认真实活动工程（ws）里那条，用于默认选中 / 高亮
      if (p.path === ws) currentId = currentId || cid;
    }
    for (const id of readDir(path.join(p.dir, 'conversations'))) {
      if (id) meta.set(id, { project: p.project, projectPath: p.path });
    }
    if (cid && !meta.has(cid)) meta.set(cid, { project: p.project, projectPath: p.path });
  }

  // GitHub Copilot 这类真实插件落盘用 SQLite `session-store.db`，不是 `genie-history`：
  // 这里单独把它们并进同一张会话表，否则 9F 永远会被旧的 Tencent 目录吞掉、UI 不点亮。
  const sqliteSessions = readSqliteSessionRows(storage);
  const sqliteById = new Map();
  for (const row of sqliteSessions) {
    if (!row || !row.id) continue;
    sqliteById.set(row.id, row);
    meta.set(row.id, { project: row.project, projectPath: row.projectPath });
    if (row.projectPath && row.projectPath === ws) currentId = currentId || row.id;
  }

  // 兜底：插件新版可能不写 genie-history，会话只在 todos / 消息队列里露过头。
  // 这类会话没有工程归属（project 留空），但它是"正在跑的那个"，不列出来更糟。
  for (const name of readDir(path.join(storage, 'todos'))) {
    const id = name.replace(/\.json$/i, '');
    if (id && !meta.has(id)) meta.set(id, { project: '', projectPath: '' });
  }

  const sessions = [];
  for (const [id, m] of meta) {
    const sqliteRow = sqliteById.get(id);
    const isProjectCurrent = id === (perProjectCurrent.get(m.projectPath) || '');
    // Copilot 没有 reporter hook，readReporterActiveTask 恒为空，相位只能推断（inferred）：
    //   ① 有 VS Code chat 索引的「这一轮在不在飞」→ 直接听它（跑着就是 thinking，收工就是 idle），
    //      这是唯一能看见"轮进行中"的旁证，见 readCopilotChatIndex；
    //   ② 没有旁证（老版本 / 库被占用）才退回 updated_at 的 COPILOT_PHASE_MS(2 分钟)窗口。
    // hasPendingTurn（空 assistant_response 的 turn）不单独使用 —— Copilot 是批次写入，
    // 放弃/取消的 turn 也留空 response，2 分钟外的空 turn 是已废弃不是正在跑。
    const reporterInWindow = readReporterActiveTask(m.projectPath, client);
    const inWindow = sqliteRow
      ? (reporterInWindow || copilotInWindow(sqliteRow, now))
      : reporterInWindow;
    const inFlight = sqliteRow ? copilotInFlight(sqliteRow) : null;
    const info = sqliteRow
      ? {
          id,
          current: Boolean(isProjectCurrent || (sqliteRow.projectPath && sqliteRow.projectPath === ws)),
          active: Boolean(sqliteRow.lastUpdated && now - sqliteRow.lastUpdated < IDLE_MS),
          listed: Boolean(sqliteRow.lastUpdated && now - sqliteRow.lastUpdated < LISTED_MS),
          live: true,
          lastUpdated: sqliteRow.lastUpdated || 0,
          runtime: { activated: true, paused: false, awaitingSessionIdle: false },
          pending: 0,
          todos: { total: 0, done: 0, doing: '', items: [] },
          // Copilot 的 session_files 表给出本轮碰过的文件路径 + 工具名；有就带上，
          // 没有回空列表（老版本 Copilot 可能没这张表 —— readCopilotFiles 已兜底回空）。
          files: { count: (sqliteRow.files || []).length, recent: sqliteRow.files || [], lastAt: sqliteRow.lastUpdated || null },
          phase: inWindow ? 'thinking' : 'idle',
          action: '',
          target: '',
          tool: '',
          context: [],
          // 「思考中」屏上那句话：正在飞的那一轮用 VS Code 会话日志里的用户原话（最新），
          // 否则退回 Copilot 的 turns 表里最后一条 user_message；summary（sessions 表）
          // 是 Copilot 自己取的会话标题 —— 都带上，渲染层按它的规则择优展示。
          prompt: (inFlight && sqliteRow.live && sqliteRow.live.prompt) || sqliteRow.lastUserMessage || '',
          // 「任务完成」标记：9F 没有 hook，完成时刻只能从会话日志取（最新那一轮 request 的
          // completedAt）—— 与 7F/8F 的 read*Done 同口径，超 DONE_TTL_MS 就算过期（不弹）。
          doneAt: copilotDoneAt(sqliteRow, now),
          doneTitle: sqliteRow.summary || '',
          doneCount: sqliteRow.turnCount || 0,
          doneFiles: [],
          // 9F 没有 hook，拿不到"打断"信号 → 一律按正常完成显示，不猜取消
          doneCancelled: false,
          inferred: true,
          hasPendingTurn: sqliteRow.hasPendingTurn || false,
          // 「这一轮在不在飞」：true / false / null（没旁证）。台账同步器（copilotTasks.js）
          // 靠它决定这条会话的任务是"运行中"还是"已完成"，比时间窗准。
          inFlight,
          /** 正在飞的那一轮：用户原话 + 起始时间 + 轮序号（台账按轮记账用） */
          livePrompt: (sqliteRow.live && sqliteRow.live.prompt) || '',
          liveStartedAt: (sqliteRow.live && sqliteRow.live.startedAt) || 0,
          liveIndex: sqliteRow.live ? sqliteRow.live.index : null,
          /** 最近几轮各自的起止时间（会话日志里的 completedAt - elapsedMs） */
          liveReqs: (sqliteRow.live && sqliteRow.live.reqs) || [],
          /** 最近几轮各自**改动过的文件**（会话日志里写工具碰过的；read_file 不算） */
          liveChanged: (sqliteRow.live && sqliteRow.live.changed) || [],
          /** 逐轮清单（turns 表）：任务台账「每一轮一条」用 */
          copilotTurns: sqliteRow.turns || [],
        }
      : sessionInfo(storage, id, {
          current: isProjectCurrent,
          now,
          workspacePath: m.projectPath,
          inWindow,
          client,
        });
    if (!info.listed) continue;
    sessions.push({
      ...info,
      project: m.project,
      projectPath: m.projectPath,
      mine: Boolean(ws) && m.projectPath === ws,
    });
  }
  sessions.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });

  cache = {
    at: now,
    key,
    value: {
      ok: true,
      sessions,
      current: currentId,
      workspacePath: ws,
      storage,
      ...(sessions.length ? {} : { reason: 'no-open-project' }),
    },
  };
  return cache.value;
}

/**
 * Copilot 当前选中的模型。从 VS Code 的 state.vscdb 里读 `chat.currentLanguageModel.editor`，
 * 值形如 `copilot/gpt-5-mini`；再用 `chat.cachedLanguageModels` 查展示名（如 "GPT-5 mini"）。
 * 取不到返回空串 —— 不猜。
 *
 * 和 TraeCode 的 traeModels.selectedModelOf 同理：模型存在 globalStorage 的 state.vscdb 里，
 * Copilot 自己的 session-store.db 不记模型。
 */
const COPILOT_MODEL_CACHE_TTL = 15_000;
let copilotModelCache = { at: 0, value: '' };

function copilotCurrentModel() {
  const now = Date.now();
  if (copilotModelCache.value && now - copilotModelCache.at < COPILOT_MODEL_CACHE_TTL) {
    return copilotModelCache.value;
  }
  const storage = findPluginStorage([/github\.copilot/i, /github-copilot/i, /^copilot/i]);
  if (!storage) {
    copilotModelCache = { at: now, value: '' };
    return '';
  }
  // state.vscdb 在 globalStorage 根下（Copilot 的 plugin storage 是它的子目录）
  const dbFile = path.join(path.dirname(storage), 'state.vscdb');
  let db = null;
  try {
    if (!fs.existsSync(dbFile)) {
      copilotModelCache = { at: now, value: '' };
      return '';
    }
    const Database = require('better-sqlite3');
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    // 当前选中的模型标识（如 "copilot/gpt-5-mini"）
    const row = db.prepare("select value from ItemTable where key = 'chat.currentLanguageModel.editor'").get();
    const identifier = row ? String(row.value || '').trim() : '';
    if (!identifier) {
      copilotModelCache = { at: now, value: '' };
      return '';
    }
    // 从 cachedLanguageModels 查展示名（如 "GPT-5 mini"）
    const cached = db.prepare("select value from ItemTable where key = 'chat.cachedLanguageModels'").get();
    if (cached && cached.value) {
      const models = JSON.parse(String(cached.value));
      if (Array.isArray(models)) {
        const match = models.find((m) => m && m.identifier === identifier);
        if (match && match.metadata && match.metadata.name) {
          const name = String(match.metadata.name);
          copilotModelCache = { at: now, value: name };
          return name;
        }
      }
    }
    // 查不到展示名就用标识符去掉 vendor 前缀（"copilot/gpt-5-mini" → "gpt-5-mini"）
    const fallback = identifier.replace(/^[^/]+\//, '');
    copilotModelCache = { at: now, value: fallback };
    return fallback;
  } catch {
    copilotModelCache = { at: now, value: '' };
    return '';
  } finally {
    if (db) {
      try { db.close(); } catch { /* 关不掉不影响读取 */ }
    }
  }
}

module.exports = {
  hasReporterState,
  reporterStateMeta,
  // 成员状态降级前的守卫：这条会话停了，同产品的别的会话还在跑吗（见函数说明）
  hasOtherLiveSession,
  readReporterDone,   // 完成标记（含 Codex 的收尾自述）：CLI 楼层靠它亮「任务完成」
  readReporterDones,  // 同上，但一次取回该 (工程, 客户端) 下所有会话的 —— 会话表扫盘用
  listReporterSessions, // 会话只能靠 hook 的楼层（5F TraeCode）与合并楼层的 hook 那一路（1F CodeBuddy CLI）
  readCopilotDone,    // 9F 的完成标记（没有 hook，从 VS Code 会话日志取）
  sessionModel,       // 这条会话在用什么模型（TraeCode 从 globalStorage 取，其余留空）
  copilotCurrentModel, // Copilot 当前选中的模型（从 VS Code state.vscdb 取）
  listSessions,
  findPluginStorage,
  decodeDirName,
  reporterMainPhase,
  freshestReporterWs,
  readReporterPhase, // 主控制台那口实时相位（打断后作废的逻辑在这里，回归测试直接盯它）
};
