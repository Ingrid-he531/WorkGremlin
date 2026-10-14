#!/usr/bin/env node
/**
 * Dev launcher: start Vite (renderer, 5173) and Electron in parallel. The Electron entry is
 * desktop/src/launcher.js, which uses Electron's bundled Node to start the server, then the client
 * (dev mode loads the Vite URL).
 * Usage:
 *   npm run dev                 connect to the real data source
 *
 * There is no startup flag for demo mode anymore (the old `--demo` / `--demo-seed` / WORKGREMLIN_DEMO*
 * were removed): once it is up, click "Demo mode" on the office HUD (left of "Gather for a meeting")
 * to switch to the demo project.
 *
 * Extra command-line arguments are passed through to the Electron main process (and on to the embedded server).
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

const children = [];

function run(name, cmd, args, opts = {}) {
  // Note: opts may carry env; it must be **pulled out and merged with process.env first**, then the
  // remaining options spread — otherwise `...opts` overwrites env wholesale and the child loses
  // DISPLAY/XAUTHORITY (Electron won't start).
  const { env: extraEnv = {}, ...restOpts } = opts;
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWin,
    env: { ...process.env, ...extraEnv },
    ...restOpts,
  });
  const tag = `[${name}]`;
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) console.log(`${tag} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.log(`${tag} exited code=${code} signal=${signal}`);
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const extra = process.argv.slice(2);
// Call the electron in node_modules/.bin directly: when run via `npm run start`, the child's PATH may not include .bin
const electronBin = path.join(
  root,
  'node_modules',
  '.bin',
  isWin ? 'electron.cmd' : 'electron'
);

// In dev, always connect to the real data source; demo mode is switched in the UI (see the header).
run('vite', npm, ['run', 'dev', '--workspace', '@workgremlin/renderer']);
run('electron', electronBin, [path.join('desktop', 'src', 'launcher.js'), ...extra], {
  env: { WORKGREMLIN_DEV: '1' },
});
