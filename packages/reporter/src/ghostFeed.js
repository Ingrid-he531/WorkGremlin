'use strict'

/**
 * subagent 临时成员（幽灵）清单 —— **格式真源**。
 *
 * 清单文件 `<工程>/.workgremlin/subagents.json` 是 WorkGremlin 里"谁在帮你写代码、
 * 它现在什么状态"的公开约定：文件里有谁，办公室里就飘着谁；删掉就散场。
 * 这个文件**多方写**：agent 侧的 hook、WorkGremlin 自己的 OpenCode/Kilo 插件
 * （packages/reporter/src/plugin/）、以及人手敲的 `scripts/subagents.js`。
 *
 * 所以**格式只能有一份实现**。本模块就是那一份，`packages/reporter/src/hook.js` 与
 * 插件都从这里取 —— 免得两边各写一份 JSON 结构，日后一个加了 `ts`、另一个还按"无 ts
 * 就算手工条目、不扫"的口径处理，幽灵就永远收不掉。
 *
 * 形状（顶层也可以直接是数组，project 缺省留空）：
 *   { "project": "WorkGremlin",
 *     "agents": [ { "name": "susan", "state": "busy", "ts": 1758…, "client": "kilo",
 *                   "sessionId": "ses_…", "task": "在做的事", "id": "本次召唤的 key",
 *                   "parent": "父轮任务 id", "model": "…" } ] }
 *
 * 定位规则（与服务端 ingest/subagentFeed.js、scripts/subagents.js 保持一致）：
 *   $WORKGREMLIN_SUBAGENTS_FILE > <工程路径>/.workgremlin/subagents.json > <cwd>/.workgremlin/subagents.json
 */

const fs = require('node:fs')
const path = require('node:path')

/** 清单文件路径（显式环境变量 > 工程路径 > cwd） */
function feedFileFor(workspacePath) {
  const env = String((process.env && process.env.WORKGREMLIN_SUBAGENTS_FILE) || '').trim()
  if (env) return path.resolve(env)
  const ws = String(workspacePath || '').trim()
  return path.join(ws ? path.resolve(ws) : process.cwd(), '.workgremlin', 'subagents.json')
}

/** 读清单。文件不存在 / 坏了都返回空清单（不抛、不猜） */
function readFeedFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const agents = Array.isArray(data) ? data : Array.isArray(data.agents) ? data.agents : []
    const project = (!Array.isArray(data) && typeof data.project === 'string' && data.project) || ''
    return { project, agents }
  } catch {
    return { project: '', agents: [] }
  }
}

