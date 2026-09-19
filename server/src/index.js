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
const { resolveWorkspacePath, resolveProjectName } = require('./project');
const { createWorkspaceManager } = require('./workspace');
const { createHub } = require('./ws/hub');
const { createHealthRouter } = require('./http/routes/health');
const { createQueryRouter } = require('./http/routes/query');
const { createIngestRouter } = require('./http/routes/ingest');
const { createWorkspaceRouter } = require('./http/routes/workspace');
const { createProductsRouter } = require('./http/routes/products');
const { createSessionsRouter } = require('./http/routes/sessions');
const { requireToken } = require('./http/auth');
const { WS_EVENTS } = require('@workgremlin/shared');
const { snapshot: registrySnapshot } = require('./sessionRegistry');
const config = require('./config');
const { seedDemoData, createDemoTicker } = require('./mock/generator');
const clock = require('./clock');

const VERSION = '0.1.0';

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
 *   demo?: boolean,
 *   seed?: number,
 *   workspacePath?: string,
 *   serveStatic?: string,
 *   silent?: boolean,
 * }} [opts]
 */
function createServer(opts = {}) {
  const dbPath = opts.dbPath || process.env.WORKGREMLIN_DB || config.defaultDbPath();
  const token = opts.token || config.newToken();
  const host = opts.host || '127.0.0.1';

  const { db, repo, checkpoint, startCheckpointLoop, close: closeDb } = openDatabase(dbPath);

  /** 当前工程：目录来自 WORKGREMLIN_WORKSPACE / 入参，否则 cwd；名字取 package.json name，回落目录名 */
  const workspacePath = resolveWorkspacePath(opts.workspacePath);
  const project = resolveProjectName(workspacePath);

  const app = express();
  const httpServer = http.createServer(app);

  let hub = null;
  const bus = createIngestBus({
    repo,
    project,
    hub: {
      /** @type {(...args: any[]) => void} */
      broadcast: (...args) => (hub ? hub.broadcast(...args) : undefined),
    },
  });

  hub = createHub({ server: httpServer, token, bus, repo });

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
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
  });

  app.use('/api/v1', createHealthRouter({ version: VERSION, project }));

  // 上报与查询需要 token；health 不需要（供 Electron 做存活探测）
  app.use('/api/v1', requireToken(token), createQueryRouter({ bus, repo }));
  app.use('/api/v1', requireToken(token), createIngestRouter({ bus }));

  /** 工程（"打开工程"）：一个 workspace 一个 team，切换即换屋里显示的那批成员 */
  const workspace = createWorkspaceManager({
    repo,
    bus,
    initial: { workspacePath, project },
    demoTeam: process.env.WORKGREMLIN_TEAM || 'workgremlin',
    preferDemo: isDemoMode(),
    broadcast: (team, type, payload) => (hub ? hub.broadcast(team, type, payload) : undefined),
  });
  app.use('/api/v1', requireToken(token), createWorkspaceRouter({ workspace }));
  app.use('/api/v1', requireToken(token), createProductsRouter());
  /** 会话下拉：所有工程里的活跃会话 */
  app.use('/api/v1', requireToken(token), createSessionsRouter({ workspace }));

  if (opts.serveStatic) {
    app.use(express.static(path.resolve(opts.serveStatic)));
  }

  const timers = [];
  let info = null;
  let demoTicker = null;
  let subagentFeed = null;
  let agentRoster = null;
  /** 临时成员（幽灵）挂在哪个 team 上：与演示数据同一个 team */
  const feedTeam = () => process.env.WORKGREMLIN_TEAM || 'workgremlin';

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
      team: cur.team || feedTeam(),
      workspacePath: cur.workspacePath,
      project: cur.project,
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
      project,
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
    for (const t of timers) if (t.unref) t.unref();

    // 恢复上次打开的工程（没有就继续用 cwd / --workspace 解析出来的那个）
    const restored = workspace.restore();
    if (info) {
      info.project = restored.project;
      info.workspacePath = restored.workspacePath || workspacePath;
      config.writeServerInfo(info);
    }

    // 演示数据要在**恢复之后**再决定：上次停在演示数据、这回又没带 --demo 启动时，
    // restore() 会把人带回 demo team，而按启动参数判定又不会灌数据、不跑心跳 —— 屋里就空了。
    maybeSeedDemo(Boolean(restored.demo));

    if (isDemoMode() || restored.demo) {
      demoTicker = createDemoTicker({
        bus,
        repo,
        team: feedTeam(),
        seed: Number(opts.seed ?? process.env.WORKGREMLIN_DEMO_SEED ?? 1),
      });
      demoTicker.start();
    }

    // 清理历史遗留：旧版 agentScan 注册的 "agent-<级别>-<id>" 成员已被 agentRoster 取代，
    // 但库里的旧行不会自动消失，会和 roster 的小怪物同名（出现"Peter/Leo 各两只"）。这里一次性删掉。
    try {
      const legacy = repo
        .listMembers.all(feedTeam())
        .filter((m) => /^agent-(user|project)-/.test(m.id));
      for (const m of legacy) bus.removeMember({ team: feedTeam(), memberId: m.id });
    } catch {
      /* 清理失败不影响启动 */
    }

    // 常驻小怪物名册：把已定义的 subagent（项目级 + 用户级）注册成坐工位、带工牌的小怪物。
    // 当前工程路径优先，回退到服务启动时解析的工程（演示模式下也能扫到项目级 agent）。
    // 必须在 startFeed() 之前创建：被召唤时由 subagentFeed 同步小怪物工位状态。
    agentRoster = createAgentRoster({
      bus,
      team: feedTeam(),
      getWorkspacePath: () => workspace.current().workspacePath || workspacePath,
    });
    // 换工程：重启 subagent 清单监听（幽灵）+ 同步小怪物名册。
    // 已定义 subagent 的"小怪物"只由 agentRoster 注册一次，避免同名两只。
    workspace.setOnSwitch(() => {
      startFeed();
      agentRoster.sync();
    });
    startFeed();
    agentRoster.start();

    if (!opts.silent) {
      console.log(`[workgremlin] server listening on http://${host}:${chosen} (db=${dbPath})`);
      const cur = workspace.current();
      if (cur.demo) console.log('[workgremlin] 当前：演示数据');
      else console.log(`[workgremlin] project=${cur.project || '(未命名工程)'} (${cur.workspacePath || workspacePath})`);
      console.log(`[workgremlin] subagent 清单：${cur.feedPath}`);
    }
    return info;
  }

  /** 是否处于 demo 模式（决定心跳推进器是否运行） */
  function isDemoMode() {
    if (process.env.WORKGREMLIN_NO_DEMO === '1') return false;
    return opts.demo === true || process.env.WORKGREMLIN_DEMO === '1' || process.env.MOCK === '1';
  }

  /**
   * @param {boolean} [onDemoWorkspace] 恢复后当前就停在演示数据上：这种也算 demo，
   *   否则非 --demo 启动 + 上次停在演示数据 = 恢复进 demo team 却没数据，屋里空无一人。
   */
  function shouldSeedDemo(onDemoWorkspace) {
    if (opts.demo === true || process.env.WORKGREMLIN_DEMO === '1' || process.env.MOCK === '1') return true;
    if (process.env.WORKGREMLIN_NO_DEMO === '1') return false;
    if (onDemoWorkspace) return true;
    // 默认**不再**在空库首跑时自动灌演示数据：首屏走真实数据源（空屋子），
    // 直到 agent 通过 hook 上报才有人。演示数据只在使用 --demo / WORKGREMLIN_DEMO=1 /
    // MOCK=1 时显式注入（README 已说明）。避免"默认演示"和文档里的"默认非演示"互相打架。
    return false;
  }

  function maybeSeedDemo(onDemoWorkspace) {
    if (!shouldSeedDemo(onDemoWorkspace)) return null;
    const team = process.env.WORKGREMLIN_TEAM || 'workgremlin';
    // 演示数据的时间基准锚定当前时间，每次重跑都会生成新时间戳。
    // 已有数据时默认跳过（否则反复 --demo 启动会让消息无限堆积），
    // 需要重置时加 WORKGREMLIN_DEMO_REFRESH=1。
    const existing = /** @type {{ c?: number } | undefined} */ (repo.countMessages.get(team));
    if (existing && existing.c > 0 && process.env.WORKGREMLIN_DEMO_REFRESH !== '1') return null;
    const seed = Number(opts.seed ?? process.env.WORKGREMLIN_DEMO_SEED ?? 1);
    return seedDemoData({
      bus,
      seed: Number.isFinite(seed) ? seed : 1,
      team,
      // 演示数据不属于任何工程：绑到某个目录的话，打开这个工程就会看到这 8 个模拟成员，
      // 还以为"打开工程没生效"。演示 team 只通过"切回演示数据"进入。
      workspacePath: '',
    });
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    if (demoTicker) demoTicker.stop();
    if (subagentFeed) subagentFeed.stop();
    if (agentRoster) agentRoster.stop();
    try {
      hub.close();
    } catch {
      /* ignore */
    }
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
    buildSnapshot: bus.buildSnapshot,
    get info() {
      return info;
    },
    VERSION,
  };
}

module.exports = { createServer, VERSION };
