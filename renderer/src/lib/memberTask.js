/**
 * The "current task" definition shared by the workstation card / office gremlins.
 *
 * Why it's needed: `agent_status.task_id` isn't cleared when work finishes —— after a member goes idle, that slot often still points at
 * **the previous task that already finished**. Displaying it straight gives "clearly idle, yet a current task hangs on screen and the elapsed time keeps ticking"
 * (caught by real user testing: the main agent is idle, yet the card still shows the previous task's title + an ever-increasing elapsed time).
 *
 * So "current task" = the task hasn't finished (no endedAt) **and** the member is actually working (busy / blocked).
 * idle / online / offline all count as idle —— what should be shown there is "how long ago the previous task was" (lastTaskAt).
 */
// Write /index.js explicitly: renderer/test node scripts import this file directly, and Node won't add the extension
import { t } from '../i18n/index.js';
import { isEphemeralMember } from './ephemeral.js';

/**
 * Phases counted as working: consistent with the main console's "is it running" definition (see PHASES.busy in iso/mainConsole.js).
 * Note there is **no** `thinking` in member state —— "thinking / waiting for the model" counts as `busy` (see AGENT_STATES in shared);
 * the main console's "thinking vs calling a tool" is a matter of the **phase** axis, not member state.
 */
export const WORKING_STATES = ['busy', 'blocked'];

/** Whether this member is working right now */
export function isWorking(member) {
  return Boolean(member && WORKING_STATES.includes(member.state));
}

/**
 * Three levels of status-label text: blocked / busy / idle.
 * blocked → blocked (waiting on an external dependency); busy → busy; the rest (idle / online / offline / unreported) → idle.
 * The 5 fine-grained states still aren't shown one by one (the user kept only idle/busy on 2026-09-30), but blocked gets its own level ——
 * the information it carries ("stuck, waiting on whom") is not the same as busy (see requirements §5.6).
 */
export function statusLabel(state) {
  if (state === 'blocked') return t('card.status.blocked');
  return WORKING_STATES.includes(state) ? t('card.status.busy') : t('card.status.idle');
}

/** The status label's tone (that little dot): same source as the text, to avoid contradictions like "green dot + idle" */
export function statusTone(state) {
  if (state === 'blocked') return 'blocked';
  return WORKING_STATES.includes(state) ? 'busy' : 'idle';
}

/**
 * The current task; null when there is none.
 * A ghost's (temporary summon's) task may be a string from the checklist (`--task`), supported too.
 * @returns {{ title?: string, startedAt?: number }|string|null}
 */
export function currentTaskOf(member) {
  const t = member && member.task;
  if (!t || !isWorking(member)) return null;
  if (typeof t === 'string') return t;
  return t.endedAt ? null : t;
}

/** The current task's title text; empty string when there is none (the caller decides whether to show "idle" or something else) */
export function currentTaskTitle(member) {
  const t = currentTaskOf(member);
  if (!t) return '';
  return typeof t === 'string' ? t : String(t.title || '');
}

/** The current task's start time; 0 when unavailable (the caller falls back to stateSince, nothing fabricated) */
export function currentTaskStartedAt(member) {
  const t = currentTaskOf(member);
  return t && typeof t === 'object' ? Number(t.startedAt) || 0 : 0;
}

/**
 * "Effective current task": when a resident gremlin has no running task in its own slot but is **being summoned** (a ghost of the same name is running),
 * borrow that ghost's task —— the same definition as the office tooltip (see IsoOfficeView's mtipTask).
 *
 * Why it's needed: the instance summoned out to work is the `subagent-<name>` ghost, the task hangs on it; the resident gremlin's
 * slot has no task. Looking only at the member's own task, the workstation card would show "status busy, current task: idle".
 * @param {object} member a resident member (or any member)
 * @param {Array} allMembers every member of the same project (including ghosts)
 * @returns {object|string|null}
 */
export function summonTaskOf(member, allMembers) {
  if (!member || !isWorking(member)) return null;
  const own = currentTaskOf(member);
  if (own) return own;
  const g = (Array.isArray(allMembers) ? allMembers : []).find(
    (x) => isEphemeralMember(x) && x.name === member.name && currentTaskOf(x)
  );
  return g ? currentTaskOf(g) : null;
}

/** The "effective current task" title; empty string when there is none (the caller shows "idle") */
export function summonTaskTitle(member, allMembers) {
  const task = summonTaskOf(member, allMembers);
  if (!task) return '';
  return typeof task === 'string' ? task : String(task.title || '');
}

/** The "effective current task" start time; 0 when unavailable */
export function summonTaskStartedAt(member, allMembers) {
  const task = summonTaskOf(member, allMembers);
  return task && typeof task === 'object' ? Number(task.startedAt) || 0 : 0;
}
