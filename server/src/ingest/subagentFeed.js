'use strict';

/**
 * subagent 实时清单 → 临时成员（幽灵）。
 *
 * 场景：真正帮你写代码的 subagent（code-explorer / coder / reviewer …）不是常驻专家，
 * 没有工位，正好对应办公室里飘着的幽灵 —— 名字是它的 id，状态是它此刻在干嘛，
 * 项目名就是当前这个工程。
 *
 * 数据源是一个 JSON 清单文件（谁写都行）：
 *   node scripts/subagents.js set code-explorer busy --task "探查数据流与幽灵渲染"
 *   node scripts/subagents.js rm code-explorer
 * 也可以由 agent 侧的 hook / 包装脚本直接写文件。
 *
 * 文件格式：
 *   { "project": "WorkGremlin",
 *     "agents": [ { "name": "code-explorer", "state": "busy", "task": "探查…", "progress": 0.4 } ] }
 * 顶层直接给数组也认（project 缺省用服务解析出来的工程名）。
 *
 * 对齐语义：**文件里有谁，屋里就飘着谁**。
 * 清单里删掉一个 agent，它的幽灵当场散掉（连状态行一起删，不清历史消息）。
 * 启动时先把库里残留的临时成员清一遍 —— 上一轮跑的幽灵不该这一轮还飘着。
 *
 * 收工（唯一的例外）：给某条写上 `result`（一句结果摘要）即表示它干完了 ——
 *   任务按 done 收尾、摘要作为产出（artifact kind=summary）下发（办公室里小怪物
 *   就是拿这句话走到主 agent 面前汇报）、小怪物工位改空闲；
 *   **幽灵不马上散**，等汇报演完（RETIRE_MS）再自动从清单里摘掉。
 * 所以一次召唤的完整收尾只要一条命令：
 *   node scripts/subagents.js set simmon idle --result "设计文档已落地，390 行，含时序表与状态机"
 */

const fs = require('node:fs');
const path = require('node:path');
const { AGENT_STATES } = require('@workgremlin/shared');
const config = require('../config');

/** 屋里只有 6 个悬浮点，多了会叠在一起；先出现的优先 */
const MAX_GHOSTS = 6;
/**
 * 写了 result 之后，幽灵还要飘多久才回收（毫秒）。
 * 得盖住办公室里那段"走到主 agent 面前 → 说出摘要 → 走回工位"的汇报动画
 * （约 3s + 3.4s + 3s），否则人还没汇报完、幽灵先散了。
 */
const RETIRE_MS = 10_000;
/**
 * hook 写的召唤条目（带 ts）活过这么久还没收场信号，就当它已经没了（毫秒）。
 * subagent 的结束信号依赖 PostToolUse / SubagentStop，哪条都可能因为 matcher
 * 没放开 / 事件不支持而不来；没有 TTL 的话这些幽灵会永久挂在屋里。
 * 只在内存里过滤，不动清单文件（手工 scripts/subagents.js 写的条目没有 ts，不受影响）。
 */
const GHOST_TTL_MS = 2 * 60 * 60_000; // 只是兜底：真正的收场由 hook 在 Stop / UserPromptSubmit / SessionEnd 主动扫（hook.js 的 sweepGhosts）。原来 30 分钟，会把跑超 30 分钟的长任务幽灵误撤。
/**
 * 收工摘要的落点：artifacts 表的 kind 只有 file / doc / pr / text 四种（CHECK 约束），
 * 所以摘要记成 kind='text'，再用 path 打这个标记让渲染层认出来
 * （检索处：renderer/src/views/IsoOfficeView.vue 的 sceneMembers）。
 */
const SUMMARY_PATH = 'workgremlin:summary';

/**
 * 清单文件路径。
 * @param {string} workspacePath
 */
function feedFilePath(workspacePath) {
  const env = String(process.env.WORKGREMLIN_SUBAGENTS_FILE || '').trim();
  if (env) return path.resolve(env);
  const dir = workspacePath || process.cwd();
  return path.join(dir, '.workgremlin', 'subagents.json');
}

/**
 * 读清单。文件不存在 / 坏了都返回空清单（不抛、不猜）。
 * @param {string} file
 * @returns {{project: string, agents: Array<Record<string, any>>}}
 */
