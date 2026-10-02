/**
 * 议事厅「四层配方」自检 —— 纯函数，不起进程。
 *
 * 盯三件事，每件都对应一条会真出事的后果：
 *   1. **参数里必须真的关掉了工具**。四层里有两层（7F/8F）没有关工具的开关，只能靠注入
 *      一份 permission 全 deny 的配置。这条要是回归了，议事厅就不再是"只读"，
 *      参与者能读工作区文件、能跑命令 —— 这是整个功能的前提，不是可选行为。
 *   2. **7F 必须摘掉 WorkGremlin 自己的上报插件**（kilo 全局配置里挂着它）。不摘的话
 *      议事厅的参与者会被上报进办公室，违反"隔离，只在议事厅看"。
 *   3. **解析不出来就说解析不出来**。输出格式变了要落到 ok=false / vote=null，
 *      绝不能猜一个立场出来。这里用几种真实的输出形态和几种残缺输出来钉。
 *
 * 跑法：`npm run test:council-agents`
 */
'use strict';

const {
  RECIPES,
  parseOutput,
  parseVoteBlock,
  normalizeVoteToken,
  parseAnalysisBlock,
  normalizeStanceToken,
  READ_TOOLS,
  QUIET_ENV,
} = require('../src/council/agents');
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

// ------------------------------------------------------------ 四层都在
head('配方齐全');
for (const f of ['1F', '4F', '7F', '8F']) {
  ok(`${f} 有配方`, Boolean(RECIPES[f] && RECIPES[f].build));
}

// -------------------------------------------------- 只读保证：这是功能的前提
head('只读保证：关工具的参数必须在');
{
  const c1 = RECIPES['1F'].build({ bin: '/usr/bin/codebuddy', prompt: '问题' });
  const c4 = RECIPES['4F'].build({ bin: '/usr/bin/claude', prompt: '问题' });
  for (const [name, inv] of [['1F CodeBuddy', c1], ['4F Claude', c4]]) {
    const i = inv.args.indexOf('--tools');
    ok(`${name} 带 --tools 且值为空串（关掉全部内置工具）`, i >= 0 && inv.args[i + 1] === '', JSON.stringify(inv.args));
  }
  // 空串这个值很容易被"顺手清理"掉（看起来像没填），所以专门钉一次
  ok('1F 的 --tools 后面跟的确实是空字符串而不是被吞掉', c1.args[c1.args.indexOf('--tools') + 1] === '');
  ok('4F 同理', c4.args[c4.args.indexOf('--tools') + 1] === '');
}
{
  const c7 = RECIPES['7F'].build({ bin: '/usr/bin/kilo', prompt: '问题' });
  const cfg = JSON.parse(c7.env.KILO_CONFIG_CONTENT);
  ok('7F 注入了 KILO_CONFIG_CONTENT', Boolean(c7.env.KILO_CONFIG_CONTENT));
  ok('7F 权限全 deny', cfg.permission['*'] === 'deny');
  ok('7F 逐项也 deny（bash / edit / write / read）',
    cfg.permission.bash === 'deny' && cfg.permission.edit === 'deny' &&
    cfg.permission.write === 'deny' && cfg.permission.read === 'deny');
  ok('7F 连 webfetch / task / skill 都 deny',
    cfg.permission.webfetch === 'deny' && cfg.permission.task === 'deny' && cfg.permission.skill === 'deny');

  // 这条是隔离的命门：kilo 全局配置里挂着 WorkGremlin 的上报插件
  ok('7F 摘掉了插件列表（否则参与者会被上报进办公室）',
    Array.isArray(cfg.plugin) && cfg.plugin.length === 0, JSON.stringify(cfg.plugin));
}
{
  const c8 = RECIPES['8F'].build({ bin: '/usr/bin/opencode', prompt: '问题' });
  const cfg = JSON.parse(c8.env.OPENCODE_CONFIG_CONTENT);
  ok('8F 注入了 OPENCODE_CONFIG_CONTENT', Boolean(c8.env.OPENCODE_CONFIG_CONTENT));
  ok('8F 权限全 deny', cfg.permission['*'] === 'deny' && cfg.permission.bash === 'deny' && cfg.permission.read === 'deny');
  ok('8F 也挡了 external_directory', cfg.permission.external_directory === 'deny');
}
{
  // 环境变量是**叠加**不是替换：登录凭据靠 HOME 找，挡掉 HOME 等于挡掉登录
  for (const f of ['1F', '4F', '7F', '8F']) {
    const env = RECIPES[f].build({ bin: '/x', prompt: 'p' }).env;
    ok(`${f} 的 env 里没有 HOME（不能挡住登录凭据）`, !('HOME' in env));
  }
}

