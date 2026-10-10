'use strict';

/**
 * 工程（workspace）标识解析 + 工程管理（"打开工程"）。
 *
 * 本文件合并了原 src/project.js（工程名解析）与 src/workspace.js（打开/切换工程管理）。
 *
 * 工程名解析：顶部连接条要显示"现在盯的是哪个工程"，名字按优先级取：
 *   1. WORKGREMLIN_WORKSPACE / 入参指定的目录
 *   2. 否则 process.cwd()
 * 名字本身：<dir>/package.json 的 name（去 scope） > 目录名 > 空串。
 *
 * 拿不到就是空串 —— UI 侧回落到原来的提示，绝不编造一个"看起来像"的项目名。
 *
 * 工程管理：一个 workspace 一个 project：打开哪个工程，屋里就显示哪个工程的成员（含这个工程下的 subagent 幽灵）。
 * 选择会落盘到 ~/.workgremlin/workspaces.json，重开还在；演示数据作为一项可随时切回。
 *
 * 为什么要手工打开：磁盘上没有"当前在跑哪些 subagent"的运行态，
 * 服务端只能盯住**某个工程**的清单文件 <workspace>/.workgremlin/subagents.json。
 * 工程不定，清单就无从谈起。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WS_EVENTS } = require('@workgremlin/shared');
const { feedFilePath } = require('./ingest/subagentFeed');
const config = require('./config');

/* ============================ 工程名解析 ============================ */

/**
 * @param {string} [dir]
 * @returns {string} package.json 的 name（已去掉 @scope/），读不到返回 ''
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
 * 工程根目录。
 * @param {string} [input]
 */
function resolveWorkspacePath(input) {
  const raw = String(input || process.env.WORKGREMLIN_WORKSPACE || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd());
}

/**
 * 工程名。
 * @param {string} [workspacePath]
 */
function resolveProjectName(workspacePath) {
  const dir = resolveWorkspacePath(workspacePath);
  const fromPkg = readPackageName(dir);
  if (fromPkg) return fromPkg;
  const base = path.basename(dir);
  return base && base !== path.sep ? base : '';
}

/* ============================ 工程管理 ============================ */

function storePath() {
  return path.join(config.home(), 'workspaces.json');
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
    /* 非 POSIX 忽略 */
  }
  return file;
}

/** 工程目录名 -> project id */
function slug(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workspace'
  );
}

/** 把 ~/xxx 展开成绝对路径 */
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
  /** 工程切换后的回调（index.js 里用来重启 subagent 清单监听） */
  let onSwitch = null;

  function persist() {
    writeStore({ current: { ...current, openedAt: Date.now() }, recent });
  }

  function pushRecent(entry) {
    recent = [entry, ...recent.filter((r) => r.path !== entry.path)].slice(0, 8);
  }

  /** 切换生效：更新 bus 上下文 -> 落盘 -> 通知 -> 广播新快照 */
  function apply() {
    bus.setContext({ projectName: current.projectName, project: current.project, workspacePath: current.workspacePath });
    persist();
    if (onSwitch) onSwitch(current);
    broadcast(null, WS_EVENTS.SNAPSHOT, bus.buildSnapshot(null));
    return { ...current };
  }

  /** 打开一个工程目录；目录不存在或不是目录就抛错（不猜、不新建） */
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
    // 同一个目录复用同一个工程；不同目录同名就加后缀，别互相顶掉
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

  /** 切到演示工程（不删库里的真数据，只是把显示切到演示工程） */
  function openDemo() {
    bus.ensureProject(demoProject, '', null, 'report');
    current = { workspacePath: '', projectName: config.DEMO_PROJECT_NAME, project: demoProject, demo: true };
    return apply();
  }

  /**
   * 兜底：把"启动时解析出来的工程"（cwd / --workspace）真正 open 一次。
   *
   * 关键：必须走 open() —— 它会把 current.project 落成这个工程对应的 project，并 setContext 交给 bus。
   * 老代码在兜底分支直接 `return {...current}`，project 仍是 null；而 buildSnapshot 在拿不到
   * project 时会回落到 projects[0]（可能正是演示/被污染的 project），办公室就挂着错的成员，
   * 跟不上当前会话。目录不存在 / 没路径就原样返回（此时确实没有"当前工程"可言）。
   */
  function openInitial() {
    if (initial.workspacePath) {
      try {
        return open(initial.workspacePath);
      } catch {
        /* 目录没了 / 不是目录：保持现状 */
      }
    }
    return { ...current };
  }

  /**
   * 启动时恢复上次打开的工程；目录已经没了就落到启动时解析出来的工程（cwd / --workspace）。
   *
   * 关于演示工程：**这里只认落盘的历史**，没有"启动就进演示"这回事了 ——
   * 演示模式改由界面上的按钮切换（见 server/src/index.js 的 syncDemo）。
   * 上次是用户自己点的「演示模式」→ 这次启动照旧回到演示工程（和回到任何别的工程一样）；
   * 从没打开过工程 → 落到启动时解析出来的工程，而不是硬塞演示数据。
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
      /* 目录没了 / 换了机器：回落默认 */
    }
    return openInitial();
  }

  return {
    current: () => ({ ...current, feedPath: current.workspacePath ? feedFilePath(current.workspacePath) : '' }),
    recent: () => recent.slice(),
    feedPath: () => (current.workspacePath ? feedFilePath(current.workspacePath) : ''),
    open,
    openDemo,
    restore,
    setOnSwitch: (fn) => {
      onSwitch = fn;
    },
  };
}

module.exports = { readPackageName, resolveWorkspacePath, resolveProjectName, createWorkspaceManager, storePath, slug, expand };
