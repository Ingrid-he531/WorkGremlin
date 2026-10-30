/**
 * Remote dispatch — Claude Code (4F) recipe and permission modes.
 *
 * Pinned rules:
 *   · 4F is selectable and exposes Claude Code's permission modes; 8F still only offers auto;
 *   · the first turn uses `--session-id <uuid>`, later turns `--resume <uuid>`;
 *   · the permission choice is passed through (`bypassPermissions` uses the explicit bypass flag);
 *   · stream-json text deltas become the transcript, not raw JSON;
 *   · an unsupported permission is rejected instead of silently downgraded.
 *
 * Run: `npm run test:dispatch-claude`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDispatchService } = require('../src/control/service');
const { claudeStreamParser, claudeModelsFromFile, recipeOf } = require('../src/control/recipes');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-claude-dispatch-'));
const WORKSPACE = path.join(TMP, 'workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

(async () => {
head('recipe');
{
  const recipe = recipeOf('4F');
  ok('4F exists', Boolean(recipe));
  ok('4F is Claude Code', recipe.client === 'claude' && recipe.name === 'Claude Code');
  ok('4F exposes its permission modes', JSON.stringify(recipe.permissions) === JSON.stringify(['auto', 'acceptEdits', 'bypassPermissions', 'plan']));
  ok('8F still only has auto', JSON.stringify(recipeOf('8F').permissions) === JSON.stringify(['auto']));
  const settingsFile = path.join(TMP, 'claude-settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      modelPicker: {
        options: [
          { label: 'Claude Sonnet', model: 'auto/sonnet' },
          { label: 'DeepSeek', model: 'auto/deepseek' },
          { label: 'duplicate', model: 'auto/sonnet' },
        ],
      },
    })
  );
  const catalog = claudeModelsFromFile(settingsFile);
  ok('Claude model picker is read from settings.json', catalog.models.join(',') === 'auto/sonnet,auto/deepseek', JSON.stringify(catalog));
  ok('Claude model labels are carried', catalog.labels['auto/sonnet'] === 'Claude Sonnet', JSON.stringify(catalog.labels));
  ok('a missing settings file is not an error', claudeModelsFromFile(path.join(TMP, 'missing.json')).models.length === 0);
  const first = recipe.build({ prompt: 'hi', sessionId: '11111111-1111-4111-8111-111111111111', permission: 'acceptEdits', resume: false });
  ok('first turn uses --session-id', first.args.includes('--session-id') && first.args.includes('11111111-1111-4111-8111-111111111111'), JSON.stringify(first.args));
  ok('prompt goes over stdin', first.stdin === 'hi');
  ok('permission mode is passed', first.args.includes('--permission-mode') && first.args.includes('acceptEdits'));
  const resumed = recipe.build({ prompt: 'again', sessionId: '11111111-1111-4111-8111-111111111111', permission: 'bypassPermissions', resume: true });
  ok('later turns use --resume', resumed.args.includes('--resume') && !resumed.args.includes('--session-id'), JSON.stringify(resumed.args));
  ok('bypass uses the explicit flag', resumed.args.includes('--dangerously-skip-permissions'));
  ok('resume does not repeat a session mode', !resumed.args.includes('--permission-mode'));
}

head('stream-json parser');
{
  const p = claudeStreamParser();
  const first = p.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}}\n');
  ok('text deltas become text (not JSON)', first === 'Hello world', JSON.stringify(first));
  const tail = p.push('{"type":"result','"');
  ok('a partial line is buffered', tail === '', JSON.stringify(tail));
  ok('flush handles the last line', p.flush() === '', 'unexpected non-empty flush');

  const split = claudeStreamParser();
  ok('a chunk split inside a text value stays buffered', split.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello ') === '', '');
  ok('the split text keeps the space between words', split.push('world"}}}\n') === 'Hello world', JSON.stringify(split.push('')));
}

head('service + permissions + continuity');
{
  const runs = [];
  const events = [];
  const service = createDispatchService({
    storeFile: null,
    readConfig: () => ({ mode: 'auto' }),
    broadcast: (_p, _t, payload) => events.push(payload),
    binFor: (floor) => (floor === '4F' ? '/fake/claude' : null),
    runCommand: (arg) =>
      new Promise((resolve) => {
        runs.push({ arg, resolve });
      }),
  });

  const overview = service.floors();
  const claude = overview.find((f) => f.id === '4F');
  ok('4F is listed as available', Boolean(claude && claude.available));
  ok('4F carries its permission choices', claude && claude.permissions.includes('bypassPermissions'));
  ok('8F carries only auto', JSON.stringify(overview.find((f) => f.id === '8F').permissions) === JSON.stringify(['auto']));

  const session = service.createSession({
    floor: '4F',
    workspacePath: WORKSPACE,
  });
  ok('session defaults to the floor permission', session.permission === 'auto', session.permission);
  ok('Claude session id is a UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session.productSessionId), session.productSessionId);
  ok('4F does not pretend to have an OpenCode id', session.opencodeSessionId === null);

  let r = service.sendTurn(session.id, { prompt: 'write a file', permission: 'bypassPermissions' });
  ok('auto mode starts immediately', r.state === 'running', r.state);
  ok('the turn records the chosen permission', r.permission === 'bypassPermissions', r.permission);
  ok('first run uses --session-id', runs[0].arg.args.includes('--session-id'));
  ok('prompt is piped over stdin', runs[0].arg.stdin === 'write a file');
  runs[0].arg.onData('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}}\n');
  runs[0].resolve({ status: 'ok', exitCode: 0, stdout: '', stderr: '' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const saved = service.getSession(session.id);
  ok('streamed text is stored', saved.turns[0].output === 'done', saved.turns[0].output);
  ok('turn is done', saved.turns[0].state === 'done', saved.turns[0].state);

  r = service.sendTurn(session.id, { prompt: 'continue', permission: 'acceptEdits' });
  ok('second turn starts', r.state === 'running', r.state);
  ok('later turn uses --resume', runs[1].arg.args.includes('--resume') && !runs[1].arg.args.includes('--session-id'), JSON.stringify(runs[1].arg.args));
  ok('same session id is resumed', runs[1].arg.args.includes(session.productSessionId));
  ok('the next turn can use a different permission', runs[1].arg.args.includes('--permission-mode') && runs[1].arg.args.includes('acceptEdits'), JSON.stringify(runs[1].arg.args));
  runs[1].resolve({ status: 'ok', exitCode: 0, stdout: '', stderr: '' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  let error = '';
  try {
    service.sendTurn(session.id, { prompt: 'bad permission', permission: 'not-a-mode' });
  } catch (err) {
    error = (err && err.message) || String(err);
  }
  ok('an unsupported permission is rejected', /不支持这个权限选项/.test(error), error);

  service.dispose();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
