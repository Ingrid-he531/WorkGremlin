'use strict';

/**
 * 常驻小怪物名册：把"已定义的 subagent"（项目级 + 用户级）注册成坐工位的小怪物。
 *
 * 设计（见办公室可视化规范）：
 *   · 工位上的小怪物 = 用户级 / 项目级 subagent（写在 <workspace>/.codebuddy/agents
 *     或 ~/.codebuddy/agents 里的 *.md）。它们常驻、脖子上带工牌（级别牌由 agentLevel
 *     按名字判定），即使当下没被召唤也在。
 *   · 召唤时由 subagentFeed 另外生成"头顶小幽灵"（ephemeral）代表本次运行，
 *     本模块只负责"小怪物"本身（role=subagent, ephemeral=false）。
 *
 * 与 subagentFeed 的分工：
 *   · 本模块：确保每个已定义 subagent 有一个坐工位、带工牌的小怪物；
 *   · subagentFeed：处理"正在跑"的实例，生成/回收 ephemeral 小幽灵
 *     （含插件专家、主 agent 临时组队生成的实例，这些不对应小怪物）。
 *   两者 memberId 不同（小怪物用裸名，幽灵用 subagent-<name>），互不冲突。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detectLevel } = require('./agentLevel');
const config = require('../config');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const USER_AGENTS_DIR = path.join(HOME, '.codebuddy', 'agents');

/** 列出目录下的 agent 文件名（去 .md），目录不可读返回空 */
function listAgentFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.md$/i.test(f))
      .map((f) => f.replace(/\.md$/i, ''));
  } catch {
    return [];
  }
}

/**
 * 列出已定义的 subagent（项目级优先于用户级，重名去重），返回 [{ name, level }]。
 * @param {string} workspacePath 当前工程路径（用于扫项目级 agents 目录）
 */
function listDefinedAgents(workspacePath) {
  const ws = String(workspacePath || '').trim();
  const projDir = ws ? path.join(path.resolve(ws), '.codebuddy', 'agents') : '';
  const seen = new Map();
  if (projDir) for (const n of listAgentFiles(projDir)) if (!seen.has(n)) seen.set(n, 'project');
  for (const n of listAgentFiles(USER_AGENTS_DIR)) if (!seen.has(n)) seen.set(n, 'user');
  const out = [];
  for (const [name, fallback] of seen) {
    const level = detectLevel(name, ws) || fallback;
    if (level) out.push({ name, level });
  }
  return out;
}

/**
 * @param {{bus:any, project?:string, getProject?:()=>string, getWorkspacePath?:()=>string, intervalMs?:number}} opts
 */
function createAgentRoster(opts) {
  const bus = opts.bus;
  /**
   * 小怪物注册到哪个工程：**跟随"当前打开的工程"**。
   * 传 getProject() 让它每次现取当前工程 —— 否则名册会固定写死进一个工程
   * （老代码写死演示工程 id，只因演示工程恰好和真实工程同名才"蒙对"），
   * 一旦演示数据隔离 / 换工程，小怪物就跟不过去。
   */
  const getProject = typeof opts.getProject === 'function' ? opts.getProject : () => opts.project || config.DEMO_PROJECT;
  const getWorkspacePath = opts.getWorkspacePath || (() => '');
  const intervalMs = Number(opts.intervalMs) || 15_000;

  let running = false;
  let timer = null;
  let lastSig = '';
  const defined = new Set();
  /** project -> 本名册在该 project 上注册过的名字（换工程时各自记账，互不干扰） */
  const registered = new Map();
  /** 正在被召唤（活跃）的小怪物：这些由 subagentFeed 负责把工位状态设为忙碌，
   *  roster 心跳不要把它覆盖回 online。召唤结束（markIdle）即复位。 */
  const activeNames = new Set();

  function sync() {
    if (!running) return;
    const project = getProject();
    const ws = getWorkspacePath();
    const list = listDefinedAgents(ws);
    const sig = `${project}|${list
      .map((a) => a.name)
      .sort()
      .join(',')}`;

    // 这条 project 上"本名册注册过"的名字；换工程（project 变）时 sig 会变，会重新在这条 project 上注册。
    let mine = registered.get(project);
    if (!mine) {
      mine = new Set();
      registered.set(project, mine);
    }

    // 名册集合（或当前 project）变化时才动注册（补新增的、摘掉不再定义的）
    if (sig !== lastSig) {
      lastSig = sig;
      defined.clear();
      const keep = new Set();
      for (const { name } of list) {
        defined.add(name);
        keep.add(name);
        if (!mine.has(name)) {
          bus.registerMember({
            project,
            memberId: name,
            name,
            role: 'subagent',
            sessionId: null,
            ephemeral: false,
            projectLabel: '',
            workspacePath: ws,
          });
          mine.add(name);
        }
      }
      // 不再定义的：只从**当前这条 project** 上摘掉，别的工程的 project 不动
      for (const name of [...mine]) {
        if (!keep.has(name)) {
          try {
            bus.removeMember({ project, memberId: name });
          } catch {
            /* ignore */
          }
          mine.delete(name);
        }
      }
    }

    // 心跳：保持在线、避免被 sweepDegraded 判灰。
    // 正在被召唤（activeNames）的小怪物由 subagentFeed 把工位状态设为忙碌，
    // 这里跳过，不把它覆盖回 online。
    for (const name of mine) {
      if (activeNames.has(name)) continue;
      try {
        bus.heartbeat({ project, memberId: name, state: 'online', progress: null, files: [] });
      } catch {
        /* ignore */
      }
    }
  }

  /** 小怪物被召唤：登记活跃，roster 心跳不再覆盖其工位状态（忙碌由 subagentFeed 下发） */
  function markActive(name) {
    activeNames.add(String(name || '').trim());
  }

  /** 召唤结束：立即把小怪物工位复位为在线，并从活跃名单移除 */
  function markIdle(name) {
    name = String(name || '').trim();
    if (!activeNames.delete(name)) return;
    try {
      bus.heartbeat({ project: getProject(), memberId: name, state: 'online', progress: null, files: [] });
    } catch {
      /* ignore */
    }
  }

  function start() {
    if (running) return;
    running = true;
    sync();
    timer = setInterval(safeSync, intervalMs);
    if (timer.unref) timer.unref();
  }

  function safeSync() {
    try {
      sync();
    } catch (err) {
      console.warn('[workgremlin] 小怪物名册同步失败：', err && err.message);
    }
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function isDefined(name) {
    return defined.has(String(name || '').trim());
  }

  return {
    start,
    stop,
    sync,
    isDefined,
    markActive,
    markIdle,
    get running() {
      return running;
    },
    get defined() {
      return [...defined];
    },
  };
}

module.exports = { createAgentRoster, listDefinedAgents };
