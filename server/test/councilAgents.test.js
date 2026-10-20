/**
 * Council CLI recipes + output parsing self-check — pure data, no processes.
 *
 * Three properties are load-bearing and pinned separately:
 *   1. **Read-only is real.** The council room accepts participants only if every recipe removes the
 *      ability to write: 1F/4F via `--tools`, 7F/8F via a deny-by-default permission table, 2F via
 *      `--plan`, 3F via `--sandbox read-only`. If this regresses, the feature is not "a meeting", it is
 *      an agent editing the user's project.
 *   2. **No office leakage.** WorkGremlin's own reporting is disabled in the environment, plugins are
 *      stripped (7F), a private server is used (8F), and the session title/prompt marker is stamped
 *      where the CLI supports one.
 *   3. **Cannot parse means cannot parse.** Unknown output yields `ok:false`; the prompt echo and error
 *      events must never be served as the participant's speech.
 *
 * Run: `npm run test:council-agents`
 */
'use strict';

const {
  RECIPES,
  READ_PERMISSION,
  READ_TOOLS,
  QUIET_ENV,
  parseOutput,
} = require('../src/council/agents');
const { roleBlock } = require('../src/council/prompt');
const { DEFAULTS } = require('@workgremlin/shared');

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

const FLOORS = ['1F', '2F', '3F', '4F', '6F', '7F', '8F'];
const build = (floor, prompt = '问题') => RECIPES[floor].build({ bin: `/usr/bin/${floor}`, prompt });

/* ------------------------------------------------------------ recipes present */
head('every floor has a recipe');
for (const f of FLOORS) ok(`${f} has build()`, Boolean(RECIPES[f] && typeof RECIPES[f].build === 'function'));
ok('no unexpected floors', Object.keys(RECIPES).length === FLOORS.length, Object.keys(RECIPES).join(','));

/* ------------------------------------------------------------ read-only */
head('read-only: 1F / 4F whitelist read tools only');
{
  for (const floor of ['1F', '4F']) {
    const inv = build(floor);
    const toolsAt = inv.args.indexOf('--tools');
    ok(`${floor} --tools is the read-only list (${READ_TOOLS})`,
      toolsAt >= 0 && inv.args[toolsAt + 1] === READ_TOOLS, JSON.stringify(inv.args));
    ok(`${floor} also allows those tools without a prompt (otherwise it can read nothing)`,
      inv.args[inv.args.indexOf('--allowedTools') + 1] === READ_TOOLS, JSON.stringify(inv.args));
    ok(`${floor} does not contain Write/Edit/Bash in the whitelist`,
      !/Write|Edit|Bash/.test(inv.args[toolsAt + 1]), inv.args[toolsAt + 1]);
  }
  const c4 = build('4F');
  ok('4F --permission-prompts comes before the variadic --allowedTools',
    c4.args.indexOf('--permission-prompts') < c4.args.indexOf('--allowedTools'), JSON.stringify(c4.args));
  ok('4F refuses rather than waiting when nobody answers', c4.args[c4.args.indexOf('--permission-prompts') + 1] === 'none');
  ok('4F does not load MCP servers from user config', c4.args.includes('--strict-mcp-config'));
}
{
  const inv = build('7F');
  const cfg = JSON.parse(inv.env.KILO_CONFIG_CONTENT);
  ok('7F injects KILO_CONFIG_CONTENT', Boolean(inv.env.KILO_CONFIG_CONTENT));
  ok('7F catch-all is deny', cfg.permission['*'] === 'deny');
  ok('7F allows only read/glob/grep/list',
    ['read', 'glob', 'grep', 'list'].every((k) => cfg.permission[k] === 'allow'));
  ok('7F denies bash/edit/write',
    ['bash', 'edit', 'write'].every((k) => cfg.permission[k] === 'deny'));
  ok('7F denies web/task/skill', ['webfetch', 'websearch', 'task', 'skill'].every((k) => cfg.permission[k] === 'deny'));
  ok('7F strips the plugin list (otherwise participants are reported into the office)',
    Array.isArray(cfg.plugin) && cfg.plugin.length === 0, JSON.stringify(cfg.plugin));
}
{
  const inv = build('8F');
  const cfg = JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT);
  ok('8F injects OPENCODE_CONFIG_CONTENT', Boolean(inv.env.OPENCODE_CONFIG_CONTENT));
  ok('8F allows read/glob/grep/list and denies bash/write',
    ['read', 'glob', 'grep', 'list'].every((k) => cfg.permission[k] === 'allow') &&
      cfg.permission.bash === 'deny' && cfg.permission.write === 'deny');
  ok('8F blocks external_directory too', cfg.permission.external_directory === 'deny');
  ok('8F runs --standalone so QUIET_ENV reaches a private server', inv.args.includes('--standalone'));
}
{
  ok('the shared permission table only allows read-type tools',
    Object.entries(READ_PERMISSION).every(([k, v]) =>
      k === '*' ? v === 'deny' : (['read', 'glob', 'grep', 'list'].includes(k) ? v === 'allow' : v === 'deny')));
}
{
  const c2 = build('2F');
  ok('2F uses --plan (Cline\'s own read-only mode)', c2.args.includes('--plan'), JSON.stringify(c2.args));
  ok('2F asks for JSON output', c2.args.includes('--json'));
  ok('2F passes the prompt positionally (its JSON mode refuses stdin)', c2.args.includes('问题') && c2.stdin === null);
}
{
  const c3 = build('3F');
  ok('3F runs codex exec', c3.args[0] === 'exec', JSON.stringify(c3.args));
  ok('3F pins --sandbox read-only', c3.args[c3.args.indexOf('--sandbox') + 1] === 'read-only');
  ok('3F is ephemeral (no session lands on the office 3F)', c3.args.includes('--ephemeral'));
  ok('3F ignores the user config (no user MCP servers)', c3.args.includes('--ignore-user-config'));
  ok('3F disables web search', c3.args.includes('web_search="disabled"'));
  ok('3F reads the prompt from stdin', c3.stdin === '问题' && c3.args[c3.args.length - 1] === '-');
}
{
  const c6 = build('6F');
  ok('6F uses -p headless mode', c6.args.includes('-p'));
  ok('6F asks for JSON output', c6.args[c6.args.indexOf('--output-format') + 1] === 'json');
  ok('6F stamps the fixed session title with --name',
    c6.args[c6.args.indexOf('--name') + 1] === DEFAULTS.COUNCIL_SESSION_TITLE);
  ok('6F reads the prompt from stdin', c6.stdin === '问题' && !c6.args.includes('问题'));
}

