'use strict';

/**
 * 4F Claude Code（CLI 与 IDE 合并楼层）。
 *
 * CLI 与 IDE 插件共用同一份 ~/.claude 配置、同一套 hook、同一个落盘目录，分不出来，
 * 合并成单楼层（见 server/src/products.js 文件头）。只有一路 cli 来源（CLI/Plugin 两形态都由它代表）。
 * 标准来源由 sessionRegistry 默认 handler 处理，本文件只声明元数据。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { clientBase } = require('@workgremlin/shared');

const HOME = os.homedir();

/**
 * Claude Code 的配置根 —— 配置、hook（settings.json）与会话落盘（projects/）都在它下面。
 * 认 CLAUDE_CONFIG_DIR（装 hook 那头早认了，找落盘这一头也得认，否则 ~/.claude 写死会偏）。
 * 这是 4F 自己私有的目录知识，放在本文件而非中央模块。
 */
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
}

/* ------------------------------ 打断检测 ------------------------------ */

/** transcript 尾部读取窗口：打断标记永远写在末尾，长会话不必整份读 */
const TRANSCRIPT_TAIL_BYTES = 128 * 1024;

/**
 * transcript 文件缓存：path -> {m, size, sinceTs, res}
 * 按 mtime+size+sinceTs 增量，文件没变就不重读。
 */
const _claudeTailCache = new Map();

/**
 * 判断文件是否存在
 */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 读目录（容错）
 */
function readDir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * 读 JSON 文件（容错）
 */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
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
 * @param {string} transcriptPath
 * @param {number} sinceTs 本轮任务开始时刻（0 = 不过滤）：只认这一轮落的标记，老一轮的不算
 * @returns {{interrupted:boolean, said:string, at:number}}
 */
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

/** 开轮宽限期：刚提交那一瞬 CLI 可能还写着 idle，不设宽限会把正常一轮误判成取消 */
const CLAUDE_IDLE_GRACE_MS = 3_000;

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

/* ------------------------------ 当前模型（selectedModelOf） ------------------------------ */

/**
 * Claude Code 的「会话 → 当前模型」补全。
 *
 * 为什么放本文件（而不是单开一个 claudeModels.js）：跟 trae.js 同构 —— 这段是"某个产品的私有
 * 落盘格式怎么读"，而它读的正好是 claude.js 里打断检测也读的同一份 transcript
 * （`<claudeHome>/projects/<slug>/<session>.jsonl`），放一起最顺；单开文件反而把同一格式的解析
 * 劈成两半。
 *
 * 为什么必须从落盘捞：**Claude Code 的 hook payload 里没有模型字段**。反编译 CLI 二进制的
 * payload schema 实测：UserPromptSubmit 只有 prompt / source / session_title，PreToolUse /
 * PostToolUse 只有工具字段；公共前缀是 session_id / transcript_path / cwd / permission_mode /
 * prompt_id / agent_id / agent_type / effort —— 都没有 model。只有 SessionStart 带一个可选的
 * model，那也拿不到"每轮用的是哪个模型"。所以 reporter 上报的 model 对 Claude 结构性地永远是
 * 空串（见 packages/reporter/src/hook.js），填这一列只能服务端读 transcript 自己补。
 *
 * 真值在哪：`<claudeHome>/projects/<工程 slug>/<session_id>.jsonl`，每一条 assistant 行都带
 * `message.model`（实测形如 `deepseek-flash`）。取最后一条，即「本回合开始时生效的模型」。
 *
 * 取不到（没装 / 没这个会话 / 一条 assistant 都还没有）一律返回空串 —— 不拿默认模型冒充
 * （这条会话还没回复过就说"不知道"，不说成"用的是默认模型"）。
 */

/** 尾部窗口起步 64KB，找不到翻 4 倍；封顶 1MB（本机实测最长行 117KB，1MB 足够兜住） */
const TAIL_START = 64 * 1024;
const TAIL_MAX = 1024 * 1024;

/** projects 下的一层工程目录：别每次调用都 readdir */
const DIR_TTL_MS = 30_000;
let dirCache = { at: 0, dirs: null };

/** 会话 -> 模型：热路径（UI 1.5s 轮询 → readReporterPhase，而它自己没有缓存）全靠这条缓存 */
const MODEL_TTL_MS = 15_000;
const CACHE_MAX = 200;
const modelCache = new Map();

