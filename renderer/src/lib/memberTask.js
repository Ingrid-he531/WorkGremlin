/**
 * The "current task" definition shared by the workstation card / office gremlins.
 *
 * The server sends every running task for a member, each tagged with its session. The UI
 * chooses one using the selected session. Task liveness is tasks.state, not a heartbeat.
 */
// Write /index.js explicitly: renderer/test node scripts import this file directly, and Node won't add the extension
import { t } from '../i18n/index.js';
import { isEphemeralMember } from './ephemeral.js';
import { agentNameKey } from '@workgremlin/shared';

/** Workstation states are busy / idle / blocked. Unknown values normalize to idle. */
export const WORKING_STATES = ['busy'];

export function normalizeState(state) {
  if (state === 'blocked') return 'blocked';
  if (state === 'busy') return 'busy';
  return 'idle';
}

/** Whether this member is working right now */
export function isWorking(member) {
  return Boolean(member && WORKING_STATES.includes(member.state));
}

/**
 * Three levels of status-label text: blocked / busy / idle.
 * blocked -> blocked (waiting on an external dependency); busy -> busy; everything else -> idle.
 */
export function statusLabel(state) {
  const normalized = normalizeState(state);
  if (normalized === 'blocked') return t('card.status.blocked');
  return normalized === 'busy' ? t('card.status.busy') : t('card.status.idle');
}

/** The status label's tone (that little dot): same source as the text, to avoid contradictions like "green dot + idle" */
export function statusTone(state) {
  return normalizeState(state);
}

/**
 * Running tasks that belong to the requested session.
 * No session id means "use the newest running task" (demo / a floor without an active session).
 */
export function currentTaskOf(member, sessionId = '') {
  const tasks = member && Array.isArray(member.tasks) ? member.tasks : [];
  const sid = String(sessionId || '');
  return tasks.find((task) => {
    if (!task || task.endedAt) return false;
    if (!sid) return true;
    const taskSession = String(task.sessionId || (isEphemeralMember(member) ? member.sessionId || '' : ''));
    return taskSession === sid;
  }) || null;
}

/** The current task's title text; empty string when there is none (the caller decides whether to show "idle" or something else) */
export function currentTaskTitle(member, sessionId = '') {
  const t = currentTaskOf(member, sessionId);
  if (!t) return '';
  return String(t.title || '');
}

/** The current task's start time; 0 when unavailable (the caller falls back to stateSince, nothing fabricated) */
export function currentTaskStartedAt(member, sessionId = '') {
  const t = currentTaskOf(member, sessionId);
  return Number(t && t.startedAt) || 0;
}

/**
 * Borrowed summon task for a resident gremlin. The server records borrowed busy in agentState;
 * the task itself lives on the same-named ephemeral member.
 */
export function summonTaskOf(member, allMembers, sessionId = '') {
  if (!member || member.ephemeral || normalizeState(member.agentState) !== 'busy') return null;
  const sid = String(sessionId || '');
  // Case-insensitive: the resident is named after the definition file stem (`simmon`), the summon
  // carries the frontmatter name (`Simmon`) — the same rule as the server (shared agentNameKey).
  const key = agentNameKey(member.name);
  const ghost = (Array.isArray(allMembers) ? allMembers : []).find((candidate) => {
    if (!candidate || !isEphemeralMember(candidate) || agentNameKey(candidate.name) !== key) return false;
    if (sid && candidate.sessionId && String(candidate.sessionId) !== sid) return false;
    return Boolean(currentTaskOf(candidate, sid));
  });
  return ghost ? currentTaskOf(ghost, sid) : null;
}

/**
 * Resolve a member card against one selected session.
 *
 * This is the single renderer-side state rule:
 *   blocked (same session) > running task (same session) > borrowed summon busy > idle.
 * A resident gremlin stays visible across sessions, but its dynamic state never leaks between them.
 */
export function memberForSession(member, sessionId = '', allMembers = []) {
  if (!member) return null;
  const sid = String(sessionId || '');
  const own = currentTaskOf(member, sid);
  const borrowed = own ? null : summonTaskOf(member, allMembers, sid);
  const task = own || borrowed;
  const lastBySession = Array.isArray(member.lastTaskAtBySession) ? member.lastTaskAtBySession : [];
  const selectedLast = sid
    ? lastBySession.find((row) => row && String(row.sessionId || '') === sid)
    : null;

  if (!sid) {
    return {
      ...member,
      task,
      currentFiles: task && Array.isArray(task.files) ? task.files : member.currentFiles || [],
    };
  }

  const blocked = (Array.isArray(member.sessionStatuses) ? member.sessionStatuses : []).find(
    (row) => row && String(row.sessionId || '') === sid && row.state === 'blocked'
  );
  let state = 'idle';
  let stateSince = Number(member.createdAt) || Number(member.stateSince) || Date.now();
  if (blocked) {
    state = 'blocked';
    stateSince = Number(blocked.stateSince) || stateSince;
  } else if (task) {
    state = 'busy';
    stateSince = Number(task.startedAt) || stateSince;
  }

  return {
    ...member,
    state,
    stateSince,
    task,
    currentFiles: task && Array.isArray(task.files) ? task.files : [],
    lastTaskAt: selectedLast ? selectedLast.at : null,
  };
}

/** The effective current task, including a same-session summon borrowed by a resident gremlin. */
export function summonTaskOfMember(member, allMembers, sessionId = '') {
  const own = currentTaskOf(member, sessionId);
  if (own) return own;
  return summonTaskOf(member, allMembers, sessionId);
}

/** The effective current task's title. */
export function summonTaskTitle(member, allMembers, sessionId = '') {
  const task = summonTaskOfMember(member, allMembers, sessionId);
  return task ? String(task.title || '') : '';
}

/** The effective current task's start time; 0 when unavailable. */
export function summonTaskStartedAt(member, allMembers, sessionId = '') {
  const task = summonTaskOfMember(member, allMembers, sessionId);
  return Number(task && task.startedAt) || 0;
}
