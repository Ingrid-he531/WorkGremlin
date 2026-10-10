'use strict';

/**
 * 会话（conversation）—— 受监控产品在各个工程下开着的会话。
 *
 * 同一层的 CLI 与 Plugin 两路落盘**不是同一份**，各自有各自的取法，但产出同一种会话行：
 *   · 插件那路（1F CodeBuddy 的插件形态）：就是本文件下面这套结构化落盘
 *     （genie-history / todos / message-queue / file-changes），能拿到运行态；
 *     TraeCode 的插件形态没有这套落盘（实测只有运行时文件），所以它那两路落盘
 *     （~/.trae-cn、~/.marscode）只作展示、不进会话来源（见 trae.js）。
 *   · CLI 那路（1F CodeBuddy、2F、3F、4F）：会话在各自的会话 jsonl 里，只有文件时间可靠；
 *   · hook 那路（5F TraeCode、1F CodeBuddy CLI 的兜底）：连 jsonl 都没有时，
 *     会话来源就是 reporter 状态文件（listReporterSessions）。
 *
 * 真源是插件自己的落盘（不经我们同意也一直在写），四个目录互相索引：
 *   genie-history/{base64(工程目录)}/conversations/{会话id}/   工程 ↔ 会话名单（目录本身是空的）
 *   genie-history/{base64(工程目录)}/current.json              { conversationId, lastUpdated } 该工程当前会话
 *   todos/{会话id}.json                                        { conversationId, todos:[{id,status,content}] }
 *   message-queue/*.json                                       每会话 runtime:{activated,paused,awaitingSessionIdle} + 排队消息
 *   file-changes/{会话id}/*.json                               改动文件（增删行 + diff）
 *
 * 下拉要的是**所有工程里活跃着的会话**（不限当前打开的那个工程），所以这里
 * 遍历 genie-history 下每个工程目录；一个活跃会话都没有 → reason: 'no-open-project'。
 *
 * 纪律（对齐 docs/requirements.md §P0-6「绝不编造」）：
 *   - 会话里**没有**职务 / 进度 / 耗时这些字段，一行都不补，拿不到就是拿不到；
 *   - 主 Agent 的阶段是从 runtime + todos + 文件改动**推**出来的，全部标 `inferred: true`，
 *     UI 侧要按"推断"展示（灰显 + 标注），不能当成上报值。
 *
 * 扫盘便宜（几十个文件），缓存 5 秒足够。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { clientBase } = require('@workgremlin/shared');
// 通用落盘扫描基础设施（目录约定 + 容错文件读取），readJson / readDir 统一从 roots 取，不在各处重复定义
const { readJson, readDir } = require('./roots');
// 楼层模块注册表（floors.js）：会话标题按 client 派发到对应楼层模块时要用 registry 里的 sessionTitle
const { floors: floorRegistry } = require('./floors');
// 楼层能力模块（module group）：每个楼层（trae / claude / codebuddy / copilot）实现同一份
// "会话能力"接口，sessions.js 一律用 `楼层.能力` 成员访问。新增楼层 = 在 FLOORS 里加一行
// require + 在该 floor 模块里实现需要的几个能力，调用点不用改。
//   selectedModelOf(sessionId, agentType)  当前模型（hook payload 无 model 字段的楼层才有）
//   cancelAt(sessionId, sinceTs)           这一轮被取消的时刻（0 = 未取消）
//   allCancels()                           全量取消扫描 → { [sessionId]: 时刻 }
//   allDoneHandlers()                      DoneHandler 终态（trae 特有）
//   interruptOf(j, startedAt)              打断检测（claude / qoder）
//   interruptTail(path, sinceTs)
//   sessionStatus(sessionId)
const trae = require('./floorTrae');
const claude = require('./floorClaude');
const codebuddy = require('./floorCodebuddy');
const copilot = require('./floorCopilot');
// 插件结构化落盘读取器（genie-history / todos / message-queue / file-changes / Copilot SQLite）：
// 所有 plugin kind 的取数都收口在 plugin.js，本文件只负责把这些落盘 + reporter 状态文件
// 综合成会话行，不再掺和插件的内部目录结构。
const plugin = require('./plugin');

// qoder 与 claude 共用同一套 transcript 打断检测（见 claude.synthMarks），
// 直接别名到 claude 模块，公共派发里就不必为它写特判了。
const qoder = claude;
const FLOORS = { trae, claude, codebuddy, copilot, qoder };

// 落盘窗口常量（与 CLI 楼层对齐）定义在 plugin.js，sessions.js / copilot.js 共用同一份，避免各定义一遍
const { IDLE_MS, BUSY_MS, FRESH_MS, LISTED_MS, DONE_TTL_MS } = plugin;


/**
 * 插件落盘这一路的来源客户端：**按楼层传入**，不再写死。
 * reporter 的状态文件按客户端分开写（同一个工程里 CodeBuddy / Codex / Claude … 各一份），
 * 每个插件楼层（1F CodeBuddy 的插件那一路、5F TraeCode-Plugin、未来的 Codex-Plugin …）只认自己
 * 这一路 —— 否则切到某层会看见别层在敲的命令、收工时还弹别层的「任务完成」。
 * 调用方（sessionRegistry）会把该楼层的 client（例如 'codebuddy-plugin' / 'trae-plugin'）传进来。
 * 合并楼层（1F CodeBuddy）另有一路 CLI 身份：见下面的 clientHit —— 它可以一次收一串 client。
 */

function clientHit(want, got) {
  if (!want) return true;
  const set = String(want)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!set.length) return true;
  return set.includes(String(got || '').toLowerCase());
}

/** 缓存：列表扫盘 + 读十几个小 json，5 秒足够 */
const TTL = 5_000;
let cache = { at: 0, key: '', value: null };

/**
 * 本进程（server）的启动时刻 —— "纪元"起点。
 * reporter 把相位写进本地状态文件、且不会被主动删除；上次运行（尤其被 kill/崩溃、
 * 没走 SessionEnd）留下的相位会在重启后被重新读到，表现为"已关闭的工程又亮了思考中"。
 * 所以只采信"本进程启动之后"写入的相位：重启后一律先回到待命，等下一个新事件再点亮。
 * 用时间戳比较而不是"退出时删文件"，是因为删除依赖干净退出，kill -9 / 崩溃时根本删不到。
 */
const SERVER_STARTED_AT = Date.now();

// 落盘窗口常量（IDLE_MS / BUSY_MS / FRESH_MS / LISTED_MS / DONE_TTL_MS）与 Copilot 共享，
// 统一定义在 plugin.js，避免 sessions.js / copilot.js 各写一份。上面已由 `const { ... } = plugin` 引入。

/* ------------------------------ 会话数据 ------------------------------ */
/** 每个会话的待办 / 改动文件 / 消息队列运行态的读取收口在 plugin.js（plugin.readTodos / readFileChanges / readRuntime）。 */

const AWAIT_TTL_MS = 5 * 60_000;
/**
 * 任务"还在跑"的判定窗口：只有最近**有过 hook 事件**（UserPromptSubmit / PreToolUse /
 * PostToolUse / Notification …）才算这一轮在生成。心跳守护的 `hb.lastEventAt` 不能算——
 * 它只证明 IDE 会话还开着，不证明 agent 在干活。
 *
 * 为什么需要它：CodeBuddy IDE 在「思考中 / 调用工具」时按 ESC 取消，既不发 Stop 也不发
 * Interrupt（实测 events.log 无此事件），但 IDE 会话没关、心跳守护照跳，于是 taskId 一直
 * 占着、sessionPhase 冻在最后一笔（tool / thinking）。旧逻辑拿 hb.lastEventAt 当新鲜度，
 * inWindow / sessionPhase 永远回落不下来 → 主控制台一直显示「调用工具 / 思考中」，实则那
 * 一轮早被掐断了。改成只看 hook 事件时间：取消后没有新事件，超过这个窗口就当这轮结束、回落待命。
 * 窗口与 inferPhase 的 FRESH_MS 对齐（2 分钟）——项目统一口径："近 2 分钟没活动就不当它在忙"。
 *
 * 已知取舍：一次 hook 事件都没有的中途长工具（比如跑了 >2 分钟的 Bash 构建，期间只有
 * PreToolUse 起手、PostToolUse 收尾，中间毫无事件）会被这个窗口误判成"已结束"、短暂回落待命，
 * 等 PostToolUse 一来相位又恢复。属于可接受的小抖动，不比"取消后永远卡在思考中"更糟。
 */
const TASK_RUN_MS = 2 * 60_000;
/**
 * "打断标记"与"最后一个 hook 事件"的先后容差（见 readReporterPhase 里那处作废判定）：
 * 标记的 ts 由 CLI 自己落盘、相位的 ts 由 hook 进程落盘，两者可能差几毫秒 —— 用户正是在
 * 最后一个工具的 hook 还没写完时按的停止。所以标记不比相位"旧过 1s"就算标记更新。
 * 代价：紧接着（<1s）重发一轮时，新相位会被压一小会儿；换来的是"按了停止就永不回弹"。
 */