function readFeed(file) {
  const empty = { project: '', agents: [] };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty;
  }
  const list = Array.isArray(data) ? data : Array.isArray(data && data.agents) ? data.agents : [];
  const project = (!Array.isArray(data) && typeof data.project === 'string' && data.project.trim()) || '';
  const now = Date.now();
  const agents = list
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      name: String(a.name || a.id || '').trim().slice(0, 64),
      state: String(a.state || '').trim(),
      // id / ts 由 hook 写（每次召唤一个 id），用来做"同名并发各算一条"和 TTL
      id: typeof a.id === 'string' ? a.id.trim().slice(0, 64) : '',
      ts: Number.isFinite(Number(a.ts)) ? Number(a.ts) : 0,
      task: typeof a.task === 'string' ? a.task.trim().slice(0, 200) : '',
      // result：一句结果摘要。写了它 = 这次召唤收工（见文件头）
      result: typeof a.result === 'string' ? a.result.trim().slice(0, 200) : '',
      progress: Number.isFinite(Number(a.progress)) ? Number(a.progress) : null,
      files: Array.isArray(a.files) ? a.files.slice(0, 10).map(String) : [],
      project: typeof a.project === 'string' && a.project.trim() ? a.project.trim() : '',
      // 写这条清单的是哪个客户端（hook 写的会带；手工 scripts/subagents.js 写的不带）
      client: typeof a.client === 'string' && a.client.trim() ? a.client.trim().toLowerCase() : '',
    }))
    .filter((a) => a.name)
    // 过期兜底：带 ts 的（hook 写的）超时未收场就当它没了，不再飘着
    .filter((a) => !a.ts || now - a.ts <= GHOST_TTL_MS)
    // 屋里只有 6 个悬浮点，多了叠在一起。**取最后 6 条**（hook 是往后追加的，即最新的）：
    // 取前 6 条的话，第 7 只会在前面的腾出位置后"迟到地"冒出来，很莫名。
    .slice(-MAX_GHOSTS);
  return { project, agents };
}

/** 状态只认 5 个主状态；清单里没写/写错 -> online（"在，但没在跑"），不编造 busy */
function normState(s) {
  return AGENT_STATES.includes(s) ? s : 'online';
}

/**
 * @param {{bus: any, repo: any, project: string, workspacePath?: string, projectName?: string,
 *          intervalMs?: number, roster?: any}} opts
 *   project  工程标识（幽灵挂在它下面）
 *   projectName 工程显示名（幽灵头顶显示的"所属项目"）
 *   roster: 常驻小怪物名册（agentRoster 实例）。传入后，清单里的"已定义 subagent"
 *           被召唤时，会把对应小怪物的工位状态同步为忙碌，结束（从清单移除）时复位在线。
 */
