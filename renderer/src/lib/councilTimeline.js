/**
 * **Pure logic** for the council view — no network, no Vue, so it is easy to pin down.
 *
 * The detail API and the WS increment describe the same meeting in slightly different shapes
 * (snake_case DB rows vs camelCase events). Everything is normalized here before it reaches reactive
 * state, otherwise a field is present before a refresh and gone after it.
 *
 * The no-fabrication rule applies on the client too: missing numbers stay `null` (rendered as "—"),
 * unknown severity/stance values are never mapped to a guessed one, and a participant with no reported
 * usage is not shown as 0 tokens.
 */

import { DEFAULTS } from '@workgremlin/shared';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pick(camel, snake, src) {
  const v = src[camel] !== undefined ? src[camel] : src[snake];
  return v === undefined ? null : v;
}

function str(v) {
  return v == null ? '' : String(v);
}

function listOf(v) {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
}

const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
const STANCES = ['reject', 'revise', 'accept'];

/* ---------------------------------- review points ---------------------------------- */

/**
 * @param {object} raw DB row or parsed ReviewPoint
 * @returns {{reviewer:string, severity:string, dimension:string, issue:string, evidence:string|null,
 *            suggestion:string, stance:string}}
 */
export function normReviewPoint(raw) {
  const r = raw || {};
  return {
    reviewer: str(pick('reviewer', 'reviewer', r)),
    severity: SEVERITIES.includes(r.severity) ? r.severity : 'minor',
    dimension: str(r.dimension) || '其他',
    issue: str(r.issue),
    evidence: r.evidence == null || r.evidence === '' ? null : String(r.evidence),
    suggestion: str(r.suggestion),
    stance: STANCES.includes(r.stance) ? r.stance : 'revise',
  };
}

/* ---------------------------------- rounds ---------------------------------- */

/**
 * One RoundResult → one stable client shape.
 * Accepts the API's assembled object and the WS push (which uses the same shape).
 *
 * @param {object} raw
 * @returns {{round:number, proposal:{version:string|null, content:string, diffFromPrev:string|null},
 *            reviews:Array, moderator:{consensus:string[], openIssues:string[],
 *              conflicts:Array<{topic:string, sides:Array<{reviewer:string, view:string}>}>,
 *              revisionDirectives:string[], convergenceScore:number|null},
 *            stats:object|null, warnings:Array<{code:string, message:string}>}}
 */
export function normRoundResult(raw) {
  const r = raw || {};
  const p = r.proposal || {};
  const m = r.moderator || {};
  const stats = r.stats && typeof r.stats === 'object' ? r.stats : null;
  const conflicts = Array.isArray(m.conflicts)
    ? m.conflicts
        .map((c) => ({
          topic: str(c && c.topic),
          sides: Array.isArray(c && c.sides)
            ? c.sides.map((s) => ({ reviewer: str(s && s.reviewer), view: str(s && s.view) }))
            : [],
        }))
        .filter((c) => c.topic)
    : [];
  return {
    round: num(pick('round', 'round_no', r)) || 0,
    proposal: {
      version: p.version == null ? null : String(p.version),
      content: str(p.content),
      diffFromPrev: p.diffFromPrev == null || p.diffFromPrev === '' ? null : String(p.diffFromPrev),
    },
    reviews: Array.isArray(r.reviews) ? r.reviews.map(normReviewPoint) : [],
    moderator: {
      consensus: listOf(m.consensus),
      openIssues: listOf(m.openIssues),
      conflicts,
      revisionDirectives: listOf(m.revisionDirectives),
      convergenceScore: num(m.convergenceScore),
    },
    stats,
    warnings: Array.isArray(r.warnings)
      ? r.warnings.map((w) => ({ code: str(w && w.code), message: str(w && w.message) }))
      : [],
  };
}

export function normRoundResults(list) {
  const out = (Array.isArray(list) ? list : []).map(normRoundResult).filter((r) => r.round > 0);
  out.sort((a, b) => a.round - b.round);
  return out;
}

