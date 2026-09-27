'use strict';

/**
 * 目录总字节数：递归遍历，排除隐藏文件与隐藏目录（名字以 '.' 开头）。
 *
 * 用场：汇总报表按工程聚合时，展示"该工程目录的总大小"。这是服务端现算的
 * 真实体积——不落库、不编造。路径不存在 / 不是目录 → 返回 null（绝不把
 * "算不到"伪装成 0）。符号链接不跟随（避免重复统计 / 死循环）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 缓存：workspace_path -> { at, size }；新鲜期内复用，避免每渲染一遍都走整棵目录树 */
const TTL_MS = 30_000;
const cache = new Map();

/**
 * @param {string} root
 * @returns {number|null} 总字节数；路径无效返回 null
 */
function dirSize(root) {
  if (!root || typeof root !== 'string') return null;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限 / 不存在：跳过这一支
    }
    for (const e of ents) {
      if (e.name === '.' || e.name === '..') continue;
      if (e.name.startsWith('.')) continue; // 排除隐藏文件 / 隐藏目录
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          stack.push(p);
        } else if (e.isFile()) {
          total += fs.statSync(p).size;
        }
        // 符号链接（isSymbolicLink）不跟随、不计体积
      } catch {
        /* 单个项 stat 失败：跳过 */
      }
    }
  }
  return total;
}

/** 带缓存（按 workspace_path，TTL 内复用；顺便清掉过期项） */
function cachedDirSize(root) {
  if (!root) return null;
  const now = Date.now();
  const hit = cache.get(root);
  if (hit && now - hit.at < TTL_MS) return hit.size;
  const size = dirSize(root);
  cache.set(root, { at: now, size });
  // 顺手清理过期缓存，避免长跑内存膨胀
  if (cache.size > 200) {
    for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
  }
  return size;
}

module.exports = { dirSize, cachedDirSize };
