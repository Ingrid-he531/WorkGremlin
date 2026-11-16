'use strict';

/**
 * The "output summary" line-break contract.
 *
 * TaskRecordsView renders `task_runs.result` / `subagent_runs.result` as Markdown (marked + GFM), and
 * Markdown is line-oriented: a heading, a list item and a code fence only mean something when they
 * start a line. The ingest layer used to store the summary through `normText()`, which collapses every
 * whitespace run into one space — every stored summary came out as a single paragraph, so the detail
 * pane showed one blob of text with the `##` and ``` markers still in it.
 *
 * This test drives the real bus + SQLite (no mocks) and locks what the renderer needs:
 *   [1] headings / list items / code fences survive as separate lines;
 *   [2] whitespace hygiene: CRLF, trailing blanks, blank-line runs, edge blank lines;
 *   [3] indentation is kept (indented code block);
 *   [4] empty stays NULL and the 4000-char cap still applies.
 *
 * Run: `npm run test:result-text` (node only, no extra deps).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-result-text-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: TMP, mainConversationId: null, source: 'report', createdAt: 1 });
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
bus.registerMember({ project: 'p1', memberId: 'dsh', name: 'dsh', role: 'agent', client: 'dsh' });

let n = 0;
/** Run one round through the real bus, then return what the ledger stored as the result. */
function store(result) {
  n += 1;
  const ts = 1_700_000_000_000 + n * 1000;
  const sessionId = `s${n}`;
  const started = bus.startTask({ project: 'p1', memberId: 'dsh', title: `round ${n}`, sessionId, ts });
  if (!started.ok) throw new Error(`startTask failed: ${started.error}`);
  const ended = bus.endTask({ project: 'p1', memberId: 'dsh', taskId: started.taskId, sessionId, result, ts: ts + 500 });
  if (!ended.ok) throw new Error(`endTask failed: ${ended.error}`);
  const row = repo.getTaskRun.get(started.taskId);
  return row ? row.result : null;
}

try {
  console.log('\n[1] Markdown structure survives the round trip');
  const markdown = '## 我做了什么\n\n- 改了 `bus.js`\n- 补了测试\n\n```js\nconst a = 1;\n```';
  const s1 = store(markdown);
  ok('heading / list lines stay on their own lines', String(s1).includes('## 我做了什么\n\n- 改了 `bus.js`'), JSON.stringify(s1));
  ok('code fence keeps its own lines', String(s1).includes('```js\nconst a = 1;\n```'), JSON.stringify(s1));

  console.log('\n[2] Whitespace hygiene');
  const crlf = store('a\r\nb');
  ok('CRLF becomes LF', crlf === 'a\nb', JSON.stringify(crlf));
  ok('trailing blanks on a line are dropped', store('a  \nb\t') === 'a\nb');
  ok('a run of blank lines collapses to one blank line', store('a\n\n\n\nb') === 'a\n\nb');
  const padded = store('\n\n a\n\n');
  ok('leading / trailing blank lines are trimmed', padded === ' a', JSON.stringify(padded));

  console.log('\n[3] Indentation is kept (indented code block)');
  ok('four leading spaces survive', store('    const a = 1;\n    const b = 2;') === '    const a = 1;\n    const b = 2;');

  console.log('\n[4] Empty and over-long values');
  ok('whitespace-only summary becomes NULL', store('   \n\n  ') === null);
  const long = `${'x'.repeat(50)}\n`.repeat(200);
  const s4 = store(long);
  ok('still capped at 4000 chars', s4.length === 4000, String(s4.length));
  ok('the cap does not glue the lines back together', String(s4).includes('\n'));
} finally {
  close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
