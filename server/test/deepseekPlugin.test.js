'use strict';

/**
 * DeepSeek Harness reporter event-mapping self-test.
 *
 * Run: `npm run test:dsh` (this file is the plugin half).
 *
 * The DSH plugin is installed into `$DSH_HOME` and must not depend on the repo,
 * so it is an ESM module. This test imports it directly and drives the pure
 * `DshReporter` with synthetic durable events; no DSH process or server needed.
 */

const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// Never touch the developer's real reporter state / server during this unit test.
process.env.WORKGREMLIN_HOME = path.join(os.tmpdir(), 'wg-dsh-plugin-test-nohome');
process.env.WORKGREMLIN_DISABLE = '1';

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail !== undefined ? `  — ${detail}` : ''}`);
  }
}

(async () => {
  const { DshReporter, apply } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'reporter', 'src', 'plugin-dsh', 'index.mjs')).href);

  console.log('\n[A] session lifecycle and user prompt');
  const posted = [];
  const reporter = new DshReporter({ post: (payload) => posted.push(payload) });
  const main = { id: 's-main', header: { id: 's-main', cwd: '/tmp/DeepSeekProj' } };
  reporter.sessionCreated(main);
  reporter.sessionEvent(main, { type: 'model/selection', data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } });
  reporter.sessionEvent(main, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] },
  });
  {
    const start = posted.find((p) => p.hook_event_name === 'SessionStart');
    const prompt = posted.find((p) => p.hook_event_name === 'UserPromptSubmit');
    ok('SessionStart carries the cwd and agent dsh', Boolean(start && start.cwd === '/tmp/DeepSeekProj' && start.agent === 'dsh'));
    ok('UserPromptSubmit carries the human prompt', Boolean(prompt && prompt.prompt === 'fix the parser'), JSON.stringify(prompt));
    ok('the model selection becomes the task model', Boolean(prompt && prompt.model === 'opencode-go/deepseek-v4.1-flash'), prompt && prompt.model);
  }

  console.log('\n[B] tool call/result and file-capable input');
  reporter.sessionEvent(main, { type: 'turn/start', data: { turn: 1 } });
  reporter.sessionEvent(main, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{"path":"src/a.js","content":"x"}' },
  });
  reporter.sessionEvent(main, {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'written' }] } },
  });
  {
    const pre = posted.find((p) => p.hook_event_name === 'PreToolUse');
    const post = posted.find((p) => p.hook_event_name === 'PostToolUse');
    ok('PreToolUse parses the JSON arguments', Boolean(pre && pre.tool_name === 'write' && pre.tool_input.path === 'src/a.js'), JSON.stringify(pre));
    ok('PostToolUse pairs by callId and includes the response', Boolean(post && post.tool_name === 'write' && post.tool_response === 'written'), JSON.stringify(post));
  }

  console.log('\n[C] approval events: waiting is reported, a decision clears it');
  reporter.sessionEvent(main, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'c2', reason: 'run tests?' } });
  reporter.sessionEvent(main, { type: 'approval/decided', data: { id: 'a1', outcome: 'approved' } });
  {
    const asked = posted.find((p) => p.hook_event_name === 'PermissionRequest');
    const decided = posted.find((p) => p.hook_event_name === 'PermissionResolved');
    ok('approval/asked becomes PermissionRequest with the tool name', Boolean(asked && asked.tool_name === 'bash'));
    ok('approval/decided becomes PermissionResolved', Boolean(decided && decided.outcome === 'approved'));
  }

  console.log('\n[D] turn end: token usage, final answer, and completion state');
  reporter.sessionEvent(main, {
    type: 'assistant/message',
    data: {
      message: { id: 'm1', content: [{ type: 'text', text: 'parser fixed' }] },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
    },
  });
  reporter.sessionEvent(main, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  {
    const stop = posted.find((p) => p.hook_event_name === 'Stop');
    ok('Stop carries the last assistant answer', Boolean(stop && stop.last_assistant_message === 'parser fixed'));
    ok(
      'Stop carries disjoint token counts',
      Boolean(stop && stop.tokens && stop.tokens.input === 10 && stop.tokens.output === 5 && stop.tokens.cacheRead === 2 && stop.tokens.cacheWrite === 1),
      JSON.stringify(stop && stop.tokens)
    );
    ok('a completed turn is completed, not cancelled', Boolean(stop && stop.stop_reason === 'completed'));
  }

  console.log('\n[E] aborted / failed turns are distinguishable');
  {
    const before = posted.length;
    reporter.sessionEvent(main, { type: 'turn/start', data: { turn: 2 } });
    reporter.sessionEvent(main, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } });
    const stop = posted.slice(before).find((p) => p.hook_event_name === 'Stop');
    ok('aborted maps to cancelled', Boolean(stop && stop.stop_reason === 'cancelled'), stop && stop.stop_reason);
  }
  {
    const before = posted.length;
    reporter.sessionEvent(main, { type: 'turn/start', data: { turn: 3 } });
    reporter.sessionEvent(main, { type: 'turn/end', data: { turn: 3, reason: { kind: 'error' } } });
    const stop = posted.slice(before).find((p) => p.hook_event_name === 'Stop');
    ok('error maps to failed', Boolean(stop && stop.stop_reason === 'failed'), stop && stop.stop_reason);
  }
  {
    const before = posted.length;
    reporter.sessionEvent(main, { type: 'turn/start', data: { turn: 4 } });
    reporter.sessionEvent(main, { type: 'turn/end', data: { turn: 4, reason: { kind: 'blocked' } } });
    const stop = posted.slice(before).find((p) => p.hook_event_name === 'Stop');
    ok('blocked maps to cancelled', Boolean(stop && stop.stop_reason === 'cancelled'), stop && stop.stop_reason);
  }

  console.log('\n[F] subagent: child sessions are not reported; SubagentStop targets the parent');
  {
    const before = posted.length;
    const child = { id: 's-child', header: { id: 's-child', cwd: '/tmp/DeepSeekProj', origin: 'subagent', parentSession: 's-main' } };
    reporter.sessionCreated(child);
    ok('a child session creation is not reported as a main session', posted.length === before);
    reporter.subagentEnd({ id: 's-child', lastAssistantMessage: [{ type: 'text', text: 'child done' }] });
    const stop = posted.slice(before).find((p) => p.hook_event_name === 'SubagentStop');
    ok('SubagentStop uses the parent session id', Boolean(stop && stop.session_id === 's-main'));
    ok('SubagentStop carries the child id and result', Boolean(stop && stop.agent_id === 's-child' && stop.last_assistant_message === 'child done'), JSON.stringify(stop));
  }

  console.log('\n[G] plugin entry shape');
  ok('apply() is exported for Cordis', typeof apply === 'function');
  ok('the plugin declares a stable name', (await import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'reporter', 'src', 'plugin-dsh', 'index.mjs')).href)).name === 'workgremlin-dsh-reporter');

  console.log('\n[H] apply() wires the DSH lifecycle events');
  {
    const handlers = {};
    let effectInstalled = false;
    const ctx = {
      on: (event, handler) => { handlers[event] = handler; },
      effect: (fn) => { effectInstalled = true; return fn(); },
    };
    apply(ctx);
    ok('session/created is wired', typeof handlers['session/created'] === 'function');
    ok('session/event is wired', typeof handlers['session/event'] === 'function');
    ok('session/disposed is wired', typeof handlers['session/disposed'] === 'function');
    ok('subagent/end is wired', typeof handlers['subagent/end'] === 'function');
    ok('a disposer is registered through ctx.effect', effectInstalled);
    // Calling with no server.json must be a silent no-op, not a throw.
    handlers['session/created']({ id: 's-no-server', header: { id: 's-no-server', cwd: '/tmp/x' } });
    handlers['session/event']({ id: 's-no-server', header: { id: 's-no-server', cwd: '/tmp/x' } }, { type: 'turn/start', data: { turn: 1 } });
    ok('events without a local server do not throw', true);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
