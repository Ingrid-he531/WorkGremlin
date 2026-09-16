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
 */

import { defineStore } from 'pinia';
import { PHASES } from '../iso/mainConsole';

/** 一轮主会话的演示脚本：阶段 / 第二层动作 / 第三层上下文 / 停留时长 / 调度目标工位 */
const SCRIPT = [
  { phase: 'idle', action: '', context: ['等待派单'], skill: '', tool: '', ms: 6000 },
  { phase: 'plan', action: '正在拆解任务', context: ['任务：重构用户登录模块', '目标：拆成 3 个子任务'], skill: 'planning（规划）', tool: '', ms: 5200 },
  { phase: 'tool', action: '正在读取 src/main.js', context: ['任务：重构用户登录模块', '进度：已读取 1 个文件'], skill: '', tool: 'mcp: filesystem.read_file', ms: 3800 },
  { phase: 'tool', action: '正在搜索 login 相关引用', context: ['任务：重构用户登录模块', '进度：已读取 3 个文件', '命中：7 处引用'], skill: '', tool: 'mcp: ripgrep.search', ms: 3800 },
  { phase: 'dispatch', action: '正在召唤 Coder 专家', target: 'A1', context: ['任务：重构用户登录模块', '委托：Coder 改写登录逻辑'], skill: 'delegate（委托专家）', tool: '', ms: 5200 },
  { phase: 'tool', action: '正在读取 src/auth/session.js', context: ['任务：重构用户登录模块', '进度：已读取 5 个文件'], skill: '', tool: 'mcp: filesystem.read_file', ms: 3600 },
  { phase: 'dispatch', action: '正在召唤 Tester 专家', target: 'B1', context: ['任务：重构用户登录模块', '委托：Tester 补登录用例'], skill: 'delegate（委托专家）', tool: '', ms: 4800 },
  { phase: 'summarize', action: '正在汇总各专家结果', context: ['任务：重构用户登录模块', '已回收：2/2', '准备写入变更摘要'], skill: 'summarize（汇总）', tool: '', ms: 5000 },
];

/** 定时器放在 store 外面：它不属于"状态"，也没必要进 devtools */
let timer = null;

export const useMainAgentStore = defineStore('mainAgent', {
  state: () => ({
    idx: 0,
    auto: true,
    /** true = 状态来自真实会话（插件落盘，阶段是推断的），mock 不推进 */
    live: false,
    phase: 'idle',
    action: '',
    skill: '',
    tool: '',
    context: [],
    target: null,
  }),

  getters: {
    /** 交给引擎的那一份：新对象，watch 才收得到变化 */
    snapshot: (s) => ({ phase: s.phase, action: s.action, skill: s.skill, tool: s.tool, context: s.context, target: s.target }),
    phaseLabel: (s) => (PHASES[s.phase] || PHASES.idle).label,
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
      this.context = step.context || [];
      this.target = step.target || null;
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

    stop() {
      this.auto = false;
      clearTimeout(timer);
      timer = null;
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
     * 会话接管：下拉里选了某个会话，控制台就显示**这个会话**的状态。
     * 真源是插件落盘，阶段是按 runtime + 待办 + 文件改动推出来的（inferred），
     * 所以 mock 的自动推进要停下来，别跟真数据打架。
     * @param {null|{phase?:string, action?:string, context?:string[]}} s 会话；null = 交还给演示脚本
     */
    applySession(s) {
      if (!s) {
        if (!this.live) return; // 本来就在跑脚本，别打搅
        this.live = false;
        if (this.auto) this.start();
        else this.apply();
        return;
      }
      this.stop();
      this.live = true;
      this.phase = s.phase || 'idle';
      this.action = s.action || '';
      this.skill = s.skill || '';
      this.tool = s.tool || '';
      this.context = Array.isArray(s.context) ? s.context : [];
      this.target = null;
    },
  },
});

export { SCRIPT as MAIN_AGENT_SCRIPT };
