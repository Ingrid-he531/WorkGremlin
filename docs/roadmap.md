# WorkGremlin 整体排期与责任矩阵（v0.1）

- 维护人：leader
- 版本：v0.1（2026-09-14）
- 关联：`docs/requirements-outline.md`（需求）、`docs/tech-design.md`（coder 技术方案）、`docs/test-strategy.md`（tester 测试策略）

---

## 0. 里程碑编号对齐说明

coder 与 tester 的里程碑编号不一致，本文档以 **coder 的 M0~M3 为主编号**，tester 文档中的编号按下表映射，**后续沟通一律使用主编号**：

| 主编号（本文档） | coder `tech-design.md` | tester `test-strategy.md` | 目标 |
| --- | --- | --- | --- |
| **M0** | M0 | M0 | 骨架 + 可测性地基 + demo 模式 |
| **M1** | M1 | M1 | 真实状态接入，工位视图上线 |
| **M2** | M2 | M2 + **M3**（持久化与恢复） | 对话记录窗口 + 落盘与恢复 |
| **M3** | M3 | **M4**（桌面端打包与发布） | 打包分发与增强 |
| **M4** | 可选 M4（反向控制） | **M5**（目录监听生产化） | 反向控制（**已确定：仅派活 + 中断**）/ 监听生产化 |

---

## 1. M0 — 骨架、可测性地基、离线演示

**目标**：工程能一键跑起来，两个核心界面用 mock 数据静态渲染，所有高险技术项（原生模块构建）验证掉。

| 项 | 内容 |
| --- | --- |
| **责任人** | coder（主），tester（契约验收 + 冒烟），leader（排期与阻塞升级） |
| **依赖** | 无（起始里程碑） |
| **交付物** | 按 `tech-design.md` 第 7 节约 30 个文件清单交付：<br>1. npm workspaces monorepo 骨架：`shared/` `server/` `desktop/` `renderer/` `packages/reporter/` `scripts/dev.sh`<br>2. Electron 空壳能起窗口（dev 走 Vite 5173，prod 走 renderer/dist）<br>3. **工位视图** mock 静态渲染（4 张卡片，含状态徽标/任务/进度条/文件/产出/耗时）<br>4. **对话记录窗口** mock 静态渲染（20 条消息 + 过滤器 UI + 搜索框 UI）<br>5. `better-sqlite3` + `@electron/rebuild` 跑通（**M0 最高风险项，先跑通再写界面**）<br>6. `packages/reporter` CLI 可手动调用的上报示例<br>7. **离线演示模式 `--demo` / `MOCK=1`**（确定性假数据源，与 mock 渲染、E2E 数据源三合一）<br>8. 5 条可测性契约落地（见 §1.1）<br>9. WS 连通（echo）+ 重连骨架<br>10. **建表预留以下字段/钩子（本期不实现逻辑）**：`file_activity.op`（read/write/edit）、`task.progress` + `progress_source`（reported/derived/unknown）、`notifications`（告警配置）、`redaction` 脱敏钩子（可替换的 `redact(content)` 中间件点）、`archived_at` 与索引<br>11. **双连接存储方案（安全与吞吐不二选一）**：**写入连接** `secure_delete=OFF` 承担 1000 事件/s 稳态；**删除/归档连接** `secure_delete=ON` 仅用于归档与手动删除。`secure_delete` 是**连接级** PRAGMA，不能按表开关，故必须双连接。WAL 显式设 `wal_autocheckpoint`，删除后执行 `wal_checkpoint(TRUNCATE)`；`.db`/`.db-wal`/`.db-shm` 权限 `0600`。**禁止为吞吐关闭 secure_delete**<br>12. **FTS5 建表直接用 `tokenize='trigram'`**（Q10 已定，避免后期重建索引迁移） |
| **明确不做** | 真实 watcher、SQLite 业务写入、FTS5 查询逻辑、虚拟滚动、ECharts、安装包、reporter 完整实现、归档逻辑、脱敏实现（只留钩子）、系统通知（只留配置项）、原文加密通道（M3） |

### 1.1 M0 必须落地的 6 条可测性契约（hard block）
> 编号对齐 `test-strategy.md` §7；tester v0.3 将 7.2 升为硬阻塞（demo 模式即 `FakeEventSource`），7.5 并入 7.1。

