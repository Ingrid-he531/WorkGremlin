/**
 * mainAgent.js —— 主 Agent（Craft Agent）的状态。
 *
 * 现在跑的是 mock：按 SCRIPT 一段一段往下演，好把控制台的三层信息和五种
 * 视觉状态先做出来。以后接真实 hook 时，把 advance/apply 换成按事件更新即可：
 *   待命   ← 一段时间没有活跃事件
 *   执行中 ← PreToolUse / PostToolUse（第二层写"正在读取 xxx.js"这类）
 *   调度中 ← 检测到 subagent 被调起（第三层写"已委托：xxx"，target 指到那个工位）
 *
 * 阶段取值见 iso/mainConsole.js 的 PHASES。
 *
 * 今天微调：
 *   1) 思考中（thinking）时，屏幕第三层把收到的 prompt 原文顶到最前面显示；
 *   2) 调用工具若是 Bash/Shell 类：**不再**按 await（等待授权）处理 —— 插件既不发
 *      "等授权"通知也不发"授权结束"通知，命令类工具又不发 PostToolUse，一旦标成 await
 *      就再也没有事件能把它清掉（点了 run 还一直显示「等待授权」）。
 *      现在服务端一律报 tool（调用工具 + 实际命令），渲染层也不再按工具名换文案：
 *      屏上第一行与 tooltip 第一行统一写「调用工具」（见 iso/mainConsole.js 的
 *      consolePhaseLabel），操作仍是实际命令，互不串味；
 *   3) 会话停止（setLiveState/applySession 收到 null，或手动 stop）时，先亮出
 *      "任务完成 / 已暂停" 摘要持续 10s，期间无新事件则退回待命(idle)。
 *   4) 2026-10-01：演示脚本不再演「规划中」；`stop()` 亮出的「已暂停」也不再借用
 *      summarize（「汇总中」）相位 —— 这两个相位真机上不产生，已从 PHASES 里去掉
 *      （见 iso/mainConsole.js）。暂停现在就是"待命中 + 操作行写『已暂停』"。
 */

import { defineStore, acceptHMRUpdate } from 'pinia';
// 相位文案只有一份实现：屏上第一行与 tooltip 第一行都走 consolePhaseLabel()，改口径只需动那一处。
import { PHASES, consolePhaseLabel } from '../iso/mainConsole';
import { t } from '../i18n/index.js';

/** 一轮主会话的演示脚本：阶段 / 第二层动作 / 第三层上下文 / 停留时长 / 调度目标工位 */
const SCRIPT = [
  { phase: 'idle', action: '', context: ['等待派单'], skill: '', tool: '', prompt: '', ms: 6000 },
  { phase: 'thinking', action: '正在分析你的请求', context: ['任务：重构用户登录模块', '思考：先理清登录链路'], skill: 'reasoning（推理）', tool: '', prompt: '请帮我重构用户登录模块，先理清登录链路', ms: 4200 },
  { phase: 'tool', action: '正在读取 src/main.js', context: ['任务：重构用户登录模块', '进度：已读取 1 个文件'], skill: '', tool: 'mcp: filesystem.read_file', prompt: '', ms: 3800 },
  { phase: 'tool', action: '正在搜索 login 相关引用', context: ['任务：重构用户登录模块', '进度：已读取 3 个文件', '命中：7 处引用'], skill: '', tool: 'mcp: ripgrep.search', prompt: '', ms: 3800 },
  { phase: 'tool', action: '执行构建脚本', context: ['任务：重构用户登录模块', '进度：跑 npm run build'], skill: '', tool: 'bash: npm run build', prompt: '', ms: 4000 },
  { phase: 'dispatch', action: '正在召唤 Coder 专家', target: 'A1', context: ['任务：重构用户登录模块', '委托：Coder 改写登录逻辑'], skill: 'delegate（委托专家）', tool: '', prompt: '', ms: 5200 },
  { phase: 'tool', action: '正在读取 src/auth/session.js', context: ['任务：重构用户登录模块', '进度：已读取 5 个文件'], skill: '', tool: 'mcp: filesystem.read_file', prompt: '', ms: 3600 },
  { phase: 'dispatch', action: '正在召唤 Tester 专家', target: 'B1', context: ['任务：重构用户登录模块', '委托：Tester 补登录用例'], skill: 'delegate（委托专家）', tool: '', prompt: '', ms: 4800 },
  { phase: 'await', action: '申请写入 renderer/vite.config.js', target: 'renderer/vite.config.js', context: ['等待用户授权后继续', '原因：修改构建基路径 base'], skill: '', tool: 'mcp: filesystem.write_file', prompt: '', ms: 5000 },
  { phase: 'done', action: '任务完成', context: ['任务：重构用户登录模块', '已交付：登录链路重构', '改动 3 个文件'], skill: '', tool: '', prompt: '', ms: 5000 },
];

