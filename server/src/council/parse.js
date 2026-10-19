'use strict';

/**
 * Structured-output parsing for every council phase.
 *
 * The contract with the models is: speak normally, then finish with one JSON block. Parsing is
 * **lenient about location** (the last fenced or inline object wins, so mid-text examples are ignored)
 * and **strict about meaning**: a review item missing a required field is dropped and counted, never
 * patched up. The caller records the drop count so the UI can show "3 of 5 points were unusable".
 *
 * None of these parsers invent a value:
 *   · no recognizable block       → `parsed: false`, lists empty
 *   · a recognized block, empty   → `parsed: true`, lists empty (a legitimate "no conflicts")
 *   · a malformed item            → dropped + counted
 */

/**
 * Find the **last** JSON object satisfying the predicate.
 * Fenced blocks are tried from the back first; a model often shows an example mid-text, and the last
 * block is the answer. With no fence, scan backwards for balanced `{...}` chunks.
 *
 * @param {string} s
 * @param {(obj:object)=>boolean} ok
 * @returns {{obj:object, start:number, end:number}|null}
 */
function findLastJsonChunk(s, ok) {
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fenced = [];
  let m;
  while ((m = fenceRe.exec(s)) !== null) {
    const obj = tryParseJsonObject(m[1], ok);
    if (obj) fenced.push({ obj, start: m.index, end: m.index + m[0].length });
  }
  if (fenced.length) return fenced[fenced.length - 1];

  // Collect every balanced object that parses. Scanning from the last `{` alone would return the
  // *innermost* item (e.g. the final element of a reviews array) instead of the object wrapping it,
  // so drop candidates contained in another candidate and keep the last outer one.
  const candidates = [];
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    const chunk = extractBalanced(s, i);
    if (!chunk) continue;
    const obj = tryParseJsonObject(chunk, ok);
    if (obj) candidates.push({ obj, start: i, end: i + chunk.length });
  }
  const outer = candidates.filter(
    (c) => !candidates.some((o) => o !== c && o.start < c.start && o.end >= c.end)
  );
  return outer.length ? outer[outer.length - 1] : null;
}

/** @param {string} s @param {(obj:object)=>boolean} ok */
function lastJsonBlock(s, ok) {
  const found = findLastJsonChunk(s, ok);
  return found ? found.obj : null;
}

function tryParseJsonObject(chunk, ok) {
  if (!chunk) return null;
  try {
    const obj = JSON.parse(String(chunk).trim());
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && ok(obj)) return obj;
  } catch {
    /* cannot parse it, try the next candidate */
  }
  return null;
}

/** From s[from]=='{', take a brace-balanced slice (braces inside strings are skipped) */
function extractBalanced(s, from) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  return '';
}

function strOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** Non-empty strings only; non-array input yields an empty list (never invented entries). */
function strList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => strOrNull(x)).filter(Boolean);
}

/**
 * Directive entries are normally strings, but models occasionally wrap them as `{"directive":"…"}`.
 * Accept that shape without accepting arbitrary objects.
 */
function directiveList(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === 'string') return strOrNull(x);
      if (x && typeof x === 'object') return strOrNull(x.directive || x.text || x.content);
      return null;
    })
    .filter(Boolean);
}

function normalizeSeverity(raw) {
  const s = strOrNull(raw);
  if (!s) return null;
  const t = s.toLowerCase();
  if (/^(blocker|critical|fatal|p0|阻塞|阻断|致命|必须修复)$/.test(t)) return 'blocker';
  if (/^(major|high|p1|严重|重要|高)$/.test(t)) return 'major';
  if (/^(minor|medium|low|p2|次要|一般|轻微|中|低)$/.test(t)) return 'minor';
  if (/^(nit|trivial|suggestion|p3|建议|提示|优化|细节)$/.test(t)) return 'nit';
  return null;
}

function normalizeStance(raw) {
  const s = strOrNull(raw);
  if (!s) return null;
  const t = s.toLowerCase();
  if (/^(reject|oppose|disagree|against|no|反对|拒绝|不同意|否决)$/.test(t)) return 'reject';
  if (/^(revise|change|modify|amend|修改|修订|调整|需修改|有条件通过)$/.test(t)) return 'revise';
  if (/^(accept|approve|agree|support|yes|接受|同意|通过|赞成|支持)$/.test(t)) return 'accept';
  return null;
}

function normalizeDecision(raw) {
  const s = strOrNull(raw);
  if (!s) return null;
  const t = s.toLowerCase();
  if (/^(approve|approved|accept|accepted|pass|通过|批准|接受)$/.test(t)) return 'approve';
  if (/^(approve_with_changes|conditional|revise|修改后通过|有条件通过|需修改)$/.test(t)) {
    return 'approve_with_changes';
  }
  if (/^(reject|rejected|fail|不通过|拒绝|否决)$/.test(t)) return 'reject';
  return null;
}

