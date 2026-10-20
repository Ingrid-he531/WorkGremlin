'use strict';

/**
 * The council room's prompts — pure functions, no IO (material content is read by the caller and passed
 * in).
 *
 * Roles:
 *   · moderator — round 0 topic decomposition + review assignment, every round's convergence result,
 *                 and the final adjudication. The moderator **must not smooth over disagreements**:
 *                 every blocker/major gets a hard directive in a fixed format.
 *   · main      — writes the proposal, revises it under the directives, and writes the final draft.
 *   · reviewer  — independent structured review points; in later rounds it must first check whether the
 *                 previous round's directives were actually implemented.
 *
 * Every participant is **read-only** (see agents.js): it can read and search the working directory, but
 * cannot write, run commands, or reach the network. The final report is written by the server, not by a
 * participant.
 *
 * The output protocol must be pinned down, and the examples carry their own fences: models imitate the
 * format in the prompt far more reliably than they follow prose instructions. The parser takes the
 * **last** matching JSON block (parse.js), so an example in the middle of the prompt is never mistaken
 * for the answer.
 */

const { DEFAULTS } = require('@workgremlin/shared');

const ROLE_ZH = Object.freeze({
  moderator: '主持人',
  main: '主答',
  reviewer: '评审',
});

/** Materials joined into one block; truncation is always stated (the reader must know it is incomplete). */
function renderMaterials(materials) {
  const list = Array.isArray(materials) ? materials : [];
  if (!list.length) return '';
  const blocks = list.map((m) => {
    const head =
      `--- ${m.path}` +
      (m.truncated
        ? `（**已截断**：原始 ${m.bytesTotal} 字节，这里只给了前 ${m.bytesIncluded} 字节）`
        : m.bytesTotal != null
          ? `（${m.bytesTotal} 字节）`
          : '');
    return `${head} ---\n${m.content == null ? '（读不到内容）' : m.content}`;
  });
  return blocks.join('\n\n');
}

/**
 * The "who you are and what you cannot do" block. Carried every turn so it cannot be forgotten over a
 * long meeting.
 *
 * The opening sentence carries COUNCIL_PROMPT_MARKER on purpose: 2F Cline stores the prompt itself as
 * the session title and has no `--title` switch, so this phrase is how floorCline.js recognizes (and
 * skips) a council participant. Do not reword it away from the marker.
 *
 * @param {string} floorId
 * @param {string} floorName
 * @param {'moderator'|'main'|'reviewer'} role
 * @param {string} [workspace]
 * @param {boolean} [workspaceProvided]
 */
function roleBlock(floorId, floorName, role, workspace, workspaceProvided) {
  const roleZh = ROLE_ZH[role] || '参与者';
  const hasWorkspace = workspaceProvided !== false && Boolean(String(workspace || '').trim());
  const workspaceLines = hasWorkspace
    ? [
        `你正在 \`${workspace}\` 这个用户提供的项目目录里，可以用**只读**工具自己去翻代码（读文件、按名字或内容搜索）。`,
        '你看到的就是这个项目真实的当前代码 —— 拿不准的事就去读；读了仍然不确定，就直说不确定，不要凭印象编造。',
      ]
    : [
        '本次没有提供用户工程目录，你是在一个临时隔离目录中运行；这个临时目录不是用户项目，里面的内容不能作为项目证据。',
        '纯文字议题可以直接作答。只有议题必须检查代码、而现有材料又不足以回答时，才需要要求用户补充项目绝对路径。',
      ];
  return [
    `你是 ${DEFAULTS.COUNCIL_PROMPT_MARKER}里【${floorId} ${floorName}】这一层的代表，角色是${roleZh}，正在参加一场有主持、有主答、有评审的多轮评审。`,
    '',
    ...workspaceLines,
    '除此之外你什么都做不了：**不能修改任何文件、不能执行命令、不能上网、看不到对方的机器**。',
  ].join('\n');
}

