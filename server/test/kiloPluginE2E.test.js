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
  // 把插件的 fetch 拦下来：既打日志（出问题时能一眼看出"是没发"、"发了但 400"还是"发了但被丢"），
  // 也**记一笔流水**（下面的「应用晚起」那一组断言"到底发出去没有"，不该依赖日志开关）。
  const realFetch = globalThis.fetch
  const reqs = []
  globalThis.fetch = async (u, o) => {
    const r = await realFetch(u, o)
    reqs.push({ method: (o && o.method) || 'GET', url: String(u), status: r.status })
    if (process.env.E2E_VERBOSE) console.log(`    [plugin] ${(o && o.method) || 'GET'} ${u} -> ${r.status} ${String(o && o.body || '').slice(0, 160)}`)
    return r
  }

  /* ---- 走**生产形状**接插件 ----
   * 7F 是 Kilo 的 `server(input, options)` 入口（安装器写的那条 plugin 条目就是
   * `[{client:'kilo'}]`，见 scripts/install-hooks.js 的 pluginEntry），形态由**环境**判：
   * VS Code 扩展起的 Kilo 带 KILO_CLIENT=vscode / KILOCODE_FEATURE=vscode-extension /
   * KILO_PLATFORM=vscode（实测 /proc/<pid>/environ），终端 CLI 一个 KILO_* 都没有。
   *
   * 早先这文件走 `setup()`（那是 8F OpenCode 的入口）并显式塞 `{client:'kilo-plugin'}`，
   * **恰好绕开了坏掉的那条路** —— 于是"VS Code 里显示成 Kilo Code CLI、同一轮落两行"
   * 这个 bug 一直是绿的（2026-09-30 实测）。
   */
  process.env.KILO_CLIENT = 'vscode'
  const hooks = await plugin.server({ directory: WS }, { client: 'kilo' })
  /** 喂一条事件：与 Kilo 调 `plugin.event({event})` 同形状 */
  const send = async (evt) => { await hooks.event({ event: evt }); await sleep(160) }
  // **实测信封**（2026-09-27，Kilo 7.8.1 探针）：{ id, type, properties }，没有 data / location。
  // 事件名也只有下面这批 —— 早先那套 session.inbox.enqueued / session.tool.called /
  // session.execution.succeeded 实测一个都不出现。
  let evtNo = 0
  const fire = async (type, properties) => send({ id: `evt_${(evtNo += 1)}`, type, properties: { sessionID: SID, ...properties } })
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
  // 身份**按精确值**认：VS Code 起的这份必须是 kilo-plugin（判成 kilo 就是本次修的 bug）
  const mem = all("SELECT * FROM members WHERE client = 'kilo-plugin'")[0]
  ok('members 里有 client=kilo-plugin 的成员', Boolean(mem), JSON.stringify(all('SELECT client, role FROM members')))
  ok('role = agent（否则 bus.endTask 不写 task_runs）', mem && mem.role === 'agent', mem && mem.role)
  ok('member 归属 proj-e2e 工程', mem && mem.project_id === 'proj-e2e', mem && mem.project_id)

  console.log('\n[2] 任务台账')
  // task_runs 是**报表表**（一行一次已完成的任务，没有 state 列 —— state 在 tasks 表里）；
  // tasks 是状态表。两张都要查：state 归 tasks，产出归 task_runs。
  //
  // 这一轮的**行数**本身就是要断言的东西：插件那一路（id 是服务端发的 `k_*`）本该
  // 一轮一行；轮询那一路（id 带 `kilo:` 前缀）在插件在场时必须让位（见 kiloTasks.js）。
  // 两路都写 = 同一轮在任务列表里出现两行 —— 2026-09-30 实测到的就是这个（孪生行相差 5 毫秒）。
  const rowsOfSession = all('SELECT id, client, form FROM task_runs WHERE session_id = ?', SID)
  ok('这一轮在台账里**只有一行**（插件与轮询不许各写一行）', rowsOfSession.length === 1, JSON.stringify(rowsOfSession))
  const t = all("SELECT * FROM task_runs WHERE session_id = ? AND id NOT LIKE 'kilo:%'", SID)[0]
  const tk = all("SELECT * FROM tasks WHERE id = ?", t && t.id)[0]
  ok('task_runs 里有这条任务', Boolean(t), JSON.stringify(all('SELECT client, count(*) c FROM task_runs GROUP BY client')))
  if (t) console.log('    [task_runs 行]', JSON.stringify(t))
  ok('client = kilo-plugin（VS Code 形态的身份，不是裸 kilo）', t && t.client === 'kilo-plugin', t && t.client)
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

  console.log('\n[7] 状态文件按身份命名：VS Code 那份是 kilo-plugin_…')
  // 状态文件名是 `<client>@<工程>@<会话>.json`（plugin/index.js 的 statePath），
  // 服务端按文件**内容里的 client** 匹配（sessions.js 的 clientHit）——两处都得是 kilo-plugin，
  // 少一处就表现为「任务列表显示 CLI / 相位读不到」。旧命名（kilo@…）那份是 VS Code
  // 老会话留下的孤儿，不续写、不删（有 TTL 兜底）。
  // 分隔符实测是 `_` 不是 `@`：statePath 的名字是 `join("@")` 之后又过了一道
  // `replace(/[^a-zA-Z0-9._-]/g, "_")`，`@` 不在白名单里，全被洗成 `_`
  // —— 所以真实文件名形如 `kilo-plugin__tmp_ProjE2E_ses_e2e_0001.json`。
  // 认身份就认**开头的 client 段**（client 里不会有 `_`），别按文档里那个 `@` 去认。
  const stateFiles = fs.existsSync(path.join(WG, 'hooks')) ? fs.readdirSync(path.join(WG, 'hooks')) : []
  const vscodeState = stateFiles.filter((n) => n.startsWith('kilo-plugin_'))
  ok('有 kilo-plugin_ 开头的状态文件', vscodeState.length === 1, JSON.stringify(stateFiles))
  const stBody = vscodeState.length ? JSON.parse(fs.readFileSync(path.join(WG, 'hooks', vscodeState[0]), 'utf8')) : {}
  ok('文件内容里的 client 也是 kilo-plugin（服务端按它匹配）', stBody.client === 'kilo-plugin', JSON.stringify(stBody.client))

  console.log('\n[8] 终端 CLI 形态：同一份实现、环境里没有 KILO_* → client=kilo / form=cli')
  // 和 [1] 那组是**同一个入口、同一个选项**，只有环境不同 —— 这正是本次要立的规矩：
  // 选项只说产品（kilo），形态由环境判（VS Code 带 KILO_*，终端不带）。
  const SID2 = 'ses_e2e_0002'
  delete process.env.KILO_CLIENT
  delete process.env.KILOCODE_FEATURE
  delete process.env.KILO_PLATFORM
  const hooksCli = await plugin.server({ directory: WS }, { client: 'kilo' })
  let cliNo = 0
  const cliSend = async (evt) => { await hooksCli.event({ event: evt }); await sleep(160) }
  const cf = async (type, properties) => cliSend({ id: `cliev_${(cliNo += 1)}`, type, properties: { sessionID: SID2, ...properties } })
  await cf('session.created', { info: { id: SID2, directory: WS, title: '终端那轮', model: { id: 'kilo-auto/free' } } })
  await cf('message.updated', { info: { id: 'u2', role: 'user', time: { created: Date.now() } } })
  await cf('message.part.updated', { part: { sessionID: SID2, messageID: 'u2', id: 'p2', type: 'text', text: '"终端里问一句"' } })
  await cf('message.part.updated', { part: { sessionID: SID2, messageID: 'a2', id: 'p2b', type: 'text', role: 'assistant', text: '"终端这一轮做完了"' } })
  await cf('message.updated', { info: { id: 'a2', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } } })
  await cf('session.idle', {})
  await sleep(500)
  const dbCli = new Database(info.dbPath, { readonly: true, fileMustExist: true })
  const cliRows = dbCli.prepare('SELECT id, client, form FROM task_runs WHERE session_id = ?').all(SID2)
  dbCli.close()
  ok('台账里这条是 client=kilo、form=cli（形态由环境判，不写死在选项里）',
    cliRows.length === 1 && cliRows[0].client === 'kilo' && cliRows[0].form === 'cli', JSON.stringify(cliRows))
  const cliState = fs.readdirSync(path.join(WG, 'hooks')).filter((n) => n.startsWith('kilo_'))
  ok('状态文件名是 kilo_ 开头（同一份实现，两个身份各写各的）', cliState.length === 1, JSON.stringify(cliState))

  console.log('\n[9] 应用晚起：建实例时还没有 server.json → 写进去之后下一条事件就接得上')
  // 真实现场（2026-09-30）：VS Code 的 Kilo server 09:04 起、WorkGremlin 10:42 才起。
  // 早先连接信息在建实例那一刻定死（base 常量 + enabled() 恒真/恒假），那个实例的 HTTP 层
  // **永久停摆**：状态文件照写本地磁盘、台账一条不来，而且完全无声。
  const LATE = path.join(TMP, 'late-home')
  fs.mkdirSync(LATE, { recursive: true })
  const prevHome = process.env.WORKGREMLIN_HOME
  process.env.WORKGREMLIN_HOME = LATE
  const SID3 = 'ses_e2e_0003'
  const hooksLate = await plugin.server({ directory: WS }, { client: 'kilo' })
  const beforeN = reqs.length
  await hooksLate.event({ event: { id: 'late_1', type: 'session.created', properties: { sessionID: SID3, info: { id: SID3, directory: WS, title: '晚起的应用' } } } })
  await sleep(400)
  ok('应用还没起时一条都不发（不撞已知不通的端口）', reqs.length === beforeN, `${beforeN} → ${reqs.length}`)
  // 应用起来了：把真实的 server.json 放进这个家目录（同一个端口 / 令牌 / pid）
  fs.copyFileSync(infoFile, path.join(LATE, 'server.json'))
  await hooksLate.event({ event: { id: 'late_2', type: 'session.created', properties: { sessionID: SID3, info: { id: SID3, directory: WS, title: '晚起的应用' } } } })
  await sleep(500)
  const late = reqs.slice(beforeN)
  ok('写完 server.json 后下一条事件就发得出去（不用重启 Kilo）',
    late.some((r) => r.method === 'POST' && r.url.includes('/api/v1/')), JSON.stringify(late))
  ok('而且服务端真的收下了（不是 4xx / 连不上）',
    late.some((r) => r.status >= 200 && r.status < 300), JSON.stringify(late.map((r) => `${r.method} ${r.status}`)))
  process.env.WORKGREMLIN_HOME = prevHome

  console.log('\n[10] 会话**先于**插件实例存在（VS Code 重开窗口 → kilo serve 重启）：一条 session.created 都没有也得能上报')
  // 真实现场（2026-09-30 用户报的「任务记录里还是只显示 Kilo Code、没有 Plugin」）：
  // kilo serve 11:25 重启，而会话 ses_f196… 是 10:08 建的 —— 新进程从头到尾**等不到
  // session.created**。早先成员注册只挂在那一支上，于是这个进程一次注册都不发；而服务端
  // 每个上报入口开头都先 requireMember，查不到就把整条请求 404 掉（`unknown_member`），
  // 插件这侧又是 fire-and-forget → **完全无声**。结果：状态文件照写、台账一条不来，
  // 任务列表里那一轮显示的是轮询兜底那行（client=kilo、form=null），
  // 用户看到的就是「Kilo Code」而不是「Kilo Code Plugin」。
  // 这里特意用**第二个工程**（它的成员从没被注册过），
  // 免得"能落库"是蹭了前面几组已经注册出来的那个成员。
  const WS2 = '/tmp/ProjE2E2'
  fs.mkdirSync(WS2, { recursive: true })
  fs.writeFileSync(path.join(WS2, 'package.json'), JSON.stringify({ name: 'proj-e2e2', version: '1.0.0' }))
  const SID4 = 'ses_e2e_0004'
  process.env.KILO_CLIENT = 'vscode'
  const hooksResumed = await plugin.server({ directory: WS2 }, { client: 'kilo' })
  let rsNo = 0
  const rs = async (type, properties) => {
    await hooksResumed.event({ event: { id: `rsev_${(rsNo += 1)}`, type, properties: { sessionID: SID4, ...properties } } })
    await sleep(160)
  }
  // **故意一条 session.created 都不喂** —— 这就是"进程重启、会话早就在"的形状
  await rs('message.updated', { info: { id: 'u4', role: 'user', time: { created: Date.now() } } })
  await rs('message.part.updated', { part: { sessionID: SID4, messageID: 'u4', id: 'p4', type: 'text', text: '"重开窗口之后这一轮"' } })
  await rs('message.part.updated', { part: { sessionID: SID4, messageID: 'a4', id: 'p4b', type: 'text', role: 'assistant', text: '"这一轮也做完了"' } })
  await rs('message.updated', { info: { id: 'a4', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } } })
  await rs('session.idle', {})
  await sleep(600)
  const dbR = new Database(info.dbPath, { readonly: true, fileMustExist: true })
  const rows4 = dbR.prepare('SELECT id, project_id, client, form FROM task_runs WHERE session_id = ?').all(SID4)
  const pid4 = rows4[0] && rows4[0].project_id
  const mem4 = pid4 ? dbR.prepare('SELECT id, client, role FROM members WHERE project_id = ?').all(pid4) : []
  dbR.close()
  ok('没有 session.created 也落了台账（注册改成"重试到成功为止"）', rows4.length === 1, JSON.stringify(rows4))
  ok('client=kilo-plugin / form=plugin —— 任务记录里标的是「Kilo Code Plugin」',
    rows4[0] && rows4[0].client === 'kilo-plugin' && rows4[0].form === 'plugin', JSON.stringify(rows4))
  ok('成员是这个工程上报时现注册出来的（不是蹭前面几组注册的）',
    mem4.some((m) => m.client === 'kilo-plugin' && m.role === 'agent'), JSON.stringify(mem4))

  console.log('\n[11] 会话级 diff 不许把**别人改的**文件算进这一轮（按 mtime 划窗口）')
  // 真实现场（2026-09-30 12:35，用户报的「这个任务显示有两个文件改动，kilotask.js /
  // taskSync.test.js，这两个文件是你改的吗」）：一条 5 秒就被打断的 Kilo 任务，台账上写了
  // 那两个文件 —— 它们是**同工程另一个 agent 12:25 改的**，本轮一条 patch part、
  // 一个写类工具都没有，7F 轮询那一路（kilo.js 只认 patch part）算出来是 0 个文件。
  // 根因：`session.diff` 是**会话级**差集（对照会话自己的快照基线），会话开着的时候
  // 谁改的都列在里面 —— 插件把它当"本轮改动"直接记账，于是把别人的活算到自己头上。
  // 修法：按 mtime 落在本轮窗口内（>= startTask 时刻）筛，见 plugin/index.js 的 steppedOf。
  const WS3 = '/tmp/ProjE2E3'
  fs.mkdirSync(WS3, { recursive: true })
  fs.writeFileSync(path.join(WS3, 'package.json'), JSON.stringify({ name: 'proj-e2e3', version: '1.0.0' }))
  // 别人一小时前改好的文件：本轮的 session.diff 里**仍然会列它**（会话级差集）
  const OLD = path.join(WS3, 'old-by-someone-else.ts')
  fs.writeFileSync(OLD, '// 别人一小时前改的\n')
  const hourAgo = new Date(Date.now() - 3_600_000)
  fs.utimesSync(OLD, hourAgo, hourAgo)
  await post(`${base}/api/v1/workspace`, info.token, { project: 'proj-e2e3', workspacePath: WS3 })
  const SID5 = 'ses_e2e_0005'
  const hooksDiff = await plugin.server({ directory: WS3 }, { client: 'kilo' })
  let d5 = 0
  const rs5 = async (type, properties) => {
    await hooksDiff.event({ event: { id: `diffev_${(d5 += 1)}`, type, properties: { sessionID: SID5, ...properties } } })
    await sleep(160)
  }
  await rs5('session.created', { info: { id: SID5, directory: WS3, title: '会话级 diff 的那一轮', model: { id: 'kilo-auto/free' } } })
  await rs5('message.updated', { info: { id: 'u5', role: 'user', time: { created: Date.now() } } })
  await rs5('message.part.updated', { part: { sessionID: SID5, messageID: 'u5', id: 'p5', type: 'text', text: '"这一轮只该记新文件"' } })
  // 本轮真落盘的那个文件：**故意不给写类工具事件**（不给 roundFiles 供料），只能走
  // session.diff 这一路 —— 这样下面断言的就是纯粹的"筛子有没有按 mtime 放行"。
  const NEWF = path.join(WS3, 'made-this-round.ts')
  fs.writeFileSync(NEWF, '// 本轮写的\n')
  await rs5('session.diff', { diff: ['old-by-someone-else.ts', 'made-this-round.ts'] })
  await rs5('message.part.updated', { part: { sessionID: SID5, messageID: 'a5', id: 'p5b', type: 'text', role: 'assistant', text: '"这一轮只动了新文件"' } })
  await rs5('message.updated', { info: { id: 'a5', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } } })
  await rs5('session.idle', {})
  await sleep(600)
  const dbD = new Database(info.dbPath, { readonly: true, fileMustExist: true })
  const rows5 = dbD.prepare('SELECT * FROM task_runs WHERE session_id = ? ORDER BY started_at').all(SID5)
  dbD.close()
  ok('第 1 轮（干完了）只记本轮那个文件 —— 别人改的那个被 mtime 筛掉',
    rows5.length === 1 && rows5[0].file_count === 1 && String(rows5[0].files_json || '').includes('made-this-round.ts')
      && !String(rows5[0].files_json || '').includes('old-by-someone-else'),
    JSON.stringify(rows5.map((r) => ({ c: r.file_count, f: r.files_json }))))
  // 主控制台「改动文件」那一栏走的是另一条路（report 的 done.files），也得是筛过的
  const rp5 = await get(`${base}/api/v1/reporter-phase?client=kilo-plugin&session=${encodeURIComponent(SID5)}`, info.token)
  const done5 = (rp5.done && rp5.done.files) || []
  ok('控制台的「改动文件」也只有本轮那个', done5.length === 1 && String(done5[0].path || '').endsWith('made-this-round.ts'),
    JSON.stringify(done5))

  // 第 2 轮：**就是这个现场** —— 被用户 ESC 打断（只有 session.idle，没有 finish=stop），
  // 且 session.diff 里只有那个别人改的旧文件 → 本轮改动必须是 0，不是 1。
  await rs5('message.updated', { info: { id: 'u5b', role: 'user', time: { created: Date.now() } } })
  await rs5('message.part.updated', { part: { sessionID: SID5, messageID: 'u5b', id: 'p5c', type: 'text', text: '"这一轮马上被打断"' } })
  await rs5('session.diff', { diff: ['old-by-someone-else.ts'] })
  await rs5('session.idle', {})
  await sleep(600)
  const dbD2 = new Database(info.dbPath, { readonly: true, fileMustExist: true })
  const rows5b = dbD2.prepare('SELECT * FROM task_runs WHERE session_id = ? ORDER BY started_at').all(SID5)
  const tk5b = dbD2.prepare('SELECT state FROM tasks WHERE id = ?').get(rows5b.length > 1 ? rows5b[1].id : '')
  dbD2.close()
  // 空清单到服务端就落成 null（bus 不拿空数组去覆盖）—— 断言"没有文件"，别咬死 0
  ok('第 2 轮（被打断）没把别人的文件算成自己的改动：没有文件',
    rows5b.length === 2 && !rows5b[1].file_count && !rows5b[1].files_json, JSON.stringify(rows5b.map((r) => ({ c: r.file_count, f: r.files_json }))))
  ok('第 2 轮按取消收尾（不是 done）', tk5b && tk5b.state === 'cancelled', JSON.stringify(tk5b))

  srv.kill('SIGTERM')
  await sleep(300)
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
