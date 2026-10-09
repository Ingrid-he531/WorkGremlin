'use strict';

/**
 * Claude Code 的「会话 → 当前模型」补全。
 *
 * 为什么单独成文件：跟 trae.js 同样的理由 —— 这段是"某个产品的私有落盘格式怎么读"，
 * 搬进 sessions.js 会把那份文件"读 json + mtime"的均质性搅乱；而且 Claude 的落盘根在哪已由
 * products.js 的 claudeHome() 定下，这里只负责"根下的 transcript 怎么读"，成对，不劈成两半。
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

const fs = require('node:fs');
const path = require('path');
const { claudeHome } = require('./claude');

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
 * @param {string} [_agentType] 为了和 traeModels.selectedModelOf 同签名；Claude 用不上
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

module.exports = { selectedModelOf };
