/**
 * 端到端：真的起一个 WorkGremlin 服务端（沙箱 HOME → 沙箱 DB，不碰你真实的库），
 * 真的把插件装上去、真的喂事件，然后查服务端库里落了什么。
 *
 * 目的是验证「插件 → ingest → bus → 各张表」整条链真的通，而不是只验证插件发了几个 POST。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-e2e-'))
const WG = path.join(TMP, 'wg')
const WS = '/tmp/ProjE2E'
fs.mkdirSync(WS, { recursive: true })
fs.mkdirSync(WG, { recursive: true })
fs.writeFileSync(path.join(WS, 'package.json'), JSON.stringify({ name: 'proj-e2e', version: '1.0.0' }))

const env = {
  ...process.env,
  HOME: TMP,
  WORKGREMLIN_HOME: WG,
  WORKGREMLIN_SUBAGENTS_FILE: path.join(TMP, 'subagents.json'),
  WORKGREMLIN_NO_AUTO_HOOKS: '1',
}

// **本进程**也锁进沙箱。只给子进程 spawn 传 env 是不够的：插件是 `import()` 到**当前**
// 进程里跑的，它的 readServerInfo() 读的是当前进程的 env —— 漏了这步它会读到你真实的
// ~/.workgremlin/server.json，把测试数据打到**你正在跑的那个 WorkGremlin** 上。
process.env.HOME = TMP
process.env.WORKGREMLIN_HOME = WG
process.env.WORKGREMLIN_SUBAGENTS_FILE = env.WORKGREMLIN_SUBAGENTS_FILE

// Kilo 的轮询那一路也锁进沙箱：它读的是 **另一个进程**（服务端）里的 kilo.js，
// 不设这个就会去读你真实的 ~/.local/share/kilo/kilo.db —— 既是污染，
// 也让「插件真相位压过轮询推导」这条根本没法验证（沙箱会话不在真实库里，轮询那一支
// 压根不会登记这行，登记的是沿用老约定报 'unreported' 的 hook 那一支）。
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
        if (process.env.E2E_VERBOSE) console.log(`    GET ${url} -> ${res.statusCode} ${raw.slice(0, 200)}`)
        try { resolve(JSON.parse(raw)) } catch (e) { resolve({ __status: res.statusCode, __raw: raw.slice(0, 200) }) }
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
const ok = (l, c, d) => { if (c) { pass++; console.log('  ✓ ' + l) } else { fail++; console.log('  ✗ ' + l + (d === undefined ? '' : '  — ' + d)) } }

async function main() {
  const SID = 'ses_e2e_0001'
  // 往沙箱 kilo.db 里补上这条会话，模拟生产（插件与轮询读**同一个**库）。
  // 不补的话轮询那一支扫不到这个 session_id，登记这行的是沿用老约定报 'unreported'
  // 的 hook 那一支 —— 那样就测不到「插件真相位压过轮询推导」这条了。
  {
    const Database = require('better-sqlite3')
    const kdb = new Database(path.join(KILO_HOME, 'kilo.db'))
    kdb.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
      agent TEXT, model TEXT, summary_files INTEGER, summary_additions INTEGER, summary_deletions INTEGER,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
    kdb.prepare('INSERT INTO session (id, project_id, directory, title, agent, model, summary_files, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(SID, 'proj-e2e', WS, '端到端这一轮做完了', 'code', '{"id":"kilo-auto/free"}', 1, Date.now(), Date.now())
    kdb.close()
  }

  console.log('起沙箱 WorkGremlin 服务端…')
  const env2 = { ...env }
  if (process.env.E2E_VERBOSE) env2.WORKGREMLIN_DEBUG_KILO = '1'
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/src/cli.js')], { env: env2, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  srv.stderr.on('data', (c) => { err += c; if (process.env.E2E_VERBOSE) process.stdout.write(c) })
  srv.stdout.on('data', () => {})

  const infoFile = path.join(WG, 'server.json')
  for (let i = 0; i < 60 && !fs.existsSync(infoFile); i += 1) await sleep(150)
  if (!fs.existsSync(infoFile)) { console.error('服务端没起来：', err.slice(0, 800)); process.exit(1) }
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'))
  const base = `http://127.0.0.1:${info.port}`
  console.log('  端口', info.port)

  // 告诉服务端"当前打开的是这个工程"（插件按服务端当前工程归属，与 hook.js 同一口径）
  await post(`${base}/api/v1/workspace`, info.token, { project: 'proj-e2e', workspacePath: WS })

  const plugin = (await import(pathToFileURL(path.join(ROOT, 'packages/reporter/src/plugin/index.js')))).default
  // 把插件的 fetch 拦下来打日志：出问题时能一眼看出"是没发"、"发了但 400"还是"发了但被丢"
  const realFetch = globalThis.fetch
  globalThis.fetch = async (u, o) => {
    const r = await realFetch(u, o)
    if (process.env.E2E_VERBOSE) console.log(`    [plugin] ${(o && o.method) || 'GET'} ${u} -> ${r.status} ${String(o && o.body || '').slice(0, 160)}`)
    return r
  }
  const q = []; let w = null
  // 已有消费者在等就直接交接，**不要再 push 进队列** —— 同时做两件事等于把同一个事件
  // 交付两次（一次给等待中的 next()，一次留在队列里给下一次 next()），
  // 表现为每个事件都发两遍上报，很难看出是测试脚手架的问题。
  const push = (v) => {
    if (w) { const r = w; w = null; r({ done: false, value: v }); return }
    q.push(v)
  }
  await plugin.setup({
    options: { client: 'kilo-plugin' },
    location: { directory: WS },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => q.length ? Promise.resolve({ done: false, value: q.shift() }) : new Promise((r) => { w = r }) }) }) },
    emit: push,
  })
  // **实测信封**（2026-09-27，Kilo 7.8.1 探针）：{ id, type, properties }，没有 data / location。
  // 事件名也只有下面这批 —— 早先那套 session.inbox.enqueued / session.tool.called /
  // session.execution.succeeded 实测一个都不出现。
  let evtNo = 0
  const fire = async (type, properties) => { push({ id: `evt_${(evtNo += 1)}`, type, properties: { sessionID: SID, ...properties } }); await sleep(160) }
  const part = (p, messageID) => fire('message.part.updated', { part: { sessionID: SID, messageID, ...p } })
  const msg = (info) => fire('message.updated', { info: { sessionID: SID, ...info } })

  console.log('\n喂一轮完整事件…')
  await fire('session.created', { info: { id: SID, directory: WS, title: '端到端这一轮做完了', model: { id: 'kilo-auto/free', providerID: 'kilo' } } })
  await msg({ id: 'msg_u', role: 'user', time: { created: Date.now() } })
  await part({ id: 'prt_1', type: 'text', text: '"端到端：让 7F 记上任务"' }, 'msg_u')
  await part({ id: 'prt_2', type: 'tool', tool: 'write', callID: 'c1', state: { status: 'running', input: { filePath: `${WS}/a.ts` } } }, 'msg_a')
  await part({ id: 'prt_3', type: 'tool', tool: 'task', callID: 'c2', state: { status: 'running', input: { subagent_type: 'leo', description: '顺手看一眼' } } }, 'msg_a')
  // 这一步之前 assistant 已经说过话（msg_a 的 role 由下面那条 message.updated 补上，
  // 这里 part 自带 role=assistant，插件认 part.role）——**整轮还没完**（finish=stop 还没来）
  await part({ id: 'prt_3b', type: 'text', role: 'assistant', text: '"先看一眼再动手"' }, 'msg_a')
  {
    // 轮中的 assistant 文字 → 思考中，不是待命（实测 2026-09-28 修的坑）。
    // 早先这里报 idle，主 agent 会在任务还在跑的时候闪回「待命中」。
    const rpMid = await get(`${base}/api/v1/reporter-phase?client=kilo-plugin&session=${encodeURIComponent(SID)}`, info.token)
    ok('轮中的 assistant 文字 → 思考中（不是待命）', rpMid.phase === 'thinking', JSON.stringify(rpMid))
    ok('「思考中」带上了用户那句话', rpMid.prompt === '端到端：让 7F 记上任务', JSON.stringify(rpMid.prompt))
  }
  await part({ id: 'prt_4', type: 'text', text: '"端到端这一轮做完了"' }, 'msg_a')
  await fire('session.diff', { diff: ['a.ts'] })
  await msg({ id: 'msg_a', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } })
  await fire('session.idle', {})
  await sleep(500)

  if (process.env.E2E_VERBOSE) {
    const hd = path.join(WG, 'hooks')
    for (const n of fs.readdirSync(hd)) console.log('    [state]', n, fs.readFileSync(path.join(hd, n), 'utf8').slice(0, 400))
  }

  console.log('\n[1] 成员：办公室里有这只小怪物了吗')
  // 直接查沙箱库：比猜 API 响应形状更准，断言的是"服务端真的落库了"这件事本身
  const Database = require('better-sqlite3')
  const db = new Database(info.dbPath, { readonly: true, fileMustExist: true })
  const all = (sql, ...a) => db.prepare(sql).all(...a)
  const mem = all("SELECT * FROM members WHERE client LIKE 'kilo%'")[0]
  ok('members 里有 client=kilo-plugin 的成员', Boolean(mem), JSON.stringify(all('SELECT client, role FROM members')))
  ok('role = agent（否则 bus.endTask 不写 task_runs）', mem && mem.role === 'agent', mem && mem.role)
  ok('member 归属 proj-e2e 工程', mem && mem.project_id === 'proj-e2e', mem && mem.project_id)

  console.log('\n[2] 任务台账')
  // task_runs 是**报表表**（一行一次已完成的任务，没有 state 列 —— state 在 tasks 表里）；
  // tasks 是状态表。两张都要查：state 归 tasks，产出归 task_runs。
  const t = all("SELECT * FROM task_runs WHERE client LIKE 'kilo%'")[0]
  const tk = all("SELECT * FROM tasks WHERE id = ?", t && t.id)[0]
  ok('task_runs 里有这条任务', Boolean(t), JSON.stringify(all('SELECT client, count(*) c FROM task_runs GROUP BY client')))
  if (t) console.log('    [task_runs 行]', JSON.stringify(t))
  ok('标题 = 用户那句话', t && t.title === '端到端：让 7F 记上任务', t && t.title)
  ok('tasks 里 state = done', tk && tk.state === 'done', tk && tk.state)
  ok('收尾自述 = 会话标题', t && String(t.result || '').includes('端到端这一轮做完了'), t && t.result)
  ok('收工时间 / 耗时记上了', t && t.ended_at > 0 && t.duration_ms > 0, t && `${t.ended_at}/${t.duration_ms}`)
  ok('本轮改动文件**去重后**只有一个（相对/绝对路径不许记两遍）', t && t.file_count === 1, t && `${t.file_count} ${t.files_json}`)
  ok('带 session_id（轴 2）', t && t.session_id === SID, t && t.session_id)
  ok('带 model', t && t.model === 'kilo-auto/free', t && t.model)
  ok('带形态（plugin）', t && t.form === 'plugin', t && t.form)

  console.log('\n[3] 对话记录 + 文件活动 + agent_status')
  const m = all("SELECT * FROM messages WHERE content LIKE '%端到端这一轮做完了%'")[0]
  ok('收尾自述进了对话记录', Boolean(m), JSON.stringify(all('SELECT from_member, type FROM messages')))
  ok('消息 type = result', m && m.type === 'result', m && m.type)
  const fa = all("SELECT * FROM file_activity WHERE member_id LIKE 'kilo%'")
  ok('file_activity 记上了改过的文件', fa.length >= 1, JSON.stringify(fa))
  ok('文件路径正确', fa.some((x) => String(x.path).endsWith('a.ts')), JSON.stringify(fa))
  const st = all("SELECT * FROM agent_status WHERE member_id LIKE 'kilo%'")[0]
  ok('agent_status 有这只成员（收工后回落 idle）', Boolean(st) && st.state === 'idle', st && st.state)

  console.log('\n[4] 7F 楼层在 /sessions 里能列出会话 + 相位')
  const snap = await get(`${base}/api/v1/sessions?refresh=1`, info.token)
  const f7 = (snap.floors || []).find((x) => x.id === '7F')
  ok('7F 在', Boolean(f7), JSON.stringify((snap.floors || []).map((x) => x.id)))
  const row = f7 && f7.sessions.find((s) => s.sessionId === SID)
  ok('会话说这条会话在跑', Boolean(row), JSON.stringify(f7 && f7.sessions.map((s) => s.sessionId)))
  ok('相位是上报真值（reported，不灰显）', row && row.inferred === false, row && JSON.stringify({ phase: row.phase, inferred: row.inferred }))

  console.log('\n[5] /reporter-phase 给得出真相位 + 模型 + instrumented')
  const rp = await get(`${base}/api/v1/reporter-phase?client=kilo-plugin&session=${encodeURIComponent(SID)}`, info.token)
  // 收工之后相位回到 idle（待命）——**这是对的**：Kilo 收完工会发 session.idle。
  // 「任务完成」不靠相位显示，而靠 done 标记（渲染层把 mainAgent.phase 置成 'done' 的条件是
  // fastDoneAt 有值，见 IsoOfficeView）——所以这里断言 idle 与 done 标记同时成立。
  ok('收工后相位回到 idle（待命）', rp.phase === 'idle', JSON.stringify(rp));
  ok('model 带出来了', rp.model === 'kilo-auto/free', rp.model)
  ok('instrumented = true', rp.instrumented === true, String(rp.instrumented))
  ok('完成标记带改动文件清单', rp.done && Array.isArray(rp.done.files), JSON.stringify(rp.done))

  console.log('\n[6] 幽灵：召唤的那只已经收工并被扫掉')
  const feedFile = env.WORKGREMLIN_SUBAGENTS_FILE
  const feed = fs.existsSync(feedFile) ? JSON.parse(fs.readFileSync(feedFile, 'utf8')) : { agents: [] }
  ok('召唤时飘起来过、收工后散场了', !feed.agents.find((a) => a.id === 'c2'), JSON.stringify(feed.agents))
  db.close()

  srv.kill('SIGTERM')
  await sleep(300)
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
