# WorkGremlin 技术设计方案（v0.1，待评审）

> 目标产品：可视化桌面程序，用于**可视化管理 / 监控多 agent 协作团队**（leader / researcher / coder / tester）。
> 两个核心界面：① **工位视图**（每成员一张工位卡片，实时状态/任务/进度/读写文件/最近产出/已耗时，自动刷新）；② **对话记录窗口**（全量消息流，按成员/时间过滤、关键字搜索、自动跟随滚动）。
>
> 本文只做方案与取舍说明，**未经批准不写业务代码**。

---

## 0. 现状调研（已确认的事实）

当前 agent 团队运行数据落盘位置（实测）：

```
{workspace}/.codebuddy/teams/{mainConversationId}/{team_name}/
├── config.json      # 团队配置 + 成员名单
│   {
│     "name": "workgremlin",
│     "mainConversationId": "848af9d6...",
│     "workspacePath": "/home/yinghui/work/...",
│     "createdAt": "2026-09-14T07:14:45.923Z",
│     "members": [
│       { "memberId": "leader@workgremlin", "name": "leader",
│         "role": "组建 WorkGremlin 团队 leader",
│         "sessionId": "5ceff238..." }
│     ]
│   }
├── leader.json      # 该成员的 mailbox（收件箱），当前为 `[]`
├── researcher.json
├── coder.json
├── team-lead.json
└── tester.json
```

**关键结论（决定了路线选择）：**

| 事实 | 影响 |
| --- | --- |
| 落盘数据**只有 roster + 收件箱消息**，**没有任何状态字段** | 纯监听（路线 A）**永远拿不到**真正的 `busy/blocked`、进度、正在读写的文件、耗时 |
| 目录路径含 `mainConversationId` 哈希，且是**私有未文档化格式** | A 路线必须做多根目录扫描 + 容错解析，格式一变就失效 |
| 成员 json 是**数组**（收件箱，只增不改） | 可用「长度增长 + 内容 diff」做增量解析；mtime 可做粗粒度活跃度 |
| 同一 workspace 可能同时存在多个 team | 数据模型必须 `team_id` 维度隔离 |
| 我们**能控制 agent 的启动方式**（runner / hook） | 路线 B（主动上报）在本团队场景下**可行** |

---

## 1. 数据源路线评估：A vs B

### A) 目录监听 + 解析（chokidar）

- 做法：`chokidar.watch('**/.codebuddy/teams/**/*.json')`，解析 `config.json` 得到 roster，解析 `{member}.json` 数组 diff 得到新消息；用「收件箱增长速率 + mtime」推断状态。
- 优点：零侵入，agent 完全无感知；对**已经存在的第三方/外部团队**也能看见消息流；实现快（M1 当天可出）。
- 缺点：
  1. **状态只能猜**（idle/active 二值），无法得到 busy/blocked、进度、当前文件、耗时 —— 而这三个恰恰是「工位视图」的核心卖点；
  2. 依赖私有目录格式与哈希路径，版本升级即碎；
  3. 只能看到**收件箱**（别人发给我的），**看不到我发出的**消息，消息流天然残缺；
  4. 大 JSON 全量重写时 diff 抖动，需去重与游标；
  5. 无法获知 agent 崩溃/退出（只能靠超时兜底，误判率高）。

### B) 主动上报 + 推送（HTTP 上报 → SQLite → WebSocket）

- 做法：提供零依赖 SDK `packages/reporter`（Node，仅用 `fetch`），agent runner / hook 在关键节点调用：
  `register` → `heartbeat` → `task.start/progress/end` → `message` → `file.touch`。
  本地服务落 SQLite，`ws` 推给渲染层。
- 优点：字段完备（状态、进度、文件、耗时、产出），语义准确；可扩展（以后加 token 消耗、成本、工具调用、artifact 都只是加字段）；对状态做**真值源**，UI 直接绑定；崩溃可用心跳超时判定。
- 缺点：需要 agent 侧配合（hook / runner 改造成本）；若某个 agent 没接上报，就完全看不到（需要 A 兜底）；引入本地端口与生命周期管理。

### 结论：**推荐 A + B 混合，以 B 为主、A 为兜底与补充**

