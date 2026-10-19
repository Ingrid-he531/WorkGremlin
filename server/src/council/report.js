'use strict';

/**
 * Final council archive: build the machine-readable report and write the export files.
 *
 * Files (per call, into `~/.workgremlin/councils/<id>/` only):
 *   report.json  — the complete archive (plan, every RoundResult, adjudication, final draft, warnings)
 *   reviews.csv  — one ReviewPoint per row, for spreadsheets / issue tracking
 *   rounds.csv   — one row per round with severity counts, conflicts, and the server-computed score
 *   report.md    — the human-readable document
 *
 * Rules:
 *   · CSV is UTF-8 **with BOM** so Excel opens Chinese text correctly.
 *   · Writes are atomic (temp file + rename) and **never overwrite** an existing export: a second run
 *     gets a timestamp suffix. Council exports are evidence; silently replacing them is not allowed.
 *   · The archive lives under the WorkGremlin home directory only. Nothing is written into the user's
 *     workspace, even when one was supplied for the participants to read.
 */

const fs = require('node:fs');
const path = require('node:path');

const { councilReportDir } = require('@workgremlin/shared/paths');
const { SCORE_MAX, WEIGHTS, CONFLICT_WEIGHT, scoreFormula } = require('./convergence');

const REPORT_SCHEMA = 'workgremlin.council.report/v1';

/* ---------------------------------- token aggregation ---------------------------------- */

/**
 * Sum one participant's usage across all of its turns.
 *
 * `null` means "not reported" and is never treated as 0. If some turns reported usage and others did
 * not, the sum is a lower bound: `exact=false`, and the UI/export prints `≥ N`. If nothing was reported,
 * `total` stays null and the UI prints `—`.
 *
 * @param {Array<{input_tokens:number|null, output_tokens:number|null,
 *                cache_read_tokens:number|null, cache_write_tokens:number|null}>} utterances
 */
function aggregateTokens(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let seen = 0;
  let missing = 0;
  for (const u of list) {
    if (!u) continue;
    const hasInput = typeof u.input_tokens === 'number';
    const hasOutput = typeof u.output_tokens === 'number';
    if (!hasInput && !hasOutput) {
      missing += 1;
      continue;
    }
    seen += 1;
    if (hasInput) sums.input += u.input_tokens;
    if (hasOutput) sums.output += u.output_tokens;
    if (typeof u.cache_read_tokens === 'number') sums.cacheRead += u.cache_read_tokens;
    if (typeof u.cache_write_tokens === 'number') sums.cacheWrite += u.cache_write_tokens;
    // A turn with only one half is still a partial reading: the missing half contributes an unknown
    // amount, so the total is a lower bound even though something was reported.
    if (!hasInput || !hasOutput) missing += 1;
  }
  if (!seen) {
    return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, exact: false };
  }
  return {
    input: sums.input,
    output: sums.output,
    cacheRead: sums.cacheRead,
    cacheWrite: sums.cacheWrite,
    total: sums.input + sums.output,
    exact: missing === 0,
  };
}

/** Latest non-null model id reported by any of this floor's turns. */
function modelOfUtterances(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].model) return list[i].model;
  }
  return null;
}

/* ---------------------------------- report model ---------------------------------- */

/**
 * @param {{council:object, participants:Array, utterances:Array, rounds:Array, reviews:Array,
 *          plan:object|null, adjudication:object|null, finalDraft:object|null,
 *          finalScore:object|null, warnings:Array}} arg
 *   `rounds` are already assembled RoundResult objects (with a `stats` field).
 */
