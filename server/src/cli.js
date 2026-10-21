#!/usr/bin/env node
'use strict';

/**
 * Standalone entry point (headless mode):
 *   node server/src/cli.js                      default port probing + connect real data sources
 *   node server/src/cli.js --port 21800
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
const config = require('./config');

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

  const server = createServer({
    dbPath: typeof args.db === 'string' ? args.db : undefined,
    port: args.port ? Number(args.port) : undefined,
    token: args['no-token'] ? '' : undefined,
    workspacePath: typeof args.workspace === 'string' ? args.workspace : undefined,
    // --log=debug / --log=error … (equivalent to WORKGREMLIN_LOG; --log-file=0 disables file logging)
    log: typeof args.log === 'string' ? args.log : undefined,
  });
  if (args['log-file'] === '0') log.setFileEnabled(false);

  await server.start(args.port ? Number(args.port) : undefined);
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
