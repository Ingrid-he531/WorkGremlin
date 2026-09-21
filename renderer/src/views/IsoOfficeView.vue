<script setup>
/**
 * IsoOfficeView —— 2.5D 等距办公室。
 *
 * 场景全部由 Canvas 现画（见 iso/），这里只负责：
 *   - 把 store 里的成员翻译成场景里的演员（专家坐工位 / 临时成员飘在空中）
 *   - HUD、任务卡、交互提示
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import WorkstationCard from '../components/WorkstationCard.vue';
import ConnectionBar from '../components/ConnectionBar.vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { useMainAgentStore } from '../stores/mainAgent';
import { isEphemeralMember, projectLabelOf } from '../lib/ephemeral';
import { httpBase, getServerInfo } from '../api/bridge';
import { createIsoOffice } from '../iso/engine';

const props = defineProps({
  selectedId: { type: String, default: '' },
  /** 左上角状态徽标用的三项：连接 / 项目名 / 相位来源（由 App.vue 统一算好传下来） */
  connection: { type: Object, default: () => ({ state: '' }) },
  projectLabel: { type: String, default: '' },
  source: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const project = useProjectStore();
const sessions = useSessionStore();
const mainAgent = useMainAgentStore();
const wrapRef = ref(null);
const canvasRef = ref(null);

/* ------------------------------ 主 Agent 相位快轮询（1.5s） ------------------------------
 * 服务端 /api/v1/reporter-phase 直接回 reporter hook 的上报相位（已映射成 UI 字段），
 * 比 /sessions 的 10s 轮询新鲜，专供主控制台"操作"实时显示（调用工具 / 等待授权）。
 * 渲染层是沙箱的（contextIsolation + nodeIntegration:false），读不到本地状态文件，
 * 所以一律走服务端，复用 readReporterPhase 的容错读，不碰 fs。
 */
const fastPhase = ref(null);
let phaseTimer = null;

async function startPhasePoll() {
  const info = await getServerInfo().catch(() => ({ port: 0, token: '' }));
  if (!info || !info.port) return;
  const tick = async () => {
    try {
      // 带上当前楼层的客户端：同一工程里 Codex 与 CodeBuddy 同时在跑时，各取各的相位
      const want = sessions.selectedClient;
      const qs = want ? `?client=${encodeURIComponent(want)}` : '';
      const res = await fetch(`${httpBase(info)}/api/v1/reporter-phase${qs}`, {
        headers: info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.ok) {
          // 相位可能为空（这一轮结束 / 当前没动作），但 instrumented 要留住：
          // 渲染层靠它区分"这个工程根本没接 hook"和"接了、只是现在没事干"。
          fastPhase.value = {
            phase: d.phase && d.phase !== 'idle' ? d.phase : null,
            action: d.action || '',
            target: d.target || null,
            context: d.context || [],
            tool: d.tool || '',
            prompt: d.prompt || '',
            workspacePath: d.workspacePath || '',
            instrumented: Boolean(d.instrumented),
            // 这份状态属于哪条会话（hook 是会话级加载的，见 consoleBase 的 sameSession）
            sessionId: d.sessionId || '',
            // 上一轮的完成标记（CLI 楼层靠它亮「任务完成」；Codex 还带收尾自述）
            done: d.done || null,
          };
        }
      }
    } catch {
      /* 拉不到就留着上一次的相位，别闪回空闲 */
    }
  };
  await tick();
  phaseTimer = setInterval(tick, 1500);
}

function stopPhasePoll() {
  if (phaseTimer) clearInterval(phaseTimer);
  phaseTimer = null;
  fastPhase.value = null;
}

/* ------------------------------ 主 Agent 控制台 tooltip ------------------------------
 * 鼠标停在悬浮屏上（hover 命中）超过 TIP_DELAY 才弹，避免拖拽 / 扫过也闪。
 * 内容取自主 Agent store：具体在做什么 + 技能名 + MCP 工具信息（都是 setMainAgent 喂进来的）。
 */
const TIP_DELAY = 400;
const tip = ref({ show: false, x: 0, y: 0 });
let tipTimer = null;

function clearTip() {
  if (tipTimer) {
    clearTimeout(tipTimer);
    tipTimer = null;
  }
  tip.value.show = false;
}

