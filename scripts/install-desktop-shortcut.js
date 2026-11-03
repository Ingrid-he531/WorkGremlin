#!/usr/bin/env node
'use strict';

/**
 * Install a Linux application-menu / desktop shortcut that launches WorkGremlin from this
 * source checkout (the same thing `npm run launch:electron` does).
 *
 * The shortcut is "self-healing": the generated launcher always resolves this repository and
 * the Electron binary at click time, so moving the checkout only requires re-running the
 * installer, and editing the source is picked up on the next launch (no repackaging needed).
 *
 * Usage:
 *   node scripts/install-desktop-shortcut.js                 install (menu entry + desktop icon + launcher)
 *   node scripts/install-desktop-shortcut.js --no-desktop    install only into the application menu
 *   node scripts/install-desktop-shortcut.js --autostart     also start WorkGremlin on login
 *   node scripts/install-desktop-shortcut.js --uninstall     remove everything this script installed
 *   node scripts/install-desktop-shortcut.js --dry-run       print what would be written, touch nothing
 *
 * Installed files:
 *   ~/.local/bin/workgremlin                                   launcher script
 *   <XDG_DATA_HOME>/applications/workgremlin.desktop           menu entry
 *   <XDG_DATA_HOME>/icons/hicolor/scalable/apps/workgremlin.svg icon
 *   ~/Desktop/workgremlin.desktop                              desktop icon (when the dir exists)
 *   <XDG_CONFIG_HOME>/autostart/workgremlin.desktop            only with --autostart
 *
 * Install writes the fixed paths below (overwriting whatever is there); uninstall removes only
 * files carrying the WorkGremlin marker, so a shortcut the user created by hand is never deleted.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

const BIN_DIR = path.join(HOME, '.local', 'bin');
const APPS_DIR = path.join(XDG_DATA_HOME, 'applications');
const ICONS_ROOT = path.join(XDG_DATA_HOME, 'icons', 'hicolor');
const ICON_DIR = path.join(ICONS_ROOT, 'scalable', 'apps');
const AUTOSTART_DIR = path.join(XDG_CONFIG_HOME, 'autostart');
const ICON_SOURCE = path.join(__dirname, 'assets', 'workgremlin.svg');

const DESKTOP_ID = 'workgremlin.desktop';
const LAUNCHER = path.join(BIN_DIR, 'workgremlin');
const ICON = path.join(ICON_DIR, 'workgremlin.svg');
const MENU_ENTRY = path.join(APPS_DIR, DESKTOP_ID);
const AUTOSTART_ENTRY = path.join(AUTOSTART_DIR, DESKTOP_ID);

const MARKER = 'X-WorkGremlin-Managed=true';
const SCRIPT_MARKER = '# Managed by WorkGremlin (scripts/install-desktop-shortcut.js)';
const SVG_MARKER = '<!-- Managed by WorkGremlin (scripts/install-desktop-shortcut.js) -->';

const argv = process.argv.slice(2);
const opts = {
  uninstall: argv.includes('--uninstall'),
  dryRun: argv.includes('--dry-run'),
  desktop: !argv.includes('--no-desktop'),
  autostart: argv.includes('--autostart'),
};

const known = new Set(['--uninstall', '--dry-run', '--no-desktop', '--autostart']);
const unknown = argv.filter((a) => !known.has(a));
if (unknown.length > 0) {
  console.error(`[workgremlin] unknown option(s): ${unknown.join(' ')}`);
  process.exit(2);
}

/** Shell-quote for `sh`/`bash` single-quoted strings. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Quote an Exec= value only when it contains characters the desktop spec reserves. */
function desktopExec(value) {
  if (!/[ \t"'\\$`]/.test(value)) return value;
  return `"${value.replace(/[\\"`$]/g, '\\$&')}"`;
}

function desktopEntry(execPath, { autostart = false } = {}) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=WorkGremlin',
    'GenericName=AI Agent Office',
    'Comment=Launch the WorkGremlin AI agent office from the source checkout',
    `Exec=${desktopExec(execPath)}`,
    'Icon=workgremlin',
    'Terminal=false',
    'Categories=Utility;',
    'Keywords=AI;agent;office;workgremlin;',
    'StartupNotify=true',
    'StartupWMClass=Electron',
    MARKER,
    ...(autostart ? ['X-GNOME-Autostart-enabled=true'] : []),
    '',
  ].join('\n');
}

