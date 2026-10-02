/**
 * 议事厅「内联材料」自检 —— 真文件、真字节数。
 *
 * 为什么这件事值得单独测：参与者**没有工具**，材料是它唯一的信息来源。所以
 *   · 切在 UTF-8 字符中间 → 参与者读到一串乱码，而它会把乱码当正文引用；
 *   · 少给了却说"没截断" → 它会以为看过全文，然后基于没看到的部分下判断（编造）；
 *   · 读不到却静默跳过 → 用户以为文件进去了，其实没有。
 * 这三条都会让一场会的结论建立在不存在的材料上，属于必须钉住的地方。
 *
 * 跑法：`npm run test:council-materials`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readMaterial, readMaterials } = require('../src/council/materials');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-mat-'));
const put = (name, content) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content);
  return p;
};

// ------------------------------------------------------------------ 正常
head('正常读入：字节数如实记');
{
  const p = put('a.txt', '一二三\nhello\n');
  const m = readMaterial(p, { maxBytes: 1024 });
  ok('读到了内容', m.content === '一二三\nhello\n', JSON.stringify(m.content));
  ok('bytesTotal 是文件真实大小', m.bytesTotal === fs.statSync(p).size, String(m.bytesTotal));
  ok('bytesIncluded 按**字节**算（中文 3 字节，不是按字符数）', m.bytesIncluded === Buffer.byteLength('一二三\nhello\n', 'utf8'), String(m.bytesIncluded));
  ok('没超限就不标截断', m.truncated === 0);
  ok('没有错误', m.error === null);
}

// ------------------------------------------------------------------ 截断
head('超单文件上限：截断并如实记账');
{
  const p = put('big.txt', 'x'.repeat(5000));
  const m = readMaterial(p, { maxBytes: 100 });
  ok('内容被截到上限', m.content.length === 100, String(m.content.length));
  ok('truncated=1', m.truncated === 1);
  ok('bytesTotal 仍然是**真实**的 5000（界面要说清省略了多少）', m.bytesTotal === 5000, String(m.bytesTotal));
  ok('bytesIncluded=100（实际给了多少）', m.bytesIncluded === 100, String(m.bytesIncluded));
}

head('UTF-8 边界：不能切碎一个字符');
{
  // '中' 占 3 字节。限到 10 字节时，第 10 字节正好卡在第 4 个字中间 ——
  // 直接切会得到 "中中中�"，参与者读到乱码还以为是原文
  const p = put('cn.txt', '中中中中中');
  const m = readMaterial(p, { maxBytes: 10 });
  ok('末尾没有出现替换符（没切碎字符）', !m.content.includes('�'), JSON.stringify(m.content));
  ok('退到字符边界：3 个字 = 9 字节', m.content === '中中中' && m.bytesIncluded === 9, `${JSON.stringify(m.content)}/${m.bytesIncluded}`);
  ok('依然是 truncated=1', m.truncated === 1);
}

head('总预算：先来的先占额度，超出的如实标成"一点没进去"');
{
  const a = put('t1.txt', 'a'.repeat(100));
  const b = put('t2.txt', 'b'.repeat(100));
  const c = put('t3.txt', 'c'.repeat(100));
  const ms = readMaterials([a, b, c], { maxBytes: 100, totalMaxBytes: 250 });
  ok('三份都返回了（一个都不悄悄丢）', ms.length === 3);
  ok('第一份完整', ms[0].bytesIncluded === 100 && ms[0].truncated === 0);
  ok('第二份完整', ms[1].bytesIncluded === 100 && ms[1].truncated === 0);
  ok('第三份拿到剩下的 50 字节', ms[2].bytesIncluded === 50, String(ms[2].bytesIncluded));
  ok('第三份标了截断', ms[2].truncated === 1);
  ok('总用量没有超预算', ms.reduce((n, m) => n + m.bytesIncluded, 0) === 250);

  const zero = readMaterials([a, b], { maxBytes: 100, totalMaxBytes: 100 });
  ok('预算用光时后一份给 0 字节，而不是整条丢掉', zero[1].bytesIncluded === 0 && zero[1].truncated === 1);
}

// ------------------------------------------------------------------ 读不到
head('读不到就说读不到（由路由拒掉整条请求，不静默跳过）');
{
  const m = readMaterial(path.join(TMP, '根本没有这个文件.txt'));
  ok('不存在：返回 error 而不是抛异常', m.error != null && /不存在/.test(m.error), String(m.error));
  ok('不知道大小就留 null（不写 0）', m.bytesTotal === null && m.bytesIncluded === null);
  ok('内容也是 null', m.content === null);

  const d = readMaterial(TMP);
  ok('目录：明说这是目录', /目录/.test(String(d.error)), String(d.error));

  const bin = put('blob.bin', Buffer.from([0x89, 0x50, 0x4e, 0x00, 0xff, 0x01]));
  const bm = readMaterial(bin);
  ok('二进制：拒掉而不是读成乱码', /二进制/.test(String(bm.error)), String(bm.error));
  ok('但文件大小照给（用户要知道自己挑错了哪个）', bm.bytesTotal === 6, String(bm.bytesTotal));

  const empty = readMaterial('');
  ok('空路径：明说路径是空的', /空的/.test(String(empty.error)), String(empty.error));
}

head('空文件是合法的（读得到，只是没内容）');
{
  const p = put('empty.txt', '');
  const m = readMaterial(p);
  ok('不报错', m.error === null, String(m.error));
  ok('大小 0 就是 0（这是真值，不是"读不到"）', m.bytesTotal === 0 && m.bytesIncluded === 0);
  ok('不算截断', m.truncated === 0);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail ? '✗' : '✓'} council-materials: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
