/**
 * 4F Claude / 1F CodeBuddy / 3F Codex 的**一轮 token 真值**自检（server/src/ingest/hookCommon.js 的 readTokens）。
 *
 * 为什么单独一个文件：token 读取逻辑（读会话落盘、认口径）从原 packages/reporter/src/usage.js
 * 搬到了服务端 hookCommon，由 runHookEvent 的 Stop 分支调用，把"这一轮消耗了多少 token"
 * 算出来随 task/end 上报（落 task_runs 的四列）。它只做两件事 —— 读会话落盘、认口径 ——
 * 而**两家的口径正好相反**（Anthropic 的 input 不含缓存，OpenAI 的 prompt 含缓存命中），
 * 外加 Claude 家族同一份 usage 会在 transcript 里重复落 2~5 行。这几条错了不会报错，
 * 只会让报表上的数字虚高几倍或差一个数量级 —— 所以拿造好的 transcript 逐条锁住。
 *
 * 纪律（对齐 requirements.md §P0-6「绝不编造」）：认得出来才给数，认不出**一律 null**
 * （服务端留 NULL、报表显示 "—"），绝不写 0 或拿别的数顶上。
 *
 * 跑法：`npm run test:tokens`（零依赖：造 JSONL → 直接 require 那个模块）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTokens, readTokensSettled } = require('../src/ingest/hookCommon');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-tokens-'));

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  — ${detail}`}`);
  }
}
function head(s) {
  console.log(`\n${s}`);
}
/** 造一份 transcript（每行一个 JSON 对象），返回路径 */
function writeJsonl(name, rows) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
/** 只比这四项（顺序无关，别的字段一概不看） */
function sameTokens(got, want) {
  if (!got) return false;
  return (
    got.input === want.input &&
    got.output === want.output &&
    got.cacheRead === want.cacheRead &&
    got.cacheWrite === want.cacheWrite
  );
}

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const before = T0 - 60_000;
const after = T0 + 1_000;

/* ------------------------------ 4F Claude ------------------------------ */

head('[1] 4F Claude：Anthropic 口径（input 不含缓存）；同一 message.id 的多行是同一笔');
{
  // Claude 的 transcript：一次 API 请求按 content block 落 2~5 行，共享同一个 message.id。
  // 实测 1049 行只对应 403 个请求 —— 不去重就是成倍虚高。
  const file = writeJsonl('claude.jsonl', [
    // 上一轮的请求：早于本轮起点，不许算进来
    {
      type: 'assistant',
      timestamp: new Date(before).toISOString(),
      message: {
        id: 'msg_OLD',
        usage: { input_tokens: 9_999, output_tokens: 9_999, cache_read_input_tokens: 9_999, cache_creation_input_tokens: 9_999 },
      },
    },
    // 本轮第 1 次请求，落了 3 行（同一 message.id）
    ...[0, 1, 2].map((i) => ({
      type: 'assistant',
      timestamp: new Date(after + i * 10).toISOString(),
      message: {
        id: 'msg_A',
        usage: { input_tokens: 161, output_tokens: 120, cache_read_input_tokens: 46_336, cache_creation_input_tokens: 0 },
      },
    })),
    // 本轮第 2 次请求：写入缓存这次不是 0
    {
      type: 'assistant',
      timestamp: new Date(after + 500).toISOString(),
      message: {
        id: 'msg_B',
        usage: { input_tokens: 224, output_tokens: 320, cache_read_input_tokens: 47_232, cache_creation_input_tokens: 1_024 },
      },
    },
    // 用户那行没有 usage：跳过，不许当成"零消耗的一次请求"
    { type: 'user', timestamp: new Date(after + 600).toISOString(), message: { role: 'user', content: '嗯' } },
  ]);

  const t = readTokens(file, T0);
  ok(
    '同一 message.id 的三行只算一次（161 而不是 483）',
    t && t.input === 161 + 224,
    JSON.stringify(t)
  );
  ok(
    '四项求和：input 385 / output 440 / cacheRead 93,568 / cacheWrite 1,024',
    sameTokens(t, { input: 385, output: 440, cacheRead: 93_568, cacheWrite: 1_024 }),
    JSON.stringify(t)
  );
  // input 不含缓存：一次请求 input 161 而 cacheRead 46,336 —— 若 input 含缓存则不可能出现
  ok('cacheRead 是独立的 46,336+47,232（没被并进 input）', t && t.cacheRead === 93_568, t && String(t.cacheRead));
}

