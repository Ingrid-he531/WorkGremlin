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
 * ## 事件契约（实测 2026-09-26，OpenCode 2.0.18；Kilo Code 7.8.1 是同源 fork、事件名相同）
 *
 * 事件信封：`{ id, created, type, location: { directory }, durable?, data }`
 * `data.sessionID` 是会话 id；`location.directory` / `session.created` 的 `data.location.directory`
 * 是该会话的工程路径。
 *
 * 只认下面这些事件（实测存在的），**其余一律忽略** —— 尤其 `*.delta` 系列（每个 token 一条，
 * 写盘会聊得离谱；相位在对应的 `.started` 上已经设好了）：
 *
 *   session.created              data.location.directory = 工程路径；data.model
 *   session.renamed              data.title
 *   session.inbox.enqueued       用户提交了新一轮            → thinking
 *   session.execution.started    开始执行                    → thinking
 *   session.text.started         开始吐字                    → thinking
 *   session.reasoning.started    开始推理                    → thinking
 *   session.tool.input.started   data.name = 工具名、data.id = 本次调用 id（**工具名只在这里**）
 *   session.tool.called          data.input = 工具入参       → tool
 *   permission.asked             data.action/resources       → await（等授权）
 *   permission.replied           data.reply                  → 清回 thinking
 *   session.step.ended           data.files/cost/tokens     → 记下来给完成标记用
 *   session.execution.succeeded  一轮结束                    → done + 完成标记
 *   session.execution.failed     data.reason                → 收尾（不亮"任务完成"）
 *   session.execution.interrupted data.reason               → 同上
 *
 * ## 它写什么
 *
 * 状态文件格式与 `packages/reporter/src/hook.js` **完全一致**（路径 `~/.workgremlin/hooks/`
 * 下 `<client>@<工程>@<会话>.json`，非法文件名字符替换成 `_`），所以服务端
 * `listReporterSessions` / `readReporterPhase` / `readReporterDone` 一行都不用改就能认。
 * 认 `WORKGREMLIN_HOME` 环境变量，与服务端 reporterHookHome() 同口径。
 *
 * ## 装法
 *
 * 零配置（推荐，作用域=本工程）：把本文件放进工程的 `.opencode/plugins/` 即自动加载。
 * 全机：在 `~/.config/opencode/opencode.json` 的 `plugins` 数组里加一条指向本文件的路径。
 * Kilo 同理（`.kilo/plugins/` 或 `~/.config/kilo/kilo.jsonc`），并用
 * `plugins: [{ package: <路径>, options: { client: 'kilo' } }]` 指定上报身份。
 *
 * 上报身份判定顺序：`options.client` → 环境变量（`KILO_CLIENT` / `KILOCODE_FEATURE` → kilo；
 * `OPENCODE_CLIENT` → opencode）→ 兜底 `opencode`。
 */

/* Node 内置模块，插件运行环境自带的，不需要额外依赖。 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/* ------------------------------ 上报身份 ------------------------------ */

