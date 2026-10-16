/**
 * OpenCode / Kilo 插件自检（7F / 8F 那条真相位 + 台账路线）。
 *
 * 跑法：`npm run test:plugin-ingest`
 *
 * Two **measured** vocabularies are fed in:
 *   · Kilo 7.8.1 / OpenCode v1 (2026-09-27): envelope `{ id, type, properties }`, events
 *     session.created / session.updated / message.updated / message.part.updated / session.diff /
 *     session.status / session.idle / session.drained.
 *   · OpenCode v2 (2026-10-16, 2.0.30): envelope `{ id, created, type, location, data }`, vocabulary
 *     `session.*` (session.inbox.enqueued / session.tool.called / session.execution.succeeded /
 *     permission.asked …); none of the v1 names above are ever emitted. A plugin that knew only v1
 *     therefore did nothing on v2 (no state file, no ledger, no tool usage); the plugin now handles
 *     both, and this check pins down each.
 *
 * Coverage:
 *   A. ledger reports  register(role:agent) / task.start / task.end / message / file.touch
 *   B. phase           await(pending tool) / tool(running) / thinking / idle / done
 *   C. done marker     only finish=stop is done; finish=tool-calls is **not** (round not over)
 *   D. state file      hb.pid (hasOtherLiveSession criterion 1) / model
 *   E. subagent ghosts  `task` tool → entry; the sweep only touches this session's own client
 *   F. edges           both generations accepted; no title → no fabricated summary
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  — ${detail}`}`);
  }
}
function head(s) {
  console.log(`\n${s}`);
}

/* ------------------------------ 假 WorkGremlin 服务端 ------------------------------ */

const seen = [];
let server = null;
let port = 0;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          /* 非 JSON 不计 */
        }
        seen.push({ route: req.url, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/workspace') {
          res.end(JSON.stringify({ ok: true, project: 'projplugin', workspacePath: '/tmp/ProjPlugin' }));
          return;
        }
        res.end(JSON.stringify({ ok: true, taskId: body && body.taskId }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-plugin-'));
const WG = path.join(TMP, 'wg');
fs.mkdirSync(path.join(WG, 'hooks'), { recursive: true });
process.env.WORKGREMLIN_HOME = WG;

const WS = '/tmp/ProjPlugin';
const SID = 'ses_plugin_0001';

// 整段包在 async main 里：本文件混用 require（CJS）与 await（要 import ESM 插件），
// 顶层同时出现两者时 Node 判不出模块格式（ERR_AMBIGUOUS_MODULE_SYNTAX）。
async function main() {
await startServer();
fs.writeFileSync(
  path.join(WG, 'server.json'),
  JSON.stringify({ port, token: 'test-token', pid: process.pid })
);
const plugin = (await import(pathToFileURL(path.resolve(__dirname, '../../packages/reporter/src/plugin/index.js')))).default;
/**
 * **必须在任何事件之前** require services。
 *
 * sessions.js 在模块加载时记 `SERVER_STARTED_AT`，`readReporterPhase` 会把
 * `sessionPhase.ts` 早于它的状态文件当成「上次运行留下的残留」跳过（重启后不采信，
 * 这是有意的守卫）。要是先让插件写完状态文件再 require，那份文件的时间戳就比
 * SERVER_STARTED_AT 更早 —— 相位会被整条跳过，表现为模型取不到、reporterMainPhase 返 null。
 */
const { reporterMainPhase } = require('../src/sessions');

/**
 * 假的 ctx / 事件源。
 *
 * 迭代器必须**长驻**（没事件就挂着等），不能 `queue.shift()` 空了返回 done —— 插件里是
 * `for await (... subscribe())`，第一次 next() 拿到 done 那个循环就立刻退出，
 * 之后推的事件一个都收不到（表现为状态文件与台账全空）。
 * `push` 也不能既入队又唤醒等待者：那会把同一个事件交付两次。
 */
function makeCtx(options) {
  const queue = [];
  let waiting = null;
  const push = (v) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w({ done: false, value: v });
      return;
    }
    queue.push(v);
  };
  return {
    options: options || {},
    location: { directory: WS },
    event: {
      subscribe() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
                return new Promise((resolve) => {
                  waiting = resolve;
                });
              },
              return() {
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        };
      },
    },
    emit: push,
  };
}