/* ------------------------------ 1F CodeBuddy ------------------------------ */

head('[2] 1F CodeBuddy：OpenAI 口径（prompt_tokens 含缓存命中）→ 落库前减掉');
{
  // 实测：一行里 `providerData.rawUsage`（完整）与 `message.usage`（简化副本）成对出现。
  // 两份都算 = 同一笔消耗记两次 —— 取 rawUsage 那份。
  const file = writeJsonl('codebuddy.jsonl', [
    {
      type: 'assistant',
      timestamp: before,
      id: 'call_OLD',
      providerData: { rawUsage: { prompt_tokens: 9_999, completion_tokens: 9_999, prompt_cache_hit_tokens: 9_999 } },
    },
    {
      type: 'assistant',
      timestamp: after,
      id: 'call_1',
      providerData: {
        rawUsage: {
          prompt_tokens: 1_000,
          completion_tokens: 30,
          prompt_cache_hit_tokens: 900,
          prompt_cache_write_tokens: 0,
        },
      },
      message: { usage: { input_tokens: 1_000, output_tokens: 30, total_tokens: 1_030, cache_read: 900 } },
    },
    {
      type: 'assistant',
      timestamp: after + 1_000,
      id: 'call_2',
      providerData: {
        rawUsage: {
          prompt_tokens: 500,
          completion_tokens: 10,
          prompt_cache_hit_tokens: 0,
          prompt_cache_write_tokens: 200,
        },
      },
      message: { usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510, cache_read: 0 } },
    },
  ]);

  const t = readTokens(file, T0);
  // 1000-900-0 = 100；500-0-200 = 300
  ok('prompt 里减掉缓存命中与写入（input 100+300=400）', t && t.input === 400, JSON.stringify(t));
  ok(
    '四项求和：input 400 / output 40 / cacheRead 900 / cacheWrite 200',
    sameTokens(t, { input: 400, output: 40, cacheRead: 900, cacheWrite: 200 }),
    JSON.stringify(t)
  );
  ok('rawUsage 与 message.usage 只算一份（不是 1500 那种两倍）', t && t.input === 400, t && String(t.input));
}

/* ------------------------------ 3F Codex ------------------------------ */

head('[3] 3F Codex：total_token_usage 是会话内累计 → 取本轮"收尾累计 − 起点前累计"');
{
  const tc = (input, cached, output) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
  });
  const file = writeJsonl('codex.jsonl', [
    // 本轮开始前的累计 = 基线
    { type: 'event_msg', timestamp: before, payload: { type: 'token_count', info: { total_token_usage: tc(1_000, 800, 10) } } },
    { type: 'event_msg', timestamp: after, payload: { type: 'token_count', info: { total_token_usage: tc(2_000, 1_600, 50) } } },
    { type: 'event_msg', timestamp: after + 1_000, payload: { type: 'token_count', info: { total_token_usage: tc(3_000, 2_500, 90) } } },
    // 不是 token_count 的事件：跳过
    { type: 'event_msg', timestamp: after + 1_100, payload: { type: 'agent_message', message: '好' } },
  ]);

  const t = readTokens(file, T0);
  // 3000-1000 = 2000；cached 2500-800 = 1700 → input = 2000-1700 = 300；output 90-10 = 80
  ok(
    '累计之差再减缓存命中：input 300 / output 80 / cacheRead 1,700',
    sameTokens(t, { input: 300, output: 80, cacheRead: 1_700, cacheWrite: 0 }),
    JSON.stringify(t)
  );

  // 这一轮一个 token_count 都还没落（最后一条也早于本轮起点）→ 留空，不拿全量累计冒充
  const stale = writeJsonl('codex-stale.jsonl', [
    { type: 'event_msg', timestamp: before, payload: { type: 'token_count', info: { total_token_usage: tc(1_000, 800, 10) } } },
  ]);
  ok('最后一条 token_count 早于本轮起点 → null（没数就是没数）', readTokens(stale, T0) === null, String(readTokens(stale, T0)));
}

