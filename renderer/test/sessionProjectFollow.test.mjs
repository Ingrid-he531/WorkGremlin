/**
 * Project follows the selected session, locally.
 *
 * Pinned rules:
 *   · selecting a session loads that session's project snapshot into this client only;
 *   · it must NOT POST /api/v1/workspace (that would switch every connected client);
 *   · a global snapshot for another project does not steal the viewed project;
 *   · reconcile asks for the viewed project, not the server's current one.
 *
 * Run: `npm run test:session-follow`
 */
import { createServer } from 'vite';
import { createPinia, setActivePinia } from 'pinia';

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}
const head = (t) => console.log(`\n${t}`);

const vite = await createServer({
  root: 'renderer',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  ssr: { external: ['@workgremlin/shared'] },
});
const { useProjectStore } = await vite.ssrLoadModule('/src/stores/project.js');
const { useSessionStore } = await vite.ssrLoadModule('/src/stores/sessions.js');

const projectA = { id: 'a', name: 'proj-a', workspacePath: '/tmp/a', projectName: 'proj-a', createdAt: 1000 };
const projectB = { id: 'b', name: 'proj-b', workspacePath: '/tmp/b', projectName: 'proj-b', createdAt: 1000 };
// Historical duplicate: an empty report wiped the stored path, so the next startup created a new
// row for the same directory. It is newer and holds only a fragment of A's members.
const projectAClone = { id: 'a-clone', name: 'a-clone', workspacePath: '/tmp/a', projectName: 'proj-a', createdAt: 2000 };
const memberA = { memberId: 'a-coder@a', name: 'a-coder', project: 'a', client: 'codex', state: 'idle', tasks: [], sessionStatuses: [] };
const memberB = { memberId: 'b-coder@b', name: 'b-coder', project: 'b', client: 'codex', state: 'busy', tasks: [], sessionStatuses: [] };
const sessionA = { id: 's-a', sessionId: 's-a', floor: '3F', project: 'proj-a', projectPath: '/tmp/a', source: 'cli', live: true, mine: true, current: true };
const sessionB = { id: 's-b', sessionId: 's-b', floor: '3F', project: 'proj-b', projectPath: '/tmp/b', source: 'cli', live: true, mine: true, current: false };
// CodeBuddy opened with no folder: the plugin encodes this workspace as `/`, and the server owns
// no project row for it. The dropdown still lists the session (with an unknown project label).
const sessionC = { id: 's-c', sessionId: 's-c', floor: '3F', project: '', projectPath: '/', source: 'plugin', live: true, mine: false, current: false };

function snapshot(project, member) {
  return {
    project,
    // The clone is intentionally first: the server lists projects newest-first, and the buggy
    // follower used to pick projects[0] just because its path matched.
    projects: [projectAClone, projectA, projectB],
    members: [member],
    projectName: project.projectName,
    recentMessages: [],
    serverTime: Date.now(),
    serverVersion: 'test',
  };
}
const snapA = snapshot(projectA, memberA);
const snapB = snapshot(projectB, memberB);