let evtNo = 0;
/** 实测信封：{ id, type, properties } —— 没有 data、没有 location */
const ev = (type, properties) => ({ id: `evt_${(evtNo += 1)}`, type, properties: { sessionID: SID, ...properties } });

/** message.part.updated 的快捷构造（part 是实测形状） */
const part = (p, messageID = 'msg_1') =>
  ev('message.part.updated', { part: { messageID, sessionID: SID, ...p } });
/** message.updated 的快捷构造 */
const msg = (info) => ev('message.updated', { info: { sessionID: SID, ...info } });

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 10));
}

const ctx = makeCtx({ client: 'kilo' });
const dispose = await plugin.setup(ctx);
const fire = async (e) => {
  ctx.emit(e);
  await settle();
};

const stateFile = () => {
  const dir = path.join(WG, 'hooks');
  const f = fs.readdirSync(dir).find((n) => n.startsWith('kilo') && n.endsWith('.json'));
  return f ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
};
const routes = () => seen.map((s) => s.route);
const lastFor = (r) => [...seen].reverse().find((s) => s.route === r);
const feedPath = process.env.WORKGREMLIN_SUBAGENTS_FILE;
const readFeed = () => JSON.parse(fs.readFileSync(feedPath, 'utf8'));

/* ------------------------------ 真实一轮对话 ------------------------------ */

