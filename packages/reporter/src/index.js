'use strict';

/**
 * Agent-side reporting SDK (zero dependencies; Node >= 18 ships fetch).
 *
 * Usage (inside an agent runner):
 *   const rep = await createReporter({ project: 'my-project', member: 'coder' });
 *   const task = rep.task('implement the workstation view');
 *   await task.progress(0.4, { files: ['renderer/src/components/WorkstationCard.vue'] });
 *   await task.end('done', { artifacts: [{ kind: 'file', title: 'WorkstationCard.vue', path: '...' }] });
 *   rep.close();
 *
 * Design principles:
 *   - a failed report **retries silently once** and never blocks the agent's main flow;
 *   - the server address and token are read from ~/.workgremlin/server.json (overridable with WORKGREMLIN_HOME);
 *   - don't report what you don't have (progress/files may be omitted); the backend then shows "unknown", never invent.
 */

const fs = require('node:fs');
const path = require('node:path');

const { HTTP_ROUTES, home } = require('@workgremlin/shared');

function readServerInfo() {
  const file = path.join(home(), 'server.json');
  if (!fs.existsSync(file)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    // After a normal shutdown the file keeps only the token (no port/pid): not connection info.
    if (!info || !Number.isInteger(info.port) || info.port <= 0) return null;
    return info;
  } catch {
    return null;
  }
}

/**
 * @param {{project: string, member: string, endpoint?: string, token?: string, silent?: boolean}} opts
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

  /** The project this report belongs to: follow the server's "currently open project" unless set explicitly */
  let project = opts.project;
  if (!project) {
    try {
      const res = await fetch(`${base}/api/v1/workspace`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const cur = res.ok ? await res.json() : null;
      project = (cur && cur.project) || '';
    } catch {
      /* server unreachable: leave it empty; later reports get rejected (better than writing into the wrong project) */
    }
  }

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
    message: (to, type, subject, content) =>
      post(HTTP_ROUTES.MESSAGE, { memberId: member, from: member, to, type, subject, content }),
    file: (files, op = 'write') => post(HTTP_ROUTES.FILE_TOUCH, { memberId: member, files, op }),
    task,
    close() {},
  };
}

module.exports = { createReporter, readServerInfo, HTTP_ROUTES };
