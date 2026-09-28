/**
 * WebSocket 重连自检：server 重启（换 token / 换端口）后，客户端必须带着**新的**鉴权重连。
 *
 * 背景（2026-09-28 实测的回归）：server 每次启动都换 token（见 server/src/config.js 的
 * newToken），而渲染层把"启动那一刻"的 url/token 吃死在重连闭包里 —— 断线（server 重启、
 * 应用重开）之后拿旧 token 重连，被服务端 bad_token 踢掉（close 4001），然后一直重连一直踢；
 * 同时所有 HTTP 轮询 401，界面就停在旧数据上不再更新。
 * 表现：跑着的任务在任务记录里"消失"，一直看不到「运行中」那条。
 *
 * 这里用假的 WebSocket 把这条路真跑一遍：第一次连接用 resolve 给的第一份鉴权，
 * 断线后必须重新问 resolve，并用它给的新 url/token 建立新连接（HELLO 也带新 token）；
 * resolve 抛错时不许把连接卡死，沿用上一份继续重试。
 *
 * 跑法：`npm run test:ws-reconnect`
 */
import { createConnection } from '../src/api/ws.js';

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 WebSocket：每次 new 都记下来，open/close 由测试手动触发 */
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this._ls = new Map();
    FakeWS.instances.push(this);
  }
  addEventListener(type, cb) {
    if (!this._ls.has(type)) this._ls.set(type, []);
    this._ls.get(type).push(cb);
  }
  emit(type, evt = {}) {
    for (const cb of this._ls.get(type) || []) cb(evt);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
}
FakeWS.instances = [];
globalThis.WebSocket = FakeWS;

const helloOf = (ws) => JSON.parse(ws.sent[0] || '{}');

let authRound = 0;
let resolveThrows = false;
const states = [];

const conn = createConnection({
  url: 'ws://127.0.0.1:1/ws',
  token: 'tok-0',
  project: null,
  resolve: async () => {
    if (resolveThrows) throw new Error('IPC 不通');
    authRound += 1;
    return { url: `ws://127.0.0.1:${authRound + 1}/ws`, token: `tok-${authRound}`, project: null };
  },
  onState: (st) => states.push(st.state),
});

(async () => {
  await sleep(10);
  console.log('\n[1] 第一次连接：用 resolve 给的那一份');
  ok('连上了 resolve 给的地址', FakeWS.instances.length === 1 && FakeWS.instances[0].url === 'ws://127.0.0.1:2/ws', FakeWS.instances[0] && FakeWS.instances[0].url);
  const ws1 = FakeWS.instances[0];
  ws1.open();
  ok('HELLO 带的是第 1 份 token', helloOf(ws1).token === 'tok-1', helloOf(ws1).token);
  ok('HELLO 先于其它帧发出（否则会被服务端当 bad token 踢）', helloOf(ws1).type === 'hello', helloOf(ws1).type);
  conn.subscribe({});
  ok('subscribe 排在 HELLO 之后', JSON.parse(ws1.sent[1] || '{}').type === 'subscribe', ws1.sent[1]);

  console.log('\n[2] 断线（server 重启）→ 必须重新问鉴权，带新 token 重连');
  ws1.close();
  ok('断线后状态回到 closed', states.includes('closed'), states.join(','));
  await sleep(1300); // 退避第一档 1s
  ok('自动重连（不是卡死）', FakeWS.instances.length === 2, `${FakeWS.instances.length} 个连接`);
  const ws2 = FakeWS.instances[1];
  ok('用新端口重连', ws2 && ws2.url === 'ws://127.0.0.1:3/ws', ws2 && ws2.url);
  ws2.open();
  ok('HELLO 带的是新 token（不是启动时吃死的旧 token）', helloOf(ws2).token === 'tok-2', helloOf(ws2).token);

  console.log('\n[3] resolve 抛错时不许把连接卡死：沿用上一份继续重试');
  resolveThrows = true;
  ws2.close();
  await sleep(2400); // 退避第二档 2s
  ok('照样重连上（用上一次已知的地址）', FakeWS.instances.length === 3, `${FakeWS.instances.length} 个连接`);
  const ws3 = FakeWS.instances[2];
  ws3.open();
  ok('HELLO 沿用上一份 token', helloOf(ws3).token === 'tok-2', helloOf(ws3).token);

  conn.close();
  await sleep(10);
  ok('close() 之后不再新增连接', FakeWS.instances.length === 3, `${FakeWS.instances.length} 个连接`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