// ---------------------------------------------------------------- 调用形态
head('调用形态：长文本优先走管道，不进 argv');
{
  const c1 = RECIPES['1F'].build({ bin: '/usr/bin/codebuddy', prompt: '很长的提示词' });
  ok('1F 提示词走 stdin', c1.stdin === '很长的提示词' && !c1.args.includes('很长的提示词'));
  ok('1F 带 -p 和 json 输出', c1.args.includes('-p') && c1.args.includes('json'));
  const c4 = RECIPES['4F'].build({ bin: '/usr/bin/claude', prompt: '很长的提示词' });
  ok('4F 提示词走 stdin', c4.stdin === '很长的提示词' && !c4.args.includes('很长的提示词'));
  const c7 = RECIPES['7F'].build({ bin: '/usr/bin/kilo', prompt: '提示词' });
  ok('7F 走位置参数（这家不读 stdin）', c7.args[0] === 'run' && c7.args[1] === '提示词' && c7.stdin === null);
  ok('7F 要 json 输出', c7.args.includes('--format') && c7.args.includes('json'));
  const c8 = RECIPES['8F'].build({ bin: '/usr/bin/opencode', prompt: '提示词' });
  ok('8F 走位置参数', c8.args[0] === 'run' && c8.args[1] === '提示词' && c8.stdin === null);
}

// ---------------------------------------------------------------- 输出解析
head('输出解析：单个 JSON（1F/4F 的形态）');
{
  const r = parseOutput(JSON.stringify({ type: 'result', result: '我觉得应该这样做。', usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 5 } }));
  ok('读到正文', r.ok === true && r.text === '我觉得应该这样做。', r.text);
  ok('词元四项都归出来了', r.tokens && r.tokens.input === 120 && r.tokens.output === 30 && r.tokens.cacheRead === 900 && r.tokens.cacheWrite === 5, JSON.stringify(r.tokens));
}
{
  const r = parseOutput(JSON.stringify({ result: '只给正文，没有 usage' }));
  ok('没有 usage 时 tokens=null（不编一个全 0 出来）', r.ok === true && r.tokens === null, JSON.stringify(r.tokens));
}