| # | 契约 | 说明 |
| --- | --- | --- |
| 7.1 | **时间源可注入**（Clock 接口 + FakeClock，含单调/墙钟分离） | 耗时/心跳/超时用例可确定性断言 |
| 7.2 | **EventSource + Fake 实现** | demo 模式即 `FakeEventSource` + fixture，M0 必需 |
| 7.4 | **确定性 ID**（`msgId` / `seq` / 唯一索引可注入） | 保证 E2E 可重复 |
| 7.6 | **core 与 Electron 解耦**（`packages/core` 纯实现，依赖注入 source/repository/clock）+ lint 强制 | L1/L2 无头运行、demo 可复用 |
| 7.7 | **`createTestApp()` 工厂** | 1 秒内跑通「注入事件 → 断言 store 状态」 |
| 7.9 | **稳定选择器 `data-testid`** | 命名约定：`seat-card-<agentId>`、`seat-status-<agentId>`、`seat-degraded-<agentId>`、`seat-progress-<agentId>`、`msg-row-<msgId>`、`conv-list`、`filter-agent`、`search-input`、`watcher-banner`、`archive-notice` |

> 7.15（`--user-data-dir=` / `WORKGREMLIN_HOME` 数据目录可覆盖）为 **M0 强建议**（E2E 隔离并行、demo 隔离）。

### 1.2 DoD（对齐 `test-strategy.md` v0.3 §6 M0）
- [ ] `npm run dev` 一键启动（至少 Linux 验证通过）。
- [ ] **6 条可测性契约全部落地**（7.1 / 7.2 / 7.4 / 7.6 / 7.7 / 7.9）。
- [ ] **demo 模式交付：`DEMO-01~07` 全通过**，并成为 L2 组件测试与 L4 E2E 的默认数据源（`--demo-seed=N` 确定性输出，覆盖 5 主状态 + ≥1 degraded + ≥200 条消息）。
- [ ] **原生模块验证 `N1`（Linux x64）5 条判据全过**：依赖装好、`@electron/rebuild` 成功、Node 侧 require 建表读写成功、**打包产物内 require 成功**、`asarUnpack` 正确 + `integrity_check ok`。`native:check` 进 CI L0 门禁。
- [ ] `check:arch-param` 静态检查通过（打包配置无硬编码架构，DS-14 前置）。
- [ ] `archived_at` 与 `content_truncated` 字段及索引存在（归档逻辑 M1 验）。
- [ ] IPC 通道有契约测试骨架 ≥1 条通过。
- [ ] 通用 DoD（tester 文档 §6 通用项）：L1 行覆盖 ≥80%、无 S1、测试可重复 5 次 flaky=0。

### 1.3 coder 开工后的验证节点（每完成一个即上报 main，附命令与结果）
| # | 节点 | 验证方式 |
| --- | --- | --- |
| V1 | 依赖装好 + **electron-rebuild 原生模块构建成功** | `npm i` 后 `npx @electron/rebuild` 成功；Node 侧 `require('better-sqlite3')` 建表插入查询成功 |
| V2 | Electron 窗口起来 | `npm run dev` 出现主窗口，两个 Tab 可见 |
| V3 | 两个界面 mock 渲染 | 截图/断言：4 张工位卡片 + 20 条对话记录渲染正确 |
| V4 | DB 读写成功 | 通过 server API 写入并读回一条消息 |
| V5 | demo 模式 | `npm run dev -- --demo` 或 `MOCK=1` 启动，数据与 mock 一致且确定 |
| V6 | WS 推送更新 UI | 手动推一条 `member.status`，卡片状态变化 |

> 任一节点阻塞（尤其 V1 electron-rebuild 失败）**立即上报 main，不得静默降级方案**。

---

## 2. M1 — 真实状态接入，工位视图上线