function onConsoleMove(e) {
  if (!office || !canvasRef.value) return;
  // 按住拖拽时不弹（那是平移视角，不是看信息）
  if (e.buttons) {
    clearTip();
    return;
  }
  const r = canvasRef.value.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  if (office.hitMainConsole(px, py)) {
    tip.value.x = e.clientX;
    tip.value.y = e.clientY;
    if (!tipTimer) tipTimer = setTimeout(() => { tip.value.show = true; }, TIP_DELAY);
  } else {
    clearTip();
  }
}

function onConsoleLeave() {
  clearTip();
}

/** 主 Agent 控制台：现在喂的是 mock 的阶段性状态，换成 hook 事件后这里不用动 */
const mainAgentState = computed(() => mainAgent.snapshot);

/** 两个工程路径是否同一个（去尾斜杠比较；任一为空视为"不限定"，返回 true） */
function sameWorkspace(a, b) {
  const na = String(a || '').replace(/\/+$/, '');
  const nb = String(b || '').replace(/\/+$/, '');
  return !na || !nb || na === nb;
}

/**
 * 主控制台严格跟随下拉选中的会话：显示"这条会话自己"的相位
 * （它自己工程 reporter 上报的真值，或落盘推断值），绝不拿别的工程的实时相位冒充。
 * 这样多个工程同时开着时，下拉切到哪条就显示哪条，与所选会话一一对应。
 */
const consoleBase = computed(() => {
  const sel = sessions.selected;
  if (!sel) return null;
  // 选中的恰好是"全局当前在敲"的那条（fresh）：叠加 1.5s 快轮询的实时相位，
  // 让"调用工具 / 等待授权"更跟手（比 10s 会话轮询新鲜）。其余会话（哪怕是各自工程的
  // current=true）只用自己会话轮询的数据，绝不借全局实时相位冒充——否则切回旧会话会误显新工程的"调用工具"。
  // 再加一道"工程归属"校验：快轮询相位带回了它所属工程（workspacePath），只有选中会话正好
  // 属于那个工程才叠加。否则切工程后旧会话的 fresh 还来不及翻新（会话快照滞后），新工程的
  // "思考中"会短暂盖到旧会话上——现象就是旧会话闪一下"思考中"、随后回落"待命中"。
  const fp = fastPhase.value;
  const sameWs = Boolean(fp) && sameWorkspace(fp.workspacePath, sel.projectPath);
  // hook 状态文件属于**某一条会话**（hook 在会话启动时加载）。工程相同还不够 ——
  // 实测：13:40 开的旧会话没有 hook，但同工程里跑过 codex exec，状态文件存在，
  // 于是这条会话被显示成「待命」，看起来像"整轮对话完全没有状态变化"。
  // 所以还要确认"上报的那条会话 == 你正在看的这条"（rollout 文件名里含 session_id）。
  const sameSession = Boolean(fp) && (!fp.sessionId || !sel.id || String(sel.id).includes(fp.sessionId));
  // `fresh` 只有 3F 插件会话会设（= 全局唯一"正在敲"的那条）。CLI 楼层（1F/2F/4F/5F）没这个标记，
  // 但同样有 hook 上报的相位 —— 只要"相位所属工程 == 这条会话的工程"就该用它；
  // 否则 4F 永远只能显示会话表里"按 jsonl 文件时间猜"的兜底：一直「调用工具」+ 文案是那个 rollout 文件名。
  const canUseFast = Boolean(sel.fresh) || (sel.source === 'cli' && Boolean(sel.projectPath));
  if (canUseFast && sameWs && sameSession && fp.phase) {
    if (fp.phase === 'await') {
      return { phase: 'await', action: fp.action || '等待用户授权', context: fp.context && fp.context.length ? fp.context : ['等待用户授权后继续'], target: fp.target || null, prompt: fp.prompt || '' };
    }
    if (fp.phase === 'tool') {
      return { phase: 'tool', action: fp.action || '调用工具', context: fp.context && fp.context.length ? fp.context : [], target: fp.target || null, tool: fp.tool || '', prompt: fp.prompt || '' };
    }
    // 思考中：把用户那句话（prompt）同时放到第二层（action）和第三层。
    // 屏上第三层有"字号够大才画"的门槛（mainConsole 的 showL3），放大不够时不出字；
    // 第二层门槛低，所以放一份在第二层，保证"思考中"下面任何时候都看得到你问的那句话。
    // 注意：这里只用快轮询（1.5s，新鲜）的字段，**不再回落到 sel**——会话快照可能还是上一轮的，
    // 一旦用 sel.action / sel.context 兜底，就会出现"思考中却显示上一轮的操作"，几秒后才更正。
    if (fp.phase === 'thinking') {
      const p = fp.prompt || '';
      return { phase: 'thinking', action: fp.action || p, context: fp.context && fp.context.length ? fp.context : [], target: fp.target || null, prompt: p };
    }
  }
  // 接了我们 hook 的 CLI 工程：当前没有相位 = 这一路现在真的没事干 → 待命。
  // 不能退回会话表里那个"按文件 mtime 猜"的结果（它会在 5 分钟窗口内一直说「调用工具」）。
  if (sel.source === 'cli' && sameWs && sameSession && fp.instrumented) {
    return { phase: 'idle', action: '', context: [], target: null, tool: '', prompt: '' };
  }
  // 否则直接用选中会话自身的相位（reporter 真值 if 它正活跃，否则推断），
  // 下拉切到旧工程会话就显示旧会话自己的状态，不再被新工程的实时相位覆盖。
  const selPrompt = sel.phase === 'thinking' ? sel.prompt || '' : '';
  return {
    phase: sel.phase || 'idle',
    action: sel.action || selPrompt,
    context: sel.context && sel.context.length ? sel.context : [],
    target: sel.target || null,
    tool: sel.tool || '',
    prompt: sel.prompt || '',
  };
});

