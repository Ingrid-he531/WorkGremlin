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
const { clientOf } = require('@workgremlin/shared');
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
  dataKind: clientOf('codebuddy', false),
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

module.exports = {
  id: '1F',
  meta,
  // 供 findPluginDir / findPluginStorageDir 默认正则复用
  RE_PLUGIN,
  // 取消检测（统一模块组接口：cancelAt / allCancels，与 trae 同签名）
  cancelAt: codebuddyPauseCancelAt,
  allCancels: allCodebuddyCancels,
  // 完成/取消标记合成：交给 readReporterDones 统一派发（sessions.js 公共代码不掺 CodeBuddy 专属逻辑）
  synthMarks,
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
function synthMarks(ctx) {
  const { workspacePath, client, hookBySid, clientHit, roundFilesOf, synthCancel, bySession } = ctx;
  const cbCancels = allCodebuddyCancels();
  const cbSids = Object.keys(cbCancels || {});
  if (!cbSids.length) return;
  for (const sid of cbSids) {
    const atC = Number(cbCancels[sid]) || 0;
    if (!atC) continue;
    // 已有同一取消（±5s 容差）→ 跳过，避免重复合成 / 重复补发 task/end(cancelled)
    const existing = bySession.get(sid);
    if (existing && existing.cancelled && Math.abs(Number(existing.at) - atC) < 5_000) continue;
    const hook = hookBySid.get(sid);
    const j = hook ? hook.j : null;
    // 只认"本轮开始之后"的取消：老取消（上一轮）不能算到新一轮头上，否则主控制台会把当前这轮
    // 亮成「任务取消」。不再依赖 j.taskId —— taskId 被清空了也能靠 hook 状态文件的 taskStartedAt 判断本轮起点。
    const sinceTs = j ? Number(j.taskStartedAt) || 0 : 0;
    if (sinceTs && atC < sinceTs) continue;
    const hookWs = j ? ((j.done && j.done.workspacePath) || j.taskWorkspacePath || '') : '';
    if (workspacePath && hookWs && path.resolve(hookWs) !== path.resolve(workspacePath)) continue;
    if (j && client && !clientHit(client, j.client)) continue;
    synthCancel({
      id: sid,
      // taskId 与 Trae 同理：hook 状态文件里的 taskId 可能是新一轮的（甚至被清空），取消属于被顶掉的上一轮；
      // sessionRegistry.flushSynthesizedCancels 会用 sessionId + cancelAt 去 task_runs 找
      // started_at <= cancelAt、还挂 running 的那条来补 task/end(cancelled)。
      j: j ? { taskTitle: j.taskTitle || '', client: j.client } : { taskTitle: '', client: 'codebuddy' },
      ws: hookWs || workspacePath || '',
      at: atC,
      files: j ? roundFilesOf(j) : [],
    });
  }
}
