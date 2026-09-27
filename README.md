# WorkGremlin

可视化桌面程序：管理 / 监控多 agent 协作团队（leader / researcher / coder / tester）。

两个核心界面：

1. **工位视图** —— 每个成员一张工位卡片：状态（在线/忙碌/空闲/阻塞/离线）、当前任务、进度、正在读写的文件、最近产出、已耗时，自动刷新。
2. **对话记录窗口** —— 全量消息流（谁→谁、时间、类型、内容），支持按成员/时间/类型过滤、关键字搜索、自动跟随滚动。

## 快速开始

```bash
# 0) 前置：Node >= 20.11，Linux 需 python3 + make + g++（编译 better-sqlite3）
node -v && npm -v && python3 --version && which make g++

# 1) 安装依赖（postinstall 会自动跑 electron-rebuild 重建 better-sqlite3）
npm install

# 2) 【V1 判据】验证原生模块可用（建表 + 写入 + 读回 + checkpoint）
npm run db:check

# 3) 开发启动（Vite + Electron）—— 一律接真实数据源
npm run dev
#    想看演示数据：起完之后在办公室右下角操作条上点「演示模式」（在「集合开会」左边），
#    再点一次「退出演示」即回到进演示前的工程

# 4) 构建 renderer 静态资源（M0 的 build；M3 再接 electron-builder）
npm run build
```

只想跑本地服务（不开窗口）：

```bash
npm run server                                  # 同 npm run server -> node server/src/cli.js
node server/src/cli.js --self-test              # 只验证原生模块
```

## 目录结构

```
shared/              类型与协议真源（零依赖，Node 与浏览器同构）
server/              本地服务：HTTP 上报 + WebSocket 推送 + SQLite（可内嵌 Electron，也可独立启动）
desktop/             Electron 主进程 / preload
renderer/            Vue 3 + Vite 渲染层
packages/reporter/   agent 侧上报 SDK + CLI + hook（零依赖）
docs/                设计、协议、runbook、**实现现状（文档对齐记录）**
scripts/             dev / build / postinstall（electron-rebuild）
```

> 文档分工：`docs/requirements.md` 是规格，`docs/implementation-status.md` 记录**代码实际怎么做的、和规格哪里对不上**（含「已承诺但未实现」清单）。读代码前建议先看后者。

## 数据源：A + B 混合

- **B（主，唯一真值）**：agent / runner 通过 `@workgremlin/reporter` 主动上报心跳与任务状态。
- **A（兜底，至今未实现）**：原计划用 `chokidar` 监听 `{workspace}/.codebuddy/teams/**` 只补 roster 与消息；`chokidar` 目前只在 `server/package.json` 里声明，源码零引用。
- 无心跳 60s → 状态标记 `degraded=1`，UI 灰显 + 标注「推断」，**绝不编造进度/文件/耗时**。
- 未接上报的成员，进度与文件区域显示「未上报 / —」。

实际在跑的成员来源有四条（见 `docs/implementation-status.md` §2）：CodeBuddy 系 hook 上报、`.codebuddy/agents` 名册、`.workgremlin/subagents.json` 清单、各产品落盘扫描。

## subagent → 幽灵

真正帮你写代码的 subagent（`code-explorer` / `coder` / `reviewer` …）不是常驻专家，没有工位，
正好对应办公室里飘着的幽灵：**名字是它的 id，状态是它此刻在干嘛，项目名是当前工程**。

服务端读一份清单文件（`server/src/ingest/subagentFeed.js`），谁写都行；仓库自带一个 CLI：

```bash
node scripts/subagents.js set code-explorer busy --task "探查数据流" --progress 0.4
node scripts/subagents.js rm code-explorer
node scripts/subagents.js list
```

对齐语义是「**清单里有谁，屋里就飘着谁**」：`rm` 之后幽灵当场散掉（连状态行一起删，历史消息保留），
服务启动时也会先清一遍上一轮残留的临时成员，避免幽灵赖着不走。

清单文件路径：`$WORKGREMLIN_SUBAGENTS_FILE` > `$WORKGREMLIN_WORKSPACE/.workgremlin/subagents.json` > `<cwd>/.workgremlin/subagents.json`。

## CodeBuddy / WorkBuddy / Claude Code 接入（hook）