/** 写清单（失败不影响 agent） */
function writeFeedFile(file, feed) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(feed, null, 2)}\n`, 'utf8')
  } catch {
    /* 写不进去就算了 */
  }
}

/**
 * 这条清单条目归不归本调用方管。
 *
 * Codex / Kilo / OpenCode / CodeBuddy 写的是**同一个** `<工程>/.workgremlin/subagents.json`，
 * 所以收工 / 扫场必须认来源，否则会把对方的幽灵一起收掉。
 * 写了 client 的按 client 认；没写的（老版本 hook / 手工 `scripts/subagents.js` 写的条目）
 * 算 CodeBuddy 的历史条目。
 *
 * 会话这一级只在**两边都有**时才比：老条目 / 手工写的条目根本没有 sessionId，
 * 不能因为缺字段就当"不是我的"（那会把手工幽灵变成谁都收不掉的僵尸）。
 * 同一个 client 的两条会话只有这一步能把它们分开。
 */
function ownsEntry(a, client, session = '') {
  if (!a) return false
  const c = String(a.client || '').trim().toLowerCase()
  if (c) {
    if (c !== client) return false
  } else if (client !== 'codebuddy') {
    return false
  }
  if (session) {
    const s = String(a.sessionId || '').trim()
    if (s && s !== session) return false
  }
  return true
}

/**
 * 主 Agent 召唤 subagent → 加一只小幽灵。
 *
 * @param {string} workspacePath 会话所属工程（清单落在它下面）
 * @param {string} name subagent 名（要与名册里的名字对得上，办公室才联动）
 * @param {string} task 它这一单的任务
 * @param {string} id 本次召唤的 key（并发召唤同名 subagent 时用来区分）
 * @param {string} parent 召唤它的那轮用户任务 id
 * @param {string} model 召唤时的模型
 * @param {string} client 归属轴 1（产品）
 * @param {string} session 归属轴 2（会话）
 */
function addGhost(workspacePath, name, task, id, parent, model, client, session = '') {
  const file = feedFileFor(workspacePath)
  const feed = readFeedFile(file)
  // 去重也要按会话：同一个 subagent 名 + 同一个 id 只会出现在一条会话里，
  // 但两条会话各自召唤同名 subagent 时，只按 name 去重会把第二只吞掉。
  const dup = id
    ? (a) => a.id === id
    : (a) => a.name === name && String(a.sessionId || '') === String(session || '')
  if (feed.agents.some(dup)) return
  feed.agents.push({
    name,
    state: 'busy',
    ts: Date.now(),
    client,
    ...(session ? { sessionId: String(session) } : {}),
    ...(task ? { task } : {}),
    ...(id ? { id } : {}),
    ...(parent ? { parent } : {}),
    ...(model ? { model } : {}),
  })
  writeFeedFile(file, feed)
}

/**
 * subagent 收工 → 改成**已收工待汇报**，不直接删。
 *
 * 为什么不是删：干活的结束信号往往落在"调用返回"那一刻，而主 agent 拿到返回值之后
 * 才有机会写自己的结果摘要 —— 直接删就等于"干活的人无声无息地没了"。
 * 服务端 subagentFeed 播完"走到主 agent 面前汇报"再自动回收（RETIRE_MS）。
 *
 * 匹配优先按 id 精确命中**一条**；没有 id 才退回按名字（也只改一条，别动同名的另一只）。
 * 摘要用调用方给的 result，没有就退回「已完成：<任务名>」。
 *
 * @returns {boolean} 有没有改到（没匹配上就是 false，调用方据此决定要不要兜底扫场）
 */
function retireGhost(workspacePath, name, id, result, client, session = '') {
  const file = feedFileFor(workspacePath)
  const feed = readFeedFile(file)
  let hit = id ? feed.agents.findIndex((a) => a.id === id) : -1
  // 没有 id 才退回按名字。按名字这一步也要带会话：两条会话各自召唤同名 subagent 时，
  // 只按名字找会收掉对方那只。
  if (hit < 0) {
    hit = feed.agents.findIndex(
      (a) => a.name === name && (!session || !a.sessionId || String(a.sessionId) === String(session))
    )
  }
  if (hit < 0) return false
  const cur = feed.agents[hit] || {}
  // client 必须传进来：ownsEntry 拿它跟条目上的 client 比。
  if (!ownsEntry(cur, client, session)) return false
  const task = String(cur.task || '').trim()
  const said = String(result || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const next = feed.agents.slice()
  next[hit] = { ...cur, state: 'idle', result: said || (task ? `已完成：${task}` : '已完成') }
  writeFeedFile(file, { ...feed, agents: next })
  return true
}

/**
 * 扫掉本调用方的幽灵。
 *
 * 判据是条目带 `ts`：写条目时一定带 ts，手工 `node scripts/subagents.js set …` 写的
 * 条目没有 ts —— 手工归手工，不动。
 *
 * `all:false`（默认）只扫「从没收过工的孤儿」：带 result 的已经进了「待汇报」流程，
 * 由服务端播完汇报再回收 —— 连它一起扫会把刚做好的汇报动画掐掉。
 * `all:true` 是"这条会话全清"（一轮真的结束了），**不是**"清光整个工程" ——
 * 否则关掉一个终端，另一个终端里还在飞的幽灵会被一起扫掉。
 *
 * @returns {number} 清掉的条数
 */
function sweepGhosts(workspacePath, client, { all = false } = {}, session = '') {
  const file = feedFileFor(workspacePath)
  const feed = readFeedFile(file)
  const doomed = feed.agents.filter(
    (a) => a && a.ts && ownsEntry(a, client, session) && (all || !a.result)
  )
  if (!doomed.length) return 0
  writeFeedFile(file, { ...feed, agents: feed.agents.filter((a) => !doomed.includes(a)) })
  return doomed.length
}

module.exports = {
  feedFileFor,
  readFeedFile,
  writeFeedFile,
  ownsEntry,
  addGhost,
  retireGhost,
  sweepGhosts,
}
