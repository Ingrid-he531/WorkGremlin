'use strict';

/**
 * Project identity resolution + the server's **default workspace fallback**.
 *
 * There is no user-facing "open project" state. A client shows the office of the project carried
 * by the session it selected; project is only an ownership key for members/tasks/messages and the
 * filter the office applies to gremlins.
 *
 * The server still needs one default directory for:
 *   1. legacy reports that omit `workspacePath` (attribution fallback);
 *   2. the floor poller / resident subagent scan;
 *   3. startup logging and `server.json`.
 *
 * Project name resolution: the default workspace resolves to package.json's name (scope stripped)
 * > the directory name > empty. The name is not displayed as a global selection in the UI.
 *
 * Project management: one workspace = one project row. The same directory always maps to the same
 * project; opening a different default never rewrites other projects' data.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspacesPath } = require('@workgremlin/shared/paths');

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

/* ==================== Default workspace (server fallback) ==================== */

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
 * Server-side **default workspace** (not a user-facing project selection).
 *
 * The office does not follow this value: each client derives the shown project from the session it
 * has selected (GET /api/v1/snapshot?project=<id|path>). The server keeps one default workspace only
 * as a fallback for:
 *   · legacy reports that carry no `workspacePath` (attribution);
 *   · the floor poller / resident subagent scan, which needs one directory to read;
 *   · startup logging and `server.json`.
 *
 * `setDefault` is only used by startup restore; there is no runtime/UI switch.
 *
 * @param {{repo: any, bus: any, initial?: {workspacePath?: string, projectName?: string}}} opts
 */
function createWorkspaceContext(opts) {
  const repo = opts.repo;
  const bus = opts.bus;
  const initial = opts.initial || {};

  /** @type {{workspacePath: string, projectName: string, project: string|null}} */
  let current = {
    workspacePath: initial.workspacePath || '',
    projectName: initial.projectName || '',
    project: null,
  };

  function persist() {
    writeStore({ default: { ...current, savedAt: Date.now() } });
  }

  /** Apply the startup default: update the bus fallback context and persist it. */
  function apply() {
    bus.setContext({ projectName: current.projectName, project: current.project, workspacePath: current.workspacePath });
    persist();
    return { ...current };
  }

  /** Set the default workspace (startup only); throws if the directory does not exist. */
  function setDefault(rawPath) {
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
    current = { workspacePath: abs, projectName, project: row.id };
    return apply();
  }

  /** Establish the startup default (cwd / --workspace). */
  function setInitial() {
    if (initial.workspacePath) {
      try {
        return setDefault(initial.workspacePath);
      } catch {
        /* directory gone / not a directory: keep the initial value */
      }
    }
    return { ...current };
  }

  /**
   * Restore the default saved by the previous run; if that directory is gone, fall back to the
   * startup default. This is persistence of a fallback, not a "last opened project" feature.
   */
  function restore() {
    const store = readStore();
    // New files use `default`; older ones wrote `current`. Read both.
    const saved = store && (store.default || store.current);
    if (!saved || saved.demo) return setInitial();
    try {
      const savedPath = saved.workspacePath || saved.path;
      if (savedPath) return setDefault(savedPath);
    } catch {
      /* directory gone / machine changed: fall back to the startup default */
    }
    return setInitial();
  }

  return {
    get: () => ({ ...current }),
    setDefault,
    restore,
  };
}

module.exports = {
  readPackageName,
  resolveWorkspacePath,
  resolveProjectName,
  createWorkspaceContext,
  storePath,
  slug,
  expand,
};
