'use strict';

/**
 * 单次调用一个参与者 —— 起进程、喂提示词、收输出、**到点连它的子进程一起杀**。
 *
 * 这是仓库里第一处"服务端异步拉起并托管长驻子进程"的地方（别处的 child_process 都是
 * 启动期同步跑一下就完的，见 products.js 的 resolveCommand）。所以这里要自己把几件事做全：
 *
 *   · **杀进程组**，不只是杀直接子进程。这些 CLI 自己会再起一个服务进程/子进程，
 *     只 kill 主进程会留下孤儿占着端口和内存。detached 让它自成一个进程组，
 *     然后对 `-pid` 下手，整组一起死。
 *   · **输出有上限**。CLI 抽风时能吐几百 MB，不封顶就是把服务端内存赌上去。
 *     超了就杀掉并按「失败」如实记 —— 不是截一半假装它答完了。
 *   · **超时是"这一票拿不到"，不是"再等等"**：到点杀进程，返回值里 status='timeout'，
 *     调用方据此记「未表态」。绝不返回一个半截的答案。
 *
 * 返回值里的 status 只有三种：ok / failed / timeout。
 *   · ok       —— 进程正常退出**且**输出解析得出正文。text / tokens 才有意义。
 *   · failed   —— 起不来（ENOENT）、非零退出、输出读不出。error 里是**原文**，别加工。
 *   · timeout  —— 到点被杀。
 * 解析出正文但**没有**投票块的情况不在这里判：那是调用方的事（记 status='unparsed'），
 * 因为"说了话但没投票"和"根本没说话"要分得开。
 */

const { spawn } = require('node:child_process');

const { parseOutput } = require('./agents');

/** 单个进程的 stdout 上限：超过就杀掉。正常一轮发言几 KB，64MB 只可能是它在吐日志风暴 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** SIGTERM 之后留给它收拾的时间，再不走就 SIGKILL */
const KILL_GRACE_MS = 3_000;

const IS_WIN = process.platform === 'win32';

/**
 * 杀**整组**进程。POSIX 下子进程是 detached 起的（自成进程组），所以对它取负 pid。
 * 组已经没了（ESRCH）是正常情况，不算错。
 */
function killTree(child) {
  if (!child || child.pid == null || child.killed) return;
  if (IS_WIN) {
    // Windows 没有进程组信号，用 taskkill 连子进程一起收
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    } catch {
      /* 收不掉就算了，下面还有 kill 兜底 */
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* 组可能已经没了 */
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }, KILL_GRACE_MS).unref();
}

/**
 * 跑一次。
 *
 * @param {{bin:string, args?:string[], env?:object, stdin?:string|null, cwd:string,
 *          timeoutMs:number, agent:string, onChild?:(child:import('node:child_process').ChildProcess)=>void}} arg
 *   env 是**叠加**在 process.env 上的（登录凭据靠 HOME 找，不能替换）。
 *   onChild 在进程起来时被叫一次，把句柄交给调用方 —— 议事厅要能在用户点「取消」
 *   或服务关闭时杀掉在飞的进程，光靠超时是等不到的。
 * @returns {Promise<{status:'ok'|'failed'|'timeout', text:string, tokens:object|null,
 *                    error:string|null, durationMs:number, exitCode:number|null}>}
 */
function runOnce(arg) {
  const startedAt = Date.now();
  const timeoutMs = Number(arg.timeoutMs) > 0 ? Number(arg.timeoutMs) : 120_000;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(arg.bin, arg.args || [], {
        cwd: arg.cwd,
        env: { ...process.env, ...(arg.env || {}) },
        // 自成进程组，超时/取消时能连它拉起来的子进程一起收
        detached: !IS_WIN,
        stdio: [arg.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // spawn 同步抛（参数不合法等）—— 如实记，不吞
      resolve({ status: 'failed', text: '', tokens: null, error: `起进程失败：${err && err.message}`, durationMs: Date.now() - startedAt, exitCode: null });
      return;
    }

    // 句柄交给调用方（议事厅要能在取消 / 关服时主动杀掉，而不是干等超时）
    if (typeof arg.onChild === 'function' && child.pid != null) {
      try {
        arg.onChild(child);
      } catch {
        /* 调用方的回调出错不该影响这次调用 */
      }
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let overflow = false;
    let timedOut = false;

    const finish = (status, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        text: extra.text != null ? extra.text : '',
        tokens: extra.tokens != null ? extra.tokens : null,
        error: extra.error != null ? extra.error : null,
        durationMs: Date.now() - startedAt,
        exitCode: extra.exitCode != null ? extra.exitCode : null,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // 不在这儿 resolve：等 close 事件回来把真实退出码也收下（给排障留证据）。
      // 万一 close 迟迟不来（进程卡在不可中断状态），兜底再 resolve 一次。
      setTimeout(() => {
        if (!settled) finish('timeout', { error: `${Math.round(timeoutMs / 1000)}s 内没有返回，已终止该参与者`, exitCode: null });
      }, KILL_GRACE_MS + 2_000).unref();
    }, timeoutMs);

    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
      if (stdout.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        killTree(child);
      }
    });
    child.stderr.on('data', (b) => {
      // stderr 只留尾巴：CLI 的报错一般就那几行，前面的进度输出没用
      stderr += b.toString('utf8');
      if (stderr.length > 32 * 1024) stderr = stderr.slice(-32 * 1024);
    });

    child.on('error', (err) => {
      finish('failed', { error: `起进程失败：${err && err.message}` });
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish('timeout', { error: `${Math.round(timeoutMs / 1000)}s 内没有返回，已终止该参与者`, exitCode: code });
        return;
      }
      if (overflow) {
        finish('failed', { error: `输出超过 ${Math.round(MAX_OUTPUT_BYTES / 1024 / 1024)}MB，已终止该参与者`, exitCode: code });
        return;
      }
      if (code !== 0) {
        // 非零退出：把 stderr 尾巴带上，界面要能直接看到它为什么没答上来
        const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
        finish('failed', { error: `退出码 ${code}${tail ? `：${tail}` : ''}`, exitCode: code });
        return;
      }
      const parsed = parseOutput(stdout);
      if (!parsed.ok) {
        const tail = (stdout.trim() || stderr.trim()).split(/\r?\n/).slice(-4).join('\n');
        finish('failed', { error: `输出解析不出内容${tail ? `：${tail}` : '（stdout 是空的）'}`, exitCode: code, tokens: parsed.tokens });
        return;
      }
      finish('ok', { text: parsed.text, tokens: parsed.tokens, exitCode: code });
    });

    if (arg.stdin != null && child.stdin) {
      child.stdin.on('error', () => {
        /* 子进程提前死掉会让写管道报 EPIPE，不是我们要报的错（退出码那路已经覆盖） */
      });
      child.stdin.end(arg.stdin, 'utf8');
    }
  });
}

module.exports = { runOnce, killTree, MAX_OUTPUT_BYTES };
