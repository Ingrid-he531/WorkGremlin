'use strict';

/**
 * 本地服务配置：端口探测、token、运行信息落盘。
 *
 * 运行信息写入 ~/.workgremlin/server.json，供 Electron 主进程、renderer、reporter CLI 共享。
 * 只监听 127.0.0.1；每次启动生成随机 token，避免本机其他进程伪造上报。
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULTS, home } = require('@workgremlin/shared');

function ensureHome() {
  const dir = home();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 非 POSIX 系统忽略 */
  }
  return dir;
}

function serverInfoPath() {
  return path.join(home(), 'server.json');
}

function defaultDbPath() {
  return path.join(home(), 'workgremlin.db');
}

/**
 * 演示工程的 id。
 *
 * 演示数据就是一个**普通的工程**，和真实工程并列；只是没有目录（workspacePath 为空）。
 * 刻意带下划线：真实工程的 id 由 workspace.js 的 slug() 生成，只含 [a-z0-9-]，
 * 两者**永不撞名**。否则演示种子成员会被写进一个和真实工程同名的工程里，
 * 办公室一直挂着演示残留、跟不上当前工程。
 * （历史事故：演示工程默认叫 workgremlin，恰好和本仓库工程的 slug 撞名。）
 *
 * WORKGREMLIN_PROJECT 可覆盖（覆盖后撞名风险自负）。
 */
const DEMO_PROJECT = process.env.WORKGREMLIN_PROJECT || '__demo__';

/** 演示工程的显示名（界面上与真实工程并列展示这个名字） */
const DEMO_PROJECT_NAME = '演示工程';

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** @param {number} port */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 [start, end] 内找第一个可用端口。
 * @param {number} [start]
 * @param {number} [end]
 * @returns {Promise<number|null>}
 */
async function pickPort(start = DEFAULTS.PORT_START, end = DEFAULTS.PORT_END) {
  for (let port = start; port <= end; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) return port;
  }
  return null;
}

/**
 * @param {{port: number, token: string, pid: number, dbPath: string, startedAt: number,
 *          version?: string, previousPid?: number|null, project?: string, workspacePath?: string}} info
 */
function writeServerInfo(info) {
  ensureHome();
  const file = serverInfoPath();
  fs.writeFileSync(file, JSON.stringify(info, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  return file;
}

/** @returns {Record<string, any>|null} */
function readServerInfo() {
  const file = serverInfoPath();
  if (!fs.existsSync(file)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPidAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

function clearServerInfo() {
  const file = serverInfoPath();
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  home,
  ensureHome,
  serverInfoPath,
  defaultDbPath,
  DEMO_PROJECT,
  DEMO_PROJECT_NAME,
  newToken,
  isPortFree,
  isPidAlive,
  pickPort,
  writeServerInfo,
  readServerInfo,
  clearServerInfo,
};
