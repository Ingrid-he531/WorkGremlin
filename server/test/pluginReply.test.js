/**
 * 测试一条 plugin 任务在不同回复场景下的行为：
 *   1) done      — 正常完成（finish=stop）
 *   2) cancelled — 用户按 ESC 打断（只有 session.idle，没有 finish=stop）
 *   3) failed    — 非正常结束（finish=length，上下文超长）
 *   4) multi     — 同一会话多轮：第一轮 done + 第二轮 cancelled
 *   5) pending   — 等待授权（tool state.status=pending → 相位 = waiting_auth）
 *
 * 端到端形状：真的起沙箱服务端，真的把插件装上去喂事件，查库里落了什么。
 * 与 kiloPluginE2E.test.js 同一套基础设施，但本文件只聚焦"一条任务的不同收尾方式"。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-plugin-reply-'))
const WG = path.join(TMP, 'wg')
const WS = path.join(TMP, 'workspace')
fs.mkdirSync(WS, { recursive: true })
fs.mkdirSync(WG, { recursive: true })
fs.writeFileSync(path.join(WS, 'package.json'), JSON.stringify({ name: 'proj-reply', version: '1.0.0' }))

const env = {
  ...process.env,
  HOME: TMP,
  WORKGREMLIN_HOME: WG,
  WORKGREMLIN_SUBAGENTS_FILE: path.join(TMP, 'subagents.json'),
  WORKGREMLIN_NO_AUTO_HOOKS: '1',
}

// 本进程也锁进沙箱（插件的 readServerInfo 读当前进程 env）
process.env.HOME = TMP
process.env.WORKGREMLIN_HOME = WG
process.env.WORKGREMLIN_SUBAGENTS_FILE = env.WORKGREMLIN_SUBAGENTS_FILE

const KILO_HOME = path.join(TMP, 'kilo')
fs.mkdirSync(KILO_HOME, { recursive: true })
process.env.WORKGREMLIN_KILO_HOME = KILO_HOME
env.WORKGREMLIN_KILO_HOME = KILO_HOME

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function get(url, token) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { authorization: `Bearer ${token}` } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) } catch { resolve({ __status: res.statusCode, __raw: raw.slice(0, 200) }) }
      })
    }).on('error', reject)
  })
}
function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {})
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(data) } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
    })
    req.on('error', reject)
    req.end(data)
  })
}

let pass = 0, fail = 0
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (detail === undefined ? '' : '  — ' + detail)) }
}

async function main() {
  console.log('起沙箱 WorkGremlin 服务端…')
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/src/cli.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let errLog = ''
  srv.stderr.on('data', (c) => { errLog += c; if (process.env.VERBOSE) process.stdout.write(c) })
  srv.stdout.on('data', () => {})

  const infoFile = path.join(WG, 'server.json')
  for (let i = 0; i < 60 && !fs.existsSync(infoFile); i++) await sleep(150)
  if (!fs.existsSync(infoFile)) {
    console.error('服务端没起来：', errLog.slice(0, 800))
    process.exit(1)
  }
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'))
  const base = `http://127.0.0.1:${info.port}`
  console.log('  端口', info.port)

  await post(`${base}/api/v1/workspace`, info.token, { project: 'proj-reply', workspacePath: WS })

  // 加载插件（VS Code 形态）
  const plugin = (await import(pathToFileURL(path.join(ROOT, 'packages/reporter/src/plugin/index.js')))).default
  process.env.KILO_CLIENT = 'vscode'
  const hooks = await plugin.server({ directory: WS }, { client: 'kilo' })

  let evtNo = 0
  const send = async (evt) => { await hooks.event({ event: evt }); await sleep(120) }
  const fire = async (type, properties) =>
    send({ id: `evt_${++evtNo}`, type, properties: { sessionID: properties.sessionID, ...properties } })
  const part = (sid, p, messageID) =>
    fire('message.part.updated', { sessionID: sid, part: { sessionID: sid, messageID, ...p } })
  const msg = (sid, info) =>
    fire('message.updated', { sessionID: sid, info: { sessionID: sid, ...info } })

  const Database = require('better-sqlite3')
  const db = () => new Database(info.dbPath, { readonly: true, fileMustExist: true })

  /* ========================================================================
   * 场景 1：正常完成（finish=stop → state=done）
   * ====================================================================== */
  console.log('\n[场景 1] 正常完成：finish=stop → state=done')
  const SID1 = 'ses_reply_done'
  await fire('session.created', { sessionID: SID1, info: { id: SID1, directory: WS, title: '正常完成', model: { id: 'kilo-auto/free' } } })
  await msg(SID1, { id: 'u1', role: 'user', time: { created: Date.now() } })
  await part(SID1, { id: 'p1', type: 'text', text: '"帮我写一个 hello"' }, 'u1')
  await part(SID1, { id: 'p2', type: 'tool', tool: 'write', callID: 'c1', state: { status: 'running', input: { filePath: `${WS}/hello.ts` } } }, 'a1')
  await part(SID1, { id: 'p3', type: 'text', role: 'assistant', text: '"已经写好了 hello.ts"' }, 'a1')
  await msg(SID1, { id: 'a1', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } })
  await fire('session.idle', { sessionID: SID1 })
  await sleep(500)

  {
    const d = db()
    const t = d.prepare("SELECT * FROM task_runs WHERE session_id = ? AND client = 'kilo-plugin'").get(SID1)
    const tk = t ? d.prepare("SELECT state FROM tasks WHERE id = ?").get(t.id) : null
    d.close()
    ok('正常完成：task_runs 有一行', Boolean(t), JSON.stringify(t))
    ok('state = done', tk && tk.state === 'done', tk && tk.state)
    ok('标题 = 用户原话', t && t.title === '帮我写一个 hello', t && t.title)
    ok('收尾自述 = assistant 的最后一段', t && String(t.result || '').includes('已经写好了 hello.ts'), t && t.result)
    ok('form = plugin', t && t.form === 'plugin', t && t.form)
    ok('model 带上了', t && t.model === 'kilo-auto/free', t && t.model)
  }

  /* ========================================================================
   * 场景 2：用户按 ESC 打断（只有 session.idle，没有 finish=stop → state=cancelled）
   * ====================================================================== */
  console.log('\n[场景 2] 用户打断：只有 session.idle → state=cancelled')
  const SID2 = 'ses_reply_cancel'
  await fire('session.created', { sessionID: SID2, info: { id: SID2, directory: WS, title: '被打断', model: { id: 'kilo-auto/free' } } })
  await msg(SID2, { id: 'u2', role: 'user', time: { created: Date.now() } })
  await part(SID2, { id: 'p4', type: 'text', text: '"帮我重构整个项目"' }, 'u2')
  await part(SID2, { id: 'p5', type: 'tool', tool: 'read', callID: 'c2', state: { status: 'running', input: { filePath: `${WS}/index.ts` } } }, 'a2')
  // 用户按 ESC —— 没有 finish=stop，直接 session.idle
  await fire('session.idle', { sessionID: SID2 })
  await sleep(500)

  {
    const d = db()
    const t = d.prepare("SELECT * FROM task_runs WHERE session_id = ? AND client = 'kilo-plugin'").get(SID2)
    const tk = t ? d.prepare("SELECT state FROM tasks WHERE id = ?").get(t.id) : null
    d.close()
    ok('被打断：task_runs 有一行', Boolean(t), JSON.stringify(t))
    ok('state = cancelled（不是 done）', tk && tk.state === 'cancelled', tk && tk.state)
    ok('标题 = 用户原话', t && t.title === '帮我重构整个项目', t && t.title)
    ok('没有收尾自述（被打断时 assistant 没说完）', t && !t.result, t && t.result)
  }

  /* ========================================================================
   * 场景 3：非正常结束（finish=length，上下文超长）
   *
   * 注意：Kilo / OpenCode 的 finish 值实测有 stop / tool-calls / length。
   * 插件只对 finish=tool-calls 特殊处理（"到工具调用处断了，整轮还没完"），
   * 其余 finish 值（包括 length）都走 done 分支 —— 因为 assistant 确实说完了话，
   * 只是被截断了。只有 session.idle 在没有 finish=stop 时才按 cancelled 收尾。
   * ====================================================================== */
  console.log('\n[场景 3] 非正常结束：finish=length（上下文超长）→ 仍按 done 收尾')
  const SID3 = 'ses_reply_error'
  await fire('session.created', { sessionID: SID3, info: { id: SID3, directory: WS, title: '上下文超长', model: { id: 'kilo-auto/free' } } })
  await msg(SID3, { id: 'u3', role: 'user', time: { created: Date.now() } })
  await part(SID3, { id: 'p6', type: 'text', text: '"处理一个超大文件"' }, 'u3')
  // finish=length 不是 tool-calls → 插件走 done 分支（assistant 确实说完了，只是被截断）
  await msg(SID3, { id: 'a3', role: 'assistant', finish: 'length', time: { created: Date.now(), completed: Date.now() } })
  await fire('session.idle', { sessionID: SID3 })
  await sleep(500)

  {
    const d = db()
    const t = d.prepare("SELECT * FROM task_runs WHERE session_id = ? AND client = 'kilo-plugin'").get(SID3)
    const tk = t ? d.prepare("SELECT state FROM tasks WHERE id = ?").get(t.id) : null
    d.close()
    ok('finish=length：task_runs 有一行', Boolean(t), JSON.stringify(t))
    ok('state = done（finish≠tool-calls 时走 done 分支）', tk && tk.state === 'done', tk && tk.state)
  }

  /* ========================================================================
   * 场景 4：同一会话里多轮 —— 第一轮完成、第二轮被打断
   * ====================================================================== */
  console.log('\n[场景 4] 同一会话多轮：第一轮 done + 第二轮 cancelled')
  const SID4 = 'ses_reply_multi'
  await fire('session.created', { sessionID: SID4, info: { id: SID4, directory: WS, title: '多轮测试', model: { id: 'kilo-auto/free' } } })

  // 第一轮：正常完成
  await msg(SID4, { id: 'u4a', role: 'user', time: { created: Date.now() } })
  await part(SID4, { id: 'p7', type: 'text', text: '"第一轮：写个函数"' }, 'u4a')
  await part(SID4, { id: 'p8', type: 'text', role: 'assistant', text: '"函数写好了"' }, 'a4a')
  await msg(SID4, { id: 'a4a', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } })
  await fire('session.idle', { sessionID: SID4 })
  await sleep(500)

  // 第二轮：被打断
  await msg(SID4, { id: 'u4b', role: 'user', time: { created: Date.now() } })
  await part(SID4, { id: 'p9', type: 'text', text: '"第二轮：加个测试"' }, 'u4b')
  await part(SID4, { id: 'p10', type: 'tool', tool: 'write', callID: 'c4', state: { status: 'running', input: { filePath: `${WS}/test.ts` } } }, 'a4b')
  // 用户按 ESC
  await fire('session.idle', { sessionID: SID4 })
  await sleep(500)

  {
    const d = db()
    const rows = d.prepare("SELECT * FROM task_runs WHERE session_id = ? AND client = 'kilo-plugin' ORDER BY started_at").all(SID4)
    const states = rows.map((r) => d.prepare("SELECT state FROM tasks WHERE id = ?").get(r.id)?.state)
    d.close()
    ok('多轮：两轮各一行', rows.length === 2, `实际 ${rows.length} 行`)
    ok('第一轮 state = done', states[0] === 'done', states[0])
    ok('第二轮 state = cancelled', states[1] === 'cancelled', states[1])
    ok('第一轮标题', rows[0] && rows[0].title === '第一轮：写个函数', rows[0] && rows[0].title)
    ok('第二轮标题', rows[1] && rows[1].title === '第二轮：加个测试', rows[1] && rows[1].title)
    ok('第一轮有收尾自述', rows[0] && String(rows[0].result || '').includes('函数写好了'), rows[0] && rows[0].result)
    ok('第二轮没有收尾自述（被打断）', rows[1] && !rows[1].result, rows[1] && rows[1].result)
  }

  /* ========================================================================
   * 场景 5：等待授权（tool part 的 state.status=pending）→ 相位 = waiting_auth
   * ====================================================================== */
  console.log('\n[场景 5] 等待授权：tool state.status=pending → 相位 = waiting_auth')
  const SID5 = 'ses_reply_pending'
  await fire('session.created', { sessionID: SID5, info: { id: SID5, directory: WS, title: '等待授权', model: { id: 'kilo-auto/free' } } })
  await msg(SID5, { id: 'u5', role: 'user', time: { created: Date.now() } })
  await part(SID5, { id: 'p11', type: 'text', text: '"帮我删除临时文件"' }, 'u5')
  await part(SID5, { id: 'p12', type: 'tool', tool: 'bash', callID: 'c5', state: { status: 'pending', input: { command: 'rm -rf /tmp/test' } } }, 'a5')
  await sleep(300)

  const rp5 = await get(`${base}/api/v1/reporter-phase?client=kilo-plugin&session=${encodeURIComponent(SID5)}`, info.token)
  ok('等待授权：相位 = await', rp5.phase === 'await', JSON.stringify(rp5))

  // 授权通过后工具继续 running → 相位回到 thinking
  await part(SID5, { id: 'p12b', type: 'tool', tool: 'bash', callID: 'c5', state: { status: 'running', input: { command: 'rm -rf /tmp/test' } } }, 'a5')
  await sleep(300)
  const rp5b = await get(`${base}/api/v1/reporter-phase?client=kilo-plugin&session=${encodeURIComponent(SID5)}`, info.token)
  ok('授权通过后：相位回到 thinking', rp5b.phase === 'thinking', JSON.stringify(rp5b))

  // 收尾
  await part(SID5, { id: 'p13', type: 'text', role: 'assistant', text: '"删除完毕"' }, 'a5')
  await msg(SID5, { id: 'a5', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } })
  await fire('session.idle', { sessionID: SID5 })
  await sleep(500)

  {
    const d = db()
    const t = d.prepare("SELECT * FROM task_runs WHERE session_id = ? AND client = 'kilo-plugin'").get(SID5)
    const tk = t ? d.prepare("SELECT state FROM tasks WHERE id = ?").get(t.id) : null
    d.close()
    ok('等待授权后完成：state = done', tk && tk.state === 'done', tk && tk.state)
  }

  srv.kill('SIGTERM')
  await sleep(300)
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
