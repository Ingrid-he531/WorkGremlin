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
 */
const { app } = require('electron');
const net = require('node:net');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
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

function startServer() {
  // 用 AppImage 自带的 Electron 跑 server（不是系统 node）；asar 内脚本可作为 electron 入口
  const child = spawn(
    process.execPath,
    [...passthroughFlags(), path.join(ROOT, 'server/src/cli.js')],
    {
      cwd: ROOT,
      env: { ...process.env },
      stdio: 'ignore',
      detached: true,
    }
  );
  child.unref();
}

app.whenReady().then(async () => {
  const existing = readServerInfo();
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
