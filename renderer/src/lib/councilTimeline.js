/**
 * **Pure logic** for the council timeline —— no network, no Vue, so it's easy to pin down.
 *
 * Why it exists: the utterances of one council come from two sources whose shapes **differ**:
 *   · GET /councils/:id —— database row (snake_case: round_no / vote_reason / duration_ms);
 *   · WS council.update —— incremental push from the server (camelCase: roundNo / voteReason / durationMs).
 * They are the same timeline on screen, so they must first be normalized to one shape before merging, otherwise you get
 * oddities like "the reason is there before refresh, gone after refresh" that are only visible on one path.
 *
 * The other thing is **deduplication**: when WS jitters / reconnects, the same utterance arrives again. Deduplicating by (round, floor)
 * is enough —— in one round a floor speaks only once, so this key is unique.
 */

/** Numeric field: unavailable means null. **Never write 0** —— 0 tokens and "tokens unreadable" are not the same thing */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pick one value from the two shapes (camelCase first, then snake_case) */
function pick(camel, snake, src) {
  const v = src[camel] !== undefined ? src[camel] : src[snake];
  return v === undefined ? null : v;
}

/** The three point arrays: anything not an array counts as empty —— each item must still be a string, the rest is dropped (no guessing via toString) */
function listOf(v) {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
}

/**
 * Analysis-mode findings → unified shape.
 *
 * **Must accept both inputs**: the detail API gives the JSON string from the DB (`findings_json`),
 * the WS increment gives an object the server has already parsed (`findings`). If they aren't compatible you get
 * "findings present before refresh, gone after refresh".
 *
 * The most critical point: `null` and `{}` **are not the same thing**, they must not be merged:
 *   · null / '' / bad JSON → null —— it didn't give findings as agreed (unparseable), the UI must say so;
 *   · {} → three empty arrays —— it did give findings, they're just all empty (asked, and the answer was "none").
 * The former is "didn't say", the latter is "said there are none" —— the UI wording differs.
 *
 * @param {unknown} raw JSON string / already-parsed object / null
 * @returns {{points:string[],risks:string[],questions:string[]}|null}
 */
export function normFindings(raw) {
  if (raw == null || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null; // bad JSON = unparseable = null, never treat it as an empty array
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  return { points: listOf(obj.points), risks: listOf(obj.risks), questions: listOf(obj.questions) };
}

/**
 * One utterance → unified shape.
 * @param {object} raw DB row or WS increment
 */
export function normUtterance(raw) {
  const u = raw || {};
  return {
    roundNo: num(pick('roundNo', 'round_no', u)) || 0,
    floorId: pick('floorId', 'floor_id', u) || '',
    role: u.role || 'speaker',
    content: u.content == null ? null : String(u.content),
    // Vote: anything outside the three recognized values is null (no stance). **Don't guess the sentiment**
    vote: u.vote === 'agree' || u.vote === 'disagree' || u.vote === 'abstain' ? u.vote : null,
    // Analysis-mode stance: likewise only the whitelist, everything else is null (no stance)
    stance: u.stance === 'support' || u.stance === 'oppose' || u.stance === 'unsure' ? u.stance : null,
    // Findings: the detail gives a JSON string, WS gives an object, accept both; unparseable is null, not an empty array
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

/** An utterance's identity: in one round a floor speaks only once */
export const utteranceKey = (u) => `${u.roundNo}#${u.floorId}`;

/**
 * Merge one utterance into the list: same key merges, new key appends. Returns a new array (the caller is reactive
 * state, so don't mutate in place).
 *
 * The merge rule is **non-empty overwrites, empty preserves**, not "last one wins": WS pushes increments, so an utterance may
 * arrive in several parts (content first, then vote), and fields the later one doesn't mention are null. Merging by "last one wins",
 * the second would wipe the first one's content to null —— which shows in the UI as "refresh and the content is gone".
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
 * Vote tally for one round (computed from the utterances).
 * The server also gives an authoritative one (round) —— the UI shows both: the server's is the basis for the verdict,
 * this one is counted from the utterances and serves to cross-check (a mismatch means something is wrong, and it must not be silently overwritten).
 */
export function tallyOf(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const t = { seats: list.length, agree: 0, disagree: 0, abstain: 0, invalid: 0 };
  for (const u of list) {
    if (u.role === 'chair') {
      t.seats -= 1; // the chair is the server's topic statement, takes no seat and doesn't vote
      continue;
    }
    if (u.status !== 'ok' || !u.vote) t.invalid += 1;
    else t[u.vote] += 1;
  }
  return t;
}

/**
 * Analysis-mode stance tally (computed from the utterances). The chair takes no seat, the same rule set as tallyOf ——
 * this way the "number of non-positions at vote time" and "at analysis time" use the same definition, so users don't have to learn two.
 *
 * The `none` bucket must exist: timeouts / crashes / unparseable stances all land here, the UI writes "no stance"
 * and attaches the original error. **Never** quietly stuff them into one side —— that would be speaking on their behalf.
 */
export function stanceCountsOf(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const t = { seats: list.length, support: 0, oppose: 0, unsure: 0, none: 0 };
  for (const u of list) {
    if (u.role === 'chair') {
      t.seats -= 1; // the chair is the server's topic statement, takes no seat and takes no stance
      continue;
    }
    if (u.status !== 'ok' || !u.stance) t.none += 1;
    else t[u.stance] += 1;
  }
  return t;
}

/**
 * Group by round for the timeline to render. Rounds ascending; within a round the chair comes first, the rest by floor number.
 * `stanceTally` is an **added field**, the `tally` of the vote path is untouched verbatim.
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
 * Stance → i18n key suffix. Unrecognized ones (null / no stance) get their own bucket, the UI writes "no stance".
 * This layer never displays "no stance" as "agree".
 */
export function voteKey(vote) {
  return vote === 'agree' || vote === 'disagree' || vote === 'abstain' ? vote : 'none';
}

/** Analysis-mode stance → i18n key suffix. Same rule as voteKey: unrecognized is 'none' */
export function stanceKey(stance) {
  return stance === 'support' || stance === 'oppose' || stance === 'unsure' ? stance : 'none';
}

/** Utterance status → whether it counts as a "valid statement" (failures / timeouts / no stance don't) */
export const isSpoken = (u) => u && u.status === 'ok';

/** Token total: returns null when **all** four fields are unavailable (the UI shows "—", not 0) */
export function tokenTotal(u) {
  const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((n, v) => n + (v || 0), 0);
}