const INTERRUPT_PHASE_SLACK_MS = 1_000;

/**
 * 命令类工具（Bash / execute_command …）：**服务端一律按"调用工具"上报，不做任何特殊化**。
 *
 * 为什么不在这里把 Bash 标成 await（等待授权）或改文案：
 * 本环境实测 CodeBuddy Plugin既不发"等授权"通知、也不发"授权结束"通知，而命令类工具
 * 又不发 PostToolUse —— 于是"到底有没有在等授权"根本没有真信号。以前靠"工具是 Bash"
 * 直接标 await，结果点了 run 之后没有任何事件能把它清掉，主控制台就一路卡在「等待授权」。
 *
 * 现在服务端只如实上报：相位 tool（调用工具）+ 工具名 + 实际命令。
 * 展示层一律写「调用工具」（不再按工具名换文案），这样展示口径改起来不用动服务端。
 * 真正的授权信号（Notification）来时，
 * 仍走下面 rp.phase === 'await' 那条真值分支——那段逻辑保留不动。
 */

function reporterHookHome() {
  return process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
}

/**
 * 这条会话在用什么模型。
 * 各产品模型字段的取法不通用，所以一个产品一个适配器、都从**各自的落盘**里捞：
 * TraeCode 见 trae.selectedModelOf，Claude Code 见 claude.selectedModelOf。
 * 两者都是因为 hook payload 里压根没有模型字段才只能读盘。
 * 其余产品（CodeBuddy / Codex）payload 里有，用不着适配器；真取不到就留空（绝不编造）。
 * 这里只做"按 client 分派适配器"这一件事，避免把某个产品的私有存储格式写死进通用读函数，
 * 也保持和 products.js 的表驱动扩展约定一致（加新产品就往 MODEL_SOURCES 挂一条，不必改 this 函数）。
 * @param {string} client 楼层客户端（如 'trae' / 'trae-plugin' / 'claude' / 'codex' …）
 * @param {string} sessionId hook payload 的 session_id
 * @param {string} agentType hook payload 的 agent_type（已落盘）
 */
/** client(基名) → 取"这条会话当前模型"的适配器；由各楼层的 selectedModelOf 自动汇总（见 FLOORS）。
 *  没实现 selectedModelOf 的楼层（codebuddy / copilot）自然落空，照旧取不到。 */
const MODEL_SOURCES = {};
for (const [key, mod] of Object.entries(FLOORS)) {
  if (typeof mod.selectedModelOf === 'function') MODEL_SOURCES[key] = mod.selectedModelOf;
}
function sessionModel(client, sessionId, agentType = '') {
  // 按**基名**查表：同一产品的插件/CLI 两种形态（trae-plugin / claude-plugin …）落盘是同一份，
  // 适配器也只认产品，不该因为客户端带了个后缀就取不到（适配器对不认识的会话 id 一律回空串，
  // 所以这里放宽只会"多给一次机会"，不会给错模型）。
  const fn = MODEL_SOURCES[clientBase(client)];
  return fn ? fn(sessionId, agentType) || '' : '';
}

function readReporterPhase(workspacePath, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  let win = null;
  let winPending = null;
  let winPrompt = '';
  let winClient = '';
  let winModel = '';
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!sameSession(j, session)) continue;
    // 按客户端过滤。老状态文件（本次改动之前写的）没有 client 字段 —— 那会儿只有 CodeBuddy，
    // 所以按 codebuddy 归属，而不是"对谁都匹配"（否则刚重启、Codex 还没写过状态文件时，
    // 3F 会短暂借到 1F 的相位）。
    if (!clientHit(client, j.client)) continue;
    const sp = j.sessionPhase;
    // 相位新鲜期：默认 AWAIT_TTL_MS（IDE 关掉后残留相位不挂）。
    // 但 taskId 还占着（这轮"在跑"）却很久没新 hook 事件（sessionPhase.ts 冻结）= 这一轮其实
    // 已经结束（CodeBuddy ESC 取消不发事件、心跳照跳），不能还显示"调用工具/思考中"，
    // 按更短的 TASK_RUN_MS 回落待命。
    const staleMs = j.taskId ? TASK_RUN_MS : AWAIT_TTL_MS;
    if (!sp || !sp.ts || now - sp.ts > staleMs) continue;
    // 相位早于本进程启动 → 上次运行留下的残留（已关闭的工程），不采信；重启后等新事件再亮
    if (sp.ts < SERVER_STARTED_AT) continue;
    if (workspacePath && sp.workspacePath && path.resolve(sp.workspacePath) !== path.resolve(workspacePath)) continue;
    // 这口"在跑"的相位是否被该楼层的取消/打断标记作废：打断检测是楼层私有知识
    // （Claude/Qoder 看 transcript 末尾、CodeBuddy 看 message-queue pauseReason、Trae 看 DoneHandler），
    // 由各楼层的 phaseSuperseded 自己判断，公共相位读取只负责派发（见各 floor 模块）。
    if (j.taskId) {
      const floorMod = FLOORS[clientBase(j.client)];
      if (floorMod && typeof floorMod.phaseSuperseded === 'function' && floorMod.phaseSuperseded(j, sp, INTERRUPT_PHASE_SLACK_MS)) continue;
    }
    // 会话已被用户取消（CLI 按 ESC 停止：reporter Stop 落盘的 done.cancelled）：相位冻在
    // 「等待授权 / 调用工具」都不再是实时状态，必须作废，否则主控制台被取消后还亮「等待授权」。
    // 插件形态的同款作废走上面 phaseSuperseded 的 message-queue 信号；这里补 CLI 形态这一份
    // （readReporterDones 把 done.cancelled 写进 bySession、任务列表据此亮「已取消」—— 相位层这里
    // 同步作废，主控制台才会切到「任务取消」红灯，而不是停在「等待授权」）。收尾不比相位旧（容差
    // INTERRUPT_PHASE_SLACK_MS）才算戳破它，避免正常「调用工具 → 收尾」被旧相位误盖。
    if (j.done && j.done.cancelled && j.done.at && Number(j.done.at) + INTERRUPT_PHASE_SLACK_MS >= Number(sp.ts || 0)) continue;
    if (!win || sp.ts > win.ts) {
      win = sp;
      winClient = String(j.client || '');
      // 同一份状态文件里的 pending：PreToolUse 写、PostToolUse 清掉；迟迟不清 = 工具被权限框卡住
      winPending = j.pending || null;
      // 同一份状态文件里的 taskTitle = 用户那句话（标题），思考中时要顶到屏幕最前显示
      winPrompt = j.taskTitle || '';
      // 模型不在这份状态文件里（多数产品的 hook payload 不带），按会话去 TraeCode 自己的落盘取。
      // 但 Kilo / OpenCode 插件（packages/reporter/src/plugin/）**直接把模型写进状态文件**
      // （它们的 session.created 事件带 data.model，轮询那一路本来也能从库里取到）——
      // 所以先认状态文件里这个值，取不到才退回落盘适配器。
      winModel = String(j.model || "") || sessionModel(winClient, j.sessionId, j.agentType);
    }
  }
  // Copilot 9F 没有 reporter hook，相位不在这份状态文件里 —— 它的相位由 9F 自己的 readPhase
  // 提供（见 reporterMainPhase 对 FLOORS[base].readPhase 的派发：copilot.readPhase = readCopilotPhaseFromSqlite）。
  // 这里只负责有 hook 的产品；读不到就如实返回 null，绝不编造兜底。
  if (!win) return null;
  return {
    // 这份相位是哪个客户端写的（Codex 有显式 PermissionRequest，不需要 pending 推断）
    client: String(winClient || ''),
    phase: String(win.phase || 'thinking'),
    tool: String(win.tool || ''),
    file: String(win.file || ''),
    // hook 在 PreToolUse 写的"实际调用"可读命令（Read src/main.js / grep ... / Bash ...），
    // 给主控制台 tips 当"工具"显示，比纯工具名更直观
    cmd: String(win.cmd || ''),
    // 用户那句话（思考中时主控制台屏幕第三层顶到最前显示；UI 只在 thinking 相位用）
    prompt: String(winPrompt || ''),
    // 这条会话在用什么模型（只有 TraeCode 取得到；别的楼层留空）。取不到就是空串，不猜。
    model: String(winModel || ''),
    // 这份相位的写入时刻：渲染层拿它跟"收尾标记"比先后 —— 只有**比收尾还新**的实时相位
    // 才算"用户又发了一轮"，取消前那一口 stale 的 thinking / tool 不许把红色「任务取消」盖回去。
    ts: Number(win.ts) || 0,
    pending: winPending
      ? { tool: String(winPending.tool || ''), file: String(winPending.file || ''), cmd: String(winPending.cmd || ''), at: Number(winPending.at) || 0 }
      : null,
  };
}

