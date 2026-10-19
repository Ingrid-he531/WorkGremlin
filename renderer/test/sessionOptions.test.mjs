/**
 * Session dropdown labels —— two different sessions must never render an identical label.
 *
 * Why it is worth pinning: the label is `<tag>-<project> <short-id>`, and the short id used to be a
 * **fixed 8-char prefix** of the session id. 2F Cline's ids are `<epoch-ms>_<rand>`, so two sessions
 * created in the same ~10 seconds share their first 8 digits and the dropdown showed two identical
 * rows (`CLI-wg-cx 17923740`) for genuinely different sessions —— the user reads that as "a duplicate".
 * The fix grows the prefix only as far as it must, so labels stay short but are always unique.
 *
 * Run: `npm run test:session-options`
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

const server = await createServer({
  root: 'renderer',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  ssr: { external: ['@workgremlin/shared'] },
});
const { useSessionStore } = await server.ssrLoadModule('/src/stores/sessions.js');

/** Fresh pinia + a session store whose floor holds exactly the given sessions */
function withSessions(sessions) {
  setActivePinia(createPinia());
  const s = useSessionStore();
  s.selectedFloor = '2F';
  s.floors = [{ id: '2F', name: 'Cline', sessions }];
  return s;
}
const cli = (id, sessionId, project = 'wg-cx') => ({ id, sessionId, project, source: 'cli' });

head('同一层里秒级相邻的会话：label 必须互不相同');
{
  // Real Cline ids from the incident: the first 8 digits are identical.
  const s = withSessions([
    cli('a', '1792374044720_6y3us'),
    cli('b', '1792374085127_ktd7j'),
    cli('c', '1792373971027_vtjlx'),
  ]);
  const labels = s.options.map((o) => o.label);
  ok('三条 label 两两不同', new Set(labels).size === 3, JSON.stringify(labels));
  // Only grew by one char, not the whole id.
  ok('只多给一位就够（不是把整个 id 摊出来）',
    labels.every((l) => l.length <= 'CLI-wg-cx 179237404'.length), JSON.stringify(labels));
  ok('前缀仍然带项目名', labels.every((l) => l.startsWith('CLI-wg-cx ')), JSON.stringify(labels));
}
{
  // Different projects, same id prefix: the project name already tells them apart — no need to grow.
  const s = withSessions([cli('a', '1792374044720_6y3us', 'proj-a'), cli('b', '1792374085127_ktd7j', 'proj-b')]);
  const labels = s.options.map((o) => o.label);
  ok('项目名不同时两条也不同', new Set(labels).size === 2, JSON.stringify(labels));
}
{
  // One id is a prefix of another (a nasty edge): growth must still separate them.
  const s = withSessions([cli('a', 'abcdef'), cli('b', 'abcdefgh')]);
  const labels = s.options.map((o) => o.label);
  ok('一个 id 是另一个的前缀时也能区分', new Set(labels).size === 2, JSON.stringify(labels));
}
{
  // Nothing selected / no floor: no crash, empty list.
  setActivePinia(createPinia());
  const s = useSessionStore();
  s.selectedFloor = '5F';
  s.floors = [];
  ok('没有这一层时返回空数组，不炸', Array.isArray(s.options) && s.options.length === 0);
}

await server.close();
console.log(`\n${fail ? '✗' : '✓'} session-options: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