console.log('\n[0] 走一遍实测事件序列');
await fire(ev('session.created', { info: { id: SID, directory: WS, title: 'New session', model: { id: 'kilo-auto/free', providerID: 'kilo' } } }));
await fire(msg({ id: 'msg_1', role: 'user', time: { created: Date.now() } }));
await fire(part({ id: 'prt_1', type: 'text', text: '"把 7F 接进楼层表"' }));
ok('用户那句话开了任务', routes().includes('/api/v1/task/start'), JSON.stringify(routes()));
{
  const t = lastFor('/api/v1/task/start');
  ok('标题剥掉了外层 JSON 引号', t && t.body.title === '把 7F 接进楼层表', t && t.body.title);
}
await fire(part({ id: 'prt_2', type: 'reasoning', time: { start: Date.now(), end: Date.now() } }));
{
  const st = stateFile();
  ok('reasoning → 思考中', st && st.sessionPhase.phase === 'thinking', st && st.sessionPhase.phase);
  // 「思考中」屏上要显示用户那句话：服务端 readReporterPhase 读的就是这个 taskTitle
  // （见 sessions.js 的 winPrompt）。早先插件只抹 done、不写 taskTitle，
  // 于是 7F/8F 的「思考中」一个字都没有（别的楼层都有，因为它们的 hook 写了）。
  ok('taskTitle = 用户那句话（屏上「思考中」显示的就是它）', st && st.taskTitle === '把 7F 接进楼层表', st && JSON.stringify(st.taskTitle));
  const rp = reporterMainPhase(WS, 'kilo', SID);
  ok('reporterMainPhase 把它带成 prompt', rp && rp.prompt === '把 7F 接进楼层表', rp && JSON.stringify(rp && rp.prompt));
}
await fire(part({ id: 'prt_3', type: 'tool', tool: 'write', callID: 'c1', state: { status: 'pending', input: {} } }));
{
  const st = stateFile();
  ok('**tool/pending → 等待授权**（Kilo 的 tool 状态实测有 pending）', st && st.sessionPhase.phase === 'await', st && st.sessionPhase.phase);
}
await fire(part({ id: 'prt_3', type: 'tool', tool: 'write', callID: 'c1', state: { status: 'running', input: { filePath: `${WS}/b.ts` } } }));
{
  const st = stateFile();
  ok('tool/running → 调用工具', st && st.sessionPhase.phase === 'tool', st && st.sessionPhase.phase);
  const f = lastFor('/api/v1/file/touch');
  ok('写类工具报了 file/touch', Boolean(f), JSON.stringify(routes()));
  ok('文件路径取自入参', f && f.body.files[0] === `${WS}/b.ts`, f && JSON.stringify(f.body.files));
  ok('op = write', f && f.body.op === 'write', f && f.body.op);
}
await fire(part({ id: 'prt_4', type: 'tool', tool: 'read', callID: 'c0', state: { status: 'completed', input: { filePath: `${WS}/a.ts` } } }));
{
  const before = seen.filter((s) => s.route === '/api/v1/file/touch').length;
  ok('读类工具不报 file/touch（读了不留改动痕迹）', before === 1, `file/touch 共 ${before} 次`);
}
// 工具使用（任务详情「工具使用」）：同一个 callID 只记一次 —— 上面 c1 被 pending / running
// 更新过两次、c0 一次，都不该重复计数，pending 那次也不算"用过"。
{
  const uses = seen.filter((s) => s.route === '/api/v1/tool/use').map((s) => s.body);
  ok('工具使用上报：write(running) ×1 + read(completed) ×1', uses.length === 2, JSON.stringify(uses));
  ok('带工具名与当前任务 id', uses.every((u) => u.tool && u.taskId), JSON.stringify(uses));
  ok('pending 那一笔不算（还没放行）', !uses.some((u) => u.tool === 'write' && !u.taskId), JSON.stringify(uses));
}
await fire(part({ id: 'prt_5', type: 'tool', tool: 'task', callID: 'c2', state: { status: 'running', input: { subagent_type: 'leo', description: '顺手看一眼' } } }));
{
  const g = lastFor('/api/v1/ghost');
  ok('task 工具召唤 → 发 /ghost spawn（统一走服务端，不再本地写文件）', g && g.body && g.body.action === 'spawn', JSON.stringify(seen.filter((s) => s.route === '/api/v1/ghost').map((s) => s.body)));
  ok('幽灵请求带 client / sessionId / id / name', g && g.body.client === 'kilo' && g.body.sessionId === SID && g.body.id === 'c2' && g.body.name === 'leo', g && JSON.stringify(g.body));
}
// assistant 的 text part 要带 **assistant 那条 message 的 id**：角色是从 message.updated 记下来的，
// 挂错 messageID 就会被当成用户的话、又开一个任务
await fire(msg({ id: 'msg_2', role: 'assistant', time: { created: Date.now() } }));
await fire(part({ id: 'prt_6', type: 'text', text: '"改好了：3 处"' }, 'msg_2'));
await fire(ev('session.diff', { diff: ['b.ts'] }));
await fire(msg({ id: 'msg_2', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } }));
{
  const e = lastFor('/api/v1/task/end');
  ok('assistant finish=stop → 收了任务', Boolean(e) && e.body.state === 'done', e && e.body.state);
  ok('收尾自述 = assistant 的 text part', e && e.body.result === '改好了：3 处', e && e.body.result);
  ok('本轮改动文件带上了（session.diff）', e && Array.isArray(e.body.files) && e.body.files.includes('b.ts'), e && JSON.stringify(e.body.files));
  const m = lastFor('/api/v1/message');
  ok('收尾自述进了对话记录', m && m.body.content === '改好了：3 处' && m.body.type === 'result', m && JSON.stringify(m.body));
  const st = stateFile();
  ok('相位 = done', st && st.sessionPhase.phase === 'done', st && st.sessionPhase.phase);
  ok('完成标记带改动文件清单', st && st.done && Array.isArray(st.done.files), st && JSON.stringify(st.done));
  // 此时这轮正常收尾（未取消），相位新鲜 —— reporterMainPhase 应把模型带出来。
  const rp = reporterMainPhase(WS, 'kilo', SID);
  ok('reporterMainPhase 把这个模型带出来了', rp && rp.model === 'kilo-auto/free', rp && rp.model);
}

/* ------------------------------ C. finish=tool-calls 不算完成 ------------------------------ */