const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || 'GET').toUpperCase();
  requests.push({ url: u, method });
  if (u.includes('/api/v1/workspace')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, ...projectA, recent: [] }) };
  }
  if (u.includes('/api/v1/snapshot')) {
    // The server answers project=null for a path it owns no project row for.
    if (u.includes(`project=${encodeURIComponent(sessionC.projectPath)}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          snapshot: {
            project: null,
            projects: [projectAClone, projectA, projectB],
            members: [],
            projectName: '',
            recentMessages: [],
            serverTime: Date.now(),
            serverVersion: 'test',
          },
        }),
      };
    }
    const snap = /project=b/.test(u) ? snapB : snapA;
    return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: snap }) };
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) };
};

setActivePinia(createPinia());
const project = useProjectStore();
const sessions = useSessionStore();
project.serverInfo = { port: 0, token: '', fallback: true };
project.applySnapshot(snapA, { force: true });
sessions.applySnapshot({
  ok: true,
  floors: [{ id: '3F', name: 'Codex', installed: true, client: 'codex', clients: ['codex'], activeCount: 3, sessions: [sessionA, sessionB, sessionC] }],
  sessions: [sessionA, sessionB, sessionC],
  defaultFloor: '3F',
});

head('初始：当前项目 A');
ok('项目是 A', project.projectId === 'a');
ok('成员是 A 的', project.members.length === 1 && project.members[0].project === 'a');

head('选中 B 会话：只在本机切到 B');
sessions.select('s-b');
await new Promise((r) => setTimeout(r, 20));
ok('项目切到 B', project.projectId === 'b', project.projectId);
ok('成员切到 B 的', project.members.length === 1 && project.members[0].project === 'b', JSON.stringify(project.members));
ok(
  '没有调用 POST /api/v1/workspace（不切服务器全局项目）',
  !requests.some((r) => r.method === 'POST' && r.url.includes('/api/v1/workspace')),
  JSON.stringify(requests)
);
ok(
  '按 B 的路径/ID 请求了快照',
  requests.some((r) => r.url.includes('/api/v1/snapshot') && /project=(b|%2Ftmp%2Fb)/.test(r.url)),
  JSON.stringify(requests)
);

head('别的客户端切全局项目 A：不能抢走本机正在看的 B');
project.applySnapshot(snapA);
ok('项目仍是 B', project.projectId === 'b');
ok('成员仍是 B 的', project.members[0].project === 'b');

head('reconcile 拉取的是 B，不是全局 A');
requests.length = 0;
await project.reconcile();
ok('reconcile 请求带 project=b', requests.some((r) => r.url.includes('project=b')), JSON.stringify(requests));
ok('reconcile 后仍是 B', project.projectId === 'b');

head('选中 A 会话：本机切回 A');
sessions.select('s-a');
await new Promise((r) => setTimeout(r, 20));
ok('项目切回 A', project.projectId === 'a', project.projectId);
ok('成员切回 A 的', project.members[0].project === 'a');

head('选中没有工程行的会话（CodeBuddy 无文件夹 → `/`）：屋子清空，不留上一个工程的人');
requests.length = 0;
sessions.select('s-c');
await new Promise((r) => setTimeout(r, 20));
ok('工程 id 清空', project.projectId === '', project.projectId);
ok('标记为「工程无法解析」', project.projectUnresolved === true);
ok('屋子清空（Susan/Leo 这类上一个工程的成员不会留下）', project.members.length === 0, JSON.stringify(project.members));
ok(
  '按该会话的路径请求了快照',
  requests.some((r) => r.url.includes('/api/v1/snapshot') && r.url.includes(encodeURIComponent('/'))),
  JSON.stringify(requests)
);
project.applySnapshot(snapA);
ok('全局快照（默认工程 A）不能把人塞回来', project.members.length === 0 && !project.project, JSON.stringify(project.members));
project.upsertMember(memberA);
ok('别的工程的 member.status 广播也进不来', project.members.length === 0, JSON.stringify(project.members));
await project.reconcile();
ok('15s 对账（无 project 参数）也不能把人塞回来', project.members.length === 0, JSON.stringify(project.members));

head('再选中 A 会话：正常恢复，且不跳到同路径的新重复工程行');
requests.length = 0;
sessions.select('s-a');
await new Promise((r) => setTimeout(r, 20));
ok('工程恢复为 A', project.projectId === 'a', project.projectId);
ok('成员恢复为 A 的', project.members.length === 1 && project.members[0].project === 'a');
ok('不再处于「工程无法解析」', project.projectUnresolved === false);
ok(
  '跟随会话时选中最早的规范工程行，而不是同路径的较新克隆',
  requests.some((r) => r.url.includes('project=a') && !r.url.includes('project=a-clone')) &&
    !requests.some((r) => r.url.includes('project=a-clone')),
  JSON.stringify(requests)
);

globalThis.fetch = originalFetch;
await vite.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
