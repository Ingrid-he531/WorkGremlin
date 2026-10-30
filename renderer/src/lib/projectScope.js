/**
 * Member card "project membership" check —— block member cards pushed from other projects.
 *
 * The renderer's WS subscription may send member.status events from several projects. The server snapshot
 * is already sliced to the viewed project, but an incremental member card must still be checked here
 * before it enters the local member list.
 *
 * This check only looks at the project field the card itself carries:
 *   · the card doesn't carry it / the viewed project is unknown (old server, old events, workspace not yet received) → **let through**
 *     (better to show too much than to block the viewed project's people for a missing field);
 *   · both present and inconsistent → block.
 *
 * @param {{project?: string|null}|null|undefined} card a member card
 * @param {string} projectId the project id currently being viewed (the server's projects.id)
 * @returns {boolean} whether this card belongs to the viewed project
 */
export function memberBelongsToProject(card, projectId) {
  if (!card || !card.project || !projectId) return true;
  return String(card.project) === String(projectId);
}

/**
 * Whether two workspace paths point at the same directory. The server always sends absolute paths,
 * but a trailing slash or a Windows separator can still differ between a project row and a session.
 * Empty values are never equal here: "unknown" must not match "unknown" and select an arbitrary project.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameWorkspacePath(a, b) {
  const norm = (v) => String(v || '').trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y && x === y);
}
