#!/usr/bin/env node
/**
 * Run all regression suites (`npm run test:all`).
 *
 * Scans package.json for every `test:*` script and runs them one by one, then prints a summary table
 * (passed / failed / time). **Serial**, not parallel: most cases are "sandbox" tests (they change HOME /
 * WORKGREMLIN_HOME, create temp on-disk data, read/write hook state), so two suites running in parallel
 * step on each other's environment and fail mysteriously and unreproducibly.
 *
 * Usage:
 *   npm run test:all                    # run everything
 *   node scripts/run-tests.js qoder     # run only names containing "qoder" (multiple keywords allowed)
 *   node scripts/run-tests.js --fail-fast  # stop at the first red
 *
 * Only failing suites print a tail (failure lines / Error stack); passing ones pass silently.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const failFast = args.some((a) => a === '--fail-fast' || a === '-x');
const filters = args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/^test:/, '').toLowerCase());

const names = Object.keys(pkg.scripts)
  .filter((k) => /^test:/.test(k) && k !== 'test:all')
  .filter((k) => !filters.length || filters.some((f) => k.slice(5).toLowerCase().includes(f)));

if (!names.length) {
  console.error(`No test:* script matched${filters.length ? ` (filters: ${filters.join(', ')})` : ''}`);
  process.exit(1);
}

console.log(`Running ${names.length} suites\n`);

const results = [];
const startedAt = Date.now();

for (const name of names) {
  const t0 = Date.now();
  const r = spawnSync(npm, ['run', '--silent', name], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  const lines = out.split('\n').filter((l) => l.trim());
  // Each sub-suite prints its summary line in Chinese; parse it as-is.
  const summary = lines.reverse().find((l) => /结果：/.test(l));
  const passed = summary && /(\d+)\s*通过/.exec(summary) ? Number(/(\d+)\s*通过/.exec(summary)[1]) : null;
  const failed = summary && /(\d+)\s*失败/.exec(summary) ? Number(/(\d+)\s*失败/.exec(summary)[1]) : null;

  console.log(
    `${ok ? '✓' : '✗'} ${name.padEnd(26)} ${ms.toString().padStart(6)}ms  ` +
      `${ok ? `${passed ?? '?'} passed` : `${failed ?? '?'} failed / ${(passed ?? 0) + (failed ?? 0)} total`}`
  );

  if (!ok) {
    // Keep only "failing-case lines + error lines": a full stdout is too long to read.
    const noisy = lines
      .slice()
      .reverse()
      .filter((l) => /✗|Error|error:|AssertionError|at /.test(l))
      .reverse()
      .slice(-12);
    for (const l of noisy) console.log(`      ${l.trim()}`);
    if (!noisy.length) console.log(`      ${(out || '(no output)').trim().split('\n').slice(-5).join('\n      ')}`);
  }

  results.push({ name, ok, ms });
  if (!ok && failFast) {
    console.log('\n--fail-fast: stopping at the first red suite');
    break;
  }
}

const bad = results.filter((r) => !r.ok);
const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\nResult: ${results.length - bad.length}/${results.length} suites passed, ${secs}s` +
    (bad.length ? `\nFailed: ${bad.map((r) => r.name).join(', ')}` : '')
);

process.exit(bad.length ? 1 : 0);