/** Keep only the given keys of an addressed entry; missing `how` is recorded as null, not fabricated. */
function addressedList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const directive = strOrNull(item.directive || item.for || item.target);
    const how = strOrNull(item.how || item.change || item.implementation);
    if (directive && how) out.push({ directive, how });
    else if (directive) out.push({ directive, how: null });
  }
  return out;
}

/** Remove the chosen JSON chunk from the text and return the remaining prose. */
function bodyWithoutChunk(s, chunk) {
  if (!chunk) return s.trim();
  return (s.slice(0, chunk.start) + '\n' + s.slice(chunk.end)).trim();
}

/* ---------------------------------- Round 0: moderator plan ---------------------------------- */

/**
 * `{"breakdown":["…"],"assignments":[{"reviewer":"4F","focus":"…"}],"reviewFocus":["…"]}`
 *
 * @param {string} text
 * @returns {{parsed:boolean, breakdown:string[], assignments:Array<{reviewer:string, focus:string|null}>,
 *            reviewFocus:string[]}}
 */
function parsePlanBlock(text) {
  const s = String(text == null ? '' : text);
  const empty = { parsed: false, breakdown: [], assignments: [], reviewFocus: [] };
  if (!s.trim()) return empty;
  const obj = lastJsonBlock(s, (o) => 'breakdown' in o || 'assignments' in o || 'reviewFocus' in o);
  if (!obj) return empty;

  const assignments = [];
  if (Array.isArray(obj.assignments)) {
    for (const a of obj.assignments) {
      if (!a || typeof a !== 'object') continue;
      const reviewer = strOrNull(a.reviewer || a.floor || a.floorId);
      if (reviewer) assignments.push({ reviewer, focus: strOrNull(a.focus || a.assignment) });
    }
  }
  return {
    parsed: true,
    breakdown: strList(obj.breakdown),
    assignments,
    reviewFocus: strList(obj.reviewFocus || obj.focus),
  };
}

/* ---------------------------------- Proposal ---------------------------------- */

const PROPOSAL_KEYS = ['version', 'diffFromPrev', 'addressed', 'content', 'proposal'];

/**
 * Proposal text is the message body; the tail block carries metadata. If a model puts the whole
 * proposal inside `content`, that wins and the prose around it is ignored.
 *
 * @param {string} text
 * @returns {{parsed:boolean, content:string, version:string|null, diffFromPrev:string|null,
 *            addressed:Array<{directive:string, how:string|null}>}}
 */
function parseProposalBlock(text) {
  const s = String(text == null ? '' : text);
  const chunk = s.trim() ? findLastJsonChunk(s, (o) => PROPOSAL_KEYS.some((k) => k in o)) : null;
  if (!chunk) {
    return { parsed: false, content: s.trim(), version: null, diffFromPrev: null, addressed: [] };
  }
  const obj = chunk.obj;
  const inline = strOrNull(obj.content || obj.proposal);
  return {
    parsed: true,
    content: inline || bodyWithoutChunk(s, chunk),
    version: strOrNull(obj.version),
    diffFromPrev: strOrNull(obj.diffFromPrev || obj.diff),
    addressed: addressedList(obj.addressed),
  };
}

/* ---------------------------------- Review ---------------------------------- */

const REVIEW_KEYS = ['reviews', 'severity', 'issue', 'suggestion'];

/**
 * `{"reviews":[{severity,dimension,issue,evidence,suggestion,stance}],"stance":"…"}`
 *
 * `reviewer` is always assigned by the server from the floor that spoke — a model cannot review under
 * someone else's name. A review item is dropped (and counted) when severity, issue, suggestion, or
 * stance is missing/unrecognized.
 *
 * @param {string} text
 * @returns {{parsed:boolean, reviews:Array<object>, dropped:number, overallStance:string|null}}
 */
function parseReviewBlock(text) {
  const s = String(text == null ? '' : text);
  const empty = { parsed: false, reviews: [], dropped: 0, overallStance: null };
  if (!s.trim()) return empty;
  const obj = lastJsonBlock(s, (o) => REVIEW_KEYS.some((k) => k in o));
  if (!obj) return empty;

  const overallStance = normalizeStance(obj.stance || obj.overallStance || obj.overall);
  const items = Array.isArray(obj.reviews) ? obj.reviews : [obj];
  const reviews = [];
  let dropped = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      dropped += 1;
      continue;
    }
    const severity = normalizeSeverity(item.severity);
    const issue = strOrNull(item.issue || item.problem || item.description);
    const suggestion = strOrNull(item.suggestion || item.fix || item.recommendation);
    const stance = normalizeStance(item.stance) || overallStance;
    if (!severity || !issue || !suggestion || !stance) {
      dropped += 1;
      continue;
    }
    reviews.push({
      severity,
      dimension: strOrNull(item.dimension || item.category) || '其他',
      issue,
      evidence: strOrNull(item.evidence || item.quote || item.reference),
      suggestion,
      stance,
    });
  }
  return { parsed: true, reviews, dropped, overallStance };
}