```
                 ┌──────────────── B：主动上报（主）──────────────┐
 agent runner ──▶│ POST /api/v1/*  ──▶ Ingest ──▶ SQLite ──▶ WS Hub│──▶ Renderer
                 └────────────────────────────────────────────────┘
                 ┌──────────────── A：目录监听（兜底）────────────┐
 .codebuddy/ ───▶│ chokidar ──▶ Parser ──▶ 同一 Ingest（source=A）│──▶ Renderer
                 └────────────────────────────────────────────────┘
```

**融合规则（写入同一张表，用 `source` 字段区分，靠 `dedupe_key` 去重）：**

1. **成员（roster）**：A 提供的名单作为「已发现成员」，B 的 `register` 覆盖/补全其 `role/session_id`；只被 A 发现的成员标记 `reported = false`，UI 上打「被动观测」角标。
2. **消息**：A 解析出的收件箱消息 `source='watch'`，`dedupe_key = sha1(memberId|ts|from|sha1(content))`；B 上报的消息 `source='report'`。同 key 只入库一次（B 优先）。
3. **状态**：**B 的状态是唯一真值**。成员若 60s 内无 B 心跳，则退化为 A 推断态，并置 `degraded=true`（UI 灰显 + 提示「状态为推断值」）。
4. **进度/文件/耗时**：仅 B 提供；A 模式下该卡片区域显示「—（未接入上报）」，**不编造数据**。

**风险与应对**

| 风险 | 应对 |
| --- | --- |
| `.codebuddy` 格式变更导致 A 失效 | A 完全隔离在 `server/src/watcher/`；解析失败只告警不崩溃，B 不受影响 |
| better-sqlite3 原生模块与 Electron ABI 不匹配 | 优先 `node:sqlite`（Electron ≥30 / Node ≥22）；否则 `better-sqlite3` + `electron-rebuild`；最坏退化 `sql.js`/JSON 落盘（接口不变） |
| 本地端口被占用 / 多实例 | 端口从 21800 起探测，成功后写 `~/.workgremlin/server.json`（含 port/token/pid）；启动前校验 pid 存活 |
| 本地服务被其他进程滥用 | 每次启动生成随机 `token`，上报与 WS 订阅均需携带；只监听 `127.0.0.1` |
| agent 未接上报 → 数据空洞 | A 兜底 + UI 明确区分「上报值 / 推断值」，避免误导 |
| mailbox 数组 diff 抖动 | 以「数组长度 + 元素内容 hash 前缀」做单调游标，只取新增尾部；异常回退则整表重算并重建 dedupe 集合 |

---

## 2. 技术选型

| 维度 | 选型 | 取舍说明 |
| --- | --- | --- |
| **桌面外壳** | **Electron 38 + Vue 3 + Vite 6 + TypeScript** | 选 Electron 而非 Tauri：① 本项目强依赖 Node 生态（`chokidar`、`ws`、SQLite 驱动、后续可能的 agent SDK 复用），Tauri 需 Rust 侧实现或 sidecar，成本翻倍；② 团队无 Rust 积累，出问题难定位；③ Tauri 需系统 WebView2/WebKitGTK，Linux 目标机兼容性差于自带 Chromium。代价：包体 ~80–120MB、内存占用高，对内部工具可接受。 |
| **语言** | TypeScript 全栈（shared 复用类型） | 协议即类型，前后端不会漂移 |
| **UI** | Vue 3 `<script setup>` + Pinia + **原生 CSS（CSS 变量主题）** | 不引入 UI 组件库，工位卡片是高度定制的信息密度型组件，组件库反而碍事；主题用 CSS 变量，M3 再补暗色 |
| **状态层** | **SQLite（主）+ 内存快照（渲染层）** | 消息/事件量大、要按成员+时间+关键字过滤并分页，SQL 明显优于内存数组；服务端内存只保留「每个成员最新状态」快照用于秒开首屏；落盘保证重启后历史不丢 |
| **实时通道** | **WebSocket（`ws`）**，HTTP 轮询为降级 | 需要双向（前端要发订阅变更/指令/回执），且单连接多路复用；SSE 仅单向，后续加「给 agent 下指令/注入任务」会返工。降级：WS 断线时 2s 轮询 `/api/v1/snapshot` |
| **文件监听** | `chokidar` 4 | 跨平台、支持 `awaitWriteFinish`，对 JSON 重写友好 |
| **消息列表** | 自研轻量虚拟滚动（定高估算 + 动态测量）或 `vue-virtual-scroller` | M0 先用「分页 + 上限 500 条窗口」；M2 再上虚拟滚动，避免过早优化 |
| **图表** | ECharts（**M3 可选**） | M0–M2 不需要；M3 用于「团队时间线甘特 / 吞吐趋势」 |
| **打包** | `electron-builder`（M3） | 产出 AppImage / deb / dmg |
| **测试** | Vitest（server 单测 + parser 快照）+ Playwright（M3 e2e） | parser 必须有用真实 `.codebuddy` 样本的快照测试 |

