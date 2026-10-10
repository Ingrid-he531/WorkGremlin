import { isPluginClient } from '@workgremlin/shared';

/**
 * 客户端身份归一化（前端共用）。
 *
 * 新合同（与 hook 的 eventClient 一致）：**agent 直接代表楼层**，client 只描述形态
 * （vscode / cli …）。isPluginClient(client) 判定 plugin 形态（vscode 系 IDE）。
 * 因此楼层与成员都按 agent 基名匹配与显示，不再用 `agent + '-plugin'` 这种合成字符串当身份。
 */

/**
 * 身份 → agent 基名：剥掉 -plugin 后缀与 @<工程/实例> 后缀。
 * 同一产品 CLI / Plugin 同层，而成员 id 常带工程后缀（如 codebuddy@workgremlin、
 * kilo@<projectId>），显示与归层都按基名认，所以这里统一收口。
 * @param {string} id memberId / name / floor.agent / floor.client
 */
function agentBase(id) {
  return String(id || '')
    .replace(/-plugin$/i, '')
    .split('@')[0]
    .toLowerCase();
}

/**
 * 某楼层（floorAgent）是否接纳某成员（memberAgent）。
 *
 * 常驻小怪物（写在 agents 目录里）与"走 CLI 还是 Plugin"无关：同一产品的 CLI 与 Plugin
 * 同属一层（1F CodeBuddy 就是这么合并的）；codex 这种「CLI 与 IDE 合并成一层」同理。
 * 所以按 **agent 基名**匹配（剥掉残留的 -plugin 后缀与 @工程 后缀兜底）。
 * client 为空的（演示数据 / 老库没补上 client 的）视作通用，哪层都显示。
 *
 * @param {string} floorAgent 楼层身份（floor.agent，如 codebuddy / kilo）
 * @param {string} memberAgent 成员身份（member.memberId，如 codebuddy / kilo）
 */
export function floorAcceptsClient(floorAgent, memberAgent) {
  if (!memberAgent || !floorAgent) return true;
  const fa = agentBase(floorAgent);
  const ma = agentBase(memberAgent);
  // 空基名（异常兜底）不误吞：基名相同才认
  if (!fa || !ma) return false;
  return fa === ma;
}

/**
 * 是否为"产品基名"（楼层主 agent）：leo / peter 这类子代理不在其中。
 * 用于区分某成员是不是它所在楼层的主 agent（与 floorAcceptsClient 无关——
 * 新模型下成员的 client 字段是形态，不能拿它和 name 比）。
 * @param {string} id memberId / name
 */
export function isBaseAgent(id) {
  return Boolean(BASE_LABELS[agentBase(id)]);
}

/**
 * agent → 显示名（楼层 / 产品基名）。
 */
const BASE_LABELS = {
  codebuddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  codex: 'Codex',
  claude: 'Claude Code',
  trae: 'TraeCode',
  kilo: 'Kilo Code',
  qoder: 'Qoder',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
};

/**
 * 由 agent + 形态得到显示名。
 * 形态 plugin（vscode 系 IDE）标注为 "… Plugin"；CLI 标注为 "… CLI"。
 * 标签里已经带形态的（TraeCode IDE）不重复追加。
 *
 * @param {string} agent 楼层基名（kilo / codebuddy …，可带 -plugin 或 @工程 后缀）
 * @param {string} form 形态（vscode / cli / ''）
 */
export function clientLabel(agent, form) {
  const a = agentBase(agent);
  const base = BASE_LABELS[a] || a || '—';
  const f = String(form || '').toLowerCase();
  if (isPluginClient(f)) return `${base} Plugin`;
  if (f === 'cli' && !/(?:^|\s)(?:CLI|IDE)$/i.test(base)) return `${base} CLI`;
  return base;
}
