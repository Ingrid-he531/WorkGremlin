'use strict';

/**
 * Remote dispatch service (reverse control, conservative): a **session** on one floor, driven by a
 * client, executed on this machine.
 *
 * The unit is a session, not a one-shot request:
 *   · a session owns one product session id (OpenCode `ses_…` / Claude UUID);
 *   · each prompt is a turn; a turn is one headless CLI process (`opencode run`, `claude -p`);
 *   · a session has a floor default, and every turn may choose its own permission mode
 *     (OpenCode: auto; Claude: its permission modes);
 *   · a turn may pin its own `--model`; an empty choice leaves the model to the floor's own default;
 *   · stdout is streamed to clients (`dispatch.output`), so the UI shows progress while it runs.
 *
 * What it does NOT do: it never writes members / tasks / task_runs. The spawned CLI is a normal,
 * persistent session in the target directory, so the floor's own hooks or the poller record it
 * exactly like a manual run. This service only owns the session/turn lifecycle, the timeout, and
 * cancellation.
 *
 * `confirm` mode parks each turn until someone on the server machine approves it (the route enforces
 * loopback); `auto` starts immediately. The policy itself comes from ~/.workgremlin/config.json
 * (see control/config.js) — never from a client setting.
 *
 * The conversation list is **persisted** to `~/.workgremlin/dispatch-sessions.json` (prompts, output
 * tails, the minted product session id), so restarting the server — or opening a client later —
 * restores the sessions and can keep talking in the same product session. A turn that was running
 * when the server died is marked failed on restore, and a still-pending one expires; nothing is
 * presented as if it had finished. The real conversation still lives in the product's own store too.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

const { DEFAULTS, WS_EVENTS } = require('@workgremlin/shared');
const { atomicWriteJson, readJson } = require('@workgremlin/shared/fslock');
const { dispatchStorePath } = require('@workgremlin/shared/paths');
const { killTree } = require('../council/runner');
const { recipeOf: defaultRecipeOf, binOf: defaultBinOf } = require('./recipes');
const { readDispatchConfig } = require('./config');

/** Output kept for a finished turn and for the detail endpoint (streaming itself is not capped) */
const OUTPUT_MAX_BYTES = 200 * 1024;
/** The model catalog is a read-only convenience: cache it per floor so a picker refresh cannot spawn a CLI per keystroke */
const MODELS_TTL_MS = 60_000;
const STATES = Object.freeze(['pending', 'running', 'done', 'failed', 'timeout', 'cancelled', 'rejected', 'expired']);

/** @param {Error & {code?: string}} err */
function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/** Strip ANSI escapes / carriage-return redraws so the transcript is readable in a <pre>. */
function cleanOutput(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+$/gm, '');
}

/** Per-chunk cleanup: strip terminal escapes but keep spaces (streaming text must not glue words). */
function cleanChunk(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * Parse `opencode models` output: one `provider/model` reference per line. Blank lines and CLI
 * banners / warnings are dropped; duplicates are collapsed (the same ref may be listed twice).
 * @param {string} text
 * @returns {string[]}
 */
function parseModelList(text) {
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const ref = line.trim();
    if (!ref || !ref.includes('/')) continue;
    seen.add(ref);
  }
  return [...seen];
}

/**
 * Default model catalog reader: the floor's CLI prints one `provider/model` reference per line.
 * Using the CLI (instead of a bundled list) keeps the picker aligned with the account, providers and
 * variants actually available on this machine. Failures are reported, never thrown: the picker can
 * still offer "default model" when the CLI is briefly unavailable.
 * @param {string} bin
 * @returns {Promise<{models: string[], error: string}>}
 */
function defaultFetchModels(bin) {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['models'],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env } },
      (err, stdout) => {
        if (err) {
          resolve({ models: [], error: String((err && err.message) || err) });
          return;
        }
        resolve({ models: parseModelList(stdout), error: '' });
      }
    );
  });
}

/**
 * Default runner: spawn, stream stdout/stderr, keep the tail, kill the whole process group on timeout.
 * @param {{bin: string, args: string[], cwd: string, timeoutMs: number, stdin?: string|null,
 *          onChild?: Function, onData?: (chunk: string) => void}} arg
 */
