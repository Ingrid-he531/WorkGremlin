#!/usr/bin/env node
/**
 * Native module rebuild (M0's highest-risk item).
 *
 * Role: recompile better-sqlite3 against Electron's ABI.
 * - Success: exit 0 silently.
 * - Failure: **exit with a non-zero code** (never degrade silently); a human must step in.
 * - Escape hatch: WORKGREMLIN_SKIP_REBUILD=1 (only for environments that cannot build online; must be
 *   stated explicitly in the daily report).
 *
 * Manual run: npm run rebuild:native
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
    console.warn('[workgremlin] WORKGREMLIN_SKIP_REBUILD=1 -> skipping electron-rebuild (native modules may be unavailable)');
    return 0;
  }
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
    console.warn('[workgremlin] detected ELECTRON_SKIP_BINARY_DOWNLOAD=1; skipping electron-rebuild');
    return 0;
  }

  const electronVersion = resolveElectronVersion();
  if (!electronVersion) {
    console.error(
      '[workgremlin] node_modules/electron/package.json not found; cannot rebuild native modules.\n' +
        'Run npm install first (the electron install may have failed; check the network/mirror).'
    );
    return 1;
  }

  const bin = path.join(root, 'node_modules', '.bin', 'electron-rebuild');
  if (!fs.existsSync(bin)) {
    console.error('[workgremlin] electron-rebuild executable not found; make sure @electron/rebuild is installed.');
    return 1;
  }

  console.log(`[workgremlin] electron-rebuild: electron=${electronVersion} module=better-sqlite3 ...`);
  const args = process.argv.includes('--force')
    ? ['-f', '-w', 'better-sqlite3', '-v', electronVersion]
    : ['-w', 'better-sqlite3', '-v', electronVersion];

  const res = spawnSync(bin, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

  if (res.status !== 0) {
    console.error(
      '\n[workgremlin] electron-rebuild failed.\n' +
        'Common causes:\n' +
        '  1) missing build toolchain (python3 / make / g++): install it first;\n' +
        '  2) prebuild download failed (network/proxy): set npm_config_build_from_source=true and retry;\n' +
        '  3) Electron ABI and better-sqlite3 version mismatch: adjust the versions in package.json and retry.\n' +
        'After fixing, re-run: npm run rebuild:native\n' +
        'To skip temporarily (must be reported): WORKGREMLIN_SKIP_REBUILD=1 npm install\n'
    );
    return res.status ?? 1;
  }

  console.log('[workgremlin] electron-rebuild succeeded: better-sqlite3 compiled for the Electron ABI');
  return 0;
}

process.exit(main());
