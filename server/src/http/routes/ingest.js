'use strict';

/**
 * Agent 上报接口（B 路线，唯一真值来源）。
 * 全部为 POST + JSON，幂等（消息按 dedupe_key 去重）。
 */

const express = require('express');
const { ERROR_CODES } = require('@workgremlin/shared');

const { createHookDispatch } = require('../../ingest/hookDispatch');
const { addGhost, retireGhost, sweepGhosts } = require('../../ingest/hookCommon');

/**
 * @param {{bus: any, repo?: any}} ctx
 */
function createIngestRouter({ bus, repo }) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  // 服务端 hook 事件分发：CLI hook 退化成事件转发器后，落盘解析 / 会话状态 / 台账写入都在这里。
  const hookDispatch = createHookDispatch();

  const wrap = (fn) => (req, res) => {
    try {
      const result = fn(req.body || {}, req);
      if (result && result.ok === false) {
        const code = result.error === 'unknown_member' ? ERROR_CODES.UNKNOWN_MEMBER : ERROR_CODES.BAD_PAYLOAD;
        return res.status(code === ERROR_CODES.UNKNOWN_MEMBER ? 404 : 400).json({ ok: false, error: { code, message: result.error } });
      }
      return res.json({ ok: true, ...(result || {}) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: { code: ERROR_CODES.INTERNAL, message: String(err && err.message) } });
    }
  };

  const projectFirst = (fn) =>
    wrap((body) => {
      /* 归属以**上报方真实所在目录**为准（见 bus.projectForReport 的说明）：
         "办公室开着 A、我在 B 里跑 CLI"时，body.project 是 A（办公室当前工程），
         body.workspacePath 才是 B —— 以前就拿 A 当归宿，任务被记到别的工程名下。
         没带 workspacePath 的老上报退回 body.project，行为不变。 */
      const project = bus.projectForReport(body.project || body.projectId || '', body.workspacePath || '');
      if (!project) return { ok: false, error: 'missing project' };
      bus.ensureProject(project, body.workspacePath || '', body.mainConversationId || null, 'report');
      return fn({ ...body, project });
    });

  router.post('/register', projectFirst((b) => ({ ok: true, memberId: bus.registerMember(b) })));

  router.post(
    '/heartbeat',
    projectFirst((b) =>
      b.memberId
        ? bus.heartbeat(b)
        : { ok: false, error: 'missing memberId' }
    )
  );

  router.post('/status', projectFirst((b) => (b.memberId ? bus.setStatus(b) : { ok: false, error: 'missing memberId' })));

  router.post('/task/start', projectFirst((b) => (b.memberId ? bus.startTask(b) : { ok: false, error: 'missing memberId' })));

  router.post(
    '/task/progress',
    projectFirst((b) => (b.memberId && b.taskId ? bus.taskProgress(b) : { ok: false, error: 'missing memberId/taskId' }))
  );

  router.post(
    '/task/end',
    projectFirst((b) => (b.memberId && b.taskId ? bus.endTask(b) : { ok: false, error: 'missing memberId/taskId' }))
  );

  /* 收工后补报 token：有些楼层的 usage 落盘比 Stop 晚（CodeBuddy 插件形态实测），
     收工那一刻读不到真值 —— 等它落盘了用这条补一刀，只写 token 四列（见 bus.backfillTaskTokens）。
     定位不到该补哪一行时服务端原样返回 ok（不写），所以这条可以放心重试。 */
  router.post(
    '/task/tokens',
    projectFirst((b) =>
      b.memberId && b.tokens ? bus.backfillTaskTokens(b) : { ok: false, error: 'missing memberId/tokens' }
    )
  );

  // 收工兜底（bug 3）：状态文件被并发覆盖丢了 taskId 时，hook 用这条回捞当前任务再收工。
  router.post(
    '/task/current',
    projectFirst((b) => (b.memberId ? bus.currentTaskFor(b.project, b.memberId, b.sessionId || '') : { ok: false, error: 'missing memberId' }))
  );

  router.post('/message', projectFirst((b) => (b.from ? bus.recordMessage({ ...b, source: 'report' }) : { ok: false, error: 'missing from' })));

  router.post('/file/touch', projectFirst((b) => (b.memberId ? bus.fileTouch(b) : { ok: false, error: 'missing memberId' })));

  // 工具使用：一轮任务里某个工具又用了一次（任务详情的「工具使用」按 (taskId, tool) 累加）
  router.post('/tool/use', projectFirst((b) => (b.memberId ? bus.toolUse(b) : { ok: false, error: 'missing memberId' })));

  /* subagent 幽灵（临时成员）写入：原本 IDE 插件直接写 <工程>/.workgremlin/subagents.json，
     现在统一收口到服务端 hookCommon（与 CLI hook 路径同一份实现），避免两边各写一份 JSON
     结构再分叉（见 ghostFeed 历史）。动作：spawn（召唤飘幽灵）/ finish（改待汇报）/
     sweep（清本会话幽灵）。归属以 workspacePath 为准，client 用来认领/隔离。 */
  router.post('/ghost', projectFirst((b) => {
    const ws = String(b.workspacePath || '');
    const client = String(b.client || '');
    const session = String(b.sessionId || b.session || '');
    const action = String(b.action || '');
    if (action === 'spawn') {
      addGhost(ws, String(b.name || 'subagent'), String(b.task || ''), String(b.id || ''), String(b.parent || ''), String(b.model || ''), client, session);
      return { ok: true, action: 'spawn' };
    }
    if (action === 'finish') {
      retireGhost(ws, String(b.name || ''), String(b.id || ''), String(b.result || ''), client, session);
      return { ok: true, action: 'finish' };
    }
    if (action === 'sweep') {
      sweepGhosts(ws, client, { all: b.all === true }, session);
      return { ok: true, action: 'sweep' };
    }
    return { ok: false, error: 'unknown_action' };
  }));

  /* CLI hook 转发来的原始事件：不再拆成语义路由，直接丢给服务端分发器，
     由对应楼层的 handleHookEvent 读落盘、写台账。project 以 workspacePath（cwd）归真，
     没带工程时回落到「办公室当前打开的工程」。 */
  router.post('/hook', async (req, res) => {
    try {
      const body = req.body || {};
      const ws = body.workspacePath || '';
      const project = bus.projectForReport(body.project || '', ws);
      if (!project) {
        return res.status(400).json({ ok: false, error: { code: ERROR_CODES.BAD_PAYLOAD, message: 'missing project' } });
      }
      bus.ensureProject(project, ws, body.mainConversationId || null, 'report');
      const result = await hookDispatch.dispatch({ ...body, project }, { project, workspacePath: ws, bus, repo });
      return res.json({ ok: true, ...(result || {}) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: { code: ERROR_CODES.INTERNAL, message: String((err && err.message) || err) } });
    }
  });

  return router;
}

module.exports = { createIngestRouter };
