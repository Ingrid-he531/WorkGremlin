# WorkGremlin 实现现状（文档对齐记录）

| 项 | 内容 |
| --- | --- |
| 生成日期 | 2026-09-20 |
| 对照基准 | 工作区 `HEAD = 27022c9` + 当日未提交改动（见 §9） |
| 用途 | 记录**代码实际怎么做的**，以及它与 `requirements*.md` / `tech-design.md` / `roadmap.md` / `test-strategy.md` / `runbook.md` 的差异 |
| 维护约定 | 改代码导致领域模型 / 数据源 / 接口变化时，同步更新本文；需求变更更新 `requirements.md`。**本文只描述已实现的事实，不表达需求倾向，也不代替规格。** |

> 规格以 `docs/requirements.md` 为准。本文负责回答「规格与实现哪里对不上」，逐条登记差异，避免后来者按过时文档去理解代码。

---

## 0. 一句话现状

产品定位没变（本地只读的多 agent 协作可视化终端），但**实现形态已经离开 v0.1 设计**：

- 领域模型由 **team** 改为 **工程（project）**（commit `def3fee`）；
- 界面从「工位视图 + 对话记录两个 Tab」扩展为 **楼层（1F~7F 受监控产品）+ 等距 Canvas 办公室 + 主 Agent 控制台**；
- 成员来源从「roster（`config.json`）+ A 路线目录监听」改为 **hook 上报 / `.codebuddy/agents` 名册 / `.workgremlin/subagents.json` 清单**三路；
- 承诺的 **A 路线（`chokidar`）、消息脱敏、FTS5 查询、双连接存储、TS 迁移、自动化测试** 均未落地。

---

## 1. 分层与目录职责

```
shared/                 协议真源（CJS，零依赖，Node 与浏览器同构）
  index.js              常量 / 信封 / dedupeKey / 状态与角色配色  ← PROTOCOL_VERSION = 2
server/                 Express + ws + better-sqlite3，可内嵌 Electron 也可独立启动
  src/index.js          createServer()：装配 DB / bus / hub / 路由 / 工程管理 / 名册 / 清单
  src/cli.js            独立启动 + --self-test（建表 → 写入 → 读回 → checkpoint）
  src/config.js         端口探测（21800-21820）、每次启动随机 token、~/.workgremlin/server.json
  src/clock.js          时钟抽象（测试契约 7.1）
  src/db/{schema.sql,index.js}   建表 + 预编译语句 + PRAGMA
  src/ingest/bus.js     唯一写入口：落库 → 广播 → 组装成员卡 / 首屏快照
  src/ingest/agentRoster.js      .codebuddy/agents 名册 → 常驻小怪物（坐工位、带工牌）
  src/ingest/agentLevel.js       用户级 / 项目级判定（工牌颜色）
  src/ingest/subagentFeed.js     subagents.json 清单 → 临时成员（头顶幽灵）
  src/project.js        工程名解析（package.json name > 目录名）
  src/workspace.js      「打开工程」：切换 + 落盘 workspaces.json + 最近 8 个
  src/products.js       楼层 = 受监控产品（安装位置 + 落盘目录探测）
  src/sessions.js       插件结构化落盘解析（genie-history / todos / message-queue / file-changes）
  src/sessionRegistry.js 全局活跃会话表（60 分钟无事件剔除）
  src/ws/hub.js         WS 连接管理、订阅过滤、广播
  src/http/routes/*     健康检查 / 查询 / 上报 / 工程 / 会话 / 产品
desktop/                Electron 主进程（内嵌 server，单实例锁）、preload（受限桥）、window、menu
renderer/               Vue 3 + Vite + Pinia
  src/iso/              手写 Canvas 等距办公室引擎（engine 2000+ 行、officeMap、sprites、mainConsole）
  src/views/            IsoOfficeView（主）/ OfficeSceneView（旧 2D，保留对比）/ Workstation / Conversation / DeskLab
  src/stores/           project（成员+连接）/ sessions（楼层+会话）/ messages / mainAgent（相位状态机）
packages/reporter/      agent 侧上报 SDK + CLI + hook（CodeBuddy 插件/CLI、WorkBuddy CLI）
scripts/                dev / build / postinstall(electron-rebuild) / install-hooks / subagents
docs/                   需求、技术方案、排期、测试策略、runbook、楼层电梯设计、本文
```

---

## 2. 运行时数据流

```
CodeBuddy 插件/CLI、WorkBuddy CLI 的 hook ─┐
reporter SDK / CLI（workgremlin-report）  ─┤ POST /api/v1/{register,heartbeat,status,task/*,message,file/touch}
                                          │        │
.codebuddy/agents/*.md（名册）────────────┤        v
.workgremlin/subagents.json（清单）───────┤   ingest bus ──> SQLite + WS Hub ──> renderer(Pinia)
各产品落盘目录（插件/CLI 会话）───────────┘        │
                                                  └─> buildMemberCard() / buildSnapshot()
```

**五条成员/数据来源（全部已实现）**

| 来源 | 触发 | 产出 | 证据 |
| --- | --- | --- | --- |
| hook 上报 | CodeBuddy 系发 `SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop / SessionEnd` | 成员注册、任务、状态、文件改动、心跳守护（15s） | `packages/reporter/src/hook.js` |
| 常驻名册 | 扫 `<workspace>/.codebuddy/agents/*.md` 与 `~/.codebuddy/agents/*.md` | `role=subagent`、`ephemeral=false` 的坐工位小怪物（15s 心跳） | `server/src/ingest/agentRoster.js` |
| 临时清单 | 轮询 + `fs.watch` `.workgremlin/subagents.json` | `ephemeral=true` 的头顶幽灵；清单删除即散场 | `server/src/ingest/subagentFeed.js` |
| 落盘扫描 | 扫各产品数据目录 | 楼层活跃会话、待办、改动文件、相位（`inferred`） | `server/src/products.js`、`server/src/sessions.js` |
| Codex CLI hook | Codex 原生 hook（`~/.codex/hooks.json`，10 个事件） | 成员注册、任务、状态、相位、文件活动、子代理幽灵 | `packages/reporter/src/hook.js`（`WORKGREMLIN_CLIENT=codex`）、`scripts/install-hooks.js` |

