'use strict';

/**
 * Electron 主进程入口（client）。
 *
 * 关键设计：server 由启动器 scripts/launch.js 先行以独立进程启动（node server/src/cli.js），
 * 并写入 ~/.workgremlin/server.json；本进程只读取 server.json 连接该 server，**不自行启动 server**，
 * 也不依赖任何环境变量。server 的生命周期完全由 launch.js 管理。
 *
 * 启动顺序：app.ready -> 读 server.json 连接已起好的 server -> 建窗
 */

const { app, ipcMain, BrowserWindow, dialog, globalShortcut, screen } = require('electron');
const { createWindow, isDev } = require('./window');
const { buildMenu } = require('./menu');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { IPC_EVENTS } = require('@workgremlin/shared');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** 渲染层 / 建窗统一用的 server 信息（无论自起还是连接已有） */
let serverInfo = null;
/** 进原生全屏前的菜单栏可见性（退出时还原） */
let menuVisibleBeforeFs = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 ~/.workgremlin/server.json（与 server 包 config.home() 同规则） */
function readServerInfoFile() {
  const home = process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
    if (info && Number.isInteger(info.port) && typeof info.token === 'string') return info;
  } catch {}
  return null;
}

/** 轻量探活：127.0.0.1:port 是否有人监听 */
function pingPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => { clearTimeout(t); done(true); });
    s.once('error', () => { clearTimeout(t); done(false); });
  });
}

async function bootstrap() {
  await app.whenReady();

  // 演示模式**没有启动开关**（原来的 --demo / --demo-seed / WORKGREMLIN_DEMO* 都散了）：
  // 它由界面上的「演示模式」按钮切换工程触发（见 server 的 syncDemo），启动一律接真实数据。

  // server 由启动器(launch.js)先行启动并写入 server.json；client 只读取并连接，不自行启动 server。
  const existing = readServerInfoFile();
  if (existing && (await pingPort(existing.port))) {
    serverInfo = existing;
    console.log(`[workgremlin] 连接 server：port=${existing.port}`);
  } else {
    console.error('[workgremlin] 未找到可用 server（请先通过 launch.js 启动），退出');
    app.quit();
    return;
  }

  /**
   * 渲染层每次（重）连前都会来问一次当前 server 信息 —— **每次都重读 server.json**。
   *
   * server 每次启动都会换 token（见 server/src/config.js 的 newToken），如果这里只回
   * 启动那一刻缓存的那份，server 一重启渲染层就拿着旧 token 一直重连（服务端 close 4001
   * bad_token）+ 所有 HTTP 轮询 401，界面停在旧数据上不再更新（实测：任务列表里"运行中"
   * 的任务消失，只剩旧记录）。所以这里现读现给，读不到才退回缓存。
   */
  ipcMain.handle(IPC_EVENTS.GET_SERVER_INFO, () => {
    const fresh = readServerInfoFile();
    if (fresh) serverInfo = fresh;
    return serverInfo;
  });
  ipcMain.handle(IPC_EVENTS.GET_APP_VERSION, () => app.getVersion());

  // "打开工程"：系统目录选择框。取消返回 null（渲染层据此什么都不做）
  ipcMain.handle(IPC_EVENTS.CHOOSE_WORKSPACE, async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: '打开工程',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    return res.filePaths[0];
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
