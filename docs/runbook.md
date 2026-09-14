# Runbook（开发 / 验证 / 排障）

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
S=workgremlin
node packages/reporter/src/cli.js --team $S --member coder --state busy
node packages/reporter/src/cli.js --team $S --member coder --task "实现工位视图" --progress 0.4 \
  --file renderer/src/components/WorkstationCard.vue
node packages/reporter/src/cli.js --team $S --member coder --task-end done \
  --artifact "file:WorkstationCard.vue|renderer/src/components/WorkstationCard.vue"
node packages/reporter/src/cli.js --team $S --member coder --message --to leader \
  --type result --subject "产出已提交" --content "工位视图卡片完成"
```

上报后工位卡片应实时变化（状态/进度/文件/最近产出）。

## 数据库与安全

- 连接 PRAGMA：`secure_delete=ON`、`wal_autocheckpoint=512`、`synchronous=NORMAL`、`foreign_keys=ON`。
- 定时 `wal_checkpoint(PASSIVE)`（30s）；关闭与归档删除后 `wal_checkpoint(TRUNCATE)`。
- 归档/删除走 `repo.purgeTeam()`（内部已 delete → TRUNCATE 串联）。
- 若未来 `secure_delete` 影响 1000 事件/s 稳态写入：按 leader 裁决改为**双连接**（写入连接 `secure_delete=OFF`，删除/归档连接 `ON` + TRUNCATE），**禁止直接关掉安全项**。

## 搜索

- FTS5 固定 `tokenize='trigram'`。
- trigram 对 <3 字查询召回差：M2 需把 1~2 字查询降级为 `LIKE` 扫描并限定时间范围（当前 `listMessages` 已内置 LIKE 分支，切换点在此）。

## data-testid 约定（tester 选择器依赖，禁止随意改名）

`seat-card-<agentId>`、`seat-status-<agentId>`、`seat-degraded-<agentId>`、`seat-progress-<agentId>`、
`msg-row-<msgId>`、`conv-list`、`filter-agent`、`search-input`、`watcher-banner`、`archive-notice`。