/** 状态文件名里"这个工程"那一段：`@<工程绝对路径>` 整体 sanitize。 */
function stateFileWs(ws) {
  return `@${path.resolve(ws)}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 会话过滤（轴 2）：这条状态文件是不是 `session` 那条会话写的。
 *
 * `session` 为空 → **不限**（保持老行为：同 client 里取最新那份）。
 * 指定了会话时，老状态文件（没有 sessionId 字段）一律不算 —— 它们属于"还没有会话概念"的时代，
 * 硬算给某条会话会让"看 A 会话"读到 B 会话的数据。
 */
function sameSession(j, session) {
  return !session || String((j && j.sessionId) || '') === String(session);
}

/** 进程还在不在（信号 0 = 只探测不投递）。权限不足也算"在"。 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n < 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但不归我们管；ESRCH = 真没了
    return Boolean(e && e.code === 'EPERM');
  }
}

/**
 * 这个成员**还有没有别的会话在跑**（轴 2）。
 *
 * 为什么需要它：`agent_status` 是**按成员一行**存的（`member_id` 是主键），没有会话维度。
 * 同一个 Claude Code 同时开着 A / B 两条会话时，A 收工（Stop → idle）或退出（SessionEnd → offline）
 * 都会去写那**唯一一行**，于是 B 还在干活、工位卡片已经显示「空闲 / 离线」。
 * 所以降级之前先问一句"这条成员的别的会话还活着吗"，活着就别降。
 *
 * 「活着」的判据（任一）：
 *   - 那份状态文件的**心跳守护进程还在**（`hb.pid` 存活）—— 主判据：会话没退，守护就没退；
 *   - 或者它还有**在飞的相位 / 任务**（`sessionPhase` 或 `taskId` 是新鲜的）——
 *     覆盖"守护没起来 / 刚被杀"的情况。注意 SessionEnd 会把这两样清空，所以干净退出的
 *     会话不会被这条误判成活着。
 *
 * **不能用 `hb.lastEventAt` 当判据**：会话干净退出后它照样是新的（它记的是"最后一次事件"，
 * 不是"最后一次心跳"），拿它判会把已结束的会话当成还在跑 —— 实测的症状是：A 退会话后
 * B 也退了，工位卡片还挂在「思考中」，永远降不下来。
 *
 * 只认**同一个 client + 同一个工程**下、**会话 id 不同**的状态文件；老命名文件（没有会话）
 * 不算"别的会话"（它压根没有会话维度，认了会把单会话场景也拦下来）。
 * @param {{workspacePath?: string, client?: string, session?: string, now?: number}} o
 * @returns {boolean}
 */
function hasOtherLiveSession({ workspacePath = '', client = '', session = '', now = Date.now() } = {}) {
  const ws = String(workspacePath || '').trim();
  // 没有会话标识就无从谈起"别的会话"（老 hook / 别的产品）→ 一律不拦
  if (!ws || !session) return false;
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  for (const name of readDir(dir)) {
    const fileSession = stateFileSession(name, m, dir);
    if (fileSession === null || !fileSession || fileSession === session) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!clientHit(client, j.client)) continue;
    // 判据 1：心跳守护还活着（最可靠）
    if (j.hb && pidAlive(j.hb.pid)) return true;
    // 判据 2：还有在飞的相位 / 任务（见函数说明，**不能**用 hb.lastEventAt）。
    // **idle 相位不算"在飞"**：收尾（Stop / Interrupt / idle_prompt）现在都会写一笔显式 idle，
    // 它只说明"这一轮结束了、在等下一句"，把它当"别的会话还在跑"会让成员卡永远回不到空闲
    // （同层 CLI + 插件混跑时尤其明显）。
    const spPhase = String((j.sessionPhase && j.sessionPhase.phase) || '');
    const phaseTs = Number(j.sessionPhase && j.sessionPhase.ts) || 0;
    if (spPhase && spPhase !== 'idle' && phaseTs && now - phaseTs <= AWAIT_TTL_MS) return true;
    const startedAt = Number(j.taskStartedAt) || 0;
    if (j.taskId && startedAt && now - startedAt <= AWAIT_TTL_MS) return true;
  }
  return false;
}

/** 会话 id 的规范形状：UUID（Claude Code 实测就是这个）。 */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 状态文件的文件名 → 它属于哪个会话（`''` = 老命名，没带会话）。
 * 不认识这个名字（不是这个工程的状态文件 / 根本不是状态文件）→ 返回 `null`。
 *
 * 命名由 hook 的 statePath() 决定：`<agent>@<工程绝对路径>[@<会话>]` 整体 sanitize 成 `[A-Za-z0-9._-]`。
 * **加了会话之后文件名尾巴多一段 `_<会话>`**，所以老的 `endsWith('@<工程>.json')` 会全部匹配不上 ——
 * 两处调用（hasReporterState / reporterStateMeta）都走这里，别退回去用 endsWith。
 *
 * **这个编码是有损的**（`_` 既是分隔符又是合法字符），所以单看文件名分不清
 * "工程 `/a/b` + 会话 `sub`" 和 "工程 `/a/b/sub` + 没有会话"——后者是老命名的文件，
 * 会被前者误认成自己的会话。所以尾巴分两步认：
 *   1. 是 UUID → 直接认（Claude Code 的规范形状，绝大多数情况走这条，不读文件）；
 *   2. 不是 UUID → 回读文件内容，**内容里的 `sessionId` 才是权威**（它是 hook 原样写进去的，
 *      没过 sanitize）。内容对不上就不认 —— 于是上面那个 `/a/b/sub` 的老文件会被正确排除。
 * @param {string} name 文件名
 * @param {string} wsPart stateFileWs() 的结果
 * @param {string} dir hooks 目录（第 2 步回读内容用）
 * @returns {string|null} 会话 id（可为 ''）
 */
function stateFileSession(name, wsPart, dir) {
  if (!/\.json$/i.test(name)) return null;
  const base = name.slice(0, -5);
  if (base.endsWith(wsPart)) return '';
  const i = base.lastIndexOf(wsPart);
  if (i < 0) return null;
  const tail = base.slice(i + wsPart.length);
  // 会话尾巴是一段 `_<id>`。**`_` 本身必须允许出现在 id 里** —— Kilo / OpenCode 的会话 id
  // 形如 `ses_f22614607ffeQV…`（OpenCode 同款），id 内不含 `_`，但**测试夹具与将来任何
  // 带下划线的 id** 都会被这里挡掉：那一份状态文件就被当成"不认识的文件"跳过，
  // `hasReporterState` / `reporterStateMeta` 恒返回 false → UI 一直显示「未上报」，
  // 而不是「接了 hook、当前没事干」。之前这里写的是 `[A-Za-z0-9.-]`（只有 UUID 成立）。
  //
  // 放宽不会引入歧义：这个编码本来就是有损的（`_` 既是分隔符又是合法字符），
  // 下面紧接着就是靠**回读文件内容里的 sessionId** 来定音的 —— 内容对不上照样不认。
  if (!/^_[A-Za-z0-9._-]+$/.test(tail)) return null;
  const cand = tail.slice(1);
  if (SESSION_UUID_RE.test(cand)) return cand;
  const j = readJson(path.join(dir, name));
  return j && String(j.sessionId || '') === cand ? cand : null;
}

/**
 * 这个工程有没有接过 hook（= 有没有对应的 hook 状态文件）。
 *
 * 和"有没有新鲜相位"是两回事：会话结束后 hook 会把 sessionPhase 清空（正确行为），
 * 但此时 CLI 楼层不该退回"按 jsonl mtime 猜"的兜底（那会让 3F 一直显示「调用工具 / 改 xxx.jsonl」），
 * 而应该显示「待命」。渲染层靠这个字段区分"没接 hook"与"接了但当前没事干"。
 *
 * 状态文件名由 hook 的 statePath() 生成：`<member>@<工程绝对路径>[@<会话>]`，非 [A-Za-z0-9._-] 换成 `_`。
 * @param {string} workspacePath
 * @param {string} [client] 来源客户端；空则不限
 */
function hasReporterState(workspacePath, client = '') {
  const ws = String(workspacePath || '').trim();
  if (!ws) return false;
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  for (const name of readDir(dir)) {
    // 注意判 null 而不是判 falsy：老命名文件（不带会话）返回的是空串，那也是**本工程的**状态文件
    if (stateFileSession(name, m, dir) === null) continue;
    if (!client) return true;
    const j = readJson(path.join(dir, name));
    // 老文件没记 client → 按 codebuddy 归属（同上）
    if (clientHit(client, j && j.client)) return true;
  }
  return false;
}

/**
 * 这个工程有没有接过 hook，以及那份状态文件属于**哪条会话**。
 *
 * 为什么要会话 id：hook 是会话级加载的（会话启动时装，之后改配置不影响它），
 * 所以"工程里有状态文件"不等于"你正在看的这条会话在上报"——
 * 实测：13:40 开的旧会话没有 hook，但同工程里跑过 `codex exec`，状态文件存在，
 * 界面就会把这条会话显示成「待命」，看起来像"整轮对话没有状态变化"。
 * @returns {{instrumented: boolean, sessionId: string}}
 */
function reporterStateMeta(workspacePath, client = '', session = '') {
  const ws = String(workspacePath || '').trim();
  if (!ws) return { instrumented: false, sessionId: '' };
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  let best = null;
  let bestTs = -1;
  for (const name of readDir(dir)) {
    const fileSession = stateFileSession(name, m, dir);
    if (fileSession === null) continue;
    // 指定了会话就只认那一条：文件名里的会话是 hook 写的，最可信；
    // 老命名文件（没带会话）在指定会话时一律不算 —— 否则"看会话 B"会借到会话 A 的老文件。
    if (session && fileSession !== session) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    // 老状态文件没记 client → 按 codebuddy 归属（与相位读取同一口径）
    if (!clientHit(client, j.client)) continue;
    const ts = (j.sessionPhase && j.sessionPhase.ts) || j.taskStartedAt || (j.hb && j.hb.lastEventAt) || 0;
    if (ts >= bestTs) {
      bestTs = ts;
      best = j;
    }
  }
  if (!best) return { instrumented: false, sessionId: '' };
  return { instrumented: true, sessionId: String(best.sessionId || '') };
}

function reporterMainPhase(workspacePath, client = '', session = '') {
  // 各楼层（尤其是 9F Copilot，没有 reporter hook）可自己实现 readPhase 来提供相位；
  // 没实现的（带 hook 的产品）退回通用的 readReporterPhase。相位职责按楼层派发，不把兜底塞进 generic 里。
  const base = clientBase(client);
  const floor = FLOORS[base];
  const readPhase = floor && typeof floor.readPhase === 'function' ? floor.readPhase : readReporterPhase;
  const rp = readPhase(workspacePath, client, session);
  if (!rp) return null;
  // 下面每个分支都是**各建各的对象**，不是展开 rp —— 要往外带什么字段，每个分支都得加一遍，
  // 漏了就会静默丢掉（model 就这么丢过一次）。
  if (rp.phase === 'await') {
    return {
      phase: 'await',
      action: rp.tool ? `申请执行 ${rp.tool}` : '等待用户授权',
      target: rp.file || '',
      context: ['等待用户授权后继续', rp.tool && `工具：${rp.tool}`, rp.file && `目标：${rp.file}`].filter(Boolean),
      prompt: rp.prompt || '',
      model: rp.model || '',
      // 相位写入时刻：渲染层拿它跟收尾标记比先后（见 IsoOfficeView 的 consoleLive 守卫）
      ts: Number(rp.ts) || 0,
    };
  }
  if (rp.phase === 'tool') {
    // 优先显示 hook 报上来的完整命令（Read src/main.js / grep ... / Bash npm run build），
    // 没有再回退到「调用 Xxx」泛化文案。
    // action 是具体在做什么；tool 只显示工具名，不要塞完整命令。
    const cmd = rp.cmd || (rp.tool ? `调用 ${rp.tool}` : '调用工具');
    return {
      phase: 'tool',
      action: cmd,
      tool: rp.tool || '',
      target: rp.file || '',
      context: rp.file ? [`目标：${rp.file}`] : [],
      prompt: rp.prompt || '',
      model: rp.model || '',
      ts: Number(rp.ts) || 0,
    };
  }
  // 其余相位**原样透传**，不要压成 thinking。
  //
  // 早先这里只认 await / tool 两个分支，剩下的全落进最后的 thinking 兜底，于是
  // 「写 idle 的一轮结束了」与「写 done 的任务完成了」在控制台上都显示成「思考中」——
  // 收工了还在显示在思考，是把已完成说成还在忙。相位词汇表里本来就有
  // idle / unreported / dispatch / done / waiting 这几项
  // （见 renderer/src/iso/mainConsole.js 的 PHASES），透传即可，不必各自再包一层。
  // 真正**不认识**的相位才落 thinking（兜底，且只对未知值生效）。
  if (rp.phase && rp.phase !== 'await' && rp.phase !== 'tool') {
    return { phase: rp.phase, action: '', target: '', context: [], prompt: rp.prompt || '', model: rp.model || '', ts: Number(rp.ts) || 0 };
  }
  // thinking：干净，不堆示意字；但把用户那句话（prompt）一并带出，屏幕第三层顶到最前显示
  return { phase: 'thinking', action: '', target: '', context: [], prompt: rp.prompt || '', model: rp.model || '', ts: Number(rp.ts) || 0 };
}

/**
 * reporter hook 的"活跃窗口"：UserPromptSubmit 落 taskId、Stop 清空。
 * 只有在这个窗口内（用户提交了任务、agent 还没收工）才算"活着"；
 * 会话存在但没有事件时一律待命 —— 主控制台据此决定要不要显示活跃状态。
 *
 * 还要校验"这份状态文件本身是否还活着"：历史遗留 / 已退出的会话会在 hooks 目录里
 * 留下 taskId 不再更新的死文件（例如改「按工位+工程分文件」之前的老命名文件）。
 * 不校验的话，只要有一个死文件的 taskId 跟当前工程匹配，inWindow 就会被永久顶成 true，
 * 于是 Stop 之后仍旧按"还在干活"推出「思考中」。
 * @param {string} workspacePath 当前打开的工程；空则不限工程
 * @param {string} [client] 来源客户端；空则不限客户端
 * @returns {boolean}
 */
function readReporterActiveTask(workspacePath, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j || !j.taskId) continue;
    if (!sameSession(j, session)) continue;
    // 按客户端过滤（口径同 readReporterPhase：老状态文件没记 client → 归 codebuddy）：
    // 同一工程里别的产品在跑时，别把它的任务算成本层"还在干活"的活跃窗口
    if (!clientHit(client, j.client)) continue;
    const ws = j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    // 心跳时间**不能**算"任务在跑"：它只证明 IDE 会话还开着（见 hasOtherLiveSession 的同名纪律），
    // 取消时心跳照跳会让 taskId 永远新鲜、相位卡死在思考中/调用工具。只认 hook 事件时间
    // （taskStartedAt 起轮、sessionPhase.ts 每次事件刷新）：取消后没有新事件，超 TASK_RUN_MS
    // 就当这一轮结束了，inWindow 回落待命。
    const lastAt = Math.max(
      Number(j.taskStartedAt) || 0,
      Number(j.sessionPhase && j.sessionPhase.ts) || 0
    );
    if (!lastAt || now - lastAt > TASK_RUN_MS) continue;
    // TraeCode 取消兜底：renderer.log 里已确认取消（取消时刻比本轮开始新）→ 不算活跃
    // （TraeCode 取消不发 Stop hook 事件，taskId 永远占着，这里手动戳破它）。
    if (clientBase(j.client) === 'trae') {
      const atT = trae.cancelAt(j.sessionId, Number(j.taskStartedAt) || 0);
      if (atT) continue;
    }
    return true;
  }
  return false;
}

/**
 * reporter hook 在 Stop 时落的"完成"标记（带工程路径），按**工程 + 客户端**一次扫盘取回。
 * 返回 { latest, bySession }：latest = 该 (工程, 客户端) 里最新的一份；bySession = 会话 id -> 该会话最新的一份。
 *
 * 为什么拆成"一次读盘"和"按会话取"两步：会话表扫盘一次能扫出上百个历史会话文件，
 * 若每扫到一条就去调一次 readReporterDone，hooks 目录就要被扫上百遍
 * （消费方见 sessionRegistry 里按 (工程, 客户端) 缓存的 doneScans）。
 */
/**
 * 状态文件里的 `roundFiles`（`{path,op,abs}`）→ 完成标记的 `files` 形状（带 size）。
 * 取消时用它补"取消前已经动了哪些文件"（与 hook.js 的 collectRoundFiles 同口径）：
 * 去重、删除类不给 size、stat 不到就不给（绝不编造）。
 * @param {{roundFiles?: Array<any>}} j 状态文件内容
 */
function roundFilesOf(j) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(j && j.roundFiles) ? j.roundFiles : []) {
    const p = typeof x === 'string' ? x : x && x.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    let size = null;
    const abs = x && typeof x === 'object' ? x.abs : '';
    if (abs && !(x && x.op === 'delete')) {
      try {
        const s = fs.statSync(abs);
        if (s.isFile()) size = s.size;
      } catch {
        /* 文件删了 / 挪了：不给 size，路径照记 */
      }
    }
    out.push(size == null ? { path: p } : { path: p, size });
  }
  return out;
}

function readReporterDones(workspacePath, client = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  /** sessionId -> 该会话最新的一份 */
  const bySession = new Map();
  /** 该工程 + 客户端里最新的一份（会话 id 拿不到的楼层用它兜底） */
  let latest = null;
  /** 兜底合成的"取消"标记里、需要服务端补发 task/end(cancelled) 的那些（见 sessionRegistry 的 flush）。
   *  这些产品（Claude / Qoder 按停止、CodeBuddy 插件按停止）取消时**一个 hook 事件都不发**，
   *  只能由服务端从落盘里认出来（见 claude.interruptOf / codebuddy.cancelAt），
   *  然后由 sessionRegistry 在 refresh 时去重后补发一次 task/end —— 否则台账那行一直挂在「进行中」。 */
  const cancels = [];
  /**
   * 扫到的"当前这一轮"：会话 id + 本轮开始时刻。
   * 交给 sessionRegistry 去收**被这一轮顶掉的上一轮**（同会话至今没收到结束事件、
   * 台账上还挂 running 的那些）—— 一个会话不可能同时跑两轮，见 bus.endStaleTasksOfSession。
   */
  const rounds = [];
  /**
   * 合成一枚取消标记：既有按会话给控制台的那份（bySession，红灯靠它），
   * 也有列进 cancels 让台账补一刀的那份。两个信号共用，别再各写一遍。
   */
  const synthCancel = ({ id, j, ws, at, files = [], said = '', result = '' }) => {
    if (!at) return;
    const mark = {
      at,
      title: j.taskTitle || '',
      workspacePath: ws,
      sessionId: id,
      cancelled: true,
      files: files.slice(0, 8),
      fileCount: files.length,
      said,
    };
    if (id && (!bySession.get(id) || Number(mark.at) > Number(bySession.get(id).at))) bySession.set(id, mark);
    if (!latest || Number(mark.at) > Number(latest.at)) latest = mark;
    cancels.push({
      sessionId: id,
      taskId: j.taskId,
      client: j.client,
      workspacePath: ws,
      at,
      title: j.taskTitle || '',
      form: j.form || '',
      files,
      fileCount: files.length,
      result,
    });
  };
  /** 真·完成（楼层补的"正常完成"标记，cancelled:false）：只在比现有 mark 新（或相等）时覆盖，
   *  让 DoneHandler 的 completed 能盖掉之前合成的 cancelled:true。不产生 cancels 行。 */
  const synthDone = ({ id, ws, at, title = '', files = [] }) => {
    if (!at) return;
    const existing = bySession.get(id);
    if (!existing || Number(at) >= Number(existing.at || 0)) {
      const mark = {
        at,
        title: title || '',
        workspacePath: ws,
        sessionId: id,
        cancelled: false,
        files: files.slice(0, 8),
        fileCount: files.length,
        said: '',
      };
      bySession.set(id, mark);
      if (!latest || Number(mark.at) > Number(latest.at)) latest = mark;
    }
  };
  /** hook 状态文件按 sessionId 归并（楼层自己的取消/完成探测从这里取 workspacePath / roundFiles / client 过滤） */
  const hookBySid = new Map();
  /** 全部 hook 状态文件（不按 sessionId 去重）：Claude/Qoder 的取消探测要逐文件扫，与主线循环同口径 */
  const allFiles = [];
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    allFiles.push(j);
    if (j.sessionId) hookBySid.set(String(j.sessionId), { j });
    if (!clientHit(client, j.client)) continue;
    const ws = (j.done && j.done.workspacePath) || j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    const id = String(j.sessionId || '');
    // 真·完成标记（Stop 落盘）：取每会话最新的一份
    if (j.done && j.done.at && now - Number(j.done.at) <= DONE_TTL_MS) {
      const done = j.done;
      const prev = id ? bySession.get(id) : null;
      if (id && (!prev || Number(done.at) > Number(prev.at))) bySession.set(id, done);
      if (!latest || Number(done.at) > Number(latest.at)) latest = done;
      // CLI 形态取消（按 ESC 停止）：Stop 落盘 done.cancelled 是 reporter 自己的权威标记，楼层无关。
      // 除了进 bySession（主控制台据此亮红灯），还要合成进 cancels —— 否则 sessionRegistry 的
      // flushSynthesizedCancels 扫不到它，task_runs 会一直停在 CLI 自己上报的 done（result 还是
      // 那句「interrupted by user」），滚动屏 / 任务状态显示「完成」，与主控制台红灯对不上。
      // 插件形态取消走各楼层 synthMarks（它有 message-queue 信号，CLI 没有）；这里补 CLI 这条。
      // result 用 done.said 那句原话，取消也照带产出摘要（"没干完"不是"没产出"）。
      if (done.cancelled) {
        const cancelledAt = Number(done.at) || 0;
        // 只认"本轮开始之后"的取消：老取消（上一轮）不能算到新一轮头上（同 synthMarks 的 sinceTs 口径）。
        const sinceTs = Number(j.taskStartedAt) || 0;
        if (!sinceTs || cancelledAt >= sinceTs) {
          const doneFiles = Array.isArray(done.files) ? done.files : [];
          cancels.push({
            sessionId: id,
            taskId: j.taskId,
            client: j.client,
            workspacePath: ws,
            at: cancelledAt,
            title: j.taskTitle || '',
            form: j.form || '',
            files: doneFiles,
            fileCount: Number.isFinite(Number(done.fileCount)) ? Number(done.fileCount) : doneFiles.length,
            result: String(done.said || ''),
          });
        }
      }
    }
    /* 楼层特有的"取消"标记合成（Claude/Qoder 的 transcript 信号、Trae 的 renderer.log、
       CodeBuddy 插件的 message-queue）已统一收口到各楼层模块的 synthMarks（见文件底部按
       FLOORS 派发），这里不再写任何产品专属逻辑。历史上"任务槽卡死 + transcript 末轮
       state='running' ⇒ 判被打断"的兜底（2026-09-29 去掉）：它判不出"还在慢慢想"和"被打断"，
       长时间不调工具的轮会被误判取消，控制台先弹红色「任务取消」又跳回「思考中」，所以宁可
       停在旧相位、等新鲜期回落待命，也不误报取消。 */
    if (j.taskId) {
      const startedAtJ = Number(j.taskStartedAt) || 0;
      // taskId 一并带上：sessionRegistry 的"被顶掉上一轮"扫尾拿它显式排除当轮自己
      //（光靠 startedAt >= ts 判界不够直观，双保险），见 bus.endStaleTasksOfSession。
      if (id && startedAtJ) rounds.push({ sessionId: id, taskId: j.taskId, taskStartedAt: startedAtJ, client: j.client });
    }
    // 楼层特有的"用户按停止却一个 hook 事件都不发"的取消探测，统一交给各楼层模块
    // （见文件底部按 FLOORS 派发的 synthMarks）；公共代码只收"当前这一轮"起点，不写死任何产品。
  }
  /* --- TraeCode 独立扫取消信号 ---
     数据源是 Trae 自己的 renderer.log（DoneHandler status:"canceled" / StreamDomainService
     cancelReason:"stop_button" / NotificationPort stopType:"cancel" / stream-diagnostics
     transformedStatus:"canceled"，四种都带 sessionId），由 trae.allCancels()
     解析出来（按 mtime+size 缓存，与 traeModels.js 同口径）。

     为什么**不在**上面的 hook 状态文件扫描循环里做：
       · Trae 取消时**Stop hook 不触发**（hooks.json 里明明配了 Stop，execCommandHook 再也没
         被调过一次），唯一权威信号是 renderer.log。
       · hook 状态文件是"一份会话一份"，新一轮一开就覆盖旧的 taskId / taskStartedAt /
         sessionPhase —— 如果我们把取消检测绑在 `if (j.taskId)` + `j.taskStartedAt` 的
         sinceTs 过滤上，那"上一轮取消 → 新一轮立刻启动"这个窗口一过，上一轮的取消
         信号就被新 startedAtJ 过滤掉了，done 标记永远合成不了。

     为什么**不在** hook 状态文件扫描循环里做、为什么**也不做** sinceTs/smart 判断：
       · Trae 取消时 Stop hook 不触发，唯一权威信号是 renderer.log。
       · hook 状态文件是"一份会话一份"，新一轮一开就覆盖旧的 taskId / taskStartedAt。
         如果取消检测绑在 `startedAtJ` 上，"上一轮取消 → 新一轮立刻启动"这个窗口一过，
         旧取消信号就被新 startedAtJ 过滤掉，done 标记永远合成不了。
       · 渲染层自己用 "phase.ts vs done.at 谁更新" 来决定显示：done.at 旧但 phase.ts 新 →
         新一轮正常跑覆盖 cancelled 状态（L459-470 IsoOfficeView.vue），**不会误亮红灯**。
         所以无需 smart 判断过滤。 */
  // 楼层特有的取消/完成标记合成：每条楼层自己实现 synthMarks（见各 floor 模块），公共代码只负责派发。
  // client 为空（不指定产品）时扫全部楼层；否则只跑被点名的那一层。
  // qoder 已在 FLOORS 里别名到 claude 模块，这里无需特判。
  const bases = client
    ? String(client).split(',').map((s) => clientBase(s.trim())).filter(Boolean)
    : Object.keys(FLOORS);
  const seen = new Set();
  for (const base of bases) {
    const floor = FLOORS[base] || null;
    if (!floor || seen.has(floor) || typeof floor.synthMarks !== 'function') continue;
    seen.add(floor);
      floor.synthMarks({
        workspacePath,
        client,
        hookBySid,
        allFiles,
        clientHit,
        roundFilesOf,
        synthCancel,
        synthDone,
        bySession,
        now,
      });
  }

  return { latest, bySession, cancels, rounds };
}

/** "任务完成"的唯一真源：取**某条会话**的完成标记（不靠相位回落到空闲来猜，避免中途误弹）。
 *  同一个 (工程, 客户端) 下可能有多条会话，各取各的；会话 id 拿不到的楼层（Codex 的
 *  rollout 文件名不含 session_id）退回"该 client 最新的一份"——不猜，只是放宽到这一步。 */
function readReporterDone(workspacePath, client = '', session = '') {
  const { latest, bySession } = readReporterDones(workspacePath, client);
  const hit = session ? bySession.get(String(session)) || null : latest;
  if (hit) return hit;
  // 9F GitHub Copilot 没有 hook：状态文件这条路永远是空的，完成标记得从它自己的会话日志取
  // （最新那一轮 request 的 completedAt，见 readCopilotLiveRequest）——不然 9F 永远没有
  // 「任务完成」那一下（实测 2026-09-28：7F/8F 都有、9F 一直空）。
  if (clientBase(client) === 'copilot') {
    const d = copilot.readCopilotDone(session);
    if (d) return d;
  }
  return hit;
}



/**
 * hook 上报的会话清单 —— 给"只认 hook"的楼层当会话来源（见 products.js 的 hookSource）。
 *
 * TraeCode IDE 没有可扫的会话落盘（`~/.trae-cn/memory/*.jsonl` 是它自己的记忆文件，
 * 不是对话会话，拿来当会话就是编造），所以它的会话表直接由 reporter 状态文件构成：
 * sessionId 就是 hook payload 的 `session_id`，工程路径取相位 / 任务里记的 workspacePath ——
 * 两个都是实测值，不猜。老命名文件（没有 sessionId）没有会话维度，不算。
 * @param {string} client 客户端身份（**这一路来源**的 client，如 trae / codebuddy）；空则不限
 * @param {{includeEnded?: boolean}} options 默认不返回收到 SessionEnd 的会话；CLI JSONL 清理时需要完整状态
 * @returns {Array<{sessionId: string, workspacePath: string, lastEventAt: number, endedAt: number}>}
 */
function listReporterSessions(client = '', { includeEnded = false } = {}) {
  const dir = path.join(reporterHookHome(), 'hooks');
  const byId = new Map();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!clientHit(client, j.client)) continue;
    const sessionId = String(j.sessionId || '').trim();
    if (!sessionId) continue;
    const sp = j.sessionPhase || {};
    const endedAt = Number(j.sessionEndedAt) || 0;
    const lastEventAt = Math.max(
      Number(j.hb && j.hb.lastEventAt) || 0,
      Number(sp.ts) || 0,
      Number(j.taskStartedAt) || 0
    );
    if (!lastEventAt) continue;
    const prev = byId.get(sessionId);
    const recordAt = Math.max(lastEventAt, endedAt);
    // 同一会话可能有多份状态文件（换过工程 / 老命名残留）：取最新那份的工程
    if (!prev || recordAt > prev.recordAt) {
      byId.set(sessionId, {
        sessionId,
        workspacePath: String(sp.workspacePath || j.sessionWorkspacePath || j.taskWorkspacePath || ''),
        lastEventAt,
        endedAt,
        recordAt,
      });
    }
  }
  return [...byId.values()].filter((s) => includeEnded || !s.endedAt);
}

