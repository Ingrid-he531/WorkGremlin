'use strict';

/**
 * 本地服务：Express(HTTP 上报/查询) + ws(推送) + SQLite(落库)。
 *
 * 两种运行方式：
 *   1) 被 Electron 主进程内嵌（同进程，无端口/子进程管理成本）：
 *        const { createServer } = require('@workgremlin/server');
 *        const server = createServer({}); await server.start();
 *   2) 独立启动（headless / 调试 / 单测）：node server/src/cli.js
 */

const http = require('node:http');
const express = require('express');
const path = require('node:path');

const { openDatabase } = require('./db');
const { createIngestBus } = require('./ingest/bus');
const { createSubagentFeed } = require('./ingest/subagentFeed');
const { createAgentRoster } = require('./ingest/agentRoster');
const { resolveWorkspacePath, resolveProjectName, createWorkspaceManager } = require('./project');
const { createHub } = require('./ws/hub');
const { createHealthRouter } = require('./http/routes/health');
const { createQueryRouter } = require('./http/routes/query');
const { createIngestRouter } = require('./http/routes/ingest');
const { createWorkspaceRouter } = require('./http/routes/workspace');
const { createProductsRouter } = require('./http/routes/products');
const { createSessionsRouter } = require('./http/routes/sessions');
const { createCouncilRouter } = require('./http/routes/council');
const { createCouncilOrchestrator } = require('./council/orchestrator');
const { requireToken } = require('./http/auth');
const { createDemo } = require('./demo');
const { createLifecycle } = require('./lifecycle');
const { WS_EVENTS } = require('@workgremlin/shared');
const { snapshot: registrySnapshot, setBackend: setRegistryBackend } = require('./sessionRegistry');
const { startTaskSyncers } = require('./floors');
const config = require('./config');
const clock = require('./clock');

const VERSION = '0.1.0';

/**
 * 探测到"装了某个受监控 CLI"就把 hook 自动接上 —— 探测和接入本该是一件事，
 * 不该让用户装完 WorkGremlin 再手跑一遍 `npm run hooks:install`。
 *
 * 安全与分寸：
 *   · 只对**安装位置命中**的产品写（products.js 的判定口径：PATH 里有可执行文件 / 有插件目录）；
 *   · 合并式写入，只加/更新我们自己的条目，别人的配置一条不动，首次改动前备份 .bak-workgremlin；
 *   · 幂等：内容没变就什么都不写（所以每次启动调用是廉价的）；
 *   · 失败绝不影响服务启动；不想被自动改配置就 `WORKGREMLIN_NO_AUTO_HOOKS=1`。
 */
function autoInstallHooks() {
  if (process.env.WORKGREMLIN_NO_AUTO_HOOKS === '1') {
    console.log('[workgremlin] WORKGREMLIN_NO_AUTO_HOOKS=1：跳过自动接入 hook');
    return null;
  }
  try {
    // 延迟 require：只有真要装的时候才加载这个脚本
    const { installHooks } = require('../../scripts/install-hooks');
    const result = installHooks({});
    if (result.installed.length) {
      console.log(`[workgremlin] 自动接入 hook：${result.installed.join('、')}`);
    }
    if (result.failed.length) {
      console.warn(`[workgremlin] 自动接入 hook 跳过（配置不是合法 JSON）：${result.failed.join('、')}`);
    }
    return result;
  } catch (err) {
    console.warn(`[workgremlin] 自动接入 hook 失败（不影响使用）：${err && err.message}`);
    return null;
  }
}

/**
 * 判断 Origin 是否为回环地址（端口不限）。
 * @param {string} origin
 */
function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (host === '127.0.0.1' || host === 'localhost' || host === '::1')
    );
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   dbPath?: string,
 *   token?: string,
 *   port?: number,
 *   host?: string,
 *   workspacePath?: string,
 *   serveStatic?: string,
 *   silent?: boolean,
 * }} [opts]
 */