head('输出解析：JSONL 事件流（7F/8F 的形态）');
{
  // 真机踩到的坑：1F CodeBuddy `--output-format json` 给的是**一整个数组** ——
  // 一份完整对话记录（user → snapshot → reasoning → assistant → result），不是单个对象。
  // 按"把每条的 content 拼起来"解析，结果是**提问原文被当成它的发言**（连 CLI 自己塞的
  // memory 系统提示一起，16KB），末尾答复再重复一遍。这里用真形状钉住：
  // 只能取 result 事件里那段，用户消息与 assistant 消息都不许漏进来。
  const transcript = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<system-reminder data-role="memory">你是……</system-reminder>\n【议题】要不要补测试？' }],
    },
    { type: 'file-history-snapshot', messageId: 'm1', snapshot: { big: '这里有一大坨快照，不该进正文' } },
    { type: 'reasoning', content: [], rawContent: '心里想了想，这段也不是发言' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '我先说说看法。\n\n```json\n{"vote":"abstain","reason":"还没想好"}\n```' }],
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '作为 1F 的代表，我弃权。\n\n```json\n{"vote":"abstain","reason":"信息不足"}\n```',
      duration_ms: 1234,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    },
  ];
  const r = parseOutput(JSON.stringify(transcript, null, 2));
  ok('对话记录数组：取的是 result 那段', r.ok === true && r.text.startsWith('作为 1F 的代表'), JSON.stringify(r.text).slice(0, 60));
  ok('对话记录数组：**提问原文没被当成它的发言**', !r.text.includes('system-reminder') && !r.text.includes('要不要补测试'), r.text.slice(0, 60));
  ok('对话记录数组：快照 / reasoning 没混进来', !r.text.includes('一大坨快照') && !r.text.includes('心里想了想'));
  ok('对话记录数组：答复只出现一次（不重复拼接）', r.text.split('我弃权').length === 2, String(r.text.split('我弃权').length));
  ok('对话记录数组：词元从收尾事件里读到了', r.tokens && r.tokens.input === 100 && r.tokens.output === 20 && r.tokens.cacheRead === 5, JSON.stringify(r.tokens));
  ok('对话记录数组：事件数如实记着', r.events === 5, String(r.events));
  const v = parseVoteBlock(r.text);
  ok('对话记录数组：投票解析到的是最后那块（弃权 + 信息不足）', v.vote === 'abstain' && v.reason === '信息不足', JSON.stringify(v));
}
{
  // 只有一问一答、没有 result 事件的记录：退回最后一条 assistant 消息
  const t = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '提问原文' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我的回答' }] },
  ];
  const r = parseOutput(JSON.stringify(t));
  ok('没有 result 事件时退回最后一条 assistant 消息', r.ok === true && r.text === '我的回答', JSON.stringify(r.text));
}
{
  // 光有用户消息、没有任何答复 → 解析不出（不许把提问端出来当发言）
  const t = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '提问原文' }] }];
  ok('记录里只有提问 → ok=false（不拿提问充数）', parseOutput(JSON.stringify(t)).ok === false);
}
{
  // 事件流里混着用户消息同样要跳过
  const lines = [
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '提问原文' }] }),
    JSON.stringify({ type: 'text', text: '我的回答' }),
  ].join('\n');
  const r = parseOutput(lines);
  ok('事件流里的用户消息被跳过', r.ok === true && r.text === '我的回答', JSON.stringify(r.text));
}
{
  // **真机抓下来的原样两行**（2026-10-01，opencode run --format json）。
  // 上面那条 `{type:'text', text:...}` 是照猜测写的，猜错了：正文在 part 里。
  // 这条用真形状，别再改回猜的。
  const real = [
    '{"type":"step_start","timestamp":1790868016288,"sessionID":"ses_f07f2c05","part":{"id":"prt_0f80","sessionID":"ses_f07f2c05","messageID":"msg_0f80","type":"step-start","snapshot":"6227b344"}}',
    '{"type":"text","timestamp":1790868034373,"sessionID":"ses_f07f2c05","part":{"id":"prt_0f80d731","sessionID":"ses_f07f2c05","messageID":"msg_0f80","type":"text","text":"作为 8F 的代表，我**不同意**。\\n\\n```json\\n{\\"vote\\":\\"disagree\\",\\"reason\\":\\"成本远超收益\\",\\"proposal\\":\\"加 DRY_RUN 先跑一遍\\"}\\n```"},"time":{"start":1,"end":2}}',
  ].join('\n');
  const r = parseOutput(real);
  ok('opencode 真形状：正文从 part.text 里取到', r.ok === true && r.text.startsWith('作为 8F 的代表'), JSON.stringify(r.text).slice(0, 80));
  ok('opencode 真形状：状态事件（step_start）不贡献正文', r.events === 2 && !r.text.includes('6227b344'));
  const v = parseVoteBlock(r.text);
  ok('opencode 真形状：投票尾块解析得出来', v.vote === 'disagree' && v.proposal === '加 DRY_RUN 先跑一遍', JSON.stringify(v));
}
{
  const lines = [
    JSON.stringify({ type: 'step_start', sessionID: 's1' }),
    JSON.stringify({ type: 'text', text: '第一段。' }),
    JSON.stringify({ type: 'text', text: '第二段。' }),
    JSON.stringify({ type: 'step_finish', usage: { input_tokens: 10, output_tokens: 2 } }),
  ].join('\n');
  const r = parseOutput(lines);
  ok('多行正文按顺序拼起来', r.ok === true && r.text === '第一段。\n第二段。', JSON.stringify(r.text));
  ok('词元从收尾那条事件里取到', r.tokens && r.tokens.input === 10 && r.tokens.output === 2, JSON.stringify(r.tokens));
  ok('认得出这是事件流', r.events === 4, String(r.events));
}
{
  // CLI 常往 stdout 混日志行，坏行不该毁掉整条流
  const mixed = ['这不是 JSON 的一行日志', JSON.stringify({ text: '正文在坏行后面' }), '还有一行日志'].join('\n');
  const r = parseOutput(mixed);
  ok('夹着非 JSON 日志行也照样解析出正文', r.ok === true && r.text === '正文在坏行后面', JSON.stringify(r));
}
{
  // usage 挂多条时取最后一条（累加会在重试时重复计费）
  const stream = [
    JSON.stringify({ text: 'a', usage: { input_tokens: 1, output_tokens: 1 } }),
    JSON.stringify({ text: 'b', usage: { input_tokens: 99, output_tokens: 9 } }),
  ].join('\n');
  const r = parseOutput(stream);
  ok('usage 取最后一条而不是累加', r.tokens.input === 99, JSON.stringify(r.tokens));
}

