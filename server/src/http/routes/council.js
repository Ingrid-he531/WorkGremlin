'use strict';

/**
 * 议事厅的 HTTP 接口 —— 发起 / 看 / 取消 / 删。
 *
 * 这里的每一条校验都是"不编造"在接口层的体现：
 *   · 楼层不在白名单、或者没装 CLI → **拒掉**，不做降级（少一个人开会不该被悄悄接受）；
 *   · 材料文件读不到 / 是二进制 → **整条请求拒掉并列明是哪几个**，不静默跳过
 *     （用户挑的文件没进去，他必须知道，否则他会以为参与者看过它）；
 *   · 在跑的会不许删（先取消）—— 删了之后在飞的发言还会往一个不存在的会里写，
 *     而这几张表没有外键，那些行就成了孤儿；
 *   · 模式（表决 / 分析）与工作目录（工程模式）都在**这里**校验完：模式认不出就拒，
 *     目录必须是存在且可读的**绝对路径**。放过去的话，错在四个参与者各失败一次之后才显形。
 *
 * 发起接口**不 await 整场会**：一场会要跑几分钟，HTTP 早该返回了。`POST /councils` 落库之后
 * 立刻返回，进度走 WS 推送（WS_EVENTS.COUNCIL），断线了前端拉 `GET /councils/:id` 补。
 */

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS } = require('@workgremlin/shared');

const { listCouncilFloors, isCouncilFloor } = require('../../council/floors');
const { readMaterials } = require('../../council/materials');
const { THRESHOLDS } = require('../../council/consensus');

/** 缺省判定口径：认全局缺省，认不出来就当最保守的那个 */
const defaultThreshold = () =>
  Object.values(THRESHOLDS).includes(DEFAULTS.COUNCIL_THRESHOLD_DEFAULT)
    ? DEFAULTS.COUNCIL_THRESHOLD_DEFAULT
    : THRESHOLDS.UNANIMOUS;

/** 一场会的 id。不用自增：议事厅的表要能整体删干净，id 里别带顺序信息 */
const newId = () => `c_${crypto.randomBytes(12).toString('hex')}`;

/** 两种谈法。见 shared 的 COUNCIL_MODE_DEFAULT 与 council/orchestrator.js 的分支 */
const MODES = Object.freeze(['vote', 'analysis']);

/**
 * 工作目录（工程模式）的校验。**只认绝对路径** —— 相对路径按服务端 cwd 解析出来的结果，
 * 和用户心里的那个目录常常不是一回事；与其替他猜，不如让他写全。
 *
 * 展开开头的 `~`（用户在输入框里最常敲的就是它），然后**必须存在且是目录**：
 * 不存在的路径要是放过去，四个参与者会各自失败一次，最后报一个"谁都没表态"的会，
 * 真因（目录写错了）反而看不见。
 *
 * @param {unknown} raw 请求体里的 workspacePath
 * @returns {{path:string}|{error:string}} path 为空串 = 用户没填（隔离模式）
 */
function resolveWorkspaceDir(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { path: '' };
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(s === '~' ? 1 : 2));
  if (!path.isAbsolute(s)) return { error: `工作目录要写绝对路径（留空 = 隔离模式）：${s}` };
  const resolved = path.resolve(s);
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return { error: `工作目录不存在：${resolved}` };
  }
  if (!st.isDirectory()) return { error: `工作目录不是目录：${resolved}` };
  return { path: resolved };
}

const bad = (res, message) => res.status(400).json({ ok: false, error: { code: 'bad_payload', message } });
const notFound = (res) => res.status(404).json({ ok: false, error: { code: 'not_found', message: '没有这场会' } });

/**
 * @param {{repo:object, orchestrator:object, deps?:object}} arg
 *   deps.listFloors 可注入（测试里换掉真实的 CLI 探测）
 */
