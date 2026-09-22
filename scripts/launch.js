#!/usr/bin/env node
'use strict';

/**
 * WorkGremlin 统一启动器：管理 server 生命周期 + 启动 client。
 *
 * 行为：
 *   - 默认：检查是否已有 server 在跑。
 *       · 有  -> 直接启动 client，复用现有 server 的端口（WORKGREMLIN_CONNECT=1）。
 *       · 无  -> 先起 server（后台常驻），等它就绪后再启动 client 连它。
 *   - 带 --restart / -r：杀掉现有 server（含孤儿进程，清 21800~21820），重启 server，再启动 client。
 *
 * 关键设计：
 *   - server 以 detached 方式启动，进程独立于本脚本；client 退出后 server 仍在，
 *     下次默认启动会直接复用（server 跨 client 重启常驻，解决"另起孤儿端口"问题）。
 *   - client 用 WORKGREMLIN_CONNECT=1 连已有 server，不会自己再起一个。
 *
 * 用法：
 *   node scripts/launch.js            # 默认：检查/启动 server，再启动 client
 *   node scripts/launch.js --restart  # 杀掉现有 server 重启，再启动 client
 */

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
const SERVER_JSON = path.join(HOME, 'server.json');
const PORT_START = 21800;
const PORT_END = 21820;

const ARGS = process.argv.slice(2);
const RESTART = ARGS.some((a) => a === '--restart' || a === '-r' || a === 'restart');
// 除 launch 自身开关外的参数（如 --no-sandbox）全部透传给 electron
const ELECTRON_ARGS = ARGS.filter((a) => a !== '--restart' && a !== '-r' && a !== 'restart');

function readServerInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8'));
    if (j && Number.isInteger(j.port) && typeof j.token === 'string') return j;
  } catch {}
  return null;
}

function pingPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => { clearTimeout(t); done(true); });
    s.once('error', () => { clearTimeout(t); done(false); });
  });
}

async function isServerAlive() {
  const info = readServerInfo();
  if (!info) return false;
  return pingPort(info.port);
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** 杀掉现有 server：server.json 里的 pid + 所有监听 218xx 的进程（清孤儿）。 */
async function killAllServers() {
  const info = readServerInfo();
  if (info && Number.isInteger(info.pid)) killPid(info.pid);
  if (process.platform !== 'win32') {
    for (let port = PORT_START; port <= PORT_END; port++) {
      if (!(await pingPort(port, 400))) continue;
      try {
        const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
        for (const line of out.split('\n')) {
          const pid = Number(line.trim());
          if (pid) killPid(pid);
        }
      } catch {
        /* lsof 不存在 / 无权限：忽略，继续 */
      }
    }
  }
}

function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await predicate()) return resolve(true);
      if (Date.now() - start >= timeoutMs) {
        console.error(`[launch] 等待超时：${label}`);
        return resolve(false);
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

function electronBin() {
  return path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
}

/** 后台常驻启动 server（detached + unref，独立于本脚本生命周期） */
function startServer() {
  const child = spawn(process.execPath, ['server/src/cli.js'], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

/** 前台启动 client，连已有 server */
function startClient() {
  return spawn(electronBin(), [...ELECTRON_ARGS, 'desktop/src/main.js'], {
    cwd: ROOT,
    env: { ...process.env, WORKGREMLIN_CONNECT: '1' },
    stdio: 'inherit',
    detached: false,
  });
}

async function main() {
  if (RESTART) {
    console.log('[launch] --restart：杀掉现有 server（含孤儿）...');
    await killAllServers();
    // 等端口释放，避免新 server 被迫占用非首项端口
    await waitFor(async () => !(await isServerAlive()), 8000, 'server 端口释放');
  } else if (await isServerAlive()) {
    console.log('[launch] 检测到已有 server，复用其端口');
  } else {
    console.log('[launch] 未发现 server，准备启动');
  }

  const needStart = RESTART || !(await isServerAlive());
  if (needStart) {
    console.log('[launch] 启动 server...');
    startServer();
    if (!(await waitFor(isServerAlive, 15000, 'server 就绪'))) {
      process.exit(1);
    }
    console.log('[launch] server 已就绪');
  }

  console.log('[launch] 启动 client（连接现有 server）...');
  const client = startClient();
  const onSignal = () => {
    try {
      client.kill('SIGTERM');
    } catch {}
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  client.on('exit', (code) => {
    console.log(`[launch] client 退出 code=${code ?? ''}`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[launch] 失败：', err && err.message);
  process.exit(1);
});