---

## 3. 目录结构（推荐方案）

**推荐：`npm workspaces` 轻量 monorepo + 单进程内嵌服务**（不是多进程微服务，也不是完全扁平的单应用）。

理由：`shared/` 的类型必须被前后端同时引用 → 需要 workspace；但**本地服务不单独起进程**，而是由 Electron 主进程 `require` 后同进程启动（免端口/子进程生命周期管理、零 IPC 序列化开销），同时保留 `server/src/cli.ts` 可独立 `node` 启动，用于 headless 模式与单测。

```
/home/yinghui/work/WorkGremlin/
├── package.json                  # npm workspaces: shared, server, desktop, renderer, packages/reporter
├── tsconfig.base.json
├── README.md
├── .gitignore
│
├── docs/
│   ├── tech-design.md            # 本文
│   ├── protocol.md               # 协议细节（M1 前补全）
│   └── runbook.md                # 开发/打包/排障
│
├── shared/                       # 纯类型与协议，零运行时依赖
│   └── src/
│       ├── types.ts              # Member, AgentStatus, Task, Message, Envelope
│       ├── protocol.ts           # HTTP 路径常量、WS 事件名、payload 校验函数
│       └── index.ts
│
├── server/                       # 本地 API + WS + 采集（可被 electron 内嵌或独立启动）
│   └── src/
│       ├── index.ts              # createServer({port, dbPath, watchRoots}) -> {app, wss, start, close}
│       ├── cli.ts                # 独立启动（headless / 调试）
│       ├── config.ts             # 端口探测、token、~/.workgremlin/server.json
│       ├── db/
│       │   ├── schema.sql
│       │   ├── migrate.ts
│       │   └── repo/{members,tasks,messages,status}.ts
│       ├── http/
│       │   ├── routes/{ingest,query,health}.ts
│       │   └── auth.ts           # 本地 token 校验
│       ├── ws/
│       │   ├── hub.ts            # 连接管理、订阅过滤、广播、背压
│       │   └── snapshot.ts       # 首屏快照构造
│       ├── ingest/
│       │   ├── normalizer.ts     # A/B 两条来源统一成内部事件（含 dedupe）
│       │   └── bus.ts            # 事件总线：落库 + 广播 + 更新内存快照
│       └── watcher/
│           ├── codebuddyWatcher.ts   # chokidar
│           └── parser.ts             # roster / mailbox 解析（容错 + 快照测试）
│
├── desktop/                      # Electron 主进程
│   └── src/
│       ├── main.ts               # app 生命周期：启动 createServer -> 建窗
│       ├── preload.ts            # contextBridge 暴露受限 API
│       ├── window.ts
│       └── menu.ts
│
├── renderer/                     # Vue 3 + Vite
│   ├── index.html
│   ├── vite.config.ts            # dev: 5173；build: dist/ 供 main 加载
│   └── src/
│       ├── main.ts  App.vue
│       ├── api/{ws.ts, http.ts, bridge.ts}   # 优先 preload bridge，降级直连 WS
│       ├── stores/{team.ts, messages.ts, connection.ts}
│       ├── views/{WorkstationView.vue, ConversationView.vue}
│       └── components/
│           ├── WorkstationCard.vue      # 工位卡片
│           ├── StatusBadge.vue  ProgressBar.vue
│           ├── FileActivityList.vue  ArtifactList.vue
│           ├── MessageList.vue  MessageRow.vue
│           ├── MessageFilters.vue  SearchBox.vue
│           └── ConnectionBar.vue
│
├── packages/reporter/            # agent 侧上报 SDK（零依赖）+ CLI
│   └── src/{index.ts, cli.ts}    # workgremlin-report heartbeat/task/...
│
├── fixtures/                     # 真实 .codebuddy 样本（脱敏），供 parser 单测
└── scripts/{dev.sh, build.sh}
```

