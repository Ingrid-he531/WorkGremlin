'use strict';

/**
 * 打包产物（AppImage / deb / dmg）的 Electron 主进程入口。
 *
 * 背景：AppImage 内没有 `node` 命令，故由 Electron 主进程自己承担「起 server + 起 client」；
 * 所以由 Electron 主进程自己承担「起 server + 起 client」：
 *   1. 用 AppImage 自带的 Electron（process.execPath）起 server 子进程（server/src/cli.js）
 *   2. 等 server 就绪（探活 server.json 里的端口）
 *   3. require('./main') —— 复用 main.js 的全部 client 逻辑（建窗 / IPC / 菜单 / 全屏）
 *
 * dev 模式（npm run dev / npm run launch:electron）也走这里：Electron 主进程用内置 Node 起
 * server + 复用 main.js 的 client，不依赖 scripts/launch.js。
 *
 * 参数：
 *   --restart   不管有没有在跑的 server，**先停掉旧的再起新的**（改了 server 代码后常用；
 *               不传的话，端口通就直接复用旧进程，改的代码不会生效）。
 *               用法：npm run launch:electron -- --restart
 *   其余 --no-sandbox / --disable-* 透传给 server 子进程（见 passthroughFlags）。
 */
const { app } = require('electron');
const net = require('node:net');
const { spawn } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const { home } = require('@workgremlin/shared');
const { remoteConfig, isClientBuild } = require('./remoteConfig');

const HOME = home();
const SERVER_JSON = path.join(HOME, 'server.json');
// 打包后指向 asar 内的项目根；dev 下指向项目根。
// 注意：Electron 以 `electron <file.js>` 启动时 app.getAppPath() 只返回该文件所在目录
// （不会向上找 package.json），dev 下直接跑 launcher.js 会算成 desktop/src，导致 server
// 路径错误。故这里向上找到含 workspaces 的仓库根；asar 内无 workspaces 字段时回退到
// app.getAppPath()，打包行为不变。
function findRepoRoot(from) {
  let dir = from;
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (Array.isArray(pkg.workspaces)) return dir;
    } catch {
      /* 读不到/无 workspaces：继续向上 */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return from;
}

const ROOT = findRepoRoot(app.getAppPath());

function readServerInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8'));
    if (j && Number.isInteger(j.port) && typeof j.token === 'string') return j;
  } catch {}
  return null;
}

function pingPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => { clearTimeout(t); done(true); });
    s.once('error', () => { clearTimeout(t); done(false); });
  });
}

function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await predicate()) return resolve(true);
      if (Date.now() - start >= timeoutMs) {
        console.error(`[launcher] 等待超时：${label}`);
        return resolve(false);
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

// 把 client 收到的 sandbox/headless 类 flag（--no-sandbox / --disable-*）透传给 server 子进程。
// 否则在多 sandbox 受限的环境里，client 关了 sandbox 但 server 仍走默认 sandbox 会起不来，
// 表现为 launcher 等 15s 超时后退出（"没法启动"）。
function passthroughFlags() {
  return process.argv
    .slice(2)
    .filter((a) => a.startsWith('--no-sandbox') || a.startsWith('--disable-'));
}

/** 本次要不要重启 server（--restart） */
const WANT_RESTART = process.argv.includes('--restart');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 信号 0：只探测在不在
    return true;
  } catch {
    return false;
  }
}

function dropServerInfo() {
  try {
    // Keep the token across a --restart, but drop port/pid: the token is what remote clients
    // were given, and it must not rotate just because the development server was restarted.
    const info = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8'));
    if (info && typeof info.token === 'string' && info.token) {
      fs.writeFileSync(SERVER_JSON, JSON.stringify({ token: info.token, stoppedAt: Date.now() }, null, 2), {
        mode: 0o600,
      });
      try {
        fs.chmodSync(SERVER_JSON, 0o600);
      } catch {
        /* ignore */
      }
      return;
    }
  } catch {
    /* missing / corrupt file: fall through to deletion */
  }
  try {
    fs.rmSync(SERVER_JSON, { force: true });
  } catch {
    /* 删不掉就算了，后面还会 ping 端口判活 */
  }
}

/**
 * 停掉在跑的 server（--restart 用）：先 SIGTERM 让它走正常收尾（它会自己写回 token、
 * 关库、停钩子），等它退；超时就 SIGKILL 兜底，再把残留的 server.json 的 port/pid 清掉 ——
 * 不清的话下面会把它当成"已有可用 server"，新代码起不来；token 保留，远程客户端不用重配。
 */
async function stopServer(info) {
  const pid = info && Number.isInteger(info.pid) ? info.pid : 0;
  if (!pid || !pidAlive(pid)) {
    dropServerInfo();
    return;
  }
  console.log(`[launcher] --restart：停掉旧 server（pid ${pid}）`);
  try {
    if (process.platform === 'win32') {
      // Windows 没有进程组信号，用 taskkill 连子进程一起收
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* 已经没了 */
  }
  const port = Number(info.port);
  const hasPort = Number.isInteger(port) && port > 0;
  await waitFor(async () => !pidAlive(pid) || (hasPort && !(await pingPort(port))), 5000, '旧 server 退出');
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退了 */
    }
  }
  dropServerInfo();
}

function startServer() {
  // Use Electron's bundled Node (not a system node) so a packaged AppImage needs no Node install.
  // Serve the built renderer as well, so the same server can be opened from a browser on another
  // machine while the local Electron window keeps using it. Missing dist (dev before the first
  // build) simply leaves browser mode off; the desktop window still loads the Vite URL in dev.
  const staticDir = path.join(ROOT, 'renderer', 'dist');
  const serveStatic = fs.existsSync(path.join(staticDir, 'index.html'));

  const args = [...passthroughFlags(), path.join(ROOT, 'server/src/cli.js')];
  if (serveStatic) args.push('--static', staticDir);
  if (serveStatic) console.log(`[launcher] 同时提供浏览器 UI：${staticDir}`);

  // Host / port / TLS come from ~/.workgremlin/config.json's "server" section (read by cli.js),
  // so `npm run launch:electron -- --restart` is the same command for local and remote use.
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

app.whenReady().then(async () => {
  // Remote mode (see remoteConfig.js): the window is a thin client for a server on another
  // machine, so starting a local server would only add a second, unused instance. The same holds
  // for the client-only package, which ships no server at all: let main.js handle (and explain)
  // a missing target instead of spawning a CLI that is not there.
  const remote = remoteConfig();
  if (remote || isClientBuild(app.getAppPath())) {
    if (remote) console.log(`[launcher] 远程模式：${remote.host}:${remote.port}（不启动本地 server）`);
    require('./main');
    return;
  }

  let existing = readServerInfo();
  if (WANT_RESTART) {
    await stopServer(existing);
    existing = null; // 旧的已经停了，下面必须重新起
  }
  if (!existing || !(await pingPort(existing.port))) {
    console.log('[launcher] 启动 server...');
    startServer();
    if (!(await waitFor(async () => {
      const info = readServerInfo();
      return Boolean(info && (await pingPort(info.port)));
    }, 15000, 'server 就绪'))) {
      process.exit(1);
    }
    console.log('[launcher] server 已就绪');
  } else {
    console.log('[launcher] 复用已有 server');
  }
  // 委托 main.js 负责 client（建窗 / IPC / 菜单 / 全屏），它读 server.json 连接已就绪的 server
  require('./main');
});
