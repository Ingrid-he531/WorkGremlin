'use strict';

const { app, Menu } = require('electron');

/**
 * 极简菜单：只在 macOS 设置（含"关于 WorkGremlin"，M3 需在此明示未公证提示）。
 * 其它平台保持无菜单，避免 M0 引入额外维护面。
 */
function buildMenu() {
  // 非 macOS：明确不要菜单栏。Electron 默认会塞一套 File/Edit/View/Window 菜单，
  // 全屏时尤其碍眼；menu.js 的设计口径本来就是"其它平台保持无菜单"，这里把它落实到底。
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return null;
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 WorkGremlin' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { buildMenu };
