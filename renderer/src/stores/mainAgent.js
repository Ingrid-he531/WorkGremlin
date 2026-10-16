/**
 * mainAgent.js —— state of the main Agent (Craft Agent).
 *
 * Right now it runs a mock: it plays the SCRIPT step by step to get the console's three
 * layers and five visual states built out first. When the real hook is wired up later,
 * just swap advance/apply for event-driven updates:
 *   standby     ← no active events for a while
 *   running     ← PreToolUse / PostToolUse (the second layer writes things like "reading xxx.js")
 *   dispatching ← a subagent is detected being summoned (the third layer writes "delegated: xxx", target points at that workstation)
 *
 * Phase values live in PHASES in iso/mainConsole.js.
 *
 * Today's tweaks:
 *   1) While thinking, the screen's third layer pins the received prompt text to the very front;
 *   2) If a tool call is Bash/Shell-like: **no longer** treated as await (waiting for authorization) —— the plugin sends
 *      neither a "waiting for authorization" notification nor an "authorization finished" one, and command-like tools send
 *      no PostToolUse either, so once marked await nothing can ever clear it (you hit run and it keeps showing "waiting for authorization").
 *      Now the server always reports tool (tool call + actual command), and the render layer no longer swaps the wording by tool name:
 *      the screen's first line and the tooltip's first line both say "tool call" (see
 *      consolePhaseLabel in iso/mainConsole.js), the action stays the actual command, and the two never bleed into each other;
 *   3) When the session stops (setLiveState/applySession receives null, or a manual stop), first show
 *      a "task complete / paused" summary for 10s; if no new events arrive, fall back to standby (idle).
 *   4) 2026-10-01: the demo script no longer plays "planning"; the "paused" that `stop()` shows no longer borrows
 *      the summarize ("summarizing") phase —— those two phases never occur on the real thing, so they were removed
 *      from PHASES (see iso/mainConsole.js). Pausing is now just "standby + the action line reading 'paused'".
 */

import { defineStore, acceptHMRUpdate } from 'pinia';
// The phase wording has a single implementation: the screen's first line and the tooltip's first line both go through
// consolePhaseLabel(), so changing the definition only touches that one place.
import { PHASES, consolePhaseLabel } from '../iso/mainConsole';
import { t } from '../i18n/index.js';

/** Demo script for one main session round: phase / second-layer action / third-layer context / dwell time / dispatch target workstation */
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

// Command-like tools (Bash / Shell / terminal …) no longer add a "needs authorization" hint: it goes neither into
// context nor into the phase wording (see consolePhaseLabel) —— writing it into context would leak onto "task
// complete" via enterDone's "reuse the last context".

/** The timer lives outside the store: it isn't "state", and there's no need to put it in devtools */
let timer = null;
let stopTimer = null;

