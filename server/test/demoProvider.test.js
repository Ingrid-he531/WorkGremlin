'use strict';

/**
 * Virtual demo provider self-test.
 *
 * Demo mode must look like a normal session to the renderer while never becoming a real project:
 *   · the snapshot contains a virtual project, normal member cards and messages;
 *   · the session carries the floor client + a running task state, so the ordinary floor / session
 *     filtering picks it up;
 *   · GET returns live phase / members, DELETE drops the in-memory state;
 *   · there is no repo/bus handle on the provider at all (nothing can be written).
 *
 * Run: `node server/test/demoProvider.test.js`
 */

const assert = require('node:assert/strict');
const { createDemoProvider } = require('../src/demo/provider');
const config = require('../src/config');
const { DEMO_PROJECT_ID, DEMO_SESSION_ID } = require('@workgremlin/shared');

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${label}\n    ${err && err.message}`);
  }
}

const provider = createDemoProvider({
  listProjects: () => [{ id: 'real', name: 'real', workspacePath: '/tmp/real', projectName: 'real' }],
});

console.log('\n[1] Session shape');
const started = provider.start('1F');
ok('session id is the shared virtual id', () => assert.equal(started.session.id, DEMO_SESSION_ID));
ok('session is a normal live, mine session', () => {
  assert.equal(started.session.live, true);
  assert.equal(started.session.mine, true);
  assert.equal(started.session.source, 'demo');
});
ok('session runs on the requested floor with that floor client', () => {
  assert.equal(started.session.floor, '1F');
  assert.equal(started.session.client, 'codebuddy');
});
ok('session has a running task and a server-owned phase', () => {
  assert.equal(started.session.taskState, 'running');
  assert.ok(['thinking', 'tool', 'await', 'dispatch', 'waiting'].includes(started.session.phase));
});
ok('virtual session has no real project path', () => assert.equal(started.session.projectPath, ''));

console.log('\n[2] Snapshot shape');
ok('the demo project id is fixed and not renameable by env', () => assert.equal(config.DEMO_PROJECT, DEMO_PROJECT_ID));
ok('snapshot project is virtual and points at the demo project', () => {
  assert.equal(started.snapshot.project.id, DEMO_PROJECT_ID);
  assert.equal(started.snapshot.project.workspacePath, '');
});
ok('real projects are still listed beside the virtual one', () => {
  const ids = started.snapshot.projects.map((p) => p.id);
  assert.ok(ids.includes(DEMO_PROJECT_ID));
  assert.ok(ids.includes('real'));
  assert.equal(ids.filter((id) => id === DEMO_PROJECT_ID).length, 1);
});
ok('member cards use the normal shape and demo project/session', () => {
  assert.equal(started.snapshot.members.length, 8);
  for (const m of started.snapshot.members) {
    assert.equal(m.project, DEMO_PROJECT_ID);
    assert.equal(m.sessionId, DEMO_SESSION_ID);
    assert.equal(m.client, 'codebuddy');
    assert.ok(Array.isArray(m.tasks));
    assert.ok(Array.isArray(m.sessionStatuses));
  }
});
ok('busy members have running tasks, reviewer is blocked', () => {
  const coder = started.snapshot.members.find((m) => m.name === 'coder');
  const reviewer = started.snapshot.members.find((m) => m.name === 'reviewer');
  assert.equal(coder.state, 'busy');
  assert.equal(coder.tasks[0].state, 'running');
  assert.equal(reviewer.state, 'blocked');
  assert.equal(reviewer.sessionStatuses[0].state, 'blocked');
});
ok('recent messages are present', () => assert.ok(started.snapshot.recentMessages.length >= 200));

console.log('\n[3] Live / stop');
const live = provider.get('1F', DEMO_SESSION_ID);
ok('GET returns the same virtual session', () => {
  assert.ok(live);
  assert.equal(live.session.id, DEMO_SESSION_ID);
  assert.equal(live.members.length, 8);
});
ok('wrong session id is rejected', () => assert.equal(provider.get('1F', 'other'), null));
ok('DELETE removes the in-memory state', () => {
  assert.equal(provider.stop('1F'), true);
  assert.equal(provider.get('1F', DEMO_SESSION_ID), null);
});
ok('DELETE on another floor does not stop the active demo', () => {
  provider.start('3F');
  assert.equal(provider.stop('1F'), false);
  assert.ok(provider.get('3F', DEMO_SESSION_ID));
  provider.stopAll();
});
ok('starting demo on another floor replaces the previous demo', () => {
  provider.start('1F');
  provider.start('3F');
  assert.equal(provider.get('1F', DEMO_SESSION_ID), null);
  assert.ok(provider.get('3F', DEMO_SESSION_ID));
  provider.stopAll();
});
ok('unknown floor is rejected', () => assert.throws(() => provider.start('99F')));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