head('输出解析：读不出就是读不出（绝不猜）');
ok('空 stdout → ok=false', parseOutput('').ok === false);
ok('null / undefined 不炸', parseOutput(null).ok === false && parseOutput(undefined).ok === false);
ok('纯日志文本 → ok=false（不算读到正文）', parseOutput('Segmentation fault').ok === false);
ok('事件流里只有状态事件、没有正文 → ok=false', parseOutput(JSON.stringify({ type: 'step_start' })).ok === false);
{
  const r = parseOutput('{坏掉的 json');
  ok('坏 JSON → ok=false 且不抛错', r.ok === false && r.text === '');
}

// ---------------------------------------------------------------- 投票解析
head('投票解析：约定的结构化尾块');
{
  const r = parseVoteBlock('我的分析是成本可控、能按期交付。\n\n```json\n{"vote":"agree","reason":"成本可控"}\n```');
  ok('同意票 + 理由', r.vote === 'agree' && r.reason === '成本可控', JSON.stringify(r));
}
{
  const r = parseVoteBlock('这条路线我不同意，风险太大。\n\n```json\n{"vote":"disagree","reason":"风险太大","proposal":"改成先做小范围灰度"}\n```');
  ok('反对票带上修订案', r.vote === 'disagree' && r.proposal === '改成先做小范围灰度', JSON.stringify(r));
}
{
  const r = parseVoteBlock('```json\n{"vote":"abstain","reason":"我不懂这块","second":"4F"}\n```');
  ok('弃权 + 附议别人', r.vote === 'abstain' && r.second === '4F', JSON.stringify(r));
}
{
  // 模型爱在中间举例，最后一块才是结论 —— 必须取最后一个
  const text = '比如可以这样写：\n```json\n{"vote":"agree","reason":"示例"}\n```\n但我的结论是：\n```json\n{"vote":"disagree","reason":"真实结论"}\n```';
  const r = parseVoteBlock(text);
  ok('取**最后一个**围栏块（中间的例子不算）', r.vote === 'disagree' && r.reason === '真实结论', JSON.stringify(r));
}
{
  const r = parseVoteBlock('没有围栏，直接给了对象 {"vote":"agree","reason":"就这样"} 收尾。');
  ok('没有围栏时也能从正文里认出来', r.vote === 'agree' && r.reason === '就这样', JSON.stringify(r));
}
{
  const r = parseVoteBlock('我的看法如下。\n\nVOTE: 反对');
  ok('兜底认「VOTE: 反对」这种一行', r.vote === 'disagree', JSON.stringify(r));
  const r2 = parseVoteBlock('立场：弃权');
  ok('也认「立场：弃权」', r2.vote === 'abstain', JSON.stringify(r2));
}
{
  // 正文里带花括号（代码片段）不能把括号配对搞崩
  const r = parseVoteBlock('伪代码是 if (x) { y(); } 这样。\n```json\n{"vote":"agree","reason":"没问题"}\n```');
  ok('正文里的花括号不影响解析', r.vote === 'agree', JSON.stringify(r));
}