让正在干活的 agent 自己往屋里报状态：**启动时会自动接入** —— 探测到装了哪个 CLI（只看安装位置），
就把对应那份 hook 写好（合并式、幂等、首次改动前备份；不想被自动改配置就 `WORKGREMLIN_NO_AUTO_HOOKS=1`）。
**CodeBuddy CLI+插件 / WorkBuddy CLI / Codex CLI / Claude Code CLI / TraeCode IDE+插件 / Qoder CLI** 七个入口的会话都会上报。
**Kilo Code（7F）例外：它没有 hook 可装** —— 见下面「Kilo Code 接入」。
**OpenCode（8F）也不进这份列表**：它没有 `hooks.json` 那套命令钩子，改用「轮询 SQLite + 可选插件」—— 见下面「OpenCode 接入」。

默认**全装**（遍历所有 target，装了才写、没装跳过）：

```bash
npm run hooks:install                      # 用户级：~/.codebuddy + ~/.workbuddy + ~/.codex + ~/.claude + ~/.trae
npm run hooks:install -- --targets=codex   # 只装某个 target（codebuddy / workbuddy / codex / claude / trae / qoder）
npm run hooks:install -- --dry-run         # 只打印将要写什么，一步都不落盘
npm run hooks:install -- --project         # 另外写一份项目级 <仓库>/.codebuddy/settings.json
npm run hooks:uninstall                    # 撤掉（只删我们加的那几条，别人的配置不动）
```

事件 → 上报的映射（对齐 `docs/requirements.md` §5 的状态机）：

| hook 事件 | 上报 |
| --- | --- |
| `SessionStart` | 注册成员 + `idle`（等派单）+ 拉起心跳守护 |
| `UserPromptSubmit` | `task/start`（标题 = 用户那句话的前 80 字）+ `busy` |
| `PreToolUse` | `busy` |
| `PostToolUse` | 写 / 改类工具 → `file/touch`；`busy` |
| `Notification` | 等权限 → `blocked`（`awaiting_permission`）；空闲提醒 → `idle` |
| `Stop` | `task/end(done)` + `idle` |
| `SessionEnd` | `offline` + 撤掉心跳守护 |

几个要点：

- **报给哪个工程**：默认报进屋里「当前打开的工程」（问服务端 `/api/v1/workspace`），
  `WORKGREMLIN_PROJECT` 可覆盖；主 agent 身份由安装目标决定（codebuddy / codex / workbuddy / trae / claude / qoder），已写进命令的 `--agent`。
- **心跳**：60s 无心跳就 `degraded`（灰显 + 「推断」），所以 `SessionStart` 会另起一个 15s
  一次的心跳守护（`node packages/reporter/src/hook.js --heartbeat`），`SessionEnd` 收掉；
  会话异常退出时，最多 30 分钟没有事件就自己退，不留孤儿进程。
- **绝不阻塞 agent**：服务没起 / 上报失败 / stdin 不是 JSON，一律静默退出 0，
  且**一个字都不写 stdout**（hook 的 stdout 会被塞回上下文）。调试用 `WORKGREMLIN_HOOK_DEBUG=1`（走 stderr）。
- **CLI 侧改完不会立刻生效**：启动时快照 hooks，外部改动要在 `/hooks` 面板过一遍；插件侧重开会话即可。

顶部连接条显示当前**工程名**：`<workspace>/package.json` 的 `name`（去 scope）→ 目录名；拿不到就是空串，不编造。

### Codex CLI 接入（hook）

Codex CLI（0.151+）自带 hook 子系统（`hooks` 是默认开启的 stable feature），协议与 Claude Code / CodeBuddy
同源，所以共用同一个 `packages/reporter/src/hook.js`，只是事件名与工具名不同，靠 `--agent codex` 分流：

```bash
npm run hooks:install                      # 一并写 ~/.codex/hooks.json
npm run hooks:install -- --targets=codex   # 只装 Codex
```

装出来的条目（`<codex home>/hooks.json`，默认 `~/.codex/hooks.json`）：

```json
{ "hooks": { "PreToolUse": [ { "matcher": "", "hooks": [
  { "type": "command", "command": "node \"/abs/hook.js\" --agent codex", "timeout": 10 } ] } ] } }
```

与 CodeBuddy 的两点差别：

- **需要「信任」**：Codex 的 hook 默认要人工批准一次（TUI 里 `/hooks`）；自动化场合可以临时加
  `--dangerously-bypass-hook-trust`。**未信任的 hook 不会执行**（会静默跳过，不报错）。
- **事件与工具名不同**，映射如下：

