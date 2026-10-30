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

const projectA = { id: 'a', name: 'proj-a', workspacePath: '/tmp/a', projectName: 'proj-a' };
const projectB = { id: 'b', name: 'proj-b', workspacePath: '/tmp/b', projectName: 'proj-b' };
const memberA = { memberId: 'a-coder@a', name: 'a-coder', project: 'a', client: 'codex', state: 'idle', tasks: [], sessionStatuses: [] };
const memberB = { memberId: 'b-coder@b', name: 'b-coder', project: 'b', client: 'codex', state: 'busy', tasks: [], sessionStatuses: [] };
const sessionA = { id: 's-a', sessionId: 's-a', floor: '3F', project: 'proj-a', projectPath: '/tmp/a', source: 'cli', live: true, mine: true, current: true };
const sessionB = { id: 's-b', sessionId: 's-b', floor: '3F', project: 'proj-b', projectPath: '/tmp/b', source: 'cli', live: true, mine: true, current: false };

function snapshot(project, member) {
  return {
    project,
    projects: [projectA, projectB],
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
  floors: [{ id: '3F', name: 'Codex', installed: true, client: 'codex', clients: ['codex'], activeCount: 2, sessions: [sessionA, sessionB] }],
  sessions: [sessionA, sessionB],
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

globalThis.fetch = originalFetch;
await vite.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
