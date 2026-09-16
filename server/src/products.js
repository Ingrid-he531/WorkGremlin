'use strict';

/**
 * 楼层 = 受监控的产品源。
 *   1F  CodeBuddy CLI
 *   2F  WorkBuddy CLI
 *   3F  CodeBuddy 插件
 *
 * 这里只做"本机是否装了"的探测（渲染层据此把未安装的楼层置灰），
 * 不负责拉取各产品内部的 agent 数据 —— 那是下一步的事。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

/** 命令是否在 PATH 里（跨平台） */
function hasCommand(cmd) {
  try {
    const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(probe, { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/** 在常见编辑器的扩展目录里翻 CodeBuddy 插件 */
function hasPlugin() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!home) return false;
  const roots = [];
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.trae', '.windsurf']) {
    roots.push(path.join(home, editor, 'extensions'));
  }
  const re = /codebuddy|tencent|ingram|code-buddy/i;
  for (const r of roots) {
    try {
      if (fs.readdirSync(r).some((d) => re.test(d))) return true;
    } catch {
      /* 目录不存在，跳过 */
    }
  }
  return false;
}

const PRODUCTS = [
  { id: '1F', name: 'CodeBuddy CLI', kind: 'cli', detect: () => hasCommand('codebuddy') },
  { id: '2F', name: 'WorkBuddy CLI', kind: 'cli', detect: () => hasCommand('workbuddy') },
  { id: '3F', name: 'CodeBuddy 插件', kind: 'plugin', detect: hasPlugin },
];

/** 探测三个楼层对应的产品是否已安装 */
function detectProducts() {
  return PRODUCTS.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    installed: Boolean(p.detect()),
  }));
}

module.exports = { detectProducts, PRODUCTS };