| Codex 事件 | 上报 | 备注 |
| --- | --- | --- |
| `SessionStart` / `SessionEnd` | 注册 + `idle` / `offline` + 撤心跳守护 | 同 CodeBuddy |
| `UserPromptSubmit` | `task/start` + `thinking` | 同 |
| `PreToolUse` / `PostToolUse` | `busy` / 回到 `thinking`；写类工具 → `file/touch` | 工具名是 `Bash` / `apply_patch` / `collaboration*` |
| `PermissionRequest` | `blocked(awaiting_permission)` | CodeBuddy 没有这个事件（那边靠 `Notification`） |
| `SubagentStart` | 飘出一只幽灵（名字取 `spawn_agent` 的 `task_name`） | CodeBuddy 没有，那边靠 `PreToolUse(Task)` 推断 |
| `SubagentStop` | 幽灵转「待汇报」，汇报文案取 `last_assistant_message` | 比 CodeBuddy 的「已完成：任务名」更实 |
| `Interrupt` | 收掉孤儿幽灵（打断时结束事件会丢） | CodeBuddy 没有 |
| `Stop` | `task/end(done)` + `idle`，顺手扫掉本轮残留的幽灵 | 同 |

CLI 楼层的主控制台**也用 hook 上报的真实相位**（思考中 / 调用工具 + 真实命令 / 等待授权 / 待命）——
以前只有插件那一路的会话能拿到实时相位，1F/2F/3F/4F 只能"按会话 jsonl 的文件时间猜"，
表现就是 3F 一直卡在「调用工具 · 改 rollout-xxxx.jsonl」且内容不变。现在只要该工程接过 hook
（`/api/v1/reporter-phase` 的 `instrumented`）就以 hook 为准，没有动作时显示「待命」。

Codex 的 `apply_patch` **没有 `file_path`**（`tool_input` 是 patch 文本），hook 会从
`*** Update File:` / `*** Add File:` / `*** Delete File:` 里解析路径，所以「正在读写」照常显示。
坐工位的小怪物名册除 `.codebuddy/agents/` 外，也会扫 `<工程>/.codex/agents/` 与 `$CODEX_HOME/agents/`。

**成员是按楼层过滤的**：每个成员都带一个「来源客户端」（`members.client`），办公室与工位卡片只显示
当前楼层那一路的成员 —— 1F 看 CodeBuddy、2F 看 WorkBuddy、3F 看 Codex、4F 看 Claude、5F 看 TraeCode、6F 看 Qoder、7F 看 Kilo Code、8F 看 OpenCode。
所以切到 3F 不会再看见你在 CodeBuddy 里建的小怪物。`client` 为空的是「通用」成员（演示数据、
手工 `scripts/subagents.js` 写的幽灵），哪层都显示。

注意**小怪物（subagent 名册）不受会话影响**：它是静态的（`client` 比对的又是去掉 `-plugin` 的
基础名），同一层的两条会话看到的是同一批常驻小怪物。会话只决定**主 agent 状态、幽灵实例、
任务台账与对话**这三样 —— 它们是"某一条会话干的活"，天然该分。

Codex 与 CodeBuddy 在同一个工程下**共用** `<工程>/.workgremlin/subagents.json`，所以每条清单记录
都会带 `client`，收工与扫场只动自己那一路 —— 否则两边的 Stop/Interrupt 会把对方的幽灵一起收掉。

### Claude Code CLI 接入（hook）

Claude Code 的 hook 与 CodeBuddy **同源**（`settings.json` + `hooks` 事件 + `matcher`），
所以共用同一个 `packages/reporter/src/hook.js`，靠 `--agent claude` 分流。
装出来的条目写在 `~/.claude/settings.json`（可用 `CLAUDE_CONFIG_DIR` 改家目录）：

```bash
npm run hooks:install                      # 一并写 ~/.claude/settings.json
npm run hooks:install -- --targets=claude  # 只装 Claude Code
```

与 CodeBuddy 的差别（按 2.1 实测）：

- **生效时机**（实测）：写完配置后新起的会话**直接就执行了**，没经过任何批准（`claude --print` 实测）。
  二进制里存在 `hook execution - workspace trust not accepted` 与「启动时对 hooks 做快照」的文案，
  但在本机这套配置下都没拦住；若你的环境里表现为「装了没反应」，先在 `/hooks` 面板过一遍。
