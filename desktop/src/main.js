'use strict';

/**
 * Electron 主进程入口。
 *
 * 关键设计：本地服务 **内嵌在主进程里**（同进程），不额外 fork 子进程 —— 免端口/生命周期管理，
 * 也没有跨进程序列化开销。server 包同时保留独立启动能力（node server/src/cli.js）。
 *
 * 启动顺序：app.ready -> createServer().start() -> 写 ~/.workgremlin/server.json -> 建窗
 */

const { app, ipcMain, BrowserWindow, globalShortcut } = require('electron');
const { createServer } = require('@workgremlin/server');
const { createWindow, isDev } = require('./window');
const { buildMenu } = require('./menu');

/** @type {ReturnType<typeof createServer> | null} */
let server = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;

const flags = {
  demo: process.argv.includes('--demo') || process.env.WORKGREMLIN_DEMO === '1' || process.env.MOCK === '1',
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

  buildMenu();
  mainWindow = createWindow({ serverInfo: info });

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