**纪律（代码里反复强调，且已被实现遵守）**：拿不到就是空 —— 无心跳 60s 标 `degraded` 而不改状态；进度拿不到显示「进度未知（未上报）」而不是 0%。

**IDE 形态（Codex 的 VS Code 扩展 / app-server）的两个坑（2026-09-27 修）**：
① 提交的 prompt 是**拼好的** —— IDE 在前面注入 `# Context from my IDE setup:` / `## Active file:` /
`## Open tabs:`，用户那句话在 `## My request:` 之后。hook 按 `userRequestText()` 只取请求正文：
整段（含被截断的）注入块当标题，任务列表里就只剩一堆 IDE 上下文、用户的话一个字看不见；
老数据在渲染层按同一套规则（`TaskRecordsView.vue` 的 `promptOf()`）再剥一次。
② 改动文件三路取：PostToolUse 从 `tool_input` 解析 apply_patch 的 patch 文本（`command` / `input`
键都认），收工时再按 transcript 里 apply_patch 的权威清单（`Success. Updated the following files:`
+ `M/A/D <路径>`）按**本轮开始时刻**补一遍 —— IDE 形态的 PostToolUse 常常不带 patch 文本，
只靠前者就会"任务结束没有改动文件列表"。自检见 `npm run test:ide-hook`
（`server/test/ideHook.test.js`）。
第三路是**兜底**：按 mtime 扫 `git ls-files`（受版本控制的 + 未跟踪但非忽略的）里**本轮开始后**
动过的文件 —— agent 用 shell 改文件（`sed -i` / `patch` / python 写文件 / 重定向）时前两路都看不到，
实测 2026-09-27 有一轮真改了 3 个文件、任务里却显示"文件变化 0"；被 .gitignore 忽略的构建产物
（`dist/` 等）不算，非 git 工程这一路自动退空。
③ 客户端标签分 CLI / 插件：Codex（3F）与 Claude Code（4F）的 CLI 与自家 IDE 扩展都共用一份落盘、
同一个 client（`codex` / `claude`），光看 client 只能显示「Codex」/「Claude Code」。hook 从**会话自己
落的记录**里认出形态（`form = 'cli' | 'plugin'`）随任务一起上报，落 `task_runs.form`，任务列表按
「产品名 + 形态」显示（Codex CLI / Codex Plugin、Claude Code CLI / Claude Code Plugin）：
Codex 看 rollout 的 `session_meta`（`source` / `originator`，见 `codexForm()`）；Claude 看 transcript
第 3~5 行的 `entrypoint`（终端 `cli` / VS Code 扩展 `claude-vscode`，见 `claudeForm()`）—— Claude 的
两个调用点（开轮 / 收工）同口径，认不出（老版本没有这一位、`sdk-cli` 这类别的形态、落盘读不到）
一律留空，绝不猜。已带形态的标签（CodeBuddy CLI / Plugin）不重复追加，读不到形态的老数据退回只写
产品名。自检见 `npm run test:task-client`（`renderer/test/taskClientLabel.test.mjs`）、
`npm run test:ide-hook` 的 [7]（Codex）与 `npm run test:claude-hook`（`server/test/claudeHook.test.js`）。

---

## 3. 领域模型（以 `server/src/db/schema.sql` 为准）

| 实体 | 关键字段 | 与文档的差异 |
| --- | --- | --- |
| `projects` | `id`、`name`、`workspace_path`、`main_conversation_id` | 原 `teams` 表；演示工程用保留 id `__demo__` |
| `members` | `ephemeral`、`project_label`、`role`、`reported`、**`client`** | 新增临时成员（幽灵）与所属项目名；工牌级别不下库（运行时判定）；**`client` = 来源客户端（codebuddy / workbuddy / codex / claude，NULL = 通用），办公室按当前楼层过滤就靠它** |
| `agent_status` | `state`、`progress`、`current_files`、`degraded`、`source` | 无 `degraded_reasons[]` |
| `tasks` | `state`、`progress`、`started_at`、`ended_at` | **无** `progress_source` / `blocked_reason` / `waiting_on` / `error_type` |
| `messages` | `dedupe_key` 唯一、`archived_at`、`content_truncated` | **无** `redacted` / `redaction_hits` / `ingested_at_ms` / `reply_to` |
| `messages_fts` | FTS5 `tokenize='trigram'` + 三个同步触发器 | 表已建，但**查询未使用**（见 §5） |
| `file_activity` | `op` CHECK 仅 `('read','write')` | 缺 `edit` |
| `artifacts` / `events` | 产出与审计 | `events` 表已建但**无写入方** |

---

## 4. 楼层与会话模型（文档里没有的新概念）

左侧「楼层」= 受监控的智能体产品，**只有安装位置命中才算 `installed`**（落盘目录不算证据，避免自己写的 `settings.json` 自我欺骗）：

