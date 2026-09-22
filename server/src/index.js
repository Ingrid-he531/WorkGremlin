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
const { seedDemoData, createDemoTicker, DEMO_MEMBER_NAMES } = require('./mock/generator');
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
  app.use('/api/v1', requireToken(token), createIngestRouter({ bus }));

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

  if (opts.serveStatic) {
    app.use(express.static(path.resolve(opts.serveStatic)));
  }

  const timers = [];
  let info = null;
  let demoTicker = null;
  let subagentFeed = null;
  let agentRoster = null;
  /**
   * 演示数据（以及没打开工程时的幽灵/ticker）挂在哪个 project 上。
   * 用**保留名**（config.DEMO_PROJECT，带下划线，绝不可能和真实工程 slug 撞名），
   * 否则演示种子成员会混进同名的真实工程 project，办公室里一直挂着演示残留。
   */
  const demoProjectId = () => config.DEMO_PROJECT;

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
      project: cur.project || demoProjectId(),
      workspacePath: cur.workspacePath,
      projectName: cur.projectName,
      roster: agentRoster,
    });
    subagentFeed.start();
    return subagentFeed;
  }

  /**
   * 清理"演示残留"：老版本演示 project 的 id 就叫 workgremlin，和真实工程 slug 撞名，
   * 于是演示种子成员（leader / researcher / tester / reviewer / ops / ghost-*）被写进了
   * 真实工程的 project；演示 project 现已改用保留名（config.DEMO_PROJECT），这里把混进当前真实
   * 工程 project 的这些成员摘掉。
   *
   * 只清**演示种子名单里**的名字，且**跳过已被 agentRoster 管理的"已定义 subagent"**
   *（如 coder —— 那个名字现在代表真实成员，且由名册持续心跳，不能误删）。
   * 只动成员行/状态/任务，不删历史消息（见 repo.purgeMember）。
   */
  function purgeDemoLeftovers() {
    const cur = workspace.current();
    if (!cur.workspacePath || cur.demo || !cur.project || cur.project === config.DEMO_PROJECT) return 0;
    let n = 0;
    for (const m of repo.listMembers.all(cur.project) || []) {
      const name = m.name || String(m.id || '').split('@')[0];
      if (!DEMO_MEMBER_NAMES.has(name)) continue;
      if (agentRoster && agentRoster.isDefined(name)) continue;
      try {
        bus.removeMember({ project: cur.project, memberId: m.id });
        n += 1;
      } catch {
        /* 单个清不掉不影响别的 */
      }
    }
    if (n) console.log(`[workgremlin] 已清理 ${n} 个混进工程「${cur.projectName || cur.project}」的演示残留成员`);
    return n;
  }

  /**
   * 清演示工程里的"名册残留"：`role='subagent'` 里那些当前名册**不再定义**的成员行。
   *
   * 为什么需要：名册是这些成员行的主人，但它摘人靠**进程内记账**（registered / mine）——
   * 服务一重启那笔账就空了。于是上一轮注册进演示工程的成员（典型：旧版还会把"启动工程"的
   * 项目级 agent 扫进来，如本工程的 leo / susan）再没人认领、也没人心跳，
   * 60s 后被 sweep 标成 degraded —— 在办公室里就是"还在，但灰了"。
   *
   * 按名册自己的口径对账最可靠：`role='subagent'` 且 `agentRoster.isDefined(name)` 为假就摘。
   * 三类不碰：演示种子成员（leader / coder …，归 ensureDemoData）、主 agent 成员
   * （`role='agent'`，hook 上报、跟楼层走）、临时成员（ephemeral，归 subagentFeed）。
   */
  function purgeDemoStragglers() {
    // 名册没起来时 isDefined 不可信（会把用户级小怪物一起误摘），宁可不做
    if (!agentRoster) return 0;
    const project = demoProjectId();
    let n = 0;
    for (const m of repo.listMembers.all(project) || []) {
      if (m.ephemeral) continue;
      if (String(m.role || '') !== 'subagent') continue;
      const name = m.name || String(m.id || '').split('@')[0];
      if (DEMO_MEMBER_NAMES.has(name)) continue;
      if (agentRoster.isDefined(name)) continue;
      try {
        bus.removeMember({ project, memberId: m.id });
        n += 1;
      } catch {
        /* 单个清不掉不影响别的 */
      }
    }
    if (n) console.log(`[workgremlin] 已清理 ${n} 个不属于演示工程的小怪物（名册残留）`);
    return n;
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

    for (const t of timers) if (t.unref) t.unref();

    // 恢复上次打开的工程（没有就继续用 cwd / --workspace 解析出来的那个）
    const restored = workspace.restore();
    if (info) {
      info.projectName = restored.projectName;
      info.workspacePath = restored.workspacePath || workspacePath;
      config.writeServerInfo(info);
    }

    // 注意：演示数据的准备（syncDemo）不在这里 —— 它要对"哪些小怪物算已定义"，（见下）
    // 而那要等 agentRoster 起来之后才有准数，所以挪到名册 start() 之后。

    // 清理历史遗留：旧版 agentScan 注册的 "agent-<级别>-<id>" 成员已被 agentRoster 取代，
    // 但库里的旧行不会自动消失，会和 roster 的小怪物同名（出现"Peter/Leo 各两只"）。这里一次性删掉。
    try {
      const legacy = repo
        .listMembers.all(demoProjectId())
        .filter((m) => /^agent-(user|project)-/.test(m.id));
      for (const m of legacy) bus.removeMember({ project: demoProjectId(), memberId: m.id });
    } catch {
      /* 清理失败不影响启动 */
    }

    // 常驻小怪物名册：把已定义的 subagent（项目级 + 用户级）注册成坐工位、带工牌的小怪物。
    // 当前工程路径优先，回退到服务启动时解析的工程（演示模式下也能扫到项目级 agent）。
    // 必须在 startFeed() 之前创建：被召唤时由 subagentFeed 同步小怪物工位状态。
    agentRoster = createAgentRoster({
      bus,
      // 小怪物跟随"当前打开的工程"的 project（不再固定写死演示 project），换工程才跟得过去
      getProject: () => workspace.current().project || config.DEMO_PROJECT,
      // 只认**当前工程**的路径，不回退到"服务启动时解析出来的工程"：
      // 演示工程没有目录（workspacePath === ''），名册于是只列**用户级** agent ——
      // 项目级小怪物属于某个真实目录，而切到演示工程后屋里演的是演示团队，
      // 那几个"本工程的 agent"不该跟着飘进来（它们并不属于演示工程）。
      getWorkspacePath: () => workspace.current().workspacePath,
    });
    // 换工程：重启 subagent 清单监听（幽灵）+ 同步小怪物名册 + 清掉混进来的演示残留。
    // 已定义 subagent 的"小怪物"只由 agentRoster 注册一次，避免同名两只。
    workspace.setOnSwitch(() => {
      startFeed();
      agentRoster.sync();
      purgeDemoLeftovers();
      // 切工程即决定"演示要不要活着"：进演示就按需播种 + 起推进器，离开就停
      syncDemo(workspace.current().demo);
    });
    startFeed();
    agentRoster.start();
    // 名册起来之后才有"已定义"的准数（syncDemo 的对账要用它），所以演示的准备放这里：
    // 上次停在演示工程 → 这回启动照旧是演示，播种 / 心跳 / 残留清理都交给它。
    syncDemo(Boolean(restored.demo));
    // 启动时也清一遍：老版本撞名留下的演示残留
    purgeDemoLeftovers();

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

  /**
   * 演示推进器随「当前工程是不是演示工程」起停。
   *
   * 演示模式**没有启动开关**了（原来靠 `--demo` / `WORKGREMLIN_DEMO=1` / `MOCK=1`）：
   * 它现在由界面上的「演示模式」按钮切换工程触发（POST /api/v1/workspace 走空路径 → openDemo）。
   *   - 进演示：库里还没有演示数据就先播一次种，再起推进器 —— 没有推进器的话，60s 后
   *     所有成员都因心跳超时变 degraded，界面一片灰，而演示恰恰要看"活着"的样子；
   *   - 离开演示：停掉推进器，别对着演示工程空转（真实工程的成员由 hook / roster 驱动）。
   */
  function syncDemo(on) {
    if (!on) {
      if (demoTicker) {
        demoTicker.stop();
        demoTicker = null;
      }
      return;
    }
    // 每次进演示都对一次账：名册摘人靠**进程内记账**，服务一重启那笔账就空了，
    // 只有按"名册自己的口径"对账才清得掉上一轮留下的成员（见 purgeDemoStragglers）。
    purgeDemoStragglers();
    if (demoTicker) return;
    ensureDemoData();
    demoTicker = createDemoTicker({ bus, repo, project: demoProjectId(), seed: 1 });
    demoTicker.start();
  }

  /** 演示工程里一条消息都没有时才播种；已有数据就沿用，反复进出演示不会把消息越堆越多 */
  function ensureDemoData() {
    const project = demoProjectId();
    const existing = /** @type {{ c?: number } | undefined} */ (repo.countMessages.get(project));
    if (existing && existing.c > 0) return;
    try {
      seedDemoData({
        bus,
        seed: 1,
        project,
        // 演示数据是一条独立的「演示工程」：绑到某个目录的话，打开这个目录就会看到这 8 个模拟成员，
        // 还以为"打开工程没生效"。演示工程只通过"切到演示工程"进入。
        workspacePath: '',
      });
    } catch (err) {
      // 播种失败不能拖垮切换本身（切工程照旧发生，只是屋里空着）
      console.warn('[workgremlin] 演示数据播种失败（不影响真实数据）：', err && err.message);
    }
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
