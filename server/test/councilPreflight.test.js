/**
 * Council preflight self-check — no real CLI is spawned.
 *
 * Preflight is the gate that turns "the executable exists" into "this floor can answer right now".
 * These cases pin the contract the HTTP layer and the UI rely on:
 *   · every selected floor is probed with its own optional model;
 *   · a failure keeps the raw reason and a normalized errorKind;
 *   · a missing executable fails without spawning anything;
 *   · verdicts are cached, but a different model never reuses another model's verdict;
 *   · the temporary probe directory is always removed.
 *
 * Run: `npm run test:council-preflight`
 */
'use strict';

const {
  probeFloors,
  clearProbeCache,
  PROBE_PROMPT,
} = require('../src/council/floors');

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

(async () => {
  clearProbeCache();

  head('every selected floor is probed with its own model');
  {
    const calls = [];
    const removed = [];
    const results = await probeFloors(['1F', '4F'], {
      models: { '1F': 'deepseek-v4.1-flash' },
      timeoutMs: 12_345,
      cwd: '/tmp/fake-probe-cwd',
      cliPathOf: (floorId) => `/usr/bin/${floorId}`,
      removeDir: (d) => removed.push(d),
      runTurn: async (arg) => {
        calls.push(arg);
        return { status: 'ok', text: 'OK', durationMs: 7, error: null, errorKind: null };
      },
    });

    ok('two results', results.length === 2, String(results.length));
    ok('both are ok', results.every((r) => r.ok), JSON.stringify(results));
    ok('the timeout is passed through', calls.every((c) => c.timeoutMs === 12_345), JSON.stringify(calls.map((c) => c.timeoutMs)));
    ok('the probe prompt is the shared short sentence', calls.every((c) => c.stdin === PROBE_PROMPT || c.args.includes(PROBE_PROMPT)));
    const one = calls.find((c) => c.bin === '/usr/bin/1F');
    const four = calls.find((c) => c.bin === '/usr/bin/4F');
    ok('1F receives --model', Boolean(one) && one.args[one.args.indexOf('--model') + 1] === 'deepseek-v4.1-flash', JSON.stringify(one && one.args));
    ok('4F (no model) receives no --model', Boolean(four) && !four.args.includes('--model'), JSON.stringify(four && four.args));
    ok('the result records the model', results.find((r) => r.floorId === '1F').model === 'deepseek-v4.1-flash');
    ok('the caller-supplied cwd is not removed', removed.length === 0, JSON.stringify(removed));
    ok('first run is not cached', results.every((r) => r.cached === false));
  }

  head('a failed floor keeps the raw reason and the normalized kind');
  {
    clearProbeCache();
    const results = await probeFloors(['1F'], {
      cwd: '/tmp/fake-probe-cwd',
      runTurn: async () => ({
        status: 'failed',
        text: '',
        durationMs: 42,
        error: '400 Copilot: The requested model is not supported.',
        errorKind: 'model',
      }),
    });
    ok('ok=false', results[0].ok === false, JSON.stringify(results[0]));
    ok('errorKind=model', results[0].errorKind === 'model', String(results[0].errorKind));
    ok('the provider text is verbatim', String(results[0].error).includes('requested model is not supported'), String(results[0].error));
  }

  head('a missing executable fails without spawning');
  {
    clearProbeCache();
    let spawned = 0;
    const results = await probeFloors(['8F'], {
      cwd: '/tmp/fake-probe-cwd',
      cliPathOf: () => null,
      runTurn: async () => {
        spawned += 1;
        return { status: 'ok', text: 'OK', durationMs: 1 };
      },
    });
    ok('ok=false', results[0].ok === false);
    ok('errorKind=spawn', results[0].errorKind === 'spawn', String(results[0].errorKind));
    ok('nothing was spawned', spawned === 0, String(spawned));
  }

  head('cache: same floor/model is reused, another model is probed again');
  {
    clearProbeCache();
    let spawned = 0;
    const runTurn = async () => {
      spawned += 1;
      return { status: 'ok', text: 'OK', durationMs: 3, error: null, errorKind: null };
    };
    const first = await probeFloors(['4F'], { cwd: '/tmp/fake-probe-cwd', runTurn, cliPathOf: () => '/usr/bin/4F' });
    const second = await probeFloors(['4F'], { cwd: '/tmp/fake-probe-cwd', runTurn, cliPathOf: () => '/usr/bin/4F' });
    ok('first spawns once', spawned === 1, String(spawned));
    ok('second is cached', second[0].cached === true, JSON.stringify(second[0]));
    ok('the cached verdict is the same', second[0].ok === first[0].ok && second[0].error === first[0].error);

    const other = await probeFloors(['4F'], {
      cwd: '/tmp/fake-probe-cwd',
      runTurn,
      cliPathOf: () => '/usr/bin/4F',
      models: { '4F': 'other-model' },
    });
    ok('a different model is not served from cache', other[0].cached === false && spawned === 2, `${other[0].cached} / ${spawned}`);
  }

  head('an owned temp directory is removed even when a probe throws');
  {
    clearProbeCache();
    const removed = [];
    let caught = null;
    try {
      await probeFloors(['4F'], {
        mkdtemp: () => '/tmp/wg-owned-probe',
        removeDir: (d) => removed.push(d),
        runTurn: async () => {
          throw new Error('boom');
        },
      });
    } catch (err) {
      caught = err;
    }
    ok('the error reaches the caller (the HTTP layer turns it into a 500)', Boolean(caught) && /boom/.test(caught.message));
    ok('the owned directory was removed anyway', removed.includes('/tmp/wg-owned-probe'), JSON.stringify(removed));
  }

  console.log(`\n${fail ? '✗' : '✓'} council-preflight: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
