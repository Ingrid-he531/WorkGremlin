'use strict';

/**
 * plugin.js —— IDE 插件（编辑器 globalStorage）落盘的**通用定位与公共约定**。
 *
 * 本文件只做"与具体产品无关"的那一层，谁都别往这里塞某个楼层的知识：
 *   · 插件落在哪：globalStorageRoots（扩展数据根）/ workspaceStorageRoots（按工作区数据）
 *   · 在 globalStorage 里按**调用方给的**目录名正则 + 落盘标记找某个产品的插件存储根
 *     （findPluginStorage —— 匹配规则全部由调用方按楼层传入）
 *   · 插件来源共用的落盘窗口常量（IDLE_MS / … / DONE_TTL_MS）
 *
 * 各楼层**自己的**落盘格式一律留在各楼层文件里（见 floors.js 的 FLOOR_CONTRACT）：
 *   · 1F CodeBuddy 的 genie-history / todos / file-changes / message-queue → floorCodebuddy.js 的 pluginStore
 *   · 9F GitHub Copilot 的 session-store.db / state.vscdb                    → floorCopilot.js
 * sessions.js 的 listSessions 按 client 把落盘读取派发到对应楼层，本文件只被它们当成
 * "找目录 + 窗口常量"用 —— 不再出现任何产品目录名，也不再内置"所有插件产品的并集"这类兜底
 * （那个并集正是"9F 误扫 1F 落盘"的根因，见 server/test/taskSync.test.js [8]）。
 *
 * 「绝不编造」纪律：找不到就是找不到，回空串 / 空数组，绝不猜。
 */

const path = require('node:path');
const os = require('node:os');
const { dataRoots, globalStorageRoots, isDir, isFile, readDir } = require('./roots');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** 落盘窗口（与 CLI 楼层对齐，sessionRegistry 的 TIMEOUT_MS = 60 分钟） */
const IDLE_MS = 10 * 60_000; // 多久没动静算"不活跃"（插件 runtime 没有心跳，只能用文件时间）
const BUSY_MS = 90_000; // 文件改动在这么久之内 → 认为正在动手
const FRESH_MS = 2 * 60_000; // 落盘在这么久之内 → 这一轮对话还在推进（含纯推理、只读工具等拿不到文件/待办证据的情况）
const LISTED_MS = 60 * 60_000; // 会话"还在下拉里"的窗口（见 sessions.js 说明）
const DONE_TTL_MS = 10 * 60_000; // 完成标记的"新鲜期"：只有这么久之内结束的才算"刚发生"

/** 编辑器 workspaceStorage 目录（VS Code 按工作区存 state.vscdb 的地方） */
function workspaceStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Code', 'Code - Insiders', 'Cursor', 'Trae', 'Windsurf', 'VSCodium']) {
      const p = path.join(r, ed, 'User', 'workspaceStorage');
      if (isDir(p)) out.push(p);
    }
  }
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'workspaceStorage');
  if (isDir(srv)) out.push(srv);
  return out;
}

/**
 * 插件存储根目录：按调用方给的目录名正则，在 globalStorage 里找出**这一个楼层**的插件目录。
 * 调用方一律传**自己楼层的** meta.pluginRe（别用"所有产品"的并集），并可用 marks 再确认
 * 这一份是"有会话落盘的那份"（例如 `github.copilot` 基础扩展与 `github.copilot-chat` 同前缀时，
 * 用 ['session-store.db'] 把没有会话库的那个挡掉）。
 * @param {RegExp|RegExp[]} re 该产品目录名匹配；**按给定顺序**在目录列表里找第一个命中。不传 = 不匹配。
 * @param {string[]} [marks] 命中目录里必须存在的子目录 / 文件名（任一即可）。空 = 不校验。
 * @returns {string} 命中的存储根绝对路径；找不到回 ''
 */
function findPluginStorage(re, marks = []) {
  const list = (Array.isArray(re) ? re : re ? [re] : []).filter(Boolean);
  if (!list.length) return '';
  const need = Array.isArray(marks) ? marks.filter(Boolean) : [];
  for (const root of globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (!list.some((rx) => rx.test(name))) continue;
      const dir = path.join(root, name);
      if (need.length && !need.some((m) => isDir(path.join(dir, m)) || isFile(path.join(dir, m)))) continue;
      return dir;
    }
  }
  return '';
}

module.exports = {
  // 与产品无关的落盘定位
  dataRoots,
  globalStorageRoots,
  workspaceStorageRoots,
  findPluginStorage,
  // 插件来源共用的落盘窗口常量（sessions.js / floorCopilot.js 共用，避免各定义一份）
  IDLE_MS,
  BUSY_MS,
  FRESH_MS,
  LISTED_MS,
  DONE_TTL_MS,
};
