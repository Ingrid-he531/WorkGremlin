/**
 * WorkGremlin 的 OpenCode / Kilo Code 插件 —— 给 8F OpenCode（以及任何同族产品）上报**真相位**。
 *
 * ## 为什么需要它
 *
 * 7F/8F 那一类楼层是**轮询**产品的 SQLite 落盘推导相位的（见 server/src/opencode.js）：
 * 零安装、装完即用，但相位一律带 `inferred: true`，UI 按推断灰显。
 * 而且对 OpenCode 来说，轮询**有一个补不上的洞**：
 *
 *   实测 OpenCode 2.0.18 全库 114 条 assistant 消息里，tool 块的 `state.status` 只出现过
 *   **completed / error / running** —— 从来没有 `pending`。也就是说"这个工具正在等用户授权"
 *   这个状态**根本没有落盘**，轮询永远推不出「等待授权」。
 *   OpenCode 把授权做成了独立事件（`permission.asked` / `permission.replied`），
 *   那个信号只在内存事件流里推。
 *
 * 这个插件订阅那条事件流，把相位/完成标记写成 reporter 状态文件，于是：
 *   · 相位是**上报真值**（服务端不标 inferred，UI 不灰显）
 *   · 能显示「等待授权」（轮询做不到的那一相位）
 *   · 完成标记能带**改动文件清单**（实测 `session.step.ended` 事件的 `data.files` 就是本轮
 *     改动的文件路径数组；轮询那边只有 `session.summary_files` 一个计数）
 *
 * 没装插件也能用 —— 8F 会自动退回轮询推导，只是相位灰显、没有「等待授权」、完成标记没有文件清单。
 *
 * ## 事件契约（**实测** 2026-09-27，Kilo 7.8.1，插件内探针跑出来的真实词汇表）
 *
 * 信封是 `{ id, type, properties }` —— **不是** `{ type, data, location }`。
 * 实测只发下面这 10 类事件；早先这里按 `data` 信封与 `session.inbox.enqueued` /
 * `session.tool.called` / `session.execution.succeeded` / `permission.asked` /
 * `session.step.ended` 写，那一串**实测一个都不出现** —— 插件能装上、加载不报错，
 * 却一条状态文件都不写（7F 的任务台账因此永远是空的）。
 *
 *   session.created        info.directory=工程路径 · info.model.id=模型
 *   session.updated        info.title · info.model.id（**模型常常在这才出现**）
 *   message.updated        info.role · info.finish · info.time.completed · info.path.cwd
 *   message.part.updated   part{type:text|tool|reasoning|step-start|step-finish|patch,
 *                           text, tool, callID, state{status,input}, messageID}
 *   message.part.delta     token 级增量 —— 忽略
 *   session.status         status.type = busy | idle
 *   session.idle           这一轮彻底结束
 *   session.drained        队列排空
 *   session.diff           diff[] = 本轮改动的文件
 *   session.next.tool.input.delta  工具入参增量 —— 忽略
 *
 * 派生规则见 `handle()` 的长注释（任务起于 role=user 的 text part、收于 assistant 的
 * finish=stop、等待授权看 tool 的 state.status==='pending'）。
 */

/* Node 内置模块，插件运行环境自带的，不需要额外依赖。 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * subagent 幽灵清单的**格式真源**（与 hook.js 共用同一份实现，见该文件的长注释）。
 * 这里 `createRequire` 是为了从 ESM 里取 CJS 模块 —— 幽灵清单的 JSON 结构只允许有一份实现，
 * 否则两边各写一份，迟早一个按"有 ts"扫场、另一个还当手工条目跳过，幽灵就永远收不掉。
 */
import { createRequire } from "node:module"
const require_ = createRequire(import.meta.url)
const ghostFeed = require_("../ghostFeed.js")

/* ------------------------------ 上报身份 ------------------------------ */

/**
 * 「这个进程是编辑器里起的吗」的专属信号 —— **按产品分开列**。
 * 混在一起认会让两边的变量互相污染：Kilo 的 CLI 进程里一个 KILO_* 都没有（实测 2026-09-30，
 * `/proc/<pid>/environ` 只有安装垫片留下的 KILO_TREE_SITTER_WASM_DIR），而 VS Code 扩展起的
 * `kilo serve` 三个都齐（KILO_CLIENT=vscode / KILOCODE_FEATURE=vscode-extension / KILO_PLATFORM=vscode）。
 */
const VSCODE_ENV = {
  kilo: [
    ["KILO_CLIENT", "vscode"],
    ["KILOCODE_FEATURE", "vscode-extension"],
    ["KILO_PLATFORM", "vscode"],
  ],
  opencode: [
    ["OPENCODE_CLIENT", "vscode"],
    ["OPENCODE_FEATURE", "vscode-extension"],
  ],
}

/**
 * 上报身份（= products.js 里的 client）= **产品基名** + **形态**，两件事分开定：
 *
 *   · 产品基名（kilo / opencode）**由入口给**：`setup(ctx)` 是 OpenCode 的插件 API、
 *     `server(input, options)` 是 Kilo 的 —— 走哪个入口就说明是哪个产品，不用猜。
 *     配置里显式写了 `client` 也归一到基名（`kilo-plugin` → `kilo`）。
 *   · 形态（CLI / VS Code 插件）**由环境判**：同一份二进制在终端里和编辑器里各起一次，
 *     事件流完全一样（见文件头），只有环境变量分得出 —— 见上面的 VSCODE_ENV。
 *
 * **这里踩过的坑（2026-09-30 修）**：早先第一行是 `if (explicit) return explicit` ——
 * 而安装器写进 kilo.jsonc 的正是 `{client:"kilo"}`、`server()` 里还有个 `|| {client:"kilo"}`
 * 的兜底，于是**显式分支把下面整段环境判定全遮死**：VS Code 里跑出来的插件也报 `kilo`、
 * `form` 随之恒为 `cli`，任务列表里永远显示「Kilo Code CLI」（7F 的 plugin 形态从来没出现过）。
 * 安装器那条注释本来就是「`options.client` 钉住产品、形态由扩展自己判」的意图，
 * 是这里的判定顺序把那个意图杀死了。
 */
function resolveClient(options, base = "opencode") {
  const env = (typeof process !== "undefined" && process.env) || {}
  const explicit = String((options && options.client) || "").trim().toLowerCase()
  // 显式选项**只说产品**：`kilo` / `kilo-plugin` / `opencode` 都归一到基名，形态仍然由环境判。
  // 选项表达不了形态 —— 它写在配置里，而那**同一份配置 CLI 和编辑器扩展都会读**（Kilo 就是这样：
  // 扩展自带同一个二进制、读同一个 ~/.config/kilo/kilo.jsonc），所以选项里写死 `-plugin`
  // 在终端里就是错的，反之亦然。环境是唯一分得出"这一次是谁起的"的信号。
  const name = explicit ? explicit.replace(/-plugin$/i, "") : base
  const vscode = (VSCODE_ENV[name] || []).some(([k, v]) => env[k] === v)
  return vscode ? `${name}-plugin` : name
}