function createSubagentFeed(opts) {
  const bus = opts.bus;
  const repo = opts.repo;
  const project = opts.project || config.DEMO_PROJECT;
  const projectName = opts.projectName || '';
  const intervalMs = Number(opts.intervalMs) || 2000;
  const file = feedFilePath(opts.workspacePath);
  const roster = opts.roster || null;

  /** 小怪物工位在被召唤时应显示的状态：召唤即视为在忙，除非显式指定 thinking/blocked */
  function gremlinState(state, result) {
    // 写了 result = 收工：工位回空闲（顺序是"汇报 → 空闲 → 幽灵消失"）
    if (result) return 'idle';
    const s = normState(state);
    if (s === 'busy' || s === 'thinking' || s === 'blocked') return s;
    // 清单里明写了 idle / offline 就照它显示：不替调用方把"空闲"编造成"忙碌"。
    // "召唤即视为在忙"只用于**没写状态**的条目（hook 侧召唤一律写 busy）。
    if (s === 'idle' || s === 'offline') return s;
    return 'busy';
  }

  /** name -> {id, title} 当前挂在幽灵身上的任务 */
  const tasks = new Map();
  /** name -> { result, at } 已收工、等着播完汇报再回收的（见文件头） */
  const retiring = new Map();
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  /** @type {fs.FSWatcher[]} */
  const watchers = [];
  let lastSig = '';
  let running = false;

  function sync() {
    if (!running) return 0;
    const feed = readFeed(file);
    const feedProject = feed.project || projectName;
    // 内容没变就只续心跳（否则每 2s 都会重写一遍状态行）
    const sig = JSON.stringify({ p: feedProject, a: feed.agents });
    const changed = sig !== lastSig;
    lastSig = sig;

    const alive = new Set();

    for (const a of feed.agents) {
      // 加 subagent- 前缀：免得跟常驻专家重名（清单里也有个 coder 的话，会把坐在工位上的那位顶掉）
      const memberId = `subagent-${a.name}`;
      const fullId = bus.memberIdOf(project, memberId);
      alive.add(fullId);
      // 老库的幽灵行没有 client，顺手补（只在缺失/不一致时写）
      if (a.client) bus.tagMemberClient(project, memberId, a.client);
      if (changed) {
        bus.registerMember({
          project,
          memberId,
          name: a.name,
          role: 'subagent',
          sessionId: null,
          ephemeral: true,
          projectLabel: a.project || feedProject,
          workspacePath: opts.workspacePath || '',
          client: a.client || '',
        });
      }

      // 任务：标题变了就换一个（旧的收尾），没变只推进度
      const known = tasks.get(fullId);
      if (a.result) {
        // 收工：结果摘要作为产出下发（渲染层拿它当汇报文案），任务按 done 收尾；
        // 幽灵留着，等汇报演完再摘（下方 retiring 到点处理）。
        if (known) {
          // 摘要写失败也不能拖住收工（否则幽灵既不汇报也不散）
          try {
            bus.endTask({
              project,
              memberId,
              taskId: known.id,
              state: 'done',
              artifacts: [{ kind: 'text', title: a.result, path: SUMMARY_PATH }],
            });
          } catch (err) {
            console.warn('[workgremlin] subagent 收工摘要落盘失败：', err && err.message);
          }
          tasks.delete(fullId);
        }
        if (!retiring.has(a.name)) retiring.set(a.name, { result: a.result, at: Date.now() + RETIRE_MS });
      } else if (a.task) {
        if (!known || known.title !== a.task) {
          if (known) bus.endTask({ project, memberId, taskId: known.id, state: 'done' });
          const r = bus.startTask({ project, memberId, title: a.task, progress: a.progress ?? 0, files: a.files });
          if (r && r.taskId) tasks.set(fullId, { id: r.taskId, title: a.task });
        } else if (a.progress !== null) {
          bus.taskProgress({ project, memberId, taskId: known.id, progress: a.progress, files: a.files });
        }
      } else if (known) {
        bus.endTask({ project, memberId, taskId: known.id, state: 'done' });
        tasks.delete(fullId);
      }

      // 心跳：state 变了才写历史，同时刷新 last_heartbeat_at（不然 60s 后被判 degraded）
      bus.heartbeat({
        project,
        memberId,
        state: normState(a.state),
        progress: a.progress,
        files: a.files,
      });

      // 清单里的"已定义 subagent"被召唤：把对应小怪物的工位状态同步为忙碌，
      // 并登记活跃（roster 心跳不再覆盖它）。召唤结束（从清单移除）时由下方 stale 清理复位。
      if (roster && roster.isDefined(a.name)) {
        bus.heartbeat({
          project,
          memberId: a.name,
          state: gremlinState(a.state, a.result),
          progress: a.progress,
          files: a.files,
        });
        roster.markActive(a.name);
      }
    }

    // 到点回收：汇报演完了，把这条从清单里摘掉 —— 幽灵这才散掉
    const nowMs = Date.now();
    for (const [name, plan] of [...retiring]) {
      if (nowMs < plan.at) continue;
      retiring.delete(name);
      retireFromFeed(name, plan.result);
    }

    // 清单里没了 -> 幽灵散掉（含上一轮残留的临时成员）
    const stale = repo.listEphemeral.all(project);
    for (const m of stale) {
      if (alive.has(m.id)) continue;
      // 若这是某个已定义 subagent 的幽灵，先把对应小怪物工位复位为在线
      if (roster && m.name && roster.isDefined(m.name)) roster.markIdle(m.name);
      tasks.delete(m.id);
      bus.removeMember({ project, memberId: m.id });
    }

    return feed.agents.length;
  }

  /**
   * 从清单里摘掉一只已收工的（汇报已播完 → 幽灵散掉）。
   * 只摘 result 仍然相同的那条：期间若被重新召唤（result 被清掉 / 换了），就别误删新一轮。
   * @param {string} name
   * @param {string} result
   */
  function retireFromFeed(name, result) {
    // 直接改原始 JSON、**不**走 readFeed 的归一化：否则回写会把别条目的 id / ts
    // 等字段冲掉（那两个是 hook 用来做并发去重和 TTL 的）。
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    const wrap = !Array.isArray(data) && Array.isArray(data.agents);
    const list = Array.isArray(data) ? data : wrap ? data.agents : null;
    if (!list) return;
    const i = list.findIndex((a) => a && a.name === name && String(a.result || '') === String(result || ''));
    if (i < 0) return;
    list.splice(i, 1);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const out = Array.isArray(data) ? list : { ...data, agents: list };
      fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.warn('[workgremlin] subagent 收工回收失败：', err && err.message);
    }
  }

  function start() {
    if (running) return;
    running = true;
    sync();
    timers.push(setInterval(safeSync, intervalMs));
    // fs.watch 只是让"改文件立刻生效"；真正的兜底是上面的轮询
    try {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, { persistent: false }, debouncedSync);
      watchers.push(w);
    } catch {
      /* 目录不可监听就算了，轮询还在 */
    }
    return file;
  }

  let debounceTimer = null;
  function debouncedSync() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(safeSync, 120);
  }

  function safeSync() {
    try {
      sync();
    } catch (err) {
      console.warn('[workgremlin] subagent 清单同步失败：', err && err.message);
    }
  }

  function stop() {
    running = false;
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    watchers.length = 0;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  return { file, start, stop, sync, read: () => readFeed(file), get running() { return running; } };
}

module.exports = { createSubagentFeed, feedFilePath, readFeed, normState, MAX_GHOSTS };
