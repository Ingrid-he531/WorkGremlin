import { clientBase } from '@workgremlin/shared';

/**
 * 客户端身份归一化（前端共用）。
 *
 * 合同来自 hook 的 eventClient（packages/reporter/src/hook.js），clientBase 直接复用
 * @workgremlin/shared 的全局定义（client = agent 或 agent + '-plugin'）：
 *   - 非 plugin：agent 本身（codebuddy / codex / trae / workbuddy / claude …）
 *   - plugin   ：agent + '-plugin'（codebuddy-plugin / codex-plugin / trae-plugin …）
 *
 * codex / trae 这种可能既有 CLI 又有 plugin 的产品，两种变体都按同一套字符串上报；
 * 楼层（floor.client）与成员（member.client）都吃这套字符串，归层 / 过滤时据此判定。
 */

/**
 * 某楼层（floorClient）是否接纳某成员（memberClient）。
 *
 * 小怪物是常住 / 项目级成员（躺在 ~/.codebuddy/agents 这类目录里），与"走 CLI 还是 Plugin"
 * 无关：CodeBuddy 的常住小怪物在 1F(CLI) 与 3F(Plugin) 都该出现，codex / trae 这些有两个变体的
 * 楼层同理。所以按 **agent 基名**（剥掉 -plugin 后缀）匹配，不再精确区分 CLI / Plugin。
 * （claude 只有 5F 一层 —— 它的 CLI 与 IDE 插件共用同一份配置与 hook，payload 分不出二者。）
 * client 为空的（演示数据 / 老库没补上 client 的）视作通用，哪层都显示。
 *
 * @param {string} floorClient 楼层身份（floor.client，如 codebuddy / codebuddy-plugin）
 * @param {string} memberClient 成员身份（member.client）
 */
export function floorAcceptsClient(floorClient, memberClient) {
  if (!memberClient || !floorClient) return true;
  const fb = clientBase(String(floorClient).toLowerCase());
  const mb = clientBase(String(memberClient).toLowerCase());
  // 空基名（clientBase 异常兜底）不误吞：基名相同才认
  if (!fb || !mb) return false;
  return fb === mb;
}

const CLIENT_LABELS = {
  codebuddy: 'CodeBuddy CLI',
  'codebuddy-plugin': 'CodeBuddy Plugin',
  workbuddy: 'WorkBuddy CLI',
  'workbuddy-plugin': 'WorkBuddy Plugin',
  codex: 'Codex',
  'codex-plugin': 'Codex Plugin',
  // Claude Code 只有一层（CLI 与 IDE 插件共用同一份 ~/.claude 配置与 hook，payload 分不出二者）
  claude: 'Claude Code',
  trae: 'TraeCode',
  'trae-plugin': 'TraeCode Plugin',
};

/** 把 client 字符串显示成友好的产品名；认不出的原样返回 */
export function clientLabel(c) {
  const k = String(c || '').toLowerCase();
  return CLIENT_LABELS[k] || c || '—';
}
