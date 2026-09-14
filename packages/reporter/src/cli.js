#!/usr/bin/env node
'use strict';

/**
 * 命令行上报（供 shell hook / 不想改 agent 代码时调用）：
 *
 *   node packages/reporter/src/cli.js --team workgremlin --member coder --state busy
 *   node packages/reporter/src/cli.js --member coder --task "实现工位视图" --progress 0.4 --file a.vue b.vue
 *   node packages/reporter/src/cli.js --member coder --task-end done --artifact "文件:docs/tech-design.md"
 *   node packages/reporter/src/cli.js --member coder --message --to leader --type result --subject "产出" --content "已提交"
 */

const { createReporter } = require('./index');

function parseArgs(argv) {
  const args = { flags: {}, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [key, inline] = a.slice(2).split('=');
    if (key === 'file') {
      args.files.push(...(inline ? [inline] : argv[++i].split(',')));
      continue;
    }
    const next = argv[i + 1];
    if (inline !== undefined) args.flags[key] = inline;
    else if (next && !next.startsWith('--')) {
      args.flags[key] = next;
      i += 1;
    } else args.flags[key] = true;
  }
  return args;
}

async function main() {
  const { flags, files } = parseArgs(process.argv.slice(2));
  const team = flags.team || process.env.WORKGREMLIN_TEAM || 'workgremlin';
  const member = flags.member || process.env.WORKGREMLIN_MEMBER;

  if (!member) {
    console.error('缺少 --member（或 env WORKGREMLIN_MEMBER）');
    process.exit(2);
  }

  const rep = await createReporter({ team, member, silent: false });

  try {
    if (flags.state) await rep.status(flags.state, typeof flags.reason === 'string' ? flags.reason : undefined);

    if (flags.task) {
      const t = rep.task(flags.task);
      await t.start();
      if (flags.progress !== undefined) await t.progress(Number(flags.progress), { files });
      if (!flags['task-end'] && flags.progress === undefined) await t.progress(0, { files });
      if (flags['task-end']) {
        const artifacts = [];
        if (typeof flags.artifact === 'string') {
          for (const a of [flags.artifact]) {
            const [kind, rest] = a.includes(':') ? a.split(':') : ['file', a];
            const [title, p] = rest.includes('|') ? rest.split('|') : [rest, rest];
            artifacts.push({ kind, title, path: p });
          }
        }
        await t.end(typeof flags['task-end'] === 'string' ? flags['task-end'] : 'done', { artifacts });
      }
      console.log(`[workgremlin] task=${t.id}`);
    }

    if (flags.message) {
      await rep.message(flags.to || null, flags.type || 'system', flags.subject || '', flags.content || '');
    }

    if (files.length && !flags.task) await rep.file(files, 'write');

    if (!flags.state && !flags.task && !flags.message && !files.length) await rep.heartbeat();
  } finally {
    rep.close();
  }
}

main().catch((err) => {
  console.error('[workgremlin] 上报失败：', err && err.message);
  process.exit(1);
});
