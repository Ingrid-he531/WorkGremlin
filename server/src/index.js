'use strict';

/**
 * Local server: Express (HTTP reporting/query) + ws (push) + SQLite (persistence).
 *
 * Two ways to run it:
 *   1) Embedded in the Electron main process (same process, no port / child-process management cost):
 *        const { createServer } = require('@workgremlin/server');
 *        const server = createServer({}); await server.start();
 *   2) Standalone (headless / debugging / unit tests): node server/src/cli.js
 */

const http = require('node:http');
const express = require('express');
const path = require('node:path');

const log = require('./log');
const { openDatabase } = require('./db');
const { createIngestBus } = require('./ingest/bus');
const { createAgentRoster } = require('./ingest/agentRoster');
const { resolveWorkspacePath, resolveProjectName, createWorkspaceManager } = require('./project');
const { createHub } = require('./ws/hub');
const { createHealthRouter } = require('./http/routes/health');
const { createQueryRouter } = require('./http/routes/query');
const { createIngestRouter } = require('./http/routes/ingest');
const { createWorkspaceRouter } = require('./http/routes/workspace');
const { createProductsRouter } = require('./http/routes/floors');
const { createSessionsRouter } = require('./http/routes/sessions');
const { createCouncilRouter } = require('./http/routes/council');
const { createCouncilOrchestrator } = require('./council/orchestrator');
const { requireToken } = require('./http/auth');
const { createDemo } = require('./demo');
const { setBackend: setRegistryBackend } = require('./sessionRegistry');
const { createPoller } = require('./poller');
const config = require('./config');
const clock = require('./clock');

const VERSION = '0.1.0';

/**
 * Detecting "some monitored CLI is installed" auto-attaches its hook —— detection and attachment
 * ought to be one step; users should not have to run `npm run hooks:install` by hand after
 * installing WorkGremlin.
 *
 * Safety and restraint:
 *   · Only write into products whose **install location was hit** (products.js's criterion: an
 *     executable on PATH / a plugin directory exists);
 *   · Merging write: only add/update our own entries, never touch anyone else's, and back the file
 *     up as .bak-workgremlin before the first change;
 *   · Idempotent: nothing is written when the content is unchanged (so calling it on every start is
 *     cheap);
 *   · A failure must never keep the server from starting; set `WORKGREMLIN_NO_AUTO_HOOKS=1` if you
 *     do not want your config touched automatically.
 */
function autoInstallHooks() {
  if (process.env.WORKGREMLIN_NO_AUTO_HOOKS === '1') {
    log.info('[workgremlin] WORKGREMLIN_NO_AUTO_HOOKS=1：跳过自动接入 hook');
    return null;
  }
  try {
    // Lazy require: this script is only loaded when something really has to be installed
    const { installHooks } = require('../../scripts/install-hooks');
    const result = installHooks({});
    if (result.installed.length) {
      log.info(`[workgremlin] 自动接入 hook：${result.installed.join('、')}`);
    }
    if (result.failed.length) {
      log.warn(`[workgremlin] 自动接入 hook 跳过（配置不是合法 JSON）：${result.failed.join('、')}`);
    }
    return result;
  } catch (err) {
    log.warn(`[workgremlin] 自动接入 hook 失败（不影响使用）：${err && err.message}`);
    return null;
  }
}

/**
 * Whether Origin is a loopback address (any port).
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
 * Server lifecycle hooks: a tiny registry that replaces the hand-written chaining in start()/close()
 * with explicit registration, run in registration order.
 *   - onWorkspaceSwitch: fires after every project switch (restore / manual switch / demo switch all
 *     go through workspace.setOnSwitch -> afterWorkspaceSwitch)
 *   - onClose: fires before the server closes (for resources other than timers)
 * An error inside a hook must not block the other hooks, hence the one-by-one try/catch.
 */
function createLifecycle() {
  const switchHooks = [];
  const closeHooks = [];

  return {
    onWorkspaceSwitch(fn) {
      switchHooks.push(fn);
    },
    onClose(fn) {
      closeHooks.push(fn);
    },
    afterWorkspaceSwitch() {
      for (const fn of switchHooks) {
        try {
          fn();
        } catch (err) {
          log.warn('[workgremlin] afterWorkspaceSwitch 钩子失败：', err && err.message);
        }
      }
    },
    beforeClose() {
      for (const fn of closeHooks) {
        try {
          fn();
        } catch (err) {
          log.warn('[workgremlin] beforeClose 钩子失败：', err && err.message);
        }
      }
    },
  };
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
 *   log?: string,
 * }} [opts]
 */
