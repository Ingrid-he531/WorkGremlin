/**
 * 临时成员（幽灵）判定 —— 渲染层专用。
 *
 * 专家团队是常驻成员，一人一个工位；为某个项目临时组队拉进来的成员
 * 没有工位，在场景里以"幽灵"形态飘在空中。
 *
 * 为什么不放 shared：@workgremlin/shared 是 CJS 包，vite dev 会预打包它，
 * 新增具名导出时旧缓存不会自动失效（会报 isEphemeralMember is not a function）。
 * 这是纯展示规则（精灵 vs 幽灵），server 并不需要，所以留在渲染层。
 *
 * 判定优先级：
 *   1. member.ephemeral === true（将来 server 可直接下发）
 *   2. memberId / name 以 ghost- ghost_ tmp- temp- 开头
 *   3. role === 'ghost'
 */

const EPHEMERAL_PREFIXES = Object.freeze(['ghost-', 'ghost_', 'tmp-', 'temp-']);

/**
 * 是否为临时成员（无工位、飘在空中）。
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

/** 临时成员所属项目名（缺省回落到 role / name） */
export function projectLabelOf(member) {
  if (!member) return '';
  const raw = String(member.project || member.role || member.name || '');
  return raw.replace(/^临时项目\s*[·:：\-]?\s*/, '').trim();
}
