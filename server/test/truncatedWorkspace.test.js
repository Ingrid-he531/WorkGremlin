/**
 * Regression test: when the extension truncates a genie-history directory name, the project
 * path must be completed back to its full value, otherwise the main console loses the live
 * phase for CodeBuddy plugin sessions.
 *
 * Measured (long Windows paths): the extension cuts `base64(project path)` to 64 chars, and
 * 64 base64 chars only carry 48 bytes, so collectProjects decodes just the first half
 * (`.../2026-09-14-19-28-26/Wor`). That no longer equals the real path freshestReporterWs
 * reads, and `p.path === ws` never holds inside listSessions:
 *   currentId stays empty -> sessionRegistry marks `fresh` false -> IsoOfficeView's
 *   canUseFast is false -> the main console drops the 1.5s live phase and falls back to an
 *   inferred "idle", while the project name shows the truncated tail ("Wor").
 *
 * No mocks here: HOME / WORKGREMLIN_HOME point at a temp dir and a real on-disk layout is
 * staged (long path -> truncated dir name + hook state file), then the real listSessions runs:
 *   [1]  premises: the dir name really is truncated and its half is not a dir on disk;
 *   [2]  end-to-end: after completion currentId / project / projectPath / phase are right;
 *   [2b] end-to-end: two candidates share the prefix -> trust order wins over length;
 *   [2c] end-to-end: a candidate missing on disk is still used (isDir is a preference only);
 *   [3]  unit: completeTruncatedWorkspace boundaries;
 *   [3b] unit: ambiguous matches are detectable (truncatedWorkspaceMatches).
 *
 * Run: `npm run test:truncated-ws` (plain node, no dependencies).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ sandbox ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-trunc-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
fs.mkdirSync(path.join(HOME, '.config', 'Code', 'User', 'globalStorage'), { recursive: true });
fs.mkdirSync(path.join(WG, 'hooks'), { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

// Require first: sessions.js captures SERVER_STARTED_AT at load time, and the hook timestamps
// written below must be newer than it, otherwise the "restart epoch" guard drops the phase.
const { listSessions } = require('../src/sessions');
// Decoding / completing genie-history dir names is 1F CodeBuddy on-disk knowledge.
const { decodeDirName, completeTruncatedWorkspace, truncatedWorkspaceMatches } = require('../src/floorCodebuddy');
const log = require('../src/log');

// Capture completion warnings so [2]/[2b]/[2c] can assert when one is (not) emitted, and keep
// the test output clean.
const warns = [];
const origWarn = log.warn;
log.warn = (...a) => {
  warns.push(a.map((x) => String(x)).join(' '));
};

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
function head(t) {
  console.log(`\n${t}`);
}

/* ------------------------------ fixtures ------------------------------ */

/** Real project path: deliberately long (> 48 bytes) to reproduce the 64-char cut. */
const WS = path.join(TMP, 'Users', 'yingh', 'Cline', '2026-09-14-19-28-26', 'WorkGremlin');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'package.json'), JSON.stringify({ name: 'workgremlin' }));

const STORAGE = path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'tencent-cloud.coding-copilot');
const SID = '0819ef3ed32241a4970a17b8013f9289';
const CLIENT = 'codebuddy';
const b64 = Buffer.from(WS).toString('base64url');
const TRUNC = b64.slice(0, 64); // what the extension writes: only the first 64 base64 chars
const decoded = decodeDirName(TRUNC); // ...which decodes to just the first 48 bytes

head('[1] premises: the dir name really is truncated (otherwise this regression tests nothing)');
ok('base64 dir name is longer than 64 chars (so it gets cut)', b64.length > 64, `len=${b64.length}`);
ok('the truncated dir name still decodes to a path', Boolean(decoded), JSON.stringify(decoded));
ok('the decoded path is not the real project path', decoded !== WS, `${decoded} vs ${WS}`);
ok(
  'the decoded path is a prefix of the real path (truncation is a plain prefix cut)',
  WS.replace(/\\/g, '/').toLowerCase().startsWith(decoded.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()),
  `${decoded} ⊄ ${WS}`
);
ok('that half path is not a directory on disk (so isDir is not short-circuiting)', !fs.existsSync(decoded));