/**
 * 正在替主 agent 干活的 subagent（屋里飘着的幽灵）。
 *
 * 这里直接读 project.members、**不复用下面的 sceneMembers** ——
 * consoleLive 的 watch 在 setup 阶段就会求值一次，那时 sceneMembers 还没初始化（TDZ）。
 * 筛选口径与 sceneMembers 保持一致：只算临时成员（幽灵）。
 */
const busySubagents = computed(() => {
  if (sessions.floorEmpty || !sessions.live) return [];
  return project.members.filter(
    (m) => isEphemeralMember(m) && (m.state === 'busy' || m.state === 'blocked' || m.state === 'thinking')
  );
});

/**
 * 主控制台最终喂给 store 的相位 = 会话自己的相位 + "在等 subagent"这一层。
 *
 * 主会话还没收到 Stop（相位仍是 idle）而屋里已经有 subagent 在跑 —— 这时写"待命中"
 * 是错的：人明明还在这一轮任务里，只是在等小怪物交活。单独给"等待中"，并写出在等谁。
 * 收到 Stop 后相位变 done / summarize，不再被这里覆盖，"任务完成 → 待命中"照旧。
 */
const consoleLive = computed(() => {
  const v = consoleBase.value;
  const subs = busySubagents.value;
  if (subs.length && (!v || v.phase === 'idle')) {
    const names = [...new Set(subs.map((m) => m.name))].join('、');
    return {
      phase: 'waiting',
      action: `等待 ${names} 汇报`,
      context: subs.slice(0, 3).map((m) => (m.task ? `${m.name}：${m.task}` : `${m.name} 执行中`)),
      target: null,
      tool: '',
      prompt: '',
    };
  }
  return v;
});

/**
 * "任务完成"唯一真源 = reporter 在 Stop 时落盘的 doneAt（服务端按工程透传）。
 * 绝不靠"相位回落到空闲"来猜——那样会被轮询间隙 / 跨工程串味误触发，
 * 导致任务中途也弹出"任务完成"。而且只有 doneAt 真正变化（收到新 Stop）时才弹，
 * 切到一条早已收工的旧会话不会误报。
 */
