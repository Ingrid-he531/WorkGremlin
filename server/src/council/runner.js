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
 *   · failed   —— could not start (ENOENT), non-zero exit, or output overflow. error carries the
 *                 **raw text**, do not dress it up.
 *   · timeout  —— killed when the time came.
 *   · unparsed —— exited normally, but stdout did not contain a parseable body. The raw tail is
 *                 retained so a truncated transcript can be diagnosed without guessing.
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
 *                    model:string|null, error:string|null, raw:string, durationMs:number,
 *                    exitCode:number|null}>}
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
      // Keep only the tail of stderr: CLI errors are usually those few lines, the progress output
      // before them is useless
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
        // Non-zero exit: attach the stderr tail, the UI has to be able to see right away why it
        // did not answer
        const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
        finish('failed', { error: `退出码 ${code}${tail ? `：${tail}` : ''}`, exitCode: code });
        return;
      }
      const parsed = parseOutput(stdout);
      if (!parsed.ok) {
        const tail = (stdout.trim() || stderr.trim()).split(/\r?\n/).slice(-4).join('\n');
        // Sizes and exit code are the difference between "the CLI printed nothing" and "the CLI was
        // cut off mid-write while still exiting 0" — the latter is what a truncated transcript looks like.
        const size = `stdout ${Buffer.byteLength(stdout, 'utf8')} 字节，stderr ${Buffer.byteLength(
          stderr,
          'utf8'
        )} 字节，退出码 ${code}`;
        finish('unparsed', {
          error: `输出解析不出内容（${size}）${tail ? `：${tail}` : '（stdout 是空的）'}`,
          exitCode: code,
          tokens: parsed.tokens,
          model: parsed.model,
          raw: utf8Tail(stdout || stderr),
        });
        return;
      }
      finish('ok', { text: parsed.text, tokens: parsed.tokens, model: parsed.model, exitCode: code });
    });

    if (arg.stdin != null && child.stdin) {
      child.stdin.on('error', () => {
        /* a child dying early makes the pipe write throw EPIPE, which is not the error to report (the exit-code path already covers it) */
      });
      child.stdin.end(arg.stdin, 'utf8');
    }
  });
}

module.exports = { runOnce, killTree, MAX_OUTPUT_BYTES, RAW_TAIL_BYTES };
