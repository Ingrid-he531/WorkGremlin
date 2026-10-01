/**
 * 中英文案表自检。
 *
 * 界面语言是 2026-10-01 加的功能（顶栏会话下拉前面的 中文 / En 开关），全应用文案都走
 * `renderer/src/i18n/index.js` 的 t()。这份用例只锁三件事 —— 都是"漏一处就悄悄退回中文"
 * 的那类问题：
 *   1. 两套文案的 **key 完全对齐**（少一条 = 那句话在英文界面里会闪回中文）；
 *   2. 两套文案的**占位符一致**（`{n}` 只写在一半的语言里 = 另一个语言渲染出半截句子）；
 *   3. t() 的行为：认不出的 key 原样返回（开发时一眼看得出漏了）、缺一边时回落中文、
 *      参数按名替换、没给值的占位符原样留着（不静默吞掉）。
 *
 * 跑法：`npm run test:i18n`
 */
import { LOCALES, locale, setLocale, t } from '../src/i18n/index.js';

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

/** 从词条表里取某个语言的 key 集与占位符：直接问 t() 拿不到表，这里读源码（同源、不引第二份实现） */
const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/i18n/index.js', import.meta.url), 'utf8'));
const zhBlock = src.slice(src.indexOf('  zh: {'), src.indexOf('  en: {'));
const enBlock = src.slice(src.indexOf('  en: {'), src.indexOf('\n};'));
const keysOf = (block) => [...block.matchAll(/^ {4}'([^']+)':/gm)].map((m) => m[1]);
const paramsOf = (block) => {
  const out = new Map();
  for (const m of block.matchAll(/^ {4}'([^']+)':\s*(.+)$/gm)) {
    out.set(m[1], [...m[2].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(','));
  }
  return out;
};
const zhKeys = keysOf(zhBlock);
const enKeys = keysOf(enBlock);

console.log('\n[1] 两套文案 key 对齐');
const missingEn = zhKeys.filter((k) => !enKeys.includes(k));
const missingZh = enKeys.filter((k) => !zhKeys.includes(k));
ok(`中文 ${zhKeys.length} 条 / 英文 ${enKeys.length} 条，key 数一致`, zhKeys.length === enKeys.length, `${zhKeys.length} vs ${enKeys.length}`);
ok('中文有的英文都有（少一条就会在英文界面闪回中文）', missingEn.length === 0, missingEn.join(', '));
ok('英文有的中文都有（多出来的 key 是死文案）', missingZh.length === 0, missingZh.join(', '));
ok('没有重复 key', new Set(zhKeys).size === zhKeys.length);

console.log('\n[2] 两种语言的占位符一致');
const zhParams = paramsOf(zhBlock);
const enParams = paramsOf(enBlock);
const diff = zhKeys.filter((k) => (zhParams.get(k) || '') !== (enParams.get(k) || ''));
ok('同一条文案在两种语言里用同一组 {占位符}', diff.length === 0, diff.map((k) => `${k}: ${zhParams.get(k)} vs ${enParams.get(k)}`).join(' | '));
ok('没有空文案', !keysOf(zhBlock).some((k) => !zhParams.has(k)));

console.log('\n[3] t() 的行为');
setLocale('zh');
ok('中文：办公室', t('nav.office') === '办公室', t('nav.office'));
setLocale('en');
ok('英文：Office', t('nav.office') === 'Office', t('nav.office'));
ok('参数按名替换', t('records.count', { n: 7 }) === '7 tasks', t('records.count', { n: 7 }));
ok('占位符没给值就原样留着（不静默吞掉）', t('records.count').includes('{n}'), t('records.count'));
ok('认不出的 key 原样返回（开发时一眼看出漏了）', t('nope.not.a.key') === 'nope.not.a.key');
ok('语言键只有 zh / en 两个，且带人类可读的标签', LOCALES.map((l) => l.key).join(',') === 'zh,en' && LOCALES.every((l) => l.label));
ok('setLocale 认不出的值不生效（不把界面切成空文案表）', (() => { setLocale('fr'); return locale.value === 'en'; })());
setLocale('zh');
ok('切回中文生效', t('nav.records') === '任务记录', t('nav.records'));

console.log('\n[4] 静态查一遍：调用 t()/tr() 的文件都绑定了翻译函数');
// 2026-10-01 的坑：TaskRecordsView 里有两处写成 t(...)（本该是 tr(...)，那文件的 t 是"一条任务"），
// 运行时 `t is not defined` → 整个任务记录页渲染失败、一片空白。这类错误编译期看不出来，
// 只有真渲染 / 真跑到那行才炸，所以这里按文件静态查一次绑定关系。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(vue|js)$/.test(e.name)) files.push(full);
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  const unbound = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const calls = /(?<![A-Za-z0-9_$.])(t|tr)\(/.test(src);
    if (!calls) continue;
    if (/i18n\/index\.js$/.test(f)) continue; // 它自己就是定义处
    const bound =
      /const\s*\{[^}]*\bt\b[^}]*\}\s*=\s*useI18n\(\)/.test(src) ||
      /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][^'"]*i18n[^'"]*['"]/.test(src);
    if (!bound) unbound.push(path.relative(new URL('..', import.meta.url).pathname, f));
  }
  ok('没有"调了 t() 却没绑定翻译函数"的文件（否则那页会整页白屏）', unbound.length === 0, unbound.join(', '));

  // 另一类残留：写过 `i18nT(...)` 这种根本不存在的东西（只有跑到那一行才炸）。
  const ghosts = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (/\bi18nT\s*\(/.test(src)) ghosts.push(path.relative(new URL('..', import.meta.url).pathname, f));
  }
  ok('没有 i18nT(...) 这种不存在的翻译函数调用', ghosts.length === 0, ghosts.join(', '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