/** 这个插件实例替哪个产品上报（= products.js 里的 client / agent 基名） */
function resolveClient(options) {
  const explicit = String((options && options.client) || "").trim().toLowerCase()
  if (explicit) return explicit
  const env = typeof process !== "undefined" && process.env ? process.env : {}
  // Kilo Code 是 OpenCode 的 fork，它自己那套环境变量最好认（实测扩展起 server 时带
  // KILO_CLIENT=vscode / KILOCODE_FEATURE=vscode-extension）
  if (env.KILO_CLIENT || env.KILOCODE_FEATURE || env.KILO_APP_NAME) return "kilo"
  if (env.OPENCODE_CLIENT || env.OPENCODE) return "opencode"
  return "opencode"
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

/* ------------------------------ 插件 ------------------------------ */

export default {
  id: "workgremlin",

  async setup(ctx) {
    const client = resolveClient(ctx && ctx.options)
    /** 会话 id → 工程路径（session.created 给的是权威值，事件信封的 location.directory 兜底） */
    const dirs = new Map()
    /** 工具调用 id → 工具名（`session.tool.called` 不带工具名，只有配对的 input.started 里有） */
    const toolNames = new Map()
    /** 会话 id → 上一轮 session.step.ended 的 files（完成标记要用） */
    const lastFiles = new Map()
    /** 会话 id → 会话标题 */
    const titles = new Map()
    /** 本插件实例自己的工程（事件流是**全服务**的，不只这个工程 —— 见下面 wsOf 的注释） */
    const ownDir = String((ctx && ctx.location && ctx.location.directory) || "")

    /** 取这条会话的工程路径；查不到就退回本实例的工程 */
    const wsOf = (event) => {
      const sid = String((event && event.data && event.data.sessionID) || "")
      const known = sid ? dirs.get(sid) : ""
      const fromEvent = String((event && event.location && event.location.directory) || "")
      return known || fromEvent || ownDir
    }

    /**
     * 写一次相位 + 心跳。
     * `phaseFields` 里的键进 sessionPhase；`done` 单独进 done 字段（两者在 hook.js 里
     * 本来就是两个字段，不该把 done 塞进相位对象）。
     */
    const report = (event, phase, { done = null, ...phaseFields } = {}) => {
      try {
        const sid = String((event && event.data && event.data.sessionID) || "")
        if (!sid) return
        const ws = wsOf(event)
        const now = Date.now()
        const patch = {
          client,
          sessionId: sid,
          hb: { lastEventAt: now },
          sessionPhase: { phase, ts: now, workspacePath: ws, ...phaseFields },
        }
        if (done) patch.done = done
        writeState(statePath(client, ws, sid), patch)
      } catch {
        /* 上报失败不影响 agent */
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          handle(event)
        }
      } catch {
        /* 订阅断了就断了：8F 会自动退回轮询推导 */
      }
    })()

    function handle(event) {
      const type = String((event && event.type) || "")
      const data = (event && event.data) || {}

      switch (type) {
        /* ---- 记住会话的工程路径 / 标题：这是把相位归到正确工程的唯一依据 ---- */
        case "session.created": {
          const sid = String(data.sessionID || "")
          const ws = String((data.location && data.location.directory) || ownDir)
          if (sid) dirs.set(sid, ws)
          break
        }
        case "session.renamed": {
          const sid = String(data.sessionID || "")
          if (sid && data.title) titles.set(sid, String(data.title))
          break
        }

        /* ---- 用户提交新一轮 / 开始执行 / 开始输出：思考中 ---- */
        case "session.inbox.enqueued":
        case "session.execution.started":
        case "session.text.started":
        case "session.reasoning.started":
          report(event, "thinking")
          break

        /* ---- 工具名只在这里出现：按调用 id 记下来，等 tool.called 来取 ---- */
        case "session.tool.input.started": {
          if (data.id && data.name) toolNames.set(String(data.id), String(data.name))
          break
        }

        /* ---- 工具真的被调起来了：调用工具（带工具名与实际命令/文件） ---- */
        case "session.tool.called": {
          const name = toolNames.get(String(data.id || "")) || ""
          report(event, "tool", {
            tool: name,
            cmd: commandOf(data.input),
            file: fileOf(data.input),
          })
          break
        }

        /* ---- 「等待授权」：轮询那一路永远给不出的相位，只有这里有 ---- */
        case "permission.asked": {
          const target = Array.isArray(data.resources) ? String(data.resources[0] || "") : ""
          report(event, "await", {
            tool: toolNames.get(String((data.source && data.source.id) || "")) || "",
            target,
            action: `申请执行 ${String(data.action || "操作")}`,
          })
          break
        }
        case "permission.replied": {
          // 授权有结果了：回到思考中（下一条 tool.called 会再把它推到"调用工具"）
          report(event, "thinking")
          break
        }

        /* ---- 记下本轮改动的文件与花费，完成标记要用 ---- */
        case "session.step.ended": {
          const sid = String(data.sessionID || "")
          if (sid && Array.isArray(data.files)) lastFiles.set(sid, data.files.map(String))
          break
        }

        /* ---- 一轮结束：任务完成 + 完成标记（带改动文件清单，轮询给不出这一项） ---- */
        case "session.execution.succeeded": {
          const sid = String(data.sessionID || "")
          const ws = wsOf(event)
          const files = (sid ? lastFiles.get(sid) || [] : []).map((f) => {
            // 顺手 stat 出当前体积（字节）：主控制台好显示文件大小。
            // 路径按 workspace 解析（绝对路径直接用之），解析不出 / 已删除就留 null。
            let size = null
            try {
              const st0 = fs.statSync(path.resolve(ws, f))
              if (st0.isFile()) size = st0.size
            } catch {
              /* 文件不存在 / 非文件：大小留 null */
            }
            return { path: f, size }
          })
          report(event, "done", {
            action: "",
            done: {
              at: Date.now(),
              title: (sid && titles.get(sid)) || "",
              fileCount: files.length,
              files: files.slice(0, 20),
              workspacePath: ws,
              sessionId: sid,
            },
          })
          break
        }

        /* ---- 失败 / 被中断：这一轮确实结束了，但**不是**"任务完成" ----
         * 相位词汇表里没有"失败"这一项（idle/unreported/plan/thinking/tool/dispatch/
         * summarize/done/await/waiting），所以落到 idle（待命）并把原因写进行 为 那一行，
         * 让控制台照实显示"执行失败：xxx"，而不是亮起一个假的「任务完成」。 */
        case "session.execution.failed":
        case "session.execution.interrupted": {
          const reason = String(data.reason || data.error || "未知原因")
          report(event, "idle", { action: `执行${type.endsWith("interrupted") ? "被中断" : "失败"}：${reason}` })
          break
        }

        default:
          // 其余事件（含 *.delta 高频流）一律不写盘：相位在 .started 上已经设好了，
          // 按 token 写状态文件会把磁盘和渲染层一起聊崩。
          break
      }
    }

    return () => controller.abort()
  },
}