| 楼层 | 产品 | 落盘形态 |
| --- | --- | --- |
| 1F | CodeBuddy（**CLI 与 Plugin 合并成一层**） | CLI：`~/.codebuddy` 下的 `*.jsonl` + reporter 状态文件；Plugin：编辑器 globalStorage 的结构化目录（genie-history / todos / message-queue / file-changes，唯一能拿到运行态的那一路）。两路都在这一层，同时开着两种形态 = 这一层里的**两条会话**（按 `session_id` 区分），不是两个楼层 |
| 2F | WorkBuddy | `~/.workbuddy` 下 `*.jsonl`（只有 CLI 一个形态，上报身份 client=workbuddy） |
| 3F | Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl`（cwd 在首行 `payload.cwd`） |
| 4F | Claude Code CLI | `~/.claude/projects/<工程目录>/*.jsonl`（cwd 从第 3 行 `user` 记录起才有，**首行没有**；见 `sessionRegistry.js` 的 `cwdOfHead`）。同一层多会话靠 `session_id` 区分；这一轮走的形态（终端 / VS Code 扩展）也落在同一条 `user` 记录上（`entrypoint`，见上页 ③） |
| 5F | TraeCode（**IDE 与 Plugin 合并成一层**） | 会话来源是 reporter 状态文件（`sessionId` / `workspacePath` 都是 hook payload 实测值）：两个形态都没有可扫的**会话**落盘 —— IDE `~/.trae-cn/memory/projects/<工程>/<日期>/session_memory_<会话>.jsonl` 与 `project_memory.md` 是记忆文件（文件名带 session_id，但不是对话记录、也没有工程路径）；插件 `~/.marscode` 实测只有 ai-chat 二进制、日志与 `ai-agent/database.db` / `snapshot/<链 id>/v2/.git` 文件快照（前者是**加密数据、非可读 sqlite**，后者是逐轮改动的 git 快照）—— **所以插件这一形态目前不支持会话记录**。**两处落盘都在楼层胶囊的 tooltip 里逐路列出**（IDE / plugin 两行，**不带 `sources[].note`**，只列目录与落盘统计）。形态靠上报身份（`client`）区分，任务列表按 `CLIENT_LABELS` 显示 **TraeCode IDE** / **TraeCode Plugin**，不按楼层特判 |
| 6F | Qoder（**CLI 与插件合并成一层**，与 4F Claude 同理） | 会话两路来源：① 落盘 transcript `~/.qoder/projects/<工程目录>/<会话>.jsonl`（Claude Code 同款格式：文件名即 `session_id`、每行带 `cwd`，工程路径从 `cwd` 解析，见 `sessionRegistry.js` 的 `SUBTREE`/`sessionIdOfFile`/`cwdOfHead`）；② reporter 状态文件兜底（JSONL 还没写/读不出时，hook 那一路照常列会话并提供实时相位）。两路按 `session_id` 去重（cli 有活会话就撤掉 hook 行）。`~/.qoder` 这一路只列落盘（文件数 / 体积 / 最后写入）。hook 写入 `~/.qoder/settings.json`（与 Claude / CodeBuddy 同构），由 `--agent qoder` 分流；事件表暂默认采用最宽的 Claude 风格（`scripts/install-hooks.js` 的 `QODER_EVENTS`），待确认 Qoder 真实事件名后再收紧。**Qoder 实测只发 `SessionStart` / `SessionEnd`、没有细粒度事件**，故 `hook.js` 对 qoder 补「思考中 / 已完成」粗粒度相位——6F 不会一直「未上报」，但相位精度比 Claude 粗（待 Qoder 开放细粒度事件后自动变细） |
| 7F | Kilo Code（**轮询 + 插件双路**） | **Kilo 没有 hook 子系统**（实测 7.8.1：`kilo --help` 里没有 hook 子命令，也没有任何 `hooks.json` / 可挂命令的事件点），所以既没有 hook 上报、也没有可扫的会话 jsonl —— 7F 由服务端**轮询**它自己的落盘。会话 / 相位 / 完成标记全部来自 `server/src/kilo.js` 读它那份 **event-sourced SQLite**（`~/.local/share/kilo/kilo.db`，WAL 模式，只读打开不阻塞 Kilo 的 daemon）：`session`（id / directory=工程路径 / title / agent / model / time_updated / summary_*）＋ `event`（append-only，aggregate_id=会话、seq 单调、data 里 `part.type ∈ tool|text|reasoning|step-start|step-finish|patch`、`part.state.status ∈ running|pending|completed|error`）＋ `message`（role、path.cwd、`finish ∈ stop|tool-calls|length|content-filter`）。相位由**最新事件推导**（tool+running→调用工具、tool+pending→等待授权、reasoning→思考中），**不是**像 5F 那样拿文件时间猜；**`text` 不等于待命**（实测 2026-09-28 修的坑）：Kilo 在**一轮之内**会多次吐 assistant 文字（每次工具调用前后都可能来一段），而轮询只看最新那条 part —— 模型在两次工具调用之间说话时最新 part 正是 text，早先一律 `text→待命` 于是任务还在跑、主 agent 却闪回「待命中」，几秒后又被下一条 tool 事件顶回「调用工具」（相位在两个值之间来回跳）。改判这条 text 归属 message 的 `finish`（`part.messageID` join 回 `message` 表）：只有 `finish=stop`（且 `time.completed`）才是整轮说完了 → 待命；`finish=tool-calls` / 还没有 finish（正在流式吐字）→ **思考中**，与其它楼层在工具间隙回落思考中的口径一致（hook.js 的 PostToolUse）。插件那一路同一个坑也修了（`message.part.updated` 的 assistant text 原先报 idle，现报 thinking；真正收尾仍由 `message.updated` 的 finish / `session.idle` 负责）。**「思考中」要带内容**：轮询这一路原本每个分支都写死 `prompt:''`，屏上一个字都没有；现由 `readRoundPrompt()` 取这一轮 role=user 的 text part（剥外层 JSON 引号、截 80 字）经 `sessionRegistry` 透传，插件那一路则由 `startTask` 把用户原话写进状态文件的 `taskTitle`（服务端 `readReporterPhase` 读成 `prompt`）—— 与 hook 那一路 `hook.js` 的做法一致，两条路都能在屏上显示用户问的是什么。完成标记取 `finish=stop` 那条 assistant 消息（`tool-calls` / `length` / `content-filter` 都不算"完成"）。数据根按 XDG 位置认（`kiloHome()`），**不是** `~/.kilo`（那个目录实测只有安装期留下的 `bin/`）。来源只有 `kind:'kilo'` 一路（读 SQLite，与 cli 扫 jsonl 完全不同，故单开一个 kind）：落盘统计与"会话是 SQLite、不是可扫的文件"那句说明都挂在同一路（不再单列 `kind:'dir'` 展示路，胶囊 tooltip 也就不会再多打一行"没有找到落盘目录"）。因是轮询而非上报，**相位一律 `inferred:true`**（UI 按推断灰显）；自检见 `npm run test:kilo` |；**任务台账只有插件形态有**：轮询那一路是**只读**的，监控端伪造上报违背「绝不编造」，所以 CLI / TUI 不装插件时任务列表与对话记录为空（相位与完成标记仍有）。**插件注册键名是 `plugin`（单数）、条目形如 `[绝对路径, {options}]`**（实测 2026-09-28 修的坑：早先写成 `plugins: [{package, options}]`，Kilo 7.8.1 降级到 V1 配置时对 `plugins` 报一条 `Omitted native setting that cannot be represented in V1` 的 WARN 并**整段丢弃** —— 插件看着装上了却一条状态文件都不写、7F 任务台账永远空，且除那条 WARN 外无任何报错，WARN 只在 `~/.local/share/kilo/log/opencode.log` 里；改正键名后 `kilo debug config` 能看到该条被规范成 `file://` URL，探针插件实测收到 `session.created` / `message.part.updated` 等真实事件）。装了 WorkGremlin 插件（`packages/reporter/src/plugin/index.js`，8F 共用）后，插件会往台账上报 `register`（**必须带 `role:agent`**，否则 `bus.endTask` 不写 `task_runs`）、`task/start`、`task/end`（带 result 与本轮改动文件）、`message`（收尾自述）、`file/touch`（**只报写类工具**，读类不报），以及 subagent 幽灵（`task` 工具召唤时写 `.workgremlin/subagents.json`，格式与 hook.js 共用 `packages/reporter/src/ghostFeed.js` 那一份实现）。拿不到会话标题就不传 `result` —— 事件流里没有「最后一段 assistant 文本」这个信号，拿文件清单拼一句「完成了 N 个文件」属于编造自述，不做。真相位压过轮询推导**不靠 sources 顺序**（claim 先到先得，hook 那一支沿用老约定只报 `unreported`），而是 `sessionRegistry` 的 kilo 那一支自己去问 `reporterMainPhase`（`kilo` 与 `kilo-plugin` 两个身份都试 —— 插件装在 CLI 上判出来的正是 `kilo`）。自检：`npm run test:plugin-ingest`（打假服务端验上报）、`npm run test:plugin-e2e`（真起服务端跑通整条链，沙箱 HOME）、`npm run test:ghost`
| 8F | OpenCode（**轮询 + 插件双路**） | 与 7F 同源（Kilo Code CLI 就是 OpenCode 的 fork，落盘结构同源：`<数据根>/{kilo,opencode}.db` + `storage/session_diff/` + `repos/` + `shell/` + `snapshot/`），但**V2 schema 已分叉，照抄 7F 的取法会读到空数据**：实测 Kilo 7.8.1 的 `event` 表有 2288 行（落盘），OpenCode 2.0.18 的 `event` 表**是 0 行**（事件只在内存流里推、不落盘）。所以 8F 改读 `session_v2`（id / directory=工程路径 / title / agent / model / time_updated / summary_*）＋ `session_message`（`type ∈ assistant|user|idle|synthetic`，`data.content[]` 里 `part.type ∈ tool|reasoning|text`、工具块是 `{type:'tool',name,state:{status,input}}`）。相位由**最新消息的 content[]** 推导（tool+running→调用工具、tool+error→调用工具但报错、reasoning→思考中、`type:'idle'` 行→待命），一律 `inferred:true`；完成标记取 `finish=stop` 且 `time.completed` 落过的那条（`tool-calls` / `error` 都不算"完成"）。表名与列名都**探测**着来（`session_v2` → `session`、`pragma table_info` 取交集），OpenCode 改版换表不会把接口打挂。**关键能力差：轮询给不出「等待授权」** —— 全库 114 条 assistant 消息实测 `tool.state.status` 只出现过 `completed / error / running`，**没有 `pending`**（Kilo 有），授权在 OpenCode 是独立事件（`permission.asked`）且只在内存流里。所以 8F 额外挂 `kind:'hook'` 一路：装了 WorkGremlin 插件（`packages/reporter/src/plugin/`，实现 OpenCode/Kilo 的 `ctx.event.subscribe` 事件流，状态文件格式与 `hook.js` 完全一致、服务端零改动）时，相位是**上报真值**（不标 inferred、UI 不灰显）、多出「等待授权」、完成标记还带**改动文件清单**（`session.step.ended` 事件的 `data.files`）；没装插件就自动退回轮询推导。数据根按 XDG 位置认（`opencodeHome()`）；`opencode` 可执行文件实测在 `~/.opencode/bin` 且**不在 PATH**，`CLI_BIN_DIRS` 已显式认这一条否则永远判成"没装"。自检见 `npm run test:opencode` |

合并楼层在 `products.js` 里由 `sources` 声明（1F 是 `['cli', 'plugin', 'hook']`，5F 是
两个 `dir` 落盘 + `hook`，7F 是一个 `kilo`（自带数据根落盘统计），8F 是 `opencode`（自带数据根）
轮询 + `hook` 收插件真相位）：一个楼层可以吃多路落盘，
每一路带自己的 client（`codebuddy` / `codebuddy-plugin`、`trae` / `trae-plugin`），
相位与完成标记按会话各认各的。
条目可以是 `{ kind, label?, client?, dirs?, note? }`：`kind: 'dir'` = 只作落盘展示、不产会话
（`sessions: false`），两份 `dir` 靠 `label` 在 tooltip 里区分（IDE / plugin）；5F 这两路
**不带 `note`**（不想带说明时，服务端不下发即可，前端不按楼层特判）；
`label` 还用来给"一路抵两形态"的合并楼层起显示名 —— 3F/4F/6F/7F 标 `CLI/Plugin`（CLI 与 IDE 插件共用同一份落盘，分不出），8F 标 `CLI/Desktop`（CLI 与桌面端/网页端同一个二进制、同一个数据根）；
`kind: 'kilo'` = 7F 专用，读 Kilo 的 SQLite（与 `kind: 'cli'` 扫 jsonl 是两套取法，
所以单开一个 kind，别让 `sessionRegistry` 里两条分支互相误认）；
`kind: 'opencode'` = 8F 专用，读 OpenCode 的 SQLite —— **与 `kind: 'kilo'` 也是两套取法**
（Kilo 读 `event` 表、OpenCode 读 `session_message`，因为后者 `event` 表是空的，见上表）；
`kind: 'hook'` 在 8F 是**叠加**在轮询之上的那一路，不是替代：装插件时它给真值，
没装时它空着、轮询照常兜底（两者都按 `session_id` 精确去重，见 `sessionRegistry` 的 `claim`）；
`kind: 'plugin'` 那一路读不出会话时（没有 `genie-history` 这类索引），服务端在 `sources[].note` 里给一句说明，
楼层胶囊的 tooltip 照它显示；`kind: 'dir'` 的展示路不带 `note`。
自检见 `server/test/mergedFloors.test.js`（`npm run test:floors`）与
`server/test/kiloFloor.test.js`（`npm run test:kilo`）。

选中的会话决定主 Agent 控制台的相位（幽灵状态跟着走），办公室布局不受影响；切到没有活跃会话的楼层时整屋清空。

### 4.1 「任务取消」逐楼层来源（红色「任务取消」，不是绿色「任务完成」）

主控制台在收尾时只问一件事：**这一轮是干完了，还是被用户掐掉了**。唯一真源是 reporter /
各产品落盘里的那枚 **完成标记**（`done`），`done.cancelled` 为真即亮红色「任务取消」，第三层照
「改动文件清单 / 没有输出」显示。渲染层读两路：① `/reporter-phase` 快轮询的 `done.cancelled`；
② `/sessions` 会话快照的 `doneCancelled`，取或（见 `IsoOfficeView.vue`）。

「被掐掉」的信号各家不一样，逐楼层如下（**知道"被打断"就亮红，不知道就老实当没有取消、绝不臆造**）：

| 楼层 | 产品 | 取消信号（落盘真值） | 落地位置 |
| --- | --- | --- | --- |
| 1F | CodeBuddy（CLI + Plugin） | ① CLI 走 `Interrupt`（有则用）/ Stop payload 的 `final_stop_reason ∈ cancelled/interrupted`；② **IDE（Plugin）不发 Stop / Interrupt**，由服务端兜底合成：状态文件 `taskId` 一直占着 + 空闲超 `TASK_RUN_MS` + transcript 末轮 `state='running'` → 合成取消标记，并补发一次 `task/end(cancelled)` | `hook.js`（`--agent codebuddy`）+ `sessions.js` 的 `readReporterDones.cancels` / `sessionRegistry` 的 `flushSynthesizedCancels`，回归 `test:codebuddy-cancel` |
| 2F | WorkBuddy | 同 1F 家族（同一条 hook，`--agent workbuddy`） | `hook.js` |
| 3F | Codex | ① 显式 `Interrupt` 事件；② 交互式会话常**不发** `Interrupt`，Stop 时读 rollout 里的 `event_msg/turn_aborted`（reason=interrupted）兜底 | `hook.js` 的 `runInterrupted`/`turnInterrupted`，回归 `test:stop-interrupt` |
| 4F | Claude Code | Claude 不发 `Interrupt`；Stop 时读 transcript 里的 `[Request interrupted by user]`（工具中途打断带 ` for tool use` 后缀） | `hook.js` 的 `turnInterrupted`，回归 `test:stop-interrupt` |
| 5F | TraeCode | **没有可读的取消信号**（无 transcript 可写、hook 只到 Stop/SessionEnd）→ 不亮「任务取消」，收尾仍按「任务完成」 | —— |
| 6F | Qoder | 与 4F 同款（Claude 转写格式）：Stop 时读 transcript 的打断标记 —— Qoder 目前只发粗粒度事件，实际多半拿不到 | `hook.js` 的 `turnInterrupted` |
| 7F | Kilo Code | ① 装了插件：`session.idle` 时若这一轮还开着 → 落一枚 `done.cancelled`（与 hook.js 的 `Interrupt` 同形）+ 台账 `task/end(state=cancelled)`；② 纯轮询这一路读不出打断（`message.finish` 没有 interrupted）→ 不臆造 | `packages/reporter/src/plugin/index.js` 的 `session.idle` 分支 |
| 8F | OpenCode | ① 插件那一路同 7F（`session.idle`）；② 轮询那一路按 `session_message` 的 `type='idle'` / `data.outcome='interrupted'` 判取消 | `plugin/index.js`、`server/src/opencode.js` 的 `readOpencodeDone` |
| 9F | GitHub Copilot | **没有可读的取消信号**（没有 hook，会话日志里没有"被打断"字段）→ 不亮「任务取消」 | —— |

服务端透传一侧：CLI / hook 楼层的快轮询直接透传 reporter 的 `done.cancelled`；7F/8F 走
`toReporterDone`（把会话行形状的 `doneCancelled` 翻回快轮询的 `done.cancelled`）；会话快照按
`sessionInfo.doneCancelled` / 会话行的 `doneCancelled` 下发（7F/8F 那两支以前把原始 `done`
直接摊进会话行，字段名对不上，现统一经 `doneFieldsFromReporter` 归一）。

**取消信号的判定一律按结构，不全文搜字符串**（`hook.js` 的 `isInterruptLine`）：agent 自己的
工具输出 / 思考里经常出现 `turn_aborted` / `Request interrupted by user` 这些词（实测：跑一句
`rg 'turn_aborted'`、或讨论打断逻辑，输出被原样写进 rollout），全文匹配会把**没被打断**的一轮
误判成取消 —— 控制台报红色「任务取消」、产出摘要还被一并清空。所以逐行 `JSON.parse` 后只认
Codex 的 `event_msg/turn_aborted` 事件行与 Claude 家族 `user` 消息里的正文文本，工具结果 /
思考 / 普通消息里带同名字符串一律不算。回归见 `npm run test:stop-interrupt` 的 [4]。

**收尾那一下必须把实时相位一起清掉**（`hook.js` 的 Stop / Interrupt）：以前只清 `taskId`，
`sessionPhase` 原样留着（还是 `thinking` / `tool`，ts 停在最后一个事件那一刻），服务端的新鲜期
（taskId 没了还有 `AWAIT_TTL_MS`=5 分钟）一直认它新鲜 —— 现象就是「任务完成 / 任务取消亮过之后，
控制台一直停在『思考中』」，且渲染层那条"刚亮的收尾相位不许被实时相位盖掉"的守卫也因
`fastPhase.phase` 非空而失效，红色「任务取消」刚亮就被旧相位顶回去。现在两个收尾分支都把
`sessionPhase` 落成 `null`（= 这一轮真的没在动），控制台按"接了 hook、此刻没动作"落「待命中」。

**`Notification idle_prompt` 不许清掉 `done`**：CodeBuddy CLI 每轮结束后约 60s 会发一条
`idle_prompt`（实测 events.log）。这一支以前走 `clearAwait()`，而它会把 `done` 一并写 null ——
`done` 是「任务完成 / 任务取消」唯一的凭据，抹掉之后标记与控制台实时状态一起消失。现在
idle_prompt 只撤 `await` / `pending` 并把相位清掉，`done` 原样保留（新的 `UserPromptSubmit`
仍照常把它清掉）。回归见 `npm run test:stop-interrupt` 的 [1]/[5]。

**取消照「任务完成」一样记录：取消只是"没干完"，不是"没产出"。** 被打断的那一轮
已经吐出来的文字（`task_runs.result` + 对话记录 `type=result`）与改过的文件
（`task/end.files`）照常入账；主控制台第三层按「改动文件 → 那一轮说的话 → 没有输出」
择优显示（`IsoOfficeView.vue` 一处决定），真的一点产出都没有才写「没有输出」。
（早先取消一律把 `said` / `result` 清空，理由"别拿上一轮冒充"——现在 `turnReplies`
按本轮 user 起算、且跳过 `[Request interrupted by user]` 那条标记行，本轮输出不会串到上一轮。）

---

## 5. 文档 ↔ 实现 差异清单

| # | 条目 | 文档说法 | 实现现状 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 协议版本与信封 | `PROTOCOL_VERSION = 1`，信封字段 `team` | **v2**，信封字段 `project` | `shared/index.js` |
| 2 | 领域模型 | team 为一等字段、UI 支持 team 切换 | **工程（project）** 为一等字段，无 team | `def3fee`、`schema.sql` |
| 3 | 数据源 A（目录监听） | `chokidar` 监听 `.codebuddy/teams/**`，M1 实现 | **未实现**；`chokidar` 只在 `server/package.json` 声明，源码零引用 | `server/package.json` |
| 4 | 成员来源 | `config.json` roster + 上报 | hook / `.codebuddy/agents` 名册 / `subagents.json` 清单 / 落盘扫描 | §2 表 |
| 5 | 主体状态枚举 | 5 主状态 `offline/idle/busy/blocked/error` + `degraded` | shared 为 `online/busy/idle/blocked/offline/thinking`；**无 `error`**，多 `online`/`thinking`；办公室只显示「忙碌 / 空闲」两档 | `shared/index.js`、`renderer/src/iso/engine.js` |
| 6 | 消息类型 | 10 类（含 `review`/`error`） | `MESSAGE_TYPES` 已含 10 类 | `shared/index.js` |
| 7 | 心跳节拍 | 15s 上报 / 60s 超时 | 一致：`HEARTBEAT_TIMEOUT_MS=60s`、hook 守护 15s、SDK 默认 5s | `shared/index.js`、`hook.js` |
| 8 | 消息脱敏（P0-7） | 入库前正则替换为 `***`，原文不入库 | **未实现**（无 `redact` 相关代码），境内目前可能落明文 | 全仓检索无命中 |
| 9 | 中文搜索 | FTS5 `trigram`，1~2 字降级 `LIKE`，FTS/LIKE 不混排 | 虚表与触发器已建；`listMessages` **一律 `LIKE`**，未接 FTS 与降级分支 | `schema.sql`、`server/src/db/index.js` |
| 10 | 存储安全基线 | 双连接（写连接 `secure_delete=OFF` / 删除归档连接 `ON`） | **单连接**，全部 `secure_delete=ON` | `server/src/db/index.js` |
| 11 | 文件活动三值 | `read / write / edit` | CHECK 仅 `read / write` | `schema.sql` |
| 12 | 归档保留 | 90 天 / 单工程 10 万条，超限导出 JSONL | 只有 `archived_at` / `content_truncated` 字段与手动 `purgeProject`，**无自动归档** | `server/src/db/index.js` |
| 13 | 进度三层降级 | 上报 → 子任务推导 → 条纹不确定条 | 只有「上报值」与「未知文案」两态，无条纹动效、无推导 | `renderer/src/components/ProgressBar.vue` |
| 14 | 告警与通知 | 站内 S1 提示（M1）+ 系统通知（M3） | **未实现** | 全仓检索无命中 |
| 15 | 语言栈 | TypeScript（main 拍板，含 1 天上限与切 B 条件） | **CommonJS JavaScript** + `jsconfig.json` | `package.json` |
| 16 | 测试 | Vitest + Playwright，15 条可测性契约，L1 覆盖 ≥80% | **无任何测试文件**（只有 `docs/test-strategy.md`）；契约中仅时钟抽象等少数落地 | 仓库 |
| 17 | 界面 | 工位视图 + 对话记录两个 Tab | **办公室（等距 Canvas，默认）/ 工位卡片 / 对话记录**，另有 `?tab=flat`、`?tab=lab` | `renderer/src/App.vue` |
| 18 | 反向控制（M4） | 派活 + 中断，需二次确认 | 未实现（办公室里的「集合开会 / 全员回工位」是纯本地动画，不是向 agent 下发指令） | `renderer/src/iso/engine.js` |
| 19 | 打包 | electron-builder，x64 三平台 | 未接入（`build` 只构建 renderer） | `package.json`、`scripts/build.js` |

---

## 6. 「已承诺但未实现」清单（按对产品价值的影响排序）

1. **消息脱敏（P0-7）** —— 唯一一条被文档标为「硬要求 / P0 缺陷」却完全没写的功能，且当前没有任何拦截点，落库即明文。
2. **A 路线兜底** —— 没有它，未接 hook 的 agent 完全不可见；`reporter` 的接入是唯一入口。
3. **FTS5 查询与短词降级** —— 数据量上来后 `LIKE %kw%` 会随消息数线性变慢。
4. **自动归档与保留策略** —— 库会无限增长。
5. **自动化测试与可测性契约** —— 回归只能靠人工跑 `npm run dev`；`docs/test-strategy.md` 的用例全部处于"设计完成、未落地"状态。
6. **TypeScript 迁移** —— 协议密集型代码目前靠注释与 reviewer 保证字段正确。
7. **告警 / 通知、打包分发、导出** —— M1/M3 项，未开工。

---

## 7. 文档维护约定

| 你想改什么 | 改哪份 |
| --- | --- |
| 产品要什么、验收标准、状态语义 | `docs/requirements.md`（编号权威在 `requirements-outline.md`） |
| 技术选型、数据结构、协议 | `docs/tech-design.md` |
| 里程碑与责任 | `docs/roadmap.md` |
| 用例设计 | `docs/test-strategy.md` |
| 跑起来 / 排障 | `docs/runbook.md` |
| **代码现在的真实形态、与上述文档的差异** | **本文** |

改代码时如果动了 §1~§5 中的任何一条事实，请顺手更新本文对应行；新增差异请追加到 §5 表格而不是散落在别处。

---

## 8. Codex CLI 支持矩阵（2026-09-20，实测 Codex 0.151.0）

协议：Codex 有原生 hook 子系统（`hooks` 是默认开启的 stable feature），文件是
`$CODEX_HOME/hooks.json`，结构与 CodeBuddy / Claude Code **同源**（`{matcher, hooks:[{type:'command',…}]}`）。
**hook 需要信任**：交互式会话要在 TUI 里用 `/hooks` 批准一次；自动化用 `--dangerously-bypass-hook-trust`。
`~/.codex/agents` 目前还不存在，Codex 侧的具名 agent 定义仍待实证。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 成员注册 / 心跳 / 状态（busy·idle·offline） | ✅ 实测 | SessionStart / Pre·PostToolUse / Stop / SessionEnd |
| 任务开始 / 结束 / 完成标记 | ✅ 实测 | UserPromptSubmit → `task/start`；Stop → `task/end(done)` |
| 相位（思考中 / 调用工具 / 等待授权 / 待命） | ✅ 实测 | Pre/PostToolUse → tool/thinking；空闲时「待命」；不再退回"按 jsonl 时间猜" |
| 文件活动（正在读写） | ✅ 实测 | `apply_patch` 没有 `file_path`，路径从 patch 文本的 `*** Update/Add/Delete File:` 解析 |
| 子代理幽灵（出现 / 收工汇报） | ✅ 实测 | SubagentStart/Stop；名字取 `spawn_agent` 的 `task_name`，汇报文案取 `last_assistant_message` |
| 打断收场（收掉孤儿幽灵） | 🟡 仅离线验证 | `Interrupt` 事件已接，真实会话里还没出现过 |
| 打断 → 主控制台「任务取消」（红色，不是「任务完成」） | 🟡 仅离线验证 | `Interrupt` 落 `done.cancelled`（与 Stop 的 done 同形）；另外 Stop 时读 rollout 里的 `turn_aborted` 兜底（交互式会话里 `Interrupt` 不一定发）；回归见 `npm run test:cancel`、`npm run test:stop-interrupt` |
| 等授权（blocked·awaiting_permission） | 🟡 仅离线验证 | 本机 `permission_mode=bypassPermissions`，从不弹权限框；Codex 走显式 `PermissionRequest`（不再用 CodeBuddy 的 pending 推断） |
| 坐工位小怪物名册（Codex 侧 agent 定义） | 🟡 未实证 | 按 `$CODEX_HOME/agents`、`<工程>/.codex/agents` 的 `.md`/`.toml` 扫；本机还没有这类文件 |
| 楼层 / 会话列表（3F） | ✅ 已有 | `products.js` 探测 codex 可执行文件；`sessionRegistry.js` 扫 `~/.codex/sessions/**/rollout-*.jsonl`，用 `cwdOfHead` 从头部若干行取 `payload.cwd` |
| 按客户端隔离（3F 不显示 CodeBuddy 的成员与相位） | ✅ 实测 | `members.client` + `/api/v1/reporter-phase?client=`（合并楼层可传逗号分隔的一串） |
| PreCompact / PostCompact | ❌ 未处理 | 与 CodeBuddy 一致（没有对应的 UI 语义） |
| `Stop.last_assistant_message` | ❌ 未使用 | 完成摘要仍取"本轮改动过的文件" |
| `turn_id` / `agent_id` 归因 | ❌ 未使用 | 子代理自己的工具调用带 `agent_id`，本可把文件活动归到那只幽灵身上（现在仍算主成员） |
| 工具名归一 | ✅ 实测 | Codex 报的是 `Bash`（不是 shell）、`apply_patch`、`collaborationspawn_agent`（展示去掉前缀） |

## 9. 工作区内的已知杂物（非工程结构）

| 路径 | 现象 | 说明 |
| --- | --- | --- |
| `work/WorkGremlin/` | ~~一份未被 git 跟踪的嵌套副本~~ | **已于 2026-09-21 删除**（内容核实为 hook 状态文件的测试残留，非工程代码） |
| `.workgremlin/workspaces.json` | 内容却是 hook 的相位状态（`lastTool` / `sessionPhase`），不是工程管理该写的 `{current, recent}` | 该目录本应只放 `subagents.json`；疑似历史误写产物 |

## 10. 演示模式：入口从「启动参数」改为「界面按钮」（2026-09-21）

**需求没变**（仍是"一套确定性的假数据、与真实数据隔离"），变的只是**怎么进**：

| 项 | 之前 | 现在 |
| --- | --- | --- |
| 进入方式 | `npm run dev -- --demo` / `--demo-seed N` / `WORKGREMLIN_DEMO=1` / `MOCK=1` | 办公室 HUD 上的「演示模式」按钮（在「集合开会」左边）→ `POST /api/v1/workspace`（空路径）→ `openDemo()` |
| 数据播种 | 启动时按 `shouldSeedDemo()` 判定（`WORKGREMLIN_DEMO_REFRESH=1` 可重灌） | 切进演示工程时**按需播种**（`__demo__` 里没有消息才灌），见 `server/src/index.js` 的 `syncDemo` / `ensureDemoData` |
| 心跳推进器 | 启动时按 `isDemoMode()` 起，进程活着就一直跑 | 随工程切换起停：进演示起、切走停（`workspace.setOnSwitch`） |
| 退出 | 重启且不带 `--demo` | 再点一次按钮（「退出演示」）→ 回进演示前打开的工程（`project.demoReturnPath`） |
| 启动恢复 | `WORKGREMLIN_NO_DEMO=1` 专用来"别把我带回演示工程" | 落盘 `current.demo` 是用户自己点的结果 → 恢复进演示；该变量已删除 |

连同删掉的开关：`desktop/src/main.js` 的 `flags` 与 `workgremlin:get-flags` IPC（`preload.js` / `api/bridge.js` / `stores/project.js` 的 `flags` 一并移除）、`server/src/cli.js` 的 `--demo` / `--demo-seed`、`scripts/dev.js` 的 `WORKGREMLIN_DEMO*` 注入、`createServer({demo, seed})` 两个入参、`workspace.js` 的 `preferDemo`。
保留：`config.DEMO_PROJECT`（`__demo__`）与 `workspace.openDemo()`（切工程本来就有）、`generator.js` 的 `seedDemoData/createDemoTicker`（改为按需调用）、`WORKGREMLIN_DEMO_FIXED_TS`（生成器的时间基准开关，与"怎么进演示"无关）。

演示期间的五处前端特判，都是为了让"点了按钮就真在演示"：
① `sceneMembers` 里演示压过楼层/会话过滤（`floorEmpty` 不清场、`sessions.live` 不把成员压成灰）；
② 会话下拉的"新会话自动跟随"在演示期间不切工程（否则一条真会话冒出来就把演示拽走）；
③ 退出演示时收掉脚本：`mainAgent.enterIdle()`（**不是** `stop()` ——那会亮「已暂停」把演示味留在真数据上），真会话相位随即接管；
④ **控制台归演示脚本独占**：`consoleLive` 的 watch 在演示时提前 return，并保证脚本在跑；
   起脚本走 `mainAgent.startDemo()`（先清 `live` / `hookLive` 再 `start()`）
   —— 不清的话，下拉里那条真会话每 1.5s 就会把它的「待命中」喂进来，脚本起不来 / 刚演一步就被顶掉，
   现象就是"点了演示模式，主 Agent 不动"；
⑤ 顶栏与状态徽标同步：项目徽标显示「演示工程 · 演示模式」（原来优先跟"选中的会话"走，会显示真工程名）、
   会话下拉换成唯一一项「演示工程 · 演示会话」（演示期间不响应切换）、相位来源标成「演示脚本」
   （`ConnectionBar` 的 `source='demo'`，与"上报真值 / 推断值"并列但分开着色）。

> 注：`startDemoScript()` 的守卫从"`live`/`hookLive` 为真就不起"改成"`auto` 为真就不重复起" ——
> 旧守卫在演示里恒为真（真会话总在喂相位），等于永远不起脚本。

**演示工程里的小怪物只留用户级**（2026-09-21）：`createAgentRoster` 的 `getWorkspacePath` 不再回退到
"服务启动时解析出来的工程"，只认当前工程路径 —— 演示工程没有目录（`workspacePath === ''`），
`listDefinedAgents('')` 只列用户级 agent（`~/.codebuddy/agents`、`$CODEX_HOME/agents`），
于是切进演示后**项目级**小怪物（`<工程>/.codebuddy/agents`，如本工程的 leo / susan）会被 `sync()`
从演示工程上摘掉，切回真实工程再自动补回；用户级的（如 simmon）照常留在屋里。
实测：真实工程 3 只（leo:project / simmon:user / susan:project）→ 演示工程 9 只
（8 个演示成员 + simmon:user，无 leo/susan）→ 切回真实工程又回到 3 只。

**名册残留的对账清理**（2026-09-21，紧接上一条）：只改 `getWorkspacePath` 还不够 ——
名册摘人靠**进程内记账**（`registered` / `mine`），服务一重启那笔账就空了，于是**上一轮**注册进
演示工程的项目级成员（leo / susan）再没人认领、也没人心跳，60s 后被 sweep 标成 degraded，
在屋里就是"还在，但灰了"。所以新增 `purgeDemoStragglers()`（`server/src/index.js`）：
进演示（含"启动时落盘就是演示"）时按名册自己的口径对账 —— 演示工程里 `role='subagent'` 且
`agentRoster.isDefined(name)` 为假的成员行摘掉；三类不碰：演示种子成员（leader / coder …）、
主 agent 成员（`role='agent'`，hook 上报）、临时成员（ephemeral）。
配套：`syncDemo()` 的调用点从"restore 之后"挪到 `agentRoster.start()` 之后（对账要用名册的
"已定义"，名册没起来时 `isDefined` 恒假，会把用户级小怪物一起误摘；函数里也加了 `if (!agentRoster) return 0` 兜底）。
实测：手工往 `__demo__` 塞 `role='subagent'` 的 leo（复现"灰着的残留"）→ 切出再切回演示即清掉、
用户级 simmon 保留；再塞 susan 后**重启服务**（落盘仍停在演示工程）也在启动期清掉。
（`ops[灰]` 是演示数据里**故意**留的 degraded 样本，不是残留。）
