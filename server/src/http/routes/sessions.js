'use strict';

const express = require('express');
const { reporterMainPhase, freshestReporterWs, reporterStateMeta, readReporterDone } = require('../../sessions');
// 7F Kilo Code：Kilo 没有 hook 状态文件，相位/完成标记从它自己的 SQLite 推导
const { kiloMainPhase, readKiloDone, kiloInstrumented } = require('../../kilo');
// 8F OpenCode：**两路**——装了 WorkGremlin 插件时真相位走 reporter 状态文件，
// 没装（或还没写过）才退回轮询 opencode.db 的推导。形态与 7F 不同，理由见下面那段注释。
const { opencodeMainPhase, readOpencodeDone, opencodeInstrumented } = require('../../opencode');
const { clientBase } = require('@workgremlin/shared');

/**
 * 完成标记统一成 **reporter 形状**（`{ at, title, fileCount, files, sessionId }`）。
 *
 * 为什么必须转译：各产品的读取器（`kilo.js` / `opencode.js` 的 `read*Done`）返回的是
 * **会话表**形状 `{ doneAt, doneTitle, doneCount, doneFiles }`（那是 `sessionRegistry`
 * 铺会话行时展开用的），而渲染层读**快轮询**那份完成标记用的是 `fpDone.at` 与
 * `fpDone.sessionId`（见 `IsoOfficeView.vue` 的 `fastDoneAt` / `sameSession`）。
 * 两套字段名对不上：把会话表形状原样塞进响应，`fpDone.at` 恒为 undefined ——
 * 快轮询那份「任务完成」就永远不触发（会话表那份还在，所以现象是"切楼层/等 10 秒才亮"，
 * 很容易被误当成偶发）。本函数是这两套形状之间唯一的转换点。
 *
 * @param {{doneAt?:number,doneTitle?:string,doneCount?:number,doneFiles?:Array}|null} done
 * @param {string} sessionId 这份标记属于哪条会话（渲染层按它精确比对，不串味）
 * @param {string} [workspacePath]
 * @returns {{at:number,title:string,fileCount:number,files:Array,sessionId:string,workspacePath:string}|null}
 */
function toReporterDone(done, sessionId, workspacePath = '') {
  if (!done || !done.doneAt) return null;
  return {
    at: Number(done.doneAt) || 0,
    title: done.doneTitle || '',
    fileCount: Number(done.doneCount) || 0,
    files: Array.isArray(done.doneFiles) ? done.doneFiles : [],
    sessionId: String(sessionId || ''),
    workspacePath,
  };
}

/**
 * 楼层客户端串里有没有**这一路**。
 *
 * 渲染层传的是**整个楼层的 clients 串**（`sessions.selectedClients.join(',')`），合并楼层就是
 * 逗号串（7F `kilo,kilo-plugin`、8F `opencode,opencode-plugin`）。以前这里写的是
 * `clientBase(client) === 'kilo' | 'opencode'` —— clientBase 只剥单个 -plugin 后缀，
 * 逗号串永远不相等，于是这两条分支**整条不生效**：相位 / 模型 / 完成标记全空。
 * （实测 2026-09-28：8F 楼层加了 opencode-plugin 这一路之后，主控制台只剩"思考中"、没有内容。）
 */