head('投票解析：认不出来就是"未表态"，不是默认同意');
ok('空文本 → vote=null', parseVoteBlock('').vote === null);
ok('null / undefined 不炸', parseVoteBlock(null).vote === null && parseVoteBlock(undefined).vote === null);
{
  const r = parseVoteBlock('我觉得这个方案还行吧，大家看着办。');
  ok('只有模糊表态、没有结构化块 → vote=null', r.vote === null, JSON.stringify(r));
}
{
  const r = parseVoteBlock('```json\n{"vote":"maybe","reason":"看情况"}\n```');
  ok('票型是没见过的词 → vote=null（不硬塞成同意）', r.vote === null, JSON.stringify(r));
}
{
  const r = parseVoteBlock('```json\n{"reason":"忘了写 vote"}\n```');
  ok('缺 vote 字段 → vote=null', r.vote === null);
}
{
  const r = parseVoteBlock('```json\n{"vote":"agree"}\n```');
  ok('没有理由也认（理由是补充信息，不是投票的前提）', r.vote === 'agree' && r.reason === null);
}

head('票型词表与 consensus.js 保持一套');
ok('agree / 同意 / AGREE 都归成 agree', normalizeVoteToken('agree') === 'agree' && normalizeVoteToken('同意') === 'agree' && normalizeVoteToken('AGREE') === 'agree');
ok('disagree / 反对 归成 disagree', normalizeVoteToken('反对') === 'disagree' && normalizeVoteToken('no') === 'disagree');
ok('abstain / 弃权 归成 abstain', normalizeVoteToken('弃权') === 'abstain');
ok('认不出返回 null', normalizeVoteToken('随便') === null && normalizeVoteToken(null) === null);