/* ------------------------------ 状态文件 ------------------------------ */

/** 状态文件根：与 server/src/sessions.js 的 reporterHookHome() 同一口径 */
function hooksDir() {
  const explicit = typeof process !== "undefined" && process.env && process.env.WORKGREMLIN_HOME
  const home = explicit || path.join(os.homedir(), ".workgremlin")
  return path.join(home, "hooks")
}

/**
 * 状态文件路径，与 hook.js 的 statePath() 同一套命名：
 * `<client>@<工程路径>@<会话 id>.json`，非法文件名字符全替换成 `_`。
 * 带上"工程 + 会话"两级归属是必须的：同一个工程里同一个产品开着多条会话时，
 * 少了这两级，A 会话的相位会被 B 覆盖（见 hook.js 里 statePath 的长注释）。
 */
function statePath(client, workspacePath, sessionId) {
  const parts = [String(client), String(workspacePath || "")]
  if (sessionId) parts.push(String(sessionId))
  const key = parts.join("@").replace(/[^a-zA-Z0-9._-]/g, "_")
  return path.join(hooksDir(), `${key}.json`)
}

function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    return data && typeof data === "object" ? data : {}
  } catch {
    return {}
  }
}

/** 合并式写（读出来打补丁再写回），与 hook.js 的 writeState 同一语义 */
function writeState(file, patch) {
  try {
    const next = { ...readState(file), ...patch }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(next)}\n`, "utf8")
  } catch {
    /* 写不进去就算了：上报是尽力而为，绝不能把 agent 带崩 */
  }
}

/* ------------------------------ 台账上报（HTTP） ------------------------------ */

/**
 * 除了相位，本插件还往 WorkGremlin 的**台账**上报：成员、任务、对话记录、文件活动。
 *
 * 之前只写状态文件，于是 7F/8F 在库里是"有相位、没有台账"：办公室没有这只小怪物
 * （`members` 里没有 client=kilo 的行）、任务列表与对话记录是空的。
 * 轮询那一路**补不了**这个洞 —— 它只读 SQLite，监控端伪造上报就违背"绝不编造"。
 * 只有本插件（跑在 agent 进程里、握着真相位事件流）能补。
 *
 * 全部按 hook.js 的同一套 ingest 路由打（`shared` 的 HTTP_ROUTES），字段形状也照它：
 *   register    成员注册（**必须带 role:'agent'** —— bus.endTask 只对 role=agent 的成员
 *               写 task_runs 台账，漏了这个字段任务会开了但台账里没有）
 *   heartbeat   保活（>60s 没有心跳服务端就标 degraded 灰显）
 *   task/start  用户提交新一轮 = 一个任务；标题取用户那句话
 *   task/end    一轮结束（succeeded→done / failed·interrupted→cancelled），带 result 与 files
 *   message     本轮的收尾自述进对话记录（type=result）
 *   file/touch  写类工具动过的文件（正在改什么）
 *
 * 三条纪律，与 hook.js 一致：
 *   1) 服务没起 / 拿不到上下文 / 上报失败 —— 一律静默，**绝不阻塞 agent**；
 *   2) 拿不到的数据就不上报（标题、result、文件都允许缺省），由服务端显示"未知"，不编造；
 *   3) 一律 fire-and-forget（不 await 事件处理），事件流绝不被 HTTP 拖住。
 */

/** 读 ~/.workgremlin/server.json（认 WORKGREMLIN_HOME，与 hook.js 的 readServerInfo 同口径） */
function readServerInfo() {
  const home = (process.env && process.env.WORKGREMLIN_HOME) || path.join(os.homedir(), ".workgremlin")
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"))
  } catch {
    return null
  }
}

/** 单次 HTTP 的超时；超了就当这次没报出去，不重试到把 agent 拖住 */
const HTTP_TIMEOUT_MS = 2_000

/** server.json 的重读间隔：读一次几百字节，5 秒足够跟上"应用刚起来 / 刚换了端口" */
const SERVER_INFO_TTL_MS = 5_000

/** 进程还活着吗？与 server/src/config.js 的 isPidAlive 同一口径（崩掉那次留下的 server.json 不能用） */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 建一个台账上报器。
 * @param {string} client 上报身份（kilo / kilo-plugin / opencode）—— 同时也是 memberId
 */
function createIngest(client) {
  /**
   * 连接信息**惰性重读**，不在建实例那一刻定死。
   *
   * **这里踩过的坑（2026-09-30 修）**：早先这里读一次就把 `base` 定成常量、`enabled()`
   * 恒为 `Boolean(base)` —— 而插件是**跟着 agent 的 server 进程活的**：Kilo 的 VS Code 扩展
   * 09:04 起 server，WorkGremlin 10:42 才起，那个实例的 `post()` / `resolveProject()`
   * 就一辈子直接 return（状态文件照写本地磁盘、台账一条不来，且**完全无声**）。
   * 实测症状：那条 VS Code 会话在任务列表里只有轮询推导的行、没有任何插件行。
   * 现在改成带 TTL 的重读：应用晚起 / 重启换了端口，下一个事件就能接上。
   *
   * 也补上了插件原先缺的存活判定（`isPidAlive`）：否则崩掉那次留下的 server.json
   * 会被一直当成有效连接，每次都往一个死端口撞。
   */
  let conn = null
  let connAt = 0
  function connect() {
    const now = Date.now()
    // 命中缓存：端口/令牌没变、且没过期 —— 高频事件（*.delta 虽然不写盘，但 part 更新很密）
    // 下不能每个事件都去读一次盘
    if (conn && now - connAt < SERVER_INFO_TTL_MS) return conn
    connAt = now
    const info = readServerInfo()
    if (!info || !info.port || !isPidAlive(info.pid)) {
      conn = null
      return null
    }
    conn = {
      base: `http://127.0.0.1:${info.port}`,
      token: info.token || "",
      headers: { "content-type": "application/json", ...(info.token ? { authorization: `Bearer ${info.token}` } : {}) },
    }
    return conn
  }

  /** WorkGremlin 没在跑 / 没装 → 这次上报不发，绝不撞一个已知不通的端口 */
  const enabled = () => Boolean(connect())

  /**
   * 记一条台账。**调用方一律不 await** —— 事件处理绝不因 HTTP 被拖住；
   * 但**把响应返回出去**，让"这一条到底发出去没有"变成可判的：`ensureRegistered`
   * 就是靠它决定"注册成功没有、要不要重试"（早先这里返回 undefined、错误全吞，
   * 于是注册悄悄失败也无人知晓，见那里踩的坑）。
   *
   * `project` 在这里**统一注入**，不交给各调用点：ingest 的 `projectFirst` 中间件
   * 要求 body 里有 project，缺了就直接 400（`missing project`）—— 而 400 是
   * **静默**的（上报 fire-and-forget，没人看响应），漏一处就表现为"这个产品的台账
   * 永远是空的"，极难定位。SDK 那边（packages/reporter/src/index.js 的 post）是
   * `{ project, ...body }` 统一加的，这里必须同一个口径。
   *
   * @returns {Promise<Response|null>} 没连上 / 发不出去 → null
   */
  function post(route, body) {
    const c = connect()
    if (!c) return Promise.resolve(null)
    try {
      return fetch(`${c.base}/api/v1${route}`, {
        method: "POST",
        headers: c.headers,
        body: JSON.stringify({ project: projectCache, ...body }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      }).catch(() => null)
    } catch {
      /* 发不出去就算了 */
      return Promise.resolve(null)
    }
  }

  /**
   * 上报归属的工程：跟随服务端"当前打开的工程"，与 hook.js 的 resolveCtx 同一口径。
   * 服务端不可达就留空 —— 留空时 post() 照样会带上空 project、被服务端 400 拒掉，
   * 宁可不上报也不写进别的工程。
   */
  let projectCache = ""
  let projectPromise = null
  function resolveProject() {
    const c = connect()
    if (!c) return Promise.resolve("")
    if (projectPromise) return projectPromise
    projectPromise = (async () => {
      try {
        const res = await fetch(`${c.base}/api/v1/workspace`, { headers: c.headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
        const j = res.ok ? await res.json() : null
        const p = String((j && j.project) || "")
        if (p) {
          projectCache = p
          return p
        }
        // 没拿到工程就别缓存 —— 下次调用重试，否则服务端晚起就永远拿不到工程、
        // register / task/start / task/end 全被 `if (!project) return` 静默跳过
        projectPromise = null
        return ""
      } catch {
        // 网络失败同样不缓存，下次重试
        projectPromise = null
        return ""
      }
    })()
    return projectPromise
  }

  return { post, resolveProject, enabled }
}

/* ------------------------------ 工具入参 ------------------------------ */

/** 工具入参里的可读命令（OpenCode 的 shell 工具入参是 command） */
function commandOf(input) {
  const s = input && typeof input === "object" ? input : {}
  const c = String(s.command || "")
  if (c) return c.replace(/\s+/g, " ").trim().slice(0, 120)
  const d = String(s.description || "")
  return d.replace(/\s+/g, " ").trim().slice(0, 120)
}

/** 工具入参里的目标文件（各家字段名不统一，都认一遍） */
function fileOf(input) {
  const s = input && typeof input === "object" ? input : {}
  const p = s.file || s.filePath || s.file_path || s.path || s.target_file || ""
  return typeof p === "string" ? p : ""
}

/**
 * 这个工具的**读/写**分类 —— 决定要不要上 file/touch（"正在读/改什么"）。
 *
 * 只认写类：写类工具会真的改文件，读类（read/grep/glob…）读了不留下任何"改动"痕迹，
 * 报上去只会让"正在修改"那一栏全是噪声。判不出就当**读**（不上报）—— 宁可少报，
 * 也不把"读了个文件"说成"改了文件"（那属于编造）。
 * 名单与 hook.js 的 PROBE_TOOLS / opOf 保持同一套口径（大小写不敏感）。
 */
function opOfTool(name) {
  const t = String(name || "").trim().toLowerCase()
  if (!t) return "read"
  if (/\b(delete|remove|rm|unlink|trash)\b/.test(t)) return "write"
  if (/\b(write|edit|patch|create|insert|update|replace|apply|rename|move|mkdir|save|apply_patch|multiedit|notebookedit)\b/.test(t)) {
    return "write"
  }
  return "read"
}

/** 剥掉外层 JSON 引号：实测 `part.text` 的值是 '"用 bash 执行 echo hi"'（自带一层引号） */
function unquote(text) {
  const s = String(text == null ? "" : text)
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s))
    } catch {
      return s.slice(1, -1)
    }
  }
  return s
}