let lastConsoleSessionId = undefined;
let lastDoneAt = undefined;
/** 是否已经见过"快轮询带回的完成标记"：首次只当基线，不弹摘要（见下面的注释） */
let seenFastDone = false;
watch(
  consoleLive,
  (v) => {
    // 演示模式：控制台**归演示脚本独占**，真会话一律不参与。
    // 不拦的话，下拉里选着的那条真会话每 1.5s 都会把它的相位喂进来（演示时通常就是「待命中」），
    // 于是脚本刚演一步就被顶回去 —— 现象正是"点了演示模式，主 Agent 状态不变"。
    if (project.demo) {
      if (!mainAgent.auto) startDemoScript();
      return;
    }
    const sel = sessions.selected;
    const selId = sel ? sel.id : null;
    // 完成标记：优先会话自身的（3F 插件从落盘算出来），CLI 楼层没有就取 hook 快轮询带回来的。
    //
    // 两条纪律（都是踩过的坑）：
    //   ① 它是"某条会话上一轮结束"的**持久状态**，不是一次性事件 —— 页面刚打开 / 刚切楼层时
    //      首次拿到它只能当基线，否则会把上一次的完成摘要当成刚发生的事重播一遍
    //      （现象：一开 4F 就弹「任务完成」，10 秒后才回待命）；
    //   ② 它按"工程 + 客户端"存（同工程里 Codex/CodeBuddy 各一份），但显示时是针对**选中的会话**，
    //      所以还要确认这份完成属于当前这条会话（rollout 文件名里含 session_id）。
    const fpDone = fastPhase.value && fastPhase.value.done;
    const sameSession =
      !fpDone || !fpDone.sessionId || !sel || !sel.id || String(sel.id).includes(fpDone.sessionId);
    const fastDoneAt = fpDone && fpDone.at && sameSession ? fpDone.at : 0;
    const firstFastDone = fastDoneAt > 0 && !seenFastDone;
    if (fastDoneAt > 0) seenFastDone = true;
    const doneAt = (sel && sel.doneAt) || fastDoneAt || 0;
    // 切换了会话（或首次）：直接把控制台切到这条会话当前的状态，重置完成标记，不弹"任务完成"。
    // 办公室的工位小怪物也跟着选中的会话走：切到别的工程会话，就切到那个工程的成员清单，
    // 这样"主 Agent + 小怪物"整组都跟随下拉选中的那条，不再停在之前打开的工程。
    if (selId !== lastConsoleSessionId) {
      lastConsoleSessionId = selId;
      lastDoneAt = doneAt;
      seenFastDone = fastDoneAt > 0; // 切会话时重新以这条会话的标记为基线
      // 空楼层（一条会话都没有）：控制台待命 + 屋里清人（见 sceneMembers），
      // 不走 applySession(null) —— 那是"会话收工"，会弹「任务完成」，跟这层没关系。
      if (!sel && sessions.floorEmpty) {
        mainAgent.enterIdle(['本层暂无活跃会话']);
        return;
      }
      mainAgent.applySession(v);
      // 演示期间不让会话把工程拽走：演示是用户显式进出的（HUD 的按钮），而"新会话自动跟随"
      // 很可能在看演示时正好插进来一条真会话 —— 一拽就走了，演示当场断掉。
      if (!project.demo && sel && sel.projectPath && sel.projectPath !== project.workspacePath) {
        project.openWorkspace(sel.projectPath);
      }
      return;
    }
    // 同一条会话：收到 Stop（doneAt 新增 / 变化）→ 亮"任务完成"，概要用真实完成内容
    // （本次改动的文件），而不是最后那段相位上下文、更不拿用户的 prompt 当概要。
    if (firstFastDone) lastDoneAt = doneAt; // 首次拿到：只记基线，不弹
    if (doneAt && doneAt !== lastDoneAt) {
      lastDoneAt = doneAt;
      // 组装成**可读的完成摘要**：原来直接把 doneFiles 的对象塞进 context，
      // tooltip 里 {{ c }} 渲染对象就成了 JSON 串；这里先给一句总述，再一行一个文件。
      const files = (sel && sel.doneFiles) || [];
      // 本轮任务改动的文件数（服务端已按"本轮开始之后"过滤）；拿不到就用列表长度兜底
      const count = (sel && Number(sel.doneCount)) || files.length;
      const said = (fpDone && fpDone.said) || '';
      const ctx = files.length
        ? [`改动 ${count} 个文件`, ...files.map((f) => `${f.name}  +${f.added}/-${f.removed}`)]
        : [said || '本次任务已完成'];
      mainAgent.enterDone('任务完成', ctx);
      return;
    }
    mainAgent.setLiveState(v);
  },
  { immediate: true }
);

/** @type {ReturnType<typeof createIsoOffice> | null} */
let office = null;
let cardRaf = 0;

/**
 * 场景演员：专家（有工位）+ 临时成员（幽灵，飘着）。
 *
 * 选中的会话不是"当前工程里正在跑的那个"时（别的工程的会话 / 只剩化石数据），
 * 这份成员清单跟那个会话对不上 —— 一律按离线 + 推断显示，绝不拿 A 工程的人
 * 冒充 B 工程的状态。办公室布局不受影响，还是这份清单摆出来的样子。
 */