function defaultRun({ bin, args, cwd, timeoutMs, stdin, onChild, onData }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env },
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ status: 'failed', exitCode: null, error: `起进程失败：${err && err.message}`, stdout: '', stderr: '' });
      return;
    }
    try {
      if (child.stdin) child.stdin.end(stdin == null ? '' : String(stdin));
    } catch {
      /* a closed stdin is not a reason to fail the run */
    }
    if (onChild) {
      try {
        onChild(child);
      } catch {
        /* the caller's bookkeeping must not kill the run */
      }
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const push = (kind, chunk) => {
      const text = chunk.toString('utf8');
      if (kind === 'out') stdout += text;
      else stderr += text;
      if (onData) {
        try {
          onData(text);
        } catch {
          /* a broken listener must not stop the process */
        }
      }
    };
    child.stdout.on('data', (d) => push('out', d));
    child.stderr.on('data', (d) => push('err', d));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1000, timeoutMs));
    timer.unref();

    const done = (status, exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, exitCode, stdout, stderr, error: error || '', durationMs: Date.now() - startedAt });
    };

    child.on('error', (err) => done('failed', null, String((err && err.message) || err)));
    child.on('close', (code) => {
      if (timedOut) return done('timeout', code, '超时，已终止进程');
      if (code === 0) return done('ok', 0, '');
      return done('failed', code, (stderr || stdout).slice(-2000) || `退出码 ${code}`);
    });
  });
}

/**
 * @param {{
 *   repo?: {insertEvent?: {run: Function}},
 *   broadcast?: (project: string|null, type: string, payload: unknown) => void,
 *   readConfig?: () => {mode: string, file?: string},
 *   runCommand?: typeof defaultRun,
 *   binFor?: (floor: string) => string|null,
 *   recipeFor?: (floor: string) => any,
 *   now?: () => number,
 *   mintSessionId?: () => string,
 *   storeFile?: string|null,
 * }} [deps]
 */