function createServer(opts = {}) {
  // Log level: parameters win (--log=debug / passed when Electron starts), then environment
  // variables (see log.js)
  if (opts.log) log.setLevel(opts.log);
  const dbPath = opts.dbPath || process.env.WORKGREMLIN_DB || config.defaultDbPath();
  // A string (empty included) means "use it": empty string = validation explicitly disabled
  // (--no-token, debugging only); absent means generate a random token.
  // Note it must not be `opts.token || newToken()` —— an empty string is falsy, which would silently
  // break --no-token.
  const token = typeof opts.token === 'string' ? opts.token : config.newToken();
  const host = opts.host || '127.0.0.1';

  const { db, repo, checkpoint, startCheckpointLoop, close: closeDb } = openDatabase(dbPath);

  /** Current project: directory from WORKGREMLIN_WORKSPACE / the parameter, else cwd; name from package.json name, falling back to the directory name */
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

  /* The session table needs to be able to add one more entry to the ledger (the server discovering
     on its own that "this round was cut short by the user" → task/end(cancelled), see
     flushSynthesizedCancels in sessionRegistry). The bus instance is created inside this function
     and unreachable from the module, so inject it here; skip the injection and that step does
     nothing (old behavior). */
  setRegistryBackend({ bus, repo });

  app.use((req, res, next) => {
    res.setHeader('X-WorkGremlin-Version', VERSION);
    next();
  });

  // Local-source CORS:
  //   - dev: the Vite dev server (http://127.0.0.1:5173) page talks straight to the local server
  //   - prod: the renderer loaded via file://, whose Origin is "null"
  // Both need cross-origin, and since this server listens on 127.0.0.1 only and every write endpoint
  // requires a Bearer token, opening it up to loopback / null origins introduces no security risk.
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

  // Reporting and queries need a token; health does not (Electron uses it as a liveness probe)
  app.use('/api/v1', requireToken(token), createQueryRouter({ bus, repo }));
  app.use('/api/v1', requireToken(token), createIngestRouter({ bus, repo }));

  /** Project ("open project"): one workspace = one project, switching changes which members show in the room */
  const workspace = createWorkspaceManager({
    repo,
    bus,
    initial: { workspacePath, projectName },
    demoProject: config.DEMO_PROJECT,
    broadcast: (project, type, payload) => (hub ? hub.broadcast(project, type, payload) : undefined),
  });
  app.use('/api/v1', requireToken(token), createWorkspaceRouter({ workspace }));
  app.use('/api/v1', requireToken(token), createProductsRouter());
  /** Session dropdown: active sessions across all projects */
  app.use('/api/v1', requireToken(token), createSessionsRouter({ workspace }));

  /**
   * Council room: pick a few floors' agents and hold a meeting.
   *
   * This is the first place in the repo where the server **asynchronously spawns and supervises
   * long-lived child processes** (elsewhere child_process only runs synchronously once at startup).
   * Participants run inside a throwaway temp directory with all tools disabled and write only to the
   * council's own tables —— they touch no monitored session and no workspace, so they do not appear
   * in the office or in task records. Broadcasts carry project=null: a meeting has nothing to do with
   * "the current project".
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
  let agentRoster = null;

  // Lifecycle hooks + demo logic (see createLifecycle above and server/src/demo/).
  const lifecycle = createLifecycle();
  const demo = createDemo({ bus, repo, getRoster: () => agentRoster });

  /**
   * Start listening.
   * @param {number} [port]
   */
  async function start(port) {
    // Attach right at startup: whichever CLI is detected gets its hook written (idempotent)
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

    // Record retention: clean once at startup, then every 24h drop task records older than
    // retentionDays. The timer is unref'd so it never blocks process exit; cleanup failures do not
    // affect the main flow.
    const runRetentionCleanup = () => {
      try {
        const days = repo.getRetentionDays();
        const beforeTs = clock.now() - days * 24 * 60 * 60 * 1000;
        const n = repo.deleteTaskRunsByFilter({ beforeTs });
        if (n > 0 && !opts.silent) log.info(`[workgremlin] 自动清理：删除 ${n} 条超过 ${days} 天的任务记录`);
      } catch (err) {
        if (!opts.silent) log.warn('[workgremlin] 自动清理失败：', err && err.message);
      }
    };
    runRetentionCleanup();
    timers.push(setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000));

    // Council reconciliation: when the last process was hard-killed (or crashed), meetings remain in
    // the DB with status='running' —— their participant processes are long gone. Mark them failed and
    // state the reason honestly, do not leave them pretending to still be discussing.
    // (A normal shutdown is wrapped up by orchestrator.shutdown() itself; this handles cases that
    // never got a clean shutdown.)
    try {
      const stale = repo.failStaleCouncils('服务上次没有正常退出，这场会没跑完', clock.now());
      if (stale > 0 && !opts.silent) log.info(`[workgremlin] 议事厅：${stale} 场没跑完的会已如实标为失败`);
    } catch (err) {
      if (!opts.silent) log.warn('[workgremlin] 议事厅对账失败：', err && err.message);
    }

    for (const t of timers) if (t.unref) t.unref();

    // Restore the last opened project (fall back to the one resolved from cwd / --workspace)
    const restored = workspace.restore();
    if (info) {
      info.projectName = restored.projectName;
      info.workspacePath = restored.workspacePath || workspacePath;
      config.writeServerInfo(info);
    }

    // Resident gremlin roster: register defined subagents (project-level + user-level) as gremlins
    // that sit at workstations wearing badges. The demo project has no directory
    // (workspacePath === ''), so the roster lists only **user-level** agents then.
    agentRoster = createAgentRoster({
      bus,
      // Gremlins follow the project of "the currently open project" (no longer hardcoded to the demo
      // project), so switching projects carries them along
      getProject: () => workspace.current().project || config.DEMO_PROJECT,
      // Only honor the **current project's** path, never fall back to "the project resolved at server
      // start": once you switch to the demo project the room plays the demo team, and those "agents
      // of this project" must not drift in with it.
      getWorkspacePath: () => workspace.current().workspacePath,
    });
    // Hand the roster to the bus: a summoned "defined subagent" shows busy in the office
    // (the ghost path marks it active / idle)
    bus.setGhostRoster(agentRoster);

    /* The one clock: session scan + per-floor task-ledger sync + per-floor agent sync + heartbeat
       sweep all live in this single unified poller, so floor modules hold no timers (see poller.js).
       It starts here — after workspace.restore() — so the first tick scans the restored project and
       replaces the roster's old boot-time sync. */
    const poller = createPoller({
      bus,
      repo,
      getWorkspace: () => workspace.current(),
      broadcast: (project, type, payload) => (hub ? hub.broadcast(project, type, payload) : undefined),
      now: () => clock.now(),
      agents: {
        registerAgent: (floor, a) => agentRoster.registerAgent(floor, a),
        unregisterAgent: (floor, name) => agentRoster.unregisterAgent(floor, name),
        pollMs: 15_000,
      },
    });
    timers.push(poller.start());

    // Lifecycle hook: fires in registration order after every project switch (restore / manual
    // switch / demo switch all come through here).
    lifecycle.onWorkspaceSwitch(() => {
      poller.syncAgentsNow();
    });
    lifecycle.onWorkspaceSwitch(() => demo.onSwitch(workspace.current(), agentRoster));
    workspace.setOnSwitch(() => lifecycle.afterWorkspaceSwitch());

    // Close hooks: stop non-timer resources in registration order (demo driver / hub).
    lifecycle.onClose(() => demo.stop());
    // Council room: first kill the in-flight participant processes (SIGTERM → SIGKILL), then record
    // an ending for each meeting still in flight. It sits before hub.close() —— the wrap-up still has
    // to broadcast one last state to clients.
    lifecycle.onClose(() => {
      try {
        orchestrator.shutdown();
      } catch (err) {
        if (!opts.silent) log.warn('[workgremlin] 议事厅收尾失败：', err && err.message);
      }
    });
    lifecycle.onClose(() => { try { hub.close(); } catch {} });

    // The roster's ground truth is "defined" (the demo reconciliation uses it): the poller's first
    // tick already ran it (poller.start() runs after workspace.restore()), so the demo prep goes here.
    demo.onSwitch(workspace.current(), agentRoster);

    if (!opts.silent) {
      log.info(`[workgremlin] server listening on http://${host}:${chosen} (db=${dbPath})`);
      if (!token) log.warn('[workgremlin] 已关闭 token 校验（--no-token，仅调试用）');
      const cur = workspace.current();
      if (cur.demo) log.info('[workgremlin] 当前：演示工程');
      else log.info(`[workgremlin] project=${cur.projectName || '(未命名工程)'} (${cur.workspacePath || workspacePath})`);
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
