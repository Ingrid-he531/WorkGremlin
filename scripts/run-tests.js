#!/usr/bin/env node
/**
 * 跑全部回归套件（`npm run test:all`）。
 *
 * 扫 package.json 里所有 `test:*` 脚本逐个执行，最后给一张汇总表（通过/失败/耗时）。
 * **串行**而不是并行：这些用例大多是"沙箱型"（改 HOME / WORKGREMLIN_HOME、建临时落盘、
 * 读写 hooks 状态），两个套件并行会互相踩环境，红得莫名其妙还难复现。
 *
 * 用法：
 *   npm run test:all                    # 全跑
 *   node scripts/run-tests.js qoder     # 只跑名字里含 qoder 的（可给多个关键字）
 *   node scripts/run-tests.js --fail-fast  # 第一个红就停
 *
 * 只有失败套件才打印尾巴（失败行 / Error 堆栈），成功的静默过。
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
  console.error(`没有匹配到任何 test:* 脚本${filters.length ? `（过滤词：${filters.join(', ')}）` : ''}`);
  process.exit(1);
}

console.log(`将跑 ${names.length} 个套件\n`);

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
  const summary = lines.reverse().find((l) => /结果：/.test(l));
  const passed = summary && /(\d+)\s*通过/.exec(summary) ? Number(/(\d+)\s*通过/.exec(summary)[1]) : null;
  const failed = summary && /(\d+)\s*失败/.exec(summary) ? Number(/(\d+)\s*失败/.exec(summary)[1]) : null;

  console.log(
    `${ok ? '✓' : '✗'} ${name.padEnd(26)} ${ms.toString().padStart(6)}ms  ` +
      `${ok ? `${passed ?? '?'} 通过` : `${failed ?? '?'} 失败 / 共 ${(passed ?? 0) + (failed ?? 0)}`}`
  );

  if (!ok) {
    // 只留「失败用例行 + 报错行」：全套 stdout 太长，没人看。
    const noisy = lines
      .slice()
      .reverse()
      .filter((l) => /✗|Error|error:|AssertionError|at /.test(l))
      .reverse()
      .slice(-12);
    for (const l of noisy) console.log(`      ${l.trim()}`);
    if (!noisy.length) console.log(`      ${(out || '(无输出)').trim().split('\n').slice(-5).join('\n      ')}`);
  }

  results.push({ name, ok, ms });
  if (!ok && failFast) {
    console.log('\n--fail-fast：停在第一个红的套件');
    break;
  }
}

const bad = results.filter((r) => !r.ok);
const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\n结果：${results.length - bad.length}/${results.length} 个套件通过，耗时 ${secs}s` +
    (bad.length ? `\n失败：${bad.map((r) => r.name).join(', ')}` : '')
);

process.exit(bad.length ? 1 : 0);