// 主 Agent（role=agent）不占工位：它自己的实时状态由主控制台剪影单独吃
// （setMainAgent），在工位区再摆一个就是重复。所以从工位名单里剔掉，
// 只让真正的 subagent 小怪物（含扫描器注册的常驻成员）坐工位。
const sceneMembers = computed(() => {
  // 演示模式压过楼层 / 会话这两层过滤：演示成员的活跃状态由服务端推进器维持
  // （每 5s 刷心跳、推进度），跟"下拉里选中哪条真会话"没关系。不特判的话，
  // 演示里 8 只小怪物会整片转灰 + 标"推断"，楼层恰好没有活跃会话时（floorEmpty）
  // 屋里还会一个人都不剩 —— 那就不叫演示了。
  const demo = project.demo;
  // 切到没有活跃会话的楼层：屋里一个人都不留。
  // 否则 project.members 还是上一个工程的人（小怪物站在工位上、卡片也是那批），
  // 看着就像楼层没切 —— 那层压根没人在干活。
  if (sessions.floorEmpty && !demo) return [];
  const want = demo ? '' : sessions.selectedClient;
  const live = demo || sessions.live;
  return project.members
    .filter((m) => m.role !== 'agent')
    // 按楼层过滤来源：4F 只看 Codex 的成员与幽灵，1F/3F 只看 CodeBuddy 的。
    // client 为空的（演示数据、手工 scripts/subagents.js 写的、老库还没补上的）视作通用，哪层都显示。
    .filter((m) => !want || !m.client || m.client === want)
    .map((m) => ({
      memberId: m.memberId,
      name: m.name || String(m.memberId || '').split('@')[0],
      level: m.level || null,
      state: live ? m.state || 'offline' : 'offline',
      degraded: live ? Boolean(m.degraded) : true,
      ghost: isEphemeralMember(m),
      project: projectLabelOf(m),
      taskProgress: live && m.task && Number.isFinite(m.task.progress) ? m.task.progress : 0,
      // 被召唤的 subagent 当前任务名：主 agent 会用气泡把它交代给小怪物
      task: m.task && m.task.title ? m.task.title : '',
      // 收工摘要：清单里写的 result 由服务端作为 artifact 随成员卡下发
      // （kind 只有 file/doc/pr/text，所以记成 kind='text' + path 标记，见 subagentFeed 的 SUMMARY_PATH），
      // 小怪物收工时会把它说给主 agent 听（见 iso/engine 的 stepReport）。
      result: ((m.artifacts || []).find((a) => a && a.kind === 'text' && a.path === 'workgremlin:summary') || {}).title || '',
    }));
});

watch(sceneMembers, (v) => {
  // 人没了（切到空楼层）：开着的工位卡片也一起收掉，别挂着上一层某个成员的任务卡
  if (!v.length) card.value = null;
  if (office) office.setMembers(v);
});
watch(
  () => props.selectedId,
  (v) => office && office.setSelected(v)
);
watch(mainAgentState, (v) => office && office.setMainAgent(v));

/* ------------------------------ 任务卡 ------------------------------ */

const card = ref(null);
let lastOpen = 0;

const cardMember = computed(() => (card.value ? project.members.find((m) => m.memberId === card.value.memberId) : null));

function updateCardPos() {
  if (!card.value || !office || !wrapRef.value) return;
  const p = office.screenOf(card.value.memberId);
  if (!p) return;
  const w = wrapRef.value.clientWidth || 800;
  card.value.left = Math.round(Math.max(175, Math.min(w - 175, p.x)));
  card.value.top = Math.round(Math.max(8, p.y - 14));
}

function openCard(id) {
  lastOpen = Date.now();
  emit('select', id);
  card.value = { memberId: id, left: 0, top: 0 };
  updateCardPos();
}

function onCanvasClick() {
  // engine 命中角色时会先调 openCard，这里只处理"点空白"
  if (Date.now() - lastOpen < 150) return;
  card.value = null;
}

function closeCard() {
  card.value = null;
}

/* ------------------------------ 演示脚本的启动时机 ------------------------------
 * 主控制台那份 SCRIPT（见 stores/mainAgent.js）是**演示数据**，只能演示模式下跑。
 * 真数据源（默认）首屏就该是待命：一条会话都没有、hook 也没接上时，没有任何非 null 的
 * applySession / setLiveState 来接管，脚本会自己循环播放「重构用户登录模块」，
 * 假状态永远没人顶掉 —— 新设备首次启动就撞上这个（屋里是空的，屏上却在演）。
 *
 * 两个细节：
 *   1) project.demo 是**异步**拿的（App.vue 在父组件 onMounted 里 project.init()，
 *      子组件先挂载），所以 onMounted 里读到的常常还是 false —— 真正的启动交给下面的 watch；
 *   2) 真数据已经在驱动时不抢方向盘（live / hookLive）。
 */
