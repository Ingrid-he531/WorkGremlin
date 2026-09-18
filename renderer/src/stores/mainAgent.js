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
 *   2) 调用工具若是 Bash/Shell 类，状态按 await（等待授权）而不是 tool；
 *   3) 会话停止（setLiveState/applySession 收到 null，或手动 stop）时，先亮出
 *      "任务完成/已暂停" 摘要（summarize）持续 10s，期间无新事件则退回待命(idle)。
 */

import { defineStore } from 'pinia';
import { PHASES } from '../iso/mainConsole';

/** 一轮主会话的演示脚本：阶段 / 第二层动作 / 第三层上下文 / 停留时长 / 调度目标工位 */
const SCRIPT = [
  { phase: 'idle', action: '', context: ['等待派单'], skill: '', tool: '', prompt: '', ms: 6000 },
  { phase: 'plan', action: '正在拆解任务', context: ['任务：重构用户登录模块', '目标：拆成 3 个子任务'], skill: 'planning（规划）', tool: '', prompt: '请帮我重构用户登录模块', ms: 5200 },
  { phase: 'thinking', action: '正在分析你的请求', context: ['任务：重构用户登录模块', '思考：先理清登录链路'], skill: 'reasoning（推理）', tool: '', prompt: '请帮我重构用户登录模块，先理清登录链路', ms: 4200 },
  { phase: 'tool', action: '正在读取 src/main.js', context: ['任务：重构用户登录模块', '进度：已读取 1 个文件'], skill: '', tool: 'mcp: filesystem.read_file', prompt: '', ms: 3800 },
  { phase: 'tool', action: '正在搜索 login 相关引用', context: ['任务：重构用户登录模块', '进度：已读取 3 个文件', '命中：7 处引用'], skill: '', tool: 'mcp: ripgrep.search', prompt: '', ms: 3800 },
  { phase: 'tool', action: '执行构建脚本', context: ['任务：重构用户登录模块', '进度：跑 npm run build'], skill: '', tool: 'bash: npm run build', prompt: '', ms: 4000 },
  { phase: 'dispatch', action: '正在召唤 Coder 专家', target: 'A1', context: ['任务：重构用户登录模块', '委托：Coder 改写登录逻辑'], skill: 'delegate（委托专家）', tool: '', prompt: '', ms: 5200 },
  { phase: 'tool', action: '正在读取 src/auth/session.js', context: ['任务：重构用户登录模块', '进度：已读取 5 个文件'], skill: '', tool: 'mcp: filesystem.read_file', prompt: '', ms: 3600 },
  { phase: 'dispatch', action: '正在召唤 Tester 专家', target: 'B1', context: ['任务：重构用户登录模块', '委托：Tester 补登录用例'], skill: 'delegate（委托专家）', tool: '', prompt: '', ms: 4800 },
  { phase: 'await', action: '申请写入 renderer/vite.config.js', target: 'renderer/vite.config.js', context: ['等待用户授权后继续', '原因：修改构建基路径 base'], skill: '', tool: 'mcp: filesystem.write_file', prompt: '', ms: 5000 },
  { phase: 'summarize', action: '正在汇总各专家结果', context: ['任务：重构用户登录模块', '已回收：2/2', '准备写入变更摘要'], skill: 'summarize（汇总）', tool: '', prompt: '', ms: 5000 },
];

/** 定时器放在 store 外面：它不属于"状态"，也没必要进 devtools */
let timer = null;
let stopTimer = null;

export const useMainAgentStore = defineStore('mainAgent', {
  state: () => ({
    idx: 0,
    auto: true,
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
    phaseLabel: (s) => (PHASES[s.phase] || PHASES.idle).label,
    phaseColor: (s) => (PHASES[s.phase] || PHASES.idle).color,
  },

  actions: {
    /** 把脚本第 i 步搬到 state 上 */
    apply(i = this.idx) {
      this.idx = ((i % SCRIPT.length) + SCRIPT.length) % SCRIPT.length;
      const step = SCRIPT[this.idx];
      this.phase = step.phase;
      // 点2：mock 里工具若是 Bash/Shell 类，同样按 await（等待授权）而不是 tool
      if (step.phase === 'tool' && /\b(bash|shell|terminal|sh|cmd|powershell|exec|zsh)\b/i.test(step.tool || '')) {
        this.phase = 'await';
      }
      this.action = step.action || '';
      this.skill = step.skill || '';
      this.tool = step.tool || '';
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

    /** 手动停止 mock：先亮出"已暂停"摘要，10s 后退回待命 */
    stop() {
      this.auto = false;
      clearTimeout(timer);
      timer = null;
      this.enterStopSummary('已暂停 · 等待下一步');
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
     *             但若工具是 Bash/Shell 类，按 await（等待授权）而不是 tool
     *   blocked -> await（等用户授权；工具与目标走会话落盘的 await 叠加）
     *   idle / online / offline -> idle（offline 对应"关掉 VS Code 还显示规划中"的修复）
     * @param {null|{phase:string, action?:string, context?:string[], target?:any, prompt?:string}} s
     */
    setLiveState(s) {
      if (!s) {
        if (this.hookLive) {
          this.hookLive = false;
          this.enterStopSummary('任务完成 · 等待下一步');
        }
        this.liveMember = null;
        return;
      }
      this.auto = false;
      clearTimeout(timer);
      timer = null;
      this.hookLive = true;
      this.liveMember = s;
      const hookPhase = s.phase || 'idle';
      let phase = 'idle';
      if (hookPhase === 'busy') {
        const tool = String(s.tool || '').toLowerCase();
        const isBash = /\b(bash|shell|terminal|sh|cmd|powershell|exec|zsh)\b/i.test(tool);
        phase = isBash ? 'await' : 'tool';
      } else if (hookPhase === 'blocked') {
        phase = 'await';
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
        this.enterStopSummary('任务完成 · 等待下一步');
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
     * 显示一段"完成 / 暂停"摘要（summarize 阶段），持续 10s；期间若有新事件
     * （setLiveState/applySession 收到非 null）会被覆盖，否则 10s 后退回待命(idle)。
     * @param {string} summary
     */
    enterStopSummary(summary) {
      clearTimeout(stopTimer);
      this.phase = 'summarize';
      this.action = summary || '任务完成 · 等待下一步';
      this.context = [];
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
