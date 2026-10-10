/**
 * subagent 幽灵清单格式自检（单一真源现为 server/src/ingest/hookCommon 的 ghost 写入，
 * 由 /api/v1/ghost 与 CLI hook 路径共用；IDE 插件不再自己写文件）。
 *
 * 跑法：`npm run test:ghost`
 *
 * 为什么要有它：这份 JSON 结构是 WorkGremlin 的**公开约定**，写家原本有三（hook.js、插件、
 * scripts/subagents.js），抽成服务端单一实现后，"两边会不会又分叉"仍得有测试钉住。
 *
 * 覆盖：addGhost 去重与字段 / ownsEntry 的 client+会话隔离（含 -plugin 归一）/
 *       retireGhost 改待汇报而不是删 / sweepGhosts 的三种范围 / 坏文件不抛。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { addGhost, retireGhost, sweepGhosts, ownsEntry } = require('../src/ingest/hookCommon')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ghost-'))
const WS = path.join(TMP, 'proj')
fs.mkdirSync(WS, { recursive: true })
const FILE = path.join(WS, '.workgremlin', 'subagents.json')

// 读清单（直接解析，catch → 空），不依赖 hookCommon 未导出的辅助函数
function readFeed() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(d) ? d : Array.isArray(d.agents) ? d.agents : []
  } catch {
    return []
  }
}
function writeFeed(agents) {
  fs.writeFileSync(FILE, JSON.stringify({ project: '', agents }, null, 2))
}

let pass = 0
let fail = 0
const ok = (l, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + l) } else { fail++; console.log('  ✗ ' + l + (d === undefined ? '' : '  — ' + d)) }
}

console.log('[1] addGhost 去重与字段')
addGhost(WS, 'susan', '探查数据流', 'call-1', 'task-1', 'kilo-auto', 'kilo', 'ses_a')
let a = readFeed()
ok('写进去一条', a.length === 1, JSON.stringify(a))
ok('字段齐全（ts/client/sessionId/task/id/parent/model）',
  a[0].ts > 0 && a[0].client === 'kilo' && a[0].sessionId === 'ses_a' &&
  a[0].task === '探查数据流' && a[0].id === 'call-1' && a[0].parent === 'task-1' && a[0].model === 'kilo-auto', JSON.stringify(a[0]))
addGhost(WS, 'susan', '另一单', 'call-1', '', '', 'kilo', 'ses_a')
ok('同 id 不重复登记', readFeed().length === 1)
addGhost(WS, 'susan', '另一会话的单', '', '', '', 'kilo', 'ses_b')
ok('不同会话的同名 subagent 各登记一条', readFeed().length === 2, readFeed().length)

console.log('\n[2] ownsEntry 隔离')
ok('别的 client 不认', ownsEntry({ client: 'codex', ts: 1 }, 'kilo') === false)
ok('没写 client 的算 codebuddy 历史条目', ownsEntry({ ts: 1 }, 'codebuddy') === true)
ok('没写 client 的对 kilo 不认', ownsEntry({ ts: 1 }, 'kilo') === false)
ok('同 client 同会话认', ownsEntry({ client: 'kilo', sessionId: 'ses_a' }, 'kilo', 'ses_a') === true)
ok('同 client 不同会话不认', ownsEntry({ client: 'kilo', sessionId: 'ses_a' }, 'kilo', 'ses_b') === false)
ok('老条目没 sessionId 时不因缺字段被拒', ownsEntry({ client: 'kilo' }, 'kilo', 'ses_a') === true)
// 统一去 -plugin 后缀后同一归属（hookCommon 用 clientFamily，这正是历史分叉点）
ok('client 带 -plugin 后缀仍认（clientFamily 归一）', ownsEntry({ client: 'kilo-plugin', sessionId: 'ses_a' }, 'kilo', 'ses_a') === true)

console.log('\n[3] retireGhost 改待汇报而不是删')
ok('按 id 命中并改成 idle', retireGhost(WS, 'susan', 'call-1', '做完了：3 处改动', 'kilo', 'ses_a') === true)
a = readFeed()
const done = a.find((x) => x.id === 'call-1')
ok('条目还在（没被删）', Boolean(done), JSON.stringify(a))
ok('state 变 idle', done && done.state === 'idle', done && done.state)
ok('result 写进去了', done && done.result === '做完了：3 处改动', done && done.result)
ok('没命中时返回 false', retireGhost(WS, 'leo', '不存在', 'x', 'kilo', 'ses_a') === false)

console.log('\n[4] retireGhost 不动别人的幽灵')
addGhost(WS, 'leo', 'Codex 的活', 'cx-1', '', '', 'codex', 'ses_c')
ok('kilo 收工时不会改 codex 那只', retireGhost(WS, 'leo', 'cx-1', 'x', 'kilo', 'ses_c') === false)
ok('codex 那只还是 busy', readFeed().find((x) => x.id === 'cx-1').state === 'busy')

console.log('\n[5] sweepGhosts 范围')
// 造：kilo/ses_a 的一只孤儿（无 result）+ 一只待汇报（有 result）+ 一只手工（无 ts）
addGhost(WS, 'orphan', '孤儿', 'k-orphan', '', '', 'kilo', 'ses_a')
addGhost(WS, 'retired', '已收工', 'k-retired', '', '', 'kilo', 'ses_a')
retireGhost(WS, 'retired', 'k-retired', '好了', 'kilo', 'ses_a')
writeFeed([...readFeed(), { name: '手工的', state: 'busy' }])
const n1 = sweepGhosts(WS, 'kilo', {}, 'ses_a')
a = readFeed()
ok('只扫掉 1 只孤儿', n1 === 1, n1)
ok('待汇报那只保住了', Boolean(a.find((x) => x.id === 'k-retired')))
ok('手工条目（无 ts）没被动', Boolean(a.find((x) => x.name === '手工的')))
ok('别的会话那只还在', Boolean(a.find((x) => x.sessionId === 'ses_b')))
const n2 = sweepGhosts(WS, 'kilo', { all: true }, 'ses_a')
a = readFeed()
// ses_a 里此时有**两只**已收工待汇报的（[3] 收的那只 + [5] 收的那只），all:true 应一次全清
ok('all:true 把本会话的待汇报全清（含 [3] 收的那只）', n2 === 2 && !a.find((x) => x.id === 'k-retired') && !a.find((x) => x.id === 'call-1'), `${n2} ${JSON.stringify(a)}`)
ok('别会话的没被清', Boolean(a.find((x) => x.sessionId === 'ses_b')))
ok('codex 的没被清', Boolean(a.find((x) => x.id === 'cx-1')))

console.log('\n[6] 坏文件不抛')
fs.writeFileSync(FILE, 'not json')
ok('坏 JSON 下 sweep 不抛', sweepGhosts(WS, 'kilo', { all: true }, 'ses_a') === 0)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
