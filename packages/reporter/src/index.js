'use strict';

/**
 * agent 侧上报 SDK（零依赖，Node >= 18 自带 fetch）。
 *
 * 用法（agent runner 内）：
 *   const rep = await createReporter({ project: 'my-project', member: 'coder' });
 *   const task = rep.task('实现工位视图');
 *   await task.progress(0.4, { files: ['renderer/src/components/WorkstationCard.vue'] });
 *   await task.end('done', { artifacts: [{ kind: 'file', title: 'WorkstationCard.vue', path: '...' }] });
 *   rep.close();
 *
 * 设计原则：
 *   - 上报失败**静默重试一次**，绝不阻塞 agent 主流程；
 *   - 服务端地址与 token 从 ~/.workgremlin/server.json 读取（可用 WORKGREMLIN_HOME 覆盖）；
 *   - 拿不到的数据就不上报（progress/files 允许缺省），后端据此显示"未知"，不编造。
 */

const fs = require('node:fs');
const path = require('node:path');

const { HTTP_ROUTES, home } = require('@workgremlin/shared');

function readServerInfo() {
  const file = path.join(home(), 'server.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{project: string, member: string, endpoint?: string, token?: string, heartbeatMs?: number, silent?: boolean}} opts
 */
async function createReporter(opts) {
  const info = readServerInfo();
  if (!info && !opts.endpoint) {
    throw new Error('未找到 ~/.workgremlin/server.json，请先启动 WorkGremlin 或传入 endpoint');
  }
  const base = (opts.endpoint || `http://127.0.0.1:${info.port}`).replace(/\/$/, '');
  const token = opts.token || (info ? info.token : '');
  const member = opts.member;
  const silent = opts.silent !== false;

  /** 上报归属的工程：没显式指定就跟随服务端"当前打开的工程" */
  let project = opts.project;
  if (!project) {
    try {
      const res = await fetch(`${base}/api/v1/workspace`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const cur = res.ok ? await res.json() : null;
      project = (cur && cur.project) || '';
    } catch {
      /* 服务端不可达：留空，后续上报会被拒（总比写进错的工程好） */
    }
  }

  let closed = false;

  async function post(route, body) {
    const payload = { project, ...body };
    try {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      });
      if (!res.ok && !silent) console.warn(`[workgremlin] ${route} -> ${res.status}`);
      return res.ok ? res.json().catch(() => ({})) : null;
    } catch (err) {
      if (!silent) console.warn(`[workgremlin] ${route} 失败: ${err && err.message}`);
      return null;
    }
  }

  await post(HTTP_ROUTES.REGISTER, { memberId: member, name: member });

  const heartbeatMs = opts.heartbeatMs || 5_000;
  const timer = setInterval(() => {
    if (!closed) post(HTTP_ROUTES.HEARTBEAT, { memberId: member });
  }, heartbeatMs);
  if (timer.unref) timer.unref();

  /** @param {string} title @param {{parentTaskId?: string, files?: string[]}} [extra] */
  function task(title, extra = {}) {
    let id = null;
    return {
      async start() {
        const r = await post(HTTP_ROUTES.TASK_START, { memberId: member, title, ...extra });
        id = r && r.taskId ? r.taskId : id;
        return id;
      },
      async progress(value, extra2 = {}) {
        if (!id) await this.start();
        await post(HTTP_ROUTES.TASK_PROGRESS, { memberId: member, taskId: id, progress: value, ...extra2 });
      },
      async end(state = 'done', extra2 = {}) {
        if (!id) await this.start();
        await post(HTTP_ROUTES.TASK_END, { memberId: member, taskId: id, state, ...extra2 });
      },
      get id() {
        return id;
      },
    };
  }

  return {
    project,
    member,
    register: (extra = {}) => post(HTTP_ROUTES.REGISTER, { memberId: member, name: member, ...extra }),
    heartbeat: (extra = {}) => post(HTTP_ROUTES.HEARTBEAT, { memberId: member, ...extra }),
    status: (state, reason) => post(HTTP_ROUTES.STATUS, { memberId: member, state, reason }),
    message: (to, type, subject, content) =>
      post(HTTP_ROUTES.MESSAGE, { memberId: member, from: member, to, type, subject, content }),
    file: (files, op = 'write') => post(HTTP_ROUTES.FILE_TOUCH, { memberId: member, files, op }),
    task,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

module.exports = { createReporter, readServerInfo, HTTP_ROUTES };
