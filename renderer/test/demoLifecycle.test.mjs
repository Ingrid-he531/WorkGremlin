/**
 * Demo lifecycle —— virtual session enters / refreshes / exits like a normal session.
 *
 * This exercises the real Pinia stores (sessions + project + demo + messages) against a tiny fetch
 * mock. It pins the important invariants:
 *   · starting demo installs the virtual session and selects it, while the real project / members /
 *     conversation stay untouched (demo state lives in the demo store);
 *   · a normal /sessions refresh cannot evict the virtual session;
 *   · live demo polls update phase / demo members without touching the real project;
 *   · exiting restores the previously selected real session;
 *   · the demo state has no persistence to restore after a reload (new store starts inactive).
 *
 * Run: `npm run test:demo-lifecycle`
 */
import { createServer } from 'vite';
import { createPinia, setActivePinia } from 'pinia';
import fs from 'node:fs';
import path from 'node:path';

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
const { useDemoStore } = await vite.ssrLoadModule('/src/stores/demo.js');
const { useProjectStore } = await vite.ssrLoadModule('/src/stores/project.js');
const { useSessionStore } = await vite.ssrLoadModule('/src/stores/sessions.js');
const { useMessageStore } = await vite.ssrLoadModule('/src/stores/messages.js');

const realSession = {
  id: 'real-1',
  sessionId: 'real-session-1',
  floor: '1F',
  project: 'wg',
  projectPath: '/tmp/wg',
  source: 'cli',
  live: true,
  mine: true,
  current: true,
  phase: 'thinking',
};
const realFloor = {
  id: '1F',
  name: 'CodeBuddy',
  installed: true,
  client: 'codebuddy',
  clients: ['codebuddy'],
  activeCount: 1,
  sessions: [realSession],
};
const sessionsSnapshot = () => ({
  ok: true,
  floors: [{ ...realFloor, sessions: [{ ...realSession }] }],
  sessions: [{ ...realSession }],
  defaultFloor: '1F',
});
const demoSession = () => ({
  id: '__demo__:session',
  sessionId: '__demo__:session',
  floor: '1F',
  client: 'codebuddy',
  project: '演示工程',
  projectId: '__demo__',
  projectPath: '',
  source: 'demo',
  live: true,
  mine: true,
  current: true,
  phase: 'thinking',
  action: 'server phase',
  taskState: 'running',
  taskStartedAt: Date.now(),
});
const demoMember = {
  memberId: 'coder@__demo__',
  name: 'coder',
  role: '编码实现',
  state: 'busy',
  project: '__demo__',
  client: 'codebuddy',
  sessionId: '__demo__:session',
  tasks: [],
  sessionStatuses: [],
};
const realProject = { id: 'real', name: 'wg', workspacePath: '/tmp/wg', projectName: 'wg' };
const realMember = {
  memberId: 'real-coder@real',
  name: 'real-coder',
  project: 'real',
  client: 'codebuddy',
  state: 'idle',
  tasks: [],
  sessionStatuses: [],
};
const realMessages = [{ id: 9, tsMs: Date.now(), fromMember: 'real', toMember: null, type: 'system', subject: 'real', content: 'real message' }];
const realSnapshot = {
  project: realProject,
  projects: [realProject],
  members: [realMember],
  projectName: 'wg',
  recentMessages: realMessages,
  serverTime: Date.now(),
  serverVersion: 'test',
};
const demoSnapshot = {
  project: { id: '__demo__', name: '__demo__', workspacePath: '', projectName: '演示工程' },
  projects: [{ id: '__demo__', name: '__demo__', workspacePath: '', projectName: '演示工程' }, realProject],
  members: [{ ...demoMember }],
  projectName: '演示工程',
  recentMessages: [{ id: 1, subject: 'demo' }],
  serverTime: Date.now(),
  serverVersion: 'test',
};

let livePhase = 'thinking';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || 'GET').toUpperCase();
  if (u.includes('/api/v1/demo/session') && method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ ok: true, session: demoSession(), snapshot: demoSnapshot }) };
  }
  if (u.includes('/api/v1/demo/session') && method === 'GET') {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, session: { ...demoSession(), phase: livePhase }, members: [{ ...demoMember, state: 'blocked' }] }),
    };
  }
  if (u.includes('/api/v1/demo/session') && method === 'DELETE') {
    return { ok: true, status: 200, json: async () => ({ ok: true, stopped: true }) };
  }
  if (u.includes('/api/v1/sessions')) {
    return { ok: true, status: 200, json: async () => sessionsSnapshot() };
  }
  if (u.includes('/api/v1/snapshot')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: realSnapshot }) };
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) };
};

