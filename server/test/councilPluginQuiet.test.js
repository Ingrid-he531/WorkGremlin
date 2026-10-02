/**
 * 上报插件（7F Kilo / 8F OpenCode）在 `WORKGREMLIN_DISABLE=1` 下必须彻底闭嘴 —— 自检。
 *
 * 为什么单独一个文件、为什么值得测：议事厅**工程模式**下参与者的 cwd 是用户的真实工程目录。
 * 隔离模式靠 cwd 在 /tmp 就够（上报出来的工程是那个一次性目录，办公室根本看不见）；
 * 工程模式下这条路断了 —— `~/.kilo` 里装着的这个插件会带着**真实工程路径**把参与者上报进去，
 * 于是参与者当场变成"你工程里的一个成员"，违反"隔离，只在议事厅看"。
 * 挡住它的就是我们自己代码里的那一行早退，所以要用机器钉住，而不是靠读代码时记得。
 *
 * 两条入口都要测（见 packages/reporter/src/plugin/index.js 的默认导出）：
 *   · `setup(ctx)`   —— 8F OpenCode，正常返回一个拆卸函数；
 *   · `server(input, options)` —— 7F Kilo，正常返回一个 Hooks 对象。
 * 两边**返回的形状**都不能变：Kilo 会校验 `server()` 的返回值
 * （给 `undefined` 可能被当成"插件加载失败"），OpenCode 会拿返回的东西当拆卸函数调。
 * 所以这里断言的不是"返回了假值"，而是"返回了契约要求的那种空壳"。
 *
 * 跑法：`npm run test:council-quiet-plugin`
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
const head = (t) => console.log(`\n${t}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-quiet-'));
const PLUGIN = path.resolve(__dirname, '..', '..', 'packages', 'reporter', 'src', 'plugin', 'index.js');

/**
 * 假服务端 + 一个记账的 fetch 替身。
 *
 * 两样都要，缺一不可：
 *   · 光有 fetch 替身不够 —— 插件会先 `enabled()`（读 server.json、探 PID 存活）再
 *     `resolveProject()`（GET /api/v1/workspace 拿工程名），拿不到工程就**静默不上报**。
 *     不搭这个台子，对照组会数出 0 个请求，看着像"被挡住了"，其实是它压根没打算发。
 *   · 光有假服务端也不够 —— 我们要断言的是"**没发起**"，而不是"发起了但失败"。
 */
const calls = [];
function installSpy() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, body: String((opts && opts.body) || '') });
    // 插件开机第一件事是拿工程名，拿不到就**静默不上报**（见插件里的 resolveProject）。
    // 这里如实回答它，否则对照组数出 0 个请求，看着像"被挡住了"。
    if (u.endsWith('/api/v1/workspace')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, project: 'FakeProject', workspacePath: '/home/somebody/real-project' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return () => {
    globalThis.fetch = real;
  };
}

(async () => {
  const restore = installSpy();
  // 插件读的是当前进程的 env（cli.js / hook.js 都这么读），所以锁在**本进程**上
  process.env.HOME = TMP;
  process.env.WORKGREMLIN_HOME = path.join(TMP, 'wg');
  fs.mkdirSync(process.env.WORKGREMLIN_HOME, { recursive: true });
  // server.json 要写得让插件**认为连得上**：端口随便填（真发请求也进不到网络，被上面的
  // fetch 替身接住），但 `pid` 必须是活的 —— 插件用它判"服务端是不是已经崩了"
  // （见插件里的 connect()），PID 探不到就会一路静默，对照组就白测了。
  fs.writeFileSync(
    path.join(process.env.WORKGREMLIN_HOME, 'server.json'),
    JSON.stringify({ port: 1, token: 'x', pid: process.pid })
  );

  const plugin = (await import(pathToFileURL(PLUGIN).href)).default;

  head('插件本身还是好的（不然下面的断言可能只是因为模块没加载起来）');
  ok('默认导出带 id（file:// 本地路径插件必须导出它）', plugin && plugin.id === 'workgremlin', String(plugin && plugin.id));
  ok('带 setup（8F OpenCode 的入口）', typeof plugin.setup === 'function');
  ok('带 server（7F Kilo 的入口）', typeof plugin.server === 'function');

  head('WORKGREMLIN_DISABLE=1 → 两条入口都不上报');
  process.env.WORKGREMLIN_DISABLE = '1';
  {
    calls.length = 0;
    const dispose = await plugin.setup({
      // 给一个**会真被订阅**的 ctx：挡不住的话这里会开始消费事件流并上报
      event: { subscribe: async function* () { throw new Error('不该有人订阅事件流'); } },
      options: {},
      location: { directory: '/home/somebody/real-project' },
    });
    ok('setup 返回的是函数（OpenCode 拿它当拆卸函数调）', typeof dispose === 'function', typeof dispose);
    ok('拆的时候不抛', (() => { try { dispose(); return true; } catch { return false; } })());
    ok('一个请求都没发出去', calls.length === 0, JSON.stringify(calls.map((c) => c.url)));
  }
  {
    calls.length = 0;
    const hooks = await plugin.server({ directory: '/home/somebody/real-project' }, {});
    // Kilo 会校验这个形状：能给 undefined 就别给 undefined
    ok('server 返回的是对象，不是 undefined（Kilo 会校验形状，给 undefined 可能被当成加载失败）',
      hooks !== null && typeof hooks === 'object', String(hooks));
    ok('一个请求都没发出去', calls.length === 0, JSON.stringify(calls.map((c) => c.url)));
  }

  head('对照组：不设那个变量时必须真的上报（否则上面两条是"整条路都坏了"才通过的）');
  delete process.env.WORKGREMLIN_DISABLE;
  {
    calls.length = 0;
    const hooks = await plugin.server({ directory: '/home/somebody/real-project' }, {});
    ok('server 照常返回带 event 的 Hooks 对象', typeof hooks.event === 'function', JSON.stringify(Object.keys(hooks || {})));
    // 喂一条真事件：它应该走到上报那一步（这里只验"路径是通的"，不断言具体上报内容 ——
    // 上报内容由 pluginIngest / kiloPluginE2E 那几个用例钉）。
    // 上报是 fire-and-forget 的（ensureRegistered 里先 await 解析工程），所以要**让出几拍**
    // 再数，不能紧接着就断言 —— 那样数出来的是 0，看着像"没上报"，其实是还没轮到。
    await hooks.event({ event: { type: 'session.created', properties: { sessionID: 'q1' } } });
    for (let i = 0; i < 50 && calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    ok('确实发起了请求（说明挡住的确实是我们那行早退）', calls.length > 0, String(calls.length));
  }

  restore();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail ? '✗' : '✓'} council-quiet-plugin: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