/* ------------------------------ 取不到就留空 ------------------------------ */

head('[4] 认不出 / 读不到 → null（服务端留 NULL，报表显示 "—"，绝不写 0）');
{
  const none = writeJsonl('no-usage.jsonl', [
    { type: 'user', timestamp: after, message: { role: 'user', content: '你 6F 的 transcript 长什么样' } },
    { type: 'assistant', timestamp: after, message: { id: 'msg_X', content: [{ type: 'text', text: '没有 usage' }] } },
  ]);
  ok('落盘里一条 usage 都没有 → null（不是 0）', readTokens(none, T0) === null, JSON.stringify(readTokens(none, T0)));

  const zeros = writeJsonl('zeros.jsonl', [
    {
      type: 'assistant',
      timestamp: after,
      message: {
        id: 'msg_Z',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ]);
  ok('四项全是 0 → null（"没读到"不是"消耗为零"）', readTokens(zeros, T0) === null, JSON.stringify(readTokens(zeros, T0)));

  // CodeBuddy **插件**形态的 transcriptPath 指向 history/<会话>/index.json：缩进过的 JSON
  //（不是 JSONL），usage 在顶层 requests[] 上。见 hookCommon 的 codebuddyRequestTokens。
  const mkIndex = (name, reqs) => {
    const file = path.join(TMP, name);
    fs.writeFileSync(file, JSON.stringify({ messages: [], requests: reqs }, null, 2) + '\n');
    return file;
  };
  // 实测口径：inputTokens **含**缓存命中，inputTokens − cacheTokens − cachedWriteTokens = cachedMissTokens
  const req = (id, startedAt, usage) => ({ id, type: 'craft', state: 'complete', startedAt, usage });
  const uNow = { inputTokens: 18407, outputTokens: 163, cacheTokens: 18176, cachedWriteTokens: 0, cachedMissTokens: 231, credit: 0.18 };
  const uOld = { inputTokens: 999999, outputTokens: 999, cacheTokens: 999000, cachedWriteTokens: 0, cachedMissTokens: 999, credit: 9.99 };
  // 本轮那条 request 实测早于 hook 记的本轮起点 84~204ms —— 所以不能写成 >= startedAt
  const idxFile = mkIndex('cb-index.json', [req('r_old', T0 - 600_000, uOld), req('r_now', T0 - 107, uNow)]);
  ok(
    '插件形态 index.json：取本轮那条 request（input 是没命中缓存的 231，不是 18407）',
    sameTokens(readTokens(idxFile, T0), { input: 231, output: 163, cacheRead: 18176, cacheWrite: 0 }),
    JSON.stringify(readTokens(idxFile, T0))
  );
  ok(
    '插件形态：上一轮那条不计入（10 分钟前那条的用量没被算进来）',
    readTokens(idxFile, T0) && readTokens(idxFile, T0).output === 163,
    String(readTokens(idxFile, T0) && readTokens(idxFile, T0).output)
  );
  // 窗口 Grace 之外（本轮 usage 还没落盘，只找得到更早的那些）→ null，不能把老数据当这轮的
  ok(
    '插件形态：本轮那条还没落盘（只剩窗口外的老 request）→ null',
    readTokens(mkIndex('cb-wait.json', [req('r_old', T0 - 600_000, uOld)]), T0) === null,
    String(readTokens(mkIndex('cb-wait.json', [req('r_old', T0 - 600_000, uOld)]), T0))
  );
  ok(
    '插件形态：一条合法 request 都没有 → null',
    readTokens(mkIndex('cb-none.json', []), T0) === null,
    String(readTokens(mkIndex('cb-none.json', []), T0))
  );

  ok('文件不存在 → null', readTokens(path.join(TMP, 'nope.jsonl'), T0) === null, String(readTokens(path.join(TMP, 'nope.jsonl'), T0)));
  ok('没给 transcript 路径 → null', readTokens('', T0) === null, String(readTokens('', T0)));
  ok('不知道本轮从哪开始（startedAt=0）→ null', readTokens(none, 0) === null, String(readTokens(none, 0)));
}

/* ------------------------------ 插件形态：usage 晚落盘 ------------------------------ */

/**
 * 插件形态**这一条最关键**：扩展把本轮 request 的 startedAt / usage 补进 index.json 的时刻
 * 比 Stop **晚 31~51ms**（本机 14/14 轮实测，见 hookCommon 的 codebuddyRequestTokens）。
 * 轮次中途那份 request 只有 `{id, type, messages, state:'running'}` —— 没有 startedAt，
 * 于是 Stop 里第一次读必然扑空（窗口里一条都没有）。只读一次 = 插件形态永远 "—"。
 */
(async () => {
  head('[5] 插件形态：usage 比 Stop 晚落盘 → readTokensSettled 回头再读一次');
  const uLate = { inputTokens: 18407, outputTokens: 163, cacheTokens: 18176, cachedWriteTokens: 0, cachedMissTokens: 231, credit: 0.18 };
  const uEarly = { inputTokens: 999999, outputTokens: 999, cacheTokens: 999000, cachedWriteTokens: 0, cachedMissTokens: 999, credit: 9.99 };
  // 造一份"Stop 那一刻"的 index.json：本轮那条还是 running，没有 startedAt / usage
  const late = path.join(TMP, 'cb-late.index.json');
  fs.writeFileSync(late, JSON.stringify({ messages: [], requests: [{ id: 'r_now', type: 'craft', state: 'running' }] }, null, 2));
  const pending = readTokensSettled(late, T0);
  // 扩展在 Stop 之后 ~40ms 补上（这里 150ms，够代表"晚一步"）
  setTimeout(() => {
    fs.writeFileSync(
      late,
      JSON.stringify({ messages: [], requests: [{ id: 'r_now', type: 'craft', state: 'complete', startedAt: T0 - 107, usage: uLate }] }, null, 2)
    );
  }, 150);
  const gotLate = await pending;
  ok(
    '晚落盘：等到补上那份（input 231 / output 163 / cacheRead 18,176）',
    sameTokens(gotLate, { input: 231, output: 163, cacheRead: 18176, cacheWrite: 0 }),
    JSON.stringify(gotLate)
  );

  // 别的形态（CLI 的 JSONL）落盘早于 Stop —— 不该为它凭空等一秒
  const plain = writeJsonl('plain-no-usage.jsonl', [{ type: 'user', timestamp: T0 + 1_000, message: { role: 'user', content: '嗯' } }]);
  const t0 = Date.now();
  await readTokensSettled(plain, T0);
  ok('非插件形态扑空就立刻返回（不加等待）', Date.now() - t0 < 50, `${Date.now() - t0}ms`);

  // 等不到（被掐掉的轮次里扩展可能永远不补）→ null，绝不拿上一轮的数顶上
  const never = path.join(TMP, 'cb-never.index.json');
  fs.writeFileSync(
    never,
    JSON.stringify({ messages: [], requests: [{ id: 'r_old', type: 'craft', state: 'complete', startedAt: T0 - 600_000, usage: uEarly }] }, null, 2)
  );
  const gotNever = await readTokensSettled(never, T0);
  ok('等到底也没有本轮那条 → null（不是 10 分钟前那条）', gotNever === null, JSON.stringify(gotNever));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