function launcherScript() {
  // The detailed output goes to a log because the shortcut has no terminal.
  return `#!/usr/bin/env bash
${SCRIPT_MARKER}
# Do not edit: re-run \`npm run shortcut:install\` instead.
set -u

REPO=${shQuote(REPO_ROOT)}
NODE_BIN=${shQuote(path.dirname(process.execPath))}
LOG_DIR="\${XDG_STATE_HOME:-\$HOME/.local/state}/workgremlin"
LOG="\$LOG_DIR/launcher.log"

mkdir -p "\$LOG_DIR"
export PATH="\$NODE_BIN:\$PATH"

fail() {
  printf '[%s] ERROR: %s\\n' "\$(date -Is)" "\$*" >>"\$LOG"
  notify-send --app-name=WorkGremlin "WorkGremlin failed to start" "\$* (see \$LOG)" 2>/dev/null || true
  exit 1
}

[ -d "\$REPO" ] || fail "repository directory is missing: \$REPO"
cd "\$REPO" || fail "cannot enter \$REPO"

ELECTRON="\$REPO/node_modules/.bin/electron"
[ -x "\$ELECTRON" ] || fail "electron is not installed; run npm install in \$REPO"

# The Electron launcher serves renderer/dist, so build it only when it is missing.
if [ ! -f renderer/dist/index.html ]; then
  printf '[%s] renderer/dist is missing, building the renderer first\\n' "\$(date -Is)" >>"\$LOG"
  npm run build >>"\$LOG" 2>&1 || fail "renderer build failed"
fi

printf '[%s] launching WorkGremlin from %s\\n' "\$(date -Is)" "\$REPO" >>"\$LOG"
"\$ELECTRON" "\$REPO/desktop/src/launcher.js" >>"\$LOG" 2>&1
status=\$?
[ "\$status" -eq 0 ] || fail "launcher exited with status \$status"
`;
}

function desktopDir() {
  const r = spawnSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' });
  if (r.status === 0) {
    const dir = String(r.stdout || '').trim();
    if (dir) return dir;
  }
  return path.join(HOME, 'Desktop');
}

function isManaged(file, marker) {
  try {
    return fs.readFileSync(file, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function writeFile(file, content, mode) {
  ensureDir(path.dirname(file));
  if (opts.dryRun) {
    console.log(`[dry-run] would write ${file}`);
    return;
  }
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  console.log(`[workgremlin] wrote ${file}`);
}

function removeManaged(file, marker) {
  if (!fs.existsSync(file)) return false;
  if (!isManaged(file, marker)) {
    console.warn(`[workgremlin] skip ${file}: it was not created by this script (no marker)`);
    return false;
  }
  if (opts.dryRun) {
    console.log(`[dry-run] would remove ${file}`);
    return true;
  }
  fs.rmSync(file, { force: true });
  console.log(`[workgremlin] removed ${file}`);
  return true;
}

function runQuiet(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return r.status === 0;
}

function refreshCaches() {
  if (opts.dryRun) return;
  runQuiet('update-desktop-database', [APPS_DIR]);
  if (fs.existsSync(ICONS_ROOT)) runQuiet('gtk-update-icon-cache', ['-f', '-t', ICONS_ROOT]);
}

function markTrusted(file) {
  if (opts.dryRun) return;
  // GNOME's desktop-icons extension only launches a .desktop file marked as trusted.
  runQuiet('gio', ['set', file, 'metadata::trusted', 'true']);
}

function installDefaultShortcut() {
  if (!fs.existsSync(ICON_SOURCE)) {
    console.error(`[workgremlin] icon asset is missing: ${ICON_SOURCE}`);
    process.exit(1);
  }

  writeFile(LAUNCHER, launcherScript(), 0o755);
  writeFile(ICON, fs.readFileSync(ICON_SOURCE, 'utf8'), 0o644);
  writeFile(MENU_ENTRY, desktopEntry(LAUNCHER), 0o755);

  if (opts.desktop) {
    const dir = desktopDir();
    if (fs.existsSync(dir)) {
      const target = path.join(dir, DESKTOP_ID);
      writeFile(target, desktopEntry(LAUNCHER), 0o755);
      markTrusted(target);
    } else {
      console.log(`[workgremlin] desktop directory not found (${dir}); skipped the desktop icon`);
    }
  }

  if (opts.autostart) {
    writeFile(AUTOSTART_ENTRY, desktopEntry(LAUNCHER, { autostart: true }), 0o755);
  }

  refreshCaches();
  if (opts.dryRun) {
    console.log('[workgremlin] dry run complete: nothing was written.');
    return;
  }
  console.log('[workgremlin] shortcut installed: search "WorkGremlin" in the application menu or use the desktop icon.');
  console.log('[workgremlin] launch log: ~/.local/state/workgremlin/launcher.log');
}

function uninstallShortcut() {
  let removed = removeManaged(LAUNCHER, SCRIPT_MARKER);
  removed = removeManaged(ICON, SVG_MARKER) || removed;
  removed = removeManaged(MENU_ENTRY, MARKER) || removed;
  removed = removeManaged(AUTOSTART_ENTRY, MARKER) || removed;

  const dir = desktopDir();
  if (removed || fs.existsSync(dir)) {
    removed = removeManaged(path.join(dir, DESKTOP_ID), MARKER) || removed;
  }

  refreshCaches();
  console.log(
    removed
      ? '[workgremlin] shortcut removed (the launcher log in ~/.local/state/workgremlin was kept).'
      : '[workgremlin] nothing to remove.'
  );
}

function main() {
  if (process.platform !== 'linux') {
    console.error(
      `[workgremlin] this installer supports Linux desktop entries only (current platform: ${process.platform}).\n` +
        '  On macOS/Windows, launch with `npm run launch:electron` or use the packaged app.'
    );
    return 1;
  }

  console.log(`[workgremlin] repository: ${REPO_ROOT}`);
  if (opts.uninstall) uninstallShortcut();
  else installDefaultShortcut();
  return 0;
}

process.exitCode = main();
