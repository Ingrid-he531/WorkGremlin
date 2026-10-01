/**
 * 办公室画布 × 中英切换 自检。
 *
 * 为什么单独一个文件：画布（iso/engine.js）不是组件，拿不到 provide/inject，直接
 * `import { t } from i18n` 用。于是它踩过一个只有真跑起来才现形的坑 ——
 * `drawWalls()` 里有个局部 `const t = WALL.thickness`（墙厚），把翻译函数遮住了，
 * 一次 `t('wall.meeting_room')` 抛 `t is not a function` → 整个 requestAnimationFrame
 * 循环当场死掉 → **办公室只剩一块空画布**（2026-10-01 用户实测：切成英文后办公室空白；
 * 其实中文也一样空，只是那一下才切过去看）。
 *
 * 所以这里真的把引擎跑起来：假 canvas + 可控 RAF，两种语言各跑若干帧，
 * 断言 ① 一帧都不许抛；② 名牌上的字确实跟着语言走（英文 "Busy" / 中文 "忙碌"）。
 *
 * 跑法：`npm run test:canvas-scene`
 */
import { register } from 'node:module';

// 引擎里是 './iso' 这种省扩展名的相对导入（浏览器由 Vite 补），Node 需要一个解析钩子
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, ctx, next) {
  try { return await next(specifier, ctx); } catch (e) {
    if (specifier.startsWith('.')) return next(specifier + '.js', ctx);
    throw e;
  }
}
`)
);

/** 画上去的文字都收进 sink，用来断言"名牌上的字是哪个语言" */
function makeCtx(sink) {
  const any = new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (k === 'fillText') {
        return (s) => {
          sink.push(String(s));
          return any;
        };
      }
      if (k === 'width' || k === 'height') return 100;
      if (k === Symbol.toPrimitive) return () => 0;
      return any;
    },
    apply: () => any,
    set: () => true,
  });
  return any;
}

let rafCb = null;
const drawn = [];
const fakeCanvas = () => ({
  width: 900,
  height: 700,
  style: {},
  getContext: () => makeCtx(drawn),
  addEventListener: () => {},
  removeEventListener: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 700 }),
});
globalThis.document = { createElement: () => fakeCanvas(), addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = { devicePixelRatio: 1, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.requestAnimationFrame = (cb) => {
  rafCb = cb;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  rafCb = null;
};

const { locale, setLocale } = await import('../src/i18n/index.js');
const { createIsoOffice } = await import('../src/iso/engine.js');

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

/** 跑一段帧；返回第一个异常（没有就 null） */
async function runFrames(office, n = 40) {
  for (let i = 0; i < n; i += 1) {
    const now = performance.now();
    if (rafCb) {
      const cb = rafCb;
      rafCb = null;
      try {
        cb(now);
      } catch (err) {
        return err;
      }
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  return null;
}

for (const [loc, busyWord, meetingWord] of [
  ['zh', '忙碌', '会议室'],
  ['en', 'Busy', 'Meeting room'],
]) {
  console.log(`\n[${loc}] 画布跑起来 + 文字跟着语言走`);
  setLocale(loc);
  ok(`语言已切到 ${loc}`, locale.value === loc, locale.value);
  drawn.length = 0;
  const office = createIsoOffice(fakeCanvas(), {});
  office.setMembers([{ memberId: 'coder@x', name: 'coder', state: 'busy', role: 'subagent:project' }]);
  const err = await runFrames(office, 40);
  ok('40 帧一帧都没抛（抛一次 raf 循环就死了 → 空画布）', !err, err && err.message);
  ok('小怪物进到屋里了（画布在正常出人）', Boolean(office.screenOf('coder@x')));
  ok(`名牌上的状态字是「${busyWord}」`, drawn.includes(busyWord), drawn.slice(0, 12).join(' | '));
  ok(`墙上的「${meetingWord}」也翻译了`, drawn.includes(meetingWord));
}

setLocale('zh');
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