/** 召唤 subagent 的工具名（Kilo / OpenCode 都叫 task；Codex 风格是 spawn_agent 后缀） */
function isSubagentTool(name) {
  const t = String(name || "").trim().toLowerCase()
  return t === "task" || t === "agent" || t.endsWith("spawn_agent")
}

/** subagent 工具入参里的名字与任务描述（各版本字段名不统一，都认一遍；取不到就兜底） */
function subagentOf(input) {
  const s = input && typeof input === "object" ? input : {}
  const name = s.subagent_type || s.subagent_name || s.task_name || s.agent || s.name || ""
  const task = s.description || s.prompt || s.message || ""
  return { name: String(name || "").trim() || "subagent", task: String(task).replace(/\s+/g, " ").trim().slice(0, 80) }
}

/* ------------------------------ 插件 ------------------------------ */

/**
 * 核心：把「一个上报实例」建起来，返回 `handle(event)` 与拆掉订阅的 `dispose()`。
 *
 * **两套产品、两套插件 API，但喂进来的是同一种事件**：
 *   · 8F OpenCode：`setup(ctx)` + `ctx.event.subscribe()` 拿事件流
 *   · 7F Kilo   ：`server(input)` 返回 `{ event }` 钩子，Kilo 每条事件调一次
 * 所以事件处理（相位 / 台账 / 幽灵）只写一份，两个入口各自接线。
 *
 * @param {any} options 配置里那条 plugin 条目的选项（目录注册的没有，是 undefined）
 * @param {{location?: any, base?: string}} ctx `base` = 产品基名，**由入口给**（见 resolveClient）
 */
