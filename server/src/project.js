'use strict';

/**
 * Project (workspace) identity resolution + project management ("open project").
 *
 * This file merges the former src/project.js (project name resolution) and src/workspace.js
 * (open/switch project management).
 *
 * Project name resolution: the top connection bar shows "which project is being watched now",
 * and the name is taken by priority:
 *   1. WORKGREMLIN_WORKSPACE / the directory given as a parameter
 *   2. otherwise process.cwd()
 * The name itself: <dir>/package.json's name (scope stripped) > the directory name > empty string.
 *
 * When it cannot be resolved it is the empty string —— the UI falls back to the original hint
 * and never fabricates a project name that merely "looks right".
 *
 * Project management: one workspace = one project: opening a project shows that project's members
 * in the office (including its subagent ghosts). The choice is persisted to
 * ~/.workgremlin/workspaces.json and restored on restart; demo data is an item you can switch back to.
 *
 * Why open manually: the office (members / gremlins / ghosts) aggregates **by project**, so you see
 * whichever project is open. Subagent ghosts now write straight to the DB (an ephemeral member +
 * a subagent_run) attributed to their own project / session, so the view still follows the open project.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WS_EVENTS } = require('@workgremlin/shared');
const { workspacesPath } = require('@workgremlin/shared/paths');
const config = require('./config');

/* ============================ Project name resolution ============================ */

/**
 * @param {string} [dir]
 * @returns {string} the name from package.json (with @scope/ stripped); '' when it cannot be read
 */
function readPackageName(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
    return name ? name.replace(/^@[^/]+\//, '') : '';
  } catch {
    return '';
  }
}

/**
 * Project root directory.
 * @param {string} [input]
 */
function resolveWorkspacePath(input) {
  const raw = String(input || process.env.WORKGREMLIN_WORKSPACE || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd());
}

/**
 * Project name.
 * @param {string} [workspacePath]
 */
function resolveProjectName(workspacePath) {
  const dir = resolveWorkspacePath(workspacePath);
  const fromPkg = readPackageName(dir);
  if (fromPkg) return fromPkg;
  const base = path.basename(dir);
  return base && base !== path.sep ? base : '';
}

/* ============================ Project management ============================ */

function storePath() {
  return workspacesPath();
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function writeStore(data) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* non-POSIX: ignore */
  }
  return file;
}

/** Project directory name -> project id */
function slug(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workspace'
  );
}

/** Expand ~/xxx into an absolute path */
function expand(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  return path.resolve(raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw);
}

/**
 * @param {{repo: any, bus: any, initial?: {workspacePath?: string, projectName?: string},
 *          demoProject?: string, broadcast?: (project: string|null, type: string, payload: unknown) => void}} opts
 */
function createWorkspaceManager(opts) {
  const repo = opts.repo;
  const bus = opts.bus;
  const demoProject = opts.demoProject || config.DEMO_PROJECT;
  const initial = opts.initial || {};
  const broadcast = opts.broadcast || (() => {});

  /** @type {{workspacePath: string, projectName: string, project: string|null, demo: boolean}} */
  let current = {
    workspacePath: initial.workspacePath || '',
    projectName: initial.projectName || '',
    project: null,
    demo: false,
  };
  let recent = [];
  /** Callback after a project switch (index.js uses it to restart subagent manifest watching) */
  let onSwitch = null;

  function persist() {
    writeStore({ current: { ...current, openedAt: Date.now() }, recent });
  }

  function pushRecent(entry) {
    recent = [entry, ...recent.filter((r) => r.path !== entry.path)].slice(0, 8);
  }

  /** Apply the switch: update bus context -> persist -> notify -> broadcast the new snapshot */
  function apply() {
    bus.setContext({ projectName: current.projectName, project: current.project, workspacePath: current.workspacePath });
    persist();
    if (onSwitch) onSwitch(current);
    broadcast(null, WS_EVENTS.SNAPSHOT, bus.buildSnapshot(null));
    return { ...current };
  }

  /** Open a project directory; throws if the directory does not exist or is not a directory (no guessing, no creating) */
  function open(rawPath) {
    const abs = expand(rawPath);
    if (!abs) throw new Error('empty path');
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }
    if (!st || !st.isDirectory()) throw new Error(`不是目录：${abs}`);

    const projectName = resolveProjectName(abs);
    // The same directory reuses the same project; same-named directories in different places get
    // a suffix instead of overwriting each other
    let row = repo.getProjectByWorkspace.get(abs);
    if (!row) {
      let id = slug(projectName);
      let n = 2;
      while (repo.getProject.get(id)) {
        id = `${slug(projectName)}-${n}`;
        n += 1;
      }
      bus.ensureProject(id, abs, null, 'report');
      row = repo.getProject.get(id);
    }
    current = { workspacePath: abs, projectName, project: row.id, demo: false };
    pushRecent({ path: abs, projectName, project: row.id, openedAt: Date.now() });
    return apply();
  }

  /** Switch to the demo project (does not delete real data in the DB, it only switches the view to the demo project) */
  function openDemo() {
    bus.ensureProject(demoProject, '', null, 'report');
    current = { workspacePath: '', projectName: config.DEMO_PROJECT_NAME, project: demoProject, demo: true };
    return apply();
  }

  /**
   * Fallback: actually open() "the project resolved at startup" (cwd / --workspace) once.
   *
   * Key point: it must go through open() —— that settles current.project into the project this
   * directory maps to and hands it to bus via setContext. The old code did `return {...current}`
   * right in the fallback branch, leaving project null; and buildSnapshot falls back to
   * projects[0] when it has no project (which may be exactly the demo / a polluted project), so
   * the office shows the wrong members and does not track the current session. If the directory
   * is missing or there is no path, return as-is (there really is no "current project" then).
   */
  function openInitial() {
    if (initial.workspacePath) {
      try {
        return open(initial.workspacePath);
      } catch {
        /* directory gone / not a directory: keep the current state */
      }
    }
    return { ...current };
  }

  /**
   * Restore the last opened project at startup; if that directory is gone, fall back to the
   * project resolved at startup (cwd / --workspace).
   *
   * About the demo project: **only the persisted history counts here**, there is no longer such a
   * thing as "start into demo" —— demo mode is toggled from the UI instead (see syncDemo in
   * server/src/index.js). If the user last clicked "demo mode" himself, this startup returns to
   * the demo project as usual (just like returning to any other project); if no project was ever
   * opened, fall back to the project resolved at startup rather than forcing demo data in.
   */
  function restore() {
    const store = readStore();
    if (store) recent = Array.isArray(store.recent) ? store.recent : [];
    const saved = store && store.current;
    if (!saved) return openInitial();
    try {
      if (saved.demo) return openDemo();
      const savedPath = saved.workspacePath || saved.path;
      if (savedPath) return open(savedPath);
    } catch {
      /* directory gone / machine changed: fall back to the default */
    }
    return openInitial();
  }

  return {
    current: () => ({ ...current }),
    recent: () => recent.slice(),
    open,
    openDemo,
    restore,
    setOnSwitch: (fn) => {
      onSwitch = fn;
    },
  };
}

module.exports = { readPackageName, resolveWorkspacePath, resolveProjectName, createWorkspaceManager, storePath, slug, expand };
