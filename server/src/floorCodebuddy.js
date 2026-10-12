'use strict';

/**
 * 1F CodeBuddy（CLI 与 Plugin 合并楼层）。
 *
 * 这一层 = 同一个产品的两种形态合成一层（见 server/src/products.js 文件头）：
 *   cli    —— ~/.codebuddy 下的会话 jsonl（CLI 历史落盘）
 *   plugin —— 编辑器 globalStorage 里的结构化落盘（genie-history / todos / …）
 *   hook   —— reporter 状态文件（CLI 常常没有可扫的会话落盘时的唯一真值）
 * 三种标准来源（cli/plugin/hook）都由 sessionRegistry 的默认 handler 处理，
 * 本文件只声明元数据，不需要写 kindHandlers。新增/调整本楼层只改这个文件。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { diskKey } = require('@workgremlin/shared');
// globalStorage 根目录列表（插件落盘位置）收口在 roots.js，全仓库单一来源，避免各处各自写一份、还漏掉 macOS/Windows 平台目录
const { globalStorageRoots, readJson, readDir } = require('./roots');

const HOME = os.homedir();

/** 插件目录名匹配（仅 plugin 楼层需要）；findPluginDir 的默认正则也用它 */
const RE_PLUGIN = [/codebuddy/i, /tencent/i, /ingram/i, /code-?buddy/i];

/* ------------------------------ 取消检测 ------------------------------ */

/**
 * message-queue 文件缓存：path -> {m, size, data}
 * 按 mtime+size 增量，文件没变就不重读。
 */
const _pauseCancelCache = new Map();

/**
 * CodeBuddy 插件取消检测：从 message-queue 的 `pauseReason='cancel'` 读出取消时刻。
 *
 * 为什么需要这个：CodeBuddy 插件（IDE 扩展）取消任务时**一个 hook 事件都不发**
 * （CLI 那条 FinalStop 在 IDE 形态等不到 —— 扩展日志里只有 AgentState.cancelled，
 * 没有任何 HookExecutor），唯一权威信号在 message-queue 的 `runtime.pauseReason:'cancel'`。
 *
 * 只认 `pauseReason === 'cancel'` 且 `updatedAt ≥ 本轮开始`：`paused` 还有别的来源
 * （手工暂停 / 队列等待），拿 `paused` 当取消会误报；老时间戳也不能算到新一轮头上。
 * @param {string} sessionId
 * @param {number} sinceTs 本轮任务开始时刻（0 = 不过滤）
 * @returns {number} 取消时刻（0 = 没有 / 判不出）
 */
function codebuddyPauseCancelAt(sessionId, sinceTs = 0) {
  const sid = String(sessionId || '');
  if (!sid) return 0;
  let best = 0;
  for (const root of globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (!/coding-copilot|tencent|ingram|codebuddy/i.test(name)) continue;
      const dir = path.join(root, name, 'message-queue');
      for (const f of readDir(dir)) {
        if (!/\.json$/i.test(f)) continue;
        const p = path.join(dir, f);
        let stat = null;
        try {
          stat = fs.statSync(p);
        } catch {
          continue;
        }
        const cached = _pauseCancelCache.get(p);
        let data = cached && cached.m === stat.mtimeMs && cached.size === stat.size ? cached.data : null;
        if (!data) {
          data = readJson(p);
          _pauseCancelCache.set(p, { m: stat.mtimeMs, size: stat.size, data });
        }
        const conv = data && data.conversations ? data.conversations[sid] : null;
        const rt = (conv && conv.runtime) || null;
        if (!rt || !rt.paused) continue;
        if (String(rt.pauseReason || '').toLowerCase() !== 'cancel') continue;
        const at = Number(rt.updatedAt) || Number(conv.updatedAt) || 0;
        if (!at) continue;
        if (sinceTs && at < sinceTs) continue; // 老取消不能算到新一轮头上
        if (at > best) best = at;
      }
    }
  }
  return best;
}

