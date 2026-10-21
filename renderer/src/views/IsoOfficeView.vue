<script setup>
/**
 * IsoOfficeView —— 2.5D isometric office.
 *
 * The whole scene is drawn live on Canvas (see iso/); this view only:
 *   - translates store members into scene actors (experts seated at workstations / ephemeral members floating in the air)
 *   - HUD, task cards, interaction hints
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import WorkstationCard from '../components/WorkstationCard.vue';
import ConnectionBar from '../components/ConnectionBar.vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { useDemoStore } from '../stores/demo';
import { useMainAgentStore } from '../stores/mainAgent';
import { isEphemeralMember, projectLabelOf } from '../lib/ephemeral';
import { floorAcceptsClient } from '../lib/clientMatch';
import { busySubagentsOf } from '../lib/liveSubagents';
import { memberForSession, normalizeState, summonTaskTitle } from '../lib/memberTask';
import { httpBase, getServerInfo } from '../api/bridge';
import { createIsoOffice } from '../iso/engine';
import { useI18n } from '../i18n';

const props = defineProps({
  selectedId: { type: String, default: '' },
  /** Connection state and phase source (computed and passed down by App.vue), shown in the bottom-left caption bar.
      The project name is not handled here —— it hangs at the far left of the lintel, see projectLabel in ElevatorDoors */
  connection: { type: Object, default: () => ({ state: '' }) },
  source: { type: String, default: '' },
  /** Whether fullscreen (passed down by App.vue): decides whether the fullscreen button shows "Fullscreen" or "Exit fullscreen" */
  fullscreen: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'toggle-fullscreen']);

const project = useProjectStore();
const sessions = useSessionStore();
const demo = useDemoStore();
const mainAgent = useMainAgentStore();
/** Demo owns only the office roster; project data (task records, messages, workspace) stays real. */
const sourceMembers = computed(() => (demo.active ? demo.members : project.members));
const { t } = useI18n();
const wrapRef = ref(null);
const canvasRef = ref(null);

/* ------------------------------ Main Agent phase fast poll (1.5s) ------------------------------
 * The server's /api/v1/reporter-phase returns the phase reported by the reporter hook (already mapped to UI fields),
 * fresher than the 10s poll of /sessions, and is used solely for the main console's "action" realtime display (tool call / waiting for authorization).
 * The renderer is sandboxed (contextIsolation + nodeIntegration:false) and cannot read local state files,
 * so it always goes through the server, reusing the tolerant read of readReporterPhase, never touching fs.
 */
const fastPhase = ref(null);
let phaseTimer = null;

