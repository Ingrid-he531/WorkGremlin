'use strict';

/**
 * 预加载脚本：只暴露**受限** API 给渲染层（contextIsolation = true, nodeIntegration = false）。
 * 渲染层拿不到 ipcRenderer 原始对象，只能调用下面这几个方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

ipcRenderer.on('workgremlin:event', (_evt, payload) => {
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
  getServerInfo: () => ipcRenderer.invoke('workgremlin:get-server-info'),
  getAppVersion: () => ipcRenderer.invoke('workgremlin:get-app-version'),
  getFlags: () => ipcRenderer.invoke('workgremlin:get-flags'),
  /** @param {(payload: any) => void} cb @returns {() => void} 取消订阅 */
  onEvent: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
});