- **`PostToolUse` 对所有工具都发**（含 `Read`/`Grep`/`Bash`），所以不需要 CodeBuddy 那种 matcher 白名单。
- **子代理工具叫 `Agent`**（不是 CodeBuddy 的 `Task`），且带真 `tool_use_id`。hook 故意**不注册
  `SubagentStart`**：`PreToolUse(Agent)` 已经能登记幽灵，再注册一次会让同一只子代理飘出两只。
- **`notification_type` 不止"要权限"一种**：除 `permission_prompt` / `idle_prompt` 外还有
  `auth_success` / `elicitation_dialog`。只有 `permission_prompt` 才算等授权，其余不认、不动状态
  （CodeBuddy 那边非 idle 只有"要权限"一种，所以它的 `else` 可以直接当"等授权"）。
- **等授权走显式事件**：和 Codex 一样注册 `PermissionRequest`，不再用"`PreToolUse` 打 pending、
  超时未清即猜"那套兜底推断。
- transcript 与 Codex 一样是 JSONL（`~/.claude/projects/<cwd 斜杠换横线>/<session_id>.jsonl`），
  所以「产出摘要 / 每次回复入库」直接复用同一条解析路径。

| Claude Code 事件 | 上报 | 备注 |
| --- | --- | --- |
| `SessionStart` / `SessionEnd` | 注册 + `idle` / `offline` + 撤心跳守护 | 同 CodeBuddy |
| `UserPromptSubmit` | `task/start` + `thinking` | 同 |
| `PreToolUse` / `PostToolUse` | `busy` / 回到 `thinking`；写类工具 → `file/touch` | 工具名同 CodeBuddy，但子代理是 `Agent` |
| `PermissionRequest` | `blocked(awaiting_permission)` | 显式事件，比 CodeBuddy 的 `Notification` 推断准 |
| `Notification` | 等权限 → `blocked`；空闲提醒 → `idle`；其余类型忽略 | 见上「`notification_type` 不止一种」 |
| `SubagentStop` | 幽灵转「待汇报」 | 与 `PostToolUse(Agent)` 互为兜底 |
| `Stop` | `task/end(done)` + `idle`，顺手扫掉本轮残留的幽灵 | 汇报文案取 `last_assistant_message` |

### Qoder 接入（CLI 与插件：hook + transcript）

Qoder 的 hook 与 Claude / CodeBuddy **同源**（`settings.json` + `hooks` 事件 + `matcher`），
所以共用同一个 `packages/reporter/src/hook.js`，靠 `--agent qoder` 分流。
装出来的条目写在 `~/.qoder/settings.json`：

```bash
npm run hooks:install                      # 一并写 ~/.qoder/settings.json
npm run hooks:install -- --targets=qoder  # 只装 Qoder
```

- **CLI 与插件合并（不拆层）**：Qoder 的 CLI 与插件（如 `qoder-context`）共用同一份 `~/.qoder` 配置、
  同一套 hook（`enabledPlugins` 里启用，hook 写在 `~/.qoder/settings.json`，CLI 与插件同吃）、
  同一个落盘目录（`~/.qoder/projects/<工程>/<会话>.jsonl`），分不出，所以 6F 只有一层。
- **会话两路来源**：① 落盘 transcript（`~/.qoder/projects/...`）走 `cli` 来源扫描，文件名即 `session_id`、
  工程路径从每行 `cwd` 解析（Claude Code 同款格式）；② reporter 状态文件兜底（JSONL 还没写/读不出时，
  hook 那一路照常列会话并提供实时相位）。两路按 `session_id` 去重（cli 有活会话就撤掉 hook 行）。
- **事件表暂用最宽覆盖**：Qoder 的真实 hook 事件名尚未确认，`scripts/install-hooks.js` 的
  `QODER_EVENTS` 默认采用 Claude 风格（`PreToolUse` / `PostToolUse` 对所有工具都发，且带
  `PermissionRequest` / `Notification` / `SubagentStop`）。若 Qoder 实际事件名不同，只需把
  `QODER_EVENTS` 换成 `EVENTS` / `CODEX_EVENTS` 或自定义——不涉及 `hook.js` 逻辑。
- **相位只有粗粒度**：Qoder 实测**只发 `SessionStart` / `SessionEnd`**，没有 `UserPromptSubmit` /
  `PreToolUse` / `PostToolUse` 等细粒度事件（见 `~/.workgremlin/hooks/events.log` 与
  `scripts/install-hooks.js` 的 `QODER_EVENTS` 注释）。所以 `hook.js` 对 `--agent qoder` 在这两个事件上
  补「思考中 / 已完成」粗粒度相位（`packages/reporter/src/hook.js`），6F 不会再一直显示「未上报」；
  相位精度比 Claude 粗——等 Qoder 开放细粒度事件后自动变细，无需改 hook 逻辑。