| 项 | 内容 |
| --- | --- |
| **责任人** | coder（主），tester（实时性/状态正确性专项），researcher（状态语义验收标准），leader（整合） |
| **依赖** | M0 完成；researcher《状态语义定义》定稿（阻塞 `busy/blocked` 判定规则） |
| **交付物** | 1. A 路线：`chokidar` watcher + parser（roster + mailbox 收件）<br>2. B 路线：HTTP ingest + `packages/reporter` SDK/CLI 实现<br>3. SQLite 落库（members / agent_status / tasks / messages / file_activity / artifacts）<br>4. `snapshot` + `member.status` WebSocket 推送<br>5. 5 主状态 + `degraded` 正交标志的 shared 类型与 DB schema 落地<br>6. 连接状态条：区分「上报值 / 推断值 / degraded」<br>7. 无心跳 60s → degraded 灰显<br>8. 消息归档保留策略落地（90 天 / 单 team 10 万条，超限先导出 JSONL 再删）<br>9. **消息脱敏启用**：入库前正则脱敏为 `***`，原文不入库（7 类规则，见需求 §P0-7），UI 标「本条已脱敏」<br>10. **进度三层降级**落地：上报 → 子任务推导（标「推导」）→ 条纹不确定进度条（禁止显示 0%/100%）<br>11. **文件读写区分**：`file_activity.op` 三值 + UI 图标/色条<br>12. **布局阈值**：≥5 人自动紧凑模式、>16 人按 team 分页/折叠、阈值可设置覆盖<br>13. **站内告警提示**（S1 级：阻塞 / 出错 / 离线 >60s）走连接条 + 卡片红点 |
| **DoD** | 引用 `test-strategy.md` §6 **M1 + M3**：<br>- 5 主状态 + degraded 全覆盖渲染；SC-01~SC-10 通过<br>- **RT-01 实时性 P95 ≤ 300ms**；RT-03/RT-04 通过；RT-05 高频抖动专项（附前后对比）<br>- 16 成员并发无串台（SC-10）；≥5 人紧凑模式、>16 分页正确<br>- **脱敏用例全通过：7 类规则命中且原文不落库；误伤率与漏判率有量化结果**
- **脱敏必须通过「绕过 UI」的三层断言**（**只验 UI 隐藏不算通过**）：
  a) **写入连接**路径下**不存在明文** —— 构造含密钥的消息，直查表 + grep `.db` + grep `.db-wal` 均不得命中；
  b) 走**删除连接**删掉该消息后再次 grep `.db` 与 `.db-wal`，freelist 与 WAL 中**不得残留可识别片段**；
  c) 压测期间（1000 事件/s）吞吐与延迟仍达标，证明**双连接方案生效**（安全与吞吐不互相牺牲）；
  d) **反向用例（必须有）**：故意关闭 `secure_delete` 跑一遍，确认 b) 的 grep 会**失败** —— 证明该断言真有检出能力，不是假阳性
- **虚拟列表 spike 必须在 M1 第一周完成**：`SPIKE-01~08` 全过（DOM ≤80、滚动均 ≥55fps/最低 ≥40fps、首次渲染 ≤500ms、内存增量 ≤200MB、尾部 100 条/秒追加仍 ≥50fps、10 万条搜索 ≤300ms、过滤切换 ≤200ms、1MB 大消息不卡死），**选型结论入库，早于对话窗口开发**
- **中文分词 spike（SPIKE-09~12）在 M1 末完成**：trigram 结论入库、中文语料搜索 <200ms、1~2 字降级 `LIKE` 行为正确（要求 coder 提供 **FTS tokenizer 可配置**（契约 7.19），否则无法做对照与后续迁移）
- **进度三态 `PRG-01~08` 全过**，其中 **`PRG-02`「不伪造 0%/100%」为硬阻塞**
- **通知 `NOT-*` 全过**，其中 **`NOT-02`（S2 事件不得弹通知，逐条负向断言）进 M1 硬阻塞**；`NOT-11`（静音/免打扰期间状态仍刷新）
- **脱敏 `SEC-01~07、SEC-12` + 三层验证为 M1 硬阻塞**；要求 coder 提供 `Redactor` 纯函数模块 + 规则集可注入 + **关闭开关**（契约见 tester 附录 C）<br>- **进度三层降级三种来源均正确渲染，无上报时不出现 0%/100%**<br>- DB-01~DB-10 通过，`kill -9` 恢复丢失窗口 ≤1s<br>- L4 冒烟：真实启动下状态实时刷新可见 |
| **风险** | ① reporter 埋点需 agent 端配合，若 agent 端不可改则进度/文件/耗时仍需占位符；② 高频状态抖动导致 UI 闪烁与性能问题；③ **脱敏正则误伤正常代码/日志**（需误伤率基线与可关闭开关） |

---

## 3. M2 — 对话记录窗口 + 持久化与恢复

| 项 | 内容 |
| --- | --- |
| **责任人** | coder（主），tester（消息完整性专项 + 10 万条压测），leader（整合） |
| **依赖** | M1 完成 |
| **交付物** | 1. 消息全量入库与增量推送（`dedupe_key` 幂等，不丢不重）<br>2. 过滤：成员多选 + 时间范围 + 消息类型<br>3. 关键字搜索（SQLite **FTS5 + `trigram` 分词器**；**1~2 字短查询自动降级 `LIKE`** 并限定时间范围控开销）<br>4. 虚拟滚动 + 上拉加载历史<br>5. 自动跟随滚动 + 手动上滚暂停 + 「N 条新消息」提示<br>6. 消息详情与原文 JSON 查看<br>7. `events` 表启用（审计/回放基础）<br>8. **M2 spike（里程碑启动时就做）**：trigram 中文召回实测 + 10 万条虚拟滚动压测，召回不足再评估 jieba 预分词 |
| **DoD** | 引用 `test-strategy.md` §6 **M2 + M3**：<br>- MS-01~MS-04、MS-06~MS-12 通过<br>- **MS-05：10 万条下 DOM 节点 ≤80、滚动 ≥55fps、内存增量 ≤200MB**<br>- 过滤/搜索组合行为与规格一致（边界语义已文档化）<br>- 1 万条下过滤/搜索响应 <200ms<br>- L4：真实收发 1000 条消息不丢不重<br>- DB-01~DB-10 通过；崩溃恢复有 L4 自动化用例；迁移脚本有向前兼容测试 |
| **风险** | 虚拟滚动与 FTS5 中文分词（需确认分词方案，可能退化为 LIKE 或 bigram） |