/**
 * 当前"真正在敲"的工程：取 reporter hook 最近一次写相位 / task 的工程路径。
 * reporter 把相位打在 REAL_WS（它实际运行的工程），而不是 office 手工"打开工程"记的那个，
 * 所以这里用最新活动判定，避免 IDE 里直接开新工程时相位错归到旧工程（主控制台对不上下拉）。
 * 超过新鲜期（AWAIT_TTL_MS）视为失效，回落到传入的 fallback（通常是 office 当前打开的工程）。
 * @param {string} fallback 回落值
 * @returns {string}
 */
function freshestReporterWs(fallback, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  let best = '';
  let bestTs = 0;
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!sameSession(j, session)) continue;
    if (!clientHit(client, j.client)) continue;
    const sp = j.sessionPhase;
    const ts = (sp && sp.ts) || (j.taskId ? j.taskStartedAt || 0 : 0);
    const ws = (sp && sp.workspacePath) || j.taskWorkspacePath || '';
    if (!ws || !ts || now - ts > AWAIT_TTL_MS) continue;
    // 同上：只认本进程启动之后写入的相位，避免用上次运行的残留判定"当前工程"
    if (ts < SERVER_STARTED_AT) continue;
    if (ts > bestTs) {
      bestTs = ts;
      best = ws;
    }
  }
  return best ? path.resolve(best) : fallback ? path.resolve(fallback) : '';
}

