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
 * 按轮次分组，供时间线渲染。轮次升序；同一轮里主席排最前，其余按楼层号。
 * @returns {Array<{roundNo:number, utterances:Array, tally:object}>}
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
      return { roundNo, utterances: items, tally: tallyOf(items) };
    });
}

/**
 * 立场 → i18n 键后缀。认不出的（null / 没表态）单独一档，界面写「未表态」。
 * 这一层绝不把"没表态"显示成"同意"。
 */
export function voteKey(vote) {
  return vote === 'agree' || vote === 'disagree' || vote === 'abstain' ? vote : 'none';
}

/** 发言状态 → 能不能算一句"有效的话"（失败 / 超时 / 没表态的不算） */
export const isSpoken = (u) => u && u.status === 'ok';

/** 词元总数：四个字段**都**取不到时返回 null（界面显示「—」，不显示 0） */
export function tokenTotal(u) {
  const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((n, v) => n + (v || 0), 0);
}
