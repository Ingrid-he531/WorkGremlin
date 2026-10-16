/**
 * Ephemeral-member (ghost) detection —— renderer-only.
 *
 * The expert team are resident members, one workstation each; members pulled in to form a team temporarily for a project
 * have no workstation and hover in the scene in "ghost" form.
 *
 * Why not put it in shared: @workgremlin/shared is a CJS package, vite dev pre-bundles it,
 * so adding a named export doesn't invalidate the old cache (it throws isEphemeralMember is not a function).
 * This is a pure display rule (sprite vs ghost), the server doesn't need it, so it stays in the renderer.
 *
 * Detection priority:
 *   1. member.ephemeral === true (the server can send this directly in the future)
 *   2. memberId / name starts with ghost- ghost_ tmp- temp-
 *   3. role === 'ghost'
 */

const EPHEMERAL_PREFIXES = Object.freeze([
  'subagent-',
  'subagent_',
  'ghost-',
  'ghost_',
  'tmp-',
  'temp-',
]);

/**
 * Whether it is an ephemeral member (no workstation, hovering in the air).
 * @param {{memberId?: string, name?: string, role?: string|null, ephemeral?: boolean}} member
 */
export function isEphemeralMember(member) {
  if (!member) return false;
  if (member.ephemeral === true) return true;
  const id = String(member.memberId || member.name || '')
    .split('@')[0]
    .toLowerCase();
  if (EPHEMERAL_PREFIXES.some((p) => id.startsWith(p))) return true;
  return String(member.role || '').toLowerCase() === 'ghost';
}

/** The project name an ephemeral member belongs to (falls back to role / name) */
export function projectLabelOf(member) {
  if (!member) return '';
  const raw = String(member.projectLabel || member.role || member.name || '');
  return raw.replace(/^临时项目\s*[·:：\-]?\s*/, '').trim();
}