/** Merge one round result into the list (WS may resend it as phases complete). */
export function mergeRoundResult(list, raw) {
  const r = normRoundResult(raw);
  if (!r.round) return Array.isArray(list) ? list : [];
  const out = (Array.isArray(list) ? list : []).slice();
  const at = out.findIndex((x) => x.round === r.round);
  if (at < 0) {
    out.push(r);
  } else {
    // Non-empty wins: a later increment normally carries the full round, but if a partial event
    // arrives, do not wipe what is already on screen.
    const merged = { ...out[at] };
    if (r.proposal.content) merged.proposal = r.proposal;
    if (r.reviews.length) merged.reviews = r.reviews;
    if (
      r.moderator.consensus.length ||
      r.moderator.openIssues.length ||
      r.moderator.conflicts.length ||
      r.moderator.revisionDirectives.length
    ) {
      merged.moderator = r.moderator;
    }
    if (r.stats) merged.stats = r.stats;
    if (r.warnings.length) merged.warnings = r.warnings;
    out[at] = merged;
  }
  out.sort((a, b) => a.round - b.round);
  return out;
}

/* ---------------------------------- utterances ---------------------------------- */

/**
 * @param {object} raw DB row or WS increment
 * @returns {{roundNo:number, floorId:string, phase:string, content:string|null, model:string|null,
 *            status:string, error:string|null, durationMs:number|null, parseDropped:number,
 *            inputTokens:number|null, outputTokens:number|null,
 *            cacheReadTokens:number|null, cacheWriteTokens:number|null}}
 */
export function normUtterance(raw) {
  const u = raw || {};
  return {
    roundNo: num(pick('roundNo', 'round_no', u)) || 0,
    floorId: str(pick('floorId', 'floor_id', u)),
    phase: str(u.phase) || 'brief',
    content: u.content == null ? null : String(u.content),
    model: u.model == null || u.model === '' ? null : String(u.model),
    status: u.status || 'ok',
    error: pick('error', 'error', u),
    durationMs: num(pick('durationMs', 'duration_ms', u)),
    parseDropped: num(pick('parseDropped', 'parse_dropped', u)) || 0,
    inputTokens: num(pick('inputTokens', 'input_tokens', u)),
    outputTokens: num(pick('outputTokens', 'output_tokens', u)),
    cacheReadTokens: num(pick('cacheReadTokens', 'cache_read_tokens', u)),
    cacheWriteTokens: num(pick('cacheWriteTokens', 'cache_write_tokens', u)),
  };
}

/** A floor can speak several phases in one round, so the phase is part of the identity. */
export const utteranceKey = (u) => `${u.roundNo}#${u.floorId}#${u.phase}`;

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

/** Group utterances by round, preserving the server's insertion order. */
export function groupUtterances(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const map = new Map();
  for (const u of list) {
    if (!map.has(u.roundNo)) map.set(u.roundNo, []);
    map.get(u.roundNo).push(u);
  }
  return [...map.keys()]
    .sort((a, b) => a - b)
    .map((roundNo) => ({ roundNo, utterances: map.get(roundNo) }));
}

/* ---------------------------------- aggregation ---------------------------------- */

/**
 * Token usage per floor, with the same semantics as the server:
 *   · all turns missing usage      → all null, total null (UI shows "—")
 *   · some turns missing usage     → sum of known values, `exact: false` (UI shows "≥ N")
 *   · every turn reported usage    → exact sum
 */
export function tokenUsageOf(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let seen = 0;
  let missing = 0;
  for (const u of list) {
    const hasInput = u.inputTokens != null;
    const hasOutput = u.outputTokens != null;
    if (!hasInput && !hasOutput) {
      missing += 1;
      continue;
    }
    seen += 1;
    input += u.inputTokens || 0;
    output += u.outputTokens || 0;
    cacheRead += u.cacheReadTokens || 0;
    cacheWrite += u.cacheWriteTokens || 0;
    // One half missing still makes the total a lower bound: the unknown half contributes an
    // unknown amount, and claiming an exact sum would overstate what was measured.
    if (!hasInput || !hasOutput) missing += 1;
  }
  if (!seen) {
    return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, exact: false };
  }
  return { input, output, cacheRead, cacheWrite, total: input + output, exact: missing === 0 };
}

export function modelOfUtterances(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].model) return list[i].model;
  }
  return null;
}

