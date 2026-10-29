/**
 * Remote dispatch API self-check — real Express router + real service, only the CLI runner is faked
 * (starting OpenCode for real would spend tokens and needs a reachable model).
 *
 * Pinned rules:
 *   · policy comes from the server config file; there is no HTTP write endpoint for it;
 *   · `off` refuses turns; `confirm` parks a turn (202) until a loopback decision; `auto` starts it;
 *   · a session keeps one OpenCode session id across turns (`--session` continuity);
 *   · output is streamed as it arrives and kept on the turn; one active turn per session;
 *   · workspace must be an existing absolute directory; prompts must not be empty;
 *   · decisions are loopback-only (a remote client cannot approve itself).
 *
 * Run: `npm run test:dispatch`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createDispatchService, parseModelList } = require('../src/control/service');
const { createDispatchRouter, isLoopback } = require('../src/http/routes/dispatch');
const { readDispatchConfig } = require('../src/control/config');

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
const head = (t) => console.log(`\n${t}`);

const WORKSPACE = path.resolve(__dirname, '..');

/** @returns {Promise<{base: string, close: () => void}>} */
async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

function makeHarness() {
  /** Stand-in for ~/.workgremlin/config.json (re-read on every policy check) */
  const config = { mode: 'off' };
  /** Deferred runs: the test decides when a fake CLI emits output / finishes */
  const runs = [];
  /** Broadcast payloads, to assert streaming */
  const events = [];
  const service = createDispatchService({
    storeFile: null,
    readConfig: () => ({ ...config }),
    broadcast: (_project, _type, payload) => events.push(payload),
    binFor: (floor) => (floor === '8F' ? '/fake/opencode' : null),
    recipeFor: () => ({
      build: ({ prompt, sessionId, model }) => ({
        args: ['run', prompt, '--session', sessionId, ...(model ? ['-m', model] : [])],
      }),
    }),
    fetchModels: async () => ({
      models: ['opencode-go/deepseek-v4.1-flash', 'opencode/deepseek-v4.1-flash-free'],
      error: '',
    }),
    runCommand: (arg) =>
      new Promise((resolve) => {
        runs.push({ arg, resolve });
      }),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createDispatchRouter({ service }));
  return { service, config, runs, events, app };
}

const getJson = async (url, init) => {
  const res = await fetch(url, init);
  const data = await res.json();
  return { status: res.status, data };
};

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

(async () => {
  head('loopback detection');
  {
    const fake = (ip) => ({ ip, socket: {} });
    ok('IPv4 loopback', isLoopback(fake('127.0.0.1')));
    ok('IPv6-mapped loopback', isLoopback(fake('::ffff:127.0.0.1')));
    ok('IPv6 loopback', isLoopback(fake('::1')));
    ok('remote address is not loopback', !isLoopback(fake('10.10.0.5')));
    ok('missing address is not loopback', !isLoopback({ socket: {} }));
  }

  head('model catalog parsing');
  {
    ok(
      'keeps provider/model refs (variants included)',
      JSON.stringify(parseModelList('opencode-go/a\nopencode/b#high\n')) ===
        JSON.stringify(['opencode-go/a', 'opencode/b#high']),
      JSON.stringify(parseModelList('opencode-go/a\nopencode/b#high\n'))
    );
    ok('drops blank lines and CLI banners', parseModelList('\nLoading models…\nnot-a-ref\nx/y\n').join(',') === 'x/y');
    ok('dedupes repeated refs', parseModelList('a/b\na/b\n').length === 1);
  }

  head('server config file');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dispatch-config-'));
    const file = path.join(dir, 'config.json');

    ok('missing file -> off', readDispatchConfig({ file, env: {} }).mode === 'off');

    fs.writeFileSync(file, JSON.stringify({ dispatch: { mode: 'auto' } }));
    ok('file mode auto', readDispatchConfig({ file, env: {} }).mode === 'auto');

    fs.writeFileSync(file, JSON.stringify({ dispatch: { mode: 'bogus' } }));
    ok('invalid mode -> off (never allow by accident)', readDispatchConfig({ file, env: {} }).mode === 'off');

    fs.writeFileSync(file, JSON.stringify({ dispatch: { mode: 'confirm' } }));
    ok('env overrides the file', readDispatchConfig({ file, env: { WORKGREMLIN_DISPATCH_MODE: 'auto' } }).mode === 'auto');
    ok('invalid env is ignored', readDispatchConfig({ file, env: { WORKGREMLIN_DISPATCH_MODE: 'nope' } }).mode === 'confirm');

    fs.writeFileSync(file, '{ not json');
    ok('broken json -> off', readDispatchConfig({ file, env: {} }).mode === 'off');

    fs.rmSync(dir, { recursive: true, force: true });
  }

  head('sessions + confirm lifecycle');
  {
    const { app, config, runs, events } = makeHarness();
    const { base, close } = await listen(app);

    let r = await getJson(`${base}/api/v1/dispatch`);
    ok('default mode is off', r.data.mode === 'off');
    ok('8F is listed and available', r.data.floors.some((f) => f.id === '8F' && f.available));
    ok('loopback connection can approve', r.data.canApprove === true);
    ok('the policy is not editable over HTTP', r.data.editable === undefined);
    ok('no sessions yet', r.data.sessions.length === 0);

    // Model catalog for the per-turn picker
    r = await getJson(`${base}/api/v1/dispatch/models?floor=8F`);
    ok(
      'model catalog is exposed for the picker',
      r.status === 200 && r.data.models.includes('opencode-go/deepseek-v4.1-flash'),
      JSON.stringify(r.data)
    );
    r = await getJson(`${base}/api/v1/dispatch/models?floor=9F`);
    ok('unknown floor model list -> 400', r.status === 400, `status=${r.status}`);

    // Session validation
    r = await getJson(`${base}/api/v1/dispatch/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ floor: '9F', workspacePath: WORKSPACE }) });
    ok('unsupported floor -> 400', r.status === 400, `status=${r.status}`);
    r = await getJson(`${base}/api/v1/dispatch/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ floor: '8F', workspacePath: 'relative/dir' }) });
    ok('relative path -> 400', r.status === 400);
    r = await getJson(`${base}/api/v1/dispatch/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ floor: '8F', workspacePath: '/definitely/not/here' }) });
    ok('missing dir -> 400', r.status === 400);

    // Create a session
    r = await getJson(`${base}/api/v1/dispatch/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ floor: '8F', workspacePath: WORKSPACE }) });
    const session = r.data.session;
    ok('create session -> 201', r.status === 201 && Boolean(session.id));
    ok('session mints an OpenCode session id', /^ses_wg/.test(session.opencodeSessionId || ''), session.opencodeSessionId);
    ok('session is idle', r.data.session.state === 'idle');

    const send = (prompt, extra) => post(`${base}/api/v1/dispatch/sessions/${session.id}/turns`, { prompt, ...(extra || {}) });

    // off mode refuses the turn
    ok('off-mode turn -> 403', (await send('做点小事')).status === 403);

    // Switch the server config file (not an HTTP call) to confirm
    config.mode = 'confirm';
    r = await getJson(`${base}/api/v1/dispatch`);
    ok('config edit is picked up without restart', r.data.mode === 'confirm');

    let res = await send('第一轮', { model: 'opencode-go/deepseek-v4.1-flash' });
    const pending = await res.json();
    ok('confirm -> 202 pending', res.status === 202 && pending.turn.state === 'pending');
    ok('pending turn records the chosen model', pending.turn.model === 'opencode-go/deepseek-v4.1-flash', pending.turn.model);
    ok('one active turn per session (busy)', (await send('插队')).status === 409);

    // Detail shows the pending turn
    r = await getJson(`${base}/api/v1/dispatch/sessions/${session.id}`);
    ok('detail has the pending turn', r.data.session.turns.length === 1 && r.data.session.turns[0].state === 'pending');

    // Reject it
    r = await getJson(`${base}/api/v1/dispatch/turns/${pending.turn.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: false }) });
    ok('reject -> rejected', r.data.turn.state === 'rejected');

    // Approve -> running, stream output, finish
    res = await send('第二轮', { model: 'opencode-go/glm-5.3' });
    const second = await res.json();
    r = await getJson(`${base}/api/v1/dispatch/turns/${second.turn.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true }) });
    ok('approve -> running', r.data.turn.state === 'running');
    ok('the CLI was started once', runs.length === 1);
    ok('continuity passes the same session id', runs[0].arg.args.includes(session.opencodeSessionId));
    ok(
      'the approved turn runs with the model chosen when it was sent',
      runs[0].arg.args.includes('-m') && runs[0].arg.args.includes('opencode-go/glm-5.3'),
      JSON.stringify(runs[0].arg.args)
    );

    runs[0].arg.onData('hello ');
    runs[0].arg.onData('world');
    const outputEvents = events.filter((e) => e.kind === 'output');
    ok('output is streamed', outputEvents.length === 2 && outputEvents[0].chunk === 'hello ');

    runs[0].resolve({ status: 'ok', exitCode: 0, stdout: '', stderr: '' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    r = await getJson(`${base}/api/v1/dispatch/sessions/${session.id}`);
    const doneTurn = r.data.session.turns[1];
    ok('runner ok -> done', doneTurn.state === 'done');
    ok('streamed output is kept on the turn', doneTurn.output.includes('hello world'), doneTurn.output);
    ok('session title comes from the first prompt', r.data.session.title === '第一轮');

    // Failure keeps the raw error; the next turn may omit the model (floor default)
    res = await send('第三轮');
    const third = await res.json();
    await getJson(`${base}/api/v1/dispatch/turns/${third.turn.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true }) });
    ok('omitting the model passes no -m flag', !runs[1].arg.args.includes('-m'), JSON.stringify(runs[1].arg.args));
    runs[1].resolve({ status: 'failed', exitCode: 1, stdout: '', stderr: 'provider said no' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    r = await getJson(`${base}/api/v1/dispatch/sessions/${session.id}`);
    const failedTurn = r.data.session.turns.find((t) => t.id === third.turn.id);
    ok('runner failed -> failed', failedTurn && failedTurn.state === 'failed');
    ok('raw error is kept', failedTurn && failedTurn.error.includes('provider said no'));

    // Delete the session
    r = await getJson(`${base}/api/v1/dispatch/sessions/${session.id}`, { method: 'DELETE' });
    ok('delete session', r.status === 200 && r.data.ok === true);
    r = await getJson(`${base}/api/v1/dispatch/sessions/${session.id}`);
    ok('deleted session -> 404', r.status === 404);

    close();
  }

  head('auto mode + cancel');
  {
    const { app, config, runs } = makeHarness();
    const { base, close } = await listen(app);
    config.mode = 'auto';

    let r = await getJson(`${base}/api/v1/dispatch/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ floor: '8F', workspacePath: WORKSPACE }) });
    const session = r.data.session;

    let res = await post(`${base}/api/v1/dispatch/sessions/${session.id}/turns`, { prompt: '直接跑' });
    const body = await res.json();
    ok('auto -> starts immediately (200 running)', res.status === 200 && body.turn.state === 'running');
    ok('one fake run started', runs.length === 1);

    // Cancel the running turn
    r = await getJson(`${base}/api/v1/dispatch/turns/${body.turn.id}`, { method: 'DELETE' });
    ok('cancel running -> cancelled', r.data.turn.state === 'cancelled');
    runs[0].resolve({ status: 'failed', exitCode: null, stdout: '', stderr: '' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A second prompt is allowed once the turn is no longer active
    res = await post(`${base}/api/v1/dispatch/sessions/${session.id}/turns`, { prompt: '第二轮' });
    ok('next turn starts after cancel', res.status === 200);
    runs[1].resolve({ status: 'ok', exitCode: 0, stdout: '', stderr: '' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Legacy sessions created with a model keep it as the fallback for turns that omit one.
    r = await getJson(`${base}/api/v1/dispatch/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ floor: '8F', workspacePath: WORKSPACE, model: 'opencode-go/kimi-k3' }),
    });
    res = await post(`${base}/api/v1/dispatch/sessions/${r.data.session.id}/turns`, { prompt: '继承会话模型' });
    const legacyTurn = await res.json();
    ok('session-level model is used when a turn omits one', runs[2].arg.args.includes('opencode-go/kimi-k3'), JSON.stringify(runs[2].arg.args));
    ok('the turn itself reports no explicit model', legacyTurn.turn.model === '', legacyTurn.turn.model);
    runs[2].resolve({ status: 'ok', exitCode: 0, stdout: '', stderr: '' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    close();
  }

  head('persistence across restarts');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dispatch-store-'));
    const storeFile = path.join(dir, 'sessions.json');
    const config = { mode: 'auto' };
    const runs = [];
    const mk = (mode) =>
      createDispatchService({
        storeFile,
        readConfig: () => ({ ...config, mode }),
        broadcast: () => {},
        binFor: (floor) => (floor === '8F' ? '/fake/opencode' : null),
        recipeFor: () => ({
          build: ({ sessionId, model }) => ({
            args: ['run', '--session', sessionId, ...(model ? ['-m', model] : [])],
          }),
        }),
        runCommand: (arg) => new Promise((resolve) => runs.push({ arg, resolve })),
      });

    // First "server process": one completed turn
    const s1 = mk('auto');
    const created = s1.createSession({ floor: '8F', workspacePath: WORKSPACE });
    s1.sendTurn(created.id, { prompt: '记住我', model: 'opencode-go/deepseek-v4.1-flash' });
    runs[0].arg.onData('持久化输出');
    runs[0].resolve({ status: 'ok', exitCode: 0, stdout: '', stderr: '' });
    await new Promise((r) => setTimeout(r, 30));
    s1.dispose();

    // Second "server process": everything comes back from disk
    const s2 = mk('auto');
    const restored = s2.list();
    ok('restored the session list', restored.length === 1 && restored[0].id === created.id);
    const detail = s2.getSession(created.id);
    ok('restored the transcript', detail.turns.length === 1 && detail.turns[0].state === 'done');
    ok('restored the output', detail.turns[0].output.includes('持久化输出'), detail.turns[0].output);
    ok('restored the per-turn model', detail.turns[0].model === 'opencode-go/deepseek-v4.1-flash', detail.turns[0].model);
    ok('restored the OpenCode session id', detail.opencodeSessionId === created.opencodeSessionId);

    s2.sendTurn(created.id, { prompt: '继续' });
    ok(
      'continuing uses the restored OpenCode session',
      runs[1].arg.args.includes(created.opencodeSessionId)
    );
    ok('a turn without a model keeps the floor default', !runs[1].arg.args.includes('-m'), JSON.stringify(runs[1].arg.args));
    runs[1].resolve({ status: 'ok', exitCode: 0, stdout: '', stderr: '' });
    await new Promise((r) => setTimeout(r, 30));
    s2.dispose();

    // A turn that was running when the process died must not look finished
    const s3 = mk('auto');
    const running = s3.createSession({ floor: '8F', workspacePath: WORKSPACE });
    s3.sendTurn(running.id, { prompt: '会被中断' });
    s3.dispose(); // flush with state=running
    const s4 = mk('auto');
    const after = s4.getSession(running.id);
    ok('running turn restored as failed', after.turns[0].state === 'failed', after.turns[0].state);
    ok('the interruption is explained', /重启/.test(after.turns[0].error), after.turns[0].error);
    s4.dispose();

    // A still-pending confirmation must not stay pending forever
    const s5 = mk('confirm');
    const pending = s5.createSession({ floor: '8F', workspacePath: WORKSPACE });
    s5.sendTurn(pending.id, { prompt: '等待确认' });
    s5.dispose();
    const s6 = mk('confirm');
    const expired = s6.getSession(pending.id);
    ok('pending turn restored as expired', expired.turns[0].state === 'expired', expired.turns[0].state);
    s6.dispose();

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