### Kilo Code 接入（7F：轮询打底 + 插件给真相位与台账）

**Kilo 没有 hook 子系统**（实测 7.8.1：`kilo --help` 里没有 hook 子命令，也没有任何
`hooks.json` 或可挂命令的事件点）。所以 7F 不进 `install-hooks.js` 的安装列表 ——
没有 hook 可装，也**不应该**在 Kilo 的配置里写任何东西。

7F 有**两路**，装的形态决定你拿到哪一路：

| | 轮询打底（永远在场） | 插件真相位 + 台账（装了才有） |
| --- | --- | --- |
| 装法 | 零配置 | 把 `packages/reporter/src/plugin/index.js` 放进 `.kilo/plugins/`，或 `~/.config/kilo/kilo.jsonc` 的 `plugins` |
| 上报身份 | — | `kilo-plugin`（VS Code 扩展）/ `kilo`（CLI / TUI） |
| 相位 | 从 event 流**推导**，`inferred:true` 灰显 | 事件流**真值**，不灰显，且能给「等待授权」 |
| 任务台账 | ❌ 不记 | ✅ 记（成员 / 任务 / 对话记录 / 文件活动 / 幽灵） |

**轮询那一路**（全部逻辑在 `server/src/kilo.js`）：

- **落盘是 event-sourced SQLite**（`~/.local/share/kilo/kilo.db`，WAL 模式）。我们**只读**打开，
  不阻塞 Kilo 自己的 daemon。数据根按 XDG 位置认（`kiloHome()`）——
  **不是** `~/.kilo`（那个目录实测只有安装期留下的 `bin/`）。
- **会话**来自 `session` 表（`id` / `directory`=工程路径 / `title` / `agent` / `model` /
  `time_updated` / `summary_*`）。已归档的（`time_archived`）不算"在跑"。
- **相位**由 `event` 表（append-only，`aggregate_id`=会话、`seq` 单调）的**最新事件推导**：
  `tool`+`running`→调用工具、`tool`+`pending`→等待授权、`reasoning`→思考中。
  比 5F TraeCode 那种"拿文件 mtime 猜"精确得多，但**仍是轮询**（不是 Kilo 主动报的），
  所以相位一律 `inferred:true`，UI 按推断灰显。
- **完成标记**取 `message` 表里 `role=assistant` 且 `finish=stop` 的那条
  （`tool-calls`/`length`/`content-filter` 都不算"完成"）。
- **只读一次、坏表不冒泡**：表结构对不上（Kilo 改版）时回空，楼层照常列出，只是没会话 ——
  绝不把每 1.5s 一次的 `/reporter-phase` 轮询打挂。

**CLI 为什么不记任务台账**：轮询是**只读**的，监控端伪造上报就违背"绝不编造"。所以
7F 的任务列表 / 对话记录**只有装了插件才有内容** —— 这是刻意的，不是没做完。

**装法**（Kilo 用的是 `"plugin": ["<绝对路径>"]` —— **字符串数组、单数键**；文件头注释里那套
`plugins: [{ package, options }]` 是 OpenCode 的形状，Kilo 会报 `Unrecognized key: plugins`，
`kilo plugin <module>` 也只收 npm 模块名、不收本地路径）：

```bash
npm run hooks:install -- --targets=kilo-plugin              # 写 ~/.config/kilo/kilo.jsonc
npm run hooks:install -- --targets=kilo-plugin --dry-run    # 先看一眼
npm run hooks:install -- --targets=kilo-plugin --uninstall  # 撤掉（备份在 kilo.jsonc.bak-workgremlin）
```

改完要**重开 Kilo 会话**才加载。

**事件契约以实测为准**（Kilo 7.8.1，探针跑出来的）：信封是 `{ id, type, properties }`，
事件只有 `session.created` / `session.updated` / `message.updated` / `message.part.updated` /
`session.status` / `session.idle` / `session.drained` / `session.diff` / `*.delta` 这几类。
**不是** `session.tool.called` / `session.execution.succeeded` 那一套 —— 按那套写会「装得上、
加载不报错、但一条记录都不来」。派生态：任务起于 `role=user` 的 text part、收于 assistant 的
`finish=stop`（`finish=tool-calls` 只是消息到工具处断了、整轮未完）、「等待授权」看 tool 的
`state.status==='pending'`、改动文件看 `session.diff`。

