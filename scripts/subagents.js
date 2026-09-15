#!/usr/bin/env node
'use strict';

/**
 * subagent 清单 CLI —— 把"谁在帮你写代码、它现在什么状态"写进清单文件，
 * 服务端（server/src/ingest/subagentFeed.js）读它，办公室里就飘出对应名字 + 状态的幽灵。
 *
 * 用法：
 *   node scripts/subagents.js set <name> <state> [--task "在做的事"] [--progress 0.4] [--project 工程名]
 *   node scripts/subagents.js rm <name>
 *   node scripts/subagents.js list
 *   node scripts/subagents.js clear
 *
 * state 取 online | busy | idle | blocked | offline（写错或不写 -> online，不编造 busy）。
 *
 * 清单文件位置（与服务端同一套规则）：
 *   $WORKGREMLIN_SUBAGENTS_FILE  >  $WORKGREMLIN_WORKSPACE/.workgremlin/subagents.json  >  <cwd>/.workgremlin/subagents.json
 */

const fs = require('node:fs');
const path = require('node:path');

/** 与 server/src/ingest/subagentFeed.js 的 feedFilePath 保持一致 */
function feedFilePath() {
  const env = String(process.env.WORKGREMLIN_SUBAGENTS_FILE || '').trim();
  if (env) return path.resolve(env);
  const ws = String(process.env.WORKGREMLIN_WORKSPACE || '').trim();
  return path.join(ws ? path.resolve(ws) : process.cwd(), '.workgremlin', 'subagents.json');
}

function readFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const agents = Array.isArray(data) ? data : Array.isArray(data.agents) ? data.agents : [];
    const project = (!Array.isArray(data) && typeof data.project === 'string' && data.project) || '';
    return { project, agents };
  } catch {
    return { project: '', agents: [] };
  }
}

function writeFile(file, feed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'list');
  const file = feedFilePath();
  const feed = readFile(file);

  if (cmd === 'list') {
    console.log(`清单：${file}`);
    if (!feed.agents.length) {
      console.log('（空 —— 屋里现在没有临时成员的幽灵）');
      return;
    }
    for (const a of feed.agents) {
      const task = a.task ? ` · ${a.task}` : '';
      console.log(`  ${a.name}  [${a.state || 'online'}]${task}`);
    }
    return;
  }

  if (cmd === 'clear') {
    writeFile(file, { project: feed.project, agents: [] });
    console.log(`已清空：${file}`);
    return;
  }

  if (cmd === 'rm') {
    const name = String(args._[1] || '');
    if (!name) {
      console.error('用法：node scripts/subagents.js rm <name>');
      process.exit(1);
    }
    feed.agents = feed.agents.filter((a) => a.name !== name);
    writeFile(file, feed);
    console.log(`已移除 ${name}：${file}`);
    return;
  }

  if (cmd === 'set') {
    const name = String(args._[1] || '');
    const state = String(args._[2] || '').trim();
    if (!name) {
      console.error('用法：node scripts/subagents.js set <name> <state> [--task "…"] [--progress 0.4]');
      process.exit(1);
    }
    const entry = {
      name,
      state: state || 'online',
      ...(args.task ? { task: String(args.task) } : {}),
      ...(args.progress !== undefined && Number.isFinite(Number(args.progress))
        ? { progress: Number(args.progress) }
        : {}),
      ...(args.project ? { project: String(args.project) } : {}),
      ...(args.file ? { files: [String(args.file)] } : {}),
    };
    const i = feed.agents.findIndex((a) => a.name === name);
    if (i >= 0) feed.agents[i] = { ...feed.agents[i], ...entry };
    else feed.agents.push(entry);
    writeFile(file, feed);
    console.log(`${entry.name} -> ${entry.state}（写入 ${file}）`);
    return;
  }

  console.error(`未知命令：${cmd}`);
  process.exit(1);
}

main();
