'use strict';

/**
 * Electron 主进程入口。
 *
 * 关键设计：本地服务 **内嵌在主进程里**（同进程），不额外 fork 子进程 —— 免端口/生命周期管理，
 * 也没有跨进程序列化开销。server 包同时保留独立启动能力（node server/src/cli.js）。
 *
 * 启动顺序：app.ready -> createServer().start() -> 写 ~/.workgremlin/server.json -> 建窗
 */

const { app, ipcMain, BrowserWindow, dialog, globalShortcut, screen } = require('electron');
const { createServer } = require('@workgremlin/server');
const { createWindow, isDev } = require('./window');
const { buildMenu } = require('./menu');

/** @type {ReturnType<typeof createServer> | null} */
let server = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** 进原生全屏前的菜单栏可见性（退出时还原） */
let menuVisibleBeforeFs = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const flags = {
  demo: process.argv.includes('--demo'),
  seed: (() => {
    const i = process.argv.indexOf('--demo-seed');
    return i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.WORKGREMLIN_DEMO_SEED || 1);
  })(),
};

async function bootstrap() {
  await app.whenReady();

  server = createServer({
    demo: flags.demo,
    seed: Number.isFinite(flags.seed) ? flags.seed : 1,
  });

  const info = await server.start();

  ipcMain.handle('workgremlin:get-server-info', () => server && server.info);
  ipcMain.handle('workgremlin:get-app-version', () => app.getVersion());
  ipcMain.handle('workgremlin:get-flags', () => ({ ...flags, userDataDir: app.getPath('userData') }));

  // "打开工程"：系统目录选择框。取消返回 null（渲染层据此什么都不做）
  ipcMain.handle('workgremlin:choose-workspace', async () => {
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
  ipcMain.handle('workgremlin:set-full-screen', async (_e, on) => {
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

  ipcMain.handle('workgremlin:is-full-screen', () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    return win && !win.isDestroyed() ? win.isFullScreen() : false;
  });

  buildMenu();
  mainWindow = createWindow({ serverInfo: info });

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

app.on('window-all-closed', async () => {
  if (server) await server.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) {
    mainWindow = createWindow({ serverInfo: server.info });
  }
});

app.on('before-quit', async () => {
  if (server) await server.close();
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
