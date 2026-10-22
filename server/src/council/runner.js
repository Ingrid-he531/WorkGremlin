'use strict';

/**
 * Invoke one participant once —— spawn it, feed it the prompt, collect the output, and
 * **kill it together with its children when time is up**.
 *
 * This is the first place in the repo where the server asynchronously spawns and supervises a
 * long-lived child process (elsewhere child_process is only used synchronously once at startup,
 * see resolveCommand in products.js). So a few things have to be done properly here:
 *
 *   · **Kill the process group**, not just the direct child. These CLIs spawn their own service /
 *     child processes, so killing only the main process leaves orphans holding ports and memory.
 *     Start it detached so it forms its own process group, then go after `-pid` so the whole group
 *     dies together.
 *   · **Cap the output**. A misbehaving CLI can spew hundreds of MB; without a cap we are betting
 *     the server's memory. It gets killed on overflow and recorded honestly as "failed" —— not
 *     cut in half and pretended to have finished.
 *   · **Timeout means "this turn did not answer", not "wait a bit more"**: kill the process when
 *     the time comes and return status='timeout'. Never return a half answer.
 *
 * There are four statuses in the return value: ok / failed / timeout / unparsed.
 *   · ok       —— the process exited normally **and** the output parses into body text. Only then
 *                 do text / tokens mean anything.
 *   · failed   —— could not start (ENOENT), non-zero exit, output overflow, or **exit 0 with nothing
 *                 on stdout** (the CLI itself reported an account/model/network error on stderr). error
 *                 carries the **raw text**, do not dress it up.
 *   · timeout  —— killed when the time came.
 *   · unparsed —— exited normally with stdout, but it did not contain a parseable body. The raw tail is
 *                 retained so a truncated transcript can be diagnosed without guessing.
 *
 * `errorKind` is a normalized label on top of the raw text (`auth` / `model` / `network` / `quota` /
 * `timeout` / `protocol` / ...). It exists because CodeBuddy, for example, exits 0 and prints a 400 on
 * stderr; calling that "unparsed" makes the user look for a parser bug instead of a dead model.
 * Body parsed but **no** structured block is not decided here: that is the caller's job (record
 * status='unparsed'), because "spoke but gave no plan/review" has to stay distinguishable from
 * "did not speak at all".
 */

const { spawn } = require('node:child_process');

const { parseOutput } = require('./agents');

/** stdout cap for a single process: exceeding it means get killed. A normal speech is a few KB, 64MB can only be a log storm */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Grace period after SIGTERM before SIGKILL */
const KILL_GRACE_MS = 3_000;
/** Raw stdout retained for an unparsed or failed turn */
const RAW_TAIL_BYTES = 64 * 1024;

const IS_WIN = process.platform === 'win32';

/**
 * Normalize the CLI's own error text into a stable failure class.
 *
 * This is intentionally keyword-based: every product prints a different sentence, and none of them
 * gives us a machine-readable error code on stderr. Classification never replaces the raw text — the
 * user still sees it verbatim; the kind only decides retry policy and the UI label.
 *
 * @param {string} text stderr (plus stdout when stderr is empty, for CLIs that log on stdout)
 * @returns {string} one of DEFAULTS.COUNCIL_ERROR_KINDS, or 'provider' when nothing matches
 */
function classifyProviderError(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (!s.trim()) return 'provider';
  if (/(401|403|unauthorized|unauthenticated|not logged in|need to sign in|sign in to use|login required|invalid api key|api key .*(missing|invalid)|authentication failed|认证失败|未登录|登录已过期)/.test(s)) {
    return 'auth';
  }
  if (/(model .*(not supported|not found|not available|does not exist|unknown)|requested model|unknown model|no such model|model_not_found|unrecognized_model|模型.*(不支持|不存在|不可用))/.test(s)) {
    return 'model';
  }
  if (/(429|rate limit|too many requests|quota|insufficient.*(credit|balance)|out of credits|限流|额度|余额不足)/.test(s)) {
    return 'quota';
  }
  if (/(econnrefused|econnreset|etimedout|enotfound|eai_again|fetch failed|network error|request timed out|reconnecting|connect timeout|connection reset|socket hang up|网络|连接超时)/.test(s)) {
    return 'network';
  }
  return 'provider';
}

/** The most useful raw line(s) from stdout/stderr for a "the CLI spoke but never produced a body" error. */
function errorTail(stdout, stderr, maxLines = 4) {
  return String(stdout || stderr || '')
    .trim()
    .split(/\r?\n/)
    .slice(-maxLines)
    .join('\n');
}

/** Keep the last N UTF-8 bytes without starting in the middle of a code point. */
function utf8Tail(value, maxBytes = RAW_TAIL_BYTES) {
  const text = String(value == null ? '' : value);
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

/**
 * Kill the **whole group**. On POSIX the child was started detached (its own process group), so use
 * its negated pid. A group that is already gone (ESRCH) is normal, not an error.
 */
function killTree(child) {
  if (!child || child.pid == null || child.killed) return;
  if (IS_WIN) {
    // Windows has no process-group signals, use taskkill to reap children along with it
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    } catch {
      /* fine if it cannot be reaped, there is still a kill fallback below */
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* the group may already be gone */
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }, KILL_GRACE_MS).unref();
}