**渲染层加载策略**：dev 下 `win.loadURL('http://localhost:5173')`；prod 下 `win.loadFile('renderer/dist/index.html')`。服务地址通过 preload 注入，渲染层不硬编码端口。

---

## 4. 数据模型（SQLite）

约定：所有时间存 **UTC 毫秒 INTEGER**（`ts_ms`），展示层转本地；枚举用 TEXT + CHECK；JSON 字段存 TEXT。

### 4.1 `teams`
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | `{workspaceHash}:{teamName}` |
| name | TEXT NOT NULL | workgremlin |
| workspace_path | TEXT NOT NULL | 监听根 |
| main_conversation_id | TEXT | .codebuddy 哈希目录名 |
| source | TEXT | `watch` / `report` |
| created_at | INTEGER | |

索引：`idx_teams_ws(workspace_path)`

### 4.2 `members`
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | `leader@workgremlin` |
| team_id | TEXT NOT NULL FK | |
| name | TEXT NOT NULL | leader / researcher / coder / tester |
| role | TEXT | 角色描述 |
| session_id | TEXT | 来自 config.json |
| reported | INTEGER DEFAULT 0 | 是否接了 B 上报 |
| created_at / last_seen_at | INTEGER | |

索引：`idx_members_team(team_id, name)`

### 4.3 `agent_status`（每个成员**一行最新快照**，UPSERT）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| member_id | TEXT PK FK | |
| state | TEXT NOT NULL | `online / busy / idle / blocked / offline` |
| state_since | INTEGER | 进入该状态的时刻（算「已耗时」） |
| task_id | TEXT NULL | 当前任务 |
| progress | REAL | 0–1，NULL 表示未知 |
| current_files | TEXT | JSON `["src/a.ts", ...]` |
| last_heartbeat_at | INTEGER | |
| degraded | INTEGER DEFAULT 0 | 1=由 A 路线推断 |
| source | TEXT | `report` / `watch` / `timeout` |
| updated_at | INTEGER | |

索引：`idx_status_team_state(state)`（便于「谁阻塞了」查询）

### 4.4 `agent_status_history`（状态变更流水，供时间线/耗时统计）
`id INTEGER PK AUTOINCREMENT, member_id, state, ts_ms, reason, source`
索引：`idx_status_hist_member_ts(member_id, ts_ms)`

### 4.5 `tasks`
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | `t_<ulid>` |
| team_id / member_id | TEXT NOT NULL | |
| parent_task_id | TEXT NULL | 支持 leader 拆解子任务 |
| title | TEXT NOT NULL | |
| state | TEXT | `pending / running / done / failed / cancelled` |
| progress | REAL | |
| started_at / ended_at | INTEGER | |
| source | TEXT | |

索引：`idx_tasks_member_state(member_id, state)`、`idx_tasks_team_started(team_id, started_at)`

### 4.6 `messages`（核心表）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK AUTOINCREMENT | 单调序号，用于游标与虚拟滚动 |
| dedupe_key | TEXT UNIQUE | A/B 去重 |
| team_id | TEXT NOT NULL | |
| ts_ms | INTEGER NOT NULL | 消息时间 |
| from_member | TEXT NOT NULL | 成员 id 或 `system`/`user` |
| to_member | TEXT | NULL=广播 |
| type | TEXT NOT NULL | `task_assign / task_update / result / question / block / shutdown / heartbeat / system` |
| subject | TEXT | 短标题（send_message 的 summary） |
| content | TEXT | 正文 |
| task_id | TEXT NULL | 关联任务 |
| source | TEXT | `report` / `watch` |
| raw_json | TEXT | 原始负载，便于回溯与格式迁移 |