**插件那一路**（`packages/reporter/src/plugin/index.js`，8F OpenCode 共用同一份）除了相位，
还往台账上报：`register`（带 `role:agent`，否则 `task_runs` 不会写）、`task/start`、
`task/end`（带 result 与本轮改动文件）、`message`（收尾自述）、`file/touch`（只报**写类**工具），
以及 subagent 幽灵（`task` 工具召唤时写 `.workgremlin/subagents.json`，与 `hook.js` 共用
`ghostFeed.js` 那一份格式实现）。没有标题就不传 `result` —— 事件流里没有"最后一段
assistant 文本"这个信号，拿文件清单拼一句"完成了 N 个文件"属于**编造自述**，不做。

自检：`npm run test:kilo`（楼层/相位推导）、`npm run test:plugin-ingest`（台账上报，
打假服务端）、`npm run test:plugin-e2e`（**真起一个服务端**跑通整条链，沙箱 HOME，不碰你的库）、
`npm run test:ghost`（幽灵清单格式）。

### OpenCode 接入（8F：轮询打底 + 插件给真相位）

7F 的兄弟楼层，也是同源（**Kilo Code CLI 就是 OpenCode 的 fork**：落盘结构一模一样，
连 Kilo 的日志目录里都直接躺着一个 `opencode.log`）。但**两者的 V2 schema 已经分叉，
所以 8F 不能照抄 7F 的取法** —— 实测 2026-09-26（Kilo 7.8.1 / OpenCode 2.0.18）：

| | Kilo 7.8.1 | OpenCode 2.0.18 |
|---|---|---|
| `event`（落盘事件流） | 2288 行 | **0 行**（只在内存里推流） |
| 消息表 | `message` + `part` | `session_message`（无 `part` 表） |
| 会话表 | `session` | `session_v2` |

8F 因此改读 `session_v2` + `session_message` 的 `data.content[]`（part 形状与 Kilo 的
`event.data.part` 同构），全部逻辑在 `server/src/opencode.js`：

- **会话**来自 `session_v2`（`id` / `directory`=工程路径 / `title` / `agent` / `model`）。
  已归档的（`time_archived`）不算"在跑"；**子代理会话（`parent_id` 非空）不算独立会话**。
  表名与列名都探测着来（`session_v2` → `session`），OpenCode 改版换表不会把接口打挂。
- **相位**由最新消息的 `content[]` 推导：`tool`+`running`→调用工具（带工具名与实际命令）、
  `tool`+`error`→调用工具但报错、`reasoning`→思考中、`type='idle'` 行→待命。
  轮询这一路一律 `inferred:true`，UI 按推断灰显。
- **一个补不上的洞**：全库 114 条 assistant 消息实测 `tool.state.status` 只出现过
  `completed / error / running`，**没有 `pending`** —— 也就是说**轮询永远推不出「等待授权」**
  （Kilo 有 pending，OpenCode 没有）。OpenCode 把授权做成了独立事件
  （`permission.asked`），那个信号只在内存事件流里。
- **所以另挂一路插件**（`packages/reporter/src/plugin/`）：订阅 OpenCode/Kilo 的
  `ctx.event.subscribe()` 事件流，把相位/完成标记写成 reporter 状态文件
  （格式与 `hook.js` **完全一致**，服务端一行都不用改）。装上之后：
  相位是**上报真值**（不标 inferred、UI 不灰显）、多出「等待授权」、
  完成标记还带**改动文件清单**（`session.step.ended` 事件的 `data.files`）。
  没装插件就自动退回轮询推导，功能不受影响。
- **可执行文件位置**：`opencode` 实测在 `~/.opencode/bin/opencode` 且**不在 PATH**，
  `products.js` 的 `CLI_BIN_DIRS` 已显式认这一条 —— 否则这层永远判成"没装"。