function clientListHas(client, base) {
  return String(client || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((c) => clientBase(c) === base);
}

/**
 * 会话：全局活跃会话表（按楼层分组）。
 * 数据源是各智能体自己的落盘，跟当前打开的工程无关 —— 换工程的入口在
 * /api/v1/workspace，这里只负责"列出 / 选中哪个会话"。
 */
function createSessionsRouter({ workspace }) {
  const router = express.Router();

  router.get('/sessions', (req, res) => {
    const cur = workspace && workspace.current ? workspace.current() : {};
    res.json(
      snapshotSafe({
        workspacePath: cur.workspacePath || '',
        force: req.query.refresh === '1',
      })
    );
  });

  // 主控制台快轮询：直接返回 reporter hook 的上报相位（已映射成 UI 字段），
  // 渲染层 1.5s 拉一次，比 /sessions 的 10s 轮询新鲜，专供主 Agent 控制台的"操作"实时显示。
  router.get('/reporter-phase', (req, res) => {
    const cur = workspace && workspace.current ? workspace.current() : {};
    // 按楼层（客户端）取相位：同一工程里 Codex 与 CodeBuddy 同时跑时不能互相串味
    // client 可以是**逗号分隔的一串** —— 合并楼层（1F CodeBuddy = CLI + Plugin）一次要认两路
    // 上报身份，串里任意一个命中就算本层（匹配见 sessions.js 的 clientHit）。
    const client = String(req.query.client || '').trim().toLowerCase();
    // 轴 2（会话）：`?session=<session_id>` 只取那一条会话的相位/完成标记。
    // 一个楼层可以同时开多条会话（同一个 claude 开两个终端 / CLI + 插件混着跑），
    // 不给 session 就是老行为——同 client 里"谁最新显示谁"，多会话下会串味。
    const session = String(req.query.session || '').trim();
    // 跟随 reporter 真实活动的最新工程，而不是 office 手工"打开工程"记的那个
    const ws = freshestReporterWs(cur.workspacePath || '', client, session);

    // ---- 7F Kilo Code：两条路，按 client 分 ——
    //   · kilo-plugin（VS Code 扩展装了 WorkGremlin 插件）：**真相位优先、轮询兜底**
    //     （与 8F OpenCode 同一套模式：插件把相位/完成标记写成 reporter 状态文件，
    //     那是上报真值、不标 inferred，而且只有它能给「等待授权」—— Kilo 的 tool 状态
    //     实测也只有 completed / error / running，没有 pending，轮询同样推不出等授权）。
    //   · kilo（CLI / TUI，没装插件）：纯轮询，从它自己的 SQLite 推导（恒带 inferred）。
    // 两条路的响应形状完全一致，渲染层分不出也不需要分。
    if (clientListHas(client, 'kilo')) {
      const fallbackWs = ws || cur.workspacePath || '';
      // ---- 先问真相位：插件写的状态文件（与通用口径读的是同一份东西） ----
      //
      // **kilo 与 kilo-plugin 都要问**，不能只问后者：插件装在 CLI / TUI 上时，
      // resolveClient() 按环境变量判出来是 `kilo`（只有扩展那三个变量才是 kilo-plugin），
      // 而 CLI 一样会写状态文件、一样有「等待授权」。只认 kilo-plugin 的话，
      // "CLI 装了插件"这个组合的真相位会被整条忽略、反而显示轮询推出来的相位 ——
      // 装了插件反而更差。
      const rpTruth = reporterMainPhase(ws, client, session);
      const metaTruth = reporterStateMeta(ws, client, session);
      const useTruth = Boolean(rpTruth && rpTruth.phase);
      // ---- 兜底：轮询 kilo.db 的推导 ----
      const rpPoll = useTruth ? null : kiloMainPhase(fallbackWs, session);
      const rp = rpTruth && rpTruth.phase ? rpTruth : rpPoll;
      const phaseSessionId = String((rp && rp.sessionId) || metaTruth.sessionId || session || '');

      // 完成标记同理：插件那份带改动文件清单，轮询那份只有计数 —— 有就优先用插件的。
      const doneTruth = readReporterDone(ws, client, phaseSessionId);
      const done = doneTruth && doneTruth.at
        ? doneTruth
        : toReporterDone(phaseSessionId ? readKiloDone(phaseSessionId, { title: '', fileCount: 0 }) : null, phaseSessionId, fallbackWs);
      // "接上了没有"：装了插件（状态文件在）**或**这条会话在库里 —— 两者任一即为真。
      const instrumented = Boolean(metaTruth.instrumented || kiloInstrumented(phaseSessionId));
      return res.json({
        ok: true,
        workspacePath: useTruth ? ws || fallbackWs : fallbackWs,
        instrumented,
        session: session || phaseSessionId,
        sessionId: phaseSessionId,
        done: done || null,
        ...(rp || { phase: null, action: '', target: '', context: [], tool: '', prompt: '', model: '' }),
      });
    }

    // ---- 8F OpenCode：**真相位优先、轮询兜底**（与 7F 不同，理由见下） ----
    // 7F 之所以直接短路到 kilo.js，是因为 Kilo 压根没有 hook 状态文件，reporterMainPhase
    // 对它恒为空。8F 不一样：OpenCode **有**插件机制，WorkGremlin 插件会把相位/完成标记写成
    // reporter 状态文件 —— 那是**上报真值**（不标 inferred、UI 不灰显），而且只有它能给
    // 「等待授权」（OpenCode 的 tool 状态实测只有 completed/error/running，授权信号只在
    // 内存事件流里，轮询推不出来）。
    // 所以顺序是：先按通用口径读 reporter（插件在就命中）→ 读不到才退回轮询推导。
    // 两条路的响应形状完全一致，渲染层分不出也不需要分。
    if (clientListHas(client, 'opencode')) {
      const fallbackWs = ws || cur.workspacePath || '';
      // ---- 真相位：插件写的状态文件（与下面通用口径读的是同一份东西） ----
      const rpTruth = reporterMainPhase(ws, client, session);
      const metaTruth = reporterStateMeta(ws, client, session);
      // ---- 兜底：轮询 opencode.db 的推导 ----
      const rpPoll = opencodeMainPhase(fallbackWs, session);
      const useTruth = Boolean(rpTruth && rpTruth.phase);
      const rp = useTruth ? rpTruth : rpPoll;
      // 这份相位属于哪条会话（渲染层拿它确认"我正在看的那条会话"是不是这份）
      const phaseSessionId = String((rp && rp.sessionId) || metaTruth.sessionId || session || '');

      // 完成标记同理：插件那份带**改动文件清单**（实测 session.step.ended 事件的 data.files），
      // 轮询那份只有一个计数 —— 有就优先用插件的。两边都经 toReporterDone 归到同一形状
      // （插件那份本来就已经是 reporter 形状，转译是幂等的）。
      const doneTruth = readReporterDone(ws, client, phaseSessionId);
      const done = doneTruth && doneTruth.at
        ? doneTruth
        : toReporterDone(phaseSessionId ? readOpencodeDone(phaseSessionId, { title: '', fileCount: 0 }) : null, phaseSessionId, fallbackWs);
      // "接上了没有"：装了插件（状态文件在）**或**这条会话在库里 —— 两者任一即为真。
      // 渲染层靠它区分"这个产品根本没在跑"与"在跑但此刻没动作"。
      const instrumented = Boolean(metaTruth.instrumented || opencodeInstrumented(phaseSessionId));
      return res.json({
        ok: true,
        workspacePath: useTruth ? ws || fallbackWs : fallbackWs,
        instrumented,
        session: session || phaseSessionId,
        sessionId: phaseSessionId,
        done: done || null,
        ...(rp || { phase: null, action: '', target: '', context: [], tool: '', prompt: '', model: '' }),
      });
    }

    const rp = reporterMainPhase(ws, client, session);
    // 这个工程有没有接 hook（接了但当前没动作 → 渲染层显示"待命"，而不是按文件时间瞎猜）
    // 有没有接 hook + 那份状态文件属于哪条会话（渲染层据此判断"你正在看的这条会话在上报吗"）
    const meta = reporterStateMeta(ws, client, session);
    const instrumented = meta.instrumented;
    // 上一轮的完成标记（含 Codex 的收尾自述）：CLI 楼层靠它亮「任务完成」
    const done = readReporterDone(ws, client, session);
    // 带上这条相位所属的工程路径（workspacePath）：渲染层据此只在"选中会话正好属于这个工程"时
    // 才叠加实时相位，避免旧会话（它自己工程已不活跃）被新工程的相位串味、短暂闪一下"思考中"。
    // session 一并回显：调用方可能没传（老行为），拿这个字段确认到底是谁的相位。
    const body = {
      ok: true,
      workspacePath: ws,
      instrumented,
      // 请求指定了会话就回显它；没指定就回"实际取到的那条"（meta.sessionId）
      session: session || meta.sessionId || '',
      sessionId: meta.sessionId,
      done,
    };
    res.json(
      rp
        ? { ...body, ...rp }
        : { ...body, phase: null, action: '', target: '', context: [] }
    );
  });

  return router;
}

/** 扫盘失败也不能把服务拖垮：返回空表 + reason */
function snapshotSafe(o) {
  try {
    const { snapshot } = require('../../sessionRegistry');
    return snapshot(o);
  } catch (e) {
    return {
      ok: true,
      floors: [],
      sessions: [],
      defaultFloor: '1F',
      workspacePath: o.workspacePath || '',
      timeoutMs: 60 * 60_000,
      updatedAt: Date.now(),
      reason: 'no-storage',
      error: String((e && e.message) || e),
    };
  }
}

module.exports = { createSessionsRouter };
