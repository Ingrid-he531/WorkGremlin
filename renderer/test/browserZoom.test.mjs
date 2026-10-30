/**
 * Remote browser client: Ctrl/Cmd +/- must not resize the office scene.
 *
 * The browser zoom shortcuts change CSS pixels; the isometric canvas then re-fits and every label
 * visibly changes size. Electron keeps its normal behaviour, browser mode cancels the shortcuts.
 *
 * Run: `npm run test:browser-zoom`
 */
import fs from 'node:fs';
import path from 'node:path';
import { isBrowserZoomKey, isBrowserZoomWheel, installBrowserZoomGuard } from '../src/lib/browserZoom.js';

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

const key = (over = {}) => ({ ctrlKey: false, metaKey: false, altKey: false, key: '', code: '', ...over });

head('快捷键识别');
ok('Ctrl +', isBrowserZoomKey(key({ ctrlKey: true, key: '+' })));
ok('Ctrl =（未按 Shift 的 + 键）', isBrowserZoomKey(key({ ctrlKey: true, key: '=' })));
ok('Ctrl -', isBrowserZoomKey(key({ ctrlKey: true, key: '-' })));
ok('Ctrl _（Shift + -）', isBrowserZoomKey(key({ ctrlKey: true, key: '_' })));
ok('Ctrl 0（恢复 100%）', isBrowserZoomKey(key({ ctrlKey: true, key: '0' })));
ok('Cmd +（macOS 浏览器）', isBrowserZoomKey(key({ metaKey: true, key: '+' })));
ok('小键盘 +', isBrowserZoomKey(key({ ctrlKey: true, code: 'NumpadAdd' })));
ok('小键盘 -', isBrowserZoomKey(key({ ctrlKey: true, code: 'NumpadSubtract' })));
ok('小键盘 0', isBrowserZoomKey(key({ ctrlKey: true, code: 'Numpad0' })));

head('不能误伤普通按键');
ok('Ctrl A 不是缩放', !isBrowserZoomKey(key({ ctrlKey: true, key: 'a' })));
ok('普通 + 不是缩放', !isBrowserZoomKey(key({ key: '+' })));
ok('Alt + 不当作缩放', !isBrowserZoomKey(key({ altKey: true, ctrlKey: true, key: '+' })));
ok('Ctrl Shift I 不是缩放', !isBrowserZoomKey(key({ ctrlKey: true, key: 'I' })));
ok('普通滚轮不是浏览器缩放', !isBrowserZoomWheel({ ctrlKey: false, metaKey: false }));
ok('Ctrl 滚轮是浏览器缩放（也覆盖触控板捏合）', isBrowserZoomWheel({ ctrlKey: true }));
ok('Cmd 滚轮（macOS）是浏览器缩放', isBrowserZoomWheel({ metaKey: true }));

head('安装：捕获阶段拦 keydown，Ctrl+滚轮只取消浏览器默认');
{
  const calls = [];
  const fake = {
    addEventListener(type, fn, opts) {
      calls.push({ type, fn, opts });
    },
    removeEventListener() {},
  };
  installBrowserZoomGuard(fake);
  const kd = calls.find((c) => c.type === 'keydown');
  const wh = calls.find((c) => c.type === 'wheel');
  ok('注册了 keydown', Boolean(kd));
  ok('keydown 在捕获阶段（先于页面自己的快捷键）', kd && kd.opts === true);
  ok('注册了 wheel', Boolean(wh));
  ok('wheel 是 capture + passive:false（否则 preventDefault 无效）', wh && wh.opts && wh.opts.capture === true && wh.opts.passive === false);

  const event = (over = {}) => {
    const e = { prevented: false, stopped: false, ...over };
    e.preventDefault = () => { e.prevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    return e;
  };
  if (kd) {
    const zoom = event({ ctrlKey: true, key: '+' });
    kd.fn(zoom);
    ok('Ctrl + 被拦下', zoom.prevented && zoom.stopped);
    const plain = event({ key: 'a' });
    kd.fn(plain);
    ok('普通按键放行', !plain.prevented && !plain.stopped);
  }
  if (wh) {
    const pinch = event({ ctrlKey: true });
    wh.fn(pinch);
    ok('Ctrl 滚轮取消浏览器缩放默认行为', pinch.prevented);
    ok('但不阻断传播（画布仍能收到它做场景缩放）', !pinch.stopped);
    const plain = event({});
    wh.fn(plain);
    ok('普通滚轮不处理', !plain.prevented);
  }
}

head('只在浏览器模式安装（Electron 不受影响）');
{
  const src = fs.readFileSync(path.resolve('renderer/src/main.js'), 'utf8');
  ok('main.js 检查 !hasBridge() 后才安装', /if\s*\(\s*!hasBridge\(\)\s*\)\s*installBrowserZoomGuard\(\)/.test(src));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
