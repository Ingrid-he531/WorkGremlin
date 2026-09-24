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
**CodeBuddy 插件 / CodeBuddy CLI / WorkBuddy CLI / Codex CLI / Claude Code CLI / TraeCode 插件** 六个入口的会话都会上报。

默认**全装**（遍历所有 target，装了才写、没装跳过）：

```bash
npm run hooks:install                      # 用户级：~/.codebuddy + ~/.workbuddy + ~/.codex + ~/.claude + ~/.trae
npm run hooks:install -- --targets=codex   # 只装某个 target（codebuddy / workbuddy / codex / claude / trae）
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
  `WORKGREMLIN_PROJECT` 可覆盖；主 agent 身份由安装目标决定（codebuddy / codex / workbuddy / trae），已写进命令的 `--agent`。
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
以前只有 3F 插件会话能拿到实时相位，1F/2F/4F/5F 只能"按会话 jsonl 的文件时间猜"，
表现就是 4F 一直卡在「调用工具 · 改 rollout-xxxx.jsonl」且内容不变。现在只要该工程接过 hook
（`/api/v1/reporter-phase` 的 `instrumented`）就以 hook 为准，没有动作时显示「待命」。

Codex 的 `apply_patch` **没有 `file_path`**（`tool_input` 是 patch 文本），hook 会从
`*** Update File:` / `*** Add File:` / `*** Delete File:` 里解析路径，所以「正在读写」照常显示。
坐工位的小怪物名册除 `.codebuddy/agents/` 外，也会扫 `<工程>/.codex/agents/` 与 `$CODEX_HOME/agents/`。

**成员是按楼层过滤的**：每个成员都带一个「来源客户端」（`members.client`），办公室与工位卡片只显示
当前楼层那一路的成员 —— 1F/3F 看 CodeBuddy、2F 看 WorkBuddy、4F 看 Codex、5F 看 Claude。
所以切到 4F 不会再看见你在 CodeBuddy 里建的小怪物。`client` 为空的是「通用」成员（演示数据、
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