/**
 * 扫所有 CodeBuddy 插件 message-queue，汇总"被用户取消"的会话 → `{ [sessionId]: 取消时刻 }`。
 * 与 codebuddyPauseCancelAt 同口径（globalStorageRoots → message-queue → mtime+size 缓存），
 * 但**不做 sinceTs 过滤、按会话聚合全部取消**（像 Trae 的 allCancels）—— 因为本函数服务于
 * readReporterDones 里**独立于 hook 状态文件**的取消扫描：取消时插件不重写状态文件、甚至把
 * taskId 清空，再拿 startedAt 去卡就认不出取消。渲染层用 phase.ts vs done.at 自行决断显示，
 * 这里只管"这一轮被取消了"，不需要 smart 过滤。
 *
 * 不做扁平 TTL 缓存：直接按文件 mtime+size 增量（走 _pauseCancelCache），每次重新聚合。
 * message-queue 文件极少（同一窗口几个），重新聚合很便宜；扁平缓存会让"刚写入的取消"最多
 * 延迟一个 TTL 才被识别，反而拖慢了取消亮红灯。
 */
function allCodebuddyCancels() {
  const merged = {};
  for (const root of globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (!/coding-copilot|tencent|ingram|codebuddy/i.test(name)) continue;
      const dir = path.join(root, name, 'message-queue');
      for (const f of readDir(dir)) {
        if (!/\.json$/i.test(f)) continue;
        const p = path.join(dir, f);
        let stat = null;
        try {
          stat = fs.statSync(p);
        } catch {
          continue;
        }
        const cached = _pauseCancelCache.get(p);
        let data = cached && cached.m === stat.mtimeMs && cached.size === stat.size ? cached.data : null;
        if (!data) {
          data = readJson(p);
          _pauseCancelCache.set(p, { m: stat.mtimeMs, size: stat.size, data });
        }
        const convs = data && data.conversations ? data.conversations : null;
        if (!convs) continue;
        for (const sid of Object.keys(convs)) {
          const c = convs[sid];
          const rt = c && c.runtime;
          if (!rt || !rt.paused) continue;
          if (String(rt.pauseReason || '').toLowerCase() !== 'cancel') continue;
          const at = Number(rt.updatedAt) || Number(c.updatedAt) || 0;
          if (!at) continue;
          if (!merged[sid] || at > merged[sid]) merged[sid] = at;
        }
      }
    }
  }
  return merged;
}

