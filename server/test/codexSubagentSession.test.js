/**
 * Codex subagent rollouts must not be listed as independent sessions.
 *
 * Codex writes a subagent's transcript into the same sessions tree as a normal rollout, with the same
 * file-name shape. Only the first session_meta line marks it as a child (`thread_source: "subagent"`,
 * `parent_thread_id`, `source.subagent`). When it is listed, the dropdown grows a second 3F entry with
 * `taskState: null` / `phase: "unreported"`; if that file is fresher than the parent's, the renderer
 * can auto-select it and the main console shows idle while the parent session's ghosts are still
 * floating.
 *
 * This suite writes real files and runs the real scanCliSessions.
 *
 * Run: `npm run test:codex-subagent-session`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-codex-sessions-'));
process.env.HOME = path.join(TMP, 'home');
process.env.WORKGREMLIN_HOME = path.join(TMP, 'wg');
fs.mkdirSync(process.env.WORKGREMLIN_HOME, { recursive: true });

const { scanCliSessions } = require('../src/sessionRegistry');

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

const WS = path.join(TMP, 'work', 'WorkGremlin');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'package.json'), JSON.stringify({ name: 'workgremlin' }));

const ROOT = path.join(process.env.HOME, '.codex');
const DAY = path.join(ROOT, 'sessions', '2026', '10', '19');
fs.mkdirSync(DAY, { recursive: true });

const PARENT_SID = '01a0fc40-44ed-7773-8c61-422f9560fe46';
const CHILD_SID = '01a1544c-40c9-7170-b2cf-e87a9328ff3a';
const SOURCE_CHILD_SID = '01a1544c-40c9-7170-b2cf-e87a9328ff3b';
const LEGACY_SID = '01a0dbb6-5d72-7af1-8afd-bd964964fd3a';
const FORK_SID = '01a0e175-825c-79a3-85d2-33a3a3fb0a62';

const fileOf = (sid) => path.join(DAY, `rollout-2026-10-19T10-00-00-${sid}.jsonl`);
const writeRollout = (sid, payload) => {
  const line = { timestamp: '2026-10-19T02:00:00.000Z', type: 'session_meta', payload: { cwd: WS, ...payload } };
  fs.writeFileSync(fileOf(sid), `${JSON.stringify(line)}\n${JSON.stringify({ type: 'user', message: 'hi' })}\n`);
};

writeRollout(PARENT_SID, { session_id: PARENT_SID, id: PARENT_SID, thread_source: 'user' });
writeRollout(CHILD_SID, {
  session_id: PARENT_SID,
  id: CHILD_SID,
  thread_source: 'subagent',
  parent_thread_id: PARENT_SID,
  agent_role: 'software-architect',
  source: { subagent: { thread_spawn: { parent_thread_id: PARENT_SID } } },
});
// A variant that only marks itself through source.subagent (no thread_source field).
writeRollout(SOURCE_CHILD_SID, {
  session_id: PARENT_SID,
  id: SOURCE_CHILD_SID,
  source: { subagent: { thread_spawn: { parent_thread_id: PARENT_SID } } },
});
// Old Codex versions have no thread_source at all: they must still be listed.
writeRollout(LEGACY_SID, { session_id: LEGACY_SID, id: LEGACY_SID });
// A user-visible fork has forked_from_id but is not a subagent thread: it stays listed.
writeRollout(FORK_SID, { session_id: FORK_SID, id: FORK_SID, thread_source: 'user', forked_from_id: PARENT_SID });

const rows = scanCliSessions(ROOT, { kind: 'codex' });
const ids = rows.map((r) => r.sessionId).sort();

console.log('\n[1] 子代理 rollout 不进会话列表');
ok('父会话被列出', ids.includes(PARENT_SID), JSON.stringify(ids));
ok('thread_source=subagent 的子代理被排除', !ids.includes(CHILD_SID), JSON.stringify(ids));
ok('只有 source.subagent 的子代理也被排除', !ids.includes(SOURCE_CHILD_SID), JSON.stringify(ids));

console.log('\n[2] 正常用户会话不受影响');
ok('新版本普通会话被列出', ids.includes(PARENT_SID));
ok('老版本（无 thread_source）会话被列出', ids.includes(LEGACY_SID), JSON.stringify(ids));
ok('用户 fork 会话被列出', ids.includes(FORK_SID), JSON.stringify(ids));
ok('一共 3 条（父 / 老版本 / fork）', rows.length === 3, JSON.stringify(ids));

console.log('\n[3] 剩下的行仍带正确的会话号与工程');
{
  const parent = rows.find((r) => r.sessionId === PARENT_SID);
  ok('父会话 sessionId 正确', Boolean(parent));
  ok('工程路径来自 session_meta.cwd', parent && parent.projectPath === WS, parent && parent.projectPath);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
