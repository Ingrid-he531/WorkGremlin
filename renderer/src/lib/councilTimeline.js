/**
 * 议事厅时间线的**纯逻辑** —— 不碰网络、不碰 Vue，好钉住。
 *
 * 存在的理由：同一场会的发言有两个来源，形状**不一样**：
 *   · GET /councils/:id —— 数据库行（snake_case：round_no / vote_reason / duration_ms）；
 *   · WS council.update —— 服务端现推的增量（camelCase：roundNo / voteReason / durationMs）。
 * 界面上它们是同一条时间线，所以必须先归一成一种形状再合并，否则会出现
 * 「刷新前有理由、刷新后理由没了」这类只在某个路径上才看得见的怪事。
 *
 * 另一件事是**去重**：WS 抖动 / 断线重连时同一条发言会再到一次。按 (轮次, 楼层)
 * 去重即可 —— 一轮里一层只发一次言，这个键是唯一的。
 */

/** 数字字段：取不到就是 null。**不写 0** —— 0 词元和"读不到词元"不是一回事 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 两种形状里挑一个值（camelCase 优先，其次 snake_case） */
function pick(camel, snake, src) {
  const v = src[camel] !== undefined ? src[camel] : src[snake];
  return v === undefined ? null : v;
}

/** 三个要点数组：不是数组一律当空 —— 里面每一项还必须是字符串，其余丢掉（不 toString 猜） */
function listOf(v) {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
}

/**
 * 分析模式的要点 → 统一形状。
 *
 * **要同时吃两种输入**：详情接口给的是 DB 里的 JSON 字符串（`findings_json`），
 * WS 增量给的是服务端已经解析好的对象（`findings`）。不兼容的话就会出现
 * "刷新前有要点、刷新后没了"。
 *
 * 最关键的一条：`null` 与 `{}` **不是一回事**，不许合并：
 *   · null / '' / 坏 JSON → null —— 它没按约定给出要点（解析不出来），界面要说这句；
 *   · {} → 三个空数组 —— 它给出了要点，只是三条都空（问了，答的是"没有"）。
 * 前者是"没说"，后者是"说了没有"，界面上的话术不一样。
 *
 * @param {unknown} raw JSON 字符串 / 已解析对象 / null
 * @returns {{points:string[],risks:string[],questions:string[]}|null}
 */
