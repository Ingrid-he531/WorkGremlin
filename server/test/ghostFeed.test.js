/**
 * subagent 幽灵清单格式自检（ghostFeed.js —— hook.js 与 OpenCode/Kilo 插件共用的那一份）。
 *
 * 跑法：`npm run test:ghost`
 *
 * 为什么要有它：这份 JSON 结构是 WorkGremlin 的**公开约定**，三个写家
 * （hook.js、插件、人手敲的 scripts/subagents.js）必须逐字一致。早期它只活在 hook.js 里，
 * 插件另写一份时两个 `ownsEntry` 口径就分叉过（一个按"有 ts"扫场、另一个还当手工条目跳过），
 * 幽灵就永远收不掉。抽成共享模块后，"两边会不会又分叉"就得有测试钉住。
 *
 * 覆盖：定位规则 / addGhost 去重与字段 / ownsEntry 的 client+会话隔离 /
 *       retireGhost 改待汇报而不是删 / sweepGhosts 的三种范围 / 坏文件不抛。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ghost-'))
const WS = path.join(TMP, 'proj')
fs.mkdirSync(WS, { recursive: true })
const FILE = path.join(WS, '.workgremlin', 'subagents.json')
// ghostFeed.js 是 packages/reporter/src/ 下的共享模块（hook.js 与 OpenCode/Kilo 插件都用它），
// 不是 server/src/ —— 本文件在 server/test/，要往上两级。
const g = require('../../packages/reporter/src/ghostFeed')

let pass = 0
let fail = 0
const ok = (l, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + l) } else { fail++; console.log('  ✗ ' + l + (d === undefined ? '' : '  — ' + d)) }
}


console.log('[1] 定位规则')
ok('认工程路径下的 .workgremlin/subagents.json', g.feedFileFor(WS) === FILE, g.feedFileFor(WS))
ok('空工程路径回退 cwd', g.feedFileFor('') === path.join(process.cwd(), '.workgremlin', 'subagents.json'))

console.log('\n[2] addGhost 去重与字段')
g.addGhost(WS, 'susan', '探查数据流', 'call-1', 'task-1', 'kilo-auto', 'kilo', 'ses_a')
let f = g.readFeedFile(FILE)
ok('写进去一条', f.agents.length === 1, JSON.stringify(f.agents))
ok('字段齐全（ts/client/sessionId/task/id/parent/model）',
  f.agents[0].ts > 0 && f.agents[0].client === 'kilo' && f.agents[0].sessionId === 'ses_a' &&
  f.agents[0].task === '探查数据流' && f.agents[0].id === 'call-1' &&
  f.agents[0].parent === 'task-1' && f.agents[0].model === 'kilo-auto', JSON.stringify(f.agents[0]))
g.addGhost(WS, 'susan', '另一单', 'call-1', '', '', 'kilo', 'ses_a')
ok('同 id 不重复登记', g.readFeedFile(FILE).agents.length === 1)
g.addGhost(WS, 'susan', '另一会话的单', '', '', '', 'kilo', 'ses_b')
ok('不同会话的同名 subagent 各登记一条', g.readFeedFile(FILE).agents.length === 2, g.readFeedFile(FILE).agents.length)

console.log('\n[3] ownsEntry 隔离')
ok('别的 client 不认', g.ownsEntry({ client: 'codex', ts: 1 }, 'kilo') === false)
ok('没写 client 的算 codebuddy 历史条目', g.ownsEntry({ ts: 1 }, 'codebuddy') === true)
ok('没写 client 的对 kilo 不认', g.ownsEntry({ ts: 1 }, 'kilo') === false)
ok('同 client 同会话认', g.ownsEntry({ client: 'kilo', sessionId: 'ses_a' }, 'kilo', 'ses_a') === true)
ok('同 client 不同会话不认', g.ownsEntry({ client: 'kilo', sessionId: 'ses_a' }, 'kilo', 'ses_b') === false)
ok('老条目没 sessionId 时不因缺字段被拒', g.ownsEntry({ client: 'kilo' }, 'kilo', 'ses_a') === true)

console.log('\n[4] retireGhost 改待汇报而不是删')
ok('按 id 命中并改成 idle', g.retireGhost(WS, 'susan', 'call-1', '做完了：3 处改动', 'kilo', 'ses_a') === true)
f = g.readFeedFile(FILE)
const done = f.agents.find((a) => a.id === 'call-1')
ok('条目还在（没被删）', Boolean(done), JSON.stringify(f.agents))
ok('state 变 idle', done && done.state === 'idle', done && done.state)
ok('result 写进去了', done && done.result === '做完了：3 处改动', done && done.result)
ok('没命中时返回 false', g.retireGhost(WS, 'leo', '不存在', 'x', 'kilo', 'ses_a') === false)

console.log('\n[5] retireGhost 不动别人的幽灵')
g.addGhost(WS, 'leo', 'Codex 的活', 'cx-1', '', '', 'codex', 'ses_c')
ok('kilo 收工时不会改 codex 那只', g.retireGhost(WS, 'leo', 'cx-1', 'x', 'kilo', 'ses_c') === false)
ok('codex 那只还是 busy', g.readFeedFile(FILE).agents.find((a) => a.id === 'cx-1').state === 'busy')

console.log('\n[6] sweepGhosts 范围')
// 造：kilo/ses_a 的一只孤儿（无 result）+ 一只待汇报（有 result）+ 一只手工（无 ts）
g.addGhost(WS, 'orphan', '孤儿', 'k-orphan', '', '', 'kilo', 'ses_a')
g.addGhost(WS, 'retired', '已收工', 'k-retired', '', '', 'kilo', 'ses_a')
g.retireGhost(WS, 'retired', 'k-retired', '好了', 'kilo', 'ses_a')
g.writeFeedFile(FILE, { ...g.readFeedFile(FILE), agents: [...g.readFeedFile(FILE).agents, { name: '手工的', state: 'busy' }] })
const n1 = g.sweepGhosts(WS, 'kilo', {}, 'ses_a')
f = g.readFeedFile(FILE)
ok('只扫掉 1 只孤儿', n1 === 1, n1)
ok('待汇报那只保住了', Boolean(f.agents.find((a) => a.id === 'k-retired')))
ok('手工条目（无 ts）没被动', Boolean(f.agents.find((a) => a.name === '手工的')))
ok('别的会话那只还在', Boolean(f.agents.find((a) => a.sessionId === 'ses_b')))
const n2 = g.sweepGhosts(WS, 'kilo', { all: true }, 'ses_a')
f = g.readFeedFile(FILE)
// ses_a 里此时有**两只**已收工待汇报的（[4] 收的那只 + [6] 收的那只），all:true 应一次全清
ok('all:true 把本会话的待汇报全清（含 [4] 收的那只）', n2 === 2 && !f.agents.find((a) => a.id === 'k-retired') && !f.agents.find((a) => a.id === 'call-1'), `${n2} ${JSON.stringify(f.agents)}`)
ok('别会话的没被清', Boolean(f.agents.find((a) => a.sessionId === 'ses_b')))
ok('codex 的没被清', Boolean(f.agents.find((a) => a.id === 'cx-1')))

console.log('\n[7] 坏文件不抛')
fs.writeFileSync(FILE, 'not json')
ok('坏 JSON 读成空清单', g.readFeedFile(FILE).agents.length === 0)
ok('坏 JSON 下 sweep 不抛', g.sweepGhosts(WS, 'kilo', { all: true }, 'ses_a') === 0)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