const meta = {
  id: '1F',
  name: 'CodeBuddy',
  kind: 'cli',
  cmd: 'codebuddy',
  agent: 'codebuddy',
  plugin: false,
  pluginRe: RE_PLUGIN,
  // 合并楼层：三路都归这一层；同一会话被两路同时看到时按 session_id 去重（见 sessionRegistry）。
  sources: ['cli', 'plugin', 'hook'],
  dataKind: 'codebuddy',
  // 落盘探测（findDataPath 用）：按名字匹配什么、家目录里哪些候选
  matchRe: [/^codebuddy/i, /^code-?buddy/i, /^tencent/i, /^ingram/i],
  homeDirs: [path.join(HOME, '.codebuddy'), path.join(HOME, '.codebuddy-cli')],
  // 这一层 CLI 自己的安装目录（PATH 查不到时兜底）；与具体产品无关的位置在 floors.js 的通用兜底里
  cliBinDirs: [path.join(HOME, '.codebuddy', 'bin')],
  // CLI 会话文件落在 <dataRoot>/projects/<工程>/ 下，文件名即 session_id
  // （老版本给的是 32 位十六进制无连字符，一并认）
  sessionSubtree: 'projects',
  sessionIdOfFile: (name) => {
    const stem = String(name).replace(/\.jsonl$/i, '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem) ||
      /^[0-9a-f]{32}$/i.test(stem)
      ? stem
      : '';
  },
};

/**
 * 这口"在跑"的 reporter 相位是否被本楼层的取消标记作废。
 * CodeBuddy 插件取消时一个 hook 事件都不发，相位冻在「思考中 / 调用工具」，只能靠
 * message-queue 的 pauseReason='cancel' 那刻来戳破（见 codebuddyPauseCancelAt）。
 * 供 sessions.js 的 readReporterPhase 派发调用。
 * @param {object} j hook 状态文件
 * @param {object} sp 状态文件里的 sessionPhase
 * @param {number} slack 相位时间戳容差（ms）
 */
function phaseSuperseded(j, sp, slack = 1_000) {
  const at = codebuddyPauseCancelAt(j.sessionId, Number(j.taskStartedAt) || 0);
  return !!at && at + slack >= Number(sp.ts || 0);
}

const { runHookEvent, sharedHookImpl, jsonlReplies, indexJsonReplies, turnInterrupted,
  normOpenAI, tokenFinish, readTokens,
  headJsonLines } = require('./ingest/hookCommon');

/* ============================== CodeBuddy 专属常量 ==============================
 * 跟着 codebuddyRequestTokens / codebuddyReadTokensOf 一起从 hookCommon 下沉到这里，
 * 只被本楼层消费，不再污染框架层。 */

const CB_REQ_GRACE_MS = 5_000;
const CB_FLUSH_WAIT_MS = 1_200;
const CB_FLUSH_STEP_MS = 120;

/* ============================== CodeBuddy Plugin index.json token 解析 ==============================
 * 从 hookCommon 下沉过来——这是 CodeBuddy 专属的 index.json usage 格式（CodeBuddy Plugin 自定的
 * inputTokens/cacheTokens/cachedWriteTokens/outputTokens），框架层不该硬编码它。 */

function codebuddyRequestTokens(indexPath, startedAt) {
  let idx;
  try { idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { return null; }
  const reqs = Array.isArray(idx && idx.requests) ? idx.requests : [];
  let best = null;
  for (const r of reqs) {
    if (!r || typeof r !== 'object') continue;
    const ts = Number(r.startedAt);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts < startedAt - CB_REQ_GRACE_MS || ts > startedAt + CB_REQ_GRACE_MS) continue;
    if (!best || ts > Number(best.startedAt)) best = r;
  }
  if (!best) return null;
  const u = best.usage;
  if (!u || typeof u !== 'object') return null;
  return normOpenAI({
    prompt_tokens: u.inputTokens,
    prompt_cache_hit_tokens: u.cacheTokens,
    prompt_cache_write_tokens: u.cachedWriteTokens,
    completion_tokens: u.outputTokens,
  });
}

/* ============================== CodeBuddy transcript 路径推导 ==============================
 *
 * CodeBuddy 有三套独立落盘，hook 事件的 transcript_path 字段**经常缺失**（Plugin 形态
 * 几乎总不带，CLI trace 形态也有缺的情况）。框架层 tp() 默认只认事件 payload——
 * 所以让楼层 transcriptPathOf 覆盖来推导。
 *
 * 优先级：事件 payload > 会话状态缓存 > 三处候选位置按 sessionId/mtime 搜索。
 */

/** 从工程路径推 CodeBuddy CLI projects 下的 slug。
 *  ~/.codebuddy/projects/home-yinghui-work-WorkGremlin/<sessionId>.jsonl */
function slugForWs(ws) {
  const s = String(ws || '').trim();
  if (!s) return '';
  return s.replace(/^\/+/, '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/\/+$/, '');
}

/** 给定 sessionId + workspacePath，按优先级搜三处 CodeBuddy transcript 落盘。
 *  返回第一个存在的文件绝对路径；都没有返回空串。 */
function inferCodebuddyTranscript(sessionId, workspacePath) {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  const wsSlug = slugForWs(workspacePath);

  // 1. CLI projects jsonl —— ~/.codebuddy/projects/<ws-slug>/<sessionId>.jsonl
  if (wsSlug) {
    const p = path.join(HOME, '.codebuddy', 'projects', wsSlug, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }

  // 2. Plugin index.json —— ~/.local/share/CodeBuddyExtension/Data/**/history/<sessionId>/*/index.json
  //    history 目录名 == sessionId（见 ~/.local/share/CodeBuddyExtension/Data/<uuid>/VSCode/<uuid>/history/）
  const pluginRoot = path.join(HOME, '.local', 'share', 'CodeBuddyExtension');
  if (fs.existsSync(pluginRoot)) {
    // 找 history/<sessionId> 这个目录，再取它下面任意一个子目录的 index.json
    const dataDir = path.join(pluginRoot, 'Data');
    if (fs.existsSync(dataDir)) {
      for (const entry of fs.readdirSync(dataDir)) {
        const cand = path.join(dataDir, entry);
        if (!fs.statSync(cand).isDirectory()) continue;
        // 递归找 history/<sessionId> 目录
        const hit = findPluginHistoryIndex(cand, sid);
        if (hit) return hit;
      }
    }
  }

  // 3. CLI trace jsonl (OTel) —— ~/.codebuddy/traces/*/trace_*.jsonl
  //    trace 文件名里**不含 sessionId**，只能取 mtime 最近的那一个。
  //    这位置最不可靠（可能匹配到别的 session），放最后。
  const tracesDir = path.join(HOME, '.codebuddy', 'traces');
  if (fs.existsSync(tracesDir)) {
    let best = '';
    let bestMtime = 0;
    for (const sub of fs.readdirSync(tracesDir)) {
      const subDir = path.join(tracesDir, sub);
      try { if (!fs.statSync(subDir).isDirectory()) continue; } catch { continue; }
      for (const f of fs.readdirSync(subDir)) {
        if (!/^trace_.*\.jsonl$/i.test(f)) continue;
        const full = path.join(subDir, f);
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = full; }
        } catch { /* ignore */ }
      }
    }
    if (best) return best;
  }

  return '';
}

/** 在 CodeBuddy Plugin Data 下递归搜 history/<sessionId>，找到就返回子目录的 index.json 路径 */
function findPluginHistoryIndex(root, sessionId) {
  // 先看直接 history 目录
  const historyDir = path.join(root, 'history');
  if (fs.existsSync(historyDir)) {
    const sessionDir = path.join(historyDir, sessionId);
    if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
      // 取 session 目录下的 index.json（session 目录可能有多轮，每轮一个子目录）
      for (const sub of fs.readdirSync(sessionDir)) {
        const idx = path.join(sessionDir, sub, 'index.json');
        if (fs.existsSync(idx)) return idx;
      }
    }
  }
  // 递归下一级（VSCode/<uuid> 层）
  let found = '';
  try {
    for (const e of fs.readdirSync(root)) {
      const p = path.join(root, e);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        found = findPluginHistoryIndex(p, sessionId);
        if (found) return found;
      }
    }
  } catch { /* ignore permission */ }
  return found;
}