head('[C] finish=tool-calls 只是"这条消息到工具处断了"，**整轮还没完**，不能收工');
await fire(msg({ id: 'msg_3', role: 'user', time: { created: Date.now() } }));
await fire(part({ id: 'prt_8', type: 'text', text: '"新的一轮"' }, 'msg_3'));
await fire(msg({ id: 'msg_4', role: 'assistant', time: { created: Date.now() } }));
{
  // 轮中的一段 assistant 文字 → **思考中**，不是待命（实测 2026-09-28 修的坑）。
  // Kilo 一轮之内会多次吐 assistant 文字（每次工具调用前后都可能来一段），
  // 早先这里一律报 idle，于是任务还在跑、主 agent 却闪回「待命中」，
  // 几秒后又被下一条 tool 事件顶回「调用工具」—— 相位在两个值之间来回跳。
  // 其它楼层在这段间隙是回到思考中的（hook.js 的 PostToolUse 写 sessionPhase thinking）。
  const st = stateFile();
  ok('轮中的 assistant 文字 → 思考中（不是待命）', st && st.sessionPhase.phase === 'thinking', st && st.sessionPhase.phase);
  ok('不是 idle', !(st && st.sessionPhase.phase === 'idle'), st && st.sessionPhase.phase);
}
await fire(part({ id: 'prt_7', type: 'text', text: '"先看一眼"' }, 'msg_4'));
await fire(msg({ id: 'msg_4', role: 'assistant', finish: 'tool-calls', time: { created: Date.now(), completed: Date.now() } }));
{
  // 配对靠 taskId：title 是 task/start 送的，task/end 的 body 里没有 title 字段
  const started = [...seen].reverse().find((x) => x.route === '/api/v1/task/start' && x.body.title === '新的一轮');
  ok('这一轮开了新任务', Boolean(started), JSON.stringify(routes().slice(-3)));
  const tid = started && started.body.taskId;
  const endedFor = (id) => seen.some((x) => x.route === '/api/v1/task/end' && x.body.taskId === id);
  ok('finish=tool-calls 之后**这个任务还没被收**', !endedFor(tid), `taskId=${tid}`);
  await fire(msg({ id: 'msg_5', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } }));
  ok('随后的 finish=stop 才收它', endedFor(tid), `taskId=${tid}`);
}

/* ------------------------------ 中断 ------------------------------ */

head('[中断] session.idle 时任务还开着 → 收成 cancelled，不亮「任务完成」');
await fire(msg({ id: 'msg_6', role: 'user', time: { created: Date.now() } }));
await fire(part({ id: 'prt_9', type: 'text', text: '"被打断的一轮"' }, 'msg_6'));
// 这一轮已经吐出来的半句（assistant）—— 取消时要照常当"产出"记下来（与「任务完成」同一条线）
await fire(msg({ id: 'msg_6a', role: 'assistant', time: { created: Date.now() } }));
await fire(part({ id: 'prt_10', type: 'text', text: '"改到一半就被掐了"' }, 'msg_6a'));
await fire(ev('session.idle', {}));
{
  const e = lastFor('/api/v1/task/end');
  ok('state = cancelled', e && e.body.state === 'cancelled', e && e.body.state);
  ok('取消但这一轮有输出 → result 照常带上（不因"取消"丢掉产出摘要）', e && e.body.result === '改到一半就被掐了', e && e.body.result);
  const st = stateFile();
  // 被打断的一轮要落一枚**取消**标记（与 hook.js 的 Interrupt 同形，多一个 cancelled:true）：
  // 主控制台据此亮红色「任务取消」，而不是干等回待命，也绝不亮「任务完成」。
  ok('落下的是**取消**标记（done.cancelled 为真）', Boolean(st && st.done && st.done.cancelled === true), st && JSON.stringify(st.done));
  ok('取消标记是刚落的（at 在 3s 内）', Boolean(st && st.done && Date.now() - st.done.at < 3000), st && JSON.stringify(st.done));
  ok('取消标记也带上这一轮的输出（said）', Boolean(st && st.done && st.done.said === '改到一半就被掐了'), st && JSON.stringify(st.done && st.done.said));
  ok('取消标记带本轮改动文件清单（没有就是空数组，UI 显示「没有输出」）', Boolean(st && st.done && Array.isArray(st.done.files)), st && JSON.stringify(st.done && st.done.files));
  ok('扫场：收工发了 /ghost sweep（服务端负责清本会话幽灵）', seen.some((s) => s.route === '/api/v1/ghost' && s.body && s.body.action === 'sweep' && s.body.all === true && s.body.sessionId === SID && s.body.client === 'kilo'), JSON.stringify(seen.filter((s) => s.route === '/api/v1/ghost').map((s) => s.body)));

  // 打断后紧跟着一条迟到的 finish=stop：不许把红色「任务取消」盖成绿色「任务完成」
  await fire(msg({ id: 'msg_6b', role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } }));
  const st2 = stateFile();
  ok('迟到的 finish=stop 不许盖掉取消标记', Boolean(st2 && st2.done && st2.done.cancelled === true), st2 && JSON.stringify(st2.done));
}

