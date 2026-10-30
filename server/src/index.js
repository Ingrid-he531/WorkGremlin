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
const https = require('node:https');
const express = require('express');

const log = require('./log');
const { openDatabase } = require('./db');
const { createIngestBus } = require('./ingest/bus');
const { createAgentRoster } = require('./ingest/agentRoster');
const { resolveWorkspacePath, resolveProjectName, createWorkspaceContext } = require('./project');
const { createHub } = require('./ws/hub');
const { createHealthRouter } = require('./http/routes/health');
const { createQueryRouter } = require('./http/routes/query');
const { createIngestRouter } = require('./http/routes/ingest');
const { createWorkspaceRouter } = require('./http/routes/workspace');
const { createProductsRouter } = require('./http/routes/floors');
const { createSessionsRouter } = require('./http/routes/sessions');
const { createDemoRouter } = require('./http/routes/demo');
const { createCouncilRouter } = require('./http/routes/council');
const { createCouncilOrchestrator } = require('./council/orchestrator');
const { createDispatchService } = require('./control/service');
const { createDispatchRouter } = require('./http/routes/dispatch');
const { requireToken } = require('./http/auth');
const { createStaticSite } = require('./http/staticSite');
const { createDemoProvider } = require('./demo');
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
 * Server lifecycle hooks: a tiny registry for close-time cleanup.
 * An error inside a hook must not block the other hooks, hence the one-by-one try/catch.
 */
