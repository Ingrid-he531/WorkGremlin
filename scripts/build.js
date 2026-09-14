#!/usr/bin/env node
/**
 * M0 的 "build"：只构建 renderer 静态资源，供 Electron 以 file:// 加载。
 * M3 再接入 electron-builder 产出安装包。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const res = spawnSync(npm, ['run', 'build', '--workspace', '@workgremlin/renderer'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(res.status ?? 1);