**装插件（可选，零配置）**：本仓库已经带了一个自动加载的入口 ——
`.opencode/plugins/workgremlin.js`，它转发到 `packages/reporter/src/plugin/index.js`。
在**本工程**里跑 OpenCode 就自动生效（上面那些实测就是它跑出来的）。
想全机生效，在 `~/.config/opencode/opencode.json` 里加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/绝对路径/WorkGremlin/packages/reporter/src/plugin/index.js" }]
}
```

Kilo 同理（`.kilo/plugins/` 或 `~/.config/kilo/kilo.jsonc`），并用
`options: { client: 'kilo' }` 指定上报身份。

不需要任何安装动作，WorkGremlin 起来就看得见 8F（有没有插件都一样）。
自检：`npm run test:opencode`。

**同一个楼层可以同时开多条会话**（比如开两个终端，或者终端 + VS Code 插件各开一条）——
CLI 与插件是同一份 `~/.claude`、同一套 hook、连二进制都相同，所以它们本来就该是**一个楼层**；
层内靠 `session_id` 区分（轴 2，与"楼层/客户端"这条轴正交）：

- **`session_id` 从哪来、可不可信**：hook payload 的 `session_id` 字段、transcript 的文件名
  （`~/.claude/projects/<工程>/<session_id>.jsonl`）、transcript 首行的 `sessionId`、
  以及子代理目录 `<session_id>/subagents/agent-<agentId>.jsonl` 的父目录名，
  实测 2.1.281 下五处 100% 一致。子代理共享父会话的 `session_id`，另带自己的 `agentId`。
- **hook 侧**：状态文件按 `<agent>@<工程>@<会话>.json` 分（`~/.workgremlin/hooks/`），
  所以两条会话各写各的，不会互相清空"本轮改动文件"。老命名（不带会话）仍然认，向后兼容。
- **服务端**：`/api/v1/reporter-phase?client=<client>&session=<session_id>` 只取那一条会话的
  实时相位与完成标记；不传 `session` 就是老行为（同 client 里取最新的那条）。
- **落库**：`task_runs` / `messages` 都带 `session_id`，报表能分清"这轮改动是哪条会话干的"。
- 状态文件每个会话一份，所以 hook 在 `SessionStart` 时会顺手清掉 7 天前的旧状态文件，避免目录无限膨胀。

**CodeBuddy 的 CLI 与 Plugin 也合成一个楼层（1F CodeBuddy）**：CLI 那一路落 `~/.codebuddy`
（会话 `*.jsonl`；没有 jsonl 时用 reporter 状态文件兜底列出），Plugin 那一路落编辑器的 globalStorage
（`genie-history` / `todos` / `message-queue` / `file-changes`，唯一能拿到运行态的一路）。
两路都归 1F：同时开着 CLI 与 Plugin 时，表现是**这一层里的两条会话**，不是两个楼层；
实时相位与完成标记按会话各认各的（`/api/v1/reporter-phase?client=codebuddy,codebuddy-plugin&session=<id>`）。

**TraeCode 的 IDE 与插件同样合成一层（5F TraeCode）**，但这一层的会话**只能靠 hook 状态文件**：
IDE（`~/.trae-cn`）与插件（`~/.marscode`）两路落盘都**只作展示**（`kind:'dir'`，不产会话），
楼层胶囊的 tooltip 把两路目录与落盘统计都列出来、**不带说明**（免得把"这一路读不到"误看成"这一层没在跑"）：
`~/.trae-cn/memory/projects/<工程>/<日期>/session_memory_<会话>.jsonl` 与 `project_memory.md` 是笔记/记忆
（文件名带 session_id，但不是对话记录、也没有工程路径）；`~/.marscode`（插件运行时）实测只有 ai-chat 二进制、
日志，以及 `ai-agent/database.db`（**加密数据、不是可读的 sqlite**）与 `snapshot/<链 id>/v2/.git`
（逐轮改动的 git 文件快照）—— 所以**插件这一形态目前不支持会话记录**，这一路只为交代"这层是两形态产品"。
形态靠上报身份（client）就分得开：任务列表里分别显示 **TraeCode IDE** / **TraeCode Plugin**
（见 `renderer/src/lib/clientMatch.js` 的 `CLIENT_LABELS`，无需按楼层特判）。

想知道"某一层吃哪几路落盘"，看 `server/src/products.js` 的 `sources`（`kind:'plugin'` 那一路
读不出会话时，服务端在 `sources[].note` 里给一句说明；`kind:'dir'` 的展示路不带）；自检
`npm run test:floors`（1F/5F/6F）、`npm run test:kilo`（7F 轮询路线）与 `npm run test:opencode`（8F 轮询 + 插件双路）。

## 安全基线（不得关闭）

- 每个 DB 连接打开即 `PRAGMA secure_delete=ON`；`wal_autocheckpoint=512`；定时 `wal_checkpoint(PASSIVE)`，关闭/归档后 `TRUNCATE`；db/-wal/-shm 权限 `0600`。
- FTS5 固定 `tokenize='trigram'`（中文可用；unicode61 会把整段中文当一个 token）。
- **脱敏必须在入库与建 FTS 索引之前完成**；库内不应出现明文。发现明文落库 → P0 立即上报。

## 数据目录（落盘都在哪）

默认 `~/.workgremlin/`（`WORKGREMLIN_HOME` 可换目录，`WORKGREMLIN_DB` 可换库文件；E2E / demo 建议配合 `--user-data-dir=` 隔离）：

| 文件 | 内容 |
| --- | --- |
| `workgremlin.db`（+ `-wal` / `-shm`） | **全部业务数据**：projects / members / agent_status / tasks / messages / file_activity / artifacts，权限 0600 |
| `server.json` | 端口、token、pid、version，以及当前工程名与工程目录 |
| `workspaces.json` | 当前打开的工程 + 最近打开过的 8 个工程（重开自动恢复） |
| `<工程>/.workgremlin/subagents.json` | 该工程的 subagent 清单（幽灵的数据源，见下节） |

想直接看库里有什么（不需要装 sqlite3 客户端）：

```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/.workgremlin/workgremlin.db',{readonly:true});
console.log(db.prepare('select id,project_id,name,role,ephemeral,project_label from members').all());
console.log(db.prepare('select id,workspace_path from projects').all())"
```

## 打开工程

一个 workspace 一个工程：**打开哪个工程，屋里就显示哪个工程的成员和幽灵**。
演示数据是一条独立的**演示工程**记录，和真实工程并列（`__demo__`，显示名「演示工程」）。

**进 / 出演示只有一个入口：办公室右下角操作条上的「演示模式」按钮**（在「集合开会」左边）——
它等价于把工程切到演示工程，服务端会顺手备好演示数据（`__demo__` 里没有消息才播种）并起心跳推进器；
再点一次「退出演示」就回到进演示前打开的那个工程。演示期间主控制台会自动演一轮
（`stores/mainAgent.js` 的 SCRIPT），小怪物换成演示成员（6 位专家 + 2 个临时成员）。
**没有启动参数与环境变量了**（原 `--demo` / `--demo-seed` / `WORKGREMLIN_DEMO*` / `MOCK=1` 均已移除）。

点顶部连接条的工程徽标 → 「打开工程…」选目录（也可以点最近打开过的工程）。
选择会写进 `~/.workgremlin/workspaces.json`，重开自动恢复（包括"上次停在演示工程"）。

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:<port>/api/v1/workspace            # 当前工程
curl -H "Authorization: Bearer $TOKEN" -X POST -H 'Content-Type: application/json' \
     -d '{"path":"/abs/path/to/project"}' http://127.0.0.1:<port>/api/v1/workspace         # 打开工程
# path 为 "demo" 或空 -> 切到演示工程（不删真数据，只是把显示切到演示工程）
```