/**
 * 会话 id 能不能当文件名用。
 * 它从 HTTP 的 `?session=` 与 hook payload 来，是**外部输入**：不校验的话 `../../` 能穿出
 * projects 目录去读任意文件。真值实测是 UUID，这里只认保守字符集。
 */
function safeSessionId(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s || s.length > 128) return '';
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return '';
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : '';
}

/** `<claudeHome>/projects` 下的一层工程目录 */
function projectDirs() {
  const now = Date.now();
  if (dirCache.dirs && now - dirCache.at < DIR_TTL_MS) return dirCache.dirs;
  const root = path.join(claudeHome(), 'projects');
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    // 没装 / 没跑过：这轮当没有，上层留空
  }
  dirCache = { at: now, dirs };
  return dirs;
}

/**
 * 这条会话的 transcript 绝对路径；找不到回空串。
 * 会话 id 就是文件名（products.js 文件头：三处实测 100% 一致），所以只需在工程目录里找同名文件。
 */
function transcriptOf(sessionId) {
  const name = `${sessionId}.jsonl`;
  for (const d of projectDirs()) {
    const p = path.join(d, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // 这个工程目录里没有这条会话，接着看下一个
    }
  }
  return '';
}

/**
 * 从文件尾部往前找出"最后一条 assistant 的 model"。
 *
 * 为什么要反读而不是顺序读：transcript 动辄几百 KB ~ 几十 MB，而这个函数在轮询热路径上。
 * assistant 行密，尾巴上 64KB 基本一定捞得到；只在遇到超长行时翻倍升窗口，且封顶不整文件读
 * （cwdOfHead 是它的镜像，理由同 —— 见 sessionRegistry.js）。
 *
 * 这里是"整窗解码 + 倒序逐行 parse"，不是"倒着分块拼接"：整窗一次读，窗口起点若不在文件头
 * 就丢掉第一个换行之前的残段 —— 被多字节字符截断的只可能是那段残段，所以解码后每一行都是
 * 完整的（0x0a 不会出现在多字节序列内部）。
 *
 * @param {string} file transcript 路径
 * @returns {{model: string, mtimeMs: number, size: number}|null} 打不开回 null
 */
function tailModel(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    // 用 fstat 而不是 statSync：拿到的是**这个 fd 上**的大小/时间，跟下面按位置读的是同一个
    // inode。改名轮转时 fd 仍指着一致（哪怕已过期）的那份；被截断则会读到 n <= 0。
    const st = fs.fstatSync(fd);
    const size = st.size;
    if (!size) return { model: '', mtimeMs: st.mtimeMs, size };
    for (let win = TAIL_START; win <= TAIL_MAX; win *= 4) {
      const start = Math.max(0, size - win);
      const len = size - start;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, start);
      // 该读到 len 个字节却读少了 = 文件正在被截断 / 轮转：宁可说不认识，也不拿半截去 parse
      if (n < len) return { model: '', mtimeMs: st.mtimeMs, size };
      let text = buf.toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line) continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          // 截断 / 正在写入的半行 / 非 JSON：跳过接着往前找（不拿正则救，那可能从 tool_result
          // 里捞出个假的 model 来）
          continue;
        }
        if (!j || j.type !== 'assistant') continue;
        // 子代理的回合（老格式会内联在父文件里）不是这条会话的模型，跳过
        if (j.isSidechain === true) continue;
        const m = j.message && j.message.model;
        if (typeof m === 'string' && m.trim()) return { model: m.trim(), mtimeMs: st.mtimeMs, size };
      }
      if (start === 0) break; // 已读到文件头，没有就是没有
    }
    return { model: '', mtimeMs: st.mtimeMs, size };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 关不掉不影响已经读到的内容 */
    }
  }
}

/**
 * 这条 Claude Code 会话在用什么模型。
 * @param {string} sessionId hook payload 的 session_id（也是 transcript 的文件名）
 * @param {string} [_agentType] 为了和 trae.selectedModelOf 同签名；Claude 用不上
 * @returns {string} 取不到返回空串
 */