---

## 4. M3 — 打包分发与增强

| 项 | 内容 |
| --- | --- |
| **责任人** | coder（主），tester（三平台 matrix + 长稳），leader（整合） |
| **依赖** | M2 完成 |
| **交付物** | 1. `electron-builder`：Linux **AppImage/deb**、Windows **nsis**、macOS **dmg**（**仅 x64**，脚本参数化不硬编码架构）<br>2. 多 team 切换（单 workspace 内）<br>3. ECharts 团队时间线与吞吐图<br>4. 会话导出 Markdown / JSONL<br>5. 暗色主题<br>6. 轻量动作：标记已读、导出、复制原文<br>7. **系统通知与免打扰**：仅 S1 级触发；系统通知默认开、声音默认关；**免打扰默认关闭** + `22:00–08:00` 模板一键启用；同成员+同故障类型 5 分钟聚合 1 条；离线期间不重复、上线合并为「离线期间发生 N 次」；**失焦才弹系统通知，聚焦只走站内**<br>8. **脱敏原文查看通道（默认关闭）**：OS 钥匙串（keytar）保管数据密钥，口令派生（scrypt/argon2）降级；原文与正文**分表 + 独立加密**；**每次会话重新授权、不记住解锁状态**；查看记事件日志 |
| **DoD** | 引用 `test-strategy.md` §6 **M4**：<br>- DS-01~DS-13 通过；三平台 x64 matrix 绿<br>- 静默安装/升级/卸载自动化覆盖<br>- **macOS：Q11 书面豁免已接受** —— 降级为 **ad-hoc 签名**，发布页 / README / release notes / 应用内「关于」页**四处均明示**「未公证，首次启动需右键 → 打开 / 系统设置 → 隐私与安全性 → 仍要打开」，有书面豁免记录即可放行<br>- **8 小时长稳**：RSS 增长 <20%、无句柄泄漏、无崩溃<br>- 发布 checklist 签字完成 |
| **风险** | ~~macOS 公证需开发者账号~~ → **Q11 已书面豁免，不阻塞**；残余风险为用户首次启动摩擦，已由四处明示文案兜底 |

---

## 5. M4 — 反向控制（保守版）与目录监听生产化

> 已拍板：**做，但只做最保守一层**。

**反向控制范围（仅两项）**
1. 向指定成员**投递任务消息**（派活）；
2. **中断当前任务**（发中断信号）。

**明确不做**：代码级干预、断点/改 prompt、重试策略、直接操作用户文件。

**约束**：所有反向操作必须 **UI 二次确认** + **记入事件日志**（`events` 表）。M0~M3 不实现，架构上预留指令通道（WS 双向已在选型中预留）。

**其余内容**
- **目录监听生产化**：`FW-01~FW-12` 通过（Linux + Windows + macOS 各跑 FW-01/03/05/08）；降级轮询模式有 UI 提示与自动化验证。
- **多 workspace**：架构预留，未排期。

---

## 6. 责任人矩阵

| 里程碑 | coder | tester | researcher | leader |
| --- | --- | --- | --- | --- |
| M0 | 主（全部骨架 + demo + 5 条契约） | 契约验收、冒烟、L1 骨架 | 状态语义定稿（M1 依赖，可并行） | 排期、阻塞升级、整合上报 |
| M1 | 主（A/B 接入 + SQLite + 推送） | 实时性、状态机、DB 恢复专项 | 验收标准与状态语义验收 | 整合方案 |
| M2 | 主（消息全量 + 过滤搜索 + 虚拟滚动） | 消息完整性、10 万条压测 | 过滤/搜索语义验收 | 整合方案 |
| M3 | 主（打包 + 增强） | 三平台 matrix、长稳 | — | 发布协调 |

---

## 7. 关键依赖链