为什么要手工打开：磁盘上没有「当前在跑哪些 subagent」的运行态，服务端只能盯住**某个工程**下的
`.workgremlin/subagents.json`。工程不定，清单就无从谈起。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `WORKGREMLIN_HOME` | 数据目录（覆盖 `~/.workgremlin`） |
| `WORKGREMLIN_DB` | 数据库文件路径 |
| `WORKGREMLIN_PROJECT` | 覆盖上报归属的工程 id（缺省跟随服务端「当前打开的工程」，也是演示工程的 id 覆盖项） |
| `WORKGREMLIN_WORKSPACE` | 当前工程根目录（工程名与 subagent 清单都基于它；缺省 `process.cwd()`） |
| `WORKGREMLIN_SUBAGENTS_FILE` | subagent 清单文件路径（覆盖 `<workspace>/.workgremlin/subagents.json`） |
| `WORKGREMLIN_DEV=1` | Electron 加载 Vite dev server 并开 DevTools |
| `WORKGREMLIN_SKIP_REBUILD=1` | 跳过 electron-rebuild（**仅供无法构建时使用，需上报**） |
| `WORKGREMLIN_NO_AUTO_HOOKS=1` | 启动时不自动写各 CLI 的 hook 配置（要用 `npm run hooks:install` 手动装） |

## 打包（M3）

- macOS 采用 **ad-hoc 签名**（未公证）。按 main/leader 要求，必须在**四处**明示「未公证，首次启动需右键→打开 / 系统设置→隐私与安全性→仍要打开」：发布页、README（本节）、release notes、应用内「关于」页。
- 打包脚本不得硬编码架构（x64/arm64 必须来自 env `ARCH` 或 `--arch`）。