/* ---------------------------------- Moderator convergence ---------------------------------- */

/**
 * `{"consensus":[…],"openIssues":[…],"conflicts":[{topic,sides:[{reviewer,view}]}],
 *   "revisionDirectives":[…]}`
 *
 * `convergenceScore` is deliberately **not read** even if a model volunteers one: the score is computed
 * by convergence.js from the reviews and this conflict list.
 *
 * @param {string} text
 * @returns {{parsed:boolean, consensus:string[], openIssues:string[],
 *            conflicts:Array<{topic:string,sides:Array<{reviewer:string,view:string}>}>,
 *            revisionDirectives:string[], dropped:number}}
 */
function parseModerationBlock(text) {
  const s = String(text == null ? '' : text);
  const empty = {
    parsed: false,
    consensus: [],
    openIssues: [],
    conflicts: [],
    revisionDirectives: [],
    dropped: 0,
  };
  if (!s.trim()) return empty;
  const obj = lastJsonBlock(
    s,
    (o) =>
      'consensus' in o ||
      'openIssues' in o ||
      'open_issues' in o ||
      'conflicts' in o ||
      'revisionDirectives' in o ||
      'directives' in o
  );
  if (!obj) return empty;

  const conflicts = [];
  let dropped = 0;
  if (Array.isArray(obj.conflicts)) {
    for (const c of obj.conflicts) {
      if (!c || typeof c !== 'object') {
        dropped += 1;
        continue;
      }
      const topic = strOrNull(c.topic || c.issue);
      const sides = [];
      if (Array.isArray(c.sides)) {
        for (const side of c.sides) {
          if (!side || typeof side !== 'object') continue;
          const reviewer = strOrNull(side.reviewer || side.floor || side.from);
          const view = strOrNull(side.view || side.opinion || side.stance);
          if (reviewer && view) sides.push({ reviewer, view });
        }
      }
      if (!topic || !sides.length) {
        dropped += 1;
        continue;
      }
      conflicts.push({ topic, sides });
    }
  }

  return {
    parsed: true,
    consensus: strList(obj.consensus),
    openIssues: strList(obj.openIssues || obj.open_issues),
    conflicts,
    revisionDirectives: directiveList(obj.revisionDirectives || obj.directives),
    dropped,
  };
}

/* ---------------------------------- Final adjudication ---------------------------------- */

/**
 * `{"decision":"approve|approve_with_changes|reject","summary":"…",
 *   "remainingRisks":[…],"finalDirectives":[…]}`
 *
 * @param {string} text
 * @returns {{parsed:boolean, decision:string|null, summary:string|null,
 *            remainingRisks:string[], finalDirectives:string[]}}
 */
function parseAdjudicationBlock(text) {
  const s = String(text == null ? '' : text);
  const empty = { parsed: false, decision: null, summary: null, remainingRisks: [], finalDirectives: [] };
  if (!s.trim()) return empty;
  // Accept the documented aliases too; otherwise a block using only `verdict`/`risks` is not even
  // recognized as an adjudication and the final phase is reported as unparsed.
  const obj = lastJsonBlock(
    s,
    (o) =>
      'decision' in o ||
      'verdict' in o ||
      'summary' in o ||
      'conclusion' in o ||
      'remainingRisks' in o ||
      'risks' in o ||
      'finalDirectives' in o ||
      'directives' in o
  );
  if (!obj) return empty;
  return {
    parsed: true,
    decision: normalizeDecision(obj.decision || obj.verdict),
    summary: strOrNull(obj.summary || obj.conclusion),
    remainingRisks: strList(obj.remainingRisks || obj.risks),
    finalDirectives: directiveList(obj.finalDirectives || obj.directives),
  };
}

/* ---------------------------------- Final draft ---------------------------------- */

const FINAL_KEYS = ['changeNotes', 'addressed', 'content', 'finalDraft'];

/**
 * @param {string} text
 * @returns {{parsed:boolean, content:string, changeNotes:string|null,
 *            addressed:Array<{directive:string, how:string|null}>}}
 */
function parseFinalBlock(text) {
  const s = String(text == null ? '' : text);
  const chunk = s.trim() ? findLastJsonChunk(s, (o) => FINAL_KEYS.some((k) => k in o)) : null;
  if (!chunk) return { parsed: false, content: s.trim(), changeNotes: null, addressed: [] };
  const obj = chunk.obj;
  const inline = strOrNull(obj.content || obj.finalDraft);
  return {
    parsed: true,
    content: inline || bodyWithoutChunk(s, chunk),
    changeNotes: strOrNull(obj.changeNotes || obj.changes),
    addressed: addressedList(obj.addressed),
  };
}

module.exports = {
  findLastJsonChunk,
  lastJsonBlock,
  extractBalanced,
  normalizeSeverity,
  normalizeStance,
  normalizeDecision,
  parsePlanBlock,
  parseProposalBlock,
  parseReviewBlock,
  parseModerationBlock,
  parseAdjudicationBlock,
  parseFinalBlock,
};
