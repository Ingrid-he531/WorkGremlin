#!/usr/bin/env node
/**
 * 原生模块重建（M0 最高风险项）。
 *
 * 职能：把 better-sqlite3 针对 Electron 的 ABI 重新编译一遍。
 * - 成功：静默退出 0。
 * - 失败：**直接以非零码退出**（绝不静默降级），由人工介入。
 * - 逃生阀：WORKGREMLIN_SKIP_REBUILD=1（仅供无法联网构建时使用，需在日报里显式说明）。
 *
 * 手动执行：npm run rebuild:native
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function resolveElectronVersion() {
  const pkgPath = path.join(root, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function main() {
  if (process.env.WORKGREMLIN_SKIP_REBUILD === '1') {
    console.warn('[workgremlin] WORKGREMLIN_SKIP_REBUILD=1 -> 跳过 electron-rebuild（原生模块可能不可用）');
    return 0;
  }
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
    console.warn('[workgremlin] 检测到 ELECTRON_SKIP_BINARY_DOWNLOAD=1，跳过 electron-rebuild');
    return 0;
  }

  const electronVersion = resolveElectronVersion();
  if (!electronVersion) {
    console.error(
      '[workgremlin] 未找到 node_modules/electron/package.json，无法重建原生模块。\n' +
        '请先执行 npm install（electron 安装可能失败，检查网络/镜像源）。'
    );
    return 1;
  }

  const bin = path.join(root, 'node_modules', '.bin', 'electron-rebuild');
  if (!fs.existsSync(bin)) {
    console.error('[workgremlin] 未找到 electron-rebuild可执行文件，请确认 @electron/rebuild 已安装。');
    return 1;
  }

  console.log(`[workgremlin] electron-rebuild: electron=${electronVersion} module=better-sqlite3 ...`);
  const args = process.argv.includes('--force')
    ? ['-f', '-w', 'better-sqlite3', '-v', electronVersion]
    : ['-w', 'better-sqlite3', '-v', electronVersion];

  const res = spawnSync(bin, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

  if (res.status !== 0) {
    console.error(
      '\n[workgremlin] electron-rebuild 失败。\n' +
        '常见原因：\n' +
        '  1) 缺少构建工具链（python3 / make / g++）：请先安装；\n' +
        '  2) prebuild 下载失败（网络/代理）：设置 npm_config_build_from_source=true 后重试；\n' +
        '  3) Electron ABI 与 better-sqlite3 版本不匹配：调整 package.json 中的版本后重试。\n' +
        '排障后重跑： npm run rebuild:native\n' +
        '临时跳过（需上报）： WORKGREMLIN_SKIP_REBUILD=1 npm install\n'
    );
    return res.status ?? 1;
  }

  console.log('[workgremlin] electron-rebuild 成功：better-sqlite3 已针对 Electron ABI 编译');
  return 0;
}

process.exit(main());
