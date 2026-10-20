import { isEphemeralMember } from './ephemeral.js';
import { floorAcceptsClient } from './clientMatch.js';

/**
 * Ghosts that are currently working for the selected floor and session.
 *
 * The main console's "waiting for subagents" layer reads this list. It must apply the same floor
 * and session scoping as the office roster: an unscoped read lets another floor's summon drive
 * this floor's console into "waiting" even though this floor has no task at all.
 *
 * @param {Array<object>} members project members (resident gremlins + ephemeral ghosts)
 * @param {{client?: string, sessionId?: string}} scope selected floor / session
 * @returns {Array<object>}
 */
export function busySubagentsOf(members, scope = {}) {
  const client = scope.client || '';
  const sessionId = scope.sessionId || '';
  return (members || []).filter(
    (m) =>
      isEphemeralMember(m) &&
      (m.state === 'busy' || m.state === 'blocked') &&
      floorAcceptsClient(client, m.client) &&
      // Ghosts with no session id (old store / manual scripts) stay visible rather than hiding every ghost.
      (!sessionId || !m.sessionId || m.sessionId === sessionId)
  );
}