function selectedModelOf(sessionId, _agentType = '') {
  const sid = safeSessionId(sessionId);
  if (!sid) return '';
  const now = Date.now();

  // 缓存优先：命中就直接 stat 上一次那个文件，**不做目录扫描**（有几十个工程的用户
  // 一次扫描要 stat 几十个目录，比真正读尾巴还贵）。文件没动过连读都不读。
  const hit = modelCache.get(sid);
  if (hit && now - hit.at < MODEL_TTL_MS) {
    if (!hit.file) return ''; // 上次就没找到这条会话 —— 短期内不反复扫盘
    try {
      const st = fs.statSync(hit.file);
      if (st.mtimeMs === hit.mtimeMs && st.size === hit.size) return hit.model;
    } catch {
      // 文件没了：往下重新找一次（可能换了工程目录），找不到就把空结果也缓存住
    }
  }

  const file = transcriptOf(sid);
  const r = file ? tailModel(file) : null;
  if (modelCache.size >= CACHE_MAX) modelCache.clear();
  modelCache.set(sid, {
    file: r ? file : '',
    mtimeMs: r ? r.mtimeMs : 0,
    size: r ? r.size : 0,
    model: r ? r.model : '',
    at: now,
  });
  return r ? r.model : '';
}

/** Claude Code 的 VS Code 扩展目录名：anthropic.claude-code-<版本> */
const RE_CLAUDE_HOST = [/^anthropic\.claude/i];

const meta = {
  id: '4F',
  name: 'Claude Code',
  kind: 'cli',
  cmd: 'claude',
  agent: 'claude',
  plugin: false,
  // 只装 IDE 扩展的人这一层照样"装了"，altPluginRe 补抓安装证据。
  altPluginRe: RE_CLAUDE_HOST,
  sources: [{ kind: 'cli', label: 'CLI/Plugin' }],
  dataKind: clientBase('claude', false),
  // 落盘探测（findDataPath 用）
  matchRe: [/^claude/i],
  homeDirs: [claudeHome()],
  // CLI 会话文件落在 <dataRoot>/projects/<工程>/ 下，文件名即 session_id
  sessionSubtree: 'projects',
  sessionIdOfFile: (name) => String(name).replace(/\.jsonl$/i, ''),
};

module.exports = { 
  id: '4F', 
  meta, 
  RE_CLAUDE_HOST,
  claudeHome,
  // 打断检测（统一模块组接口：interruptOf / interruptTail / sessionStatus）
  interruptTail: claudeInterruptTail,
  sessionStatus: claudeSessionStatus,
  interruptOf: claudeInterruptOf,
  CLAUDE_IDLE_GRACE_MS,
  // 当前模型（读 transcript 补，hook payload 无 model 字段）
  selectedModelOf,
  // 取消标记合成：交给 readReporterDones 统一派发（sessions.js 公共代码不掺 Claude/Qoder 专属逻辑）
  synthMarks,
};

/**
 * 楼层特有的"取消"标记合成（Claude / Qoder 共用，两者都靠 transcript 尾部信号判断打断），
 * 由 sessions.js 的 readReporterDones 统一派发。
 *
 * 这两家用户按"停止"后**一个 hook 事件都不发** —— 唯一权威痕迹在 transcript 末尾那条
 * `[Request interrupted by user]`（或 Claude 自己的会话状态文件说 idle）。服务端在轮询时自己认
 * （见 claudeInterruptOf 的两个信号），合成取消标记，由 sessionRegistry 去重后补发 task/end(cancelled)。
 * 不设 TASK_RUN_MS 门槛：信号一到位就该亮，同一轮靠 (会话, 任务, at) 去重只补发一次。
 *
 * @param {object} ctx
 *   { workspacePath, client, allFiles, clientHit, roundFilesOf, synthCancel, now }
 */
function synthMarks(ctx) {
  const { workspacePath, client, allFiles, clientHit, roundFilesOf, synthCancel, now } = ctx;
  for (const j of allFiles) {
    if (!j || !j.taskId) continue;
    const base = clientBase(j.client);
    if (base !== 'claude' && base !== 'qoder') continue;
    const startedAtJ = Number(j.taskStartedAt) || 0;
    const iv = claudeInterruptOf(j, startedAtJ);
    if (!iv.hit) continue;
    // 收尾自述只有 transcript 那条路有（idle 兜底认出来的早打断，本来就没吐过字）
    const ci = claudeInterruptTail(j.transcriptPath, startedAtJ);
    const id = String(j.sessionId || '');
    const ws = (j.done && j.done.workspacePath) || j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    if (client && !clientHit(client, j.client)) continue;
    synthCancel({
      id,
      j,
      ws: ws || workspacePath || '',
      at: iv.at || Number(j.sessionPhase && j.sessionPhase.ts) || startedAtJ || now,
      files: roundFilesOf(j),
      said: String(ci.said || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      result: String(ci.said || '').trim().slice(0, 4_000),
    });
  }
}
