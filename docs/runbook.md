# Runbook（开发 / 验证 / 排障）

> **[2026-09-20 更新]** V1（`better-sqlite3` + `@electron/rebuild`）已跑通，`npm run db:check` 可直接复验；命令与参数以本文件为准。文档与实现的差异汇总见 `docs/implementation-status.md`。

## V1：原生模块验证（M0 最高风险项，必须通过）

按顺序执行，任何一步失败都要贴完整输出上报，不要静默降级。

```bash
# 1) 环境自检
node -v; npm -v; python3 --version; which make g++; npm config get registry

# 2) 安装依赖（根目录 npm install 会自动触发 postinstall -> electron-rebuild）
npm install

# 3) 单独重跑重建
npm run rebuild:native

# 4) 纯 Node 下建表 + 写入 + 读回 + checkpoint
npm run db:check
# 期望输出：{"ok":true, ..., "read":{"content":"world"}, "secure_delete":1, "journal_mode":"wal"}

# 5) Electron 主进程内 require（关键：不是 Node 里可用就算过）
WORKGREMLIN_DEV=1 npx electron desktop/src/main.js --demo
```

排障要点：

- `gyp ERR! stack Error: not found: make/python` → 缺构建工具链，先装。
- `prebuild-install warn install ... EACCES/ETIMEDOUT` → 网络/代理问题，可 `npm_config_build_from_source=true npm rebuild better-sqlite3`。
- Electron 启动报 `NODE_MODULE_VERSION` 不匹配 → `@electron/rebuild` 没生效，确认 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 的 mtime 与 electron 版本一致。
- 失败禁止静默降级到 `node:sqlite` / `sql.js` / 纯内存，必须走审批。

## 日常开发

```bash
npm run dev          # Vite(5173) + Electron
npm run server       # 只起本地服务（headless）
npm run build        # 构建 renderer 到 renderer/dist
```

## 手动上报示例（reporter CLI）

```bash
S=workgremlin   # 工程 id；参数名是 --project（代码里已无 team 概念）
node packages/reporter/src/cli.js --project $S --member coder --state busy
node packages/reporter/src/cli.js --project $S --member coder --task "实现工位视图" --progress 0.4 \
  --file renderer/src/components/WorkstationCard.vue
node packages/reporter/src/cli.js --project $S --member coder --task-end done \
  --artifact "file:WorkstationCard.vue|renderer/src/components/WorkstationCard.vue"
node packages/reporter/src/cli.js --project $S --member coder --message --to leader \
  --type result --subject "产出已提交" --content "工位视图卡片完成"
```

上报后工位卡片应实时变化（状态/进度/文件/最近产出）。

> 不传 `--project` 时，reporter 会跟随服务端「当前打开的工程」（`GET /api/v1/workspace`）；`WORKGREMLIN_PROJECT` 也可覆盖。

## 数据库与安全

- 连接 PRAGMA：`secure_delete=ON`、`wal_autocheckpoint=512`、`synchronous=NORMAL`、`foreign_keys=ON`。
- 定时 `wal_checkpoint(PASSIVE)`（30s）；关闭与归档删除后 `wal_checkpoint(TRUNCATE)`。
- 归档/删除走 `repo.purgeProject()`（内部 delete → TRUNCATE 串联；函数名是 Project，不是 Team）。
- 若未来 `secure_delete` 影响 1000 事件/s 稳态写入：按 leader 裁决改为**双连接**（写入连接 `secure_delete=OFF`，删除/归档连接 `ON` + TRUNCATE），**禁止直接关掉安全项**。

## 搜索

- FTS5 固定 `tokenize='trigram'`。
- trigram 对 <3 字查询召回差：M2 需把 1~2 字查询降级为 `LIKE` 扫描并限定时间范围。
- ⚠️ **实现在用的就是 `LIKE`**：`server/src/db/index.js` 的 `listMessages` 只走 `LIKE %kw%`；`messages_fts` 虚表与触发器已建，但查询尚未接入 —— 切换点在该函数。

## data-testid 约定（tester 选择器依赖，禁止随意改名）

`seat-card-<agentId>`、`seat-status-<agentId>`、`seat-degraded-<agentId>`、`seat-progress-<agentId>`、
`msg-row-<msgId>`、`conv-list`、`filter-agent`、`search-input`、`watcher-banner`、`archive-notice`。