export function normFindings(raw) {
  if (raw == null || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null; // 坏 JSON = 解析不出来 = null，绝不当成空数组
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  return { points: listOf(obj.points), risks: listOf(obj.risks), questions: listOf(obj.questions) };
}

/**
 * 一条发言 → 统一形状。
 * @param {object} raw DB 行或 WS 增量
 */
export function normUtterance(raw) {
  const u = raw || {};
  return {
    roundNo: num(pick('roundNo', 'round_no', u)) || 0,
    floorId: pick('floorId', 'floor_id', u) || '',
    role: u.role || 'speaker',
    content: u.content == null ? null : String(u.content),
    // 票：认得出的三种之外一律 null（未表态）。**不猜语气**
    vote: u.vote === 'agree' || u.vote === 'disagree' || u.vote === 'abstain' ? u.vote : null,
    // 分析模式的立场：同样只认白名单，其余一律 null（未表态）
    stance: u.stance === 'support' || u.stance === 'oppose' || u.stance === 'unsure' ? u.stance : null,
    // 要点：详情给 JSON 字符串、WS 给对象，两边都吃；解析不出来是 null，不是空数组
    findings: normFindings(pick('findings', 'findings_json', u)),
    voteReason: pick('voteReason', 'vote_reason', u),
    proposal: pick('proposal', 'proposal_text', u),
    second: pick('second', 'second_floor', u),
    status: u.status || 'ok',
    error: pick('error', 'error', u),
    durationMs: num(pick('durationMs', 'duration_ms', u)),
    inputTokens: num(pick('inputTokens', 'input_tokens', u)),
    outputTokens: num(pick('outputTokens', 'output_tokens', u)),
    cacheReadTokens: num(pick('cacheReadTokens', 'cache_read_tokens', u)),
    cacheWriteTokens: num(pick('cacheWriteTokens', 'cache_write_tokens', u)),
  };
}

/** 一条发言的身份：一轮里一层只发一次言 */
export const utteranceKey = (u) => `${u.roundNo}#${u.floorId}`;

/**
 * 把一条发言并进列表：同一个键就合并，新的键就追加。返回新数组（调用方是响应式
 * state，不原地改）。
 *
 * 合并的规矩是**非空覆盖、空则保留**，不是"后到的赢"：WS 是增量推送，一条发言可能
 * 分几次到（先正文、再票型），后到那条里没提到的字段是 null。按"后到的赢"合并，
 * 第二条就会把第一条的正文抹成 null —— 界面上表现为"刷新一下正文就没了"。
 */
export function mergeUtterance(list, raw) {
  const u = normUtterance(raw);
  const key = utteranceKey(u);
  const out = (Array.isArray(list) ? list : []).slice();
  const at = out.findIndex((x) => utteranceKey(x) === key);
  if (at < 0) {
    out.push(u);
    return out;
  }
  const merged = { ...out[at] };
  for (const [k, v] of Object.entries(u)) {
    if (v != null && v !== '') merged[k] = v;
  }
  out[at] = merged;
  return out;
}

/**
 * 一轮里的票型汇总（从发言现算）。
 * 服务端也会给一份权威的（round）—— 界面上两个都显示：服务端那份是判定依据，
 * 这份是从发言数出来的，用来互相印证（对不上就是有问题，不该悄悄盖掉）。
 */
export function tallyOf(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const t = { seats: list.length, agree: 0, disagree: 0, abstain: 0, invalid: 0 };
  for (const u of list) {
    if (u.role === 'chair') {
      t.seats -= 1; // 主席是服务端的议题陈述，不占席位、不投票
      continue;
    }
    if (u.status !== 'ok' || !u.vote) t.invalid += 1;
    else t[u.vote] += 1;
  }
  return t;
}

/**
 * 分析模式的立场汇总（从发言现算）。主席不占席位，与 tallyOf 同一套规矩 ——
 * 这样"表决时的未表态人数"和"分析时的未表态人数"口径一致，用户不必学两套。
 *
 * `none` 这一档必须存在：超时 / 崩了 / 解析不出立场的都落在这里，界面写「未表态」
 * 并附上错误原文。**不许**把它们悄悄塞进某一方 —— 那是替它表态。
 */
export function stanceCountsOf(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const t = { seats: list.length, support: 0, oppose: 0, unsure: 0, none: 0 };
  for (const u of list) {
    if (u.role === 'chair') {
      t.seats -= 1; // 主席是服务端的议题陈述，不占席位、不表态
      continue;
    }
    if (u.status !== 'ok' || !u.stance) t.none += 1;
    else t[u.stance] += 1;
  }
  return t;
}

/**
 * 按轮次分组，供时间线渲染。轮次升序；同一轮里主席排最前，其余按楼层号。
 * `stanceTally` 是**加出来的字段**，表决那条路的 `tally` 逐字未动。
 * @returns {Array<{roundNo:number, utterances:Array, tally:object, stanceTally:object}>}
 */
export function groupByRound(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const byRound = new Map();
  for (const u of list) {
    if (!byRound.has(u.roundNo)) byRound.set(u.roundNo, []);
    byRound.get(u.roundNo).push(u);
  }
  return [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((roundNo) => {
      const items = byRound.get(roundNo).slice().sort((a, b) => {
        if (a.role !== b.role) return a.role === 'chair' ? -1 : 1;
        return String(a.floorId).localeCompare(String(b.floorId), 'en', { numeric: true });
      });
      return { roundNo, utterances: items, tally: tallyOf(items), stanceTally: stanceCountsOf(items) };
    });
}

/**
 * 立场 → i18n 键后缀。认不出的（null / 没表态）单独一档，界面写「未表态」。
 * 这一层绝不把"没表态"显示成"同意"。
 */
export function voteKey(vote) {
  return vote === 'agree' || vote === 'disagree' || vote === 'abstain' ? vote : 'none';
}

/** 分析模式的立场 → i18n 键后缀。与 voteKey 同一条规矩：认不出就是 'none' */
export function stanceKey(stance) {
  return stance === 'support' || stance === 'oppose' || stance === 'unsure' ? stance : 'none';
}

/** 发言状态 → 能不能算一句"有效的话"（失败 / 超时 / 没表态的不算） */
export const isSpoken = (u) => u && u.status === 'ok';

/** 词元总数：四个字段**都**取不到时返回 null（界面显示「—」，不显示 0） */
export function tokenTotal(u) {
  const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((n, v) => n + (v || 0), 0);
}