// ==================================================== 工程模式：只读，不是"能读能写"
// 这一组与上面那组是**同一件事的两档**：allow='none' 是"什么都没有"，allow='read' 是
// "只有读类工具"。第二种情况更容易出事 —— 多放行一个 write/edit/bash，参与者就能改用户的
// 代码、在用户机器上跑命令。所以这里逐项断言放行了什么、没放行什么，而不是只看它"有没有工具"。
head('只读保证（工程模式）：放行的只有读类工具，写类一律 deny');
{
  const i1 = RECIPES['1F'].build({ bin: '/usr/bin/codebuddy', prompt: '问题', allow: 'read' });
  const a1 = i1.args;
  ok('1F 的 --tools 不再是空串（隔离模式是空串，工程模式是白名单）', a1[a1.indexOf('--tools') + 1] !== '');
  ok(`1F 的 --tools 就是那份白名单（${READ_TOOLS}）`, a1[a1.indexOf('--tools') + 1] === READ_TOOLS, JSON.stringify(a1));
  // -p 是非交互的：只给 --tools 不给 --allowedTools，读文件时没人应答权限询问会被直接拒，
  // 参与者就变成"干瞪眼"。这一条钉的是"它是只读，不是读不了"。
  ok('1F 同时给了 --allowedTools 同一份（否则读文件会被权限询问拦下）',
    a1[a1.indexOf('--allowedTools') + 1] === READ_TOOLS, JSON.stringify(a1));

  const a4 = RECIPES['4F'].build({ bin: '/usr/bin/claude', prompt: '问题', allow: 'read' }).args;
  ok('4F 的 --tools 也是那份白名单', a4[a4.indexOf('--tools') + 1] === READ_TOOLS, JSON.stringify(a4));
  ok('4F 同样给了 --allowedTools', a4[a4.indexOf('--allowedTools') + 1] === READ_TOOLS, JSON.stringify(a4));
  // --allowedTools 收的是变长参数，排在它后面的开关会被吃掉 → --permission-prompts 必须在前面
  ok('4F 的 --permission-prompts none 排在 --allowedTools 前面（否则会被变长参数吃掉）',
    a4.indexOf('--permission-prompts') < a4.indexOf('--allowedTools'), JSON.stringify(a4));
  ok('4F 明说"没人应答就拒"（不是挂在那儿等）', a4[a4.indexOf('--permission-prompts') + 1] === 'none');
}
{
  const cfg = JSON.parse(RECIPES['7F'].build({ bin: '/usr/bin/kilo', prompt: 'p', allow: 'read' }).env.KILO_CONFIG_CONTENT);
  ok('7F 放行 read / glob / grep / list',
    cfg.permission.read === 'allow' && cfg.permission.glob === 'allow' &&
    cfg.permission.grep === 'allow' && cfg.permission.list === 'allow', JSON.stringify(cfg.permission));
  ok('7F 的兜底仍然是 deny（没在表里的工具一个都别想用）', cfg.permission['*'] === 'deny');
  ok('7F 的写类照旧全 deny（bash / edit / write）',
    cfg.permission.bash === 'deny' && cfg.permission.edit === 'deny' && cfg.permission.write === 'deny');
  ok('7F 仍然摘掉上报插件（工程模式同样不许上报）', Array.isArray(cfg.plugin) && cfg.plugin.length === 0);
}
{
  const cfg = JSON.parse(RECIPES['8F'].build({ bin: '/usr/bin/opencode', prompt: 'p', allow: 'read' }).env.OPENCODE_CONFIG_CONTENT);
  ok('8F 放行 read / glob / grep / list',
    cfg.permission.read === 'allow' && cfg.permission.glob === 'allow' &&
    cfg.permission.grep === 'allow' && cfg.permission.list === 'allow', JSON.stringify(cfg.permission));
  ok('8F 的写类照旧全 deny（bash / edit / write）',
    cfg.permission.bash === 'deny' && cfg.permission.edit === 'deny' && cfg.permission.write === 'deny');
  // 命门：工程模式只许看工程里。这条松了，参与者能顺着 ~ 读到用户所有的东西
  ok('8F 仍然挡住 external_directory（只许看工程里，不许看 ~）', cfg.permission.external_directory === 'deny');
  ok('8F 也仍然挡 webfetch / task / skill',
    cfg.permission.webfetch === 'deny' && cfg.permission.task === 'deny' && cfg.permission.skill === 'deny');
}
{
  // 隔离模式（allow 缺省 / 'none'）必须与改动前逐字相同 —— 这条是回归对照
  for (const f of ['1F', '4F', '7F', '8F']) {
    const withDefault = RECIPES[f].build({ bin: '/x', prompt: 'p' });
    const withNone = RECIPES[f].build({ bin: '/x', prompt: 'p', allow: 'none' });
    ok(`${f} 不传 allow 与传 'none' 逐字相同`, JSON.stringify(withDefault) === JSON.stringify(withNone));
  }
  ok('不传 allow 时 1F/4F 依然是空串 --tools',
    RECIPES['1F'].build({ bin: '/x', prompt: 'p' }).args[RECIPES['1F'].build({ bin: '/x', prompt: 'p' }).args.indexOf('--tools') + 1] === '');
}