```
researcher《状态语义定义》──┐
                            ├──> coder M1（状态机 + DB schema）
M0 electron-rebuild 跑通 ───┘         │
                                      v
                            tester M1 实时性/状态正确性专项
                                      │
                                      v
                            coder M2 对话记录 ──> tester M2 压测
                                      │
                                      v
                            coder M3 打包 ──> tester M3 三平台 matrix
```

**最高风险项（按优先级）**：
1. **`better-sqlite3` + `@electron/rebuild` 构建失败（M0-V1）—— 当前最高风险，且 V1 尚未产出结果**。V1 阻塞 M0~M3 全链路（DB 是唯一存储层）。
   - **备选降级路径（按顺序，须 main 书面批准，禁止静默降级）**：
     ① **`node:sqlite`**（Node 内置，免编译原生模块）—— 需验证 Electron 38 内置 Node 版本是否启用该模块、以及功能是否够用（FTS5 trigram 是硬需求，`node:sqlite` 的 FTS5 支持需实测）；
     ② **server 层移出 Electron 主进程**（改为独立 Node 子进程，主进程通过 HTTP/IPC 与之通信）—— 彻底绕开原生模块重建，代价是进程模型与打包形态变复杂（需随应用分发一个 Node 运行时或要求系统 Node）。
   - 触发条件：V1 在本机（Linux x64）连续失败且无可行修复方案时启用。
2. reporter 埋点需要 agent 端配合，若不可改则「进度/当前文件/已耗时」退化为占位符（影响 M1 核心价值）。
3. 10 万条虚拟滚动性能；中文 FTS5 采用 `trigram` 后**短词（1~2 字）召回差**，需 `LIKE` 降级兜底（M2，spike 前置验证）。
4. ~~macOS 公证~~ → **Q11 已书面豁免，风险关闭**。
5. ~~`secure_delete` 拖垮写入吞吐~~ → **已裁决：双连接方案，两个指标都不放宽**（写入连接 OFF / 删除归档连接 ON）。残余风险：归档删除若高频，删除连接的 `TRUNCATE` checkpoint 可能造成瞬时卡顿 —— 届时走「归档批量化 + 降频（同步改异步批处理）」，**不削弱安全项**。
6. 脱敏正则**误伤正常代码/日志**（M1，需误伤率基线与可关闭开关）。
7. **语言栈偏差 —— 已裁决：方案 A（切回 TypeScript），带硬前提与安全阀**（main 2026-09-14）。coder 当前以 CommonJS **JavaScript** 实现（`jsconfig.json`），拍板选型为 **TypeScript**（§7 决策 2）。
   - **决策理由**（三条实质依据，非沉没成本）：① 本项目是**协议密集型**（Envelope / 十几种 message type / agent 上报接口 / 前端订阅格式），字段名写错只能运行时发现，而这类 bug 在「实时状态流」下极难复现定位，类型化契约是**随规模放大收益**的设计点；② 现在 6 个文件，迁移成本最低，等 30 个文件铺开就是重写，**不允许既成事实绑架决策**；③ tester 评估约 80% 用例与语言无关、测试侧改回 TS 成本 ≈0，成本全在 coder 侧，性价比高。
   - **硬前提：语言栈优先级严格低于 V1**。V1（依赖安装 + `electron-rebuild`）出结果前，**禁止投入任何时间做 TS 迁移**——V1 不过则 Electron 方案本身可能变更（`node:sqlite` / server 独立进程），届时 TS 讨论作废。**顺序：V1 先过 → 再切 TS**。
   - **安全阀：TS 迁移总耗时上限 1 天**（`tsconfig` + `vite` 配置 + 现有 6 文件改 `.ts` + 类型化契约）。超时或 TS 工具链与 `electron-rebuild` 冲突 → **立即上报**并切方案 B。
   - **触发切 B 的条件**：coder 判断迁移 > 1 天；或 TS 工具链与 `electron-rebuild` 产生冲突。切 B 后须带 tester 的三个前置：`checkJs: true` 且**至少开 `strictNullChecks`**；引入运行时 schema 校验库做 IPC 契约；eslint 补 `no-undef` / `eqeqeq` / 异步相关规则。
   - 无论 A/B，**硬底线不变：不为语言问题让 M0 阻塞超过 1 天**。

**待关闭跟踪项（main 指定）**
| ID | 事项 | 责任人 | 关闭条件 |
| --- | --- | --- | --- |
| **T-01** | `server/src/db/index.js` 为 **0 字节**（疑似漏写内容） | coder | 文件写入真实实现，且 V1（`better-sqlite3` + `electron-rebuild`）在本机跑通 |