async function startPhasePoll() {
  const info0 = await getServerInfo().catch(() => ({ port: 0, token: '' }));
  if (!info0 || !info0.port) return;
  const tick = async () => {
    try {
      // A server restart changes the token: fetch the **current** serverInfo every round (the project store
      // already refreshed it from server.json on WS reconnect), never hard-bake the startup token into the closure ——
      // baking it in means a 401 every 1.5s and the phase and "action" stuck on old values forever (same as the api/ws.js regression).
      const info = project.serverInfo || info0;
      // Reporter phases are scoped by one bare floor base name. CLI and plugin forms of a floor share it.
      const want = sessions.selectedClient;
      const params = [];
      if (want) params.push(`client=${encodeURIComponent(want)}`);
      // Also pass the selected session's session id (axis 2): several sessions can be open under one client
      // (e.g. two Claude Code terminals on the same floor); keying only on client shows "whoever is newest" and cross-contaminates.
      // Products with no session id (Codex / plugins) simply have no such param here → the server falls back to the old behavior.
      const wantSession = sessions.selectedSessionId;
      if (wantSession) params.push(`session=${encodeURIComponent(wantSession)}`);
      const qs = params.length ? `?${params.join('&')}` : '';
      const res = await fetch(`${httpBase(info)}/api/v1/reporter-phase${qs}`, {
        headers: info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.ok) {
          // The phase may be empty (round ended / no action right now), but instrumented must be kept:
          // the renderer uses it to tell "this project has no hook at all" from "it has one, it is just idle right now".
          fastPhase.value = {
            phase: d.phase && d.phase !== 'idle' ? d.phase : null,
            action: d.action || '',
            target: d.target || null,
            context: d.context || [],
            tool: d.tool || '',
            prompt: d.prompt || '',
            workspacePath: d.workspacePath || '',
            instrumented: Boolean(d.instrumented),
            // Which session this state belongs to (the hook is loaded per session, see sameSession in consoleBase)
            sessionId: d.sessionId || '',
            // When this phase was written: compared against the wrap-up marker for ordering (see the guard in consoleLive below)
            phaseTs: Number(d.ts) || 0,
            // The previous round's done marker (CLI floors light "Task done" with it; Codex also carries a wrap-up note)
            done: d.done || null,
          };
        }
      }
    } catch {
      /* If the fetch fails, keep the previous phase and never flash back to idle */
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

/* ------------------------------ Main Agent console tooltip ------------------------------
 * Only pops after the mouse rests on the floating screen (hover hit) longer than TIP_DELAY, so dragging / sweeping past does not flash it.
 * Content comes from the main Agent store: what it is doing + skill name + MCP tool info (all fed in by setMainAgent).
 */
const TIP_DELAY = 400;
const tip = ref({ show: false, x: 0, y: 0 });
let tipTimer = null;

/* ------------------------------ Gremlin tooltip ------------------------------
 * Only pops after the mouse rests on a gremlin (or the ghost above its head) for 400ms: shows **the task it is doing**
 * plus the most recent completed result —— a ghost keeps only its name overhead; task and result are both told here.
 */
const mtip = ref({ show: false, x: 0, y: 0, id: '' });
let mtipTimer = null;

function clearMTip() {
  if (mtipTimer) {
    clearTimeout(mtipTimer);
    mtipTimer = null;
  }
  mtip.value.show = false;
  mtip.value.id = '';
}

const mtipMember = computed(() =>
  mtip.value.id ? sourceMembers.value.find((m) => m.memberId === mtip.value.id) : null
);
/**
 * Task text: an ephemeral member (ghost) is a string, a workstation gremlin is { title }.
 *
 * While summoned the task is written only on the **ghost** (the server assigns the task to subagent-xxx; the resident
 * gremlin at the workstation has no task of its own). So this falls back to the same-named ghost: hovering a **gremlin**
 * shows what it is doing for the main agent. The ghost itself still gets no tooltip (see memberAt in the engine); only its name stays overhead.
 */
const mtipTask = computed(() => {
  const m = mtipMember.value;
  if (!m) return '';
  // The "current task" definition matches the workstation card (see lib/memberTask.summonTaskTitle): when the gremlin itself has no running task,
  // borrow the same-named ghost dispatched by this summon (only while it really is running) —— the same implementation as the workstation card.
  return summonTaskTitle(m, sourceMembers.value, sessions.selectedSessionId);
});
/** The most recent completed result (recorded by the engine when the report animation finishes) */
const mtipResult = computed(() => (mtip.value.id && office ? office.lastResult(mtip.value.id) : null));

function clearTip() {
  if (tipTimer) {
    clearTimeout(tipTimer);
    tipTimer = null;
  }
  tip.value.show = false;
}

function onConsoleMove(e) {
  if (!office || !canvasRef.value) return;
  // No tooltip while a button is held dragging (that pans the view, not inspecting info)
  if (e.buttons) {
    clearTip();
    clearMTip();
    return;
  }
  const r = canvasRef.value.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  // First check whether it rests on some member: if so pop "its" tooltip and yield the main console one
  const hit = office.memberAt(px, py);
  if (hit) {
    clearTip();
    mtip.value.id = hit;
    mtip.value.x = e.clientX;
    mtip.value.y = e.clientY;
    if (!mtipTimer) mtipTimer = setTimeout(() => { mtip.value.show = true; }, TIP_DELAY);
    return;
  }
  clearMTip();
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
  clearMTip();
}

/** Main Agent console: currently fed mock stage state; switching to hook events needs no change here */
const mainAgentState = computed(() => mainAgent.snapshot);

/** Wrap-up phase (task done / task cancelled): the tooltip lists "output summary" instead of action */
const isFinishPhase = computed(() => mainAgent.phase === 'done' || mainAgent.phase === 'cancelled');

/** Byte count -> human readable (B / KB / MB), the same display as the task records page */
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Whether two project paths are the same (compare after trimming trailing slashes; either empty means "unrestricted", returns true) */
function sameWorkspace(a, b) {
  const na = String(a || '').replace(/\/+$/, '');
  const nb = String(b || '').replace(/\/+$/, '');
  return !na || !nb || na === nb;
}

/**
 * Whether the selected session itself is "running" (the taskState synthesized uniformly by the server: a fresh realtime phase on this floor = running).
 * The lintel scroll screen and the main console read the **same** field, so the two can no longer disagree.
 */
const floorTaskActive = computed(() => {
  const sel = sessions.selected;
  return Boolean(sel && sel.taskState === 'running');
});

/**
 * The main console strictly follows the session selected in the dropdown: it shows "this session's own" phase
 * (the real value reported by its own project's reporter, or the value inferred from disk), never impersonating with another project's realtime phase.
 * So with several projects open at once, switching the dropdown to a session shows that one, matching the selected session one-to-one.
 */
const consoleBase = computed(() => {
  const sel = sessions.selected;
  if (!sel) return null;
  // For a finished (cancelled / done) task: light the end state first, never let a leftover "tool call" from the fast poll cover it.
  // Observed: after the user hits stop the reporter has not written Stop yet, or the realtime phase still sits on tool; if fastPhase is allowed through it would
  // jump from "task cancelled" back to "tool call" and stick; but taskState is already cancelled / done (no in-flight task on this floor),
  // so the end state should show steadily. Once a new round starts and this floor is running again, taskState returns to running and this no longer intercepts.
  if (sel.taskState === 'cancelled' || sel.taskState === 'done' || sel.phase === 'cancelled' || sel.phase === 'done') {
    const finished = sel.taskState === 'done' || sel.phase === 'done' ? 'done' : 'cancelled';
    return { phase: finished, action: '', context: [], target: null, tool: '', prompt: '' };
  }
  // The selected one is exactly the "globally typing right now" session (fresh): layer on the 1.5s fast poll's realtime phase,
  // making "tool call / waiting for authorization" more responsive (fresher than the 10s session poll). Other sessions (even their own project's
  // current=true) use only their own session poll data, never borrowed global realtime phase —— otherwise switching back to an old session would wrongly show the new project's "tool call".
  // Plus a "project ownership" check: the fast poll phase carries back its project (workspacePath); only layer it on when the selected session
  // belongs to exactly that project. Otherwise, after a project switch, the old session's fresh has not been refreshed yet (session snapshot lags)
  // and the new project's "thinking" briefly covers the old session —— the symptom is the old session flashing "thinking" then falling back to "idle".
  const fp = fastPhase.value;
  const sameWs = Boolean(fp) && sameWorkspace(fp.workspacePath, sel.projectPath);
  // The **session id** of the selected session (axis 2): both "does this report belong to the session you are viewing" checks below compare against it exactly.
  // If unavailable (Codex / plugins) it is an empty string → the related checks pass, falling back to the old behavior.
  const selSessionId = sel.sessionId || '';
  // The hook state file belongs to **one particular session** (the hook is loaded when the session starts). Sharing a project is not enough ——
  // observed: an old session opened at 13:40 has no hook, but codex exec ran in the same project so the state file exists,
  // and this session ended up shown as "standby", looking like "a whole conversation with no state change".
  // So it must also confirm "the reported session == the one you are viewing".
  // Compare session ids **exactly** (the server returns the sessionId from the state file, i.e. the hook payload's session_id).
  // Previously it took sel.id and did includes(fp.sessionId): sel.id is a **disk locator** (for CLI it is the relative path
  // `<project dir>/<session>.jsonl`), and substring matching can both miss and mismatch. Now with real session ids on both sides it is a direct equality check.
  // If either side lacks a session id (Codex rollout file names have no session_id, old state files) → lenient pass-through, keeping the old behavior.
  const sameSession = Boolean(fp) && (!fp.sessionId || !selSessionId || fp.sessionId === selSessionId);
  // All four hook-source forms (plugin/cli/ide/desktop) should pass the fast poll phase; cli/ide/desktop are no longer hardcoded into two branches.
  // plugin has a fresh flag (set by handlePlugin), cli/ide are the two paths that write the hook to disk (handleCliHook),
  // and both share "the reporter hook is wired up, the realtime phase comes from the /reporter-phase fast poll".
  const isHookSource = Boolean(sel.fresh) || ['cli', 'ide', 'plugin', 'desktop'].includes(sel.source);
  const canUseFast = isHookSource && Boolean(sel.projectPath);
  if (canUseFast && sameWs && sameSession && fp.phase) {
    if (fp.phase === 'await') {
      return { phase: 'await', action: fp.action || t('console.await_action'), context: fp.context && fp.context.length ? fp.context : [t('console.await_hint')], target: fp.target || null, prompt: fp.prompt || '' };
    }
    if (fp.phase === 'tool') {
      return { phase: 'tool', action: fp.action || t('console.tool_action'), context: fp.context && fp.context.length ? fp.context : [], target: fp.target || null, tool: fp.tool || '', prompt: fp.prompt || '' };
    }
    // Thinking: put the user's sentence (prompt) into both the second layer (action) and the third layer.
    // The third layer on screen has a "only draw when the font is large enough" threshold (showL3 in mainConsole); when not zoomed in enough nothing shows;
    // the second layer has a lower threshold, so keeping a copy there guarantees the question you asked is always visible under "thinking".
    // Note: this uses only fields from the fast poll (1.5s, fresh), **never falling back to sel** —— the session snapshot may still be the previous round's,
    // and falling back to sel.action / sel.context would show "thinking but displaying the previous round's action" until corrected seconds later.
    if (fp.phase === 'thinking') {
      const p = fp.prompt || '';
      return { phase: 'thinking', action: fp.action || p, context: fp.context && fp.context.length ? fp.context : [], target: fp.target || null, prompt: p };
    }
  }
  // A project with the hook wired up (plugin/cli/ide): this floor has an in-flight task (floorTaskActive) but no realtime phase right now =
  // the round is still running, just temporarily producing no new event (thinking / waiting); show "thinking" rather than "standby".
  if (isHookSource && sameWs && sameSession && fp.instrumented) {
    if (floorTaskActive.value) {
      return { phase: 'thinking', action: '', context: [], target: null, tool: '', prompt: '' };
    }
    return { phase: 'idle', action: '', context: [], target: null, tool: '', prompt: '' };
  }
  const selPrompt = sel.phase === 'thinking' ? sel.prompt || '' : '';
  const phase = sel.phase || 'idle';
  // The session itself is idle / unreported (no realtime phase, inference also falls back to standby): as long as this floor really still has a running task
  // (same definition as the lintel scroll screen), show "thinking" —— the person is still in this round, just temporarily producing no new event;
  // only when there is no active task at all (wrapped up / empty floor) does it fall back to "standby".
  if ((phase === 'idle' || phase === 'unreported') && floorTaskActive.value) {
    return {
      phase: 'thinking',
      action: sel.action || '',
      context: sel.context && sel.context.length ? sel.context : [],
      target: sel.target || null,
      tool: sel.tool || '',
      prompt: sel.prompt || '',
    };
  }
  // Otherwise use the selected session's own phase directly (the reporter's real value if it is active, otherwise inferred),
  // so switching the dropdown to an old project's session shows that session's own state, no longer covered by the new project's realtime phase.
  return {
    phase,
    action: sel.action || selPrompt,
    context: sel.context && sel.context.length ? sel.context : [],
    target: sel.target || null,
    tool: sel.tool || '',
    prompt: sel.prompt || '',
  };
});

/**
 * Subagents currently doing work for the main agent (the ghosts floating in the office).
 *
 * This reads the same member source as sceneMembers below but **does not reuse sceneMembers** ——
 * the consoleLive watch evaluates once during setup, when sceneMembers is not initialized yet (TDZ).
 * The filter definition stays consistent with sceneMembers (see liveSubagents): only ephemeral
 * members (ghosts) count, and they are scoped to the selected floor and session. Without the
 * floor scope a Codex ghost on 3F makes 8F (OpenCode, no task) report "waiting for subagent".
 */
const busySubagents = computed(() => {
  if (sessions.floorEmpty || !sessions.live) return [];
  return busySubagentsOf(sourceMembers.value, {
    client: sessions.selectedClient,
    sessionId: sessions.selectedSessionId,
  });
});

/**
 * The phase the main console finally feeds to the store = the session's own phase + the "waiting on subagents" layer.
 *
 * The main session has not received Stop yet (phase still idle) while subagents are already running in the office —— writing "standby"
 * here would be wrong: the person is clearly still in this round, just waiting for the gremlins to hand in. Give "waiting" separately, and say who it is waiting for.
 * After Stop arrives the phase becomes done and is no longer overridden here, so "task done → standby" still holds.
 */
const consoleLive = computed(() => {
  const v = consoleBase.value;
  const subs = busySubagents.value;
  if (subs.length && (!v || v.phase === 'idle')) {
    const names = [...new Set(subs.map((m) => m.name))].join('、');
    return {
      phase: 'waiting',
      action: t('console.waiting_subs', { names }),
      context: subs.slice(0, 3).map((m) => {
        const task = summonTaskTitle(m, sourceMembers.value, sessions.selectedSessionId);
        return task ? `${m.name}：${task}` : t('console.sub_running', { name: m.name });
      }),
      target: null,
      tool: '',
      prompt: '',
    };
  }
  return v;
});

/**
 * The sole source of truth for "task done" = the doneAt the reporter writes to disk on Stop (the server passes it through per project).
 * Never guess from "phase fell back to idle" —— polling gaps / cross-project contamination would trigger it falsely,
 * popping "task done" mid-task. And it only pops when doneAt truly changes (a new Stop arrives),
 * so switching to a long-finished old session does not misfire.
 */
let lastConsoleSessionId = undefined;
let lastDoneAt = undefined;
/** Whether the "done marker brought back by the fast poll" has been seen: the first time it is only a baseline, no summary pops (see the comment below) */
let seenFastDone = false;
/**
 * A deferred wrap-up: the task is done (real data reported Stop first) but the office still has a
 * summon / report animation to finish. Stash it here and only light up "Task done / Task cancelled"
 * once the beats drain (engine.whenFlowIdle). If a new task comes in meanwhile, drop it (the previous
 * round's wrap-up must not smother the new task).
 */
let pendingDone = null;
let pendingDoneTimer = 0;
/** Safety cap for waiting on the office animation (ms): never leave the main phase stuck on "waiting" */
const FLOW_WAIT_MAX = 15000;
/**
 * The office engine instance. Must be declared before the consoleLive watch below (immediate): that
 * callback references it (to defer the wrap-up until after the animation), and accessing it in the
 * TDZ would throw.
 * @type {ReturnType<typeof createIsoOffice> | null}
 */
let office = null;
/** When the page (this view) opened = the initial value of trackSince below */
const PAGE_OPEN_AT = Date.now();
/**
 * When we **started watching the current session**: on page open = PAGE_OPEN_AT, refreshed on session / floor switch.
 *   · A done marker earlier than it = wrapped up before we started watching → only a baseline, no summary pops;
 *   · later than it = a Stop truly received while watching → "Task done" must pop.
 *
 * Why the constant from page open cannot be the ruler: when switching floors the fast poll still holds the **previous floor's** data
 * (it only refreshes every 1.5s), so "first seeing the new floor's done marker" necessarily happens after the switch, and that marker is
 * usually later than page open —— measuring against the open time would always judge it a "newly occurred Stop".
 * Observed: switching 1F to 3F pops "Task done" immediately on entry, falling back to "standby" seconds later, reproduced on every switch.
 */
let trackSince = PAGE_OPEN_AT;
watch(
  consoleLive,
  (v) => {
    const sel = sessions.selected;
    const selId = sel ? sel.id : null;
    // The done marker has two sources; take the **newer** one: ① the session snapshot's doneAt (one per 10s, present on every floor;
    // plugin floors compute it from plugin disk writes, CLI / hookSource floors take it from the server reading the same hook state);
    // ② the hook fast poll's done (one per 1.5s). Use max rather than `||`: the snapshot one can be up to 10 seconds old,
    // letting it cover a freshly received Stop would delay "Task done"; conversely, when the fast poll lacks this session the marker is not lost.
    //
    // Two rules (both learned the hard way):
    //   ① It is the **persistent state** of "some session's previous round ending", not a one-off event —— on just opening the page / just switching floors
    //      the first read can only be a baseline, otherwise the previous completion summary is replayed as if it just happened
    //      (observed: opening 3F pops "Task done", falling back to standby 10 seconds later);
    //   ② A floor can have several sessions open at once, so it is stored per "project + client + session", and the display targets the
    //      **selected session**; it must also confirm this completion belongs to the current session (exact session id comparison, as above).
    const fpDone = fastPhase.value && fastPhase.value.done;
    const doneSessionId = (sel && sel.sessionId) || '';
    const sameSession = !fpDone || !fpDone.sessionId || !doneSessionId || fpDone.sessionId === doneSessionId;
    const fastDoneAt = fpDone && fpDone.at && sameSession ? fpDone.at : 0;
    const firstFastDone = fastDoneAt > 0 && !seenFastDone;
    if (fastDoneAt > 0) seenFastDone = true;
    const doneAt = Math.max(Number(sel && sel.doneAt) || 0, fastDoneAt);
    // Session switched (or first time): switch the console straight to this session's current state, reset the done marker, no "task done" pop.
    // The office's workstation gremlins also follow the selected session: switching to another project's session switches to that project's member list,
    // so the whole "main Agent + gremlins" group follows the one selected in the dropdown, no longer stuck on the previously opened project.
    if (selId !== lastConsoleSessionId) {
      lastConsoleSessionId = selId;
      lastDoneAt = doneAt;
      seenFastDone = fastDoneAt > 0; // On session switch, re-baseline on this session's marker
      trackSince = Date.now(); // The "is the done marker new or old" ruler also switches to this session
      // Session switch = the previous round's wrap-up has nothing to do with this one: drop it
      pendingDone = null;
      clearTimeout(pendingDoneTimer);
      // Empty floor (no session at all): console standby; the office keeps only resident gremlins and clears ghosts
      // (see sceneMembers), but **does not go through applySession(null)** —— that is "session wrapped up" and
      // would pop "Task done", which has nothing to do with this floor.
      if (!sel && sessions.floorEmpty) {
        mainAgent.enterIdle([t('console.floor_empty')]);
        return;
      }
      mainAgent.applySession(v);
      // A real session can switch the viewed project. The virtual demo session has no
      // projectPath, so demo mode never triggers this path.
      if (sel && sel.projectPath && sel.projectPath !== project.workspacePath) {
        project.openWorkspace(sel.projectPath);
      }
      return;
    }
    // Waiting on wrap-up (the office is still playing this round's summon / report):
    //   - a genuinely new round (a phase newer than the Stop, or taskState running again) -> drop the
    //     wait and follow the new task;
    //   - everything else (stale pre-Stop phase or an inactive fallback) -> ignore, so the
    //     pending wrap-up is not overridden.
    if (pendingDone) {
      const fp = fastPhase.value;
      const phaseTs = Number(fp && fp.phaseTs) || 0;
      const active = v && ['thinking', 'tool', 'await', 'dispatch'].includes(v.phase);
      const newer = Boolean(phaseTs && phaseTs > lastDoneAt);
      const runningAgain = Boolean(sel && sel.taskState === 'running');
      if (active && (newer || runningAgain)) {
        pendingDone = null;
        clearTimeout(pendingDoneTimer);
      } else {
        return;
      }
    }
    // Same session: a Stop is received (doneAt added / changed) → light "task done", with the real completion content as the summary
    // This round is clearly still running (taskState==='running', judged by the server from in-flight tasks, which overrides the previous round's leftover doneAt):
    // do not pop a cancel/done summary, to avoid a new round flashing "task cancelled" first.
    // (the files changed this time), not the last phase context, and certainly not the user's prompt as the summary.
    // First read of the marker: earlier than trackSince (= started watching this session) only records a baseline (the previous round's wrap-up, not replayed);
    // anything later cannot be a baseline —— that is a Stop truly received while watching, so fall through to the normal summary-pop judgment below
    if (firstFastDone && doneAt < trackSince) lastDoneAt = doneAt;
    if (doneAt && doneAt !== lastDoneAt && !(sel && sel.taskState === 'running')) {
      lastDoneAt = doneAt;
      // Change list: prefer the session snapshot's doneFiles (the plugin/IDE floor one, with +/- line counts + size),
      // falling back to the reporter's on-disk done.files (the CLI path, size only). Plugin / IDE
      // file-changes on disk carry addedLines / removedLines, so +/- is shown here too;
      // the size is stat'ed live by the server (disk writes do not provide it) and shown when available.
      const snapFiles = (sel && sel.doneFiles) || [];
      const hookFiles = (fpDone && Array.isArray(fpDone.files) ? fpDone.files : []).map((p) => ({
        name: typeof p === 'string' ? p : (p && p.path) || '',
        size: typeof p === 'string' ? null : (p && typeof p.size === 'number' ? p.size : null),
      }));
      const files = snapFiles.length ? snapFiles : hookFiles;
      const count = (sel && Number(sel.doneCount)) || (fpDone && Number(fpDone.fileCount)) || files.length;
      const said = (fpDone && fpDone.said) || '';
      /* Whether this round "finished" or was "cut off": the sole proof is the cancel marker the reporter
         writes on Interrupt (done.cancelled), with the session snapshot one passed through by the server as doneCancelled.
         OR the two: the fast poll arrives in 1.5s, the session snapshot in 10s, whichever comes first counts ——
         without the snapshot one, the round would pop "Task done" before the cancel marker was brought back by the fast poll. */
      const cancelled = Boolean((fpDone && fpDone.cancelled) || (sel && sel.doneCancelled));
      // Show +X/-Y when +/- line counts are available (plugin / IDE path); show the volume (B/KB/MB) when size is available
      // Has output (this round touched files) → list which files changed; no file changes but has words (text emitted this round)
      // → show that sentence the way "Task done" does; write "no output" only when **neither** is present.
      // Cancel and done share the same definition here: cancelled just means "not finished", not "no output" —— a cut-off round often still
      // emits half a sentence and changes a few files, so record it; only when there is truly no output at all is "this task is complete" a lie.
      const ctx = files.length
        ? [
            t('console.files_changed', { n: count }),
            ...files.map((f) => {
              const nm = f && (f.name || f.path) || (typeof f === 'string' ? f : '');
              const bits = [];
              const add = f && Number.isFinite(f.added) ? f.added : null;
              const rm = f && Number.isFinite(f.removed) ? f.removed : null;
              if (add != null || rm != null) bits.push(`+${add || 0}/-${rm || 0}`);
              const sz = f && Number.isFinite(f.size) ? f.size : null;
              if (sz != null) bits.push(fmtSize(sz));
              return bits.length ? `${nm}  (${bits.join(' · ')})` : String(nm);
            }),
          ]
        : [said || (cancelled ? t('console.no_output') : t('console.this_task_done'))];
      const finish = () => {
        if (cancelled) mainAgent.enterCancelled(t('console.cancelled'), ctx);
        else mainAgent.enterDone(t('console.done'), ctx);
      };
      // When the task is fast, real data has already reported Stop but the office is still playing
      // "pick up task -> ghost appears -> report". Wait for the whole animation before lighting
      // "Task done / Task cancelled" so the arc is not swallowed (as long as no new task arrives).
      if (office && office.flowPending && office.flowPending()) {
        pendingDone = finish;
        clearTimeout(pendingDoneTimer);
        // Safety net: if the animation stalls, never leave the main phase stuck on "waiting"
        pendingDoneTimer = setTimeout(() => {
          const f = pendingDone;
          pendingDone = null;
          if (f) f();
        }, FLOW_WAIT_MAX);
        office.whenFlowIdle(() => {
          if (pendingDone !== finish) return; // dropped by a new task / session switch
          pendingDone = null;
          clearTimeout(pendingDoneTimer);
          finish();
        });
        return;
      }
      pendingDone = null;
      clearTimeout(pendingDoneTimer);
      finish();
      return;
    }
    // "Task cancelled / Task done" has just lit up; it must not be covered by the same round's leftover phase:
    // after Stop / Interrupt the hook clears the realtime phase (fastPhase.phase is null), but the 10s session snapshot
    // still sits on the pre-wrap-up "tool call" —— arriving a few seconds late it washes out the red/green flash (the order flipping to task done→tool call→standby).
    // Only intercept when "there is no realtime phase" or "the cancel marker is still there": a new round (after UserPromptSubmit the realtime phase is restored and done is cleared)
    // still overrides normally —— the user sent another task.
    // For products that do not interrupt events, like CodeBuddy IDE, after a cancel the phase still sits on "tool call" and the cancel marker is only
    // synthesized by the ≥TASK_RUN_MS fallback —— during this window fastPhase.phase stays tool, so the "done.cancelled still present" gate must shield the red,
    // otherwise "Task cancelled" flashes and is covered right back by "tool call" (the very symptom: after cancel the state sticks on "tool call" and the task stays "in progress").
    if (mainAgent.phase === 'done' || mainAgent.phase === 'cancelled') {
      const fp = fastPhase.value;
      // No realtime phase (after wrap-up the hook writes the phase as idle) → intercept, so the wrap-up flash stays lit
      if (!fp || !fp.phase) return;
      // Has a realtime phase: only one **newer than the wrap-up marker** counts as "the user sent another round" (the ts written by UserPromptSubmit is later).
      // The stale "thinking / tool call" from before the wrap-up / cancel has an earlier ts → always intercept —— this is exactly the root cause of
      // "Claude Code emits not a single event on stop, the red 'task cancelled' is pushed back by a stale phase right after lighting, stuck thinking forever"
      // (the cancel marker comes from server-side fallback synthesis; nobody clears the phase in the state file).
      // Paths with no phase timestamp (the 7F/8F poll one carries no ts) fall back to the old behavior: override allowed.
      const phaseTs = Number(fp.phaseTs) || 0;
      if (phaseTs && phaseTs <= doneAt) return;
    }
    mainAgent.setLiveState(v);
  },
  { immediate: true }
);

let cardRaf = 0;

/**
 * Scene actors: experts (with a workstation) + ephemeral members (ghosts, floating).
 *
 * When the selected session is not "the one running in the current project" (another project's session / only fossil data left),
 * this member list does not match that session. The actors then fall back to idle, never using project A's people
 * to impersonate project B's state. The office layout is unaffected.
 */
// The main Agent (role=agent) takes no workstation: its own realtime state is consumed separately by the main console silhouette
// (setMainAgent), so placing another one in the workstation area would be a duplicate. So it is excluded from the workstation roster,
// leaving only true subagent gremlins (including resident members registered by the scanner) at workstations.
const sceneMembers = computed(() => {
  /**
   * How to handle an empty floor (no active session on this floor) —— two categories:
   *   · Ghosts (`subagent-<name>`) are not kept: they are session-level ephemeral members, the product of "this round's summon",
   *     and should not exist without a session (keeping them is the previous floor's afterimage).
   *   · **Resident gremlins are kept**: user-level / project-level gremlins are static workstations already defined in the agents directory,
   *     "present even when not currently summoned", unrelated to whether this floor has a session.
   *     Not seeing them after switching would make people think this floor has nobody at all (with no session on 1F, user-level/project-level experts should still be at their workstations).
   */
  const emptyFloor = sessions.floorEmpty;
  // The virtual demo session behaves exactly like a real one here: its members carry the floor
  // client and the demo session id, so the ordinary floor / session filters select them.
  const want = sessions.selectedClient;
  const wantSession = sessions.selectedSessionId;
  // Gremlins are assigned to floors by agent base name: the CLI and plugin forms belong to the same floor (1F CodeBuddy is merged this way),
  // so a resident gremlin is placed as long as its base name matches. floorAcceptsClient strips -plugin internally before comparing base names.
  const live = sessions.live;
  return sourceMembers.value
    .filter((m) => m.role !== 'agent')
    .filter((m) => !(emptyFloor && isEphemeralMember(m))) // Empty floor: keep only resident ones
    // Filter the source by client (product / floor identifier): 3F sees only Codex, 1F only CodeBuddy.
    // client alone represents "which floor this belongs to" —— resident gremlins are written in the agents directory, and memberId is a
    // human-given name like peter/leo unrelated to the product, so it is never used to match floors. An empty client (old store / demo data /
    // written by manual scripts) is treated as generic and shown on every floor (the semantics of floorAcceptsClient).
    .filter((m) => floorAcceptsClient(want, m.client))
    // Ghosts (subagent- prefix) carry a sessionId —— only the selected session's ghosts are shown.
    // Resident gremlins (role=subagent but not ephemeral) have no sessionId and are shared floor-wide, so they must not be filtered out by this.
    // Ghosts with an empty sessionId (old store / manual scripts) are passed through too, rather than hiding every ghost.
    .filter((m) => !isEphemeralMember(m) || !wantSession || !m.sessionId || m.sessionId === wantSession)
    .map((m) => (live ? memberForSession(m, wantSession, sourceMembers.value) : { ...m, state: 'idle', tasks: [], sessionStatuses: [] }))
    .map((m) => ({
      memberId: m.memberId,
      name: m.name || String(m.memberId || '').split('@')[0],
      level: m.level || null,
      state: live ? normalizeState(m.state) : 'idle',
      ghost: isEphemeralMember(m),
      project: projectLabelOf(m),
      // taskProgress was removed (2026-09-29): the progress bar on the 3D office monitor became an "indeterminate bar",
      // so this field is no longer consumed; and task.progress itself has no real value (only 0/1, see
      // the note on the "progress" row in TaskRecordsView), so keeping it would only mislead the next person into wiring it up again.
      // Current task name of a summoned subagent: the main agent hands it to the gremlin via a bubble
      task: m.task && m.task.title ? m.task.title : '',
      // Stable identity for replay suppression across floor switches; title is only a legacy fallback.
      taskKey: m.task
        ? String(m.task.id || '') ||
          (Number(m.task.startedAt) ? `at:${Number(m.task.startedAt)}` : `title:${m.task.title || ''}`)
        : '',
      // Finish summary: the server delivers the subagent's result as an artifact on the member card
      // (kind is only file/doc/pr/text, so it is stored as kind='text' + a path marker — see bus's
      // GHOST_SUMMARY_PATH); the gremlin says it to the main agent when it finishes (see iso/engine's stepReport).
      result: ((m.artifacts || []).find((a) => a && a.kind === 'text' && a.path === 'workgremlin:summary') || {}).title || '',
    }));
});

watch(sceneMembers, (v) => {
  // Everyone is gone (switched to an empty floor): take down the open workstation card too, do not leave a previous floor member's task card hanging
  if (!v.length) card.value = null;
  if (office) office.setMembers(v);
});
watch(
  () => props.selectedId,
  (v) => office && office.setSelected(v)
);
// On floor switch, swap in this floor's material palette (partitions / metal parts / wood parts differ per floor, see FLOOR_COLORS in iso/officeMap).
// The changeover happens after the elevator doors close; here it just follows the store.
watch(
  () => sessions.selectedFloor,
  (v) => office && office.setFloor(v)
);
watch(mainAgentState, (v) => office && office.setMainAgent(v));

/* ------------------------------ Task card ------------------------------ */

const card = ref(null);
let lastOpen = 0;

const cardMember = computed(() => (card.value ? sourceMembers.value.find((m) => m.memberId === card.value.memberId) : null));

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
  // The engine calls openCard first when a character is hit; here only "clicking empty space" is handled
  if (Date.now() - lastOpen < 150) return;
  card.value = null;
}

function closeCard() {
  card.value = null;
}

/* ------------------------------ HUD ------------------------------ */

/** Demo mode toggle: start / stop the read-only virtual session on the current floor. */
async function toggleDemo() {
  try {
    await demo.toggle(sessions.selectedFloor);
  } catch (err) {
    // If the switch fails (unknown floor / server refused), the view must not crash: stay as-is, just log one line
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
  office = createIsoOffice(canvasRef.value, { onSelect: openCard, floor: sessions.selectedFloor });
  office.setMembers(sceneMembers.value);
  office.setSelected(props.selectedId);
  office.setMainAgent(mainAgentState.value);
}

onMounted(() => {
  office = createIsoOffice(canvasRef.value, { onSelect: openCard, floor: sessions.selectedFloor });
  office.setMembers(sceneMembers.value);
  office.setSelected(props.selectedId);
  office.setMainAgent(mainAgentState.value);
  startPhasePoll();

  const loop = () => {
    updateCardPos();
    cardRaf = requestAnimationFrame(loop);
  };
  cardRaf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(cardRaf);
  stopPhasePoll();
  if (office) office.destroy();
  office = null;
  // Leaving the view: drop the deferred wrap-up so it never fires on the store after we are gone
  pendingDone = null;
  clearTimeout(pendingDoneTimer);
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

    <!-- Main Agent console tooltip: pops 400ms after the mouse rests on the floating screen -->
    <div
      v-if="tip.show"
      class="console-tip"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      <div class="ct-head">
        <i class="dot" :style="{ background: mainAgent.phaseColor }" />
        <!-- The "task cancelled" text also follows the phase color (red) —— only this phase is tinted; other phases stay as-is -->
        <span class="ct-phase" :style="mainAgent.phase === 'cancelled' ? { color: mainAgent.phaseColor } : null">{{ mainAgent.phaseLabel }}</span>
      </div>
      <!-- Wrap-up phase (task done / task cancelled): those "output summary" lines in the third layer are what matters,
            so they override action —— on cancel this is "which files changed", and none changed means "no output". -->
      <div
        class="ct-row"
        v-if="mainAgent.action || (isFinishPhase && mainAgent.context.length)"
      >
        <b>{{ t('office.tip.action') }}</b>
        <span class="ct-val">
          <template v-if="isFinishPhase && mainAgent.context.length">
            <span v-for="(c, i) in mainAgent.context" :key="i" class="ct-file">{{ c }}</span>
          </template>
          <template v-else-if="mainAgent.action">{{ mainAgent.action }}</template>
        </span>
      </div>
      <div v-if="mainAgent.target && mainAgent.phase === 'await'" class="ct-row"><b>{{ t('office.tip.target') }}</b><span class="ct-val">{{ mainAgent.target }}</span></div>
      <div v-if="mainAgent.skill" class="ct-row"><b>{{ t('office.tip.skill') }}</b><span class="ct-val">{{ mainAgent.skill }}</span></div>
    </div>

    <!-- Gremlin tooltip: current task + most recent completed result -->
    <div
      v-if="mtip.show && mtipMember"
      class="console-tip member-tip"
      :style="{ left: `${mtip.x}px`, top: `${mtip.y}px` }"
    >
      <div class="ct-head">
        <span class="ct-phase">{{ mtipMember.name }}</span>
      </div>
      <div class="ct-row">
        <b>{{ t('office.tip.task') }}</b>
        <span class="ct-val">{{ mtipTask || t('office.tip.idle') }}</span>
      </div>
      <div v-if="mtipResult && (mtipResult.result || mtipResult.task)" class="ct-row">
        <b>{{ t('office.tip.last_result') }}</b>
        <span class="ct-val">{{ mtipResult.result || t('bubble.done_prefix', { task: mtipResult.task }) }}</span>
      </div>
    </div>

    <!-- Task card (follows the character) -->
    <div
      v-if="card && cardMember"
      class="card-layer"
      :style="{ left: `${card.left}px`, top: `${card.top}px` }"
      @click.stop
    >
      <WorkstationCard :member="cardMember" :members="sourceMembers" :session-id="sessions.selectedSessionId" />
      <button class="card-close" @click="closeCard">{{ t('records.delete_cancel') }}</button>
    </div>

    <!-- HUD -->
    <div class="hud" @click.stop>
      <!-- Demo mode: start / stop the read-only virtual session on this floor. It behaves like a
           normal session for the dropdown, member cards and sprites. -->
      <button
        class="demo-btn"
        :class="{ on: demo.active }"
        :title="demo.active ? t('office.exit_demo_title') : t('office.demo_title')"
        @click="toggleDemo"
      >
        {{ demo.active ? t('office.exit_demo') : t('office.demo') }}
      </button>
      <button @click="callAll">{{ t('office.meeting') }}</button>
      <button @click="dismiss">{{ t('office.back_to_desk') }}</button>
      <button @click="resetView">{{ t('office.reset_view') }}</button>
      <!-- Fullscreen toggle: placed at the end of the "demo mode" row, still here after the top bar is hidden,
           and never landing to the right of the scroll screen; the label switches between "Fullscreen" / "Exit fullscreen", the button is fixed width and does not jump -->
      <button
        class="fs-hud-btn"
        :title="fullscreen ? t('nav.exit_fullscreen_title') : t('nav.fullscreen_title')"
        @click="emit('toggle-fullscreen')"
      >
        {{ fullscreen ? t('nav.exit_fullscreen') : t('nav.fullscreen') }}
      </button>
    </div>

    <!-- Bottom-left caption bar: connection state + phase source (previously in the small badge at the top-left) **side by side with** the operation hint in one bar.
         The project name is not here —— it moved to the far left of the lintel (the floor LCD panel), see ElevatorDoors. -->
    <div class="tip">
      <ConnectionBar bare class="status-hud" :connection="connection" :source="source" />
      <span class="sep" />
      {{ t('office.tip.pan') }}
      <!-- Another vertical line between it and the preceding operation hint (the same spec .sep as the one after the "phase source") -->
      <span class="sep" />
      <span class="legend"><i class="dot green" />{{ t('office.legend.project_expert') }}</span>
      <span class="legend"><i class="dot blue" />{{ t('office.legend.user_expert') }}</span>
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
  /* The background uses a token: the lintel (the floor screen area) uses the same color, see --iso-bg in theme.css */
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

/* Connection / phase source: merged into the bottom-left caption bar (inside .tip); it swallows no mouse events, so it does not block scene dragging */
.status-hud {
  flex: none;
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

/* Fullscreen button: fixed width, so it does not jump when the label switches between "Fullscreen" (2 chars) / "Exit fullscreen" (4 chars) */
.fs-hud-btn {
  min-width: 76px;
  text-align: center;
  white-space: nowrap;
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

/* Bottom-left caption bar: connection / phase source / operation hint / expert level legend —— side by side on one row */
.tip {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
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
  /* Long content (very long file paths etc.) aligns to the label's top rather than bursting the box */
  align-items: flex-start;
}

.ct-row b {
  flex: 0 0 auto;
  color: #7fb0ff;
  font-weight: 600;
}

/* Value text: shrinkable; long strings (file paths / tool names) wrap mid-word */
.ct-val {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* The "changes" detail on done/paused: each file on its own line */
.ct-files .ct-file {
  display: block;
}

.dim {
  color: var(--text-faint);
}

/* Expert level legend: colors match the badge/nameplate levels (project green / user blue) */
.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.legend .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.legend .dot.green {
  background: #22c55e;
}

.legend .dot.blue {
  background: #3b82f6;
}
</style>
