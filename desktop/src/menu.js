'use strict';

const { app, Menu } = require('electron');

/**
 * 极简菜单：只在 macOS 设置（含"关于 WorkGremlin"，M3 需在此明示未公证提示）。
 * 其它平台保持无菜单，避免 M0 引入额外维护面。
 */
function buildMenu() {
  if (process.platform !== 'darwin') return null;
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
