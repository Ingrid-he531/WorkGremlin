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

## 安全基线（不得关闭）

- 每个 DB 连接打开即 `PRAGMA secure_delete=ON`；`wal_autocheckpoint=512`；定时 `wal_checkpoint(PASSIVE)`，关闭/归档后 `TRUNCATE`；db/-wal/-shm 权限 `0600`。
- FTS5 固定 `tokenize='trigram'`（中文可用；unicode61 会把整段中文当一个 token）。
- **脱敏必须在入库与建 FTS 索引之前完成**；库内不应出现明文。发现明文落库 → P0 立即上报。

## 数据目录

默认 `~/.workgremlin/`（`server.json` 存端口/token，`workgremlin.db` 为数据库）。
可用 `WORKGREMLIN_HOME` 覆盖；E2E / demo 建议配合 `--user-data-dir=` 隔离。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `WORKGREMLIN_HOME` | 数据目录（覆盖 `~/.workgremlin`） |
| `WORKGREMLIN_DB` | 数据库文件路径 |
| `WORKGREMLIN_DEMO=1` / `MOCK=1` | 启用演示数据 |
| `WORKGREMLIN_DEMO_SEED=N` | 演示数据随机种子（同 seed 输出完全一致） |
| `WORKGREMLIN_NO_DEMO=1` | 禁止首次运行自动灌演示数据 |
| `WORKGREMLIN_DEV=1` | Electron 加载 Vite dev server 并开 DevTools |
| `WORKGREMLIN_SKIP_REBUILD=1` | 跳过 electron-rebuild（**仅供无法构建时使用，需上报**） |

## 打包（M3）

- macOS 采用 **ad-hoc 签名**（未公证）。按 main/leader 要求，必须在**四处**明示「未公证，首次启动需右键→打开 / 系统设置→隐私与安全性→仍要打开」：发布页、README（本节）、release notes、应用内「关于」页。
- 打包脚本不得硬编码架构（x64/arm64 必须来自 env `ARCH` 或 `--arch`）。