function createDispatchService(deps = {}) {
  const broadcast = deps.broadcast || (() => {});
  const runCommand = deps.runCommand || defaultRun;
  const binFor = deps.binFor || defaultBinOf;
  const recipeFor = deps.recipeFor || defaultRecipeOf;
  const now = deps.now || (() => Date.now());
  const readConfig = deps.readConfig || (() => readDispatchConfig());
  const fetchModels = deps.fetchModels || defaultFetchModels;
  const mintSessionId =
    deps.mintSessionId || (() => `ses_wg${crypto.randomBytes(12).toString('hex')}`);
  // `null`/'' disables persistence (tests); undefined means the real store.
  const storeFile = deps.storeFile === undefined ? dispatchStorePath() : deps.storeFile;
  const insertEvent =
    deps.insertEvent ||
    ((projectId, tsMs, kind, payloadJson) => {
      try {
        if (deps.repo && deps.repo.insertEvent) deps.repo.insertEvent.run(projectId, tsMs, kind, payloadJson);
      } catch {
        /* an audit row must never break the dispatch itself */
      }
    });

  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** floor -> { at, value: {floor, models, error} } */
  const modelsCache = new Map();
  let disposed = false;
  let persistTimer = null;

  function emit(payload) {
    broadcast(null, WS_EVENTS.DISPATCH, payload);
  }

  /**
   * Snapshot for the on-disk store. Runtime handles (child / timers / deadlines) are dropped;
   * output is already capped per turn.
   */
  function snapshot() {
    return {
      version: 1,
      sessions: [...sessions.values()].map((session) => ({
        id: session.id,
        floor: session.floor,
        workspacePath: session.workspacePath,
        model: session.model || null,
        permission: session.permission || null,
        title: session.title || '',
        productSessionId: session.productSessionId || session.opencodeSessionId || '',
        opencodeSessionId: session.opencodeSessionId || null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        turns: session.turns.map((turn) => ({
          id: turn.id,
          prompt: turn.prompt,
          state: turn.state,
          mode: turn.mode,
          model: turn.model || '',
          permission: turn.permission || null,
          createdAt: turn.createdAt,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          error: turn.error || '',
          exitCode: turn.exitCode == null ? null : turn.exitCode,
          output: turn.output || '',
        })),
      })),
    };
  }

  function flushPersist() {
    if (!storeFile) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    try {
      atomicWriteJson(storeFile, snapshot(), { pretty: false });
      // Transcripts contain prompts and agent output: keep the file private to this user.
      fs.chmodSync(storeFile, 0o600);
    } catch {
      /* losing the cache must not break a running turn */
    }
  }

  /** Debounced write: output arrives in many small chunks and must not hit the disk per chunk. */
  function persistSoon() {
    if (!storeFile || persistTimer || disposed) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushPersist();
    }, 500);
    if (persistTimer.unref) persistTimer.unref();
  }

  /**
   * Restore the sessions written by a previous server process.
   * A turn that was `running`/`pending` when the process died cannot still be alive: mark it failed
   * (or expired) honestly instead of pretending it finished.
   */
  function restore() {
    if (!storeFile) return;
    const raw = readJson(storeFile, null);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) return;
    const ts = now();
    for (const entry of raw.sessions) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id || '');
      const floor = String(entry.floor || '');
      const productSessionId = String(entry.productSessionId || entry.opencodeSessionId || '');
      const recipe = recipeFor(floor);
      if (!id || !DEFAULTS.DISPATCH_FLOORS.includes(floor) || !productSessionId || !recipe) continue;
      const permissions =
        Array.isArray(recipe.permissions) && recipe.permissions.length
          ? recipe.permissions
          : ['auto'];
      const permission = permissions.includes(entry.permission)
        ? entry.permission
        : recipe.defaultPermission || permissions[0];
      const turns = (Array.isArray(entry.turns) ? entry.turns : []).map((t) => {
        const state = STATES.includes(t && t.state) ? t.state : 'failed';
        let finalState = state;
        let error = String((t && t.error) || '');
        let endedAt = Number.isFinite(Number(t && t.endedAt)) ? Number(t.endedAt) : null;
        if (state === 'running') {
          finalState = 'failed';
          error = '服务重启，执行中的这一轮已中断';
          endedAt = endedAt || ts;
        } else if (state === 'pending') {
          finalState = 'expired';
          error = '服务重启，待确认的请求已失效';
          endedAt = endedAt || ts;
        }
        return {
          id: String((t && t.id) || crypto.randomUUID()),
          prompt: String((t && t.prompt) || ''),
          state: finalState,
          mode: DEFAULTS.DISPATCH_MODES.includes(t && t.mode) ? t.mode : 'auto',
          model: String((t && t.model) || ''),
          permission: permissions.includes(t && t.permission) ? t.permission : permission,
          createdAt: Number(t && t.createdAt) || ts,
          startedAt: Number(t && t.startedAt) || null,
          endedAt,
          error,
          exitCode: Number.isInteger(t && t.exitCode) ? t.exitCode : null,
          output: String((t && t.output) || '').slice(-OUTPUT_MAX_BYTES),
          pendingDeadline: null,
          child: null,
          expiryTimer: null,
        };
      });
      sessions.set(id, {
        id,
        floor,
        workspacePath: String(entry.workspacePath || ''),
        model: entry.model ? String(entry.model) : null,
        permission,
        title: String(entry.title || ''),
        productSessionId,
        opencodeSessionId: floor === '8F' ? productSessionId : entry.opencodeSessionId || null,
        createdAt: Number(entry.createdAt) || ts,
        updatedAt: Number(entry.updatedAt) || ts,
        turns,
      });
    }
  }

  restore();

  /**
   * Audit row in `events` (reverse control must be auditable). The prompt itself is not stored ——
   * only its byte length, so the log identifies who/what/where without duplicating task text.
   * @param {string} kind
   * @param {any} session
   * @param {any} [turn]
   */
  function audit(kind, session, turn) {
    try {
      insertEvent(
        null,
        now(),
        kind,
        JSON.stringify({
          sessionId: session.id,
          turnId: turn ? turn.id : null,
          floor: session.floor,
          workspacePath: session.workspacePath,
          model: (turn && turn.model) || session.model || null,
          promptBytes: turn ? Buffer.byteLength(turn.prompt || '', 'utf8') : null,
          state: turn ? turn.state : sessionState(session),
          exitCode: turn ? turn.exitCode : null,
        })
      );
    } catch {
      /* ignore */
    }
  }

  function mode() {
    try {
      const raw = String((readConfig() || {}).mode || 'off');
      return DEFAULTS.DISPATCH_MODES.includes(raw) ? raw : 'off';
    } catch {
      return 'off';
    }
  }

  function policy() {
    try {
      const cfg = readConfig() || {};
      return { mode: mode(), file: cfg.file };
    } catch {
      return { mode: 'off' };
    }
  }

  /** @param {any} session */
  function sessionState(session) {
    if (session.turns.some((t) => t.state === 'pending')) return 'pending';
    if (session.turns.some((t) => t.state === 'running')) return 'running';
    return 'idle';
  }

  /** @param {any} turn */
  function publicTurn(turn) {
    return {
      id: turn.id,
      prompt: turn.prompt,
      state: turn.state,
      mode: turn.mode,
      model: turn.model || '',
      permission: turn.permission || null,
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      error: turn.error || '',
      exitCode: turn.exitCode,
      output: turn.output || '',
      pendingDeadline: turn.pendingDeadline || null,
    };
  }

  /** @param {any} session */
  function summary(session) {
    return {
      id: session.id,
      floor: session.floor,
      workspacePath: session.workspacePath,
      model: session.model || null,
      permission: session.permission || null,
      title: session.title || '',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      state: sessionState(session),
      turnCount: session.turns.length,
      productSessionId: session.productSessionId || session.opencodeSessionId || null,
      opencodeSessionId: session.opencodeSessionId || null,
    };
  }

  /** @param {any} session */
  function detail(session) {
    return { ...summary(session), turns: session.turns.map(publicTurn) };
  }

  /** @param {any} session */
  function touchSession(session) {
    session.updatedAt = now();
    emit({ kind: 'session', session: summary(session) });
    persistSoon();
  }

  /** @param {any} session @param {any} turn */
  function emitTurn(session, turn) {
    emit({ kind: 'turn', sessionId: session.id, session: summary(session), turn: publicTurn(turn) });
  }

  function armPendingExpiry(session, turn) {
    turn.pendingDeadline = turn.createdAt + DEFAULTS.DISPATCH_PENDING_TIMEOUT_MS;
    turn.expiryTimer = setTimeout(() => {
      if (turn.state !== 'pending') return;
      turn.state = 'expired';
      turn.endedAt = now();
      turn.error = '服务端长时间未确认，请求已过期';
      audit('dispatch.expired', session, turn);
      emitTurn(session, turn);
      touchSession(session);
    }, DEFAULTS.DISPATCH_PENDING_TIMEOUT_MS);
    if (turn.expiryTimer.unref) turn.expiryTimer.unref();
  }

  function clearPendingExpiry(turn) {
    if (turn.expiryTimer) {
      clearTimeout(turn.expiryTimer);
      turn.expiryTimer = null;
    }
  }

  /** @param {any} session @param {any} turn */
  function startTurn(session, turn) {
    if (disposed || turn.state !== 'pending') return publicTurn(turn);
    clearPendingExpiry(turn);

    const recipe = recipeFor(session.floor);
    const bin = binFor(session.floor);
    if (!recipe || !bin) {
      turn.state = 'failed';
      turn.endedAt = now();
      turn.error = !bin ? `${session.floor} 没有可执行的 CLI` : `${session.floor} 没有派发配方`;
      audit('dispatch.failed', session, turn);
      emitTurn(session, turn);
      touchSession(session);
      return publicTurn(turn);
    }

    let inv;
    try {
      inv = recipe.build({
        prompt: turn.prompt,
        // Per-turn choice wins; legacy sessions created with a model keep it as their fallback.
        model: turn.model || session.model || null,
        sessionId: session.productSessionId || session.opencodeSessionId,
        permission: turn.permission || session.permission,
        // Claude Code distinguishes the first turn (--session-id) from later ones (--resume).
        // Only a turn that actually started proves the product session exists.
        resume: session.turns.some((t) => t.id !== turn.id && Number(t.startedAt) > 0),
      });
    } catch (err) {
      turn.state = 'failed';
      turn.endedAt = now();
      turn.error = `构造命令失败：${(err && err.message) || err}`;
      audit('dispatch.failed', session, turn);
      emitTurn(session, turn);
      touchSession(session);
      return publicTurn(turn);
    }

    const parser = typeof inv.parser === 'function' ? inv.parser() : null;
    const appendOutput = (text) => {
      if (!text) return;
      const chunk = cleanChunk(text);
      if (!chunk) return;
      turn.output = (turn.output + chunk).slice(-OUTPUT_MAX_BYTES);
      // Streaming event: the client appends it to this turn without re-fetching the session.
      emit({ kind: 'output', sessionId: session.id, turnId: turn.id, chunk });
      persistSoon();
    };

    turn.state = 'running';
    turn.startedAt = now();
    audit('dispatch.start', session, turn);
    emitTurn(session, turn);
    touchSession(session);

    runCommand({
      bin,
      args: inv.args || [],
      stdin: inv.stdin,
      cwd: session.workspacePath,
      timeoutMs: DEFAULTS.DISPATCH_TIMEOUT_MS,
      onChild: (child) => {
        turn.child = child;
      },
      onData: (chunk) => {
        if (!chunk) return;
        appendOutput(parser ? parser.push(chunk) : chunk);
      },
    })
      .then((r) => {
        turn.child = null;
        if (turn.state === 'cancelled') return;
        if (parser) appendOutput(parser.flush());
        turn.endedAt = now();
        turn.exitCode = r.exitCode == null ? null : r.exitCode;
        if (r.status === 'ok') {
          turn.state = 'done';
          turn.error = '';
        } else if (r.status === 'timeout') {
          turn.state = 'timeout';
          turn.error = r.error || '超时';
        } else {
          turn.state = 'failed';
          turn.error = String(r.error || r.stderr || r.stdout || '').slice(0, 2000) || '执行失败';
        }
        if (turn.output.length === 0) {
          const tail = cleanOutput(`${r.stdout || ''}${r.stderr || ''}`).slice(-OUTPUT_MAX_BYTES);
          if (tail) turn.output = tail;
        }
        audit(`dispatch.${turn.state}`, session, turn);
        emitTurn(session, turn);
        touchSession(session);
      })
      .catch((err) => {
        turn.child = null;
        if (turn.state === 'cancelled') return;
        turn.state = 'failed';
        turn.endedAt = now();
        turn.error = String((err && err.message) || err).slice(0, 2000);
        audit('dispatch.failed', session, turn);
        emitTurn(session, turn);
        touchSession(session);
      });

    return publicTurn(turn);
  }

  /** @param {any} session @param {any} turn */
  function decideTurn(session, turn, approve) {
    if (turn.state !== 'pending') throw fail('not_pending', `这一轮当前是 ${turn.state}，不能再确认`, 409);
    if (approve) return startTurn(session, turn);
    clearPendingExpiry(turn);
    turn.state = 'rejected';
    turn.endedAt = now();
    turn.error = '服务端取消了这次请求';
    audit('dispatch.rejected', session, turn);
    emitTurn(session, turn);
    touchSession(session);
    return publicTurn(turn);
  }

  /** @param {any} session @param {any} turn */
  function cancelTurn(session, turn) {
    if (!['pending', 'running'].includes(turn.state)) {
      throw fail('not_active', `这一轮当前是 ${turn.state}，无需取消`, 409);
    }
    clearPendingExpiry(turn);
    turn.state = 'cancelled';
    turn.endedAt = now();
    turn.error = '已取消';
    audit('dispatch.cancelled', session, turn);
    const child = turn.child;
    turn.child = null;
    if (child) {
      try {
        killTree(child);
      } catch {
        /* already gone */
      }
    }
    emitTurn(session, turn);
    touchSession(session);
    return publicTurn(turn);
  }

  /** @param {{floor: string, workspacePath: string, model?: string, permission?: string, title?: string}} input */
  function createSession(input = {}) {
    const floor = String(input.floor || '');
    if (!DEFAULTS.DISPATCH_FLOORS.includes(floor)) {
      throw fail('bad_floor', `暂不支持该楼层：${floor || '(空)'}`, 400);
    }
    const recipe = recipeFor(floor);
    if (!recipe) throw fail('bad_floor', `${floor} 没有派发配方`, 400);
    if (!binFor(floor)) throw fail('floor_unavailable', `${floor} 的 CLI 未安装`, 409);

    const permissions =
      Array.isArray(recipe.permissions) && recipe.permissions.length ? recipe.permissions : ['auto'];
    const requestedPermission = String(input.permission || '').trim();
    if (requestedPermission && !permissions.includes(requestedPermission)) {
      throw fail('bad_permission', `${floor} 不支持这个权限选项：${requestedPermission}`, 400);
    }
    const permission = requestedPermission || recipe.defaultPermission || permissions[0];

    let workspacePath = String(input.workspacePath || '').trim();
    if (!workspacePath) throw fail('empty_workspace', '请选择工程目录（服务器上的绝对路径）', 400);
    if (workspacePath === '~' || workspacePath.startsWith('~/')) {
      workspacePath = path.join(os.homedir(), workspacePath.slice(workspacePath === '~' ? 1 : 2));
    }
    if (!path.isAbsolute(workspacePath)) throw fail('relative_workspace', '工程目录必须是绝对路径', 400);
    workspacePath = path.resolve(workspacePath);
    let stat = null;
    try {
      stat = fs.statSync(workspacePath);
    } catch {
      /* handled below */
    }
    if (!stat || !stat.isDirectory()) {
      throw fail('bad_workspace', `工程目录不存在或不是目录：${workspacePath}`, 400);
    }

    const productSessionId =
      typeof recipe.mintSessionId === 'function' ? recipe.mintSessionId() : mintSessionId();
    const session = {
      id: crypto.randomUUID(),
      floor,
      workspacePath,
      model: input.model ? String(input.model) : null,
      permission,
      title: String(input.title || '').slice(0, 120),
      productSessionId,
      opencodeSessionId: floor === '8F' ? productSessionId : null,
      createdAt: now(),
      updatedAt: now(),
      turns: [],
    };
    sessions.set(session.id, session);
    audit('dispatch.session', session);
    emit({ kind: 'session', session: summary(session) });
    return summary(session);
  }

  /**
   * Send one prompt into an existing session.
   * @param {string} sessionId
   * @param {{prompt: string}} input
   */
  function sendTurn(sessionId, input = {}) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) throw fail('not_found', '会话不存在', 404);

    const currentMode = mode();
    if (currentMode === 'off') {
      throw fail('disabled', '服务器未允许远程触发任务（服务端 config.json 的 dispatch.mode）', 403);
    }

    const prompt = String(input.prompt || '').trim();
    if (!prompt) throw fail('empty_prompt', '请填写要下发的任务内容', 400);
    if (Buffer.byteLength(prompt, 'utf8') > DEFAULTS.DISPATCH_PROMPT_MAX_BYTES) {
      throw fail('prompt_too_large', `任务内容超过 ${DEFAULTS.DISPATCH_PROMPT_MAX_BYTES} 字节`, 413);
    }
    // Per-turn model override: the composer lets the user pick a different model for every message.
    // Empty means "the floor's default" (or the session-level model on legacy sessions).
    const model = String(input.model || '').trim().slice(0, 200);
    // Per-turn permission override: 8F only has auto; Claude Code offers its modes.
    const recipe = recipeFor(session.floor);
    const permissions =
      recipe && Array.isArray(recipe.permissions) && recipe.permissions.length
        ? recipe.permissions
        : ['auto'];
    const requestedPermission = String(input.permission || '').trim();
    if (requestedPermission && !permissions.includes(requestedPermission)) {
      throw fail('bad_permission', `${session.floor} 不支持这个权限选项：${requestedPermission}`, 400);
    }
    const permission =
      requestedPermission ||
      session.permission ||
      (recipe && recipe.defaultPermission) ||
      permissions[0];
    if (session.turns.some((t) => ['pending', 'running'].includes(t.state))) {
      throw fail('busy', '这个会话还有一轮正在等待或执行，请先等它结束', 409);
    }

    const turn = {
      id: crypto.randomUUID(),
      prompt,
      state: 'pending',
      mode: currentMode,
      model,
      permission,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      error: '',
      exitCode: null,
      output: '',
      pendingDeadline: null,
      child: null,
      expiryTimer: null,
    };
    session.turns.push(turn);
    if (!session.title) session.title = prompt.slice(0, 60);
    audit('dispatch.turn', session, turn);
    emitTurn(session, turn);
    touchSession(session);

    if (currentMode === 'auto') return startTurn(session, turn);
    armPendingExpiry(session, turn);
    return publicTurn(turn);
  }

  /** @param {string} turnId */
  function findTurn(turnId) {
    for (const session of sessions.values()) {
      const turn = session.turns.find((t) => t.id === turnId);
      if (turn) return { session, turn };
    }
    return null;
  }

  /** @param {string} turnId @param {boolean} approve */
  function decide(turnId, approve) {
    const found = findTurn(turnId);
    if (!found) throw fail('not_found', '这一轮不存在', 404);
    return decideTurn(found.session, found.turn, approve);
  }

  /** @param {string} turnId */
  function cancel(turnId) {
    const found = findTurn(turnId);
    if (!found) throw fail('not_found', '这一轮不存在', 404);
    return cancelTurn(found.session, found.turn);
  }

  /** @param {string} sessionId */
  function getSession(sessionId) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) throw fail('not_found', '会话不存在', 404);
    return detail(session);
  }

  /** @param {string} sessionId */
  function deleteSession(sessionId) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) throw fail('not_found', '会话不存在', 404);
    for (const turn of session.turns) {
      clearPendingExpiry(turn);
      if (turn.state === 'running' && turn.child) {
        try {
          killTree(turn.child);
        } catch {
          /* already gone */
        }
      }
    }
    sessions.delete(session.id);
    audit('dispatch.session_deleted', session);
    emit({ kind: 'session_deleted', sessionId: session.id });
    return { ok: true };
  }

  function list() {
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary);
  }

  function floors() {
    return DEFAULTS.DISPATCH_FLOORS.map((id) => {
      const recipe = recipeFor(id);
      return {
        id,
        name: (recipe && recipe.name) || id,
        available: Boolean(binFor(id)),
        permissions:
          recipe && Array.isArray(recipe.permissions) && recipe.permissions.length
            ? recipe.permissions
            : ['auto'],
        defaultPermission:
          (recipe && recipe.defaultPermission) ||
          (recipe && Array.isArray(recipe.permissions) && recipe.permissions[0]) ||
          'auto',
      };
    });
  }

  /**
   * Model catalog for one floor, from that floor's own CLI (`opencode models`) or a recipe-provided
   * reader (Claude Code has no catalog command). The composer uses it for the per-turn model picker;
   * the server never picks a model for the user beyond "empty = CLI default".
   * @param {string} floor
   * @param {{refresh?: boolean}} [opts]
   * @returns {Promise<{floor: string, models: string[], labels: Record<string,string>, error: string}>}
   */
  async function listModels(floor, opts = {}) {
    const id = String(floor || '');
    if (!DEFAULTS.DISPATCH_FLOORS.includes(id)) {
      throw fail('bad_floor', `暂不支持该楼层：${id || '(空)'}`, 400);
    }
    const bin = binFor(id);
    if (!bin) throw fail('floor_unavailable', `${id} 的 CLI 未安装`, 409);
    const hit = modelsCache.get(id);
    if (!opts.refresh && hit && now() - hit.at < MODELS_TTL_MS) return hit.value;
    const recipe = recipeFor(id);
    const raw =
      recipe && typeof recipe.fetchModels === 'function'
        ? await recipe.fetchModels(bin)
        : await fetchModels(bin);
    const value = {
      floor: id,
      models: Array.isArray(raw && raw.models) ? raw.models : [],
      labels: raw && raw.labels && typeof raw.labels === 'object' ? raw.labels : {},
      error: String((raw && raw.error) || ''),
    };
    modelsCache.set(id, { at: now(), value });
    return value;
  }

  function dispose() {
    flushPersist();
    disposed = true;
    for (const session of sessions.values()) {
      for (const turn of session.turns) {
        clearPendingExpiry(turn);
        if (turn.state === 'running' && turn.child) {
          try {
            killTree(turn.child);
          } catch {
            /* already gone */
          }
        }
      }
    }
  }

  return {
    mode,
    policy,
    createSession,
    sendTurn,
    decide,
    cancel,
    getSession,
    deleteSession,
    list,
    floors,
    listModels,
    dispose,
    STATES,
  };
}

module.exports = { createDispatchService, defaultRun, defaultFetchModels, parseModelList, STATES, cleanOutput };
