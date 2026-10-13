// 回归：服务端统一日志（server/src/log.js）与保留策略。
//
// 钉住：
//   1) 默认级别 = info（info / warn / error 打，debug 不打）；WORKGREMLIN_LOG=debug 才放行 debug；
//   2) info 及以上落一份按天文件 ~/.workgremlin/logs/workgremlin-<YYYY-MM-DD>.log，debug 不落；
//   3) 保留 7 天：过期的按天文件删掉、hooks/events.log 里过期行删掉、废弃单文件日志清掉。
//
// 跑法：npm run test:log（零依赖）
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-log-'));
process.env.WORKGREMLIN_HOME = TMP;
process.env.WORKGREMLIN_LOG = 'debug';
delete process.env.WORKGREMLIN_LOG_LEVEL;
delete process.env.WORKGREMLIN_LOG_FILE;
delete process.env.WORKGREMLIN_LOG_KEEP_DAYS;

const log = require('../src/log');

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`);
  }
}

/** 抓一次屏幕输出（stdout+stderr），返回拼起来的字符串 */
function capture(fn) {
  const out = [];
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
  return out.join('');
}

const DAY = 24 * 60 * 60_000;
const stamp = (offsetDays = 0) => new Date(Date.now() - offsetDays * DAY).toISOString().slice(0, 10);
const iso = (offsetDays = 0) => new Date(Date.now() - offsetDays * DAY).toISOString();

console.log(`沙箱：${TMP}`);

console.log('\n[1] 级别：env 打开 debug');
ok('WORKGREMLIN_LOG=debug -> 级别 debug', log.getLevel() === 'debug', log.getLevel());
ok('debug 放行', log.isEnabled('debug'));
const dbg = capture(() => log.debug('调试一行', { a: 1 }));
ok('debug 打到屏幕上，且带级别与 [workgremlin]', /DEBUG \[workgremlin\] 调试一行 \{"a":1\}/.test(dbg), JSON.stringify(dbg));

console.log('\n[2] 默认级别 = info（不开 debug 就只放行 info 及以上）');
log.setLevel('info');
ok('setLevel(info) 生效', log.getLevel() === 'info');
ok('debug 不再放行', !log.isEnabled('debug'));
ok('debug 一行都没打', capture(() => log.debug('不该出现')) === '');
ok('info 打出来了', /INFO {2}\[workgremlin\] 常规一行/.test(capture(() => log.info('常规一行'))));

console.log('\n[3] 落文件：按天文件在 ~/.workgremlin/logs/，只落 info 及以上');
const file = log.path();
ok('日志文件是 logs/workgremlin-<今天>.log', file === path.join(TMP, 'logs', `workgremlin-${stamp()}.log`), file);
log.debug('debug-only');
log.info('写进文件这一行');
log.error('错误也要落文件');
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
ok('文件里有 info / error 两行', text.includes('写进文件这一行') && text.includes('错误也要落文件'), text);
ok('文件里没有 debug 行', !text.includes('debug-only'), text);
ok('文件里带级别前缀', /(INFO|ERROR)\s+\[workgremlin\]/.test(text), text);

console.log('\n[4] 保留 7 天：过期的按天文件删掉、窗口内的留着');
const logsDir = path.join(TMP, 'logs');
const oldFile = path.join(logsDir, `workgremlin-${stamp(10)}.log`);
const recentFile = path.join(logsDir, `workgremlin-${stamp(3)}.log`);
fs.writeFileSync(oldFile, 'old\n');
fs.writeFileSync(recentFile, 'recent\n');
ok('默认保留天数是 7', log.keepDays === 7, String(log.keepDays));
const r1 = log.pruneOldLogs();
ok('10 天前的按天文件被删', !fs.existsSync(oldFile), JSON.stringify(r1));
ok('3 天前的按天文件还在', fs.existsSync(recentFile));
ok('今天的还在', fs.existsSync(file));

console.log('\n[5] events.log：按行时间戳删掉 7 天以前的行');
const events = path.join(TMP, 'hooks', 'events.log');
fs.mkdirSync(path.dirname(events), { recursive: true });
fs.writeFileSync(events, `${iso(10)} PreToolUse old\n${iso(0)} PreToolUse new\n`);
const r2 = log.pruneOldLogs();
const evText = fs.readFileSync(events, 'utf8');
ok('过期那行被删', !evText.includes('old'), evText);
ok('今天的行还在', evText.includes('new'), evText);
ok('确实删了 1 行', r2.lines === 1, JSON.stringify(r2));

console.log('\n[6] 废弃的单文件日志直接清掉');
const legacy = path.join(TMP, 'cb-cancel-debug.log');
fs.writeFileSync(legacy, 'x'.repeat(10));
log.pruneOldLogs();
ok('cb-cancel-debug.log 被清掉', !fs.existsSync(legacy));

console.log('\n[7] WORKGREMLIN_LOG_FILE=0 关掉文件日志');
log.setFileEnabled(false);
const before = fs.readFileSync(file, 'utf8').length;
log.info('这行不该落盘');
ok('关了之后不再写文件', fs.readFileSync(file, 'utf8').length === before);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