/**
 * 主 Agent 阶段：会话落盘里没有"阶段"这个字段，只能推。
 * 所以返回值一律带 inferred: true，UI 按推断展示。
 */
function inferPhase({ todos, files, runtime, pending, lastUpdated, now, inWindow }) {
  // 活跃窗口 = reporter hook 的 UserPromptSubmit..Stop（本地状态文件 taskId 非空）。
  // 不在窗口内 → 一律待命：会话存在但没有事件，绝不凭空显示活跃状态。
  if (!inWindow) {
    return { phase: 'idle', action: '', inferred: true };
  }
  // 没有任何线索（没待办、没改文件、没运行态）→ 空闲
  if (!todos.total && !files.count && !runtime.activated) {
    return { phase: 'idle', action: '', inferred: true };
  }
  // 重启纪元：推断用的时间证据（文件改动 / 待办 / 运行态落盘）也必须是**本进程启动之后**的。
  // 否则"上次运行留下的最后一次文件改动"（仍在 BUSY_MS 窗口内）会在重启瞬间被判成「调用工具」，
  // 与"重启后先待命、等下一个新事件"相悖。与 readReporterPhase 用同一把尺子。
  const afterRestart = (ts) => Number(ts) >= SERVER_STARTED_AT;
  // 显式状态也只在"近期真有动静"时采信，避免 IDE 关掉后残留的运行态一直挂着
  if (runtime.paused && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'idle', action: '会话已暂停', inferred: true };
  }
  // 「等会话空闲后收尾」：插件把消息排到了这一轮结束之后再发，人没在干活 —— 报待命，
  // 把原因写在 action 上。以前这里报 summarize（「汇总中」），但那个相位真机上不产生
  // （演示脚本才有），留着会让"没在干活"看着像"正在汇总"（2026-10-01 去掉，见 renderer/src/iso/mainConsole.js）。
  if (runtime.awaitingSessionIdle && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'idle', action: '等会话空闲后收尾', inferred: true };
  }

  // 正在干活：必须"新鲜"证据，否则 IDE 关掉后残留的 in_progress 待办 / 文件改动会一直显示「工具中」
  if (todos.doing && afterRestart(todos.at) && now - todos.at < IDLE_MS) {
    return { phase: 'tool', action: todos.doing, inferred: true };
  }
  if (afterRestart(files.lastAt) && now - files.lastAt < BUSY_MS) {
    const f = files.recent[0];
    return { phase: 'tool', action: `改 ${f.name}（+${f.added}/-${f.removed}）`, inferred: true };
  }
  // 运行态极新鲜（插件最近在落盘）→ 这一轮对话真的在推进（含纯推理、只读工具等拿不到文件/待办证据的情况）。
  // 没有"正在调工具"的硬证据，只是知道在动，归到「思考中」——绝不凭空显示「调用工具」。
  if (afterRestart(lastUpdated) && now - lastUpdated < FRESH_MS) {
    return { phase: 'thinking', action: '', inferred: true };
  }

  // 有排队待发消息（且不是陈年残留）→ 待命 + 说明排队条数。
  // 以前报 plan（「规划中」），但排队消息不等于 agent 在规划 —— 同一个演示态，2026-10-01 一起去掉。
  if (pending > 0 && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'idle', action: `${pending} 条待发消息排队中`, inferred: true };
  }

  // 没有新动静：IDE 多半关了 / 在等用户。回空闲，不凭"激活过"瞎显示活跃相位
  return { phase: 'idle', action: '会话空闲', inferred: true };
}