/** Shared context: topic, working directory, materials. */
function contextBlock(arg) {
  const parts = ['【议题】', String(arg.topic || '').trim()];
  if (arg.workspaceProvided !== false && arg.workspace) {
    parts.push('', '【用户提供的项目目录】', String(arg.workspace));
  }
  const mats = renderMaterials(arg.materials);
  if (mats) parts.push('', '【背景材料】', mats);
  return parts.join('\n');
}

/* ---------------------------------- rendering helpers ---------------------------------- */

/** @param {Array<{floorId:string, floorName?:string, role?:string, focus?:string}>} reviewers */
function renderReviewers(reviewers) {
  const list = Array.isArray(reviewers) ? reviewers : [];
  if (!list.length) return '（没有评审）';
  return list
    .map((r) => `- ${r.floorId}${r.floorName ? ` ${r.floorName}` : ''}${r.focus ? `：${r.focus}` : ''}`)
    .join('\n');
}

/** @param {object|null} plan parsed plan (`parsePlanBlock`) */
function renderPlan(plan) {
  if (!plan) return '';
  const parts = [];
  if (plan.breakdown && plan.breakdown.length) {
    parts.push('【议题拆解】', plan.breakdown.map((x, i) => `${i + 1}. ${x}`).join('\n'));
  }
  if (plan.assignments && plan.assignments.length) {
    parts.push(
      '',
      '【评审分工】',
      plan.assignments
        .map((a) => `- ${a.reviewer}${a.focus ? `：${a.focus}` : ''}`)
        .join('\n')
    );
  }
  if (plan.reviewFocus && plan.reviewFocus.length) {
    parts.push('', '【重点审查方向】', plan.reviewFocus.map((x) => `- ${x}`).join('\n'));
  }
  return parts.join('\n');
}

/** @param {Array<{severity:string, dimension:string, issue:string, evidence?:string, suggestion:string, stance:string}>} reviews */
function renderReviews(reviews) {
  const list = Array.isArray(reviews) ? reviews : [];
  if (!list.length) return '（本轮没有任何评审意见）';
  return list
    .map((r, i) => {
      const evidence = r.evidence ? `\n  证据：${r.evidence}` : '';
      return `${i + 1}. [${r.severity}][${r.dimension}] ${r.issue}${evidence}\n  建议：${r.suggestion}（立场：${r.stance}）`;
    })
    .join('\n');
}

/** @param {string[]} directives */
function renderDirectives(directives) {
  const list = Array.isArray(directives) ? directives : [];
  if (!list.length) return '（没有任何修改指令）';
  return list.map((d, i) => `${i + 1}. ${d}`).join('\n');
}