function createCouncilRouter({ repo, orchestrator, deps = {} }) {
  const router = express.Router();
  const listFloors = deps.listFloors || (() => listCouncilFloors());

  /** 这一层现在能不能请（装了 CLI 才算） */
  const floorsById = () => new Map(listFloors().map((f) => [f.floorId, f]));

  /* ------------------------------------------------------------------ 可选楼层 */
  // 注意：这条要放在 /councils/:id 前面，否则 'floors' 会被当成一个 id
  router.get('/councils/floors', (req, res) => {
    res.json({
      ok: true,
      floors: listFloors(),
      // 界面要显示"最多几轮"，缺省与硬顶从这儿取，别在前端再写死一份
      defaults: {
        maxRounds: DEFAULTS.COUNCIL_ROUNDS_DEFAULT,
        maxRoundsLimit: DEFAULTS.COUNCIL_ROUNDS_MAX,
        threshold: defaultThreshold(),
        modes: [...MODES],
        mode: DEFAULTS.COUNCIL_MODE_DEFAULT,
        turnTimeoutMs: DEFAULTS.COUNCIL_TURN_TIMEOUT_MS,
        // 工程模式的单轮超时（参与者要自己翻代码，比上面那个宽）—— 界面要能写明"最长等多久"
        workspaceTurnTimeoutMs: DEFAULTS.COUNCIL_WORKSPACE_TURN_TIMEOUT_MS,
        materialMaxBytes: DEFAULTS.COUNCIL_MATERIAL_MAX_BYTES,
        materialTotalMaxBytes: DEFAULTS.COUNCIL_MATERIAL_TOTAL_MAX_BYTES,
      },
    });
  });

  /* ------------------------------------------------------------------ 发起 */
  router.post('/councils', (req, res) => {
    const body = req.body || {};
    const topic = String(body.topic == null ? '' : body.topic).trim();
    if (!topic) return bad(res, '议题不能是空的');

    // 谈法：认不出来就拒，不静默降级成表决（用户选了"分析"却被当成"表决"跑，是最坏的一种错）
    const mode = body.mode == null || body.mode === '' ? DEFAULTS.COUNCIL_MODE_DEFAULT : String(body.mode);
    if (!MODES.includes(mode)) return bad(res, `模式只能是 ${MODES.join(' / ')}：${mode}`);

    // 在哪儿谈：留空 = 隔离模式（与改动前逐字相同）；填了必须是存在且可读的目录
    const ws = resolveWorkspaceDir(body.workspacePath);
    if (ws.error) return bad(res, ws.error);

    const wanted = Array.isArray(body.floors) ? [...new Set(body.floors.map((f) => String(f)))] : [];
    if (wanted.length < 2) return bad(res, '至少要请两个楼层 —— 一个人不叫讨论');

    const known = floorsById();
    const unknown = wanted.filter((f) => !isCouncilFloor(f));
    if (unknown.length) return bad(res, `这几个楼层议事厅请不了：${unknown.join('、')}`);
    const asleep = wanted.filter((f) => !(known.get(f) || {}).ready);
    if (asleep.length) {
      // 说清每一层为什么不行 —— 用户装了插件但没装 CLI 时，得知道差的是什么
      const why = asleep.map((f) => `${f}：${(known.get(f) || {}).reason || '不可用'}`).join('；');
      return bad(res, `这些楼层现在请不动 —— ${why}`);
    }

    const wantedRounds = Number(body.maxRounds);
    const maxRounds = Number.isFinite(wantedRounds) && wantedRounds > 0
      ? Math.min(Math.floor(wantedRounds), DEFAULTS.COUNCIL_ROUNDS_MAX)
      : DEFAULTS.COUNCIL_ROUNDS_DEFAULT;

    const threshold = Object.values(THRESHOLDS).includes(body.threshold) ? body.threshold : defaultThreshold();

    // 材料：读不到就整条拒掉，并列明是哪几个（不静默跳过）
    const files = Array.isArray(body.files) ? body.files.map((f) => String(f || '')).filter(Boolean) : [];
    const materials = readMaterials(files);
    const broken = materials.filter((m) => m.error);
    if (broken.length) {
      return bad(res, `这些文件没能读进来：${broken.map((m) => `${m.path}（${m.error}）`).join('；')}`);
    }

    const id = newId();
    const createdAt = Date.now();
    const floorOf = (f) => known.get(f) || {};
    try {
      repo.createCouncil({ id, topic, mode, workspacePath: ws.path || null, threshold, maxRounds, createdAt });
      for (const f of wanted) {
        repo.insertParticipant({ councilId: id, floorId: f, agent: floorOf(f).agent || '', cliPath: floorOf(f).cliPath || null });
      }
      materials.forEach((m, ord) => {
        repo.insertMaterial({
          councilId: id,
          ord,
          path: m.path,
          bytesTotal: m.bytesTotal,
          bytesIncluded: m.bytesIncluded,
          truncated: m.truncated,
          content: m.content,
        });
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: { code: 'internal', message: `建这场会失败：${(err && err.message) || '未知原因'}` } });
    }

    // 落库成功了才开跑。**不 await**：发起接口立刻返回，进度走 WS。
    // start() 自己保证不抛（见 orchestrator.js），所以这里不用挂 catch。
    orchestrator.start(id);

    res.status(201).json({ ok: true, council: repo.getCouncil(id) });
  });

  /* ------------------------------------------------------------------ 列表 */
  router.get('/councils', (req, res) => {
    res.json({ ok: true, councils: repo.listCouncils(Number(req.query.limit) || 50) });
  });

  /* ------------------------------------------------------------------ 详情 */
  router.get('/councils/:id', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    res.json({
      ok: true,
      council,
      participants: repo.listParticipants(council.id),
      // 材料连正文一起给：界面要能让人核对"到底喂进去了什么"，这是可追溯的一部分
      materials: repo.listMaterials(council.id),
      rounds: repo.listRounds(council.id),
      utterances: repo.listUtterances(council.id),
      // 还在跑吗（进程是否还活着只有服务端知道；库里的 status 可能刚被标过还没推送出去）
      live: orchestrator.activeIds().includes(council.id),
    });
  });

  /* ------------------------------------------------------------------ 取消 */
  router.post('/councils/:id/cancel', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    // cancel 只对"服务端内存里还在跑"的会有效；已经结束的会取消不了，如实返回 false
    const cancelled = orchestrator.cancel(council.id);
    res.json({ ok: true, cancelled, council: repo.getCouncil(council.id) });
  });

  /* ------------------------------------------------------------------ 删除 */
  router.delete('/councils/:id', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    if (orchestrator.activeIds().includes(council.id)) {
      // 在跑的会先取消再删：直接删掉的话，在飞的发言还会往这个已经不存在的会里写，
      // 而这几张表没有外键约束，那些行会变成孤儿留在库里
      return res.status(409).json({ ok: false, error: { code: 'conflict', message: '这场会还在讨论，先取消再删' } });
    }
    repo.deleteCouncil(council.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createCouncilRouter, resolveWorkspaceDir };
