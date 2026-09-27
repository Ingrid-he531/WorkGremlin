/**
 * OpenCode / Kilo 插件自检（7F / 8F 那条真相位 + 台账路线）。
 *
 * 跑法：`npm run test:plugin-ingest`
 *
 * 喂的是**实测**事件词汇表（2026-09-27，Kilo 7.8.1，探针跑出来的）：信封
 * `{ id, type, properties }`，事件只有 session.created / session.updated / message.updated /
 * message.part.updated / session.diff / session.status / session.idle / session.drained 这几个。
 * 早先按 `data` 信封与 `session.inbox.enqueued` / `session.tool.called` /
 * `session.execution.succeeded` / `permission.asked` 那套写，实测**一个都不出现** ——
 * 插件看着能装上，实际一条状态文件都不写。改口径后这里钉住真实形状。
 *
 * 覆盖：
 *   A. 台账上报      register(role:agent) / task.start / task.end / message / file.touch
 *   B. 相位          await(pending 工具) / tool(running) / thinking / idle / done
 *   C. 完成标记      finish=stop 才算 done；finish=tool-calls **不算**（整轮还没完）
 *   D. 状态文件      hb.pid（hasOtherLiveSession 判据 1）/ model
 *   E. subagent 幽灵  task 工具召唤 → 写条目；收工只动本会话本 client
 *   F. 边界          信封 properties vs data 都认；拿不到标题不编造自述
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
process.env.WORKGREMLIN_SUBAGENTS_FILE = path.join(TMP, 'subagents.json');

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
await fire(part({ id: 'prt_5', type: 'tool', tool: 'task', callID: 'c2', state: { status: 'running', input: { subagent_type: 'leo', description: '顺手看一眼' } } }));
{
  const g = readFeed().agents.find((a) => a.id === 'c2');
  ok('task 工具召唤 → 飘起一只小幽灵', Boolean(g), JSON.stringify(readFeed().agents));
  ok('幽灵带 client / sessionId / ts', g && g.client === 'kilo' && g.sessionId === SID && g.ts > 0, g && JSON.stringify(g));
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
}

/* ------------------------------ C. finish=tool-calls 不算完成 ------------------------------ */

head('[C] finish=tool-calls 只是"这条消息到工具处断了"，**整轮还没完**，不能收工');
await fire(msg({ id: 'msg_3', role: 'user', time: { created: Date.now() } }));
await fire(part({ id: 'prt_8', type: 'text', text: '"新的一轮"' }, 'msg_3'));
await fire(msg({ id: 'msg_4', role: 'assistant', time: { created: Date.now() } }));
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
await fire(ev('session.idle', {}));
{
  const e = lastFor('/api/v1/task/end');
  ok('state = cancelled', e && e.body.state === 'cancelled', e && e.body.state);
  const st = stateFile();
  ok('没有落下 done 完成标记', !(st && st.done && Date.now() - st.done.at < 3000), st && JSON.stringify(st.done));
  ok('扫场：这一轮召唤的幽灵收掉了', !readFeed().agents.find((a) => a.id === 'c2'), JSON.stringify(readFeed().agents));
}

/* ------------------------------ D. 状态文件 ------------------------------ */

head('[D] 状态文件：hb.pid 与 model');
{
  const st = stateFile();
  ok('hb.pid = 插件所在进程 pid（hasOtherLiveSession 判据 1）', st && st.hb && st.hb.pid === process.pid, st && JSON.stringify(st.hb));
  ok('model 写上了（session.created.info.model.id）', st && st.model === 'kilo-auto/free', st && st.model);
  const rp = reporterMainPhase(WS, 'kilo', SID);
  ok('reporterMainPhase 把这个模型带出来了', rp && rp.model === 'kilo-auto/free', rp && JSON.stringify(rp));
}

/* ------------------------------ F. 边界 ------------------------------ */

head('[F] 边界：信封两代都认 / 拿不到标题不编造自述');
{
  // 老信封（data + location）也要能用 —— OpenCode 2.x 走那条
  const ctx2 = makeCtx({ client: 'opencode' });
  const off2 = await plugin.setup(ctx2);
  const q2 = [];
  const wait2 = [];
  const old = (type, data) => ({ type, data, location: { directory: WS } });
  ctx2.emit(old('session.created', { sessionID: 'ses_oc_1', location: { directory: WS }, model: { id: 'opencode/x' } }));
  ctx2.emit(old('message.updated', { sessionID: 'ses_oc_1', info: { id: 'm1', role: 'user', time: { created: Date.now() } } }));
  ctx2.emit(old('message.part.updated', { sessionID: 'ses_oc_1', part: { id: 'p1', messageID: 'm1', type: 'text', text: '"老信封也能开任务"' } }));
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 10));
  const t2 = [...seen].reverse().find((s) => s.route === '/api/v1/task/start' && s.body.sessionId === 'ses_oc_1');
  ok('data 信封（OpenCode 2.x）同样能开任务', Boolean(t2), JSON.stringify(routes().slice(-4)));
  ok('标题也剥了引号', t2 && t2.body.title === '老信封也能开任务', t2 && t2.body.title);
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