/* ------------------------------------------------------------ invocation shape */
head('invocation shape');
{
  for (const floor of ['1F', '4F', '3F', '6F']) {
    const inv = RECIPES[floor].build({ bin: '/x', prompt: 'a long prompt' });
    ok(`${floor} sends the prompt over stdin, not argv`, inv.stdin === 'a long prompt' && !inv.args.includes('a long prompt'));
  }
  const c7 = build('7F', '提示词');
  ok('7F sends the prompt positionally', c7.args[0] === 'run' && c7.args[1] === '提示词' && c7.stdin === null);
  ok('7F asks for JSON output', c7.args.includes('--format') && c7.args.includes('json'));
  const c8 = build('8F', '提示词');
  ok('8F sends the prompt positionally', c8.args[0] === 'run' && c8.args[1] === '提示词' && c8.stdin === null);
  ok('7F does not need --standalone (it strips plugins via config)',
    !build('7F').args.includes('--standalone'));
}
{
  // Environment is layered on top of process.env, never a replacement: login credentials are found via HOME.
  for (const f of FLOORS) {
    const env = RECIPES[f].build({ bin: '/x', prompt: 'p' }).env;
    ok(`${f} does not override HOME`, !('HOME' in env));
  }
}

/* ------------------------------------------------------------ office isolation */
head('office isolation');
for (const f of FLOORS) {
  const env = RECIPES[f].build({ bin: '/x', prompt: 'p' }).env;
  ok(`${f} injects WORKGREMLIN_DISABLE=1`, env.WORKGREMLIN_DISABLE === '1', JSON.stringify(env));
}
ok('QUIET_ENV contains exactly that one flag',
  Object.keys(QUIET_ENV).length === 1 && QUIET_ENV.WORKGREMLIN_DISABLE === '1');
for (const f of ['7F', '8F']) {
  const args = build(f).args;
  const at = args.indexOf('--title');
  ok(`${f} stamps the fixed session title`, at >= 0 && args[at + 1] === DEFAULTS.COUNCIL_SESSION_TITLE, JSON.stringify(args));
  ok(`${f} does not pass --title twice`, args.filter((a) => a === '--title').length === 1);
}
for (const f of ['1F', '4F']) {
  ok(`${f} does not need --title (it does not persist a session)`, !build(f).args.includes('--title'));
  ok(`${f} uses --no-session-persistence`, build(f).args.includes('--no-session-persistence'));
}
ok('2F has no title switch (the marker rides in the prompt)',
  !build('2F').args.includes('--title'));
ok('the role block starts with COUNCIL_PROMPT_MARKER (the 2F lock depends on this exact phrase)',
  roleBlock('2F', 'Cline', 'reviewer').includes(DEFAULTS.COUNCIL_PROMPT_MARKER));
ok('the role block names the role and forbids writes',
  roleBlock('2F', 'Cline', 'reviewer').includes('评审') && roleBlock('2F', 'Cline', 'reviewer').includes('不能修改任何文件'));

