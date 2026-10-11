'use strict';

/**
 * 服务端 hook 事件分发器。
 *
 * 架构背景（见重构说明）：CLI 的 hook 退化成「只读 stdin 事件 → POST /api/v1/hook」，
 * 所有落盘解析 / 会话状态 / 台账写入都在**服务端**完成 —— 服务端是本地进程，
 * 跟 CLI 同机同文件系统，本来就读 agent 的落盘（Kilo/Copilot 那几家一直这么干）。
 *
 * 本模块只做三件事：
 *   ① 从事件里解析出客户端（楼层）；
 *   ② 找到对应楼层的 `handleHookEvent` 派发过去；
 *   ③ 持有「会话状态」—— 替代 hook 曾经那份 state 文件（taskId / taskStartedAt / taskTitle …），
 *      按 sessionId 索引；拿不到时由楼层自己向 bus 回捞（currentTaskFor）。
 *
 * 没有 `handleHookEvent` 的楼层（Kilo / Copilot / OpenCode / Trae 这类靠轮询的）直接忽略事件，
 * 它们的台账由各自的同步器兜着，不走这条 hook 路线。
 *
 * 楼层 `handleHookEvent` 契约：
 *   async (ev, ctx) => any
 *   ctx = { project, workspacePath, client, bus, repo, sessionGet(id), sessionSet(id, patch) }
 *   返回任意对象都会原样回给 hook（{ ok:true, ... } 包装）；返回 {ok:false,...} 走 400。
 */

const { floorByAgent } = require('../floors');

function createHookDispatch() {
  // 会话状态：替代 hook 的 state 文件。sessionId -> 本轮任务上下文。
  const sessions = new Map();

  const sessionGet = (id) => (id ? sessions.get(id) || null : null);
  const sessionSet = (id, patch) => {
    if (!id) return;
    sessions.set(id, { ...(sessions.get(id) || {}), ...(patch || {}) });
  };

  /**
   * 派发一次 hook 事件。
   * @param {object} ev 原始 hook 事件（含 hook_event_name / session_id / cwd / transcript_path / client / agent …）
   * @param {{project: string, workspacePath: string, bus: any, repo: any}} ctx
   */
  async function dispatch(ev, ctx) {
    const event = ev && ev.hook_event_name;
    if (!event || !ev.agent) {
      return { ok: false, error: 'missing hook_event_name or agent' };
    }
    const floor = floorByAgent[String(ev.agent).toLowerCase()];
    if (!floor || typeof floor.handleHookEvent !== 'function') {
      return { ok: true, ignored: true };
    }
    return floor.handleHookEvent(ev, {
      project: ctx.project,
      workspacePath: ctx.workspacePath,
      bus: ctx.bus,
      repo: ctx.repo,
      sessionGet,
      sessionSet,
    });
  }

  return { dispatch, sessionGet, sessionSet, _sessions: sessions };
}

module.exports = { createHookDispatch };
