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
 *   2. 认不出的形状（Qoder 的 transcript 根本没有 usage）→ 返回 null，让那一行留空。
 *
 * **CodeBuddy 插件形态走另一条路**（见 codebuddyRequestTokens）：transcriptPath 指向的
 * index.json **不是 JSONL**（缩进过的多行 JSON，逐行 parse 必全败），usage 也不在正文里 ——
 * 它在顶层 `requests[]` 上，一次用户请求一条，自带 startedAt 与 usage。
 * 而这一份 usage **比 Stop 晚 30~50ms 才落盘**（实测 14/14 轮），所以 Stop 里要用
 * turnTokensSettled 等它落盘，不能只读一次（只读一次 = 恒 null = 满屏 "—"）。
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
 * CodeBuddy **插件**形态（VS Code 扩展）的本轮 token。
 *
 * transcriptPath 指向 `history/<会话>/index.json` —— 缩进过的多行 JSON，**按行 parse 必全败**，
 * 正文在同目录 `messages/<id>.json`，而 usage 两者都没有：它在顶层 `requests[]` 上，一条请求一条：
 *   { id, type, state, startedAt, usage: { inputTokens, outputTokens, cacheTokens,
 *                                          cachedWriteTokens, cachedMissTokens, credit } }
 * 口径同 OpenAI（本机 25 份 index.json / 572 条实测，0 例不符）：`inputTokens` **含**缓存命中，
 *   恒有 inputTokens − cacheTokens − cachedWriteTokens === cachedMissTokens
 * 所以照旧交给 normOpenAI 归一 —— 落库才与 CLI 形态那一家的口径一致（四项分列的语义统一）。
 *
 * **对轮（对人）的口径要特别小心**：request 由扩展先建、hook 后收到 UserPromptSubmit，
 * 实测 request.startedAt 比本轮 startedAt **早 84~204ms**（16 轮全如此）。写成 >= startedAt
 * 会把本轮的整条漏掉 —— 一条都捞不着，满屏就是 "—"。所以前后各留 GRACE_MS 的窗口。
 * 窗口里取 startedAt 最大的那条：实测每个会话 tasks 与 requests **严格 1:1**（16/16、25/25、25/25），
 * Stop 时刻最后一条必然就是本轮那条；若本轮的 usage 还没落盘，窗口为空 → null（宁可留 "—"）。
 *
 * **这一份 usage 落盘得比 Stop 晚**（"插件形态一直显示 —"的真正原因，2026-10-08 实测）：
 *   · 轮次进行中，本轮那条 request 只有 `{ id, type, messages, state:'running' }` ——
 *     **没有 startedAt、也没有 usage**（扩展要等这一轮彻底收尾才补上这两项）；
 *   · 补上的时刻实测比服务端记的 ended_at **晚 31~51ms**（同一会话 14/14 轮全如此，
 *     看 index.json 的 mtime 与 task_runs.ended_at 对得上）。
 * 于是 Stop 里第一次读**必然**扑空 —— 窗口里一条都没有，与"这一轮没消耗"长得一样。
 * 只有回头再读一次才拿得到，见 turnTokensSettled。
 */
const CB_REQ_GRACE_MS = 5_000;

function codebuddyRequestTokens(indexPath, startedAt) {
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return null; // 读不到 / 半截 JSON：本轮就是没数，不是 0
  }
  const reqs = Array.isArray(idx && idx.requests) ? idx.requests : [];
  let best = null;
  for (const r of reqs) {
    if (!r || typeof r !== 'object') continue;
    const ts = Number(r.startedAt);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts < startedAt - CB_REQ_GRACE_MS || ts > startedAt + CB_REQ_GRACE_MS) continue;
    if (!best || ts > Number(best.startedAt)) best = r;
  }
  if (!best) return null;
  const u = best.usage;
  if (!u || typeof u !== 'object') return null;
  return normOpenAI({
    prompt_tokens: u.inputTokens,
    prompt_cache_hit_tokens: u.cacheTokens,
    prompt_cache_write_tokens: u.cachedWriteTokens,
    completion_tokens: u.outputTokens,
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
  const isCbIndex = /index\.json$/i.test(file);
  // CodeBuddy **插件**形态：history/<会话>/index.json（缩进过的 JSON，不是 JSONL，
  // 逐行 parse 必全败），usage 在顶层 requests[] 上 —— 走专门那条路（见 codebuddyRequestTokens）
  if (isCbIndex) return finish(codebuddyRequestTokens(file, Number(startedAt)));

  const rows = parseLines(file);
  if (!rows) return null;

  const t = codexDelta(rows, Number(startedAt)) || requestSum(rows, Number(startedAt));
  return finish(t);
}

/** 收尾同一把尺：取不到 → null；四项全零 → null（"一条都没读到"与"消耗为零"是两回事） */
function finish(t) {
  if (!t) return null;
  // 四项全零 = 这一轮一条有效 usage 都没读到（Stop 早于落盘），留空而不是写 0
  if (t.input + t.output + t.cacheRead + t.cacheWrite <= 0) return null;
  return t;
}

/** CodeBuddy 插件形态：等那份"晚到的 usage"最多多久 / 每隔多久回头看一眼 */
const CB_FLUSH_WAIT_MS = 1_200;
const CB_FLUSH_STEP_MS = 120;

/**
 * 这一轮消耗的 token，**必要时等落盘**（只为 CodeBuddy 插件形态等）。
 *
 * 为什么要有这个函数：插件那条 request 的 usage 比 Stop 晚 31~51ms 才写进 index.json
 * （见 codebuddyRequestTokens 的实测记录），而 Stop 里这一次读是**在 TASK_END 之前** ——
 * 此刻窗口里一条 request 都没有，turnTokens 恒 null，报表就是满屏 "—"。
 * 补读一次即可：实测差距只有几十毫秒，第一次回头（120ms）就命中。
 *
 * 只在这两处等：① 路径是插件那份 index.json；② 第一读确实扑空。其余形态（CLI 的 JSONL /
 * Claude / Codex）落盘都早于 Stop，读一次就有 —— 不该为它们凭空加延迟。
 * 等不到（被掐掉的轮次里扩展可能永远不补 / 这一轮真的一条 usage 都没有）就回 null，
 * 与"没数就是没数"同一条纪律：绝不拿上一轮的数顶上。
 *
 * @param {string} transcriptPath
 * @param {number} startedAt 本轮开始时刻（0 / 路径为空 → 立刻 null，连等都不等）
 * @returns {Promise<{input:number, output:number, cacheRead:number, cacheWrite:number}|null>}
 */
async function turnTokensSettled(transcriptPath, startedAt) {
  const file = String(transcriptPath || '');
  const first = turnTokens(file, startedAt);
  if (first || !file || !(Number(startedAt) > 0)) return first;
  if (!/index\.json$/i.test(file)) return null; // 只有插件那一份会晚到
  for (let waited = 0; waited < CB_FLUSH_WAIT_MS; waited += CB_FLUSH_STEP_MS) {
    await new Promise((r) => setTimeout(r, CB_FLUSH_STEP_MS));
    const t = turnTokens(file, startedAt);
    if (t) return t;
  }
  return null;
}

module.exports = { turnTokens, turnTokensSettled };
