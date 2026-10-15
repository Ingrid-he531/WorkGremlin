'use strict';

/**
 * Inline materials —— read the files the user picked as text and stuff them into the prompt.
 *
 * Why "the server reads them and stuffs them in" rather than letting participants read for
 * themselves: participants have **no tools** (see agents.js), they cannot even open a file.
 * Materials are their only source of information, so "how much was given" must be exactly
 * verifiable.
 *
 * Three rules:
 *   1. **Truncation must be accounted for**. bytes_total / bytes_included / truncated are all
 *      persisted, so the UI can state plainly: "the original file is 2.1MB, only the first
 *      64KB was given". Silently cutting it in half is worse than not reading it at all — the
 *      participant would believe it saw the whole thing.
 *   2. **Say it when you cannot read**. A missing path / a directory / no permission / binary
 *      content all return an error, and the route rejects the run because of it. **No silent
 *      skipping**: if a file the user picked did not make it in, he has to know.
 *   3. **Truncate by bytes, not by characters** (otherwise 4-byte emoji would double the real
 *      size), and never split a UTF-8 character in half (splitting it yields a run of U+FFFD,
 *      i.e. garbage for the participant to read).
 */

const fs = require('node:fs');

const { DEFAULTS } = require('@workgremlin/shared');

/**
 * Binary files are never read in: read as text they only produce garbage, which participants
 * would then quote as if it were content.
 * The criterion is **whether there is a NUL byte** —— plain text files (including Chinese and
 * emoji) never contain one.
 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8 * 1024);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * Truncate by bytes, guaranteed not to split the trailing UTF-8 character.
 * @returns {string}
 */
function sliceUtf8(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = Math.max(0, maxBytes);
  // Back off at most 3 bytes: a UTF-8 character is at most 4 bytes, and cutting in the middle
  // would decode the tail into U+FFFD
  for (let i = 0; i < 4 && end > 0; i += 1) {
    const s = buf.subarray(0, end).toString('utf8');
    if (!s.endsWith('�')) return s;
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Read one file. **Throws nothing** —— failures come back in the error field, and the route
 * turns that into an explicit reason for rejecting the run.
 *
 * @param {string} filePath
 * @param {{ord?:number, maxBytes?:number, remainingTotal?:number}} [opt]
 *   maxBytes per-file cap; remainingTotal is what is left of the total budget (the smaller of
 *   the two wins)
 * @returns {{path:string, bytesTotal:number|null, bytesIncluded:number|null,
 *            truncated:number, content:string|null, error:string|null}}
 *   bytesTotal is the file's **real size** (reported even when the content cannot be read, so
 *   the user can tell which one he picked wrong); when nothing can be read at all,
 *   bytesTotal / bytesIncluded are null (unknown means unknown).
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
    // Record **how many bytes were actually given** (not "how many were read") —— the UI uses
    // this to compute how much was left out
    bytesIncluded: Buffer.byteLength(content, 'utf8'),
    truncated,
    content,
    error: null,
  };
}

/**
 * Read a batch of files, allocating by **total budget** in order (order = the order the user
 * picked them, first come first served).
 *
 * Later files that exceed the budget get 0 bytes —— that too is a meaningful truncation
 * (truncated=1), and the UI shows "did not make it in at all" rather than silently dropping it.
 *
 * @param {string[]} paths
 * @param {{maxBytes?:number, totalMaxBytes?:number}} [opt]
 * @returns {Array<object>} same length and order as paths
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
