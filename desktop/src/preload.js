'use strict';

/**
 * 预加载脚本：只暴露**受限** API 给渲染层（contextIsolation = true, nodeIntegration = false）。
 * 渲染层拿不到 ipcRenderer 原始对象，只能调用下面这几个方法。
 */

const { contextBridge, ipcRenderer } = require('electron');
const { IPC_EVENTS } = require('@workgremlin/shared');

const listeners = new Set();
const fullScreenListeners = new Set();

ipcRenderer.on(IPC_EVENTS.FULL_SCREEN_EVENT, (_evt, on) => {
  for (const cb of fullScreenListeners) {
    try {
      cb(Boolean(on));
    } catch {
      /* 单个监听器异常不影响其他监听器 */
    }
  }
});

ipcRenderer.on(IPC_EVENTS.EVENT, (_evt, payload) => {
  for (const cb of listeners) {
    try {
      cb(payload);
    } catch {
      /* 单个监听器异常不影响其他监听器 */
    }
  }
});

contextBridge.exposeInMainWorld('workgremlin', {
  /** @returns {Promise<{port:number, token:string, dbPath:string, version:string}|null>} */
  getServerInfo: () => ipcRenderer.invoke(IPC_EVENTS.GET_SERVER_INFO),
  getAppVersion: () => ipcRenderer.invoke(IPC_EVENTS.GET_APP_VERSION),
  /** 弹出系统目录选择框；取消返回 null @returns {Promise<string|null>} */
  chooseWorkspace: () => ipcRenderer.invoke(IPC_EVENTS.CHOOSE_WORKSPACE),
  /** @param {(payload: any) => void} cb @returns {() => void} 取消订阅 */
  onEvent: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  /**
   * 原生（OS 级）全屏：会连窗口菜单和边框一起去掉。
   * @param {boolean} on @returns {Promise<boolean>} 切换后的实际状态
   */
  setFullScreen: (on) => ipcRenderer.invoke(IPC_EVENTS.SET_FULL_SCREEN, Boolean(on)),
  /** @returns {Promise<boolean>} 窗口当前是否处于原生全屏 */
  isFullScreen: () => ipcRenderer.invoke(IPC_EVENTS.IS_FULL_SCREEN),
  /** @param {(on: boolean) => void} cb @returns {() => void} 取消订阅 */
  onFullScreen: (cb) => {
    fullScreenListeners.add(cb);
    return () => fullScreenListeners.delete(cb);
  },
  /** 退出整个应用 */
  quit: () => ipcRenderer.invoke(IPC_EVENTS.QUIT),
  /** @param {string} url 用系统默认程序打开的外部链接 @returns {Promise<boolean>} */
  openExternal: (url) => ipcRenderer.invoke(IPC_EVENTS.OPEN_EXTERNAL, url),
});