索引：
- `idx_messages_team_ts(team_id, ts_ms DESC, id DESC)` —— 主查询路径（时间倒序分页）
- `idx_messages_from(team_id, from_member, ts_ms DESC)`
- `idx_messages_to(team_id, to_member, ts_ms DESC)`
- `idx_messages_type(team_id, type, ts_ms DESC)`
- `messages_fts` —— FTS5 虚表（`content, subject`），M2 用于关键字搜索；M0/M1 先用 `LIKE '%kw%'` 顶上

### 4.7 `file_activity`
`id PK, member_id, path, op('read'|'write'), ts_ms`
索引：`idx_files_member_ts(member_id, ts_ms DESC)`；写入时按 member 保留最近 N=200 条（滚动清理）

### 4.8 `artifacts`（「最近产出」）
`id PK, member_id, task_id, kind('file'|'doc'|'pr'|'text'), title, path, ts_ms`
索引：`idx_artifacts_member_ts(member_id, ts_ms DESC)`

### 4.9 `events`（通用审计/回放，M2 启用）
`id PK, team_id, ts_ms, kind, payload_json`

---

## 5. 协议定义（v1）

### 5.1 通用信封
所有 HTTP body 与 WS 帧统一：

```ts
// shared/src/protocol.ts
export const PROTOCOL_VERSION = 1;

export interface Envelope<T = unknown> {
  v: 1;              // 协议版本
  type: string;      // 事件/请求类型
  ts: number;        // 客户端产生时间（ms）
  seq?: number;      // 上报方单调序号，用于乱序检测
  team: string;      // team name，如 "workgremlin"
  actor: string;     // memberId 或 "runner"
  payload: T;
}
```

鉴权：`Authorization: Bearer <token>`（HTTP）；WS 首帧 `{type:'hello', token, team, filters}`。`token` 从 `~/.workgremlin/server.json` 读取。

### 5.2 Agent 上报接口（HTTP，全部 `POST /api/v1/...`，幂等）

| 路径 | payload | 语义 |
| --- | --- | --- |
| `/register` | `{memberId, name, role, sessionId?}` | 注册/更新成员，置 `reported=1` |
| `/heartbeat` | `{memberId, state?, progress?, taskId?, files?: string[], ts?}` | 心跳，建议 5s；同时作为「在线」与轻量状态更新。服务端 UPSERT `agent_status`，60s 未收到则按 `watch`/`timeout` 退化 |
| `/task/start` | `{memberId, taskId?, title, parentTaskId?}` | 建任务并置该成员 `busy` |
| `/task/progress` | `{memberId, taskId, progress, note?, files?}` | 0–1 |
| `/task/end` | `{memberId, taskId, state:'done'\|'failed'\|'cancelled', artifacts?: [{kind,title,path}]}` | 收尾 + 写 artifacts，成员回 `idle` |
| `/status` | `{memberId, state, reason?}` | 显式状态切换（如 `blocked` + 原因） |
| `/message` | `{from, to?, type, subject?, content, taskId?, ts?}` | 上报一条消息（补齐 A 路线缺失的「发件」侧） |
| `/file/touch` | `{memberId, path, op}` | 文件读写活动（可选，批量） |

统一响应：`{ok:true, id?}` / `{ok:false, error:{code,message}}`。
错误码：`400 bad_payload / 401 bad_token / 404 unknown_member / 409 duplicate / 500 internal`。

**reporter SDK（packages/reporter）** 形态（agent/runner 侧）：

```ts
import { createReporter } from '@workgremlin/reporter';
const rep = await createReporter({ team: 'workgremlin', member: 'coder' });
const task = rep.task('实现工位视图');      // 自动 start
await task.progress(0.4, { files: ['renderer/src/components/WorkstationCard.vue'] });
await task.end('done', { artifacts: [{ kind: 'file', title: 'WorkstationCard.vue', path: '...' }] });
rep.close();                              // 停止心跳
```

同时提供 CLI，便于 shell hook 调用（不改造 agent 也能用）：
`workgremlin-report --member coder --state busy --task "..." --progress 0.3`

### 5.3 前端订阅消息格式（WebSocket）

连接：`ws://127.0.0.1:<port>/ws?token=<token>`

**客户端 → 服务端**

```ts
{ type: 'hello',   token, team, filters?: { members?: string[]; types?: string[]; since?: number } }
{ type: 'subscribe', filters: { members?, types?, since?, until?, keyword? } }  // 变更订阅条件
{ type: 'ping',    ts }
{ type: 'backfill', beforeId?: number, limit?: number }   // 历史分页上拉
```