function buildReportJson(arg) {
  const council = arg.council || {};
  const rounds = Array.isArray(arg.rounds) ? arg.rounds : [];
  const reviews = Array.isArray(arg.reviews) ? arg.reviews : [];
  const utterances = Array.isArray(arg.utterances) ? arg.utterances : [];
  const participants = Array.isArray(arg.participants) ? arg.participants : [];

  const last = rounds.length ? rounds[rounds.length - 1] : null;
  const stats = (last && last.stats) || null;

  const roles = participants.map((p) => {
    const mine = utterances.filter((u) => u && u.floor_id === p.floor_id);
    return {
      floor: p.floor_id,
      role: p.role,
      agent: p.agent,
      status: p.status,
      model: modelOfUtterances(mine),
      tokens: aggregateTokens(mine),
    };
  });

  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    council: {
      id: council.id,
      topic: council.topic,
      workspacePath: council.workspace_path != null ? council.workspace_path : null,
      status: council.status,
      verdict: council.verdict != null ? council.verdict : null,
      maxRounds: council.max_rounds,
      roundsCompleted: rounds.length,
      createdAt: council.created_at != null ? council.created_at : null,
      startedAt: council.started_at != null ? council.started_at : null,
      endedAt: council.ended_at != null ? council.ended_at : null,
      error: council.error != null ? council.error : null,
    },
    score: {
      final: arg.finalScore && typeof arg.finalScore.score === 'number' ? arg.finalScore.score : null,
      max: SCORE_MAX,
      formula: stats ? scoreFormula(stats) : null,
      weights: { ...WEIGHTS },
      conflictWeight: CONFLICT_WEIGHT,
      trend: rounds
        .filter((r) => r && r.stats && typeof r.stats.score === 'number')
        .map((r) => ({ round: r.round, score: r.stats.score })),
    },
    summary: {
      rounds: rounds.length,
      reviewCount: reviews.length,
      blockers: stats && stats.bySeverity ? stats.bySeverity.blocker : 0,
      majors: stats && stats.bySeverity ? stats.bySeverity.major : 0,
      minors: stats && stats.bySeverity ? stats.bySeverity.minor : 0,
      nits: stats && stats.bySeverity ? stats.bySeverity.nit : 0,
      conflicts: stats ? stats.conflicts : 0,
      warnings: Array.isArray(arg.warnings) ? arg.warnings : [],
    },
    roles,
    plan: arg.plan || null,
    rounds,
    adjudication: arg.adjudication || null,
    finalDraft: arg.finalDraft || null,
    files: [],
  };
}

/* ---------------------------------- CSV ---------------------------------- */

function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function reviewsCsv(reviews) {
  const rows = (Array.isArray(reviews) ? reviews : []).map((r) => [
    r.round_no,
    r.reviewer,
    r.severity,
    r.dimension,
    r.issue,
    r.evidence,
    r.suggestion,
    r.stance,
  ]);
  return toCsv(
    ['round', 'reviewer', 'severity', 'dimension', 'issue', 'evidence', 'suggestion', 'stance'],
    rows
  );
}

function roundsCsv(rounds) {
  const rows = (Array.isArray(rounds) ? rounds : []).map((r) => {
    const s = r.stats || {};
    const b = (s.bySeverity && s.bySeverity.blocker) || 0;
    const ma = (s.bySeverity && s.bySeverity.major) || 0;
    const mi = (s.bySeverity && s.bySeverity.minor) || 0;
    const ni = (s.bySeverity && s.bySeverity.nit) || 0;
    return [
      r.round,
      r.proposal && r.proposal.version,
      b,
      ma,
      mi,
      ni,
      s.conflicts || 0,
      s.score != null ? s.score : '',
      s.deduction != null ? s.deduction : '',
      ((r.moderator && r.moderator.openIssues) || []).join('；'),
      ((r.moderator && r.moderator.revisionDirectives) || []).join('；'),
      r.proposal && r.proposal.diffFromPrev,
    ];
  });
  return toCsv(
    [
      'round',
      'version',
      'blocker',
      'major',
      'minor',
      'nit',
      'conflicts',
      'score',
      'deduction',
      'open_issues',
      'revision_directives',
      'proposal_diff',
    ],
    rows
  );
}

