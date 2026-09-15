'use strict';

/**
 * 本地服务配置：端口探测、token、运行信息落盘。
 *
 * 运行信息写入 ~/.workgremlin/server.json，供 Electron 主进程、renderer、reporter CLI 共享。
 * 只监听 127.0.0.1；每次启动生成随机 token，避免本机其他进程伪造上报。
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULTS } = require('@workgremlin/shared');

function home() {
  return process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
}

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
  newToken,
  isPortFree,
  isPidAlive,
  pickPort,
  writeServerInfo,
  readServerInfo,
  clearServerInfo,
};