/* ------------------------------------------------------------ single JSON */
head('parse: single JSON (1F/4F/6F shape)');
{
  const r = parseOutput(JSON.stringify({
    type: 'result',
    result: '我的意见是……\n\n{"reviews":[]}',
    model: 'claude-opus',
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 5 },
  }));
  ok('body read', r.ok === true && r.text.startsWith('我的意见是'));
  ok('all four token fields normalized',
    r.tokens && r.tokens.input === 120 && r.tokens.output === 30 && r.tokens.cacheRead === 900 && r.tokens.cacheWrite === 5,
    JSON.stringify(r.tokens));
  ok('model read', r.model === 'claude-opus');
  ok('single event counted', r.events === 1);
}
{
  const r = parseOutput(JSON.stringify({ result: 'only body, no usage' }));
  ok('no usage -> tokens null (never an all-zero object)', r.ok === true && r.tokens === null);
  ok('no model -> null', r.model === null);
}
{
  // camelCase usage (Cline) and prompt/completion aliases
  const r = parseOutput(JSON.stringify({ result: 'x', usage: { prompt_tokens: 3, completion_tokens: 4, cached_tokens: 5 } }));
  ok('prompt_tokens / completion_tokens / cached_tokens aliases',
    r.tokens.input === 3 && r.tokens.output === 4 && r.tokens.cacheRead === 5, JSON.stringify(r.tokens));
}

/* ------------------------------------------------------------ transcript */
head('parse: full transcript array (1F CodeBuddy)');
{
  const transcript = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<system-reminder>memory</system-reminder>\n【议题】要不要补测试？' }],
    },
    { type: 'file-history-snapshot', messageId: 'm1', snapshot: { big: 'a large snapshot that must not become speech' } },
    { type: 'reasoning', content: [], rawContent: 'private reasoning that must not become speech' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'draft answer\n\n```json\n{"reviews":[]}\n```' }],
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'final answer\n\n```json\n{"reviews":[{"severity":"minor","issue":"x","suggestion":"y","stance":"accept"}]}\n```',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    },
  ];
  const r = parseOutput(JSON.stringify(transcript, null, 2));
  ok('the result event is the speech', r.ok === true && r.text.startsWith('final answer'), JSON.stringify(r.text).slice(0, 60));
  ok('the question is not served as the answer', !r.text.includes('要不要补测试') && !r.text.includes('system-reminder'));
  ok('snapshot / reasoning do not leak into the body', !r.text.includes('large snapshot') && !r.text.includes('private reasoning'));
  ok('the answer is not repeated', r.text.split('final answer').length === 2, String(r.text.split('final answer').length));
  ok('tokens come from the closing event', r.tokens && r.tokens.input === 100 && r.tokens.output === 20);
  ok('every transcript entry is counted', r.events === 5, String(r.events));
}
{
  const t = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
  ];
  ok('without a result event, the last assistant message is used', parseOutput(JSON.stringify(t)).text === 'answer');
  ok('a transcript with only the question cannot be parsed',
    parseOutput(JSON.stringify([t[0]])).ok === false);
}
{
  const complete = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'intermediate draft' }],
    },
    {
      type: 'result',
      result: 'recovered final answer\n\n{"reviews":[]}',
      model: 'codebuddy-model',
      usage: { input_tokens: 101, output_tokens: 23 },
    },
  ];
  const cut = `${JSON.stringify(complete, null, 2).slice(0, -2)},\n  {"type":"progress","message":"still writing`;
  const r = parseOutput(cut);
  ok('a truncated transcript recovers the last complete result event',
    r.ok === true && r.text.startsWith('recovered final answer'), JSON.stringify(r.text).slice(0, 80));
  ok('recovered result keeps usage and model', r.tokens.input === 101 && r.tokens.output === 23 && r.model === 'codebuddy-model');
  ok('only complete prefix events are counted', r.events === 3, String(r.events));
  ok('the truncated prefix is labelled', r.truncated === true);
}
{
  const complete = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer from assistant\n\n{"reviews":[]}' }],
      usage: { input_tokens: 7, output_tokens: 5 },
    },
  ];
  const cut = `${JSON.stringify(complete, null, 2).slice(0, -2)},\n  {"type":"result","result":"cut off`;
  const r = parseOutput(cut);
  ok('without a result event, a truncated transcript falls back to the last complete assistant message',
    r.ok === true && r.text.startsWith('answer from assistant'));
  ok('assistant fallback tokens survive truncation', r.tokens.input === 7 && r.tokens.output === 5);
  ok('the fallback is marked truncated with two complete events', r.truncated === true && r.events === 2);
}

