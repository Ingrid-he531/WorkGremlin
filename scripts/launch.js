#!/usr/bin/env node
'use strict';

/**
 * WorkGremlin 统一启动器：管理 server 生命周期 + 启动 client。
 *
 * 行为：
 *   - 默认：检查是否已有 server 在跑（读 server.json + 探活端口）。
 *       · 有  -> 复用现有 server。
 *       · 无  -> 先起 server（后台常驻 detached），等它就绪后再启动 client。
 *   - 带 --restart / -r：杀掉现有 server（含孤儿进程，清 21800~21820），重启 server，再启动 client。
 *
 * 关键设计：
 *   - server 以 detached 方式启动，进程独立于本脚本；client 退出后 server 仍在，
 *     下次默认启动会直接复用（server 跨 client 重启常驻）。
 *   - client 只读取 server.json 连接本脚本起好的 server，**不自行启动 server、不读环境变量**
 *     （见 desktop/src/main.js），server 的生命周期完全由本脚本管理。
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

/** 解析 package.json 里 engines.node 声明的最低版本（兼容 >=x.y.z / x.y.z / ^x / ~x 形式） */
function requiredNodeVersion() {
  let raw = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    raw = (pkg && pkg.engines && pkg.engines.node) || '';
  } catch {}
  const m = String(raw).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

/** 当前 Node 版本：[major, minor, patch] */
function nodeVer() {
  const m = process.version.match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

/** 启动器自身的 Node 版本校验（严格，过低直接退出）：client 仍由**系统 Node** 跑 Vite，
 *  在 Node 22 下会启动失败（需 >= 24），所以这里卡住，避免在 client 起不来后才暴露问题。
 *  server 已改用 Electron 内置 Node 启动（见 startServer，自带 Node 22.x），不受系统 Node 版本限制。 */
function checkNodeVersion() {
  const req = requiredNodeVersion();
  if (!req) return; // 没声明就不拦
  const cur = nodeVer();
  const lower =
    cur[0] < req[0] ||
    (cur[0] === req[0] && cur[1] < req[1]) ||
    (cur[0] === req[0] && cur[1] === req[1] && cur[2] < req[2]);
  if (!lower) return;
  console.error(
    `[launch] 当前 Node v${cur.join('.')} 过低，需要 >= v${req.join('.')}。\n` +
      '        client（Vite）在 Node 22 下无法启动，请升级系统 Node 到 24+。\n' +
      '        （server 由 Electron 内置 Node 运行，不受此限制；但启动器本身也用系统 Node 跑 client）'
  );
  process.exit(1);
}

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

/**
 * 解析 Electron 可执行文件。
 * Windows 优先用 electron 包自带的 `electron.exe`：`node_modules\.bin\electron.cmd` 是批处理，
 * 见 startClient 的注释（spawn .cmd 会 EINVAL / 走 shell 又有 DEP0190 告警）。
 */
function electronBin() {
  if (process.platform === 'win32') {
    const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
}

/** 只有落到 .cmd/.bat 批处理（没找到 electron.exe 时的兜底）才需要 shell */
function needsShell(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

/** 后台常驻启动 server（detached + unref，独立于本脚本生命周期）。
 *  关键：server 用 **Electron 内置 Node** 跑（而非系统 node），这样机器上只要装了 Electron
 *  （自带 Node 22.x）就能起 server，无需单独安装 Node。better-sqlite3 也正是在 postinstall 时
 *  按 Electron ABI 编译的，二者配套。 */
function startServer() {
  const bin = electronBin();
  const child = spawn(bin, ['server/src/cli.js'], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: 'ignore',
    detached: true,
    shell: needsShell(bin),
  });
  child.unref();
  return child;
}

/**
 * 前台启动 client：连接本脚本已起好的 server，不读环境变量、不自行启动 server。
 *
 * Windows 注意：不要直接 spawn `node_modules\.bin\electron.cmd` —— Node >= 20.12
 * （CVE-2024-27980 修复）起，不带 shell 直接 spawn .cmd/.bat 会抛 `spawn EINVAL`，
 * launch 直接起不来；而给它加 shell 又会引入 DEP0190 告警（参数不做转义）。
 * 所以优先走 electronBin() 解析出的 electron.exe（无需 shell），仅兜底落到 .cmd 时才加 shell。
 */
function startClient() {
  const bin = electronBin();
  return spawn(bin, [...ELECTRON_ARGS, 'desktop/src/main.js'], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: 'inherit',
    detached: false,
    shell: needsShell(bin),
  });
}

async function main() {
  // 先校验 Node 版本：低版本直接退出并提示，避免在 server 启动失败后才暴露问题
  checkNodeVersion();
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
