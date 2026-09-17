'use strict';

const path = require('node:path');
const { BrowserWindow } = require('electron');

const isDev = process.env.WORKGREMLIN_DEV === '1' || process.env.NODE_ENV === 'development';
const DEV_URL = process.env.WORKGREMLIN_RENDERER_URL || 'http://127.0.0.1:5173';
const RENDERER_DIST = path.resolve(__dirname, '..', '..', 'renderer', 'dist');

/**
 * 创建主窗口。dev 走 Vite dev server，prod 走 renderer/dist/index.html。
 * @param {{serverInfo?: any}} [opts]
 */
function createWindow(opts = {}) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'WorkGremlin',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: opts.serverInfo
        ? [`--workgremlin-port=${opts.serverInfo.port}`, `--workgremlin-token=${opts.serverInfo.token}`]
        : [],
    },
  });

  /**
   * 显示主窗口。注意：**不能只依赖 ready-to-show** ——
   * Wayland / 部分 WM 下 Electron 38 可能永远不触发该事件，导致主窗口一直隐藏
   * （表现就是"只看到 DevTools 窗口"）。因此三条路径都指向 showOnce。
   */
  let shown = false;
  const showOnce = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    win.focus();
    if (process.env.WORKGREMLIN_DEBUG_WINDOW === '1') {
      console.log('[workgremlin] window shown visible=', win.isVisible(), JSON.stringify(win.getBounds()));
    }
  };

  win.once('ready-to-show', showOnce);
  win.webContents.once('did-finish-load', showOnce);
  const showTimer = setTimeout(showOnce, 1500);
  win.once('closed', () => clearTimeout(showTimer));

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[workgremlin] 渲染进程加载失败', code, desc, url);
  });

  if (isDev) {
    // 把渲染进程 console 打到主进程日志，便于远程/无头排查
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const L = ['verbose', 'info', 'warning', 'error'][level] || String(level);
      console.log(`[renderer:${L}] ${message} (${sourceId}:${line})`);
    });
    let devTries = 0;
    const MAX_DEV_TRIES = 60;
    win.webContents.once('did-finish-load', () => {
      console.log('[workgremlin] renderer did-finish-load');
    });
    // dev 下 Vite 常比窗口晚就绪：加载失败就重试，否则窗口会停在
    // ERR_CONNECTION_REFUSED 的空白错误页（表现成"黑屏、没有控件"）
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[workgremlin] 渲染进程加载失败', code, desc, url);
      if (devTries < MAX_DEV_TRIES) {
        devTries += 1;
        setTimeout(() => win.loadURL(DEV_URL), 500);
      }
    });

    win.loadURL(DEV_URL);
    // 默认打开独立 DevTools；不想要就 WORKGREMLIN_DEVTOOLS=0（仍可用 Ctrl/Cmd+Shift+I 呼出）
    if (process.env.WORKGREMLIN_DEVTOOLS !== '0') win.webContents.openDevTools({ mode: 'detach' });
    // 无头/远程排查用：WORKGREMLIN_DEBUG_WINDOW=1 会在 3 秒后截一张图到 /tmp
    if (process.env.WORKGREMLIN_DEBUG_WINDOW === '1') {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          require('node:fs').writeFileSync('/tmp/wg-screen.png', img.toPNG());
          console.log('[workgremlin] screenshot -> /tmp/wg-screen.png');
        } catch (err) {
          console.error('[workgremlin] screenshot failed', err && err.message);
        }
      }, 8000);
    }
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }

  return win;
}

module.exports = { createWindow, isDev, DEV_URL, RENDERER_DIST };