/** 单个会话的完整信息 */
function sessionInfo(storage, id, { current = false, now = Date.now(), workspacePath = '', inWindow = false, client = '' } = {}) {
  // 结构化落盘（todos / file-changes / message-queue）的读取统一收口在 plugin.js，本文件只综合。
  const todos = plugin.readTodos(storage, id);
  const files = plugin.readFileChanges(storage, id);
  const mq = plugin.readRuntime(storage, id);
  const lastUpdated = Math.max(todos.at, files.lastAt, mq.updatedAt) || null;
  // 活跃 = 当前会话且近期有动静 / 运行态新鲜 / 刚改过文件。
  // 关键：关掉 IDE 后插件不再落盘，但 current.json 仍指向它、runtime.activated 也残留为真，
  // 所以不能只靠 current / activated 判定活跃，必须用"近期有写入"确认它真的还活着，
  // 否则关掉窗口的会话会一直卡在列表里、相位还停在某个活跃态。
  const active = Boolean(
    (current && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (mq.runtime.activated && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (files.lastAt && now - files.lastAt < BUSY_MS)
  );
  // 还在列表里（宽窗口，60 分钟）；active 仍是"热窗口"，只影响相位推断
  const listed = Boolean(lastUpdated && now - lastUpdated < LISTED_MS);
  const inferred = inferPhase({ todos, files, runtime: mq.runtime, pending: mq.pending, lastUpdated, now, inWindow });

  /** 悬浮屏第三层：任务清单（状态用符号标出来，不做翻译） */
  const mark = { completed: '✓', in_progress: '▶', pending: '·' };
  let phase = inferred.phase;
  let action = inferred.action;
  let target = '';
  let tool = '';
  let context = todos.items.map((t) => `${mark[t.status] || '·'} ${t.content}`);

  // 上报真值：reporter hook 把每个事件的相位（思考中 / 调用工具 / 等待授权）落到本地状态文件。
  // 优先级高于从 genie-history 推断的相位；只在"当前会话"上生效（相位必然出在这只 agent 身上）。
  let reported = false;
  let prompt = '';
  if (current && inWindow) {
    const rp = reporterMainPhase(workspacePath, client);
    if (rp) {
      reported = true;
      phase = rp.phase;
      action = rp.action;
      target = rp.target;
      context = rp.context;
      tool = rp.tool || '';
      prompt = rp.prompt || '';
    }
  }

  // 完成标记：reporter 仅在 Stop 时落盘（按工程 + 客户端区分），是"任务完成"的唯一真源；
  // 比"相位回落到空闲"可靠——任务中途因轮询间隙 / 跨工程串味出现空闲，绝不冒充完成。
  const done = readReporterDone(workspacePath, client) || null;
  const doneAt = done ? done.at : 0;
  const doneTitle = done ? done.title || '' : '';
  // 只挑"本轮任务开始之后"改过的文件：file-changes 是整个会话累积的，
  // 不筛会把上一轮（甚至更早）的改动当成"本次完成"——典型：这一轮只是 push，却显示上一轮改了多少文件。
  // done.startedAt 缺省（老数据）时不过滤，退回原来的"取最近几个"。
  const doneStartedAt = done ? Number(done.startedAt) || 0 : 0;
  const doneAll = done && done.cancelled
    ? [] // 被打断的那一轮常常什么都没改：不把整轮会话的文件改动算成"本次完成"
    : (done
      ? (Array.isArray(files.recent) ? files.recent.filter((f) => !doneStartedAt || Number(f.at) >= doneStartedAt) : [])
      : []);

  return {
    id,
    current,
    active,
    listed,
    // 有 runtime 说明插件还认这个会话；没有就是历史会话（只剩待办/改动的化石）
    live: Boolean(mq.hasRuntime),
    lastUpdated,
    runtime: mq.runtime,
    pending: mq.pending,
    todos: { total: todos.total, done: todos.done, doing: todos.doing, items: todos.items },
    files: { count: files.count, recent: files.recent, lastAt: files.lastAt || null },
    phase,
    action,
    target,
    tool,
    context,
    prompt,
    doneAt,
    doneTitle,
    doneCount: doneAll.length, // 本轮任务改动的文件数（在切片之前算）
    doneFiles: doneAll.slice(0, 6),
    // 这一轮是被打断收掉的（reporter 在 Interrupt 时落的 done.cancelled）：
    // 渲染层据此亮红色「任务取消」，不亮「任务完成」。
    doneCancelled: Boolean(done && done.cancelled),
    inferred: !reported, // 上报真值（reporter hook）不算推断
  };
}

/* ------------------------------ 对外：列会话 ------------------------------ */

/** 工程路径补全与 genie-history 工程归集的读取收口在 plugin.js（plugin.completeTruncatedWorkspace / plugin.collectProjects）。 */

/**
 * 列出**所有工程**里的活跃会话（不局限于当前打开的那个工程）。
 * @param {{workspacePath?: string, force?: boolean, client?: string, pluginRe?: RegExp[]}} o
 * @returns {{ok: true, sessions: Array, current: string, workspacePath: string,
 *            storage: string, reason?: string}}
 *   reason: 'no-storage' 没找到插件落盘 / 'no-open-project' 一个活跃会话都没有
 */
function listSessions({ workspacePath = '', force = false, client = '', pluginRe = plugin.PLUGIN_RE } = {}) {
  // 会话归属用的"当前工程"跟随 reporter 真实活动的最新工程，
  // 而不是 office 手工"打开工程"记的那个（IDE 里直接开新工程时两者会脱节）。
  // 只认传入的 client 这一路：这份清单属于某个插件楼层，别层（其它产品 / 同一产品的 CLI）
  // 在别的工程里活动不该决定这一层的"当前工程" —— 否则 mine / current / fresh 全被带偏。
  const ws = freshestReporterWs(workspacePath, client);
  const now = Date.now();
  // 缓存键必须覆盖 client / pluginRe / 工程，否则同一工程里的不同插件楼层、或 CLI/Plugin 视图
  // 会复用上一次的旧结果（例如 A5 里 plugin 那路读到先前写入的窗口值、误以为还在全局表里）。
  const key = `${client}@@${ws}@@${String(pluginRe instanceof RegExp ? pluginRe.source : Array.isArray(pluginRe) ? pluginRe.map((r) => (r && r.source) || String(r)).join('|') : String(pluginRe || ''))}`;
  if (!force && cache.value && cache.key === key && now - cache.at < TTL) return cache.value;

  const storage = plugin.findPluginStorage(pluginRe);
  if (!storage) {
    cache = {
      at: now,
      key,
      value: { ok: true, sessions: [], current: '', workspacePath: ws, storage: '', reason: 'no-storage' },
    };
    return cache.value;
  }

  /** 会话 id -> 归属（工程名 / 工程路径）。每个工程自己的"当前会话"单独记，
   *  不做成全局唯一 —— 这样多工程时每条工程里的活跃会话都能拿到自己 reporter 的实时相位，
   *  主控制台跟随下拉选中的那条，不再被全局"最后一个 reporter"覆盖。 */
  const meta = new Map();
  const perProjectCurrent = new Map(); // 工程路径 -> 该工程 current.json 指向的会话 id
  let currentId = '';
  // candidates 传"真实活动工程 + 本次查询的工程"，顺序即优先级（ws 放最前）：
  // genie-history 目录名可能被扩展截断，用它俩把半截路径补回完整路径（优先磁盘上真实存在的目录），
  // 否则工程名会显示成被截断后的残尾、currentId 落空，见 completeTruncatedWorkspace
  for (const p of plugin.collectProjects(storage, [ws, workspacePath])) {
    const cur = readJson(path.join(p.dir, 'current.json')) || {};
    const cid = cur && cur.conversationId ? String(cur.conversationId) : '';
    if (cid) {
      perProjectCurrent.set(p.path, cid);
      // 全局唯一的"当前会话"仍认真实活动工程（ws）里那条，用于默认选中 / 高亮
      if (p.path === ws) currentId = currentId || cid;
    }
    for (const id of readDir(path.join(p.dir, 'conversations'))) {
      if (id) meta.set(id, { project: p.project, projectPath: p.path });
    }
    if (cid && !meta.has(cid)) meta.set(cid, { project: p.project, projectPath: p.path });
  }

  // GitHub Copilot 这类真实插件落盘用 SQLite `session-store.db`，不是 `genie-history`：
  // 这里单独把它们并进同一张会话表，否则 9F 永远会被旧的 Tencent 目录吞掉、UI 不点亮。
  // 整段 Copilot SQLite 的读取 + enrich 在 copilot.js 的 readCopilotSessions 里做（plugin 来源统一收口）。
  const sqliteRows = copilot.readCopilotSessions(storage, { ws, now });
  const sqliteById = new Map();
  for (const row of sqliteRows) {
    if (!row || !row.id) continue;
    sqliteById.set(row.id, row);
    meta.set(row.id, { project: row.project, projectPath: row.projectPath });
    if (row.projectPath && row.projectPath === ws) currentId = currentId || row.id;
  }

  // 兜底：插件新版可能不写 genie-history，会话只在 todos / 消息队列里露过头。
  // 这类会话没有工程归属（project 留空），但它是"正在跑的那个"，不列出来更糟。
  for (const name of readDir(path.join(storage, 'todos'))) {
    const id = name.replace(/\.json$/i, '');
    if (id && !meta.has(id)) meta.set(id, { project: '', projectPath: '' });
  }

  const sessions = [];
  for (const [id, m] of meta) {
    const sqliteRow = sqliteById.get(id);
    const isProjectCurrent = id === (perProjectCurrent.get(m.projectPath) || '');
    // Copilot 没有 reporter hook，readReporterActiveTask 恒为空，相位只能推断（inferred）：
    //   ① 有 VS Code chat 索引的「这一轮在不在飞」→ 直接听它（跑着就是 thinking，收工就是 idle），
    //      这是唯一能看见"轮进行中"的旁证，见 readCopilotChatIndex；
    //   ② 没有旁证（老版本 / 库被占用）才退回 updated_at 的 COPILOT_PHASE_MS(2 分钟)窗口。
    // hasPendingTurn（空 assistant_response 的 turn）不单独使用 —— Copilot 是批次写入，
    // 放弃/取消的 turn 也留空 response，2 分钟外的空 turn 是已废弃不是正在跑。
    const reporterInWindow = readReporterActiveTask(m.projectPath, client);
    let info;
    if (sqliteRow) {
      // 整条 enrich 已在 copilot.readCopilotSessions 完成（phase / inFlight / doneAt / live* 系列），
      // 这里只叠加 reporter 这一层的 inWindow，以及统一"当前工程"口径（isProjectCurrent || projectPath===ws）。
      info = { ...sqliteRow, inWindow: reporterInWindow || sqliteRow.inWindow };
      info.current = Boolean(isProjectCurrent || (sqliteRow.projectPath && sqliteRow.projectPath === ws));
    } else {
      info = sessionInfo(storage, id, {
        current: isProjectCurrent,
        now,
        workspacePath: m.projectPath,
        inWindow: reporterInWindow,
        client,
      });
    }
    if (!info.listed) continue;
    sessions.push({
      ...info,
      project: m.project,
      projectPath: m.projectPath,
      mine: Boolean(ws) && m.projectPath === ws,
    });
  }
  sessions.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });

  cache = {
    at: now,
    key,
    value: {
      ok: true,
      sessions,
      current: currentId,
      workspacePath: ws,
      storage,
      ...(sessions.length ? {} : { reason: 'no-open-project' }),
    },
  };
  return cache.value;
}