function startDemoScript() {
  if (mainAgent.auto) return; // 已经在演了，别把进度拨回第一步
  // 演示期间控制台归脚本：必须先把 live / hookLive 清掉，否则脚本起不来 / 起步就被真会话顶掉。
  // 优先走 store 的 startDemo()；热更时页面里可能还是改之前的 store 实例（没有这个 action），
  // 那就地清标志再 start() —— 不能让"HMR 没换掉 action"变成控制台每 1.5s 抛一次错。
  if (typeof mainAgent.startDemo === 'function') {
    mainAgent.startDemo();
    return;
  }
  mainAgent.live = false;
  mainAgent.hookLive = false;
  mainAgent.liveMember = null;
  mainAgent.start();
}

/** 服务端确认当前停在演示工程后（含"上次停在演示工程"被 restore 回来的情况）才开演；
 *  退出演示时收掉脚本，控制台交回真会话（真实相位由上面那个 watch 立刻接管）。 */
watch(
  () => project.demo,
  (v) => {
    if (v) startDemoScript();
    else if (mainAgent.auto) mainAgent.enterIdle();
  }
);

/* ------------------------------ HUD ------------------------------ */

/** 演示模式开关（HUD 里、集合开会前面那个按钮）：切进 / 切出演示工程 */
async function toggleDemo() {
  try {
    if (project.demo) await project.exitDemo();
    else await project.enterDemo();
  } catch (err) {
    // 切不过去（目录没了 / 服务端拒绝）不能把视图带崩：保持原样，只报一行
    console.warn('[workgremlin] 切换演示模式失败：', err && err.message);
  }
}

function callAll() {
  if (office) office.callAll();
}
function dismiss() {
  if (office) office.dismiss();
}
function resetView() {
  if (!office) return;
  office.destroy();
  office = createIsoOffice(canvasRef.value, { onSelect: openCard });
  office.setMembers(sceneMembers.value);
  office.setSelected(props.selectedId);
  office.setMainAgent(mainAgentState.value);
}

onMounted(() => {
  office = createIsoOffice(canvasRef.value, { onSelect: openCard });
  office.setMembers(sceneMembers.value);
  office.setSelected(props.selectedId);
  office.setMainAgent(mainAgentState.value);
  // 非演示模式不 start()：保持待命，等真会话 / hook 相位接管（见 startDemoScript 的注释）
  if (project.demo) startDemoScript();
  startPhasePoll();

  const loop = () => {
    updateCardPos();
    cardRaf = requestAnimationFrame(loop);
  };
  cardRaf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(cardRaf);
  // 只有演示脚本在跑时才 stop()：stop() 会亮「已暂停」摘要，非演示模式下没在演就别弹
  if (mainAgent.auto) mainAgent.stop();
  stopPhasePoll();
  if (office) office.destroy();
  office = null;
});
</script>

