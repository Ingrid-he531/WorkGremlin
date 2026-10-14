#!/usr/bin/env node
/**
 * M0 "build": build only the renderer static assets, for Electron to load over file://.
 * M3 will wire in electron-builder to produce installers.
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
