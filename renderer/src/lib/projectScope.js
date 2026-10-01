/**
 * 成员卡的"工程归属"判定 —— 挡住别的工程推过来的成员卡。
 *
 * 为什么需要：渲染层的 WS 订阅**不带 project**（它只显示"当前打开的工程"，
 * 服务端快照已经按当前工程切好，见 stores/project.js 的 init），于是服务端会把
 * **所有**工程的 member.status 广播都送过来。浏览器只按事件类型分发、不看工程，
 * `upsertMember` 又是"有新卡就往 members 里塞" —— 别的工程的成员就这样混进了屋里。
 *
 * 实测的现形方式（2026-10-01）：进演示模式再退出、切楼层后，演示那 8 只小怪物会
 * "短暂出现一下又消失"。原因是演示推进器停了之后，那些成员的心跳不再刷新，
 * 服务端每 10s 一次的心跳超时扫描（bus.sweepDegraded，阈值 60s）在把它们标成
 * degraded 的同时**逐个广播了它们的成员卡**；客户端照单收下 → 屋里闪回 8 只；
 * 下一次对账（15s 一次，整份快照覆盖）又把它们清掉 —— 于是"闪一下又没"。
 *
 * 这个判定只看卡片自己带的 project 字段：
 *   · 卡片没带 / 当前工程未知（老服务端、老事件、还没拿到 workspace）→ **放行**
 *     （宁可多显示，也不能因为缺字段把当前工程的人挡掉）；
 *   · 两边都有且不一致 → 拦掉。
 *
 * @param {{project?: string|null}|null|undefined} card 成员卡
 * @param {string} projectId 当前打开的工程 id（server 的 projects.id）
 * @returns {boolean} 这张卡属不属于当前工程
 */
export function memberBelongsToProject(card, projectId) {
  if (!card || !card.project || !projectId) return true;
  return String(card.project) === String(projectId);
}
