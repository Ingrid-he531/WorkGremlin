/**
 * mainAgent.js —— state of the main Agent (Craft Agent).
 *
 * The console is driven by the selected session / hook data. The old in-browser demo SCRIPT was
 * removed: demo mode now gets its phase, action and context from the server's read-only provider,
 * exactly like a real session (see stores/demo.js and server/src/demo/provider.js).
 *
 * Phase values live in PHASES in iso/mainConsole.js.
 */

import { defineStore, acceptHMRUpdate } from 'pinia';
// The phase wording has a single implementation: the screen's first line and the tooltip's first line both go through
// consolePhaseLabel(), so changing the definition only touches that one place.
import { PHASES, consolePhaseLabel } from '../iso/mainConsole';
import { t } from '../i18n/index.js';

/** The wrap-up timer lives outside the store: it isn't "state", and there's no need to put it in devtools */
let stopTimer = null;

export const useMainAgentStore = defineStore('mainAgent', {
  state: () => ({
    /** true = state comes from a real / demo session (persisted by the server, phase is inferred) */
    live: false,
    /** true = currently driven by live hook reports (the reporter sends busy/idle/blocked to the server) */
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
    /**
     * Drive the main console from the member card reported live by the reporter hook. When the hook sends
     * no event, s is null; if the hook was driving before, first show a "task complete" summary for 10s,
     * then fall back to standby.
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
     *   idle / unreported / unknown -> idle
     * @param {null|{phase:string, action?:string, context?:string[], target?:any, prompt?:string}} s
     */
    setLiveState(s) {
      // While the wrap-up summary (done "task complete" / cancelled "task cancelled") is showing, ignore the falling-back
      // idle/null and wait for the 10s timer to return to standby; new active events still override it.
      if ((this.phase === 'done' || this.phase === 'cancelled') && (!s || s.phase === 'idle')) return;
      if (!s) {
        if (this.hookLive) {
          this.hookLive = false;
          // Task complete: show the "task complete" summary (reusing the last context: files changed this round, etc.), then fall back to standby after 10s
          this.enterDone(t('console.done_wait'), this.context && this.context.length ? this.context.slice() : [t('console.this_task_done')]);
        }
        this.liveMember = null;
        return;
      }
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
      } else if (PHASES[hookPhase] && !['idle', 'unreported', 'done', 'cancelled'].includes(hookPhase)) {
        // thinking / tool / await / dispatch / waiting: accept as-is
        // done / cancelled do not go through setLiveState —— the wrap-up is managed by watch's
        // enterDone/enterCancelled path (with the 10s stopTimer); consoleBase should not keep feeding done back, or it would pop up again when stopTimer expires
        phase = hookPhase;
      } else if (hookPhase === 'idle' || hookPhase === 'done' || hookPhase === 'cancelled') {
        // done/cancelled fed in from consoleBase is treated as idle: stopTimer already owns the 10s display window,
        // and once it expires the console should return to standby; consoleBase's taskState='done' must not keep pushing it back to "task complete".
        // idle is the definite state of the currently selected session; whether a task is still running is decided by that session's own taskState,
        // and it must not reuse the earlier thinking/tool, nor borrow another session's task state from the same floor.
        phase = 'idle';
      } else {
        phase = 'idle'; // unreported / unknown: no active state to display
      }
      this.phase = phase;
      // Coming back to "thinking": keep the previous status wording (the tool just being called / the user's prompt), don't blank it out;
      // only genuine standby (idle) clears it.
      if (phase === 'thinking' && hookPhase === 'idle') {
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
     * The source of truth is the plugin's persisted data, and the phase is derived from runtime + todos + file changes (inferred).
     * When the session is cancelled (s=null): first show a "task complete" summary for 10s, then fall back to standby.
     * @param {null|{phase?:string, action?:string, context?:string[], prompt?:string}} s session; null = the session ended
     */
    applySession(s) {
      if (!s) {
        if (!this.live) return;
        this.live = false;
        // Session cancelled: show the "task complete" summary (reusing the last context), then fall back to standby after 10s
        this.enterDone(t('console.done_wait'), this.context && this.context.length ? this.context.slice() : [t('console.this_task_done')]);
        return;
      }
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
     * The common part of the wrap-up phases (both done / cancelled go here): clear the tool name and prompt,
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

// Let the store support HMR: when this file changes, Pinia hot-swaps the store instance's actions/state,
// otherwise the running instance stays on the old version (e.g. missing the newly added enterDone) and calls error out.
if (import.meta.hot) {
  acceptHMRUpdate(useMainAgentStore, import.meta.hot);
}
