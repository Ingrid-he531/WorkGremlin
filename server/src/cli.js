#!/usr/bin/env node
'use strict';

/**
 * Standalone entry point (headless mode):
 *   Host / port / TLS can also be set in ~/.workgremlin/config.json under "server";
 *   command-line flags and environment variables override that file.
 *
 *   node server/src/cli.js                      default port probing + connect real data sources
 *   node server/src/cli.js --port 21800
 *   node server/src/cli.js --host 0.0.0.0       listen on all interfaces (remote clients reuse the
 *                                              token persisted in server.json)
 *   node server/src/cli.js --token mytoken      explicit token (not recommended: visible in the
 *                                              process list / shell history)
 *   node server/src/cli.js --rotate-token       generate a new token and persist it in server.json
 *   node server/src/cli.js --static renderer/dist
 *                                              also serve the built UI, so a client machine only
 *                                              needs a browser (`npm run build` first)
 *   node server/src/cli.js --tls                HTTPS with a self-signed certificate generated into
 *                                              ~/.workgremlin/tls (reused while valid); the SHA-256
 *                                              fingerprint is printed so "continue anyway" can be
 *                                              verified. WORKGREMLIN_TLS=1 does the same.
 *   node server/src/cli.js --tls-cert server.crt --tls-key server.key
 *                                              HTTPS with an existing certificate (internal CA,
 *                                              mkcert, real domain certificate)
 *   node server/src/cli.js --db /tmp/wg.db
 *   node server/src/cli.js --self-test          only verify better-sqlite3 create/read/write (V1 criterion 3)
 *   node server/src/cli.js --no-token           disable the local token (debugging only)
 *   node server/src/cli.js --log=debug          log level (error|warn|info|debug, default info)
 *   node server/src/cli.js --log-file=0         turn off file logging (~/.workgremlin/workgremlin.log)
 *
 * There is no startup flag for demo mode. Demo mode is a read-only, in-memory virtual session
 * exposed by /api/v1/demo/session (see server/src/demo/provider.js); it never seeds the real tables.
 * In the UI that is the "demo mode" button in the HUD.
 */

// Runtime version check: the server is now preferably started by Electron's bundled Node (see
// startServer in desktop/src/launcher.js), so the Node major version is no longer hard-enforced
// here. It only warns on a "pure node runtime" below Node 22 —— better-sqlite3@13 is N-API and its
// binaries are compatible across Node 22/24 and Electron's bundled Node, so 22 suffices.
const log = require('./log');
{
  const cur = process.version.match(/^v(\d+)\.(\d+)\.(\d+)/);
  const inElectron = Boolean(process.versions && process.versions.electron);
  const floor = [22, 0, 0];
  if (cur && !process.env.WORKGREMLIN_SKIP_VERSION_CHECK && !inElectron) {
    const less = (a, b) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0;
    if (less(cur.slice(1).map(Number), floor)) {
      log.error(
        `[workgremlin] Node 版本过低：当前 ${process.version}，需要 >= v22。\n` +
          '        可改用 Electron 内置 Node 启动（无需单独安装 Node）：见 desktop/src/launcher.js。'
      );
      process.exit(1);
    }
  }
}

const { createServer } = require('./index');
const { openDatabase } = require('./db');
const { resolveTls } = require('./tls');
const { resolveStartupSettings, validTls } = require('./startupConfig');
const config = require('./config');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Host to put in the printed browser URL: 0.0.0.0 / :: cannot be opened, so use the first
 * non-internal IPv4 address instead.
 * @param {string} [host]
 */
function browserHost(host) {
  if (host && host !== '0.0.0.0' && host !== '::') return host;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split('=');
    const next = argv[i + 1];
    if (inline !== undefined) args[key] = inline;
    else if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else args[key] = true;
  }
  return args;
}

