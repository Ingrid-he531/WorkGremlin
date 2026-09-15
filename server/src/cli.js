#!/usr/bin/env node
'use strict';

/**
 * 独立启动入口（headless 模式）：
 *   node server/src/cli.js                      默认端口探测 + 演示数据
 *   node server/src/cli.js --port 21800
 *   node server/src/cli.js --db /tmp/wg.db --demo --demo-seed 42
 *   node server/src/cli.js --self-test          只验证 better-sqlite3 建表/读写（V1 判据 3）
 *   node server/src/cli.js --no-token           关闭本地 token（仅调试）
 */

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

  repo.upsertTeam.run({
    id: 'selftest',
    name: 'selftest',
    workspacePath: '/tmp',
    mainConversationId: null,
    source: 'report',
    createdAt: 1,
  });
  repo.upsertMember.run({
    id: 'coder@selftest',
    teamId: 'selftest',
    name: 'coder',
    role: 'test',
    sessionId: null,
    reported: 1,
    createdAt: 1,
    lastSeenAt: 1,
    ephemeral: 0,
    project: null,
  });
  repo.insertMessage.run({
    dedupeKey: 'k1',
    teamId: 'selftest',
    tsMs: 1,
    fromMember: 'coder@selftest',
    toMember: null,
    type: 'system',
    subject: 'hello',
    content: 'world',
    taskId: null,
    source: 'report',
    rawJson: null,
  });
  const row = repo.getMessage.get(1);
  const teams = repo.listTeams.all();

  const pragmaSecure = repo.raw.pragma('secure_delete', { simple: true });
  const pragmaWal = repo.raw.pragma('journal_mode', { simple: true });
  const cp = checkpoint('TRUNCATE');
  close();

  console.log(JSON.stringify({
    ok: true,
    dbFile: file,
    read: row,
    teams: teams.length,
    secure_delete: pragmaSecure,
    journal_mode: pragmaWal,
    checkpoint: cp,
  }, null, 2));

  if (!row || row.content !== 'world') {
    console.error('[self-test] FAILED: 写入后读回不一致');
    process.exit(1);
  }
  console.log('[self-test] PASS: better-sqlite3 建表/写入/读取/checkpoint 均正常');
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
    demo: args.demo === true || process.env.MOCK === '1',
    seed: args['demo-seed'] ? Number(args['demo-seed']) : undefined,
    token: args['no-token'] ? '' : undefined,
    workspacePath: typeof args.workspace === 'string' ? args.workspace : undefined,
  });

  await server.start(args.port ? Number(args.port) : undefined);
  console.log(`[workgremlin] server.json -> ${config.serverInfoPath()}`);
  console.log('[workgremlin] Ctrl+C 退出');

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[workgremlin] 启动失败：', err);
  process.exit(1);
});