// ================================================== 不上报：工程模式隔离的命门
// cwd 是用户的真实工程时，装了 WorkGremlin 上报 hook/插件的机器会把参与者**按真实工程
// 路径**上报 —— 参与者就变成"你工程里的一个成员"。cwd 挡不住这件事，只有显式关掉上报。
head('所有配方都关掉了 WorkGremlin 自己的上报');
for (const f of ['1F', '4F', '7F', '8F']) {
  for (const allow of ['none', 'read']) {
    const env = RECIPES[f].build({ bin: '/x', prompt: 'p', allow }).env;
    ok(`${f}（allow=${allow}）注入了 WORKGREMLIN_DISABLE=1`, env.WORKGREMLIN_DISABLE === '1', JSON.stringify(env));
  }
}
ok('QUIET_ENV 只有这一条（别顺手塞别的东西进去）', Object.keys(QUIET_ENV).length === 1 && QUIET_ENV.WORKGREMLIN_DISABLE === '1');

// ============================================== 7F/8F 的会话标记（第二道隔离）
// 这两家没有 1F/4F 那种 `--no-session-persistence`，会话一定落进它们**全局**的 SQLite，
// 而 session.directory 记的是当时的 cwd。工程模式下 cwd 就是用户的工程 —— 不标记的话，
// 参与者会当场出现在办公室的 7F/8F 上（办公室按工程过滤，它正好落在那个工程里）。
// 挡法是固定标题 + server/src/kilo.js / opencode.js 列出会话时跳过它。
// 这里只钉"发出去的确实是那个标题"；"跳过了"由 kiloFloor / opencodeFloor 那两个用例钉。
head('7F/8F 发送固定的会话标题（办公室据此把参与者挡在外面）');
for (const f of ['7F', '8F']) {
  for (const allow of ['none', 'read']) {
    const args = RECIPES[f].build({ bin: '/x', prompt: 'p', allow }).args;
    const at = args.indexOf('--title');
    ok(`${f}（allow=${allow}）带了 --title`, at >= 0, JSON.stringify(args));
    ok(`${f}（allow=${allow}）标题就是 DEFAULTS.COUNCIL_SESSION_TITLE`,
      args[at + 1] === DEFAULTS.COUNCIL_SESSION_TITLE, JSON.stringify(args));
  }
  // 只给这两家加：1F/4F 靠 --no-session-persistence 根本不产生记录，标题对它们是多余的
  ok(`${f} 的标题在参数里只出现一次`, RECIPES[f].build({ bin: '/x', prompt: 'p' }).args.filter((a) => a === '--title').length === 1);
}
for (const f of ['1F', '4F']) {
  ok(`${f} 不带 --title（它靠 --no-session-persistence，压根不落盘）`,
    !RECIPES[f].build({ bin: '/x', prompt: 'p' }).args.includes('--title'), JSON.stringify(RECIPES[f].build({ bin: '/x', prompt: 'p' }).args));
}
ok('标记里带 WorkGremlin（用户在 Kilo / OpenCode 自己的会话历史里认得出这是谁留下的）',
  DEFAULTS.COUNCIL_SESSION_TITLE.includes('WorkGremlin'), DEFAULTS.COUNCIL_SESSION_TITLE);