/** Compact rendering of completed rounds for the final phase. */
function renderPreviousRounds(rounds) {
  const list = Array.isArray(rounds) ? rounds : [];
  if (!list.length) return '';
  return list
    .map((r) => {
      const s = r.stats || {};
      const b = (s.bySeverity && s.bySeverity.blocker) || 0;
      const ma = (s.bySeverity && s.bySeverity.major) || 0;
      const mi = (s.bySeverity && s.bySeverity.minor) || 0;
      const lines = [
        `### 第 ${r.round} 轮（${r.proposal && r.proposal.version ? r.proposal.version : '—'}）`,
        `方案变更：${(r.proposal && r.proposal.diffFromPrev) || '（无变更说明）'}`,
        `评审统计：blocker ${b}、major ${ma}、minor ${mi}；冲突 ${s.conflicts || 0}；收敛度 ${s.score != null ? s.score : '—'}`,
      ];
      if (r.moderator) {
        if (r.moderator.consensus && r.moderator.consensus.length) {
          lines.push(`共识：${r.moderator.consensus.join('；')}`);
        }
        if (r.moderator.openIssues && r.moderator.openIssues.length) {
          lines.push(`未决：${r.moderator.openIssues.join('；')}`);
        }
        if (r.moderator.conflicts && r.moderator.conflicts.length) {
          lines.push(
            `冲突：${r.moderator.conflicts
              .map((c) => `${c.topic}（${c.sides.map((x) => `${x.reviewer}:${x.view}`).join(' vs ')}）`)
              .join('；')}`
          );
        }
        lines.push(`修改指令：\n${renderDirectives(r.moderator.revisionDirectives)}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/* ---------------------------------- protocols ---------------------------------- */

const PLAN_PROTOCOL = [
  '【本轮怎么回】',
  '0. 如果现有信息不足以拆解议题（例如必须检查代码但未提供项目路径、关键材料缺失、目标有歧义），不要猜路径，也不要假装能开始评审。只返回下面这个 JSON 代码块：',
  '',
  '```json',
  '{"needsClarification":["具体、可以直接回答的补充信息问题"]}',
  '```',
  '',
  '问题必须具体到用户能直接回答，例如“请给出需要评审的项目绝对路径”或“请说明要兼容的 Node.js 最低版本”；不要写“请提供更多信息”这种空泛问题。纯文字议题不需要项目目录，不要仅因为未提供目录而索要路径。',
  '',
  '1. 先把议题拆成 3~6 个可独立回答的子问题，并给每位评审分配审查重点。',
  '2. 然后在**最后**附一个 JSON 代码块，格式必须是这样：',
  '',
  '```json',
  '{"breakdown":["子问题 1","子问题 2"],"assignments":[{"reviewer":"4F","focus":"负责审查哪一部分"}],"reviewFocus":["所有评审都要注意的共同风险"]}',
  '```',
  '',
  'reviewer 必须使用给定的楼层编号，不要自创角色；每个评审都要有明确分工。',
].join('\n');

const PROPOSAL_PROTOCOL = [
  '【本轮怎么回】',
  '1. 正文直接写**完整方案**（Markdown），不是只写改动片段。方案必须能独立阅读。',
  '2. 然后在**最后**附一个 JSON 代码块：',
  '',
  '```json',
  '{"version":"v2","diffFromPrev":"相比上一版改了哪几处，逐条写","addressed":[{"directive":"上轮指令原文","how":"你在哪一节、怎么落实的"}]}',
  '```',
  '',
  '3. 上一轮主持人给出的每一条修改指令都**必须**落实；确实不能落实的，要在正文里说明理由，不能悄悄跳过。',
  '4. 不要自由发挥去改指令之外的大结构；如果指令之间互相冲突，在正文里指出并选择一条，同时说明理由。',
].join('\n');

const REVIEW_PROTOCOL = [
  '【本轮怎么回】',
  '1. 先写你的审查过程（可以引用方案章节、代码位置、材料原文）。',
  '2. 然后在**最后**附一个 JSON 代码块，列出**每一条**独立的审查意见：',
  '',
  '```json',
  '{"reviews":[{"severity":"blocker","dimension":"安全","issue":"问题是什么","evidence":"方案 3.2 节原文 / 代码行 / 材料","suggestion":"具体怎么改","stance":"reject"}],"stance":"revise"}',
  '```',
  '',
  'severity 只能是 blocker / major / minor / nit：',
  '- blocker：不修就不能继续，通常是正确性、安全、会导致方案失败的问题；',
  '- major：本轮必须修，否则不能收敛；',
  '- minor：应该修，但可以排到后面；',
  '- nit：纯风格问题，不影响结论。',
  '',
  `dimension 建议使用：${DEFAULTS.COUNCIL_DIMENSIONS.join(' / ')}。`,
  'stance 只能是 reject（反对当前方案）/ revise（方向可以但要改）/ accept（接受当前方案）。',
  '没有问题时写 `{"reviews":[],"stance":"accept"}`；不要为了凑数编问题，也不要因为别人都接受就跟着接受。',
  '**上轮指令核验**：如果上一轮有修改指令，先逐条检查是否真的落实；没落实的，按 blocker 或 major 记录，并在 evidence 里引用指令原文。',
].join('\n');

const MODERATION_PROTOCOL = [
  '【本轮怎么回】',
  '1. 先逐条判断评审意见是否成立，再汇总本轮结果。',
  '2. 然后在**最后**附一个 JSON 代码块：',
  '',
  '```json',
  '{"consensus":["已经达成一致的点"],"openIssues":["仍未解决的问题"],"conflicts":[{"topic":"争议点","sides":[{"reviewer":"4F","view":"一方观点"},{"reviewer":"7F","view":"另一方观点"}]}],"revisionDirectives":["【针对 <问题>】必须 <具体改动>；验收标准：<可核对的条件>。"]}',
  '```',
  '',
  '**硬性要求（不许和稀泥）：**',
  '- 每一条 blocker 和 major 都必须有对应的修改指令；不能只在 openIssues 里写一句"建议关注"。',
  '- 修改指令必须使用固定格式：【针对 <问题>】必须 <具体改动>；验收标准：<可核对的条件>。',
  '- 禁止使用"建议 / 可以考虑 / 酌情 / 视情况 / 进一步优化 / 尽量"等模糊措辞。',
  '- 评审之间确实存在对立观点时，必须写进 conflicts，不能写成"大家基本同意"。',
  '- consensus 只写**真正达成一致**的点；没有一致就写 []，不要凑。',
  '- **不要输出收敛度分数**：服务端会按固定公式计算，你的分数不会被采用。',
].join('\n');

const ADJUDICATION_PROTOCOL = [
  '【最终裁决怎么回】',
  '1. 先给出裁决理由：哪些 blocker 已经解决、哪些风险仍然存在。',
  '2. 然后在**最后**附一个 JSON 代码块：',
  '',
  '```json',
  '{"decision":"approve","summary":"一两句话说明裁决","remainingRisks":["仍然存在的风险"],"finalDirectives":["交给主答的最终要求"]}',
  '```',
  '',
  'decision 只能是 approve / approve_with_changes / reject。',
  '如果最后一轮仍有 blocker，**不能**给 approve；只能 approve_with_changes 或 reject。',
  'remainingRisks 只写真实存在的风险；没有就写 []。',
].join('\n');

const FINAL_PROTOCOL = [
  '【最终稿怎么回】',
  '1. 正文直接写**最终交付稿**（Markdown），必须完整、可直接使用，不能留 TODO 或占位符。',
  '2. 然后在**最后**附一个 JSON 代码块：',
  '',
  '```json',
  '{"changeNotes":"相对上一版改了什么、为什么改","addressed":[{"directive":"裁决要求原文","how":"最终稿在哪里落实"}]}',
  '```',
  '',
  '裁决里的每一条 finalDirectives 都必须落实；不能落实的必须在 changeNotes 里说明理由。',
].join('\n');

/* ---------------------------------- prompt builders ---------------------------------- */

/**
 * Round 0 — moderator decomposes the topic and assigns review focus.
 * @param {{topic:string, materials:Array, workspace?:string|null, workspaceProvided?:boolean,
 *          floorId:string, floorName:string,
 *          reviewers:Array<{floorId:string, floorName?:string}>}} arg
 */
function buildPlanPrompt(arg) {
  return [
    roleBlock(arg.floorId, arg.floorName, 'moderator', arg.workspace, arg.workspaceProvided),
    '',
    contextBlock(arg),
    '',
    '【你的任务：议题拆解与评审分工】',
    '你是主持人，不写方案。请把议题拆开，并给每位评审分配明确的审查重点。',
    '',
    '【评审名单】',
    renderReviewers(arg.reviewers),
    '',
    PLAN_PROTOCOL,
  ].join('\n');
}

/**
 * Proposal turn for the main answerer.
 * @param {{topic:string, materials:Array, workspace?:string|null, workspaceProvided?:boolean,
 *          floorId:string, floorName:string,
 *          roundNo:number, maxRounds:number, plan:object|null, previousRounds:Array,
 *          directives:string[], priorProposal?:{version:string, diffFromPrev?:string}|null}} arg
 */
function buildProposalPrompt(arg) {
  const first = arg.roundNo === 1;
  const parts = [
    roleBlock(arg.floorId, arg.floorName, 'main', arg.workspace, arg.workspaceProvided),
    '',
    contextBlock(arg),
    '',
    `【第 ${arg.roundNo}/${arg.maxRounds} 轮：主答${first ? '初稿' : '修订'}】`,
  ];
  const plan = renderPlan(arg.plan);
  if (plan) parts.push('', plan);

  if (first) {
    parts.push(
      '',
      '这是第一版方案。请按议题拆解逐项给出可执行的设计，明确取舍和风险；不要写成泛泛而谈的原则。'
    );
  } else {
    if (arg.priorProposal) {
      parts.push('', `【上一版：${arg.priorProposal.version}】`, arg.priorProposal.diffFromPrev || '（没有变更说明）');
    }
    parts.push(
      '',
      '【主持人上一轮给出的修改指令 —— 必须逐条落实】',
      renderDirectives(arg.directives),
      '',
      '你的修订稿必须覆盖每一条指令。不要只改措辞；改完后在 diffFromPrev 里逐条说明改动位置。'
    );
  }

  const history = renderPreviousRounds(arg.previousRounds);
  if (history) parts.push('', '【之前各轮记录】', history);

  parts.push('', PROPOSAL_PROTOCOL);
  return parts.join('\n');
}

/**
 * Review turn for one reviewer.
 * @param {{topic:string, materials:Array, workspace?:string|null, workspaceProvided?:boolean,
 *          floorId:string, floorName:string,
 *          roundNo:number, maxRounds:number, plan:object|null,
 *          proposal:{version:string, content:string, diffFromPrev?:string},
 *          previousDirectives:string[], previousProposal?:object|null}} arg
 */
function buildReviewPrompt(arg) {
  const parts = [
    roleBlock(arg.floorId, arg.floorName, 'reviewer', arg.workspace, arg.workspaceProvided),
    '',
    contextBlock(arg),
    '',
    `【第 ${arg.roundNo}/${arg.maxRounds} 轮：独立评审】`,
  ];
  const plan = renderPlan(arg.plan);
  if (plan) parts.push('', plan);

  parts.push(
    '',
    `【待评审方案：${arg.proposal.version || '当前版本'}】`,
    String(arg.proposal.content || '').trim()
  );
  if (arg.proposal.diffFromPrev) {
    parts.push('', '【主答声称的变更】', String(arg.proposal.diffFromPrev));
  }

  if (arg.roundNo > 1) {
    parts.push(
      '',
      '【上一轮主持人的修改指令 —— 你要先核验是否落实】',
      renderDirectives(arg.previousDirectives)
    );
    if (arg.previousProposal) {
      parts.push(
        '',
        `【上一版方案（${arg.previousProposal.version || '上一版'}，供对比）】`,
        String(arg.previousProposal.content || '').trim()
      );
    }
  }

  parts.push(
    '',
    '你是独立评审：不要因为别的评审已经表态就跟着走，也不要把"没意见"当成默认答案。',
    '指出问题必须给出证据（方案原文、代码位置、材料内容）；没有证据就明确说这是推测。',
    '',
    REVIEW_PROTOCOL
  );
  return parts.join('\n');
}

/**
 * Convergence turn for the moderator.
 * @param {{topic:string, materials:Array, workspace?:string|null, workspaceProvided?:boolean,
 *          floorId:string, floorName:string,
 *          roundNo:number, maxRounds:number, plan:object|null,
 *          proposal:{version:string, content:string, diffFromPrev?:string},
 *          reviews:Array, previousDirectives:string[]}} arg
 */
function buildModerationPrompt(arg) {
  return [
    roleBlock(arg.floorId, arg.floorName, 'moderator', arg.workspace, arg.workspaceProvided),
    '',
    contextBlock(arg),
    '',
    `【第 ${arg.roundNo}/${arg.maxRounds} 轮：收敛汇总】`,
    '',
    renderPlan(arg.plan) || '（本轮没有拆解记录）',
    '',
    `【本轮方案：${arg.proposal.version || '当前版本'}】`,
    String(arg.proposal.content || '').trim(),
    arg.proposal.diffFromPrev ? `\n【主答声称的变更】\n${arg.proposal.diffFromPrev}` : '',
    '',
    '【本轮全部评审意见】',
    renderReviews(arg.reviews),
    '',
    '【上一轮修改指令（用于检查是否落实）】',
    renderDirectives(arg.previousDirectives),
    '',
    MODERATION_PROTOCOL,
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/**
 * Final adjudication by the moderator.
 * @param {{topic:string, materials:Array, workspace?:string|null, workspaceProvided?:boolean,
 *          floorId:string, floorName:string,
 *          maxRounds:number, rounds:Array, proposal:{version:string, content:string},
 *          reviews:Array, lastModeration:object|null}} arg
 */
function buildAdjudicationPrompt(arg) {
  return [
    roleBlock(arg.floorId, arg.floorName, 'moderator', arg.workspace, arg.workspaceProvided),
    '',
    contextBlock(arg),
    '',
    '【最终裁决】',
    `全部 ${arg.maxRounds} 轮评审已经结束。请根据完整过程做最终裁决。`,
    '',
    '【最后一版方案】',
    String(arg.proposal.content || '').trim(),
    '',
    '【最后一轮评审意见】',
    renderReviews(arg.reviews),
    '',
    '【最后一轮主持人汇总】',
    renderDirectives(
      arg.lastModeration && arg.lastModeration.revisionDirectives
        ? arg.lastModeration.revisionDirectives
        : []
    ),
    '',
    '【各轮记录】',
    renderPreviousRounds(arg.rounds),
    '',
    ADJUDICATION_PROTOCOL,
  ].join('\n');
}

/**
 * Final draft by the main answerer.
 * @param {{topic:string, materials:Array, workspace?:string|null, workspaceProvided?:boolean,
 *          floorId:string, floorName:string,
 *          proposal:{version:string, content:string}, adjudication:object|null,
 *          lastReviews:Array, rounds:Array}} arg
 */
function buildFinalDraftPrompt(arg) {
  const adj = arg.adjudication || {};
  return [
    roleBlock(arg.floorId, arg.floorName, 'main', arg.workspace, arg.workspaceProvided),
    '',
    contextBlock(arg),
    '',
    '【最终交付稿】',
    '评审流程已经结束。请根据最后一版方案和主持人裁决，写出最终交付稿。',
    '',
    '【最后一版方案】',
    String(arg.proposal.content || '').trim(),
    '',
    '【主持人最终裁决】',
    adj.summary ? String(adj.summary) : '（没有裁决摘要）',
    '',
    '【最终要求】',
    renderDirectives(adj.finalDirectives || []),
    '',
    '【仍然存在的风险】',
    (adj.remainingRisks && adj.remainingRisks.length
      ? adj.remainingRisks.map((x) => `- ${x}`).join('\n')
      : '（没有列出）'),
    '',
    '【最后一轮评审意见】',
    renderReviews(arg.lastReviews),
    '',
    FINAL_PROTOCOL,
  ].join('\n');
}

/**
 * Text for the server-rendered topic statement. This turn does not call a model; it is recorded so the
 * timeline starts from "what the topic is".
 */
function buildBriefText(topic, materials) {
  const mats = renderMaterials(materials);
  return mats ? `${String(topic || '').trim()}\n\n【背景材料】\n${mats}` : String(topic || '').trim();
}

module.exports = {
  ROLE_ZH,
  PLAN_PROTOCOL,
  PROPOSAL_PROTOCOL,
  REVIEW_PROTOCOL,
  MODERATION_PROTOCOL,
  ADJUDICATION_PROTOCOL,
  FINAL_PROTOCOL,
  roleBlock,
  renderMaterials,
  renderReviews,
  renderDirectives,
  renderPlan,
  renderPreviousRounds,
  buildPlanPrompt,
  buildProposalPrompt,
  buildReviewPrompt,
  buildModerationPrompt,
  buildAdjudicationPrompt,
  buildFinalDraftPrompt,
  buildBriefText,
};