async function selfTest() {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wg-selftest-')), 'test.db');
  const { repo, checkpoint, close } = openDatabase(file);

  repo.upsertProject.run({
    id: 'selftest',
    name: 'selftest',
    workspacePath: '/tmp',
    mainConversationId: null,
    source: 'report',
    createdAt: 1,
  });
  repo.upsertMember.run({
    id: 'coder@selftest',
    projectId: 'selftest',
    name: 'coder',
    role: 'test',
    sessionId: null,
    reported: 1,
    createdAt: 1,
    ephemeral: 0,
    // Columns were renamed: the old schema's project is now project_label, and a client column was
    // added. The self-test fills them in per bus.js's reporting criteria, otherwise better-sqlite3
    // raises "Missing named parameter".
    projectLabel: null,
    client: null,
  });
  repo.insertMessage.run({
    dedupeKey: 'k1',
    projectId: 'selftest',
    tsMs: 1,
    fromMember: 'coder@selftest',
    toMember: null,
    type: 'system',
    subject: 'hello',
    content: 'world',
    taskId: null,
    sessionId: null,
    source: 'report',
    rawJson: null,
  });
  const row = repo.getMessage.get(1);
  const projects = repo.listProjects.all();

  const pragmaSecure = repo.raw.pragma('secure_delete', { simple: true });
  const pragmaWal = repo.raw.pragma('journal_mode', { simple: true });
  const cp = checkpoint('TRUNCATE');
  close();

  // Structured output, meant to be read by machines —— no log prefix, straight to stdout
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dbFile: file,
    read: row,
    projects: projects.length,
    secure_delete: pragmaSecure,
    journal_mode: pragmaWal,
    checkpoint: cp,
  }, null, 2)}\n`);

  if (!row || row.content !== 'world') {
    log.error('[self-test] FAILED: 写入后读回不一致');
    process.exit(1);
  }
  log.info('[self-test] PASS: better-sqlite3 建表/写入/读取/checkpoint 均正常');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args['self-test']) {
    await selfTest();
    return;
  }

  // host / port / TLS may come from ~/.workgremlin/config.json ("server" section) in addition to
  // the flags. Command line > environment > file > default; the same file also holds dispatch.mode.
  const startup = resolveStartupSettings({ args });
  const host = startup.host;
  const requestedPort = startup.port;
  // The address actually bound by createServer: no host means loopback, never the LAN address.
  const bindHost = host || '127.0.0.1';
  const staticDir = typeof args.static === 'string' ? path.resolve(args.static) : undefined;
  if (staticDir && !fs.existsSync(path.join(staticDir, 'index.html'))) {
    log.error(`[workgremlin] --static 目录里没有 index.html：${staticDir}（先跑 npm run build）`);
    process.exit(1);
  }

  // TLS: `--tls` (self-signed, generated once) or `--tls-cert` + `--tls-key`. WORKGREMLIN_TLS=1
  // and config.json's `server.tls` are the same as --tls, so a dev shell can start an https server
  // without a long command line. An explicit certificate pair always wins over the self-signed flag.
  const certFile = typeof args['tls-cert'] === 'string' ? path.resolve(args['tls-cert']) : undefined;
  const keyFile = typeof args['tls-key'] === 'string' ? path.resolve(args['tls-key']) : undefined;
  if (validTls(args.tls) === true && (certFile || keyFile)) {
    log.error('[workgremlin] --tls 与 --tls-cert/--tls-key 只能二选一（自签 或 指定证书）');
    process.exit(1);
  }
  if ((certFile && !keyFile) || (keyFile && !certFile)) {
    log.error('[workgremlin] --tls-cert 和 --tls-key 必须同时给出');
    process.exit(1);
  }
  const wantsSelfSigned = !certFile && !keyFile && startup.tls;
  let tls = null;
  try {
    tls = await resolveTls({ certFile, keyFile, selfSigned: wantsSelfSigned });
  } catch (err) {
    log.error(`[workgremlin] TLS 配置不成立：${(err && err.message) || err}`);
    process.exit(1);
  }
  log.info(
    `[workgremlin] 启动配置：host=${bindHost} port=${requestedPort || 'auto'} tls=${tls ? 'on' : 'off'}` +
      `（${startup.file}）`
  );

  // Token: an explicit --token wins, --rotate-token forces a new one, otherwise the token in
  // server.json is reused. Reuse is what lets a remote client keep working after a restart.
  // --no-token (debugging only) disables validation and is never reused.
  const noToken = Boolean(args['no-token']);
  const rotateToken = Boolean(args['rotate-token']);
  if (rotateToken && noToken) {
    log.error('[workgremlin] --rotate-token 和 --no-token 不能同时使用');
    process.exit(1);
  }
  if (rotateToken && args.token !== undefined) {
    log.error('[workgremlin] --rotate-token 和 --token 不能同时使用');
    process.exit(1);
  }
  if (args.token !== undefined && typeof args.token !== 'string') {
    log.error('[workgremlin] --token 需要一个值');
    process.exit(1);
  }
  let token;
  let tokenSource;
  if (noToken) {
    token = '';
    tokenSource = 'none';
  } else if (rotateToken) {
    token = config.newToken();
    tokenSource = 'rotated';
  } else if (typeof args.token === 'string') {
    token = args.token;
    tokenSource = 'explicit';
  } else {
    const persisted = config.persistedToken();
    token = persisted || config.newToken();
    tokenSource = persisted ? 'persisted' : 'generated';
  }
  if (tokenSource === 'explicit') {
    log.warn(
      '[workgremlin] --token 会把密钥暴露在进程参数/命令历史里；建议去掉 --token，' +
        '让服务器复用 server.json 中持久化的 token'
    );
  }

  const server = createServer({
    dbPath: typeof args.db === 'string' ? args.db : undefined,
    port: requestedPort,
    host,
    token,
    workspacePath: typeof args.workspace === 'string' ? args.workspace : undefined,
    serveStatic: staticDir,
    tls,
    // --log=debug / --log=error … (equivalent to WORKGREMLIN_LOG; --log-file=0 disables file logging)
    log: typeof args.log === 'string' ? args.log : undefined,
  });
  if (args['log-file'] === '0') log.setFileEnabled(false);

  await server.start(requestedPort);

  if (tls) {
    const kind = tls.source === 'self-signed' ? '自签证书' : '证书文件';
    log.info(
      `[workgremlin] TLS 已启用（${kind}${tls.reused ? '，沿用已有' : ''}，有效期至 ${tls.validTo}）：` +
        `SHA-256 ${tls.fingerprint256}`
    );
    if (tls.source === 'self-signed') {
      log.info(
        '[workgremlin] 自签证书不被系统信任：浏览器首次访问会提示"不是私密连接"，选"高级 → 继续前往"即可；' +
          '指纹与上面一致说明没有被中间人替换'
      );
    }
  }

  // Never print the token itself: this log line is also written to disk for 7 days.
  if (tokenSource === 'generated') {
    log.info(`[workgremlin] 已生成新 token 并写入 ${config.serverInfoPath()}（0600）`);
  } else if (tokenSource === 'rotated') {
    log.info(`[workgremlin] 已轮换 token 并写入 ${config.serverInfoPath()}（0600）`);
  } else if (tokenSource === 'persisted') {
    log.info('[workgremlin] 复用 server.json 中已有的 token（重启不会更换）');
  }

  if (staticDir) {
    // Use the bound host, not browserHost(undefined): without --host the server listens on loopback,
    // so printing the LAN address made the URL unreachable (the socket never accepted it).
    const base = `${server.info.protocol}://${browserHost(bindHost)}:${server.info.port}/`;
    log.info(`[workgremlin] 浏览器访问（客户端无需安装任何东西）：${base}`);
    if (server.token) {
      log.info(
        `[workgremlin] 首次访问需要 token：读取 ${config.serverInfoPath()} 的 token 字段，` +
          `打开 ${base}?token=<token>`
      );
    }
  }

  const loopback = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback) {
    if (noToken) {
      log.warn(`[workgremlin] 已监听 ${host} 且关闭了 token：只能用于可信网络或 SSH 隧道`);
    }
    if (tls) {
      log.warn(
        `[workgremlin] 已监听 ${host}：传输已加密；但自签证书不能证明服务器身份，` +
          '首次访问请核对启动日志里的 SHA-256 指纹'
      );
    } else if (!noToken) {
      log.warn(`[workgremlin] 已监听 ${host}：token 与实际数据都是明文 HTTP/WS 传输（建议加 --tls）`);
    }
  } else if (staticDir) {
    log.warn(
      '[workgremlin] 当前只监听本机（127.0.0.1）；其他机器要访问，请加 --host 0.0.0.0' +
        (tls ? '' : ' --tls')
    );
  }
  log.info(`[workgremlin] server.json -> ${config.serverInfoPath()}`);
  log.info('[workgremlin] Ctrl+C 退出');

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('[workgremlin] 启动失败：', err);
  process.exit(1);
});
