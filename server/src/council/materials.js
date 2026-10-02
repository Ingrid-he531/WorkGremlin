'use strict';

/**
 * 内联材料 —— 把用户挑的文件读成文本，塞进提示词。
 *
 * 为什么是"服务端读好塞进去"而不是让参与者自己去读：参与者是**没有工具的**（见 agents.js），
 * 它连文件都打不开。材料是它唯一的信息来源，所以"给了多少"必须精确可查。
 *
 * 三条规矩：
 *   1. **截断要记账**。bytes_total / bytes_included / truncated 三个值都落库，界面才能说清
 *      「原文件 2.1MB，只给了前 64KB」。悄悄截一半比不读更坏 —— 参与者会以为它看到了全文。
 *   2. **读不到就说读不到**。路径不存在 / 是目录 / 没权限 / 是二进制，一律返回 error，
 *      由路由拒掉这次发起。**不静默跳过**：用户挑的文件没进去，他必须知道。
 *   3. **按字节截，不按字符截**（不然 4 字节的 emoji 会让实际体积翻倍），且不切碎一个
 *      UTF-8 字符（切碎了会变成一串 U+FFFD，参与者读到的是乱码）。
 */

const fs = require('node:fs');

const { DEFAULTS } = require('@workgremlin/shared');

/**
 * 二进制文件不往里读：读成文本只会得到一段乱码，而参与者会把它当正文引用。
 * 判据是**有没有 NUL 字节** —— 纯文本文件（包括中文、emoji）不会有。
 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8 * 1024);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * 按字节截断，并保证不切碎末尾那个 UTF-8 字符。
 * @returns {string}
 */
function sliceUtf8(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = Math.max(0, maxBytes);
  // 最多回退 3 字节：一个 UTF-8 字符最多 4 字节，切在中间时末尾会解码成 U+FFFD
  for (let i = 0; i < 4 && end > 0; i += 1) {
    const s = buf.subarray(0, end).toString('utf8');
    if (!s.endsWith('�')) return s;
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 读一个文件。**不抛异常** —— 失败以 error 字段返回，路由据此给用户一个明确的拒绝理由。
 *
 * @param {string} filePath
 * @param {{ord?:number, maxBytes?:number, remainingTotal?:number}} [opt]
 *   maxBytes 单文件上限；remainingTotal 是总预算里还剩多少（两个都取更小的那个）
 * @returns {{path:string, bytesTotal:number|null, bytesIncluded:number|null,
 *            truncated:number, content:string|null, error:string|null}}
 *   bytesTotal 是文件的**真实大小**（即使读不到内容也要给出，好让用户知道挑错了哪个）；
 *   完全读不到时 bytesTotal / bytesIncluded 为 null（不知道就是不知道）。
 */
function readMaterial(filePath, opt = {}) {
  const p = String(filePath == null ? '' : filePath);
  const base = { path: p, bytesTotal: null, bytesIncluded: null, truncated: 0, content: null, error: null };

  if (!p.trim()) return { ...base, error: '路径是空的' };

  let st;
  try {
    st = fs.statSync(p);
  } catch (err) {
    return { ...base, error: `读不到这个文件：${err && err.code === 'ENOENT' ? '不存在' : (err && err.message) || '未知原因'}` };
  }
  if (st.isDirectory()) return { ...base, bytesTotal: null, error: '这是一个目录，不是文件' };
  if (!st.isFile()) return { ...base, error: '不是普通文件（软链接 / 设备文件读法不同，这里不收）' };

  const bytesTotal = st.size;
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (err) {
    return { ...base, bytesTotal, error: `读这个文件失败：${(err && err.message) || '未知原因'}` };
  }
  if (looksBinary(buf)) {
    return { ...base, bytesTotal, error: '这看起来是二进制文件（含 NUL 字节），读成文本没有意义' };
  }

  const cap = Math.max(0, Number(opt.maxBytes) || DEFAULTS.COUNCIL_MATERIAL_MAX_BYTES);
  const remain = opt.remainingTotal == null ? Infinity : Math.max(0, Number(opt.remainingTotal));
  const limit = Math.min(cap, remain);
  const truncated = buf.length > limit ? 1 : 0;
  const content = sliceUtf8(buf, limit);

  return {
    path: p,
    bytesTotal,
    // 记**实际给了多少字节**（不是"读了多少"）—— 界面据此算"省略了多少"
    bytesIncluded: Buffer.byteLength(content, 'utf8'),
    truncated,
    content,
    error: null,
  };
}

/**
 * 读一批文件，按**总预算**依次分配（顺序即用户挑的顺序，先来的先占额度）。
 *
 * 超预算的后面的文件会拿到 0 字节 —— 那也是一次有意义的截断（truncated=1），
 * 界面会显示"完全没进去"，而不是被悄悄丢掉。
 *
 * @param {string[]} paths
 * @param {{maxBytes?:number, totalMaxBytes?:number}} [opt]
 * @returns {Array<object>} 与 paths 等长、同序
 */
function readMaterials(paths, opt = {}) {
  const total = Math.max(0, Number(opt.totalMaxBytes) || DEFAULTS.COUNCIL_MATERIAL_TOTAL_MAX_BYTES);
  const maxBytes = Math.max(0, Number(opt.maxBytes) || DEFAULTS.COUNCIL_MATERIAL_MAX_BYTES);
  let used = 0;
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const m = readMaterial(p, { maxBytes, remainingTotal: total - used });
    used += m.bytesIncluded || 0;
    out.push(m);
  }
  return out;
}

module.exports = { readMaterial, readMaterials, looksBinary, sliceUtf8 };