function createLifecycle() {
  const closeHooks = [];

  return {
    onClose(fn) {
      closeHooks.push(fn);
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
 *   tls?: {key: string, cert: string, fingerprint256?: string},
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
  // (--no-token, debugging only); absent means reuse the token persisted by a previous run, or
  // generate one on the very first start. Reuse matters for remote clients: a token that changed
  // on every restart would invalidate every client each time the server comes back.
  // Note it must not be `opts.token || ...` —— an empty string is falsy, which would silently
  // break --no-token.
  const token =
    typeof opts.token === 'string' ? opts.token : config.persistedToken() || config.newToken();
  const host = opts.host || '127.0.0.1';

  const { db, repo, checkpoint, startCheckpointLoop, close: closeDb } = openDatabase(dbPath);

  /** Current project: directory from WORKGREMLIN_WORKSPACE / the parameter, else cwd; name from package.json name, falling back to the directory name */
  const workspacePath = resolveWorkspacePath(opts.workspacePath);
  const projectName = resolveProjectName(workspacePath);

  const app = express();
  // HTTPS when TLS material was resolved (cli.js / --tls). Everything below is protocol-agnostic:
  // the ws hub attaches to whichever server this is, and the API/static routers do not care.
  const tls = opts.tls || null;
  const httpServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : http.createServer(app);

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

  /**
   * Demo is a read-only virtual session, not a seeded project: the provider owns its members,
   * phase and messages in memory. It sees real projects only for the snapshot's project list.
   */
  const demo = createDemoProvider({ listProjects: () => bus.listProjectSummaries() });

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

  /**
   * Server-side default workspace. It is **not** what the office shows: each client follows the
   * project of its selected session. This value only backs legacy attribution (reports without a
   * workspacePath), the floor poller and the resident subagent scan.
   */
  const workspace = createWorkspaceContext({
    repo,
    bus,
    initial: { workspacePath, projectName },
  });
  app.use('/api/v1', requireToken(token), createWorkspaceRouter({ workspace }));
  app.use('/api/v1', requireToken(token), createProductsRouter());
  /** Session dropdown: active sessions across all projects */
  app.use('/api/v1', requireToken(token), createSessionsRouter({ workspace }));
  /** Virtual demo session (read-only; never writes office tables) */
  app.use('/api/v1', requireToken(token), createDemoRouter({ demo }));

  /**
   * Council room: pick a few floors' agents and hold a meeting.
   *
   * This is the first place in the repo where the server **asynchronously spawns and supervises
   * long-lived child processes** (elsewhere child_process only runs synchronously once at startup).
   * Participants run inside a throwaway temp directory with all tools disabled and write only to the
   * council's own tables —— they touch no monitored session and no workspace, so they do not appear
   * in the office or in task records. Broadcasts carry project=null: a meeting has nothing to do with
   * the office's selected project.
   */
  const orchestrator = createCouncilOrchestrator({
    repo,
    broadcast: (project, type, payload) => (hub ? hub.broadcast(project, type, payload) : undefined),
  });
  app.use('/api/v1', requireToken(token), createCouncilRouter({ repo, orchestrator }));

  /**
   * Remote dispatch (reverse control): one client asks one floor to do one task on this machine.
   * Unlike the council, the spawned run is a **normal session** in the target directory: it is not
   * hidden, and this server writes no ledger rows for it —— the floor's own hook/poller records it,
   * exactly like a manual CLI run. `confirm` mode parks requests until the server machine approves.
   */
  const dispatch = createDispatchService({
    repo,
    broadcast: (project, type, payload) => (hub ? hub.broadcast(project, type, payload) : undefined),
  });
  app.use('/api/v1', requireToken(token), createDispatchRouter({ service: dispatch }));

  if (opts.serveStatic) {
    // Browser-only mode: the same server hands out the built UI, so the client machine needs
    // nothing installed. Registered after the API routers so /api is never shadowed.
    app.use(createStaticSite({ dir: opts.serveStatic, token, secure: Boolean(tls) }));
  }

  const timers = [];
  let info = null;
  let agentRoster = null;

  // Lifecycle hooks (see createLifecycle above).
  const lifecycle = createLifecycle();

  /**
   * Start listening.
   * @param {number} [port]
   */
  async function start(port) {
    // Attach right at startup: whichever CLI is detected gets its hook written (idempotent)
    autoInstallHooks();

    const existing = config.readServerInfo();
    const chosen = Number(port) || Number(opts.port) || (await config.pickPort(undefined, undefined, host));
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
      // Clients build their HTTP/WS base from this (renderer/api/bridge.js): a remote client may
      // have no way to guess that the target speaks https, and the scheme is not derivable from
      // host+port alone. `http` is written explicitly so old readers see no change.
      protocol: tls ? 'https' : 'http',
      tlsFingerprint: tls && tls.fingerprint256 ? tls.fingerprint256 : null,
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

    // Restore the server-side default workspace (cwd / --workspace is the fallback). This does
    // not select a project for the UI; clients still follow their selected session.
    const restored = workspace.restore();
    if (info) {
      info.projectName = restored.projectName;
      info.workspacePath = restored.workspacePath || workspacePath;
      config.writeServerInfo(info);
    }

    // Resident gremlin roster: register defined subagents (project-level + user-level) as gremlins
    // that sit at workstations wearing badges. The roster uses the server default workspace, not a
    // client-selected project; the office then filters cards by the selected session's project.
    agentRoster = createAgentRoster({
      bus,
      getProject: () => workspace.get().project,
      getWorkspacePath: () => workspace.get().workspacePath,
    });
    // Hand the roster to the bus: a summoned "defined subagent" shows busy in the office
    // (the ghost path marks it active / idle)
    bus.setGhostRoster(agentRoster);

    // Live ghosts are a hot in-memory map; restore them from open ledger rows before the poller
    // starts so an asynchronous child remains visible across a server restart.
    const restoredGhosts = bus.restoreGhosts();
    bus.gcGhosts();
    if (restoredGhosts > 0 && !opts.silent) {
      log.info(`[workgremlin] 恢复 ${restoredGhosts} 个仍在运行的子代理幽灵`);
    }

    /* The one clock: session scans, per-floor task-ledger sync, agent sync and ghost GC all live in
       this single unified poller, so floor modules hold no timers (see poller.js).
       It starts after workspace.restore() so the first tick scans the server's default workspace
       and replaces the roster's old boot-time sync. */
    const poller = createPoller({
      bus,
      repo,
      getWorkspace: () => workspace.get(),
      broadcast: (project, type, payload) => (hub ? hub.broadcast(project, type, payload) : undefined),
      now: () => clock.now(),
      agents: {
        registerAgent: (floor, a) => agentRoster.registerAgent(floor, a),
        unregisterAgent: (floor, name) => agentRoster.unregisterAgent(floor, name),
        pollMs: 15_000,
      },
    });
    timers.push(poller.start());

    // Close hooks: stop non-timer resources in registration order.
    lifecycle.onClose(() => demo.stopAll());
    // Remote dispatch: kill any in-flight child before the HTTP/WS resources go away.
    lifecycle.onClose(() => dispatch.dispose());
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

    if (!opts.silent) {
      log.info(`[workgremlin] server listening on ${info.protocol}://${host}:${chosen} (db=${dbPath})`);
      if (!token) log.warn('[workgremlin] 已关闭 token 校验（--no-token，仅调试用）');
      const dispatchPolicy = dispatch.policy();
      log.info(
        `[workgremlin] 远程派发：${dispatchPolicy.mode}` +
          (dispatchPolicy.file ? `（配置文件 ${dispatchPolicy.file}，可随时修改，无需重启）` : '')
      );
      const cur = workspace.get();
      log.info(
        `[workgremlin] default workspace=${cur.workspacePath || workspacePath}` +
          ` (project=${cur.projectName || '(未命名工程)'})`
      );
    }
    return info;
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    lifecycle.beforeClose();
    await new Promise((resolve) => httpServer.close(() => resolve(null)));
    closeDb();
    // Keep the token for the next start; drop port/pid so nobody mistakes this for a live server.
    config.writeStoppedInfo(token);
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