<template>
  <div ref="wrapRef" class="scene-wrap">
    <canvas
      ref="canvasRef"
      class="scene"
      @click="onCanvasClick"
      @mousemove="onConsoleMove"
      @mouseleave="onConsoleLeave"
    />

    <!-- 左上角状态徽标：连接 / 项目 / 相位来源（原来在顶栏，现在跟着办公室走） -->
    <ConnectionBar
      class="status-hud"
      :connection="connection"
      :project="projectLabel"
      :source="source"
    />

    <!-- 主 Agent 控制台 tooltip：鼠标停在悬浮屏上 400ms 后弹出 -->
    <div
      v-if="tip.show"
      class="console-tip"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      <div class="ct-head">
        <i class="dot" :style="{ background: mainAgent.phaseColor }" />
        <span class="ct-phase">{{ mainAgent.phaseLabel }}</span>
      </div>
      <div
        class="ct-row"
        v-if="mainAgent.action || ((mainAgent.phase === 'done' || mainAgent.phase === 'summarize') && mainAgent.context.length)"
      >
        <b>操作</b>
        <span class="ct-val">
          <template v-if="(mainAgent.phase === 'done' || mainAgent.phase === 'summarize') && mainAgent.context.length">
            <span v-for="(c, i) in mainAgent.context" :key="i" class="ct-file">{{ c }}</span>
          </template>
          <template v-else-if="mainAgent.action">{{ mainAgent.action }}</template>
        </span>
      </div>
      <div v-if="mainAgent.target && mainAgent.phase === 'await'" class="ct-row"><b>目标</b><span class="ct-val">{{ mainAgent.target }}</span></div>
      <div v-if="mainAgent.skill" class="ct-row"><b>技能</b><span class="ct-val">{{ mainAgent.skill }}</span></div>
    </div>

    <!-- 任务卡（跟着角色走） -->
    <div
      v-if="card && cardMember"
      class="card-layer"
      :style="{ left: `${card.left}px`, top: `${card.top}px` }"
      @click.stop
    >
      <WorkstationCard :member="cardMember" />
      <button class="card-close" @click="closeCard">关闭</button>
    </div>

    <!-- HUD -->
    <div class="hud" @click.stop>
      <!-- 演示模式：切到演示工程（主控制台自动演一轮、小怪物换成演示成员）。
           放在办公室自己的操作条上、集合开会之前 —— 它切的是"屋里这台机器"，
           和 集合开会 / 全员回工位 是一类动作，不占顶栏页签。 -->
      <button
        class="demo-btn"
        :class="{ on: project.demo }"
        :title="project.demo ? '退出演示，回到进演示前的工程' : '切到演示工程：主控制台自动演一轮，小怪物用演示成员'"
        @click="toggleDemo"
      >
        {{ project.demo ? '退出演示' : '演示模式' }}
      </button>
      <button @click="callAll">集合开会</button>
      <button @click="dismiss">全员回工位</button>
      <button @click="resetView">复位视角</button>
    </div>

    <div class="tip">
      拖拽平移 · 滚轮缩放 · 双击复位 · 点小怪物看任务
      <span class="dim">（前玻璃墙下是主 Agent 控制台，放大可看清屏幕）</span>
    </div>
  </div>
</template>

<style scoped>
.scene-wrap {
  position: relative;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  /* 底色走 token：门楣（楼层屏那片）用的是同一个色，见 theme.css 的 --iso-bg */
  background: var(--iso-bg, #151a22);
}

.scene {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.card-layer {
  position: absolute;
  transform: translate(-50%, -100%);
  width: 320px;
  z-index: 5;
  filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.5));
}

.card-close {
  margin-top: 6px;
  width: 100%;
}

/* 左上角状态徽标：不吃鼠标事件，免得挡住场景拖拽 */
.status-hud {
  position: absolute;
  left: 10px;
  top: 10px;
  z-index: 4;
  pointer-events: none;
}

.hud {
  position: absolute;
  right: 10px;
  top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(12, 15, 20, 0.82);
  border: 1px solid var(--border);
  font-size: 12px;
  z-index: 4;
}

.hud button.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.ghost-dot {
  background: transparent;
  border: 1px dashed #8fe0f5;
}

.sep {
  width: 1px;
  height: 16px;
  background: var(--border-strong);
}

.tip {
  position: absolute;
  left: 10px;
  bottom: 10px;
  padding: 5px 10px;
  border-radius: 6px;
  background: rgba(12, 15, 20, 0.7);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
  z-index: 4;
}

.console-tip {
  position: fixed;
  transform: translate(16px, 16px);
  max-width: 320px;
  padding: 9px 11px;
  border-radius: 8px;
  background: rgba(14, 18, 26, 0.96);
  border: 1px solid var(--accent, #4c8dff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  color: var(--text, #e6ebf2);
  font-size: 12px;
  line-height: 1.5;
  z-index: 60;
  pointer-events: none;
}

.ct-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.ct-phase {
  font-weight: 700;
}

.ct-row {
  display: flex;
  gap: 8px;
  color: var(--text-dim, #a8bdd6);
  /* 长内容（超长文件路径等）与标签顶部对齐，而不是撑破盒子 */
  align-items: flex-start;
}

.ct-row b {
  flex: 0 0 auto;
  color: #7fb0ff;
  font-weight: 600;
}

/* 值文本：可收缩，长串（文件路径 / 工具名）断词换行 */
.ct-val {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* 完成/暂停时的「改动」明细：每个文件单独一行 */
.ct-files .ct-file {
  display: block;
}

.dim {
  color: var(--text-faint);
}
</style>
