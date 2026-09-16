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

# 3) 开发启动（Vite + Electron）
npm run dev

# 4) 构建 renderer 静态资源（M0 的 build；M3 再接 electron-builder）
npm run build
```

只想跑本地服务（不开窗口）：

```bash
npm run server                                  # 同 npm run server -> node server/src/cli.js
node server/src/cli.js --demo --demo-seed 42    # 确定性演示数据
node server/src/cli.js --self-test              # 只验证原生模块
```

## 目录结构

```
shared/              类型与协议真源（零依赖，Node 与浏览器同构）
server/              本地服务：HTTP 上报 + WebSocket 推送 + SQLite（可内嵌 Electron，也可独立启动）
desktop/             Electron 主进程 / preload
renderer/            Vue 3 + Vite 渲染层
packages/reporter/   agent 侧上报 SDK + CLI（零依赖）
docs/                设计、协议、runbook
scripts/             dev / build / postinstall（electron-rebuild）
```

## 数据源：A + B 混合

- **B（主，唯一真值）**：agent / runner 通过 `@workgremlin/reporter` 主动上报心跳与任务状态。
- **A（兜底）**：`chokidar` 监听 `{workspace}/.codebuddy/teams/**`，只补 roster 与消息（M1 实现）。
- 无心跳 60s → 状态标记 `degraded=1`，UI 灰显 + 标注「推断」，**绝不编造进度/文件/耗时**。
- 未接上报的成员，进度与文件区域显示「未上报 / —」。

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

## CodeBuddy / WorkBuddy 接入（hook）

让正在干活的 agent 自己往屋里报状态：装一次，CodeBuddy 插件、CodeBuddy CLI、WorkBuddy CLI
三个入口的会话都会上报：

```bash
npm run hooks:install                      # 用户级：~/.codebuddy + ~/.workbuddy
npm run hooks:install -- --member coder    # 指定工位名（默认 codebuddy）
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

- **报给哪个 team**：默认报进屋里「当前打开的工程」（问服务端 `/api/v1/workspace`），
  `WORKGREMLIN_TEAM` 可覆盖；工位名默认 `codebuddy`（`WORKGREMLIN_MEMBER` 可覆盖）。
- **心跳**：60s 无心跳就 `degraded`（灰显 + 「推断」），所以 `SessionStart` 会另起一个 15s
  一次的心跳守护（`node packages/reporter/src/hook.js --heartbeat`），`SessionEnd` 收掉；
  会话异常退出时，最多 30 分钟没有事件就自己退，不留孤儿进程。
- **绝不阻塞 agent**：服务没起 / 上报失败 / stdin 不是 JSON，一律静默退出 0，
  且**一个字都不写 stdout**（hook 的 stdout 会被塞回上下文）。调试用 `WORKGREMLIN_HOOK_DEBUG=1`（走 stderr）。
- **CLI 侧改完不会立刻生效**：启动时快照 hooks，外部改动要在 `/hooks` 面板过一遍；插件侧重开会话即可。

顶部连接条显示当前**工程名**：`<workspace>/package.json` 的 `name`（去 scope）→ 目录名；拿不到就是空串，不编造。

## 安全基线（不得关闭）

- 每个 DB 连接打开即 `PRAGMA secure_delete=ON`；`wal_autocheckpoint=512`；定时 `wal_checkpoint(PASSIVE)`，关闭/归档后 `TRUNCATE`；db/-wal/-shm 权限 `0600`。
- FTS5 固定 `tokenize='trigram'`（中文可用；unicode61 会把整段中文当一个 token）。
- **脱敏必须在入库与建 FTS 索引之前完成**；库内不应出现明文。发现明文落库 → P0 立即上报。

## 数据目录（落盘都在哪）

默认 `~/.workgremlin/`（`WORKGREMLIN_HOME` 可换目录，`WORKGREMLIN_DB` 可换库文件；E2E / demo 建议配合 `--user-data-dir=` 隔离）：

| 文件 | 内容 |
| --- | --- |
| `workgremlin.db`（+ `-wal` / `-shm`） | **全部业务数据**：teams / members / agent_status / tasks / messages / file_activity / artifacts，权限 0600 |
| `server.json` | 端口、token、pid、version，以及当前工程名与工程目录 |
| `workspaces.json` | 当前打开的工程 + 最近打开过的 8 个工程（重开自动恢复） |
| `<工程>/.workgremlin/subagents.json` | 该工程的 subagent 清单（幽灵的数据源，见下节） |

想直接看库里有什么（不需要装 sqlite3 客户端）：

```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/.workgremlin/workgremlin.db',{readonly:true});
console.log(db.prepare('select id,team_id,name,role,ephemeral,project from members').all());
console.log(db.prepare('select id,workspace_path from teams').all())"
```

## 打开工程

一个 workspace 一个 team：**打开哪个工程，屋里就显示哪个工程的成员和幽灵**。
点顶部连接条的工程徽标 → 「打开工程…」选目录（也可以切回演示数据、或点最近打开过的工程）。
选择会写进 `~/.workgremlin/workspaces.json`，重开自动恢复。

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:<port>/api/v1/workspace            # 当前工程
curl -H "Authorization: Bearer $TOKEN" -X POST -H 'Content-Type: application/json' \
     -d '{"path":"/abs/path/to/project"}' http://127.0.0.1:<port>/api/v1/workspace         # 打开工程
# path 为 "demo" 或空 -> 切回演示数据（不删真数据，只是把显示切回演示 team）
```

为什么要手工打开：磁盘上没有「当前在跑哪些 subagent」的运行态，服务端只能盯住**某个工程**下的
`.workgremlin/subagents.json`。工程不定，清单就无从谈起。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `WORKGREMLIN_HOME` | 数据目录（覆盖 `~/.workgremlin`） |
| `WORKGREMLIN_DB` | 数据库文件路径 |
| `WORKGREMLIN_DEMO=1` / `MOCK=1` | 启用演示数据 |
| `WORKGREMLIN_DEMO_SEED=N` | 演示数据随机种子（同 seed 输出完全一致） |
| `WORKGREMLIN_NO_DEMO=1` | 禁止首次运行自动灌演示数据 |
| `WORKGREMLIN_WORKSPACE` | 当前工程根目录（工程名与 subagent 清单都基于它；缺省 `process.cwd()`） |
| `WORKGREMLIN_SUBAGENTS_FILE` | subagent 清单文件路径（覆盖 `<workspace>/.workgremlin/subagents.json`） |
| `WORKGREMLIN_DEV=1` | Electron 加载 Vite dev server 并开 DevTools |
| `WORKGREMLIN_SKIP_REBUILD=1` | 跳过 electron-rebuild（**仅供无法构建时使用，需上报**） |

## 打包（M3）

- macOS 采用 **ad-hoc 签名**（未公证）。按 main/leader 要求，必须在**四处**明示「未公证，首次启动需右键→打开 / 系统设置→隐私与安全性→仍要打开」：发布页、README（本节）、release notes、应用内「关于」页。
- 打包脚本不得硬编码架构（x64/arm64 必须来自 env `ARCH` 或 `--arch`）。