// 命令类工具（Bash / Shell / 终端 …）不再额外提示"需要授权"：既不写进 context，也不改相位文案
// （见 consolePhaseLabel）—— 写进 context 会顺着 enterDone 的"沿用最后上下文"漏到「任务完成」上。

/** 定时器放在 store 外面：它不属于"状态"，也没必要进 devtools */
let timer = null;
let stopTimer = null;

export const useMainAgentStore = defineStore('mainAgent', {
  state: () => ({
    idx: 0,
    /** true = 演示脚本正在自动推进。**默认不开**：演示脚本只在演示模式下由视图显式 start()
     *  （见 IsoOfficeView 的 startDemoScript）；真数据源首屏应当停在待命，等会话 / hook 接管。 */
    auto: false,
    /** true = 状态来自真实会话（插件落盘，阶段是推断的），mock 不推进 */
    live: false,
    /** true = 当前由 hook 实时上报驱动（reporter 把 busy/idle/offline/blocked 发给服务端） */
    hookLive: false,
    /** 最近一次 hook 喂进来的成员卡（仅用于 HUD/调试，不直接驱动画法） */
    liveMember: null,
    phase: 'idle',
    action: '',
    skill: '',
    tool: '',
    context: [],
    target: null,
    /** 主 Agent 收到的 prompt 原文（思考中时显示在屏幕） */
    prompt: '',
  }),

  getters: {
    /** 交给引擎的那一份：新对象，watch 才收得到变化 */
    snapshot: (s) => ({ phase: s.phase, action: s.action, skill: s.skill, tool: s.tool, context: s.context, target: s.target, prompt: s.prompt }),
    /** tooltip 第一行：与屏上第一行同源（consolePhaseLabel），调用工具一律显示「调用工具」 */
    phaseLabel: (s) => consolePhaseLabel(s),
    phaseColor: (s) => (PHASES[s.phase] || PHASES.idle).color,
  },

  actions: {
    /** 把脚本第 i 步搬到 state 上 */
    apply(i = this.idx) {
      this.idx = ((i % SCRIPT.length) + SCRIPT.length) % SCRIPT.length;
      const step = SCRIPT[this.idx];
      this.phase = step.phase;
      this.action = step.action || '';
      this.skill = step.skill || '';
      this.tool = step.tool || '';
      // 点2：mock 里工具若是 Bash/Shell 类（`bash: npm run build`），相位照旧是 tool，
      // 文案也照旧是「调用工具」（不再按工具名换「需要授权」），context 保持原样。
      this.context = step.context || [];
      this.target = step.target || null;
      this.prompt = step.prompt || '';
    },

    /** 按当前步的时长排下一步（暂停时不排） */
    advance() {
      clearTimeout(timer);
      timer = null;
      if (!this.auto) return;
      timer = setTimeout(() => {
        this.apply(this.idx + 1);
        this.advance();
      }, SCRIPT[this.idx].ms);
    },

    start() {
      this.auto = true;
      this.apply();
      this.advance();
    },

    /**
     * 演示模式：把控制台**抢回来**交给脚本。
     *
     * 与 start() 的区别就在这里：必须先把 live / hookLive 清掉。那两个标志的意思是
     * "真会话正在接管" —— 演示期间下拉里往往还选着一条真会话，快轮询每 1.5s 就会把它的
     * 相位喂进来（演示时通常就是「待命中」），于是：
     *   ① startDemoScript() 被 live 挡住，脚本根本起不来；
     *   ② 就算起来了，下一步立刻被那条真会话的相位顶掉。
     * 现象就是"点了演示模式，主 Agent 停在待命不动"。清干净之后由脚本一路演。
     */
    startDemo() {
      this.live = false;
      this.hookLive = false;
      this.liveMember = null;
      clearTimeout(stopTimer);
      stopTimer = null;
      this.start();
    },

    /** 手动停止 mock：先亮出"已暂停"摘要，10s 后退回待命 */
    stop() {
      this.auto = false;
      clearTimeout(timer);
      timer = null;
      this.enterPause(t('console.paused'));
    },

    /** 手动跳一步（暂停状态下也能点，用来一个个阶段对着看） */
    next() {
      this.apply(this.idx + 1);
      if (this.auto) this.advance();
    },

    setAuto(v) {
      if (v) this.start();
      else this.stop();
    },

    /**
     * 用 reporter hook 实时上报的成员卡驱动主控制台。hook 不发事件时 s 传 null，
     * 这时若之前是 hook 在驱动：先亮出"任务完成"摘要 10s，再退回待命（不直接回脚本）。
     *
     * 阶段映射（hook 的 AGENT_STATES -> 主控制台 PHASES）：
     *   busy    -> tool  （调用工具 / 干活中）
     *             命令类工具（Bash/Shell）也一样是 tool：插件不发"等授权 / 授权结束"通知，
     *             标成 await 就再没有事件能把它清掉。相位文案一律「调用工具」，不按工具名换
     *             （见 iso/mainConsole.js 的 consolePhaseLabel），action（操作）仍是实际命令。
     *   blocked -> await（等用户授权；工具与目标走会话落盘的 await 叠加）
     *             注：await 相位仍然只认服务端给的真值（Notification 等授权 -> await，
     *             授权结束 -> 回落其它相位），渲染层不自己推断。
     *   idle / online / offline -> idle（offline 对应"关掉 VS Code 还显示规划中"的修复）
     * @param {null|{phase:string, action?:string, context?:string[], target?:any, prompt?:string}} s
     */
    setLiveState(s) {
      // 收尾概要（done「任务完成」/ cancelled「任务取消」）展示期间，忽略回落的
      // idle/offline/null，等 10s 定时器退回待命；新的活跃事件（tool/thinking…）仍会覆盖它。
      if ((this.phase === 'done' || this.phase === 'cancelled') && (!s || s.phase === 'idle' || s.phase === 'offline')) return;
      if (!s) {
        if (this.hookLive) {
          this.hookLive = false;
          // 任务完成：亮出"任务完成"概要（沿用最后上下文：本次改动的文件等），10s 后退回待命
          this.enterDone(t('console.done_wait'), this.context && this.context.length ? this.context.slice() : [t('console.this_task_done')]);
        }
        this.liveMember = null;
        return;
      }
      this.auto = false;
      clearTimeout(timer);
      timer = null;
      this.hookLive = true;
      this.liveMember = s;
      // s.phase 已是 UI 相位（thinking / tool / await / idle …）或 hook 原始状态（busy / blocked）。
      // 之前这里把 thinking / tool 等非 busy/blocked 一律归成 idle，导致：
      //  - UserPromptSubmit 进入的「思考中」被吞成「待命」；
      //  - 正在调工具时相位被压成「待命」，action 却还留着上一条工具命令
      //    （图上"待命中却显示 Bash diff"就是这么来的）。
      // 相位一律采用服务端映射好的真值：busy -> tool、blocked -> await。
      // 命令类工具（Bash）不再在这里被改写成 await —— 插件没有"授权结束"通知，
      // 改写后没有任何事件能把它清掉，主控制台会一直卡在「等待授权」。
      const hookPhase = s.phase || 'idle';
      let phase;
      if (hookPhase === 'busy') {
        phase = 'tool';
      } else if (hookPhase === 'blocked') {
        phase = 'await';
      } else if (PHASES[hookPhase]) {
        phase = hookPhase;
      } else {
        phase = 'idle';
      }
      this.phase = phase;
      this.action = s.action || '';
      this.skill = s.skill || '';
      this.tool = s.tool || '';
      this.target = s.target || null;
      this.context = Array.isArray(s.context) ? s.context : [];
      this.prompt = s.prompt || '';
    },

    /**
     * 会话接管：下拉里选了某个会话，控制台就显示**这个会话**的状态。
     * 真源是插件落盘，阶段是按 runtime + 待办 + 文件改动推出来的（inferred），
     * 所以 mock 的自动推进要停下来，别跟真数据打架。会话取消（s=null）时：
     * 先亮出"任务完成"摘要 10s，再退回待命。
     * @param {null|{phase?:string, action?:string, context?:string[], prompt?:string}} s 会话；null = 交还给演示脚本
     */
    applySession(s) {
      if (!s) {
        if (!this.live) return; // 本来就在跑脚本，别打搅
        this.live = false;
        // 会话取消：亮出"任务完成"概要（沿用最后上下文），10s 后退回待命
        this.enterDone(t('console.done_wait'), this.context && this.context.length ? this.context.slice() : [t('console.this_task_done')]);
        return;
      }
      this.auto = false;
      clearTimeout(timer);
      timer = null;
      this.live = true;
      this.phase = s.phase || 'idle';
      this.action = s.action || '';
      this.skill = s.skill || '';
      this.tool = s.tool || '';
      this.target = s.target || null;
      this.context = Array.isArray(s.context) ? s.context : [];
      this.prompt = s.prompt || '';
    },

    /**
     * 任务完成：亮出"任务完成"状态（done 阶段）并带上完成概要（context），
     * 持续 10s；期间若有新事件（setLiveState/applySession 收到非 null）会被覆盖，
     * 否则 10s 后退回待命(idle)。
     * @param {string} summary 第二层动作文案（默认"任务完成 · 等待下一步"）
     * @param {string[]} [context] 第三层完成概要（如本次改动的文件、已交付的子任务）
     */
    enterDone(summary = t('console.done_wait'), context = []) {
      this.enterFinish('done', summary || t('console.done_wait'), context);
    },

    /**
     * 任务取消：用户按了 ESC / 停止，这一轮没干完就被掐掉。
     *
     * 与 enterDone 唯一的区别是相位（cancelled，红色「任务取消」）——
     * 同样亮 10s 再退回待命，期间的覆盖规则也完全一致（见 setLiveState 那一处守卫）。
     * @param {string} summary 第二层动作文案
     * @param {string[]} [context] 第三层概要：取消前改过的文件；一个都没动就写「没有输出」
     */
    enterCancelled(summary = t('console.cancelled_wait'), context = []) {
      this.enterFinish('cancelled', summary || t('console.cancelled_wait'), context);
    },

    /**
     * 收尾相位的共同部分（done / cancelled 都走这里）：停掉 mock、清掉工具名与 prompt、
     * 亮 10s 再退回待命。
     * 收尾相位把工具名与 prompt 一起清掉：这轮已经结束，别把上一轮的工具名留在状态里。
     * @param {'done'|'cancelled'} phase 收尾相位
     * @param {string} summary 第二层动作文案
     * @param {string[]} context 第三层概要
     */
    enterFinish(phase, summary, context = []) {
      clearTimeout(stopTimer);
      this.phase = phase;
      this.action = summary;
      this.context = Array.isArray(context) ? context : [];
      this.tool = '';
      this.prompt = '';
      stopTimer = setTimeout(() => {
        this.phase = 'idle';
        this.action = '';
        this.context = [];
        this.prompt = '';
      }, 10000);
    },

    /**
     * 没有会话（切到了一个没有活跃会话的楼层）：控制台回到待命。
     * 与 applySession(null)（会话取消 → 亮"任务完成"摘要）分开：空楼层跟"上一层收工"
     * 没关系，弹"任务完成"是拿别人的收尾信号冒充这层的状态。
     * @param {string[]} [context] 待命时屏上第三层显示的话
     */
    enterIdle(context = []) {
      this.auto = false;
      clearTimeout(timer);
      timer = null;
      clearTimeout(stopTimer);
      stopTimer = null;
      this.live = false;
      this.hookLive = false;
      this.liveMember = null;
      this.phase = 'idle';
      this.action = '';
      this.skill = '';
      this.tool = '';
      this.target = null;
      this.context = Array.isArray(context) ? context.slice() : [];
      this.prompt = '';
    },

    /**
     * 手动暂停演示：亮出"已暂停"提示，持续 10s 后退回待命。
     *
     * 相位用 idle（「待命中」）而不是另造一个：暂停就是"没在干活"，屏上第一行写「待命中」
     * 是对的；"已暂停"这三个字写在 tooltip 的操作行上。以前借 summarize（「汇总中」）
     * 当暂停的相位，看着像真有个"汇总"阶段（2026-10-01 去掉，见 iso/mainConsole.js 的 PHASES）。
     */
    enterPause(summary = t('console.paused')) {
      clearTimeout(stopTimer);
      this.phase = 'idle';
      this.action = summary;
      this.context = [];
      this.tool = '';
      this.prompt = '';
      stopTimer = setTimeout(() => {
        this.phase = 'idle';
        this.action = '';
        this.context = [];
        this.prompt = '';
      }, 10000);
    },
  },
});

export { SCRIPT as MAIN_AGENT_SCRIPT };

// 让 store 支持 HMR：改本文件时 Pinia 会热替换 store 实例的 actions/state，
// 否则运行中的实例仍是旧版本（例如没有新加的 enterDone），调用即报错。
if (import.meta.hot) {
  acceptHMRUpdate(useMainAgentStore, import.meta.hot);
}
