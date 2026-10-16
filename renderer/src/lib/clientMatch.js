import { agentBase, AGENT_LABELS } from '@workgremlin/shared';

/**
 * Client identity normalization (shared by the front end).
 *
 * New contract (matching the hook's eventClient): **agent directly represents the floor**, client only describes the form
 * (vscode / cli …). isPluginClient(client) decides the plugin form (vscode-family IDE).
 * So floors and members are both matched and displayed by the agent base name, no longer using a synthesized string like `agent + '-plugin'` as the identity.
 *
 * The display name / clientLabel have moved to shared/index.js and are returned directly by the backend API (the client_label field),
 * the front end no longer builds them from form —— this file only keeps the floor-matching logic.
 */

/**
 * Whether a floor (floorAgent) accepts a member (memberAgent).
 *
 * Resident gremlins (written into the agents directory) have nothing to do with "CLI or Plugin": the CLI and Plugin of the same product
 * belong to the same floor (1F CodeBuddy is merged like this); codex's "CLI and IDE merged into one floor" is the same.
 * So match by **agent base name** (strip any leftover -plugin suffix and @project suffix as a fallback).
 * An empty client (demo data / old DBs that never backfilled client) is treated as generic and shows on every floor.
 *
 * @param {string} floorAgent floor identity (floor.agent, e.g. codebuddy / kilo)
 * @param {string} memberAgent member identity (member.memberId, e.g. codebuddy / kilo)
 */
export function floorAcceptsClient(floorAgent, memberAgent) {
  if (!memberAgent || !floorAgent) return true;
  const fa = agentBase(floorAgent);
  const ma = agentBase(memberAgent);
  // An empty base name (abnormal fallback) must not swallow: only identical base names are accepted
  if (!fa || !ma) return false;
  return fa === ma;
}

/**
 * Whether it is a "product base name" (the floor's main agent): sub-agents like leo / peter are not included.
 * Used to tell whether a member is the main agent of its floor (unrelated to floorAcceptsClient——
 * under the new model a member's client field is the form, you can't compare it with name).
 * @param {string} id memberId / name
 */
export function isBaseAgent(id) {
  return Boolean(AGENT_LABELS[agentBase(id)]);
}
