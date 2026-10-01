/**
 * 工位卡 / 办公室小怪物共用的「当前任务」口径。
 *
 * 为什么需要它：`agent_status.task_id` 不会随收工清空 —— 成员空闲之后，那个槽位往往还指着
 * **上一条已经收工**的任务。照着显示就会「明明空闲，屏幕上却挂着当前任务、已耗时还在走」
 * （用户实测抓出来的：主代理状态空闲，卡片上仍是上一个任务的标题 + 一直在涨的已耗时）。
 *
 * 所以「当前任务」= 任务还没收工（没有 endedAt）**且** 成员确实在干活（busy / thinking / blocked）。
 * idle / online / offline 一律算空闲 —— 那里显示的应该是「上一个任务在多久以前」（lastTaskAt）。
 */
// 显式写 /index.js：这个文件被 renderer/test 的 node 脚本直接 import，Node 不会补扩展名
import { t } from '../i18n/index.js';

/** 算在干活的相位：与主控制台"在不在跑"的口径一致（见 iso/mainConsole.js 的 PHASES.busy） */
export const WORKING_STATES = ['busy', 'thinking', 'blocked'];

/** 这个成员现在在不在干活 */
export function isWorking(member) {
  return Boolean(member && WORKING_STATES.includes(member.state));
}

/**
 * 状态牌只有两档文案：在干活 → 忙碌，其余 → 空闲。
 * 用户 2026-09-30 的要求：主代理 / 子代理卡片右上角只显示「空闲 / 忙碌」，不要 5 种细分状态。
 */
export function statusLabel(state) {
  return WORKING_STATES.includes(state) ? t('card.status.busy') : t('card.status.idle');
}

/** 状态牌的色调（那个小圆点）：与文案同源，避免出现"绿色点 + 空闲"这种自相矛盾 */
export function statusTone(state) {
  return WORKING_STATES.includes(state) ? 'busy' : 'idle';
}

/**
 * 当前任务；没有就回 null。
 * 幽灵（临时召唤）的 task 可能是清单里的字符串（`--task`），一并支持。
 * @returns {{ title?: string, startedAt?: number }|string|null}
 */
export function currentTaskOf(member) {
  const t = member && member.task;
  if (!t || !isWorking(member)) return null;
  if (typeof t === 'string') return t;
  return t.endedAt ? null : t;
}

/** 当前任务的标题文案；没有回空串（调用方自己决定显示「空闲」还是别的） */
export function currentTaskTitle(member) {
  const t = currentTaskOf(member);
  if (!t) return '';
  return typeof t === 'string' ? t : String(t.title || '');
}

/** 当前任务的开工时刻；拿不到回 0（调用方回落到 stateSince，不编造） */
export function currentTaskStartedAt(member) {
  const t = currentTaskOf(member);
  return t && typeof t === 'object' ? Number(t.startedAt) || 0 : 0;
}