/* ============================== CodeBuddy trace jsonl (OTel) token 解析 ==============================
 *
 * CLI 新形态 trace jsonl 不是普通的 JSONL message 流，是 OpenTelemetry span 格式：
 *   {"type":"span_end","span":{"type":"generation","startedAt":"ISO","toolOutput":"[{\"usage\":{...}}]"}}
 * usage 在 toolOutput 字符串里，被 JSON 再包一层数组；usage 格式与 OpenAI 一致（prompt_tokens /
 * completion_tokens / prompt_tokens_details.cached_tokens）。
 */
function codebuddyTraceTokens(tracePath, startedAt) {
  const file = String(tracePath || '');
  if (!file || !(Number(startedAt) > 0)) return null;
  let rows;
  try { rows = fs.readFileSync(file, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return null; }
  if (!rows.length) return null;
  let acc = null;
  for (const o of rows) {
    if (o.type !== 'span_end') continue;
    const span = o.span;
    if (!span || span.type !== 'generation') continue;
    const ts = Date.parse(span.startedAt);
    if (!ts || ts < startedAt) continue;
    let toolOut; try { toolOut = JSON.parse(span.toolOutput); } catch { continue; }
    const first = Array.isArray(toolOut) ? toolOut[0] : toolOut;
    const u = first && first.usage;
    if (!u) continue;
    const part = normOpenAI({
      prompt_tokens: u.prompt_tokens,
      prompt_cache_hit_tokens: u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens,
      prompt_cache_write_tokens: u.prompt_cache_write_tokens,
      completion_tokens: u.completion_tokens,
    });
    if (!acc) acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    acc.input += part.input;
    acc.output += part.output;
    acc.cacheRead += part.cacheRead;
    acc.cacheWrite += part.cacheWrite;
  }
  return tokenFinish(acc);
}

/* ============================== CodeBuddy 三路 token 读取 ==============================
 *
 * 框架层 readTokensOf 默认实现只认"标准 JSONL 格式"（Codex rollout / Claude transcript）。
 * CodeBuddy 有三种格式，按文件后缀分支：
 *   · index.json → codebuddyRequestTokens（Plugin 落盘）
 *   · trace_*.jsonl → codebuddyTraceTokens（CLI OTel trace 形态）
 *   · 其余 jsonl → readTokens（projects 目录下老形态，走 requestSum 解析）
 *
 * 另外 CodeBuddy Plugin 的 index.json **比 Stop hook 事件晚 ~30-50ms 才落盘**，
 * 所以这里带一个"等落盘"的重试环（原 hookCommon.readTokensSettled 的职责）。
 */
async function codebuddyReadTokensOf(transcriptPath, startedAt) {
  const file = String(transcriptPath || '');
  if (!file || !(Number(startedAt) > 0)) return null;
  const t = codebuddyTryRead(file, startedAt);
  if (t) return t;
  // 只有 index.json 需要等落盘；其余 jsonl 格式 Stop 时刻之前已经写完了
  if (!/index\.json$/i.test(file)) return null;
  for (let waited = 0; waited < CB_FLUSH_WAIT_MS; waited += CB_FLUSH_STEP_MS) {
    await new Promise((r) => setTimeout(r, CB_FLUSH_STEP_MS));
    const t2 = codebuddyTryRead(file, startedAt);
    if (t2) return t2;
  }
  return null;
}

/** 同步版的三路分发（codebuddyReadTokensOf 内部也调它做首次尝试 + 重试） */
function codebuddyTryRead(file, startedAt) {
  if (/index\.json$/i.test(file)) return tokenFinish(codebuddyRequestTokens(file, Number(startedAt)));
  if (/trace_.*\.jsonl$/i.test(file)) return codebuddyTraceTokens(file, Number(startedAt));
  return readTokens(file, Number(startedAt));
}

/* ============================== CodeBuddy sessionId 推断 ==============================
 *
 * CodeBuddy CLI / Plugin 的 hook 事件里没有 session_id 字段（events.log 实锤全是 None）。
 * 需要服务端自己从 transcript 文件推 —— transcript 文件名/目录名就是 sessionId。
 *
 * 反向推导（没有 sessionId 时）：
 *   1. CLI projects 目录（最可靠）：~/.codebuddy/projects/<ws-slug>/<sid>.jsonl
 *      取 mtime 最新的 .jsonl => basename
 *   2. Plugin history 目录:
 *      ~/.local/share/CodeBuddyExtension/Data/<uuid>/<ver>/history/<sid>/
 *      取 mtime 最新的 history/<sid> 目录 => sid
 *
 * 并发安全：用模块级 Map 缓存 workspacePath -> 最近 sessionId。
 * SessionStart 事件更新缓存，后续事件直接复用，避免并发误匹配。
 */

/** ws-slug 缓存（diskKey 比较贵，只算一次） */
const _wsSlugCache = new Map();
function slugForWs(workspacePath) {
  const ws = String(workspacePath || '').trim();
  if (!ws) return '';
  const hit = _wsSlugCache.get(ws);
  if (hit != null) return hit;
  const s = (typeof diskKey === 'function' ? diskKey(ws) : '') || '';
  _wsSlugCache.set(ws, s);
  return s;
}

/** 活跃会话缓存：workspacePath → sessionId（最近一次 SessionStart 推出来的） */
const _activeSessionCache = new Map();

/** 从 workspacePath 推 CodeBuddy 当前活跃会话的 sessionId */
function inferCodebuddySessionId(workspacePath) {
  const ws = String(workspacePath || '').trim();

  // 0. 缓存命中（同 workspace 下 SessionStart 已推过）
  if (ws && _activeSessionCache.has(ws)) {
    const cached = _activeSessionCache.get(ws);
    if (cached) return cached;
  }

  const wsSlug = slugForWs(ws);

  // 1. CLI projects —— 最可靠：文件名就是 sessionId
  if (wsSlug) {
    const dir = path.join(HOME, '.codebuddy', 'projects', wsSlug);
    if (fs.existsSync(dir)) {
      let best = '';
      let bestMtime = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl') || f.startsWith('.')) continue;
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs;
            best = f.replace(/\.jsonl$/i, '');
          }
        } catch { /* ignore */ }
      }
      if (best) {
        if (ws) _activeSessionCache.set(ws, best);
        return best;
      }
    }
  }

  // 2. Plugin history —— 目录名就是 sessionId
  const pluginRoot = path.join(HOME, '.local', 'share', 'CodeBuddyExtension', 'Data');
  if (fs.existsSync(pluginRoot)) {
    let best = '';
    let bestMtime = 0;
    for (const entry of fs.readdirSync(pluginRoot)) {
      const cand = path.join(pluginRoot, entry);
      try { if (!fs.statSync(cand).isDirectory()) continue; } catch { continue; }
      // 找 history/<uuid>/ 目录
      for (const sub of fs.readdirSync(cand)) {
        const historyDir = path.join(cand, sub, 'history');
        if (!fs.existsSync(historyDir)) continue;
        try {
          if (!fs.statSync(historyDir).isDirectory()) continue;
          for (const histEntry of fs.readdirSync(historyDir)) {
            const histFull = path.join(historyDir, histEntry);
            try {
              const st = fs.statSync(histFull);
              if (!st.isDirectory()) continue;
              if (st.mtimeMs > bestMtime) {
                bestMtime = st.mtimeMs;
                best = histEntry; // 目录名 = sessionId
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
    if (best) {
      if (ws) _activeSessionCache.set(ws, best);
      return best;
    }
  }

  return '';
}

/** CodeBuddy CLI 的 transcriptPathOf 覆盖：事件 payload > 状态缓存 > 三处候选位置推导 */
function codebuddyTranscriptPathOf(ev, st, sessionId, workspacePath) {
  if (ev && ev.transcript_path) return String(ev.transcript_path);
  if (st && st.transcriptPath) return String(st.transcriptPath);
  return inferCodebuddyTranscript(sessionId, workspacePath);
}

/** CodeBuddy 的落盘差异：事件开关与文件/token/ghost 等公共逻辑全在 hookCommon.runHookEvent。
 * 只覆盖与公有默认不同的接口；其余回退 sharedHookImpl。 */
const codebuddyImpl = {
  ...sharedHookImpl,
  // hasSubagentStart 必须回退 sharedHookImpl 的 false：CodeBuddy 发 0 次 SubagentStart（events.log 实锤），
  // 只有 SubagentStop。PreToolUse 等 pendingSpawn 认领永远等不到 → addGhost 永远被跳过。
  // 走 !hasSubagentStart 分支：PreToolUse(Task/Agent) 直接 addGhost，PostToolUse / SubagentStop 各自 finishGhostServer。
  // 重构 commit 9d0a11c 本来就是 false，后来 07dec75 误改成 true（注释编造了"插件发 SubagentStart"）——这是回归。
  awaitingPermission: () => true, // 非 idle 的 Notification 一律视为"等授权"
  repliesOf: (tp) => (/index\.json$/i.test(tp) ? indexJsonReplies(tp) : jsonlReplies(tp)),
  interruptedSince: (tp, since) => turnInterrupted(tp, since),
  // 新增接口覆盖：transcript 路径推导 + 三路 token 解析
  transcriptPathOf: codebuddyTranscriptPathOf,
  readTokensOf: codebuddyReadTokensOf,
};

async function handleHookEvent(ev, ctx) {
  // CodeBuddy CLI/Plugin hook 事件里没有 session_id —— 从 transcript 文件推
  if (!String((ev && ev.session_id) || '').trim()) {
    const ws = String((ctx && ctx.workspacePath) || (ev && ev.cwd) || '').trim();
    const sid = inferCodebuddySessionId(ws);
    if (sid) ev.session_id = sid;
  }
  return runHookEvent(ev, ctx, codebuddyImpl);
}

module.exports = {
  id: '1F',
  meta,
  // 供 findPluginDir / findPluginStorageDir 默认正则复用
  RE_PLUGIN,
  // 取消检测（统一模块组接口：cancelAt / allCancels，与 trae 同签名）
  cancelAt: codebuddyPauseCancelAt,
  phaseSuperseded,
  allCancels: allCodebuddyCancels,
  // 完成/取消标记合成：交给 readReporterDones 统一派发（sessions.js 公共代码不掺 CodeBuddy 专属逻辑）
  synthMarks,
  // 服务端 hook 事件处理（落盘解析归服务端）
  handleHookEvent,
};

/**
 * 楼层特有的"取消"标记合成，由 sessions.js 的 readReporterDones 统一派发。
 *
 * CodeBuddy **插件**（IDE 扩展）取消时**一个 hook 事件都不发**（CLI 那条 FinalStop 在 IDE 形态等不到，
 * 扩展日志里只有 AgentState.cancelled，没有任何 HookExecutor），唯一权威信号在 message-queue 的
 * `runtime.pauseReason:'cancel'`（会话 id 与 hook 状态文件 sessionId 一字不差，见 allCodebuddyCancels）。
 *
 * 为什么独立扫、不绑在 hook 状态文件的 `if (j.taskId)` 上：
 *   · 取消时状态文件的 taskId 会被**新一轮覆盖 / 清空**，绑在 taskId 上的探测就再也认不出这口取消，
 *     主控制台红灯灭、台账也补不上。所以像 Trae 一样独立扫，只认"会话 id + 取消落盘"。
 *   · 渲染层用 "phase.ts vs done.at 谁更新" 决定显示，done.at 旧但 phase.ts 新 → 新一轮覆盖 cancelled，
 *     不会误亮红灯，所以无需 smart 过滤。
 *
 * @param {object} ctx
 *   { workspacePath, client, hookBySid, clientHit, roundFilesOf, synthCancel, bySession }
 */
function synthMarks(_ctx) {
  // CodeBuddy 的 message-queue 里 runtime.pauseReason='cancel' 不可靠：
  // CodeBuddy 内部超时（agent 长时间无响应）也会写 pauseReason=cancel，
  // 但任务实际还在跑（用户没取消）。这导致假取消被合成 → 任务被误标 cancelled。
  // 停止检测改回只认 hook 事件的 Stop/Interrupt 信号（CodeBuddy Plugin 不发 Stop，
  // 所以任务会保持 running 直到超时或被新一轮顶掉——这比假取消更正确）。
  return;
  /* 以下旧逻辑保留备查，但不再执行：
  const { workspacePath, client, hookBySid, clientHit, roundFilesOf, synthCancel, bySession } = ctx;
  const cbCancels = allCodebuddyCancels();
  const cbSids = Object.keys(cbCancels || {});
  if (!cbSids.length) return;
  for (const sid of cbSids) {
    const atC = Number(cbCancels[sid]) || 0;
    if (!atC) continue;
    const existing = bySession.get(sid);
    if (existing && existing.cancelled && Math.abs(Number(existing.at) - atC) < 5_000) continue;
    const hook = hookBySid.get(sid);
    const j = hook ? hook.j : null;
    const sinceTs = j ? Number(j.taskStartedAt) || 0 : 0;
    if (sinceTs && atC < sinceTs) continue;
    const hookWs = j ? ((j.done && j.done.workspacePath) || j.taskWorkspacePath || '') : '';
    if (workspacePath && hookWs && path.resolve(hookWs) !== path.resolve(workspacePath)) continue;
    if (j && client && !clientHit(client, j.client)) continue;
    synthCancel({
      id: sid,
      j: j ? { taskTitle: j.taskTitle || '', client: j.client } : { taskTitle: '', client: 'codebuddy' },
      ws: hookWs || workspacePath || '',
      at: atC,
      files: j ? roundFilesOf(j) : [],
    });
  }
  */
}
