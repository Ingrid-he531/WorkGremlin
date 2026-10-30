'use strict';

/**
 * Electron 主进程入口（client）。
 *
 * 关键设计：server 由 launcher（desktop/src/launcher.js，Electron 主进程入口）先行以独立进程
 * 启动（electron server/src/cli.js，即 Electron 内置 Node 跑），并写入 ~/.workgremlin/server.json；
 * 本进程只读取 server.json 连接该 server，**不自行启动 server**。
 * server 的内存持久由 launcher 管理（detached，应用退出不随之退出）。
 *
 * 启动顺序：app.ready -> 读 server.json 连接已起好的 server -> 建窗
 *
 * Exception: when a remote target is configured (see remoteConfig.js), the window connects to a
 * server running elsewhere, does not read server.json and never expects a local server. The
 * remote token is fixed, so it is handed to the renderer as-is instead of re-read per reconnect.
 */

const { app, ipcMain, BrowserWindow, dialog, globalShortcut, screen, shell, session } = require('electron');
const { createWindow, isDev } = require('./window');
const { buildMenu } = require('./menu');
const { remoteConfig, isClientBuild } = require('./remoteConfig');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { IPC_EVENTS, home: wgHome } = require('@workgremlin/shared');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** 渲染层 / 建窗统一用的 server 信息（无论自起还是连接已有） */
let serverInfo = null;
/** 进原生全屏前的菜单栏可见性（退出时还原） */
let menuVisibleBeforeFs = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 ~/.workgremlin/server.json（与 server 包 config.home() 同规则） */
function readServerInfoFile() {
  const home = wgHome();
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
    if (info && Number.isInteger(info.port) && typeof info.token === 'string') return info;
  } catch {}
  return null;
}

/** 轻量探活：host:port 是否有人监听 */
function pingPort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => { clearTimeout(t); done(true); });
    s.once('error', () => { clearTimeout(t); done(false); });
  });
}

/**
 * Trust exactly the certificate the local server reported in server.json.
 *
 * A self-signed certificate is fine for loopback, but Chromium refuses it, which would break the
 * local window as soon as `server.tls` is enabled. Matching the SHA-256 fingerprint keeps that
 * window working without disabling certificate checks for any other HTTPS request.
 *
 * @param {{protocol?: string, tlsFingerprint?: string}|null} info
 */
function trustServerCertificate(info) {
  if (!info || String(info.protocol || '').toLowerCase() !== 'https' || !info.tlsFingerprint) return;
  const expected = String(info.tlsFingerprint).replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!expected) return;
  try {
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      try {
        const cert = request && request.certificate;
        if (cert && cert.data) {
          const actual = new crypto.X509Certificate(cert.data)
            .fingerprint256.replace(/[^0-9a-f]/gi, '')
            .toUpperCase();
          if (actual === expected) return callback(0);
        }
      } catch {
        /* fall through to Chromium's normal verification */
      }
      return callback(-3);
    });
    console.log('[workgremlin] 已信任本地 server 的 TLS 证书指纹');
  } catch (err) {
    console.warn('[workgremlin] 无法安装本地证书信任：', err && err.message);
  }
}

