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
 */

const fs = require('node:fs');
const path = require('node:path');
const { AGENT_STATES } = require('@workgremlin/shared');

/** 屋里只有 6 个悬浮点，多了会叠在一起；先出现的优先 */
const MAX_GHOSTS = 6;

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
  const agents = list
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      name: String(a.name || a.id || '').trim().slice(0, 64),
      state: String(a.state || '').trim(),
      task: typeof a.task === 'string' ? a.task.trim().slice(0, 200) : '',
      progress: Number.isFinite(Number(a.progress)) ? Number(a.progress) : null,
      files: Array.isArray(a.files) ? a.files.slice(0, 10).map(String) : [],
      project: typeof a.project === 'string' && a.project.trim() ? a.project.trim() : '',
    }))
    .filter((a) => a.name)
    .slice(0, MAX_GHOSTS);
  return { project, agents };
}

/** 状态只认 5 个主状态；清单里没写/写错 -> online（"在，但没在跑"），不编造 busy */
function normState(s) {
  return AGENT_STATES.includes(s) ? s : 'online';
}

/**
 * @param {{bus: any, repo: any, team: string, workspacePath?: string, project?: string,
 *          intervalMs?: number, roster?: any}} opts
 *   roster: 常驻小怪物名册（agentRoster 实例）。传入后，清单里的"已定义 subagent"
 *           被召唤时，会把对应小怪物的工位状态同步为忙碌，结束（从清单移除）时复位在线。
 */
function createSubagentFeed(opts) {
  const bus = opts.bus;
  const repo = opts.repo;
  const team = opts.team || 'workgremlin';
  const project = opts.project || '';
  const intervalMs = Number(opts.intervalMs) || 2000;
  const file = feedFilePath(opts.workspacePath);
  const roster = opts.roster || null;

  /** 小怪物工位在被召唤时应显示的状态：召唤即视为在忙，除非显式指定 thinking/blocked */
  function gremlinState(state) {
    const s = normState(state);
    return s === 'busy' || s === 'thinking' || s === 'blocked' ? s : 'busy';
  }

  /** name -> {id, title} 当前挂在幽灵身上的任务 */
  const tasks = new Map();
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  /** @type {fs.FSWatcher[]} */
  const watchers = [];
  let lastSig = '';
  let running = false;

  function sync() {
    if (!running) return 0;
    const feed = readFeed(file);
    const feedProject = feed.project || project;
    // 内容没变就只续心跳（否则每 2s 都会重写一遍状态行）
    const sig = JSON.stringify({ p: feedProject, a: feed.agents });
    const changed = sig !== lastSig;
    lastSig = sig;

    const alive = new Set();

    for (const a of feed.agents) {
      // 加 subagent- 前缀：免得跟常驻专家重名（清单里也有个 coder 的话，会把坐在工位上的那位顶掉）
      const memberId = `subagent-${a.name}`;
      const fullId = bus.memberIdOf(team, memberId);
      alive.add(fullId);
      if (changed) {
        bus.registerMember({
          team,
          memberId,
          name: a.name,
          role: 'subagent',
          sessionId: null,
          ephemeral: true,
          project: a.project || feedProject,
          workspacePath: opts.workspacePath || '',
        });
      }

      // 任务：标题变了就换一个（旧的收尾），没变只推进度
      const known = tasks.get(fullId);
      if (a.task) {
        if (!known || known.title !== a.task) {
          if (known) bus.endTask({ team, memberId, taskId: known.id, state: 'done' });
          const r = bus.startTask({ team, memberId, title: a.task, progress: a.progress ?? 0, files: a.files });
          if (r && r.taskId) tasks.set(fullId, { id: r.taskId, title: a.task });
        } else if (a.progress !== null) {
          bus.taskProgress({ team, memberId, taskId: known.id, progress: a.progress, files: a.files });
        }
      } else if (known) {
        bus.endTask({ team, memberId, taskId: known.id, state: 'done' });
        tasks.delete(fullId);
      }

      // 心跳：state 变了才写历史，同时刷新 last_heartbeat_at（不然 60s 后被判 degraded）
      bus.heartbeat({
        team,
        memberId,
        state: normState(a.state),
        progress: a.progress,
        files: a.files,
      });

      // 清单里的"已定义 subagent"被召唤：把对应小怪物的工位状态同步为忙碌，
      // 并登记活跃（roster 心跳不再覆盖它）。召唤结束（从清单移除）时由下方 stale 清理复位。
      if (roster && roster.isDefined(a.name)) {
        bus.heartbeat({
          team,
          memberId: a.name,
          state: gremlinState(a.state),
          progress: a.progress,
          files: a.files,
        });
        roster.markActive(a.name);
      }
    }

    // 清单里没了 -> 幽灵散掉（含上一轮残留的临时成员）
    const stale = repo.listEphemeral.all(team);
    for (const m of stale) {
      if (alive.has(m.id)) continue;
      // 若这是某个已定义 subagent 的幽灵，先把对应小怪物工位复位为在线
      if (roster && m.name && roster.isDefined(m.name)) roster.markIdle(m.name);
      tasks.delete(m.id);
      bus.removeMember({ team, memberId: m.id });
    }

    return feed.agents.length;
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
