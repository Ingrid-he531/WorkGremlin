'use strict';

/**
 * Total bytes of a directory: recursive walk, excluding hidden files and hidden directories
 * (names starting with '.').
 *
 * Usage: when roll-up reports aggregate by project, they show "total size of that project
 * directory". This is the real size computed live on the server — not persisted, not fabricated.
 * A missing path / non-directory returns null (never disguise "cannot compute" as 0).
 * Symbolic links are not followed (to avoid double counting / infinite loops).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Cache: workspace_path -> { at, size }; reused while fresh to avoid walking the whole tree on every render */
const TTL_MS = 30_000;
const cache = new Map();

/**
 * @param {string} root
 * @returns {number|null} total bytes; null when the path is invalid
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
      continue; // no permission / missing: skip this branch
    }
    for (const e of ents) {
      if (e.name === '.' || e.name === '..') continue;
      if (e.name.startsWith('.')) continue; // exclude hidden files / hidden directories
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          stack.push(p);
        } else if (e.isFile()) {
          total += fs.statSync(p).size;
        }
        // Symbolic links (isSymbolicLink) are neither followed nor counted
      } catch {
        /* a single entry failing to stat: skip it */
      }
    }
  }
  return total;
}

/** Cached variant (keyed by workspace_path, reused within TTL; expired entries are cleaned up on the way) */
function cachedDirSize(root) {
  if (!root) return null;
  const now = Date.now();
  const hit = cache.get(root);
  if (hit && now - hit.at < TTL_MS) return hit.size;
  const size = dirSize(root);
  cache.set(root, { at: now, size });
  // Sweep expired entries while we are here, so long-running processes do not bloat memory
  if (cache.size > 200) {
    for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
  }
  return size;
}

module.exports = { dirSize, cachedDirSize };
