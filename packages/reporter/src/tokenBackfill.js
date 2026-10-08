'use strict';

/**
 * 收工后补报 token 的小工（detached 子进程，父进程退出后照常活着）。
 *
 * 为什么要有它：CodeBuddy **插件**形态（VS Code 扩展）本轮那条 request 的 usage
 * 落盘**比 Stop 晚得多** —— 收工那一刻 index.json 里它还是 `{state:'running'}`
 * （没有 startedAt、没有 usage），hook 在 Stop 里等 1.2s 也等不到（本机实测
 * 0c1f… 会话：第一轮 Stop 于 14:12:41，那条 request 直到第二轮开始之后才补上）。
 * 于是插件形态的 token 永远是 "—"。
 *
 * 收工流程不能再拖（TASK_END 得按时发），所以放一个小工在外面：
 * 过几秒再去看一眼落盘，读到了就补报（`/api/v1/task/tokens`，只写 token 四列）。
 *
 * 用法：`node tokenBackfill.js '<json>'`
 * json = { info, project, workspacePath, sessionId, memberId, transcriptPath, startedAt }
 *
 * 补不到（落盘里始终没有本轮那条 / 服务端认不出该补哪一行）就静静退出 ——
 * "没数就是没数"，绝不拿上一轮的数顶上。
 */
const http = require('node:http');

const { turnTokens } = require('./usage');
const { readServerInfo, HTTP_ROUTES } = require('./index');

/** 回头看一眼的时刻（毫秒）：扩展补 usage 的时机不固定，实测晚几十毫秒到几分钟都有 */
const TRY_AT_MS = [4_000, 14_000, 40_000, 90_000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(url, token, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on('error', () => resolve({})); // 服务没起 / 端口变了：算了，不重试、不打搅用户
    req.end(data);
  });
}

async function main() {
  let cfg = {};
  try {
    cfg = JSON.parse(process.argv[2] || '{}');
  } catch {
    return;
  }
  const info = cfg.info || readServerInfo();
  const startedAt = Number(cfg.startedAt) || 0;
  if (!info || !info.port || !cfg.transcriptPath || !(startedAt > 0)) return;
  const base = `http://127.0.0.1:${info.port}`;

  let slept = 0;
  for (const at of TRY_AT_MS) {
    if (at > slept) {
      await sleep(at - slept);
      slept = at;
    }
    const tokens = turnTokens(cfg.transcriptPath, startedAt);
    if (!tokens) continue; // 还没落盘 → 下一个时刻再看
    await post(`${base}${HTTP_ROUTES.TASK_TOKENS}`, info.token, {
      project: cfg.project || '',
      workspacePath: cfg.workspacePath || '',
      sessionId: cfg.sessionId || '',
      memberId: cfg.memberId || '',
      startedAt,
      tokens,
    });
    return;
  }
}

main().catch(() => {});