export const useMainAgentStore = defineStore('mainAgent', {
  state: () => ({
    idx: 0,
    /** true = the demo script is auto-advancing. **Off by default**: the demo script only runs when the view explicitly start()s it in demo mode
     *  (see startDemoScript in IsoOfficeView); with a real data source the first screen should sit at standby and wait for the session / hook to take over. */
    auto: false,
    /** true = state comes from a real session (persisted by the plugin, phase is inferred), so the mock does not advance */
    live: false,
    /** true = currently driven by live hook reports (the reporter sends busy/idle/offline/blocked to the server) */
    hookLive: false,
    /** The most recent member card fed in by the hook (used only for HUD/debugging, does not drive rendering directly) */
    liveMember: null,
    phase: 'idle',
    action: '',
    skill: '',
    tool: '',
    context: [],
    target: null,
    /** The raw prompt the main Agent received (shown on screen while thinking) */
    prompt: '',
  }),

  getters: {
    /** The copy handed to the engine: a new object, so watch can see the change */
    snapshot: (s) => ({ phase: s.phase, action: s.action, skill: s.skill, tool: s.tool, context: s.context, target: s.target, prompt: s.prompt }),
    /** Tooltip's first line: same source as the screen's first line (consolePhaseLabel); a tool call always shows "tool call" */
    phaseLabel: (s) => consolePhaseLabel(s),
    phaseColor: (s) => (PHASES[s.phase] || PHASES.idle).color,
  },

  actions: {
    /** Copy step i of the script onto state */
    apply(i = this.idx) {
      this.idx = ((i % SCRIPT.length) + SCRIPT.length) % SCRIPT.length;
      const step = SCRIPT[this.idx];
      this.phase = step.phase;
      this.action = step.action || '';
      this.skill = step.skill || '';
      this.tool = step.tool || '';
      // Point 2: in the mock, if a tool is Bash/Shell-like (`bash: npm run build`), the phase stays tool
      // and the wording stays "tool call" (no more swapping in "needs authorization" by tool name); context stays as-is.
      this.context = step.context || [];
      this.target = step.target || null;
      this.prompt = step.prompt || '';
    },

    /** Schedule the next step after the current step's dwell time (nothing scheduled while paused) */
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
     * Demo mode: **take the console back** and hand it to the script.
     *
     * This is where it differs from start(): live / hookLive must be cleared first. Those two flags mean
     * "a real session is taking over" —— during a demo the dropdown usually still has a real session selected,
     * and the fast poll feeds its phase in every 1.5s (during a demo that's usually "standby"), so:
     *   ① startDemoScript() is blocked by live and the script never starts;
     *   ② even if it starts, the next step is immediately overridden by that real session's phase.
     * The symptom is "you click demo mode and the main Agent sits at standby without moving". Once things are cleared, the script plays all the way through.
     */
    startDemo() {
      this.live = false;
      this.hookLive = false;
      this.liveMember = null;
      clearTimeout(stopTimer);
      stopTimer = null;
      this.start();
    },

    /** Stop the mock manually: first show a "paused" summary, then fall back to standby after 10s */
    stop() {
      this.auto = false;
      clearTimeout(timer);
      timer = null;
      this.enterPause(t('console.paused'));
    },

    /** Advance one step manually (clickable while paused too, to inspect the phases one by one) */
    next() {
      this.apply(this.idx + 1);
      if (this.auto) this.advance();
    },

    setAuto(v) {
      if (v) this.start();
      else this.stop();
    },

    /**
     * Drive the main console from the member card reported live by the reporter hook. When the hook sends
     * no event, s is null; if the hook was driving before, first show a "task complete" summary for 10s,
     * then fall back to standby (not straight back to the script).
     *
     * Phase mapping (hook's AGENT_STATES -> main console PHASES):
     *   busy    -> tool  (tool call / working)
     *             Command-like tools (Bash/Shell) are tool too: the plugin sends no "waiting for authorization /
     *             authorization finished" notification, so once marked await nothing can ever clear it. The phase
     *             wording is always "tool call", never swapped by tool name (see consolePhaseLabel in
     *             iso/mainConsole.js), and action stays the actual command.
     *   blocked -> await (waiting for user authorization; the tool and target come from the session's persisted await overlay)
     *             Note: the await phase still only trusts the true value from the server (an authorization Notification -> await,
     *             authorization finished -> fall back to another phase); the render layer does not infer it itself.
     *   idle / online / offline -> idle (offline corresponds to the fix for "close VS Code and it still shows planning")
     * @param {null|{phase:string, action?:string, context?:string[], target?:any, prompt?:string}} s
     */
    setLiveState(s) {
      // While the wrap-up summary (done "task complete" / cancelled "task cancelled") is showing, ignore the falling-back
      // idle/offline/null and wait for the 10s timer to return to standby; new active events (tool/thinking…) still override it.
      if ((this.phase === 'done' || this.phase === 'cancelled') && (!s || s.phase === 'idle' || s.phase === 'offline')) return;
      if (!s) {
        if (this.hookLive) {
          this.hookLive = false;
          // Task complete: show the "task complete" summary (reusing the last context: files changed this round, etc.), then fall back to standby after 10s
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
      // s.phase is already a UI phase (thinking / tool / await / idle …) or a raw hook state (busy / blocked).
      // This used to lump thinking / tool and other non-busy/blocked states into idle, which caused:
      //  - the "thinking" entered by UserPromptSubmit to be swallowed into "standby";
      //  - the phase to be squashed to "standby" while a tool was running, while action still held the previous tool command
      //    (that's where "shows standby but displays a Bash diff" on the map came from).
      // The phase always takes the true value mapped by the server: busy -> tool, blocked -> await.
      // Command-like tools (Bash) are no longer rewritten to await here —— the plugin has no "authorization finished" notification,
      // so after rewriting nothing could clear it and the main console would stay stuck on "waiting for authorization".
      const hookPhase = s.phase || 'idle';
      let phase;
      if (hookPhase === 'busy') {
        phase = 'tool';
      } else if (hookPhase === 'blocked') {
        phase = 'await';
      } else if (PHASES[hookPhase] && hookPhase !== 'idle' && hookPhase !== 'online' && hookPhase !== 'offline' && hookPhase !== 'unreported' && hookPhase !== 'done' && hookPhase !== 'cancelled') {
        // thinking / tool / await / dispatch / waiting: accept as-is
        // done / cancelled do not go through setLiveState —— the wrap-up is managed by watch's
        // enterDone/enterCancelled path (with the 10s stopTimer); consoleBase should not keep feeding done back, or it would pop up again when stopTimer expires
        phase = hookPhase;
      } else if (hookPhase === 'idle' || hookPhase === 'online' || hookPhase === 'done' || hookPhase === 'cancelled') {
        // done/cancelled fed in from consoleBase is treated as idle: stopTimer already owns the 10s display window,
        // and once it expires the console should return to standby; consoleBase's taskState='done' must not keep pushing it back to "task complete".
        // idle is the definite state of the currently selected session; whether a task is still running is decided by that session's own taskState,
        // and it must not reuse the earlier thinking/tool, nor borrow another session's task state from the same floor.
        phase = 'idle';
      } else {
        phase = 'idle'; // offline / unreported / unknown: genuinely not working
      }
      this.phase = phase;
      // Coming back to "thinking": keep the previous status wording (the tool just being called / the user's prompt), don't blank it out;
      // only genuine standby (idle) clears it.
      if (phase === 'thinking' && (hookPhase === 'idle' || hookPhase === 'online')) {
        this.action = s.action || this.action;
        this.context = Array.isArray(s.context) && s.context.length ? s.context : this.context;
        this.prompt = s.prompt || this.prompt;
      } else {
        this.action = s.action || '';
        this.context = Array.isArray(s.context) ? s.context : [];
        this.prompt = s.prompt || '';
      }
      this.skill = s.skill || '';
      this.tool = s.tool || '';
      this.target = s.target || null;
    },

    /**
     * Session takeover: once a session is selected in the dropdown, the console shows **that session's** state.
     * The source of truth is the plugin's persisted data, and the phase is derived from runtime + todos + file changes (inferred),
     * so the mock's auto-advance has to stop and not fight the real data. When the session is cancelled (s=null):
     * first show a "task complete" summary for 10s, then fall back to standby.
     * @param {null|{phase?:string, action?:string, context?:string[], prompt?:string}} s session; null = hand back to the demo script
     */
    applySession(s) {
      if (!s) {
        if (!this.live) return; // the script is already running, don't interrupt
        this.live = false;
        // Session cancelled: show the "task complete" summary (reusing the last context), then fall back to standby after 10s
        this.enterDone(t('console.done_wait'), this.context && this.context.length ? this.context.slice() : [t('console.this_task_done')]);
        return;
      }
      this.auto = false;
      clearTimeout(timer);
      timer = null;
      this.live = true;
      // done/cancelled are not set directly: switching back to a session, consoleBase feeds back
      // {phase:'done'} from sel.taskState='done', and setting it directly would skip stopTimer → stuck on "task complete" forever.
      // The wrap-up display is owned solely by watch's enterDone/enterCancelled path (with stopTimer).
      const sp = s.phase;
      this.phase = (sp === 'done' || sp === 'cancelled') ? 'idle' : (sp || 'idle');
      this.action = s.action || '';
      this.skill = s.skill || '';
      this.tool = s.tool || '';
      this.target = s.target || null;
      this.context = Array.isArray(s.context) ? s.context : [];
      this.prompt = s.prompt || '';
    },

    /**
     * Task complete: show the "task complete" state (done phase) with a completion summary (context),
     * for 10s; if a new event arrives (setLiveState/applySession receives non-null) it is overridden,
     * otherwise it falls back to standby (idle) after 10s.
     * @param {string} summary second-layer action wording (defaults to "task complete · waiting for the next step")
     * @param {string[]} [context] third-layer completion summary (e.g. files changed this round, sub-tasks delivered)
     */
    enterDone(summary = t('console.done_wait'), context = []) {
      this.enterFinish('done', summary || t('console.done_wait'), context);
    },

    /**
     * Task cancelled: the user pressed ESC / stop, and this round was cut off before finishing.
     *
     * The only difference from enterDone is the phase (cancelled, red "task cancelled") ——
     * it likewise shows for 10s then falls back to standby, with the exact same override rules (see that one guard in setLiveState).
     * @param {string} summary second-layer action wording
     * @param {string[]} [context] third-layer summary: files changed before the cancel; if none changed, writes "no output"
     */
    enterCancelled(summary = t('console.cancelled_wait'), context = []) {
      this.enterFinish('cancelled', summary || t('console.cancelled_wait'), context);
    },

    /**
     * The common part of the wrap-up phases (both done / cancelled go here): stop the mock, clear the tool name and prompt,
     * show for 10s then fall back to standby.
     * The wrap-up phase clears the tool name along with the prompt: this round is over, so don't leave the previous round's tool name in state.
     * @param {'done'|'cancelled'} phase wrap-up phase
     * @param {string} summary second-layer action wording
     * @param {string[]} context third-layer summary
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
     * No session (switched to a floor with no active session): the console returns to standby.
     * Kept separate from applySession(null) (session cancelled → show a "task complete" summary): an empty floor has
     * nothing to do with "the previous floor wrapped up", and popping "task complete" would pass off someone else's wrap-up signal as this floor's state.
     * @param {string[]} [context] the text shown on the screen's third layer while on standby
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
     * Pause the demo manually: show a "paused" hint, then fall back to standby after 10s.
     *
     * The phase is idle ("standby") rather than a new one of its own: pausing means "not working", so the screen's first line
     * reading "standby" is right; the words "paused" go on the tooltip's action line. It used to borrow summarize ("summarizing")
     * as the pause phase, which looked like there really was a "summarizing" stage (removed 2026-10-01, see PHASES in iso/mainConsole.js).
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

// Let the store support HMR: when this file changes, Pinia hot-swaps the store instance's actions/state,
// otherwise the running instance stays on the old version (e.g. missing the newly added enterDone) and calls error out.
if (import.meta.hot) {
  acceptHMRUpdate(useMainAgentStore, import.meta.hot);
}