/* ============================================================== 会话标题（原 sessionTitle.js，从 floors.js 迁入） */

/**
 * 会话标题：给"这一轮属于哪条会话"一个**会话级**的名字 —— 同一 session_id 的所有任务拿到同一个值，
 * 凭它把同一会话的多轮任务认出来（一轮 = 一行任务，一条会话通常有多轮；各轮自己的标题互不相同，
 * 只有会话标题是共同的）。
 *
 * 两条来源，按顺序取：
 *   1. 各楼层自己的会话标题（agent 起的摘要，与用户原话不同）：
 *        7F Kilo Code → SQLite session.title
 *        8F OpenCode  → SQLite session.title
 *        6F Qoder     → SQLite chat_session.session_title
 *      这些函数（kiloTitleOf / opencodeTitleOf / lingmaTitleOf）已经搬进各自的楼层文件（kilo.js /
 *      opencode.js / qoder.js），这里只从楼层注册表动态构建分发表。
 *   2. **兜底（所有楼层）**：这条会话第一轮的用户原话。
 *      会话开始时的标题就是用户原话 —— 1F/2F/3F/4F/5F/9F 没有第 1 条那种摘要列，但它们每一轮的
 *      prompt 都在 tasks.title 里，取同一 session_id 里**最早那一轮**的即可（见 sessionFirstPrompts()）。
 *
 * 纪律：任何一层查不到一律回空串，绝不冒泡、绝不编造。
 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 分发表**惰性构建并缓存**：凡是楼层模块导出了 sessionTitle 的，都按它的 client 与
 * client-plugin 两种身份注册。延迟到首次调用才构建，避免在模块加载期去读（没有 sessionTitle 的）
 * 楼层 exports 的属性，从而避开 Node 的循环依赖告警。
 * @returns {Array<{match: RegExp, fn: Function}>}
 */
