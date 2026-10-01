'use strict';

/**
 * 一轮任务消耗的 token —— 从会话落盘里读**真值**，读不到就回 null（服务端留 NULL）。
 *
 * 为什么单独一个模块：hook.js 是"跑完就退出的脚本"（末尾直接 `main()`，require 它就会执行
 * 一遍 hook），拿它做单测等于触发一次上报。这里只放纯函数（读文件 + 解析 + 求和），
 * 由 hook.js 的 Stop 调用，单测直接喂造好的 transcript。
 *
 * **四列的语义（全楼层统一，落库前必须归一）**：
 *   input      —— **不含缓存**的那部分输入（fresh tokens）
 *   cacheRead  —— 命中缓存的输入
 *   cacheWrite —— 写入缓存的输入
 *   output     —— 模型吐出的（**含思考**）
 * 于是恒有 `input + cacheRead + cacheWrite` = 这一次请求的 prompt 总长。之所以要归一，
 * 是因为两家的口径**正好相反**（本机实测，见下），不归一的话同一个"输入 token"列在
 * 1F/3F 是整段上下文、在 4F/7F/8F 只是没命中缓存的那一小截，差出一个数量级。
 *
 * 认两种口径，认不出来的一律 null（宁可留空，绝不猜）：
 *   · Anthropic 口径（4F Claude Code）：`input_tokens` **不含**缓存，另有
 *     `cache_read_input_tokens` / `cache_creation_input_tokens`。
 *     实测：输入 161 而缓存读 46,336 —— 若 input 含缓存则不可能出现。
 *   · OpenAI 口径（1F CodeBuddy CLI、3F Codex 的中转）：`prompt_tokens` **含**缓存命中。
 *     实测：`prompt_cache_hit_tokens + prompt_cache_miss_tokens == prompt_tokens`，142/142 条成立。
 *     落库前减掉命中与写入，与上面那套对齐。
 *
 * **按轮取数**：一轮用户任务里往往有多次 API 请求，每次请求各写一条 usage。
 *   · 逐请求那两家（1F/4F）—— 取本轮窗口内的请求**求和**（计费口径：每次请求都真的读了那么多）。
 *   · Codex（3F）—— `total_token_usage` 是**会话内累计**，取"本轮收尾时的累计 − 本轮开始前的累计"。
 *
 * 两条纪律（对齐 requirements.md §P0-6「绝不编造」）：
 *   1. **Claude 家族一份 usage 会在 transcript 里重复落 2~5 行**（同一 `message.id`，
 *      一行一个 content block）。实测 1049 行只对应 403 个请求 —— 不去重就是几倍虚高。
 *   2. 认不出的形状（Qoder 的 transcript 根本没有 usage、CodeBuddy 插件形态的 index.json
 *      也没有）→ 返回 null，让那一行留空。
 */

const fs = require('node:fs');

/** 一行里的数字：非有限值 / 负数一律当 0（缺字段就是没有，不拿别的数顶） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 行的时间戳：Claude 家族是 ISO 字符串，CodeBuddy 是毫秒数（实测 `1790484979790`）。
 * 读不出就是 0 —— 0 在下面的窗口过滤里会**被排除**（宁可少算，不算到别的轮头上）。
 */
function tsOf(o) {
  const t = o && o.timestamp;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const n = Date.parse(String(t || ''));
  return Number.isFinite(n) ? n : 0;
}

/** 逐行 JSON.parse；文件读不到 → null（区别于"读到了但一行 usage 都没有"）。半截行跳过，不猜。 */
function parseLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = [];
  for (const ln of raw.split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') out.push(o);
    } catch {
      /* 半截行 / 非 JSON 行：跳过 */
    }
  }
  return out;
}

