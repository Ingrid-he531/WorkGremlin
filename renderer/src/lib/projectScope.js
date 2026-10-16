/**
 * Member card "project membership" check —— block member cards pushed from other projects.
 *
 * Why it's needed: the renderer's WS subscription **doesn't carry project** (it only shows "the currently open project",
 * the server snapshot is already sliced by the current project, see init in stores/project.js), so the server sends
 * member.status broadcasts of **all** projects. The browser dispatches only by event type, not looking at the project,
 * and `upsertMember` is "dump any new card into members" —— so members of other projects sneak into the room.
 *
 * How it showed up in testing (2026-10-01): after entering demo mode and exiting, then switching floors, those 8 demo gremlins
 * "briefly appear and then vanish". The cause is that after the demo driver stops, those members' heartbeats no longer refresh,
 * and the server's 10s heartbeat-timeout sweep (bus.sweepDegraded, 60s threshold), while marking them
 * degraded, **broadcasts their member cards one by one**; the client accepts them all → 8 flash back into the room;
 * the next reconciliation (every 15s, a full snapshot overwrite) clears them again —— hence "a flash and then gone".
 *
 * This check only looks at the project field the card itself carries:
 *   · the card doesn't carry it / the current project is unknown (old server, old events, workspace not yet received) → **let through**
 *     (better to show too much than to block the current project's people for a missing field);
 *   · both present and inconsistent → block.
 *
 * @param {{project?: string|null}|null|undefined} card a member card
 * @param {string} projectId the currently open project id (the server's projects.id)
 * @returns {boolean} whether this card belongs to the current project
 */
export function memberBelongsToProject(card, projectId) {
  if (!card || !card.project || !projectId) return true;
  return String(card.project) === String(projectId);
}