setActivePinia(createPinia());
const project = useProjectStore();
const sessions = useSessionStore();
const demo = useDemoStore();
const msgs = useMessageStore();
project.serverInfo = { port: 0, token: '' };
project.applyWorkspace({ project: 'real', projectName: 'wg', workspacePath: '/tmp/wg', recent: [], demo: false });
project.applySnapshot(realSnapshot);
msgs.setSnapshot(realMessages);
sessions.applySnapshot(sessionsSnapshot());
sessions.select(realSession.id);

head('进入演示：虚拟会话 + demo-only 成员');
await demo.enter('1F');
ok('demo is active', demo.active === true);
ok('virtual session is in the normal session table', sessions.sessions.some((x) => x.id === '__demo__:session'));
ok('virtual session is selected', sessions.selectedId === '__demo__:session');
ok('the demo snapshot is kept in the demo store', demo.snapshot && demo.snapshot.project.id === '__demo__');
ok('demo member cards are demo-only', demo.members.length === 1 && demo.members[0].project === '__demo__');
ok('the real project is untouched', project.projectId === 'real' && project.project && project.project.id === 'real');
ok('the project selector still lists real projects', project.projects.length === 1 && project.projects[0].id === 'real');
ok('the real member table is untouched', project.members.length === 1 && project.members[0].project === 'real');
ok('the conversation still shows real messages', msgs.count === 1 && msgs.messages[0].subject === 'real');

head('/sessions refresh 不能挤掉虚拟会话');
sessions.applySnapshot(sessionsSnapshot());
ok('virtual session survives a server session snapshot', sessions.sessions.some((x) => x.id === '__demo__:session'));
ok('it is still selected', sessions.selectedId === '__demo__:session');

head('后端实时相位 / 成员状态');
livePhase = 'tool';
await demo.poll();
ok('session phase follows the backend poll', sessions.selected && sessions.selected.phase === 'tool');
ok('demo member state follows the backend poll', demo.members[0].state === 'blocked');
ok('the backend poll never replaces real members', project.members[0].project === 'real');

head('退出演示：恢复真实会话');
await demo.exit({ restore: true });
demo.stopPolling();
ok('demo is inactive', demo.active === false);
ok('the real project is still the real project', project.projectId === 'real' && project.members[0].project === 'real');
ok('demo-only state is dropped', demo.members.length === 0 && demo.snapshot === null);
ok('virtual session is gone', !sessions.sessions.some((x) => x.id === '__demo__:session'));
ok('previous real session is selected', sessions.selectedId === realSession.id);
ok('the real conversation is unchanged', msgs.count === 1 && msgs.messages[0].subject === 'real');

head('刷新/重启不恢复演示');
setActivePinia(createPinia());
const fresh = useDemoStore();
ok('a fresh store starts with demo inactive', fresh.active === false && fresh.session === null);

head('楼层切换 / 选真实会话都会退出演示（App 入口）');
const appSrc = fs.readFileSync(path.resolve('renderer/src/App.vue'), 'utf8');
ok(
  'selected floor change exits demo when it no longer matches the demo floor',
  /demo\.active\s*&&\s*old\s*&&\s*floor\s*&&\s*floor\s*!==\s*demo\.floor/.test(appSrc)
);
ok(
  'selecting a non-demo session exits demo first',
  /demo\.active\s*&&\s*id\s*!==\s*demo\.sessionId/.test(appSrc) && /await\s+demo\.exit/.test(appSrc)
);
ok('the conversation is never replaced by demo messages', !/msgs\.setSnapshot\(demo\.recentMessages\)/.test(appSrc));

head('办公室 / 工位视图单独消费 demo 成员');
const officeSrc = fs.readFileSync(path.resolve('renderer/src/views/IsoOfficeView.vue'), 'utf8');
const stationSrc = fs.readFileSync(path.resolve('renderer/src/views/WorkstationView.vue'), 'utf8');
const sourceExpr = /demo\.active\s*\?\s*demo\.members\s*:\s*project\.members/;
ok('the isometric office prefers demo members when active', sourceExpr.test(officeSrc));
ok('the workstation view prefers demo members when active', sourceExpr.test(stationSrc));

head('服务端只保留一个演示会话');
const { createDemoProvider } = await import('../../server/src/demo/provider.js');
const provider = createDemoProvider();
provider.start('1F');
provider.start('3F');
ok('starting demo on another floor drops the previous demo', !provider.get('1F', '__demo__:session') && Boolean(provider.get('3F', '__demo__:session')));
provider.stopAll();

globalThis.fetch = originalFetch;
await vite.close();
console.log(`\n${fail ? '✗' : '✓'} demo-lifecycle: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
