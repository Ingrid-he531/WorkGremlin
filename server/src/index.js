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
const { createHub } = require('./ws/hub');
const { createHealthRouter } = require('./http/routes/health');
const { createQueryRouter } = require('./http/routes/query');
const { createIngestRouter } = require('./http/routes/ingest');
const { requireToken } = require('./http/auth');
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

  const app = express();
  const httpServer = http.createServer(app);

  let hub = null;
  const bus = createIngestBus({
    repo,
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

  app.use('/api/v1', createHealthRouter({ version: VERSION }));

  // 上报与查询需要 token；health 不需要（供 Electron 做存活探测）
  app.use('/api/v1', requireToken(token), createQueryRouter({ bus, repo }));
  app.use('/api/v1', requireToken(token), createIngestRouter({ bus }));

  if (opts.serveStatic) {
    app.use(express.static(path.resolve(opts.serveStatic)));
  }

  const timers = [];
  let info = null;
  let demoTicker = null;

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
    for (const t of timers) if (t.unref) t.unref();

    maybeSeedDemo();

    if (isDemoMode()) {
      demoTicker = createDemoTicker({
        bus,
        repo,
        team: process.env.WORKGREMLIN_TEAM || 'workgremlin',
        seed: Number(opts.seed ?? process.env.WORKGREMLIN_DEMO_SEED ?? 1),
      });
      demoTicker.start();
    }

    if (!opts.silent) {
      console.log(`[workgremlin] server listening on http://${host}:${chosen} (db=${dbPath})`);
    }
    return info;
  }

  /** 是否处于 demo 模式（决定心跳推进器是否运行） */
  function isDemoMode() {
    if (process.env.WORKGREMLIN_NO_DEMO === '1') return false;
    return opts.demo === true || process.env.WORKGREMLIN_DEMO === '1' || process.env.MOCK === '1';
  }

  function shouldSeedDemo() {
    if (opts.demo === true || process.env.WORKGREMLIN_DEMO === '1' || process.env.MOCK === '1') return true;
    if (process.env.WORKGREMLIN_NO_DEMO === '1') return false;
    return repo.listTeams.all().length === 0; // 首次运行：给两个界面一份可渲染的数据
  }

  function maybeSeedDemo() {
    if (!shouldSeedDemo()) return null;
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
      workspacePath: opts.workspacePath || process.env.WORKGREMLIN_WORKSPACE || '',
    });
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    if (demoTicker) demoTicker.stop();
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