/* ------------------------------ D. 状态文件 ------------------------------ */

head('[D] 状态文件：hb.pid 与 model');
{
  const st = stateFile();
  ok('hb.pid = 插件所在进程 pid（hasOtherLiveSession 判据 1）', st && st.hb && st.hb.pid === process.pid, st && JSON.stringify(st.hb));
  ok('model 写上了（session.created.info.model.id）', st && st.model === 'kilo-auto/free', st && st.model);
}

/* ------------------------------ F. 边界 ------------------------------ */

head('[F] 边界：两代信封都认 / OpenCode v2 事件词汇 / 拿不到标题不编造自述');
{
  // OpenCode v2 (measured 2026-10-16, 2.0.30): envelope {id,created,type,location,data} and the
  // `session.*` vocabulary — the v1 names (message.updated / message.part.updated) never appear.
  // Regression: the plugin used to know only v1, so on v2 it produced nothing at all (no state file,
  // no ledger, no tool usage).
  const ctx2 = makeCtx({ client: 'opencode' });
  const off2 = await plugin.setup(ctx2);
  const v2 = (type, data) => ({ type, data: { sessionID: 'ses_oc_1', ...data }, location: { directory: WS }, created: Date.now() });
  ctx2.emit(v2('session.created', { location: { directory: WS } }));
  ctx2.emit(v2('session.renamed', { title: 'v2 会话标题' }));
  ctx2.emit(v2('session.inbox.enqueued', { item: { type: 'user', payload: { text: '"v2 开任务"' } } }));
  ctx2.emit(v2('session.execution.started', {}));
  ctx2.emit(v2('session.step.started', { assistantMessageID: 'msg_v2_1', model: { id: 'opencode/z' } }));
  ctx2.emit(v2('session.tool.input.started', { assistantMessageID: 'msg_v2_1', id: 'call_v2_1', name: 'shell' }));
  ctx2.emit(v2('session.tool.called', { assistantMessageID: 'msg_v2_1', id: 'call_v2_1', input: { command: 'echo hi' } }));
  ctx2.emit(
    v2('session.step.ended', {
      assistantMessageID: 'msg_v2_1',
      finish: 'stop',
      tokens: { input: 11, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
      files: [],
    })
  );
  ctx2.emit(v2('session.execution.succeeded', {}));
  await settle();
  const t2 = [...seen].reverse().find((s) => s.route === '/api/v1/task/start' && s.body.sessionId === 'ses_oc_1');
  ok('v2 session.inbox.enqueued(user) 开任务', Boolean(t2), JSON.stringify(routes().slice(-6)));
  ok('标题也剥了引号', t2 && t2.body.title === 'v2 开任务', t2 && t2.body.title);
  const use2 = [...seen].reverse().find((s) => s.route === '/api/v1/tool/use' && s.body.sessionId === 'ses_oc_1');
  ok('v2 session.tool.called 记了工具使用（名字取自 tool.input.started）', Boolean(use2) && use2.body.tool === 'shell', JSON.stringify(use2 && use2.body));
  const end2 = [...seen].reverse().find((s) => s.route === '/api/v1/task/end' && s.body.sessionId === 'ses_oc_1');
  ok(
    'v2 session.execution.succeeded 收工（state=done，tokens 把 reasoning 并进 output）',
    Boolean(end2) && end2.body.state === 'done' && end2.body.tokens && end2.body.tokens.input === 11 && end2.body.tokens.output === 5,
    JSON.stringify(end2 && end2.body)
  );
  if (typeof off2 === 'function') off2();
}

if (typeof dispose === 'function') dispose();
if (server) server.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error('自检本身崩了：', e);
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