**服务端 → 客户端**

```ts
{ type: 'snapshot',  ts, payload: { team, members: MemberCard[], recentMessages: Message[], serverTime } }
{ type: 'member.status', ts, payload: { memberId, state, stateSince, taskId, progress, currentFiles, degraded, source } }
{ type: 'task.update',   ts, payload: { taskId, memberId, title, state, progress, startedAt, endedAt } }
{ type: 'message.new',   ts, payload: Message }                 // 增量，带自增 id 做游标
{ type: 'messages.page', ts, payload: { beforeId, items: Message[], hasMore } }
{ type: 'file.activity', ts, payload: { memberId, path, op, tsMs } }
{ type: 'artifact.new',  ts, payload: Artifact }
{ type: 'connection',    ts, payload: { state: 'open'|'closed'|'degraded', source: 'ws'|'poll' } }
{ type: 'error',         ts, payload: { code, message } }
```

`MemberCard`（工位视图直接绑定）：
```ts
interface MemberCard {
  memberId: string; name: string; role: string;
  state: 'online'|'busy'|'idle'|'blocked'|'offline';
  stateSince: number;                 // 算「已耗时」
  task?: { id: string; title: string; progress?: number; startedAt: number };
  currentFiles: string[];
  artifacts: Artifact[];              // 最近产出 top3
  lastSeenAt: number;
  degraded: boolean;                  // 状态为推断值
  reported: boolean;                  // 是否接了主动上报
  messageCount: number;               // 会话计数
}
```

**广播策略**：`member.status` 做 200ms 合并（同一成员只发最新）；`message.new` 立即发；WS 发送缓冲区 >1MB 时降级为「只发计数 + 客户端自行刷新」。

---

## 6. 里程碑

| 里程碑 | 目标 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| **M0** | 空壳跑起来，**两个界面静态渲染** | 工程骨架 + Electron 窗口 + 工位视图（4 张卡片，mock 数据）+ 对话记录窗口（mock 20 条，含过滤器与搜索框 UI）+ WS 连通（echo） | `npm run dev` 一键起；窗口出现两个 Tab；mock 数据可通过 WS 推送更新到 UI；`npm run build` 能产出可运行包（可不做安装包） |
| **M1** | **真实状态接入** | A 路线 watcher + parser；B 路线 ingest HTTP + reporter SDK；SQLite 落库；`snapshot` + `member.status` 推送；连接状态条 | 打开一个真实 `.codebuddy/teams` 工作区，roster 与消息真实入库；用 `reporter` CLI 模拟 agent，卡片状态/进度/文件实时变化；UI 区分「上报值/推断值」 |
| **M2** | **对话记录接入 + 过滤搜索** | 消息全量入库与增量推送；按成员/时间/类型过滤；关键字搜索（FTS5）；自动跟随滚动 + 上拉加载历史；消息详情与原文 JSON 查看 | 1 万条消息下滚动流畅；过滤/搜索响应 <200ms；新消息自动滚到底、用户手动上滚时暂停跟随并提示「N 条新消息」 |
| **M3** | **打包分发 + 增强** | electron-builder（AppImage/deb/dmg）；多工作区/多团队切换；ECharts 团队时间线与吞吐图；暗色主题；导出会话为 Markdown/JSON | 目标机一键安装并运行；可切换观察多个 workspace；时间线能还原一天的任务分布 |

（可选 M4：反向指令 —— 从 UI 给 agent 下任务/中断，依赖 runner 能力。）

---

## 7. M0 最小可运行骨架（文件级清单）

