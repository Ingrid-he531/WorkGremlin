'use strict';

/**
 * Mechanical convergence arithmetic and consistency checks.
 *
 * The convergence score is **never model-reported**. It is derived from the review points and the
 * moderator's conflict list, so a moderator cannot inflate it by writing "convergenceScore: 95":
 *
 *   raw   = 100 - (blocker * 25 + major * 8 + minor * 2 + nit * 0 + conflicts * 10)
 *   score = clamp(raw, 0, 100)
 *
 * `nit` carries no weight by design — cosmetic suggestions must not move the number. `conflicts` is the
 * number of entries in `moderator.conflicts`, i.e. genuinely opposing positions the moderator recorded;
 * anything the moderator fails to record still shows up through the severity terms of the review points.
 */

const { DEFAULTS } = require('@workgremlin/shared');

const WEIGHTS = DEFAULTS.COUNCIL_SEVERITY_WEIGHTS;
const CONFLICT_WEIGHT = DEFAULTS.COUNCIL_CONFLICT_WEIGHT;
const SCORE_MAX = DEFAULTS.COUNCIL_SCORE_MAX;
const SEVERITIES = DEFAULTS.COUNCIL_SEVERITIES;

/** Phrases that turn a directive into a suggestion. A hard directive must not contain them. */
const VAGUE_DIRECTIVE_PATTERNS = [
  '建议',
  '可以考虑',
  '酌情',
  '视情况',
  '进一步优化',
  '尽量',
  '最好',
  '或许',
  'maybe',
  'consider',
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Count reviews by severity, dimension, and stance.
 *
 * @param {Array<{severity:string, dimension:string, stance:string}>} reviews
 * @param {Array<{topic:string, sides:Array}>} [conflicts]
 * @returns {{
 *   total:number, bySeverity:Record<string,number>, byDimension:Record<string,number>,
 *   byStance:Record<string,number>, conflicts:number,
 *   weights:Record<string,number>, conflictWeight:number,
 *   deduction:number, rawScore:number, score:number, clamped:boolean
 * }}
 */
function computeStats(reviews, conflicts) {
  const list = Array.isArray(reviews) ? reviews : [];
  const conflictList = Array.isArray(conflicts) ? conflicts : [];

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const byDimension = {};
  const byStance = { reject: 0, revise: 0, accept: 0 };
  for (const r of list) {
    if (!r) continue;
    if (bySeverity[r.severity] != null) bySeverity[r.severity] += 1;
    const dim = r.dimension && String(r.dimension).trim() ? String(r.dimension).trim() : '其他';
    byDimension[dim] = (byDimension[dim] || 0) + 1;
    if (byStance[r.stance] != null) byStance[r.stance] += 1;
  }

  let deduction = conflictList.length * CONFLICT_WEIGHT;
  for (const s of SEVERITIES) deduction += bySeverity[s] * (WEIGHTS[s] || 0);

  const rawScore = SCORE_MAX - deduction;
  const score = clamp(rawScore, 0, SCORE_MAX);
  return {
    total: list.length,
    bySeverity,
    byDimension,
    byStance,
    conflicts: conflictList.length,
    weights: { ...WEIGHTS },
    conflictWeight: CONFLICT_WEIGHT,
    deduction,
    rawScore,
    score,
    clamped: rawScore !== score,
  };
}

/**
 * A compact, human-readable breakdown for the UI and the exported report.
 * Example: `100 - (blocker 2×25 + major 1×8 + minor 0×2 + nit 0×0 + 冲突 1×10) = 24`.
 */
function scoreFormula(stats) {
  const b = stats.bySeverity;
  const parts = SEVERITIES.map((s) => `${s} ${b[s] || 0}×${WEIGHTS[s] || 0}`);
  parts.push(`冲突 ${stats.conflicts}×${CONFLICT_WEIGHT}`);
  const tail = stats.clamped ? ` = ${stats.rawScore} → 封顶 ${stats.score}` : ` = ${stats.score}`;
  return `${SCORE_MAX} - (${parts.join(' + ')})${tail}`;
}

/**
 * Is this a hard directive? The prompt asks for
 * `【针对 <问题>】必须 <具体改动>；验收标准：<可核对的条件>。`
 * A directive missing `必须` / an acceptance criterion, or containing hedging words, is still kept (the
 * moderator's words are data), but it is flagged so the user can see the moderator fudged it.
 */
function directiveProblems(directive) {
  const s = typeof directive === 'string' ? directive : '';
  const problems = [];
  if (!/必须/.test(s)) problems.push('missing_must');
  if (!/验收标准/.test(s)) problems.push('missing_acceptance');
  const lower = s.toLowerCase();
  for (const p of VAGUE_DIRECTIVE_PATTERNS) {
    if (lower.includes(p.toLowerCase())) {
      problems.push('vague');
      break;
    }
  }
  return problems;
}

/**
 * Mechanical consistency warnings for one round. These do not change the score; they are shown to the
 * user and written into report.json so a "the moderator smoothed things over" round is visible.
 *
 * @param {{round:number, reviews:Array, moderator:{consensus:string[],openIssues:string[],
 *          conflicts:Array,revisionDirectives:string[]},
 *          expectedReviewers?:string[], submittedReviewers?:string[]}} round
 * @returns {Array<{code:string, message:string}>}
 */
function consistencyWarnings(round) {
  const out = [];
  const reviews = Array.isArray(round.reviews) ? round.reviews : [];
  const mod = round.moderator || {};
  const blockers = reviews.filter((r) => r && r.severity === 'blocker');
  const directives = Array.isArray(mod.revisionDirectives) ? mod.revisionDirectives : [];
  const openIssues = Array.isArray(mod.openIssues) ? mod.openIssues : [];
  const conflicts = Array.isArray(mod.conflicts) ? mod.conflicts : [];
  const stances = { reject: 0, revise: 0, accept: 0 };
  for (const r of reviews) if (r && stances[r.stance] != null) stances[r.stance] += 1;

  if (blockers.length && !directives.length) {
    out.push({
      code: 'blockers_without_directives',
      message: `本轮有 ${blockers.length} 个 blocker，但主持人没有给出任何修改指令`,
    });
  }
  if (blockers.length && !openIssues.length) {
    out.push({
      code: 'blockers_without_open_issues',
      message: `本轮有 ${blockers.length} 个 blocker，但没有进入 openIssues —— 这些阻塞项不能凭空消失`,
    });
  }
  if (!conflicts.length && (stances.reject > 0 || (stances.accept > 0 && stances.revise > 0))) {
    out.push({
      code: 'split_stance_without_conflicts',
      message: `评审立场出现分歧（reject ${stances.reject} / revise ${stances.revise} / accept ${stances.accept}），但主持人没有记录任何冲突`,
    });
  }

  const vague = directives.filter((d) => directiveProblems(d).includes('vague'));
  if (vague.length) {
    out.push({
      code: 'vague_directives',
      message: `有 ${vague.length} 条修改指令含"建议/可以考虑/酌情"等模糊措辞，不是硬指令`,
    });
  }
  const noAcceptance = directives.filter((d) => directiveProblems(d).includes('missing_acceptance'));
  if (noAcceptance.length) {
    out.push({
      code: 'directives_without_acceptance',
      message: `有 ${noAcceptance.length} 条修改指令没有"验收标准"，无法核对是否落实`,
    });
  }

  if (Array.isArray(round.expectedReviewers)) {
    const submitted = new Set(round.submittedReviewers || []);
    const missing = round.expectedReviewers.filter((x) => !submitted.has(x));
    if (missing.length) {
      out.push({
        code: 'incomplete_reviews',
        message: `以下评审本轮没有产出可用意见：${missing.join('、')}`,
      });
    }
  }
  return out;
}

/**
 * Final-phase warnings. Kept separate because they depend on the adjudication, not on one round.
 *
 * @param {{decision:string|null, lastRoundReviews:Array}} arg
 * @returns {Array<{code:string, message:string}>}
 */
function finalWarnings(arg) {
  const out = [];
  const reviews = Array.isArray(arg.lastRoundReviews) ? arg.lastRoundReviews : [];
  const blockers = reviews.filter((r) => r && r.severity === 'blocker').length;
  if (arg.decision === 'approve' && blockers > 0) {
    out.push({
      code: 'final_accept_with_blockers',
      message: `主持人最终通过，但最后一轮仍有 ${blockers} 个 blocker 未消除`,
    });
  }
  return out;
}

/**
 * Aggregate per-round score trends for the council summary.
 * @param {Array<{round_no:number, stats_json:string|null}>} rows
 */
function scoreTrend(rows) {
  const trend = [];
  for (const row of rows || []) {
    if (!row || !row.stats_json) continue;
    try {
      const stats = JSON.parse(row.stats_json);
      if (stats && typeof stats.score === 'number') {
        trend.push({ round: row.round_no, score: stats.score });
      }
    } catch {
      /* a broken archive row must not break the summary */
    }
  }
  return trend;
}

module.exports = {
  WEIGHTS,
  CONFLICT_WEIGHT,
  SCORE_MAX,
  VAGUE_DIRECTIVE_PATTERNS,
  clamp,
  computeStats,
  scoreFormula,
  directiveProblems,
  consistencyWarnings,
  finalWarnings,
  scoreTrend,
};