function createIngestPlugin(options, { location, base } = {}) {
  const client = resolveClient(options, base)
  /**
   * 形态（落 task_runs.form，任务列表按它显示「… CLI」/「… Plugin」）。
   * 与 `client` 的 `-plugin` 后缀是同一件事，所以只在这里算一次 —— 原先开轮（task/start）
   * 与工具计数（tool/use）两处各写一遍 `client.endsWith("-plugin") ? …`，将来改一处必漏另一处。
   * 口径与 shared 的 isPluginClient 一致。
   */
  const form = /-plugin$/i.test(client) ? "plugin" : "cli"
  /** 会话 id → 工程路径（session.created 给的是权威值，事件信封的 location.directory 兜底） */
  const dirs = new Map()
  /** 工具调用 id → 工具名（`session.tool.called` 不带工具名，只有配对的 input.started 里有） */
  const toolNames = new Map()
  /** 会话 id → 上一轮 session.step.ended 的 files（完成标记要用） */
  const lastFiles = new Map()
  /** 会话 id → 会话标题 */
  const titles = new Map()
  /** 会话 id → 模型（session.created 带 data.model；台账要它，MODEL_SOURCES 里没有 kilo） */
  const models = new Map()
  /** messageID → role（user / assistant）。part 只带 messageID，角色要从 message.updated 取 */
  const msgRoles = new Map()
  /** messageID → 用户的原话（万一 text part 比 message.updated 先到，先挂这儿等角色确认） */
  const pendingUserText = new Map()
  /** 会话 id → 本轮 assistant 的最后一段文本（收尾自述；实测每次 part 更新带的是全文，不是增量） */
  const assistantText = new Map()
  /** 会话 id → 本轮的任务 id（台账；task/end 与 message 都要用） */
  const taskIds = new Map()
  /** 会话 id → 本轮动过的文件（台账 file/touch 累积，收尾时并进 task/end 的 files） */
  const roundFiles = new Map()
  /**
   * 会话 id → 最近一次"被打断收尾"的时刻。
   * 用户按 ESC / 停止时 Kilo / OpenCode 只发一条 `session.idle`（没有 `finish=stop`）——
   * 这一轮按**取消**收尾并落一枚 `done.cancelled`。但偶尔会有一条迟到的 assistant
   * `finish=stop` 消息跟在后面，别让它把红色「任务取消」盖成绿色「任务完成」（同 hook.js 的 justCancelled）。
   */
  const cancelledAt = new Map()
  /**
   * 已经计过一次「工具使用」的工具调用 id（Kilo / OpenCode 的 `part.callID`）。
   * 工具的 part 会反复更新（pending → running → completed），每一条都算一次的话次数会成倍虚高；
   * 同一个 callID 只记一次。攒到一定量整批清掉 —— 它只是"本进程见过的调用"，不需要长留。
   */
  let toolCallSeen = new Set()
  const ingest = createIngest(client)
  /** 本插件实例自己的工程（事件流是**全服务**的，不只这个工程 —— 见下面 wsOf 的注释） */
  const ownDir = String((location && location.directory) || "")

  /* ------------------------------ 成员注册 ------------------------------ */

  /** 这个 client 的成员建出来了没有（建出来就不再重复补） */
  let registered = false
  /** 在途的那次注册（事件很密，几十毫秒里能来一串 —— 别每来一条就发一次 register） */
  let registering = null

  /**
   * 确保"本身份的成员"已经在服务端建出来了，返回一个 Promise：
   * 建好了 → true；WorkGremlin 不可达 / 没拿到工程 / 服务端拒了 → false（**下次再试**）。
   *
   * ## 为什么必须有这个函数，以及为什么它要重试
   *
   * 服务端 bus 的**每一个**上报入口开头都是 `requireMember(...)`，查不到就把整条请求
   * 404 掉（`unknown_member`）—— 而插件这侧是 fire-and-forget，**404 完全无声**。
   * 也就是说：成员没建出来 ⇒ 这个进程上报的**每一条台账**都石沉大海，只剩本地状态文件。
   *
   * **这里踩过的坑（2026-09-30 修，实测）**：早先只在 `session.created` 那一支注册一次，
   * 而且 `registered = true` 是在**发出去之前**就置上的。两个后果都真实发生过：
   *
   *   1) **会话先于进程存在** —— Kilo 的 VS Code 扩展重开窗口会重启 `kilo serve`，而会话
   *      （`ses_f196…`）是更早那个进程建的：新进程从头到尾**等不到 session.created**，
   *      于是它一次注册都不发。实测症状：状态文件照写（相位 / 完成标记都对）、台账一条不来。
   *   2) **注册那一次正好撞上应用没起**（本就该跳过）时 `registered` 已置真 → 应用起来后
   *      也永远不再注册。
   *
   * 两种情形的表现是同一个：任务列表里那一轮显示的是**轮询兜底**写的那一行
   * （`kiloTasks.js` 写的 client=kilo / form=null），用户看到的就是「Kilo Code」而不是
   * 「Kilo Code Plugin」—— 2026-09-30 用户报的正是这个。
   *
   * 所以：注册**重试到成功为止**（失败就把在途标记清掉，下一条事件再试），
   * 且下面所有台账上报都先等它 —— 顺序也由此有了保证（否则 register 与 task/start
   * 并发发出去，谁先到服务端不一定，task/start 先到就是一条 404）。
   */
  function ensureRegistered() {
    if (registered) return Promise.resolve(true)
    if (!ingest.enabled()) return Promise.resolve(false)
    if (!registering) {
      registering = ingest
        .resolveProject()
        .then(async (project) => {
          // 没拿到工程（应用晚起 / 刚换了端口）→ 这次不发，下一条事件重试
          if (!project) {
            registering = null
            return false
          }
          const res = await ingest.post("/register", {
            memberId: client,
            name: client,
            client,
            role: "agent",
            workspacePath: ownDir,
            sessionId: "",
          })
          if (res && res.ok) {
            registered = true
            return true
          }
          registering = null
          return false
        })
        .catch(() => {
          registering = null
          return false
        })
    }
    return registering
  }

  /**
   * 台账上报的统一入口：**先确保成员已注册，再发**（理由见 ensureRegistered 的长注释）。
   * `/register` 自己走 `ingest.post` —— 从这里走就递归了。
   */
  const post = (route, body) => ensureRegistered().then((ok) => (ok ? ingest.post(route, body) : null))

  /** 取这条会话的工程路径；查不到就退回本实例的工程 */
  const wsOf = (event) => {
    // 信封两代并存：Kilo 7.8.1 是 properties，OpenCode 2.x 是 data。两边都认。
    const p = (event && (event.properties || event.data)) || {}
    const sid = String(p.sessionID || "")
    const known = sid ? dirs.get(sid) : ""
    const fromEvent = String(
      (event && event.location && event.location.directory) ||
        (p.info && p.info.directory) ||
        (p.info && p.info.path && p.info.path.cwd) ||
        "",
    )
    return known || fromEvent || ownDir
  }

  /**
   * 写一次相位 + 心跳。
   * `phaseFields` 里的键进 sessionPhase；`done` 单独进 done 字段（两者在 hook.js 里
   * 本来就是两个字段，不该把 done 塞进相位对象）。
   *
   * `hb.pid` = 本进程 pid：这是 `sessions.js` 的 `hasOtherLiveSession()` 判据 1
   * （"这份状态文件所属的会话还活着吗" 看 `pidAlive(j.hb.pid)`）。本插件跑在
   * Kilo / OpenCode 的 server 进程里 —— 那个进程死了就不会再有任何事件落到这份文件上，
   * 所以拿它当"活着"的判据是成立的。**早先这里只写 lastEventAt、没有 pid**，
   * 于是同工程开两条会话时，A 收工会把仍在跑的 B 一起降级，B 的卡片误显示空闲。
   */
  const report = (event, phase, { done = null, ...phaseFields } = {}) => {
    try {
      // 信封两代并存：Kilo 7.8.1 是 properties，OpenCode 2.x 是 data
      const sid = String((((event && (event.properties || event.data)) || {}).sessionID) || "")
      if (!sid) return
      const ws = wsOf(event)
      const now = Date.now()
      const patch = {
        client,
        sessionId: sid,
        hb: { pid: process.pid, lastEventAt: now },
        sessionPhase: { phase, ts: now, workspacePath: ws, ...phaseFields },
      }
      if (done) patch.done = done
      writeState(statePath(client, ws, sid), patch)
      // 心跳跟着相位一起发：>60s 没有心跳服务端就把这只成员标 degraded 灰显
      // 带上真实工程路径：服务端以它为准反查工程（见 bus.projectForReport）——
      // 不带的话会落到"办公室当前打开的工程"，开着 A、在 B 里干活时成员/心跳就挂错了工程。
      post("/heartbeat", { memberId: client, sessionId: sid, ts: now, workspacePath: ws })
    } catch {
      /* 上报失败不影响 agent */
    }
  }

  /* ---- 台账上报的三个小动作（都不 await，绝不拖住事件流） ---- */

  /**
   * 开一个任务。标题 = **用户那句话**，由调用方从 role=user 的 text part 里取到传进来
   * （实测 Kilo 的用户原话就在 `message.part.updated` 的 `part.type==='text'` 里，
   * 信封没有 prompt 字段，所以拿不到就退回会话标题 / 占位，不编）。
   * @param {any} event 触发的事件（取工程路径 / 形态用）
   * @param {string} sid 会话 id
   * @param {string} prompt 用户那句话（可能为空）
   */
  function startTask(event, sid, prompt = "") {
    const said = String(prompt || "").replace(/\s+/g, " ").trim()
    const title = (said || titles.get(sid) || "").slice(0, 80) || "(未命名任务)"
    const taskId = `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    taskIds.set(sid, taskId)
    roundFiles.set(sid, new Set())
    // 新一轮开始：上一次的"被打断"标记作废（迟到的旧 done 不该再压住这一轮的完成）
    cancelledAt.delete(sid)
    // **新一轮开始时把上一轮的「任务完成」标记抹掉。**
    // 状态文件是合并写（readState → 打补丁 → 写回），不显式清的话旧 done 会一直挂着 ——
    // 新任务已经在跑了，控制台却还亮着上一轮的「任务完成」。done 置 null 而不是删键：
    // 合并写只认键值，null 就够服务端 readReporterDone 判成"没有"（见 sessions.js）。
    //
    // 同一个补丁里带上 **taskTitle = 用户那句话**：服务端 readReporterPhase 把它读成
    // `prompt`，「思考中」时主控制台第二/第三层显示的就是它（见 sessions.js 的
    // winPrompt 与 renderer/src/views/IsoOfficeView.vue 的 thinking 分支）。
    // 早先这里只抹 done、不写 taskTitle，于是 7F/8F 的「思考中」屏上**一个字都没有** ——
    // 别的楼层（hook 那一路，hook.js 的 TASK_START 分支）都写 taskTitle，所以只有 7F/8F 空着。
    //
    // 只写 `said`（用户原话，截到与 hook 同一口径的 80 字），**不写会话标题**：
    // 会话标题默认是 "New session - <时间戳>" 这种没信息量的值，拿它当"用户问了什么"是编造。
    // 拿不到原话就写空串（而不是留着上一轮的旧 prompt）—— 空屏好过显示上一轮的内容。
    try {
      writeState(statePath(client, wsOf(event), sid), { done: null, taskTitle: said.slice(0, 80) })
    } catch {
      /* 抹不掉就算了：readReporterDone 有 TTL，最多多显示一会儿 */
    }
    // 形态标记（form）在 createIngestPlugin 里算一次，这里直接用。
    // 工程由 post() 里的 ensureRegistered 保证已解析（拿不到就整条不发 —— 见那里的注释）。
    post("/task/start", {
      memberId: client,
      taskId,
      title,
      sessionId: sid,
      client,
      form,
      // 模型从 session.created 记下来了（models map）。**必须自己带**：bus.endTask 的
      // 兜底 refill 走 sessionModel() 的 MODEL_SOURCES 表，那里只挂了 trae / claude，
      // 没有 kilo → 轮询/适配器都取不到，task_runs.model 会留 null（任务列表少一列）。
      ...(models.get(sid) ? { model: models.get(sid) } : {}),
      workspacePath: wsOf(event),
    })
    return taskId
  }

  /**
   * 写类工具动过的文件 → 台账 file/touch（"正在改什么"）。
   * **只在写类时调用**：读类工具不报（读了不留改动痕迹，报上去只是噪声）。
   */
  function touchFile(sid, file, ws = "") {
    if (!file) return
    const set = roundFiles.get(sid)
    if (set) set.add(file)
    post("/file/touch", { memberId: client, files: [file], op: "write", sessionId: sid, client, workspacePath: ws })
  }

  /**
   * 一轮收尾：task/end（带 result 与本轮改动文件）+ 收工自述进对话记录。
   * @param {"done"|"failed"|"cancelled"} state
   */
  function endTask(event, sid, state, result) {
    const taskId = taskIds.get(sid)
    if (!taskId) return
    taskIds.delete(sid)
    const touched = [...(roundFiles.get(sid) || new Set())]
    roundFiles.delete(sid)
    const stepped = (sid ? lastFiles.get(sid) || [] : []).map(String)
    // **同一个文件会被记两遍**：`session.step.ended` 给的是工作区相对路径（a.ts），
    // file/touch 记的是工具入参原样（可能是绝对路径 /tmp/…/a.ts）。直接并起来，
    // file_count 与 files 列表里同一个文件会出现两次（实测 file_count=2，其实只改了一个）。
    // 所以先按工作区统一解析成相对路径再去重 —— 台账上的"本轮改了几个文件"必须是真的。
    const ws = wsOf(event)
    const rel = (f) => {
      const s = String(f || "")
      if (!s) return ""
      try {
        return path.relative(ws, path.resolve(ws, s)) || s
      } catch {
        return s
      }
    }
    const all = [...new Set([...stepped, ...touched].map(rel).filter(Boolean))]
    // 形态标记（form）在 createIngestPlugin 里算一次，这里直接用
    post("/task/end", {
      memberId: client,
      taskId,
      state,
      result: String(result || "").slice(0, 4_000) || undefined,
      files: all,
      sessionId: sid,
      client,
      form,
      ...(models.get(sid) ? { model: models.get(sid) } : {}),
      workspacePath: ws,
    })
    // 本轮的收尾自述也进对话记录（type=result）；没有自述就不写 —— 不拿文件清单凑数
    const said = String(result || "").trim()
    if (said) {
      post("/message", {
        memberId: client,
        from: client,
        to: null,
        type: "result",
        subject: null,
        content: said.slice(0, 8_000),
        taskId,
        sessionId: sid,
        client,
        workspacePath: ws,
        ts: Date.now(),
      })
    }
  }

  // 这里**不订阅**：事件从哪来由入口决定（OpenCode 走 subscribe 流、Kilo 走 server 的
  // event 钩子），工厂只负责"拿到一条事件怎么处理"。
  /**
   * 处理一条事件。
   *
   * ## 事件契约（**实测** 2026-09-27，Kilo 7.8.1，探针跑出来的真实词汇表）
   *
   * 信封是 `{ id, type, properties }` —— **不是** `{ type, data, location }`。
   * 早先这里按 `data` / `location` 和一串 `session.inbox.enqueued` / `session.tool.called` /
   * `session.execution.succeeded` / `permission.asked` / `session.step.ended` 来写，
   * 那些**实测一个都不出现**（`kilo run` 跑两轮，真实事件只有下面这 10 个）。
   * 工程路径因此也拿不到 `location.directory`，只能从 `session.created` 的 `info.directory`
   * （或 `message.updated` 的 `info.path.cwd`）取 —— 那才是权威值。
   *
   *   session.created        info.directory=工程路径 · info.model.id=模型
   *   session.updated        info.title（会话改名）
   *   message.updated        info.role / info.finish / info.time.completed / info.path.cwd
   *   message.part.updated   part{type:text|tool|reasoning|step-start|step-finish|patch,
   *                           text, tool, callID, state{status,input}, messageID}
   *   message.part.delta     token 级增量 —— 忽略（每 token 一条，写盘会聊崩）
   *   session.status         status.type = busy | idle
   *   session.idle           这一轮彻底结束
   *   session.drained        队列排空（收尾信号）
   *   session.diff           diff[] = 本轮改动的文件
   *   session.next.tool.input.delta  工具入参增量 —— 忽略（part 更新里已有完整 input）
   *
   * ## 由此推出的几条判定
   *
   * · **任务开始 = 一条 role=user 的 text part**。用户那句话就在
   *   `part.type==='text'` 的 `part.text` 里（实测值带一层 JSON 引号，要剥掉）。
   *   `message.updated` 给出该 messageID 的 role；万一 part 先到（顺序不该变，但不想赌），
   *   先把 text 挂到 messageID 上，等 role=user 的 message.updated 到了再开任务。
   * · **任务结束 = 一条 role=assistant 且 `finish` + `time.completed` 的 message.updated**。
   *   `finish==='stop'` 才是"说完收工"（= 台账的 done，也是「任务完成」）；
   *   `finish==='tool-calls'` 只是**这条消息**到工具调用处断了，**整轮还没完**，不能收。
   *   （与 kilo.js 从 SQLite 读 `message.finish` 的口径一致，见那里的注释）
   * · **收尾自述 = 本轮 assistant 的 text part**（按 messageID 归属，取最后一条完整的）。
   * · **等待授权 = tool part 的 `state.status==='pending'`**。Kilo 的 tool 状态实测有
   *   pending / running / completed / error —— pending 就是还没放行。
   *   SQLite 落盘里同样有这个 pending（轮询那一路据此推「等待授权」），插件这一路是**真值**。
   */
  function handle(event) {
    const type = String((event && event.type) || "")
    // 信封两代并存：Kilo 7.8.1 是 properties，OpenCode 2.x 是 data。两种都认。
    const p = (event && (event.properties || event.data)) || {}
    const sid = String(p.sessionID || "")
    // 工程路径：事件信封没有 location（Kilo 侧），回落 ownDir
    const dirOf = () => String((p.info && p.info.directory) || (p.info && p.info.path && p.info.path.cwd) || "")

    // 成员注册：**每一条事件都顺手确保一次**，而不是等 `session.created` 那一支。
    // 一定要这么做：Kilo 的 VS Code 扩展重开窗口会重启 kilo serve，而会话是**早就存在**的
    // —— 新进程等不到 session.created，只在那一支注册的话它一次都不发（见 ensureRegistered）。
    // 已注册时这只是一次布尔判断，高频的 `*.delta` 也扛得住。
    void ensureRegistered()

    switch (type) {
      /* ---- 会话创建：工程路径与模型的权威来源 ---- */
      case "session.created": {
        const info = p.info || {}
        const ws = dirOf() || ownDir
        if (sid) dirs.set(sid, ws)
        const model = String((info.model && (info.model.id || info.model.modelID)) || info.modelID || "")
        if (sid && model) {
          models.set(sid, model)
          // 主控制台要显示模型；轮询那一路本来也能从库里取到，装了插件就用真值
          writeState(statePath(client, ws, sid), { model })
        }
        break
      }

      /* ---- 会话改名 = 标题（任务收尾时没有标题可退，就用会话标题） ---- */
      case "session.updated":
      case "session.renamed": {
        const info = p.info || {}
        if (sid && info.title) titles.set(sid, String(info.title))
        // 模型**常常在 session.created 时还没有**（实测：created 的 info 里没 model，
        // 是紧接着的 session.updated 才带上 model.id）—— 所以两处都要认，
        // 少一处就表现为「主控制台不显示模型」。早先只读 created，主控制台一直空着。
        const model = String((info.model && (info.model.id || info.model.modelID)) || info.modelID || "")
        if (sid && model) {
          models.set(sid, model)
          writeState(statePath(client, dirOf() || wsOf(event), sid), { model })
        }
        break
      }

      /* ---- 消息：role / finish / time.completed 是任务台账的三个判据 ---- */
      case "message.updated": {
        const info = p.info || {}
        const mid = String(info.id || "")
        const role = String(info.role || "")
        if (mid) msgRoles.set(mid, role)
        // user 消息：若它的 text part 先到了，这里补开任务（正常顺序是 part 后到，这里兜底）
        if (role === "user" && sid && !taskIds.has(sid)) {
          const early = pendingUserText.get(mid)
          if (early) {
            pendingUserText.delete(mid)
            startTask(event, sid, early)
          }
        }
        // assistant 消息收尾：finish + completed 才是"这条消息结束了"
        if (role === "assistant" && info.finish && info.time && info.time.completed) {
          // finish=tool-calls 只是"到工具调用处断了"，整轮还没完 —— 不能收工
          if (info.finish === "tool-calls") break
          /* 刚被 session.idle 判成"打断"的那一轮不许再用一枚"完成"盖回来：
             ① 取消标记是刚才落的（60s 内）；② 这一轮已经没有任务在跑（taskId 已被 endTask 清掉）。
             打断后又发了新任务时 taskId 是新那一轮的，startTask 也会清掉 cancelledAt，照常落完成。 */
          if (sid && cancelledAt.has(sid) && !taskIds.has(sid) && Date.now() - Number(cancelledAt.get(sid) || 0) < 60_000) {
            assistantText.delete(sid)
            break
          }
          const result = String(assistantText.get(sid) || "")
          assistantText.delete(sid)
          const ws = wsOf(event)
          const files = (sid ? lastFiles.get(sid) || [] : []).map(String)
          endTask(event, sid, "done", result || titles.get(sid) || "")
          // 收工扫场：带 result 的"待汇报"保留给服务端的汇报动画
          ghostFeed.sweepGhosts(ws, client, { all: false }, sid)
          report(event, "done", {
            action: "",
            done: {
              at: Number(info.time.completed) || Date.now(),
              // 标题优先用**这一轮自己的收尾自述**（agent 真正说的话），
              // 拿不到才退会话标题 —— 会话标题是 "New session - <时间戳>" 这种没信息量的默认值
              title: result || titles.get(sid) || "",
              fileCount: files.length,
              files: files.slice(0, 20).map((f) => ({ path: f, size: null })),
              workspacePath: ws,
              sessionId: sid,
              cancelled: false,
            },
          })
        }
        break
      }

      /* ---- 部件：相位与「本轮改了什么」的来源 ---- */
      case "message.part.updated": {
        const part = p.part || {}
        const mid = String(part.messageID || "")
        const role = msgRoles.get(mid) || String(part.role || "")
        const kind = String(part.type || "")

        if (kind === "text") {
          // 实测 part.text 带一层 JSON 引号（'"用 bash 执行 echo hi"'"），剥掉再用
          const text = unquote(part.text)
          if (role === "user") {
            // 用户那句话 = 任务标题。没装插件时这条路径不存在，任务台账也就没有 Kilo 的记录
            if (sid && !taskIds.has(sid)) startTask(event, sid, text)
            else if (mid) pendingUserText.set(mid, text)
            report(event, "thinking")
          } else {
            // assistant 的文本是这一轮的收尾自述；实测每次 part 更新带的是**当前全文**，不是增量
            if (sid) assistantText.set(sid, text)
            // **这里原来报的是 idle（待命），是错的** —— 改过，实测踩的坑：
            // Kilo 在**一轮之内**会多次吐 assistant 文字（每次工具调用前后都可能来一段）。
            // 一律报 idle 的话，模型在两次工具调用之间说话时主 agent 就闪回「待命中」，
            // 几秒后又被下一条 tool 事件顶回「调用工具」—— 用户看到的是相位在两个值之间来回跳，
            // 而任务明明还在跑。其它楼层（hook 那一路）在这段间隙是**回落到思考中**的
            // （见 hook.js 的 PostToolUse：工具跑完 → 写 sessionPhase thinking），
            // 7F/8F 跟同一口径。
            //
            // 真正"这一轮结束了"有独立的判据，不靠这条：message.updated 带
            // finish + time.completed（且不是 tool-calls）→ 报 done（上面那个分支）；
            // session.idle / session.status=idle → 报 idle。所以这里报 thinking 不会让
            // 相位卡在"思考中"收不了尾。
            report(event, "thinking")
          }
          break
        }

        if (kind === "tool") {
          const status = String((part.state && part.state.status) || "")
          const input = (part.state && part.state.input) || {}
          const target = fileOf(input)
          /* 工具使用计数（任务详情「工具使用」）：同一个 callID 只记一次
             （part 会反复更新 pending/running/completed，逐条记就成倍虚高）。
             pending 不算"用过"（还没放行），其余状态都算"调过它了"。 */
          const callId = String(part.callID || part.id || "")
          if (sid && callId && status && status !== "pending" && !toolCallSeen.has(callId)) {
            toolCallSeen.add(callId)
            // 只当"本进程见过的调用"用，攒太多就丢掉重来（同一支工具的下一次调用照样会记）
            if (toolCallSeen.size > 500) toolCallSeen = new Set([callId])
            const toolName = String(part.tool || "")
            const taskId = taskIds.get(sid) || ""
            if (toolName && taskId) {
              post("/tool/use", {
                memberId: client,
                taskId,
                tool: toolName,
                sessionId: sid,
                client,
                workspacePath: wsOf(event),
                form,
              })
            }
          }
          // 台账：只报**写类**工具（读类不报 —— 读了不留改动痕迹，报上去只是噪声）
          if (sid && opOfTool(part.tool) === "write" && status !== "pending") touchFile(sid, target, wsOf(event))
          // 召唤 subagent（task 工具）时飘一只小幽灵
          if (sid && isSubagentTool(part.tool) && status !== "pending") {
            const sa = subagentOf(input)
            ghostFeed.addGhost(wsOf(event), sa.name, sa.task, String(part.callID || ""), taskIds.get(sid) || "", "", client, sid)
          }
          if (status === "pending") {
            // Kilo 的 tool 状态实测有 pending —— 这就是「等待授权」，
            // 也是轮询那一路补不上的那一相位（那边落盘里同样能推，但插件是上报真值）
            report(event, "await", {
              tool: part.tool || "",
              target,
              action: part.tool ? `申请执行 ${part.tool}` : "等待用户授权",
            })
          } else if (status === "running") {
            report(event, "tool", { tool: part.tool || "", cmd: commandOf(input), file: target })
          } else if (status === "error") {
            report(event, "tool", { tool: part.tool || "", cmd: commandOf(input), file: target, action: `调用 ${part.tool || "工具"} 报错` })
          }
          // completed：不回退相位（那一支跑完了，下一条 part 会再推进）
          break
        }

        if (kind === "reasoning") {
          report(event, "thinking")
          break
        }
        if (kind === "patch") {
          const f = String(part.file || part.path || "")
          report(event, "tool", { action: f ? `改 ${f}` : "落盘改动", target: f, file: f, tool: "patch" })
          break
        }
        // step-start / step-finish **不是相位**：实测一个会话里各 300+ 次，是「一步」的边界记账。
        // 套成「规划中 / 汇总中」会让控制台在每次工具跑完后一直卡在「汇总中」（见 kilo.js 同名注释）
        break
      }

      /* ---- 本轮改动的文件：实测是 diff 数组 ---- */
      case "session.diff": {
        const arr = Array.isArray(p.diff) ? p.diff : []
        if (sid && arr.length) {
          lastFiles.set(sid, arr.map((d) => (typeof d === "string" ? d : String((d && (d.file || d.path)) || ""))).filter(Boolean))
        }
        break
      }

      /* ---- 忙碌 / 空闲 ---- */
      case "session.status": {
        const st = String((p.status && p.status.type) || "")
        if (st === "idle") report(event, "idle")
        break
      }
      case "session.idle": {
        /* 兜底：真收到"这一轮结束了"却没有 finish=stop 的 assistant 消息
           （比如用户按 ESC / 停止打断）—— 这一轮按**取消**收尾，不亮「任务完成」。
           Kilo / OpenCode 打断时不发 finish=stop，只发这一条 session.idle ——
           以前这里只把台账收成 cancelled，**没有往状态文件落取消标记**，于是主控制台
           拿不到任何"这是被打断"的证据，红色「任务取消」永远不亮（只能干等回待命）。
           现在补一枚 done（与 hook.js 的 Interrupt 同形，多一个 cancelled:true）：
             ① 台账 task/end(state=cancelled)（endTask 里）；
             ② 状态文件 done.cancelled=true → /reporter-phase 与 /sessions 透传 →
                主控制台照「任务取消」亮红色，「改动文件」或「没有输出」照常。 */
        if (sid && taskIds.has(sid)) {
          // 统计本轮动过的文件：lastFiles（session.step.ended / session.diff 给的）∪ roundFiles（写类工具给）
          const files = [...new Set([...(lastFiles.get(sid) || []), ...((roundFiles.get(sid)) || [])].map(String).filter(Boolean))]
          // 这一轮已经吐出来的文字也照常收（与 message.updated 那条 done 同口径）：
          // 取消只是"没干完"，不是"没产出"——台账的产出摘要 / 对话记录照记。
          const result = String(assistantText.get(sid) || "")
          const ws = wsOf(event)
          cancelledAt.set(sid, Date.now())
          endTask(event, sid, "cancelled", result)
          assistantText.delete(sid)
          ghostFeed.sweepGhosts(ws, client, { all: true }, sid)
          report(event, "idle", {
            done: {
              at: Date.now(),
              title: result || titles.get(sid) || "",
              fileCount: files.length,
              files: files.slice(0, 20).map((f) => ({ path: f, size: null })),
              workspacePath: ws,
              sessionId: sid,
              // 这一轮已经吐出来的话照常记（有就记、没有就空 —— 与「任务完成」一致）
              said: result.replace(/\s+/g, " ").trim().slice(0, 160),
              cancelled: true,
            },
          })
          // 清掉状态文件里的 taskId：否则服务端兜底合成取消标记会在 ≥TASK_RUN_MS 后
          // 再补一发 task/end(cancelled)（重复），也避免任务槽一直占着、相位卡在「调用工具」。
          // 与 hook.js 的 Interrupt 同口径（它也把 taskId 清成 null）。
          try { writeState(statePath(client, ws, sid), { taskId: null, taskWorkspacePath: '', taskStartedAt: 0 }) } catch {}
          break
        }
        report(event, "idle")
        break
      }

      default:
        // 其余事件（含 *.delta 高频流）一律不写盘：相位在对应的 part/status 上已经设好了，
        // 按 token 写状态文件会把磁盘和渲染层一起聊崩。
        break
    }
  }

  return { handle, dispose: () => {} }
}

/**
 * 模块默认导出 —— **Kilo 与 OpenCode 两套入口，喂的是同一种事件**。
 *
 * 两边的插件 API 完全不同（实测 2026-09-27，Kilo 7.8.1）：
 *   · 8F OpenCode：`setup(ctx)` 返回一个拆函数；事件靠 `ctx.event.subscribe()` 拿流
 *   · 7F Kilo   ：**`server(input, options)`** 返回 `Hooks` 对象，Kilo 每条事件调
 *                 `hooks.event({ event })`。而且 Kilo 会校验：
 *                 「Plugin must default export an object with server()」——
 *                 只给 setup() 的话 **Kilo 直接拒绝加载**（日志里一条 ERROR，
 *                 表现为插件看着装上了、但状态文件与台账一条都不来）。
 *                 另外 `file://` 的本地路径插件**必须导出 `id`**。
 *   两边**不能同时**导出 `server` 与 `tui`（Kilo 会抛 "either server() or tui(), not both"）；
 *   `setup` 与 `server` 并存不冲突（校验只看后两个）。
 *
 * 为什么 7F 值得单独写一个入口：Kilo 那一路是 CLI 任务台账的**唯一**来源
 * （服务端轮询是只读的，监控端不能伪造上报），入口不对就等于这条记录永远出不来。
 */
export default {
  id: "workgremlin",

  /** 8F OpenCode —— 走这个入口就说明是 OpenCode，产品基名不用猜 */
  async setup(ctx) {
    const inst = createIngestPlugin(ctx && ctx.options, { location: ctx && ctx.location, base: "opencode" })
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          inst.handle(event)
        }
      } catch {
        /* 订阅断了就断了：退回轮询推导 */
      }
    })()
    return () => {
      controller.abort()
      inst.dispose()
    }
  },

  /** 7F Kilo —— 契约见 packages/plugin/src/index.ts 的 `PluginModule` */
  async server(input, options) {
    // `base: "kilo"`：走 server() 这个入口就是 Kilo（setup() 才是 OpenCode），产品基名不用猜。
    // 早先这里是 `options || { client: "kilo" }` —— 目录注册那份没有 options，于是被喂了一个
    // 假默认 `{client:"kilo"}`，把 resolveClient 里的环境判定（形态 CLI / Plugin）整段遮死。
    const inst = createIngestPlugin(options || {}, {
      location: { directory: String((input && input.directory) || (input && input.worktree) || "") },
      base: "kilo",
    })
    return {
      /** Kilo 的每一条事件都从这里过一遍（含 `*.delta`，靠 handle 里的 switch 只认需要的那些） */
      async event({ event } = {}) {
        if (event) inst.handle(event)
      },
    }
  },
}