async function bootstrap() {
  await app.whenReady();

  // Demo mode has no startup switch (the old --demo / --demo-seed / WORKGREMLIN_DEMO* flags are
  // gone). It is a read-only virtual session started from the office HUD via
  // /api/v1/demo/session; startup always opens real data.

  const remote = remoteConfig();

  // Client-only package: there is no server inside it, so a missing target must be explained
  // instead of silently quitting (a portable exe has no console to read).
  if (!remote && isClientBuild(app.getAppPath())) {
    dialog.showErrorBox(
      'WorkGremlin Client',
      '没有找到远程服务配置。\n\n' +
        '在与本程序相同的目录放一个 client.json：\n\n' +
        '{\n  "host": "192.168.1.5",\n  "port": 21800,\n  "token": "<服务端 server.json 里的 token>"\n}\n\n' +
        '也可以改用环境变量 WORKGREMLIN_REMOTE=host:port 与 WORKGREMLIN_REMOTE_TOKEN。'
    );
    app.quit();
    return;
  }

  if (remote) {
    // Remote mode: no local server.json, no local server. Only the fixed target + token are needed;
    // the token cannot rotate under us, so re-reading it per reconnect (below) does not apply.
    if (!(await pingPort(remote.host, remote.port))) {
      console.error(`[workgremlin] 远程 server 不可达：${remote.host}:${remote.port}，退出`);
      app.quit();
      return;
    }
    serverInfo = { host: remote.host, port: remote.port, token: remote.token, version: 'remote' };
    console.log(`[workgremlin] 连接远程 server：host=${remote.host} port=${remote.port}`);
    if (isDev) {
      console.warn('[workgremlin] dev 模式下窗口仍由本地 Vite 提供，远程模式请先用 npm run build 再启动');
    }
  } else {
    // server 由 launcher（desktop/src/launcher.js）先行启动并写入 server.json；client 只读取并连接，不自行启动 server。
    const existing = readServerInfoFile();
    if (existing && (await pingPort('127.0.0.1', existing.port))) {
      serverInfo = existing;
      console.log(`[workgremlin] 连接 server：port=${existing.port}`);
    } else {
      console.error('[workgremlin] 未找到可用 server（请先通过 npm run dev / npm run launch:electron 启动），退出');
      app.quit();
      return;
    }
  }

  trustServerCertificate(serverInfo);

  /**
   * 渲染层每次（重）连前都会来问一次当前 server 信息 —— **每次都重读 server.json**。
   *
   * token 会在 --rotate-token 时更换（正常重启复用同一个 token），如果这里只回启动那一刻
   * 缓存的那份，服务端轮换 token 后渲染层就拿着旧 token 一直重连（服务端 close 4001
   * bad_token）+ 所有 HTTP 轮询 401，界面停在旧数据上不再更新（实测：任务列表里"运行中"
   * 的任务消失，只剩旧记录）。所以这里现读现给，读不到才退回缓存。
   *
   * 远程模式下跳过：目标地址和 token 都由配置固定，不存在"本地 server 重启换了 token"这回事。
   */
  ipcMain.handle(IPC_EVENTS.GET_SERVER_INFO, () => {
    if (remote) return serverInfo;
    const fresh = readServerInfoFile();
    if (fresh) serverInfo = fresh;
    return serverInfo;
  });
  // 应用版本号：直接读**仓库根** package.json。monorepo 下 desktop 子包也有自己的 version，
  // 而 Electron 的 app.getVersion() 在 dev 启动（electron desktop/src/main.js）时会回退到
  // Electron 自身版本（38.8.6），不可靠 —— 故显式读根目录文件，与设置面板口径一致。
  function readAppVersion() {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')
      );
      if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      /* 读不到就退回 Electron 口径 */
    }
    return app.getVersion();
  }

  ipcMain.handle(IPC_EVENTS.GET_APP_VERSION, () => readAppVersion());

  // 构建信息（设置面板展示）：应用版本 + 最近 commit 短 sha + Electron / Node 运行时版本。
  // commit 在打包产物里没有 .git 会取不到，回退空串，渲染层据此决定要不要加括号。
  ipcMain.handle(IPC_EVENTS.GET_BUILD_INFO, () => {
    let commit = '';
    try {
      commit = execSync('git rev-parse --short=8 HEAD', {
        cwd: path.resolve(__dirname, '..', '..'),
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
    } catch {
      /* 无 .git（打包产物）或 git 不可用：commit 留空 */
    }
    return {
      version: readAppVersion(),
      commit,
      electron: process.versions.electron || '',
      node: process.versions.node || '',
    };
  });

  // 退出整个应用（设置面板里的「退出 WorkGremlin」）
  ipcMain.handle(IPC_EVENTS.QUIT, () => {
    app.quit();
  });

  // 用系统默认程序打开外部链接（不会在应用内嵌网页）；失败返回 false
  ipcMain.handle(IPC_EVENTS.OPEN_EXTERNAL, async (_e, url) => {
    try {
      await shell.openExternal(String(url || ''));
      return true;
    } catch {
      return false;
    }
  });

  /**
   * 原生（OS 级）全屏：窗口占满整屏，标题栏/边框/菜单栏一起没掉 —— 只有主舞台留着。
   * 渲染层那套"专注模式"（收自家顶栏与左栏）跟着它一起走，见 App.vue。
   */
  ipcMain.handle(IPC_EVENTS.SET_FULL_SCREEN, async (_e, on) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win || win.isDestroyed()) return false;
    const want = Boolean(on);
    if (win.isFullScreen() === want) return want;
    if (want) {
      // 记下进全屏前的菜单栏可见性，退出时还回去（macOS 才可能有；其它平台菜单已整体置空）
      menuVisibleBeforeFs = win.isMenuBarVisible();
      win.setMenuBarVisibility(false);
    }

    win.setFullScreen(want);
    // setFullScreen 是异步生效的，等一拍验证；某些 WM（Wayland 的部分合成器）下它是空操作
    await sleep(400);
    if (win.isDestroyed()) return false;
    if (win.isFullScreen() !== want) {
      console.log('[workgremlin] fullscreen: setFullScreen 未生效，改试 kiosk');
      win.setKiosk(want);
      await sleep(400);
    }
    if (want && win.isFullScreen() !== want) {
      // 最后一招：手动铺满整屏并置顶（标题栏可能还在，但至少占满屏幕）
      console.log('[workgremlin] fullscreen: kiosk 也未生效，退回手动铺满');
      win.setBounds(screen.getPrimaryDisplay().bounds);
      win.setAlwaysOnTop(true);
    }
    if (!want) {
      win.setKiosk(false);
      win.setAlwaysOnTop(false);
      if (menuVisibleBeforeFs) win.setMenuBarVisibility(true);
    }
    console.log(`[workgremlin] fullscreen: want=${want} isFullScreen=${win.isFullScreen()}`);
    return win.isFullScreen();
  });

  ipcMain.handle(IPC_EVENTS.IS_FULL_SCREEN, () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    return win && !win.isDestroyed() ? win.isFullScreen() : false;
  });

  /**
   * Bring the window forward when a remote dispatch request needs a decision on this machine.
   * Flash the taskbar/dock too: the operator may be looking at another app, and a pending request
   * expires (5 minutes) rather than sitting there forever.
   */
  ipcMain.handle(IPC_EVENTS.FOCUS_WINDOW, () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.flashFrame(true);
      setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.flashFrame(false);
        } catch {
          /* window closed meanwhile */
        }
      }, 8000).unref?.();
    } catch {
      return false;
    }
    return true;
  });

  buildMenu();
  mainWindow = createWindow({ serverInfo });

  /** 退出原生全屏时把菜单栏恢复成进去之前的样子 */
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed() && menuVisibleBeforeFs) {
      mainWindow.setMenuBarVisibility(true);
    }
  });

  // Linux 无菜单栏，DevTools 快捷键不会自动注册；dev 下手动挂一个，
  // 这样即使关掉自动弹出的 DevTools 也能随时呼出。
  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const w = BrowserWindow.getFocusedWindow();
      if (w) w.webContents.toggleDevTools();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverInfo) {
    mainWindow = createWindow({ serverInfo });
  }
});

// 单实例锁：避免重复启动争抢端口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  bootstrap().catch((err) => {
    console.error('[workgremlin] 启动失败：', err);
    app.quit();
  });
}