/** Anthropic 口径：三项分列，原样取（`input_tokens` 本来就不含缓存） */
function normAnthropic(u) {
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

/**
 * OpenAI 口径：`prompt_tokens` **含**缓存命中，减掉才是"没命中缓存的那部分"。
 * 写入那一项各家叫法不一（CodeBuddy 是 `prompt_cache_write_tokens`），取不到按 0 算 ——
 * 本机实测这条链路从不做 cache 写入（五个源全是 0），减不减都一样。
 */
function normOpenAI(u) {
  const prompt = num(u.prompt_tokens);
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {};
  const cacheRead = num(u.prompt_cache_hit_tokens) || num(details.cached_tokens) || num(u.cached_tokens);
  const cacheWrite = num(u.prompt_cache_write_tokens);
  return {
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output: num(u.completion_tokens) || num(u.output_tokens),
    cacheRead,
    cacheWrite,
  };
}

/**
 * 一行 transcript 里的 usage —— 认得出就回 `{kind, u, key, ts}`，认不出回 null。
 *
 * 只认**结构完整**的那份：CodeBuddy 一行里同时有 `providerData.rawUsage`（完整，带缓存命中/写入）
 * 与 `message.usage`（简化副本，只有 input/output/total/cache_read，本机实测 142 行两者成对出现）。
 * 取 rawUsage 那一份，别两份都算 —— 那就是同一笔消耗记两次。
 */
function usageOf(row) {
  const raw = row.providerData && row.providerData.rawUsage;
  if (raw && typeof raw === 'object' && 'prompt_tokens' in raw) {
    return { kind: 'openai', u: raw, key: String(row.id || row.callId || ''), ts: tsOf(row) };
  }
  const m = row.message;
  const u = m && m.usage;
  if (u && typeof u === 'object') {
    // `cache_creation_input_tokens` 是 Claude 家族独有的分列字段，拿它当判据最稳
    if ('cache_creation_input_tokens' in u) {
      return { kind: 'anthropic', u, key: String(m.id || row.uuid || ''), ts: tsOf(row) };
    }
    if ('prompt_tokens' in u) {
      return { kind: 'openai', u, key: String(row.id || row.uuid || ''), ts: tsOf(row) };
    }
  }
  return null;
}

/** 逐请求求和（1F / 4F）。按 key 去重：同一 `message.id` 的多行是同一笔。 */
function requestSum(rows, startedAt) {
  const seen = new Set();
  let acc = null;
  for (const row of rows) {
    const got = usageOf(row);
    if (!got) continue;
    // 时间窗：本轮开始**之前**落的那条是上一轮的。时间戳读不出的（ts=0）一并排除。
    if (!got.ts || got.ts < startedAt) continue;
    if (got.key) {
      if (seen.has(got.key)) continue;
      seen.add(got.key);
    }
    const part = got.kind === 'anthropic' ? normAnthropic(got.u) : normOpenAI(got.u);
    if (!acc) acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    acc.input += part.input;
    acc.output += part.output;
    acc.cacheRead += part.cacheRead;
    acc.cacheWrite += part.cacheWrite;
  }
  return acc;
}

/**
 * Codex（3F）：rollout 里的 `event_msg / token_count` 事件带 `info.total_token_usage`，
 * 那是**会话内累计**（实测一条会话到 6993 万）。本轮消耗 = 收尾时的累计 − 本轮开始前的累计。
 * 没有比 startedAt 更早的事件时基线取 0 —— 那是"这个会话就是从本轮开始的"，
 * 不是缺数据；但若最后一条事件本身早于本轮开始，说明这一轮一个 token_count 都还没落，回 null。
 */
function codexDelta(rows, startedAt) {
  const evs = [];
  for (const o of rows) {
    if (!o || o.type !== 'event_msg') continue;
    const p = o.payload;
    if (!p || p.type !== 'token_count') continue;
    const t = p.info && p.info.total_token_usage;
    if (!t || typeof t !== 'object') continue;
    evs.push({ ts: tsOf(o), t });
  }
  if (!evs.length) return null;

  let base = null;
  for (const e of evs) if (e.ts && e.ts <= startedAt) base = e;
  const last = evs[evs.length - 1];
  if (!base && last.ts && last.ts < startedAt) return null;

  const from = base ? base.t : {};
  const d = (k) => Math.max(0, num(last.t[k]) - num(from[k]));
  // Codex 的 `input_tokens` 同样**含**缓存命中（实测 cached ⊆ input，1633/1633），
  // 所以交给 normOpenAI 统一减：字段名对齐它的入参。
  return normOpenAI({
    prompt_tokens: d('input_tokens'),
    prompt_cache_hit_tokens: d('cached_input_tokens'),
    prompt_cache_write_tokens: d('cache_write_input_tokens'),
    completion_tokens: d('output_tokens'),
  });
}

/**
 * 这一轮消耗的 token。
 * @param {string} transcriptPath hook payload 的 `transcript_path`（或状态文件里缓存的那份）
 * @param {number} startedAt 本轮开始时刻（见 hook 状态文件的 taskStartedAt）
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number}|null}
 *          取不到一律 null —— 服务端据此留 NULL，报表显示 "—"
 */
function turnTokens(transcriptPath, startedAt) {
  const file = String(transcriptPath || '');
  if (!file) return null;
  // 本轮从哪开始都不知道，就没法把 usage 归到这一轮头上（宁可留空）
  if (!(Number(startedAt) > 0)) return null;
  // CodeBuddy **插件**形态的 transcriptPath 指向 history/<会话>/index.json，那份索引里
  // 没有 usage（实测 377 字节，连 token 字样都没有）—— CLI 形态才落在 projects/*.jsonl。
  if (/index\.json$/i.test(file)) return null;

  const rows = parseLines(file);
  if (!rows) return null;

  const t = codexDelta(rows, Number(startedAt)) || requestSum(rows, Number(startedAt));
  if (!t) return null;
  // 四项全零 = 这一轮一条有效 usage 都没读到（Stop 早于落盘），留空而不是写 0
  if (t.input + t.output + t.cacheRead + t.cacheWrite <= 0) return null;
  return t;
}

module.exports = { turnTokens };