```
WorkGremlin/
├── package.json                      # workspaces + scripts(dev/build/typecheck)
├── tsconfig.base.json
├── .gitignore
├── README.md                         # 一键启动说明
├── docs/tech-design.md               # 本文
│
├── shared/
│   ├── package.json                  # name: @workgremlin/shared, type: module
│   └── src/index.ts                  # types.ts + protocol.ts（M0 只放 MemberCard/Message/Envelope）
│
├── server/
│   ├── package.json                  # 依赖：express, ws, chokidar, better-sqlite3|node:sqlite
│   └── src/
│       ├── index.ts                  # createServer()：express + ws + 静态兜底
│       ├── cli.ts                    # 独立启动：node server/src/cli.ts
│       ├── config.ts                 # 端口探测 + token + 写 ~/.workgremlin/server.json
│       ├── db/schema.sql             # 4.1–4.8 建表（M0 先建 members/messages/agent_status）
│       ├── db/index.ts               # 打开/迁移/关闭
│       ├── ws/hub.ts                 # 连接管理 + broadcast()
│       ├── http/routes/health.ts     # /api/v1/health
│       ├── http/routes/query.ts      # /api/v1/snapshot（M0 返回 mock 生成器）
│       └── mock/generator.ts         # 4 个成员的假状态 + 20 条假消息（M0 专用，M1 删除）
│
├── desktop/
│   ├── package.json                  # 依赖：electron, electron-builder
│   └── src/
│       ├── main.ts                   # 启动 createServer(内嵌) → createWindow → 关闭时 close server
│       ├── preload.ts                # contextBridge: getServerInfo / onEvent / send
│       └── window.ts                 # dev 走 5173，prod 走 renderer/dist
│
├── renderer/
│   ├── package.json                  # vue, pinia, vite, @vitejs/plugin-vue, TS
│   ├── vite.config.ts                # proxy /api→server, proxy /ws→ws
│   ├── index.html
│   └── src/
│       ├── main.ts                   # createApp + Pinia
│       ├── App.vue                   # 顶部 ConnectionBar + Tab(工位/对话)
│       ├── api/bridge.ts             # 优先 window.workgremlin，降级 http/ws
│       ├── api/ws.ts                 # 重连（指数退避）+ 断线降级轮询
│       ├── stores/team.ts            # members、subscribe(member.status)
│       ├── stores/messages.ts        # messages、filters、keyword、autoFollow
│       ├── views/WorkstationView.vue       # 卡片网格（M0 mock）
│       ├── views/ConversationView.vue      # 列表 + 过滤 + 搜索（M0 mock）
│       └── components/
│           ├── WorkstationCard.vue   # 状态徽标/任务/进度条/文件/产出/耗时
│           ├── StatusBadge.vue
│           ├── ProgressBar.vue
│           ├── MessageList.vue       # M0：简单 v-for + 上限 500；M2 换虚拟滚动
│           ├── MessageRow.vue
│           ├── MessageFilters.vue    # 成员多选 + 时间范围 + 类型（UI 先上）
│           ├── SearchBox.vue         # 输入防抖（UI 先上）
│           └── ConnectionBar.vue     # 连接状态 + 数据源(上报/推断)图例
│
├── packages/reporter/
│   ├── package.json                  # 零运行时依赖
│   └── src/index.ts                  # createReporter()（M0 只留接口骨架，M1 实现）
│
└── scripts/dev.sh                    # 并行起 vite + electron
```

**M0 依赖清单（锁定大版本）**：`electron@^38` `vue@^3.5` `vite@^6` `pinia@^2` `express@^5` `ws@^8` `chokidar@^4` `typescript@^5`；DB 二选一：`node:sqlite`（Electron ≥30 原生）或 `better-sqlite3@^11` + `electron-rebuild`。

**M0 不做**：真实 watcher、SQLite 写入、FTS、虚拟滚动、ECharts、打包成安装包、reporter 实现。

---

## 8. 待决问题（请 leader / main 拍板）

1. **A/B 混合是否批准？** 若不批准 B（不改造 agent），则「进度/当前文件/阻塞原因/已耗时」只能显示占位符，工位视图价值大幅下降 —— 请确认。
2. **Electron 是否可接受**（~100MB 包体）？若坚持 Tauri，M0 工期 +3～5 天（Rust 侧文件监听 + sidecar）。
3. **SQLite 驱动**：目标机 Electron 版本是否 ≥30？决定用 `node:sqlite` 还是 `better-sqlite3` + rebuild。
4. **观察范围**：只观察当前工作区，还是需要同时观察多个 workspace / 多个 team？（影响 M3 工作量与 `teams` 表设计，模型已预留）
5. **M0 交付节奏**：是否按上表一次性交付 M0 全部骨架（约 30 个文件）？
