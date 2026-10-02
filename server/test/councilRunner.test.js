/**
 * 议事厅「单次调用」自检 —— 起**真的子进程**，但跑的是临时目录里的假 CLI（`#!/bin/sh` 桩）。
 *
 * 为什么不打真 CLI：真的那四家要花掉一次模型调用、几十秒，而且结果每次都不一样，
 * 没法拿来钉"超时会怎样""非零退出会怎样"。这里要验的是**进程管理**，不是模型：
 *   · 到点必须杀得掉，而且**连它拉起来的子进程一起杀**（这些 CLI 自己会再起服务进程，
 *     只杀主进程会留下孤儿占着资源）；
 *   · 非零退出 / 输出读不出，都要**如实记失败并留下错误原文** —— 不能返回半截内容
 *     假装它答完了（铁律：不允许编造）。真 CLI 的输出格式在第 7 步的烟测里对。
 *
 * 跑法：`npm run test:council-runner`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runOnce } = require('../src/council/runner');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-runner-'));

/** 造一个假 CLI。@returns {string} 可执行文件绝对路径 */
function stub(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 进程还活着吗（ESRCH = 已死） */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  // ------------------------------------------------------------------ 正常
  head('正常返回：读出正文与词元');
  {
    const bin = stub('ok.sh', `echo '{"result":"我的看法是可行。","usage":{"input_tokens":11,"output_tokens":4}}'`);
    const r = await runOnce({ bin, args: [], cwd: TMP, timeoutMs: 10_000, agent: 'x' });
    ok('status=ok', r.status === 'ok', r.error || '');
    ok('正文读到了', r.text === '我的看法是可行。', r.text);
    ok('词元读到了', r.tokens && r.tokens.input === 11 && r.tokens.output === 4);
    ok('退出码记着 0', r.exitCode === 0);
    ok('耗时有值', typeof r.durationMs === 'number' && r.durationMs >= 0);
  }

  // ------------------------------------------------------------------ 管道
  head('提示词走 stdin（长文本不进 argv）');
  {
    // 把 stdin 原样包进 JSON 吐回来，验证喂进去的东西没被截断 / 变形。
    // 这里必须用 python 拼 JSON：拿 shell 的 echo 拼，内容里的换行和引号会直接把 JSON 弄成非法的
    // （第一版就是这么写的，结果 runner 判"解析不出"是对的，错的是桩）。
    const bin = stub('echo-stdin.sh', `python3 -c 'import sys,json;print(json.dumps({"result": sys.stdin.read()}))'`);
    const prompt = `第一行\n第二行带 "引号" 和 $符号 和 \\反斜杠\n${'长'.repeat(500)}`;
    const r = await runOnce({ bin, args: [], stdin: prompt, cwd: TMP, timeoutMs: 10_000, agent: 'x' });
    ok('status=ok', r.status === 'ok', (r.error || '').slice(0, 200));
    ok('多行 / 特殊字符原样到达子进程', r.text.includes('第二行带 "引号" 和 $符号'), JSON.stringify((r.text || '').slice(0, 80)));
    ok('反斜杠没被吞', r.text.includes('\\反斜杠'));
    ok('长文本没有被截断', r.text.includes('长'.repeat(500)));
    ok('整段内容一字不差', r.text === prompt, `${(r.text || '').length} vs ${prompt.length}`);
  }

  // ------------------------------------------------------------------ 超时
  head('超时：杀掉进程，如实记 timeout');
  {
    const bin = stub('hang.sh', 'sleep 60');
    const t0 = Date.now();
    const r = await runOnce({ bin, args: [], cwd: TMP, timeoutMs: 600, agent: 'x' });
    const took = Date.now() - t0;
    ok('status=timeout', r.status === 'timeout', `${r.status} / ${r.error}`);
    ok('没有返回半截正文（超时就是拿不到这一票）', r.text === '');
    ok('错误里说明了为什么（界面要原样显示给用户）', /没有返回/.test(String(r.error)), String(r.error));
    ok('按时返回、没有干等 60s', took < 8_000, `${took}ms`);
  }

  // --------------------------------------------- 超时：子进程也要一起死
  head('超时杀的是**整组**：它自己拉起来的子进程不能留成孤儿');
  {
    // 桩自己再起一个后台子进程（模拟 CLI 内部再起服务），把它的 pid 写到文件里
    const pidFile = path.join(TMP, 'grandchild.pid');
    const bin = stub('hang-tree.sh', `sleep 60 &\necho $! > ${pidFile}\nsleep 60`);
    // 不能 await 完再查"它本来活着"：runOnce 返回时 SIGTERM 早发出去了（见下面注释），
    // 所以要在跑的过程中查一次，才知道"后来它死了"是**被杀掉的**而不是本来就没起来。
    const pending = runOnce({ bin, args: [], cwd: TMP, timeoutMs: 1_500, agent: 'x' });
    let gpid = 0;
    for (let i = 0; i < 60 && !gpid; i += 1) {
      await sleep(50);
      if (fs.existsSync(pidFile)) gpid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0;
    }
    ok('拿到孙子进程的 pid', gpid > 0, String(gpid));
    ok('超时之前，孙子进程确实活着', alive(gpid), `pid ${gpid} 已经不在了`);

    const r = await pending;
    ok('status=timeout', r.status === 'timeout', r.status);
    await sleep(1_200); // 留给 SIGTERM/SIGKILL 一点点时间落地
    ok('**孙子进程也死了**（只杀主进程的话这里会留孤儿）', alive(gpid) === false, `pid ${gpid} 仍活着`);
  }

  // ------------------------------------------------------------------ 失败
  head('非零退出：记失败，带上 stderr 原文');
  {
    const bin = stub('boom.sh', 'echo "认证失败：token 过期" >&2\nexit 3');
    const r = await runOnce({ bin, args: [], cwd: TMP, timeoutMs: 10_000, agent: 'x' });
    ok('status=failed', r.status === 'failed', r.status);
    ok('退出码记着 3', r.exitCode === 3, String(r.exitCode));
    ok('stderr 原文带回来了（用户要知道它为什么没答上来）', String(r.error).includes('认证失败：token 过期'), String(r.error));
    ok('text 是空的，不编内容', r.text === '');
  }
  head('输出读不出：记失败，不假装它答了');
  {
    const bin = stub('garbage.sh', 'echo "这不是 JSON，是一段日志"');
    const r = await runOnce({ bin, args: [], cwd: TMP, timeoutMs: 10_000, agent: 'x' });
    ok('status=failed', r.status === 'failed', r.status);
    ok('错误里点明是解析不出', /解析不出/.test(String(r.error)), String(r.error));
    ok('原文尾巴留着便于排障', String(r.error).includes('这不是 JSON'), String(r.error));
  }
  head('起不来：记失败，不抛异常');
  {
    const r = await runOnce({ bin: path.join(TMP, '根本不存在'), args: [], cwd: TMP, timeoutMs: 5_000, agent: 'x' });
    ok('status=failed', r.status === 'failed', r.status);
    ok('错误里说清是起进程失败', /起进程失败/.test(String(r.error)), String(r.error));
  }

  // ------------------------------------------------------------------ 隔离
  head('cwd 是调用方指定的（隔离靠这个，不靠改环境变量）');
  {
    const work = path.join(TMP, 'sandbox');
    fs.mkdirSync(work, { recursive: true });
    const bin = stub('pwd.sh', 'echo "{\\"result\\":\\"$(pwd)\\"}"');
    const r = await runOnce({ bin, args: [], cwd: work, timeoutMs: 10_000, agent: 'x' });
    ok('子进程确实跑在指定目录里', r.text === fs.realpathSync(work) || r.text === work, r.text);
  }
  head('env 是叠加不是替换（HOME 必须留着，登录凭据靠它）');
  {
    const bin = stub('env.sh', 'echo "{\\"result\\":\\"$HOME|$COUNCIL_PROBE\\"}"');
    const r = await runOnce({ bin, args: [], env: { COUNCIL_PROBE: 'yes' }, cwd: TMP, timeoutMs: 10_000, agent: 'x' });
    ok('HOME 还在（否则 CLI 会找不到登录态）', String(r.text).startsWith(process.env.HOME || '/'));
    ok('叠加的变量也到了', String(r.text).endsWith('|yes'), r.text);
  }

  console.log(`\n${fail ? '✗' : '✓'} council-runner: ${pass} 通过 / ${fail} 失败`);
  // 自己搭的台子自己拆：这套用例建了不少 stub 脚本与工作目录，不收拾的话 /tmp 里
  // 每跑一次就多留一份（攒了 21 个才被发现）。**失败时也拆** —— 排障看的是断言输出，不是这些。
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
