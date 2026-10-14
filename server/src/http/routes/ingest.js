'use strict';

/**
 * Agent 上报接口（B 路线，唯一真值来源）。
 * 全部为 POST + JSON，幂等（消息按 dedupe_key 去重）。
 */

const express = require('express');
const { ERROR_CODES } = require('@workgremlin/shared');

const log = require('../../log');
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

  /* subagent ghost (ephemeral member) writes: funnelled into server-side hookCommon (the same
     implementation as the CLI hook path). No manifest file anymore — it writes straight to the DB as
     an ephemeral member + subagent_runs. Actions: spawn (summon a ghost) / finish (retire it) /
     sweep (clear this session's ghosts). Ownership follows workspacePath; client is used to claim /
     isolate. */
  router.post('/ghost', projectFirst((b) => {
    const ws = String(b.workspacePath || '');
    const client = String(b.client || '');
    const session = String(b.sessionId || b.session || '');
    const action = String(b.action || '');
    if (action === 'spawn') {
      addGhost(bus, b.project, ws, String(b.name || 'subagent'), String(b.task || ''), String(b.id || ''), String(b.parent || ''), String(b.model || ''), client, session);
      return { ok: true, action: 'spawn' };
    }
    if (action === 'finish') {
      retireGhost(bus, b.project, String(b.name || ''), String(b.id || ''), String(b.result || ''), client, session);
      return { ok: true, action: 'finish' };
    }
    if (action === 'sweep') {
      sweepGhosts(bus, b.project, client, { all: b.all === true }, session);
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
      // 诊断：每次收到 hook 事件都打一行（info 级，默认落盘），看清楚"服务端到底收没收到、字段长啥样"
      log.info('[ghost-debug] /hook recv', JSON.stringify({ event: body.hook_event_name, agent: body.agent, client: body.client, tool: body.tool_name || body.tool, ws, session: body.session_id || '' }));
      const project = bus.projectForReport(body.project || '', ws);
      if (!project) {
        log.warn('hook 没有归属工程，忽略', body.hook_event_name, body.agent, ws);
        return res.status(400).json({ ok: false, error: { code: ERROR_CODES.BAD_PAYLOAD, message: 'missing project' } });
      }
      bus.ensureProject(project, ws, body.mainConversationId || null, 'report');
      const result = await hookDispatch.dispatch({ ...body }, { project, workspacePath: ws, bus, repo });
      return res.json({ ok: true, ...(result || {}) });
    } catch (err) {
      log.error('hook 处理失败：', err);
      return res.status(500).json({ ok: false, error: { code: ERROR_CODES.INTERNAL, message: String((err && err.message) || err) } });
    }
  });

  return router;
}

module.exports = { createIngestRouter };