// genie-history: written the way the extension does, i.e. the dir name is the truncated base64.
const PROJ_DIR = path.join(STORAGE, 'genie-history', TRUNC);
fs.mkdirSync(path.join(PROJ_DIR, 'conversations', SID), { recursive: true });
fs.writeFileSync(path.join(PROJ_DIR, 'current.json'), JSON.stringify({ conversationId: SID, lastUpdated: Date.now() }));
fs.mkdirSync(path.join(STORAGE, 'todos'), { recursive: true });
fs.writeFileSync(
  path.join(STORAGE, 'todos', `${SID}.json`),
  JSON.stringify({ conversationId: SID, todos: [{ id: 't1', status: 'in_progress', content: 'complete the project name' }] })
);
fs.mkdirSync(path.join(STORAGE, 'message-queue'), { recursive: true });
fs.writeFileSync(
  path.join(STORAGE, 'message-queue', 'mq.json'),
  JSON.stringify({ conversations: { [SID]: { runtime: { activated: true, paused: false }, updatedAt: Date.now(), items: [] } } })
);

/** Write a reporter hook state file; workspacePath is the REAL path (what freshestReporterWs reads). */
function writeHook(sessionId, ws, extra = {}) {
  const name = `${CLIENT}@${ws}@${sessionId}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const ts = Date.now();
  fs.writeFileSync(
    path.join(WG, 'hooks', `${name}.json`),
    JSON.stringify({
      client: CLIENT,
      form: 'vscode',
      sessionId,
      taskId: `task-${sessionId}`,
      taskStartedAt: ts,
      taskWorkspacePath: ws,
      sessionPhase: { ts, workspacePath: ws, phase: 'tool', tool: 'Edit', target: 'renderer/x.js', detail: 'edit renderer/x.js' },
      ...extra,
    })
  );
}
writeHook(SID, WS);

/* ------------------------------ cases ------------------------------ */

head('[2] end-to-end: after completing the half path, listSessions has all three things the console needs');
const st = listSessions({ workspacePath: WS, client: CLIENT, force: true });
ok('currentId points at this session (the premise of `fresh`)', st.current === SID, JSON.stringify(st.current));
ok('workspacePath is the real full path', st.workspacePath === WS, st.workspacePath);
const row = (st.sessions || []).find((s) => s.id === SID);
ok('the session is listed', Boolean(row), JSON.stringify((st.sessions || []).map((s) => s.id)));
if (row) {
  ok('project name is no longer the truncated tail (not "Wor")', row.project === 'workgremlin', JSON.stringify(row.project));
  ok('projectPath is completed back to the full path', row.projectPath === WS, row.projectPath);
  ok('mine is true (attributed to the active project)', row.mine === true);
  ok('phase is the reported truth tool (not an inferred idle)', row.phase === 'tool', row.phase);
  ok('inferred is false (truth is not greyed out)', row.inferred === false, String(row.inferred));
  ok('it is marked as a completion guess (projectPathGuessed)', row.projectPathGuessed === true, String(row.projectPathGuessed));
  ok('a single real candidate is not ambiguous', row.projectPathAmbiguous === false, String(row.projectPathAmbiguous));
}
ok('one matching candidate -> no ambiguity warning', warns.length === 0, JSON.stringify(warns));

/* ---------------------------------------------------------------------------
 * [2b] end-to-end: two candidates share the truncated prefix and "order" and "length"
 * disagree -> the trust order (ws first) must win, we must not fall back to "shortest".
 *
 * This is the core semantic of the ordering change, and a function-level assertion in [3]
 * cannot lock it: there the candidates are hand-built, bypassing the [ws, workspacePath]
 * assembly that listSessions does. Without this section, swapping the implementation back to
 * "shortest" would keep every other test green.
 * --------------------------------------------------------------------------- */
head('[2b] end-to-end: candidates that share the prefix but differ in length -> the trusted one wins');
// Decoy project: shares the truncated 48-byte prefix with WS but is shorter. "Shortest" would
// pick it and attribute the session to the wrong project. It arrives as the second candidate
// (workspacePath), behind the active project (ws, from the hook).
const DECOY = `${decoded}z`;
fs.mkdirSync(DECOY, { recursive: true });
fs.writeFileSync(path.join(DECOY, 'package.json'), JSON.stringify({ name: 'decoy' }));
ok('decoy premise: shares the truncated prefix with WS', WS.startsWith(decoded) && DECOY.startsWith(decoded), DECOY);
ok('decoy premise: shorter than WS ("shortest" would pick it)', DECOY.length < WS.length, `${DECOY.length} < ${WS.length}`);
const st2 = listSessions({ workspacePath: DECOY, client: CLIENT, force: true });
ok('currentId still points at this session (the premise of `fresh`)', st2.current === SID, JSON.stringify(st2.current));
const row2 = (st2.sessions || []).find((s) => s.id === SID);
ok('the session is listed', Boolean(row2));
if (row2) {
  ok('completed to the active project WS, not the shorter decoy', row2.projectPath === WS, `${row2.projectPath} vs ${DECOY}`);
  ok('project name is workgremlin (not the decoy)', row2.project === 'workgremlin', JSON.stringify(row2.project));
  ok('mine stays true (the decoy did not steal attribution)', row2.mine === true);
  ok('flagged ambiguous: two real projects share the prefix', row2.projectPathAmbiguous === true, String(row2.projectPathAmbiguous));
}
ok('ambiguous match -> exactly one warning', warns.length === 1 && /命中 2 个已知工程/.test(warns[0]), JSON.stringify(warns));

/* ---------------------------------------------------------------------------
 * [2c] end-to-end: the winning candidate need not exist on disk. A hard isDir gate here
 * would drop back to the truncated half, i.e. re-open the very bug this module fixes, so
 * this case must be locked end-to-end (the [3] unit case alone is not enough).
 * --------------------------------------------------------------------------- */
head('[2c] end-to-end: a candidate missing on disk is still used (isDir is a preference, not a gate)');
// Long path whose directory is deliberately never created on disk: the reporter still reports
// it (hook state is just a file), so it must win even though isDir() cannot stat it.
const GHOST_WS = path.join(TMP, 'Users', 'yingh', 'NoDirBuddy', '2026-09-14-19-28-26', 'GhostProj');
const GHOST_SID = 'ghost0session0truncated0';
const ghostB64 = Buffer.from(GHOST_WS).toString('base64url');
const GHOST_TRUNC = ghostB64.slice(0, 64);
const ghostDecoded = decodeDirName(GHOST_TRUNC);
const GHOST_DIR = path.join(STORAGE, 'genie-history', GHOST_TRUNC);
fs.mkdirSync(path.join(GHOST_DIR, 'conversations', GHOST_SID), { recursive: true });
fs.writeFileSync(path.join(GHOST_DIR, 'current.json'), JSON.stringify({ conversationId: GHOST_SID, lastUpdated: Date.now() }));
fs.writeFileSync(
  path.join(STORAGE, 'todos', `${GHOST_SID}.json`),
  JSON.stringify({ conversationId: GHOST_SID, todos: [] })
);
ok('ghost premise: its directory is not on disk', !fs.existsSync(GHOST_WS));
ok('ghost premise: its own truncated prefix differs from WS', ghostDecoded !== decoded, `${ghostDecoded} vs ${decoded}`);
writeHook(GHOST_SID, GHOST_WS); // newest timestamp -> freshestReporterWs returns GHOST_WS
const warnsBeforeGhost = warns.length;
const st3 = listSessions({ workspacePath: GHOST_WS, client: CLIENT, force: true });
ok('currentId still points at the ghost session', st3.current === GHOST_SID, JSON.stringify(st3.current));
const row3 = (st3.sessions || []).find((s) => s.id === GHOST_SID);
ok('the ghost session is listed', Boolean(row3));
if (row3) {
  ok('projectPath is completed even though the dir does not exist', row3.projectPath === GHOST_WS, row3.projectPath);
  ok('project name falls back to the dir name', row3.project === 'GhostProj', JSON.stringify(row3.project));
  ok('phase is still the reported truth tool', row3.phase === 'tool', row3.phase);
  ok('it is marked as a completion guess', row3.projectPathGuessed === true, String(row3.projectPathGuessed));
  ok('one matching candidate -> not ambiguous', row3.projectPathAmbiguous === false, String(row3.projectPathAmbiguous));
}
ok('single candidate missing on disk -> no ambiguity warning', warns.length === warnsBeforeGhost, JSON.stringify(warns.slice(warnsBeforeGhost)));

head('[3] unit: completeTruncatedWorkspace boundaries');
// Not truncated: the directory really exists -> returned as-is, no guessing.
const realDir = path.join(TMP, 'short', 'proj');
fs.mkdirSync(realDir, { recursive: true });
ok('path is an existing dir -> returned unchanged (short paths are untouched)', completeTruncatedWorkspace(realDir, [path.join(TMP, 'short')]) === realDir);
// Nothing to complete with: no candidate carries it as a prefix -> returned unchanged.
ok('no candidate carries the prefix -> returned unchanged', completeTruncatedWorkspace(decoded, ['/nope/other']) === decoded);
// Normal completion.
ok('a matching candidate -> completed to the full path', completeTruncatedWorkspace(decoded, [WS]) === WS);
// A candidate equal to the half string itself is not a match (it would complete to itself).
ok('candidate equal to the half string -> skipped, the other one is used', completeTruncatedWorkspace(decoded, [decoded, WS]) === WS);
// isDir is a preference, not a gate: a prefix match that is missing on disk is still used,
// otherwise the caller drops back to the truncated tail (the bug this module fixes).
ok('prefix match but missing on disk -> still completed (isDir is not a gate)', completeTruncatedWorkspace(decoded, [`${WS}-nope`]) === `${WS}-nope`);
// isDir preference: an earlier candidate missing on disk yields to a later one that exists.
{
  const gBase = path.join(TMP, 'ghost', 'ghost-project-name-here');
  const gMissing = `${gBase}-one`; // never created
  const gReal = `${gBase}-two`; // really created
  fs.mkdirSync(gReal, { recursive: true });
  const gPart = gBase.slice(0, gBase.length - 4); // half: both candidates start with it, it is not a dir
  ok('the half string itself is not a dir (premise)', !fs.existsSync(gPart));
  ok('earlier match missing -> yields to the later one that exists', completeTruncatedWorkspace(gPart, [gMissing, gReal]) === gReal);
  ok('no candidate exists -> falls back to the first match (never a hard failure)', completeTruncatedWorkspace(gPart, [gMissing, `${gPart}-x`]) === gMissing);
}
// Order is priority: with two candidates sharing the prefix, the first one wins (not "shortest").
{
  const common = path.join(TMP, 'collide', 'long-project-name-here');
  const second = path.join(TMP, 'collide', 'long-project-name-here-and-more');
  fs.mkdirSync(common, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const part = common.slice(0, common.length - 4); // half: both candidates start with it, it is not a dir
  ok('the half string itself is not a dir (premise)', !fs.existsSync(part));
  ok('shared prefix -> the first candidate wins (even when the longer one is first)', completeTruncatedWorkspace(part, [second, common]) === second);
  ok('(control) swapping the order picks the other one - order, not length, decides', completeTruncatedWorkspace(part, [common, second]) === common);
}
// Empty-value safety.
ok('empty decoded -> returned as empty', completeTruncatedWorkspace('', [WS]) === '');
ok('empty candidates -> returned unchanged', completeTruncatedWorkspace(decoded, []) === decoded);
ok('candidates omitted -> returned unchanged (default arg)', completeTruncatedWorkspace(decoded) === decoded);

head('[3b] unit: truncatedWorkspaceMatches reports the ambiguity the warning is based on');
{
  const base = path.join(TMP, 'amb', 'base-project-name');
  const part = base.slice(0, base.length - 3); // half both candidates start with
  const a = `${base}-alpha`;
  const b = `${base}-beta`;
  ok('duplicated candidate paths collapse to one match', truncatedWorkspaceMatches(part, [a, a]).length === 1, JSON.stringify(truncatedWorkspaceMatches(part, [a, a])));
  ok('two distinct projects sharing the prefix -> two matches', truncatedWorkspaceMatches(part, [a, b]).length === 2, JSON.stringify(truncatedWorkspaceMatches(part, [a, b])));
  ok('a candidate equal to the half string is not a match', truncatedWorkspaceMatches(part, [part]).length === 0);
  ok('an unrelated candidate is not a match', truncatedWorkspaceMatches(part, ['/somewhere/else']).length === 0);
  ok('empty decoded -> no matches', truncatedWorkspaceMatches('', [a]).length === 0);
}

log.warn = origWarn;
// Keep the Chinese summary line: scripts/run-tests.js parses `结果：N 通过 / M 失败`.
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