function createServer(opts = {}) {
  const dbPath = opts.dbPath || process.env.WORKGREMLIN_DB || config.defaultDbPath();
  // 传字符串（含空串）即采用：空串 = 显式关闭校验（--no-token，仅调试）；未传才生成随机 token。
  // 注意不能用 `opts.token || newToken()` —— 空串是 falsy，会让 --no-token 静默失效。
  const token = typeof opts.token === 'string' ? opts.token : config.newToken();
  const host = opts.host || '127.0.0.1';

  const { db, repo, checkpoint, startCheckpointLoop, close: closeDb } = openDatabase(dbPath);

  /** 当前工程：目录来自 WORKGREMLIN_WORKSPACE / 入参，否则 cwd；名字取 package.json name，回落目录名 */
  const workspacePath = resolveWorkspacePath(opts.workspacePath);
  const projectName = resolveProjectName(workspacePath);

  const app = express();
  const httpServer = http.createServer(app);

  let hub = null;
  const bus = createIngestBus({
    repo,
    projectName,
    hub: {
      /** @type {(...args: any[]) => void} */
      broadcast: (...args) => (hub ? hub.broadcast(...args) : undefined),
    },
  });

  hub = createHub({ server: httpServer, token, bus, repo });

  /* 会话表要能往台账补一刀（服务端自己发现的"这一轮被用户掐了" → task/end(cancelled)，
     见 sessionRegistry 的 flushSynthesizedCancels）。bus 实例是本函数造的，模块里拿不到，
     所以在这儿注入；不注入那一步就什么都不做（老行为）。 */
  setRegistryBackend({ bus, repo });

  app.use((req, res, next) => {
    res.setHeader('X-WorkGremlin-Version', VERSION);
    next();
  });

  // 本地源 CORS：
  //   - dev：Vite dev server（http://127.0.0.1:5173）页面直连本地服务
  //   - prod：file:// 加载的渲染进程，Origin 为 "null"
  // 两者都要跨域，而本服务只监听 127.0.0.1 且所有写接口都要 Bearer token，
  // 因此仅对回环地址 / null 源放开，不引入安全风险。
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && (isLoopbackOrigin(origin) || origin === 'null')) {
      res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
  });

  app.use('/api/v1', createHealthRouter({ version: VERSION, projectName }));

  // 上报与查询需要 token；health 不需要（供 Electron 做存活探测）
  app.use('/api/v1', requireToken(token), createQueryRouter({ bus, repo }));
  app.use('/api/v1', requireToken(token), createIngestRouter({ bus, repo }));

  /** 工程（"打开工程"）：一个 workspace 一个工程，切换即换屋里显示的那批成员 */
  const workspace = createWorkspaceManager({
    repo,
    bus,
    initial: { workspacePath, projectName },
    demoProject: config.DEMO_PROJECT,
    broadcast: (project, type, payload) => (hub ? hub.broadcast(project, type, payload) : undefined),
  });
  app.use('/api/v1', requireToken(token), createWorkspaceRouter({ workspace }));
  app.use('/api/v1', requireToken(token), createProductsRouter());
  /** 会话下拉：所有工程里的活跃会话 */
  app.use('/api/v1', requireToken(token), createSessionsRouter({ workspace }));

  /**
   * 议事厅：选几个楼层的 agent 开一场会。
   *
   * 这是仓库里第一处由服务端**异步拉起并托管长驻子进程**的地方（别处的 child_process 都是
   * 启动期同步跑一下就完的）。参与者跑在一次性临时目录里、工具全关、只写议事厅自己的表 ——
   * 它不碰任何被监控的会话，也不碰工作区，所以在办公室和任务记录里看不到它。
   * 广播传 project=null：一场会与"当前工程"无关。
   */
  const orchestrator = createCouncilOrchestrator({
    repo,
    broadcast: (project, type, payload) => (hub ? hub.broadcast(project, type, payload) : undefined),
  });
  app.use('/api/v1', requireToken(token), createCouncilRouter({ repo, orchestrator }));

  if (opts.serveStatic) {
    app.use(express.static(path.resolve(opts.serveStatic)));
  }

  const timers = [];
  let info = null;
  let subagentFeed = null;
  let agentRoster = null;

  // 生命周期钩子 + 演示逻辑（从 index.js 拆出，见 server/src/lifecycle.js 与 server/src/demo/）。
  const lifecycle = createLifecycle();
  const demo = createDemo({ bus, repo, getRoster: () => agentRoster });

  /**
   * （重）启动 subagent 清单监听 —— 盯的是**当前打开工程**下的
   * <workspace>/.workgremlin/subagents.json。演示数据模式没有工程目录，不监听。
   */
  function startFeed() {
    if (subagentFeed) subagentFeed.stop();
    const cur = workspace.current();
    if (!cur.workspacePath) return null;
    subagentFeed = createSubagentFeed({
      bus,
      repo,
      project: cur.project || config.DEMO_PROJECT,
      workspacePath: cur.workspacePath,
      projectName: cur.projectName,
      roster: agentRoster,
    });
    subagentFeed.start();
    return subagentFeed;
  }

  /**
   * 启动监听。
   * @param {number} [port]
   */
  async function start(port) {
    // 启动即接入：探测到装了哪个 CLI 就把它那份 hook 写好（幂等）
    autoInstallHooks();

    const existing = config.readServerInfo();
    const chosen = Number(port) || Number(opts.port) || (await config.pickPort());
    if (!chosen) throw new Error('no free port available in the configured range');

    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(chosen, host, resolve);
    });

    info = {
      port: chosen,
      token,
      pid: process.pid,
      dbPath,
      startedAt: clock.now(),
      version: VERSION,
      previousPid: existing ? existing.pid : null,
      projectName,
      workspacePath,
    };
    config.writeServerInfo(info);

    timers.push(startCheckpointLoop());
    timers.push(
      setInterval(() => {
        try {
          bus.sweepDegraded();
        } catch {
          /* ignore */
        }
      }, 10_000)
    );
    // 会话（全局活跃会话表）变化实时推送：开/关工程（会话）立刻反映到办公室，不再等 10s 轮询。
    // 每 2s 强制扫盘一次，按"活跃会话集合"算签名，只在变化时广播，避免无谓推送。
    let lastSessionSig = '';
    timers.push(
      setInterval(() => {
        try {
          const cur = workspace.current();
          const snap = registrySnapshot({ workspacePath: cur.workspacePath || '', force: true });
          const sig = JSON.stringify({
            d: snap.defaultFloor,
            f: snap.floors.map((f) => [f.id, f.activeCount, f.installed ? 1 : 0]),
            s: snap.sessions.map((x) => [x.floor, x.id, x.active ? 1 : 0, x.lastEventAt]),
          });
          if (sig !== lastSessionSig) {
            lastSessionSig = sig;
            hub.broadcast(null, WS_EVENTS.SESSIONS, snap);
          }
        } catch {
          /* 扫盘失败不阻断主流程 */
        }
      }, 2000)
    );

    // 记录自动保留：启动即清一次，之后每 24h 按 retentionDays 清掉更早的任务记录。
    // 定时器 unref 不阻止进程退出；清理失败不影响主流程。
    // 无 hook 上报能力的楼层：启动后台任务同步器（每 5s 轮询各自本地库，补写 task + task_run，
    // 让任务列表/主控制台能看到 6F/7F/8F/9F）。各同步器异常各自吞掉不阻断主流程；细节见 floors.js。
    timers.push(...startTaskSyncers({ bus, repo, now: () => clock.now() }));

    const runRetentionCleanup = () => {
      try {
        const days = repo.getRetentionDays();
        const beforeTs = clock.now() - days * 24 * 60 * 60 * 1000;
        const n = repo.deleteTaskRunsByFilter({ beforeTs });
        if (n > 0 && !opts.silent) console.log(`[workgremlin] 自动清理：删除 ${n} 条超过 ${days} 天的任务记录`);
      } catch (err) {
        if (!opts.silent) console.warn('[workgremlin] 自动清理失败：', err && err.message);
      }
    };
    runRetentionCleanup();
    timers.push(setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000));

    // 议事厅对账：上次进程被硬杀（或崩了）时，库里会留下 status='running' 的会 —— 那些会的
    // 参与进程早就不在了。如实标成 failed 并写明原因，不留在那儿假装还在讨论。
    // （正常关服那一路由 orchestrator.shutdown() 自己收尾，这里管的是没跑成正常关服的情况。）
    try {
      const stale = repo.failStaleCouncils('服务上次没有正常退出，这场会没跑完', clock.now());
      if (stale > 0 && !opts.silent) console.log(`[workgremlin] 议事厅：${stale} 场没跑完的会已如实标为失败`);
    } catch (err) {
      if (!opts.silent) console.warn('[workgremlin] 议事厅对账失败：', err && err.message);
    }

    for (const t of timers) if (t.unref) t.unref();

    // 恢复上次打开的工程（没有就继续用 cwd / --workspace 解析出来的那个）
    const restored = workspace.restore();
    if (info) {
      info.projectName = restored.projectName;
      info.workspacePath = restored.workspacePath || workspacePath;
      config.writeServerInfo(info);
    }

    // 清理历史遗留：旧版 agentScan 注册的 "agent-<级别>-<id>" 成员已被 agentRoster 取代，
    // 但库里的旧行不会自动消失，会和 roster 的小怪物同名（出现"Peter/Leo 各两只"）。这里一次性删掉。
    try {
      const legacy = repo
        .listMembers.all(config.DEMO_PROJECT)
        .filter((m) => /^agent-(user|project)-/.test(m.id));
      for (const m of legacy) bus.removeMember({ project: config.DEMO_PROJECT, memberId: m.id });
    } catch {
      /* 清理失败不影响启动 */
    }

    // 常驻小怪物名册：把已定义的 subagent（项目级 + 用户级）注册成坐工位、带工牌的小怪物。
    // 演示工程没有目录（workspacePath === ''），名册于是只列**用户级** agent。
    agentRoster = createAgentRoster({
      bus,
      // 小怪物跟随"当前打开的工程"的 project（不再固定写死演示 project），换工程才跟得过去
      getProject: () => workspace.current().project || config.DEMO_PROJECT,
      // 只认**当前工程**的路径，不回退到"服务启动时解析出来的工程"：
      // 切到演示工程后屋里演的是演示团队，那几个"本工程的 agent"不该跟着飘进来。
      getWorkspacePath: () => workspace.current().workspacePath,
    });

    // 生命周期钩子：切换工程后（恢复 / 手动切 / 演示切换都走这）按注册顺序触发。
    lifecycle.onWorkspaceSwitch(() => {
      startFeed();
      agentRoster.sync();
    });
    lifecycle.onWorkspaceSwitch(() => demo.onSwitch(workspace.current(), agentRoster));
    workspace.setOnSwitch(() => lifecycle.afterWorkspaceSwitch());

    // 关闭钩子：按注册顺序停掉定时器之外的资源（demo 推进器 / 清单监听 / 名册 / hub）。
    lifecycle.onClose(() => demo.stop());
    lifecycle.onClose(() => { if (subagentFeed) subagentFeed.stop(); });
    lifecycle.onClose(() => { if (agentRoster) agentRoster.stop(); });
    // 议事厅：先杀掉在飞的参与者进程（SIGTERM → SIGKILL），再给每场在飞的会落个结局。
    // 放在 hub.close() 前面 —— 收尾那一下还要往客户端广播最后一条状态。
    lifecycle.onClose(() => {
      try {
        orchestrator.shutdown();
      } catch (err) {
        if (!opts.silent) console.warn('[workgremlin] 议事厅收尾失败：', err && err.message);
      }
    });
    lifecycle.onClose(() => { try { hub.close(); } catch {} });

    startFeed();
    agentRoster.start();
    // 名册起来之后才有"已定义"的准数（演示对账要用它），所以演示的准备放这里：
    // 上次停在演示工程 → 这回启动照旧是演示，播种 / 心跳 / 残留清理都交给它。
    demo.onSwitch(workspace.current(), agentRoster);

    if (!opts.silent) {
      console.log(`[workgremlin] server listening on http://${host}:${chosen} (db=${dbPath})`);
      if (!token) console.warn('[workgremlin] 已关闭 token 校验（--no-token，仅调试用）');
      const cur = workspace.current();
      if (cur.demo) console.log('[workgremlin] 当前：演示工程');
      else console.log(`[workgremlin] project=${cur.projectName || '(未命名工程)'} (${cur.workspacePath || workspacePath})`);
      console.log(`[workgremlin] subagent 清单：${cur.feedPath}`);
    }
    return info;
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    lifecycle.beforeClose();
    await new Promise((resolve) => httpServer.close(() => resolve(null)));
    closeDb();
    config.clearServerInfo();
  }

  return {
    app,
    httpServer,
    ws: hub.wss,
    hub,
    bus,
    repo,
    db,
    dbPath,
    token,
    checkpoint,
    start,
    close,
    buildSnapshodet: bus.buildSnapshot,
    get info() {
      return info;
    },
    VERSION,
  };
}

module.exports = { createServer, VERSION };