// ============================================================ 分析解析
head('分析解析：约定的结构化尾块');
{
  const r = parseAnalysisBlock('我的分析……\n\n```json\n' +
    JSON.stringify({ stance: 'support', points: ['A', 'B'], risks: ['C'], questions: ['D'] }) + '\n```\n');
  ok('stance 解析出来', r.stance === 'support', JSON.stringify(r));
  ok('三条要点都在', r.findings.points.length === 2 && r.findings.risks[0] === 'C' && r.findings.questions[0] === 'D', JSON.stringify(r.findings));
}
{
  const r = parseAnalysisBlock('```json\n{"stance":"oppose","points":[],"risks":[],"questions":[]}\n```');
  ok('空数组是合法的（"答了，答的是没有"）', r.stance === 'oppose' && Array.isArray(r.findings.points) && r.findings.points.length === 0);
  ok('findings 不是 null —— 与"整个尾块没解析出来"是两回事', r.findings !== null);
}
{
  const r = parseAnalysisBlock('```json\n{"stance":"unsure"}\n```');
  ok('只给了 stance、一条要点都没有 → findings=null（"没说" ≠ "说没有"）', r.stance === 'unsure' && r.findings === null, JSON.stringify(r));
}
{
  const r = parseAnalysisBlock('```json\n{"points":["有结论没立场"]}\n```');
  ok('有要点但没给 stance → stance=null（立场这东西不许替它定）', r.stance === null);
  ok('要点照收（它说了的话不因为缺立场就丢掉）', r.findings && r.findings.points[0] === '有结论没立场');
}
{
  // 注意"看情况""maybe"这类**模糊词**是归到 unsure 的 —— unsure 本来就是"没拿定主意"
  // 那一档，收下它不算替它表态（与表决里 neutral → abstain 同一个路子）。
  // 真正认不出的词（下面这个）才必须是 null。
  const r = parseAnalysisBlock('```json\n{"stance":"banana","points":["x"]}\n```');
  ok('立场是个没见过的词 → null，不硬塞成 support', r.stance === null, JSON.stringify(r));
  ok('模糊词归到 unsure（它就是"没拿定主意"那一档）', parseAnalysisBlock('```json\n{"stance":"maybe"}\n```').stance === 'unsure');
}
{
  ok('整个没有 JSON 块 → 两样都是 null', JSON.stringify(parseAnalysisBlock('就说了一段话，没给尾块')) === JSON.stringify({ stance: null, findings: null }));
  ok('空文本 → 全 null', parseAnalysisBlock('').stance === null && parseAnalysisBlock(null).stance === null);
}
{
  // 模型爱在中间举例：取**最后**一个块才是它的结论（与表决解析同一条规矩）
  const r = parseAnalysisBlock('例如可以这样写：\n```json\n{"stance":"oppose"}\n```\n而我最后判断是：\n```json\n{"stance":"support","points":["最后说的算"]}\n```');
  ok('中间举例的块不会被误当结论（取最后一个）', r.stance === 'support', JSON.stringify(r));
}
{
  // 元素不是字符串的（模型偶尔塞对象进来）丢掉，不当成一条要点
  const r = parseAnalysisBlock('```json\n{"stance":"support","points":["好的",{"point":"坏的"},"  "],"risks":[]}\n```');
  ok('非字符串元素与空串被丢掉，不硬转成字符串', r.findings.points.length === 1 && r.findings.points[0] === '好的', JSON.stringify(r.findings));
}

head('立场词表：认识的归一，不认识的一律 null');
ok('support / 支持 / 赞成 / 可行 归成 support',
  ['support', '支持', '赞成', '可行', 'agree'].every((s) => normalizeStanceToken(s) === 'support'));
ok('oppose / 反对 / 不可行 归成 oppose', ['oppose', '反对', 'no', 'disagree'].every((s) => normalizeStanceToken(s) === 'oppose'));
ok('unsure / 不确定 / 存疑 归成 unsure', ['unsure', '不确定', '存疑', 'maybe'].every((s) => normalizeStanceToken(s) === 'unsure'));
ok('认不出返回 null', normalizeStanceToken('随便') === null && normalizeStanceToken(null) === null && normalizeStanceToken('') === null);

console.log(`\n${fail ? '✗' : '✓'} council-agents: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