/**
 * Run it once.
 *
 * @param {{bin:string, args?:string[], env?:object, stdin?:string|null, cwd:string,
 *          timeoutMs:number, agent:string, onChild?:(child:import('node:child_process').ChildProcess)=>void}} arg
 *   env is **layered on top of** process.env (login credentials are found via HOME, it must not
 *   replace them).
 *   onChild is called once when the process is up, handing the handle to the caller —— the council
 *   has to be able to kill in-flight processes when the user hits "cancel" or the server closes;
 *   a timeout alone would never get there in time.
 * @returns {Promise<{status:'ok'|'failed'|'timeout'|'unparsed', text:string, tokens:object|null,
 *                    model:string|null, error:string|null, errorKind:string|null, raw:string,
 *                    durationMs:number, exitCode:number|null}>}
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
        // Own process group, so on timeout/cancel everything it spawned can be reaped together
        detached: !IS_WIN,
        stdio: [arg.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // spawn throws synchronously (invalid arguments, etc.) —— record it honestly, do not swallow
      resolve({
        status: 'failed',
        text: '',
        tokens: null,
        model: null,
        error: `起进程失败：${err && err.message}`,
        errorKind: 'spawn',
        raw: '',
        durationMs: Date.now() - startedAt,
        exitCode: null,
      });
      return;
    }

    // Hand the handle to the caller (the council has to be able to kill proactively on cancel /
    // shutdown instead of just waiting for the timeout)
    if (typeof arg.onChild === 'function' && child.pid != null) {
      try {
        arg.onChild(child);
      } catch {
        /* an error in the caller's callback must not affect this invocation */
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
        model: extra.model != null ? extra.model : null,
        error: extra.error != null ? extra.error : null,
        errorKind: extra.errorKind != null ? extra.errorKind : null,
        raw: extra.raw != null ? extra.raw : utf8Tail(stdout),
        durationMs: Date.now() - startedAt,
        exitCode: extra.exitCode != null ? extra.exitCode : null,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Do not resolve here: wait for the close event so the real exit code is captured too
      // (evidence for troubleshooting).
      // If close never comes (the process is stuck uninterruptible), resolve once as a fallback.
      setTimeout(() => {
        if (!settled) {
          const kind = classifyProviderError(`${stderr}\n${stdout}`);
          finish('timeout', {
            error: `${Math.round(timeoutMs / 1000)}s 内没有返回，已终止该参与者`,
            errorKind: kind === 'network' ? 'network' : 'timeout',
            exitCode: null,
          });
        }
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
      // Keep only the tail of stderr: CLI errors are usually those few lines, the progress output
      // before them is useless
      stderr += b.toString('utf8');
      if (stderr.length > 32 * 1024) stderr = stderr.slice(-32 * 1024);
    });

    child.on('error', (err) => {
      finish('failed', { error: `起进程失败：${err && err.message}`, errorKind: 'spawn' });
    });

    child.on('close', (code) => {
      if (timedOut) {
        const kind = classifyProviderError(`${stderr}\n${stdout}`);
        finish('timeout', {
          error: `${Math.round(timeoutMs / 1000)}s 内没有返回，已终止该参与者`,
          errorKind: kind === 'network' ? 'network' : 'timeout',
          exitCode: code,
        });
        return;
      }
      if (overflow) {
        finish('failed', {
          error: `输出超过 ${Math.round(MAX_OUTPUT_BYTES / 1024 / 1024)}MB，已终止该参与者`,
          errorKind: 'output_limit',
          exitCode: code,
        });
        return;
      }
      if (code !== 0) {
        // Non-zero exit: attach the stderr tail, the UI has to be able to see right away why it
        // did not answer. The kind is still classified from the output, because "exit 1 + 401" is an
        // auth problem, not a generic process failure.
        const tail = errorTail('', stderr);
        const kind = classifyProviderError(`${stderr}\n${stdout}`);
        finish('failed', {
          error: `退出码 ${code}${tail ? `：${tail}` : ''}`,
          errorKind: kind === 'provider' ? 'exit' : kind,
          exitCode: code,
        });
        return;
      }
      // Exit 0 with an empty stdout is the shape CodeBuddy uses for "the model is gone": it prints the
      // 400 on stderr and still exits 0. Treat it as a provider failure, not as a protocol failure —
      // otherwise the UI says "output could not be parsed" and sends the user hunting for a parser bug.
      const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(stderr, 'utf8');
      if (!stdout.trim()) {
        const kind = classifyProviderError(stderr);
        const detail = errorTail('', stderr) || '（stdout 和 stderr 都是空的）';
        finish('failed', {
          error: `命令行没有输出正文（stdout ${stdoutBytes} 字节，stderr ${stderrBytes} 字节，退出码 ${code}）：${detail}`,
          errorKind: kind,
          exitCode: code,
          raw: utf8Tail(stderr),
        });
        return;
      }
      const parsed = parseOutput(stdout);
      if (!parsed.ok) {
        const tail = errorTail(stdout, stderr);
        // Sizes and exit code are the difference between "the CLI printed nothing" and "the CLI was
        // cut off mid-write while still exiting 0" — the latter is what a truncated transcript looks like.
        const size = `stdout ${stdoutBytes} 字节，stderr ${stderrBytes} 字节，退出码 ${code}`;
        finish('unparsed', {
          error: `输出解析不出内容（${size}）${tail ? `：${tail}` : '（stdout 是空的）'}`,
          errorKind: 'protocol',
          exitCode: code,
          tokens: parsed.tokens,
          model: parsed.model,
          raw: utf8Tail(stdout || stderr),
        });
        return;
      }
      finish('ok', {
        text: parsed.text,
        tokens: parsed.tokens,
        model: parsed.model,
        errorKind: null,
        exitCode: code,
      });
    });

    if (arg.stdin != null && child.stdin) {
      child.stdin.on('error', () => {
        /* a child dying early makes the pipe write throw EPIPE, which is not the error to report (the exit-code path already covers it) */
      });
      child.stdin.end(arg.stdin, 'utf8');
    }
  });
}

module.exports = {
  runOnce,
  killTree,
  classifyProviderError,
  MAX_OUTPUT_BYTES,
  RAW_TAIL_BYTES,
};
