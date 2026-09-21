#!/usr/bin/env node
/**
 * 开发启动器：并行拉起 Vite（renderer, 5173）与 Electron（desktop）。
 * 用法：
 *   npm run dev                 接真实数据源
 *
 * 演示模式没有启动开关了（原 `--demo` / `--demo-seed` / WORKGREMLIN_DEMO* 已移除）：
 * 起完之后在办公室的 HUD 上点「演示模式」（集合开会左边）切到演示工程。
 *
 * 额外的命令行参数会透传给 Electron 主进程（进而传给内嵌 server）。
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

const children = [];

function run(name, cmd, args, opts = {}) {
  // 注意：opts 里可能带 env，必须**先拆出来与 process.env 合并**再展开其余选项，
  // 否则 `...opts` 会把 env 整体覆盖掉，子进程丢失 DISPLAY/XAUTHORITY（Electron 起不来）。
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
    if (code !== 0 && code !== null) console.log(`${tag} 退出 code=${code} signal=${signal}`);
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
// 直接调用 node_modules/.bin 里的 electron：走 `npm run start` 时子进程 PATH 不一定带 .bin
const electronBin = path.join(
  root,
  'node_modules',
  '.bin',
  isWin ? 'electron.cmd' : 'electron'
);

// 开发态一律接真实数据源；演示模式在界面里现切（见文件头的说明）。
run('vite', npm, ['run', 'dev', '--workspace', '@workgremlin/renderer']);
run('electron', electronBin, [path.join('desktop', 'src', 'main.js'), ...extra], {
  env: { WORKGREMLIN_DEV: '1' },
});
