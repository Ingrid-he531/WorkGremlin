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
- 界面从「工位视图 + 对话记录两个 Tab」扩展为 **楼层（1F~5F 受监控产品）+ 等距 Canvas 办公室 + 主 Agent 控制台**；
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
| 1F | CodeBuddy CLI | `~/.codebuddy` 下 `*.jsonl` |
| 2F | WorkBuddy CLI | `~/.workbuddy` 下 `*.jsonl` |
| 3F | CodeBuddy 插件 | 编辑器 globalStorage 的结构化目录（唯一能拿到运行态的一层） |
| 4F | Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl`（cwd 在首行 `payload.cwd`） |
| 5F | Claude Code CLI | `~/.claude/projects/<工程目录>/*.jsonl` |

选中的会话决定主 Agent 控制台的相位（幽灵状态跟着走），办公室布局不受影响；切到没有活跃会话的楼层时整屋清空。

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
| 等授权（blocked·awaiting_permission） | 🟡 仅离线验证 | 本机 `permission_mode=bypassPermissions`，从不弹权限框；Codex 走显式 `PermissionRequest`（不再用 CodeBuddy 的 pending 推断） |
| 坐工位小怪物名册（Codex 侧 agent 定义） | 🟡 未实证 | 按 `$CODEX_HOME/agents`、`<工程>/.codex/agents` 的 `.md`/`.toml` 扫；本机还没有这类文件 |
| 楼层 / 会话列表（4F） | ✅ 已有 | `products.js` 探测 codex 可执行文件；`sessions.js` 扫 `~/.codex/sessions/**/rollout-*.jsonl` 取首行 `cwd` |
| 按客户端隔离（4F 不显示 CodeBuddy 的成员与相位） | ✅ 实测 | `members.client` + `/api/v1/reporter-phase?client=` |
| PreCompact / PostCompact | ❌ 未处理 | 与 CodeBuddy 一致（没有对应的 UI 语义） |
| `Stop.last_assistant_message` | ❌ 未使用 | 完成摘要仍取"本轮改动过的文件" |
| `turn_id` / `agent_id` 归因 | ❌ 未使用 | 子代理自己的工具调用带 `agent_id`，本可把文件活动归到那只幽灵身上（现在仍算主成员） |
| 工具名归一 | ✅ 实测 | Codex 报的是 `Bash`（不是 shell）、`apply_patch`、`collaborationspawn_agent`（展示去掉前缀） |

## 9. 工作区内的已知杂物（非工程结构）

| 路径 | 现象 | 说明 |
| --- | --- | --- |
| `work/WorkGremlin/` | 一份未被 git 跟踪的嵌套副本（server / renderer / desktop / packages 的部分文件 + 一个 `.workgremlin/subagents.json`） | 疑似某次演示或运行留下的残骸，**不是工程结构的一部分**，可安全删除（删除前请自行确认） |
| `.workgremlin/workspaces.json` | 内容却是 hook 的相位状态（`lastTool` / `sessionPhase`），不是工程管理该写的 `{current, recent}` | 该目录本应只放 `subagents.json`；疑似历史误写产物 |
| 未提交改动 | 11 个文件（iso 引擎、主控制台相位、`sessionRegistry`、`products` 探测、`App.vue` 等），约 +600 行 | 最近一轮「办公室渲染 + 相位保真」修复，尚未提交 |
