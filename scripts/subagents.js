#!/usr/bin/env node
'use strict';

/**
 * subagent manifest CLI — writes "who is helping you code and what state it is in" into the manifest
 * file; the server (server/src/ingest/subagentFeed.js) reads it and the office floats a ghost with the
 * matching name + state.
 *
 * Usage:
 *   node scripts/subagents.js set <name> <state> [--task "what it is doing"] [--progress 0.4] [--project <project>]
 *   node scripts/subagents.js rm <name>
 *   node scripts/subagents.js list
 *   node scripts/subagents.js clear
 *
 * state is one of online | busy | idle | blocked | offline (typo or omitted -> online; never invent busy).
 *
 * Finishing (recommended): write a one-line result summary; the gremlin in the office walks up to the main
 * agent and says it, and once the report finishes the server recycles this entry (the ghost disperses, the
 * desk goes idle):
 *   node scripts/subagents.js set simmon idle --result "design doc landed, 390 lines, with a timing table and state machine"
 *
 * Manifest file location (same rule as the server):
 *   $WORKGREMLIN_SUBAGENTS_FILE  >  $WORKGREMLIN_WORKSPACE/.workgremlin/subagents.json  >  <cwd>/.workgremlin/subagents.json
 */

const fs = require('node:fs');
const path = require('node:path');
// Share the same manifest file with the hook / server: read-modify-write is locked + atomic (see shared/fslock.js).
const { updateJson } = require('@workgremlin/shared/fslock');
const { home } = require('@workgremlin/shared');

/** Keep in sync with server/src/ingest/subagentFeed.js feedFilePath: a single file in the data dir */
function feedFilePath() {
  const env = String(process.env.WORKGREMLIN_SUBAGENTS_FILE || '').trim();
  if (env) return path.resolve(env);
  return path.join(home(), 'subagents.json');
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

/** Locked manifest read-modify-write: mutate receives the normalized { project, agents } and returns the new manifest to write. */
function updateFeed(file, mutate) {
  return updateJson(
    file,
    (raw) => {
      const agents = Array.isArray(raw) ? raw : Array.isArray(raw && raw.agents) ? raw.agents : [];
      const project = (!Array.isArray(raw) && raw && typeof raw.project === 'string' && raw.project) || '';
      return mutate({ project, agents });
    },
    { fallback: { project: '', agents: [] }, pretty: true }
  );
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
    console.log(`manifest: ${file}`);
    if (!feed.agents.length) {
      console.log('(empty — no temporary-member ghosts in the office right now)');
      return;
    }
    for (const a of feed.agents) {
      const task = a.task ? ` · ${a.task}` : '';
      console.log(`  ${a.name}  [${a.state || 'online'}]${task}`);
    }
    return;
  }

  if (cmd === 'clear') {
    updateFeed(file, (f) => ({ project: f.project, agents: [] }));
    console.log(`cleared: ${file}`);
    return;
  }

  if (cmd === 'rm') {
    const name = String(args._[1] || '');
    if (!name) {
      console.error('Usage: node scripts/subagents.js rm <name>');
      process.exit(1);
    }
    updateFeed(file, (f) => ({ project: f.project, agents: f.agents.filter((a) => a.name !== name) }));
    console.log(`removed ${name}: ${file}`);
    return;
  }

  if (cmd === 'set') {
    const name = String(args._[1] || '');
    const state = String(args._[2] || '').trim();
    if (!name) {
      console.error('Usage: node scripts/subagents.js set <name> <state> [--task "…"] [--progress 0.4]');
      process.exit(1);
    }
    const entry = {
      name,
      state: state || 'online',
      // Result summary: writing it = this summon is done (the server recycles the entry after the report
      // finishes); otherwise set it empty — so a previous round's result does not stick to a new summon.
      result: args.result ? String(args.result) : '',
      ...(args.task ? { task: String(args.task) } : {}),
      ...(args.progress !== undefined && Number.isFinite(Number(args.progress))
        ? { progress: Number(args.progress) }
        : {}),
      ...(args.project ? { project: String(args.project) } : {}),
      ...(args.file ? { files: [String(args.file)] } : {}),
    };
    updateFeed(file, (f) => {
      const i = f.agents.findIndex((a) => a.name === name);
      if (i >= 0) f.agents[i] = { ...f.agents[i], ...entry };
      else f.agents.push(entry);
      return f;
    });
    console.log(`${entry.name} -> ${entry.state} (written to ${file})`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main();
