/**
 * Member card "project membership" check —— block member cards pushed from other projects.
 *
 * The renderer's WS subscription does not scope member.status events by project. The server snapshot
 * is already sliced to the current project, but an incremental member card must still be checked here
 * before it enters the local member list.
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