let _routers = null;
function routers() {
  if (_routers) return _routers;
  const mods = /** @type {any[]} */ (Object.values(floorRegistry));
  _routers = mods
    .filter((mod) => typeof mod.sessionTitle === 'function' && mod.client)
    .map((mod) => ({ match: new RegExp('^' + escapeRegExp(mod.client) + '(?:-plugin)?$', 'i'), fn: mod.sessionTitle }));
  return _routers;
}

/**
 * 占位标题：Kilo 起会话时默认写的是 "New session - <ISO 时间戳>"（它自己占的位，不是摘要）。
 * 把它当"有标题"列出来，详情里就多一行时间戳，纯噪声 —— 一律当没有。
 */
const PLACEHOLDER_TITLE = /^new session\b/i;

/**
 * 根据 client 分发到对应楼层查 title。找不到、库没装、表结构变了、查出来是占位名一律回空串。
 * @param {string|null|undefined} sessionId
 * @param {string|null|undefined} client
 * @returns {string}
 */
function resolveSessionTitle(sessionId, client) {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  const c = String(client || '').trim();
  if (!c) return '';
  for (const r of routers()) {
    if (!r.match.test(c)) continue;
    const title = r.fn(sid);
    return title && !PLACEHOLDER_TITLE.test(title) ? title : '';
  }
  return '';
}

/* ------------------------------ 兜底：会话第一轮的用户原话 ------------------------------ */

/**
 * 老数据（hook 修掉之前）把 IDE 注入的那段上下文整段当标题存了下来 ——
 * `# Context from my IDE setup: ## Active file: …`。规则与前端 promptOf()、
 * hook 侧 userRequestText 保持一致：只在真出现那段上下文时才按「My request:」切开取后面。
 */
const IDE_INJECTED = [/^[ \t]*#{0,6}[ \t]*Context from my IDE setup\b/im, /^[ \t]*#{1,6}[ \t]*(?:Active file|Open tabs)\b/im];
const REQUEST_SPLIT = /^[ \t]*#{0,6}[ \t]*(?:My request|User request|Request|我的请求|用户请求)[ \t]*[:：][ \t]*$/im;

/** 一条 tasks.title → 用户原话（首行，够当标题用；过长截断，免得详情那一行撑爆） */
function userRequestOf(raw) {
  const s = String(raw || '').replace(/\r\n?/g, '\n');
  if (!s.trim()) return '';
  const text = IDE_INJECTED.some((re) => re.test(s)) ? (s.split(REQUEST_SPLIT).slice(1).join('\n') || '') : s;
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

/**
 * 一批会话各自"第一轮说了什么"（用户原话）。
 *
 * 只查一次：按 session_id 分组取 started_at 最小的那一轮 —— SQLite 的规矩是
 * `MIN()` 与裸列同用时，裸列取自 MIN 命中的那一行，所以 t.title 就是最早那轮的标题。
 *
 * @param {import('better-sqlite3').Database|null} raw 主库（只读用）
 * @param {string[]} sessionIds
 * @returns {Map<string, string>} 查不到的会话不在表里（调用方当"没有"）
 */
function sessionFirstPrompts(raw, sessionIds) {
  const out = new Map();
  const ids = [...new Set(sessionIds.map((s) => String(s || '').trim()).filter(Boolean))];
  if (!raw || !ids.length) return out;
  // 占位符别一次塞太多（SQLite 默认上限 999）：分批查
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const holes = chunk.map(() => '?').join(',');
    try {
      const rows = /** @type {Array<{ sid: string, title: string }>} */ (
        raw
          .prepare(
            `SELECT tr.session_id AS sid, t.title AS title, MIN(t.started_at) AS started_at
               FROM tasks t
               JOIN task_runs tr ON tr.id = t.id
              WHERE tr.session_id IN (${holes})
              GROUP BY tr.session_id`
          )
          .all(...chunk)
      );
      for (const r of rows) {
        const title = userRequestOf(r.title);
        if (title) out.set(String(r.sid), title);
      }
    } catch {
      /* 表结构变了 / 库被锁：这一批没有，调用方按"没有会话标题"走，不编造 */
    }
  }
  return out;
}

module.exports = {
  resolveSessionTitle, // 会话标题：按 client 派发到对应楼层模块（kilo/opencode/qoder 的 SQLite title）
  sessionFirstPrompts, // 兜底：一批会话各自第一轮用户原话（从 tasks 表取最早一轮）
  hasReporterState,
  reporterStateMeta,
  hasOtherLiveSession,// 成员状态降级前的守卫：这条会话停了，同产品的别的会话还在跑吗（见函数说明）
  readReporterDone,   // 完成标记（含 Codex 的收尾自述）：CLI 楼层靠它亮「任务完成」
  readReporterDones,  // 同上，但一次取回该 (工程, 客户端) 下所有会话的 —— 会话表扫盘用
  listReporterSessions, // 会话只能靠 hook 的楼层（5F TraeCode/ 1F CodeBuddy CLI）
  sessionModel,       // 这条会话在用什么模型（TraeCode 从 globalStorage 取，其余留空）
  listSessions,
  reporterMainPhase,
  freshestReporterWs,
  readReporterPhase, // 主控制台那口实时相位（打断后作废的逻辑在这里，回归测试直接盯它）
};