/** Participant rows → one object per role, with model and token usage derived from the utterances. */
export function roleSummary(participants, utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  return (Array.isArray(participants) ? participants : []).map((p) => {
    const mine = list.filter((u) => u.floorId === p.floor_id);
    return {
      floorId: p.floor_id,
      role: p.role,
      agent: p.agent,
      status: p.status,
      error: p.error || null,
      model: modelOfUtterances(mine),
      tokens: tokenUsageOf(mine),
    };
  });
}

export function severityCountsOf(reviews) {
  const out = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (out[r.severity] != null) out[r.severity] += 1;
  }
  return out;
}

export function stanceCountsOf(reviews) {
  const out = { reject: 0, revise: 0, accept: 0 };
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (out[r.stance] != null) out[r.stance] += 1;
  }
  return out;
}

/** Last round's server-computed score; null when no round has completed. */
export function scoreOf(roundResults) {
  const list = Array.isArray(roundResults) ? roundResults : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = list[i];
    if (r.stats && typeof r.stats.score === 'number') return r.stats.score;
    if (r.moderator && typeof r.moderator.convergenceScore === 'number') {
      return r.moderator.convergenceScore;
    }
  }
  return null;
}

/**
 * Explainable score breakdown. Uses the server's stats when present; otherwise recomputes from the
 * reviews with the shared weights (still deterministic, never model-supplied).
 */
export function scoreBreakdownOf(roundResults) {
  const list = Array.isArray(roundResults) ? roundResults : [];
  const last = list.length ? list[list.length - 1] : null;
  if (!last) return null;
  const weights = DEFAULTS.COUNCIL_SEVERITY_WEIGHTS;
  const conflictWeight = DEFAULTS.COUNCIL_CONFLICT_WEIGHT;
  const max = DEFAULTS.COUNCIL_SCORE_MAX;
  const counts = (last.stats && last.stats.bySeverity) || severityCountsOf(last.reviews);
  const conflicts =
    last.stats && typeof last.stats.conflicts === 'number'
      ? last.stats.conflicts
      : (last.moderator.conflicts || []).length;
  const deduction = SEVERITIES.reduce((n, s) => n + (counts[s] || 0) * (weights[s] || 0), 0) +
    conflicts * conflictWeight;
  const score =
    last.stats && typeof last.stats.score === 'number'
      ? last.stats.score
      : Math.min(max, Math.max(0, max - deduction));
  const parts = SEVERITIES.map((s) => `${s} ${counts[s] || 0}×${weights[s] || 0}`);
  parts.push(`冲突 ${conflicts}×${conflictWeight}`);
  return {
    score,
    max,
    counts: { ...counts },
    conflicts,
    deduction,
    formula: `${max} - (${parts.join(' + ')})`,
  };
}

/**
 * Everything the right-side summary card needs.
 * @param {{participants:Array, utterances:Array, roundResults:Array}} arg
 */
export function summarizeCouncil(arg) {
  const rounds = Array.isArray(arg.roundResults) ? arg.roundResults : [];
  const last = rounds.length ? rounds[rounds.length - 1] : null;
  const reviews = last ? last.reviews : [];
  const breakdown = scoreBreakdownOf(rounds);
  return {
    rounds: rounds.length,
    score: breakdown ? breakdown.score : null,
    breakdown,
    reviewCount: reviews.length,
    severityCounts: severityCountsOf(reviews),
    stanceCounts: stanceCountsOf(reviews),
    conflictCount: last ? last.moderator.conflicts.length : 0,
    roles: roleSummary(arg.participants, arg.utterances),
    trend: rounds
      .filter((r) => r.stats && typeof r.stats.score === 'number')
      .map((r) => ({ round: r.round, score: r.stats.score })),
  };
}

/** Clause for a phase heading: "第 2 轮 · 评审" */
export function phaseLabelKey(phase) {
  return `council.phase.${phase}`;
}

/** Format a token usage object for display ("—", "≥ 1234", "1234"). */
export function formatTokens(tokens) {
  if (!tokens || tokens.total == null) return '—';
  return `${tokens.exact ? '' : '≥ '}${tokens.total}`;
}