/* ---------------------------------- Markdown ---------------------------------- */

function bulletList(list, empty = '（无）') {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  return arr.length ? arr.map((x) => `- ${x}`).join('\n') : empty;
}

function tokenLine(tokens) {
  if (!tokens || tokens.total == null) return '—';
  const prefix = tokens.exact ? '' : '≥ ';
  const parts = [`${prefix}${tokens.total}`];
  if (tokens.input != null || tokens.output != null) {
    parts.push(`（输入 ${tokens.input != null ? tokens.input : '—'} / 输出 ${tokens.output != null ? tokens.output : '—'}）`);
  }
  return parts.join(' ');
}

function reportMarkdown(report) {
  const lines = [];
  lines.push(`# 议事厅报告：${report.council.topic}`, '');
  lines.push(`- 议事厅 ID：\`${report.council.id}\``);
  lines.push(`- 状态：${report.council.status}${report.council.verdict ? `（${report.council.verdict}）` : ''}`);
  lines.push(`- 轮次：${report.council.roundsCompleted}/${report.council.maxRounds}`);
  if (report.council.workspacePath) lines.push(`- 工作目录：\`${report.council.workspacePath}\``);
  lines.push('');

  lines.push('## 汇总', '');
  lines.push(`- 收敛度：**${report.score.final != null ? report.score.final : '—'} / ${report.score.max}**`);
  if (report.score.formula) lines.push(`- 计算公式：\`${report.score.formula}\``);
  lines.push(
    `- 评审意见：${report.summary.reviewCount} 条（blocker ${report.summary.blockers}、major ${report.summary.majors}、minor ${report.summary.minors}、nit ${report.summary.nits}）`
  );
  lines.push(`- 冲突：${report.summary.conflicts}`);
  if (report.score.trend.length) {
    lines.push(`- 收敛趋势：${report.score.trend.map((x) => `第 ${x.round} 轮 ${x.score}`).join(' → ')}`);
  }
  lines.push('');

  lines.push('## 参与角色', '');
  lines.push('| 楼层 | 角色 | Agent | 模型 | Token |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of report.roles) {
    lines.push(`| ${r.floor} | ${r.role} | ${r.agent} | ${r.model || '—'} | ${tokenLine(r.tokens)} |`);
  }
  lines.push('');

  if (report.summary.warnings.length) {
    lines.push('## 一致性提示', '');
    for (const w of report.summary.warnings) lines.push(`- ${w.message}`);
    lines.push('');
  }

  if (report.plan) {
    lines.push('## 议题拆解（第 0 轮）', '');
    lines.push(bulletList(report.plan.breakdown), '');
    if (report.plan.assignments && report.plan.assignments.length) {
      lines.push('评审分工：', '');
      for (const a of report.plan.assignments) lines.push(`- ${a.reviewer}${a.focus ? `：${a.focus}` : ''}`);
      lines.push('');
    }
  }

  for (const round of report.rounds) {
    lines.push(`## 第 ${round.round} 轮（${(round.proposal && round.proposal.version) || '—'}）`, '');
    if (round.proposal && round.proposal.diffFromPrev) {
      lines.push('**本轮变更**', '', round.proposal.diffFromPrev, '');
    }
    lines.push('### 方案', '', (round.proposal && round.proposal.content) || '（缺失）', '');
    lines.push('### 评审意见', '');
    if (!round.reviews || !round.reviews.length) {
      lines.push('（无）', '');
    } else {
      for (const r of round.reviews) {
        lines.push(`- **${r.severity}** / ${r.dimension} / ${r.reviewer}：${r.issue}`);
        if (r.evidence) lines.push(`  - 证据：${r.evidence}`);
        lines.push(`  - 建议：${r.suggestion}（立场：${r.stance}）`);
      }
      lines.push('');
    }
    const m = round.moderator || {};
    lines.push('### 主持人汇总', '');
    lines.push(`- 本轮收敛度：${round.stats ? round.stats.score : '—'}（${round.stats ? scoreFormula(round.stats) : '—'}）`);
    lines.push(`- 共识：${(m.consensus || []).join('；') || '（无）'}`);
    lines.push(`- 未决：${(m.openIssues || []).join('；') || '（无）'}`);
    if (m.conflicts && m.conflicts.length) {
      lines.push('- 冲突：');
      for (const c of m.conflicts) {
        lines.push(`  - ${c.topic}：${(c.sides || []).map((s) => `${s.reviewer} ${s.view}`).join(' / ')}`);
      }
    }
    lines.push(`- 修改指令：`);
    lines.push(bulletList(m.revisionDirectives));
    lines.push('');
  }

  if (report.adjudication) {
    lines.push('## 最终裁决', '');
    lines.push(`- 结论：${report.adjudication.decision || '—'}`);
    if (report.adjudication.summary) lines.push(`- 理由：${report.adjudication.summary}`);
    lines.push(`- 剩余风险：`);
    lines.push(bulletList(report.adjudication.remainingRisks));
    lines.push('- 最终要求：');
    lines.push(bulletList(report.adjudication.finalDirectives));
    lines.push('');
  }

  if (report.finalDraft && report.finalDraft.content) {
    lines.push('## 最终交付稿', '');
    lines.push(report.finalDraft.content, '');
    if (report.finalDraft.changeNotes) {
      lines.push('## 变更说明', '', report.finalDraft.changeNotes, '');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

/* ---------------------------------- writing ---------------------------------- */

function atomicWrite(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Never overwrite: an existing name gets `-<timestamp>` inserted before the extension. */
function uniquePath(dir, name, ext) {
  const first = path.join(dir, `${name}${ext}`);
  if (!fs.existsSync(first)) return first;
  return path.join(dir, `${name}-${stamp()}${ext}`);
}

/**
 * Write the four export files into one directory.
 * @returns {string[]} absolute file paths
 */
function writeToDir(dir, report) {
  const reviews = report.rounds.flatMap((r) =>
    (r.reviews || []).map((x) => ({
      round_no: r.round,
      reviewer: x.reviewer,
      severity: x.severity,
      dimension: x.dimension,
      issue: x.issue,
      evidence: x.evidence,
      suggestion: x.suggestion,
      stance: x.stance,
    }))
  );
  const files = [];
  const roundsFile = uniquePath(dir, 'rounds', '.csv');
  atomicWrite(roundsFile, roundsCsv(report.rounds));
  files.push(roundsFile);

  const reviewsFile = uniquePath(dir, 'reviews', '.csv');
  atomicWrite(reviewsFile, reviewsCsv(reviews));
  files.push(reviewsFile);

  const mdFile = uniquePath(dir, 'report', '.md');
  atomicWrite(mdFile, reportMarkdown(report));
  files.push(mdFile);

  // report.json is written last so it can list the files that actually landed.
  const jsonFile = uniquePath(dir, 'report', '.json');
  const withFiles = { ...report, files: [...files, jsonFile] };
  atomicWrite(jsonFile, `${JSON.stringify(withFiles, null, 2)}\n`);
  files.push(jsonFile);
  return files;
}

/**
 * Write the archive into the WorkGremlin home dir.
 *
 * The user's workspace is never written to — it is only something the participants read, and a
 * meeting must not leave files behind in the project it was asked to review.
 *
 * @param {{councilId:string, report:object}} arg
 * @returns {{files:string[]}}
 */
function writeCouncilReports(arg) {
  return { files: writeToDir(councilReportDir(arg.councilId), arg.report) };
}

module.exports = {
  REPORT_SCHEMA,
  aggregateTokens,
  modelOfUtterances,
  buildReportJson,
  reviewsCsv,
  roundsCsv,
  reportMarkdown,
  writeCouncilReports,
  atomicWrite,
  uniquePath,
};