/* ------------------------------------------------------------ JSONL */
head('parse: JSONL event streams');
{
  const lines = [
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }),
    JSON.stringify({ type: 'text', text: 'first' }),
    JSON.stringify({ type: 'text', text: 'second' }),
    JSON.stringify({ type: 'step_finish', usage: { input_tokens: 10, output_tokens: 2 } }),
  ].join('\n');
  const r = parseOutput(lines);
  ok('user echoes are skipped', r.ok === true && r.text === 'first\nsecond', JSON.stringify(r.text));
  ok('tokens come from the closing event', r.tokens.input === 10 && r.tokens.output === 2);
  ok('all events counted', r.events === 4, String(r.events));
}
{
  // Real opencode shape captured on 2026-10-01: the body lives in `part.text`, not at the top level.
  const real = [
    '{"type":"step_start","timestamp":1790868016288,"sessionID":"ses_f07f2c05","part":{"id":"prt_0f80","sessionID":"ses_f07f2c05","messageID":"msg_0f80","type":"step-start","snapshot":"6227b344"}}',
    '{"type":"text","timestamp":1790868034373,"sessionID":"ses_f07f2c05","part":{"id":"prt_0f80d731","sessionID":"ses_f07f2c05","messageID":"msg_0f80","type":"text","text":"作为 8F 的代表，我的评审意见如下。","modelID":"claude-sonnet"},"time":{"start":1,"end":2}}',
  ].join('\n');
  const r = parseOutput(real);
  ok('opencode real shape: body comes from part.text', r.ok === true && r.text.startsWith('作为 8F 的代表'));
  ok('opencode real shape: status events contribute nothing', r.events === 2 && !r.text.includes('6227b344'));
  ok('opencode modelID alias is read', r.model === 'claude-sonnet', String(r.model));
}
{
  const mixed = ['this line is not JSON', JSON.stringify({ text: 'body after a bad line' }), 'another log line'].join('\n');
  ok('non-JSON log lines do not destroy the stream', parseOutput(mixed).text === 'body after a bad line');
}
{
  const stream = [
    JSON.stringify({ text: 'a', usage: { input_tokens: 1, output_tokens: 1 } }),
    JSON.stringify({ text: 'b', usage: { input_tokens: 99, output_tokens: 9 } }),
  ].join('\n');
  ok('usage takes the last occurrence instead of summing retries', parseOutput(stream).tokens.input === 99);
}

/* ------------------------------------------------------------ Codex / Cline */
head('parse: Codex and Cline real shapes');
{
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'private reasoning' } }),
    JSON.stringify({ type: 'error', message: 'Reconnecting... (plan type is required)' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'error', message: 'ignoring 2 unrecognized settings' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'my review\n\n{"reviews":[]}' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } }),
  ].join('\n');
  const r = parseOutput(lines);
  ok('codex: only agent_message is speech', r.ok === true && r.text.startsWith('my review'));
  ok('codex: reasoning and error events never become speech',
    !r.text.includes('private reasoning') && !r.text.includes('Reconnecting') && !r.text.includes('unrecognized'));
  ok('codex: cached_input_tokens alias normalized',
    r.tokens.input === 100 && r.tokens.output === 20 && r.tokens.cacheRead === 40, JSON.stringify(r.tokens));
}
{
  const body = '看完了。\n\n{"reviews":[]}';
  const lines = [
    JSON.stringify({ ts: '1', type: 'agent_event', event: { type: 'content_start', contentType: 'reasoning', reasoning: 'let me read files' } }),
    JSON.stringify({ ts: '2', type: 'agent_event', event: { type: 'content_end', contentType: 'text', text: body } }),
    JSON.stringify({ ts: '3', type: 'run_result', finishReason: 'completed', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 }, text: body }),
  ].join('\n');
  const r = parseOutput(lines);
  ok('cline: body comes from run_result', r.ok === true && r.text === body);
  ok('cline: the body appears once (reasoning is not text)', r.text.split('看完了').length === 2);
  ok('cline: camelCase usage normalized', r.tokens.input === 20 && r.tokens.output === 5 && r.tokens.cacheRead === 3);
}

/* ------------------------------------------------------------ unparseable */
head('cannot parse means cannot parse');
ok('empty stdout -> ok=false', parseOutput('').ok === false);
ok('null / undefined do not throw', parseOutput(null).ok === false && parseOutput(undefined).ok === false);
ok('plain log text -> ok=false', parseOutput('Segmentation fault').ok === false);
ok('only status events, no body -> ok=false', parseOutput(JSON.stringify({ type: 'step_start' })).ok === false);
{
  const r = parseOutput('{broken json');
  ok('broken JSON -> ok=false with empty text', r.ok === false && r.text === '');
}
{
  const r = parseOutput(JSON.stringify({ type: 'error', message: 'auth failed' }));
  ok('a top-level error event is not speech', r.ok === false && r.text === '');
}

console.log(`\n${fail ? '✗' : '✓'} council-agents: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
