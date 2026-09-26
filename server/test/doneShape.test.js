/**
 * 完成标记的**形状契约**自检 —— 7F Kilo 与 8F OpenCode 共用。
 *
 * 跑法：`npm run test:done-shape`（零外部依赖；express / better-sqlite3 都用工程里已装好的那份）。
 *
 * ## 为什么要有它
 *
 * 各产品的读取器（`kilo.js` / `opencode.js` 的 `read*Done`）返回的是**会话表**形状：
 *   `{ doneAt, doneTitle, doneCount, doneFiles }`
 * —— 那是 `sessionRegistry` 铺会话行时展开用的字段。
 * 而渲染层读**快轮询**（`/api/v1/reporter-phase`）那份完成标记，用的是
 *   `fpDone.at` 与 `fpDone.sessionId`（见 `renderer/src/views/IsoOfficeView.vue`
 *   的 `fastDoneAt` / `sameSession`）。
 *
 * 两套字段名对不上。7F 曾经把 `readKiloDone` 的返回值**原样**塞进响应，于是
 * `fpDone.at` 恒为 `undefined` → 快轮询那份「任务完成」永远不触发。
 * 现象很有欺骗性：会话快照那份还在（每 10s 一条），所以"任务完成"并非不亮，而是
 * **要等最多 10 秒、切一次楼层才亮** —— 很容易被当成偶发，不会有人去查形状。
 *
 * 所以这里不测相位、不测会话，只测一件事：**这个接口吐出来的 `done` 是不是渲染层
 * 真的在读的那个形状**。为此起一个真的 express 实例、用真的 HTTP 打过去 ——
 * 直接调函数会漏掉"字段在中间某一层被改名"这种恰恰是本 bug 的失败模式。
 *
 * 覆盖：
 *   A. 7F Kilo：finish=stop 的会话 → done 里有 at / sessionId（渲染层读得到）
 *   B. 8F OpenCode：同上（轮询那一路的兜底）
 *   C. 没有完成标记时 → done 为 null（不是空对象、不是会话表形状）
 *   D. 回归护栏：会话表形状的字段名（doneAt / doneTitle）**不该**出现在响应里 ——
 *      它们是 sessionRegistry 内部用的，漏到接口上就说明转译被绕过了
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-done-shape-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const KILO_HOME = path.join(HOME, '.local', 'share', 'kilo');
const OC_HOME = path.join(HOME, '.local', 'share', 'opencode');
for (const d of [HOME, WG, KILO_HOME, OC_HOME]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.WORKGREMLIN_KILO_HOME = KILO_HOME;
process.env.WORKGREMLIN_OPENCODE_HOME = OC_HOME;
process.env.PATH = '/nonexistent'; // 地板判定走"没装"也无所谓，这里只测形状

const Database = require('better-sqlite3');

const now = Date.now();
const KILO_SID = 'ses_kilo_shape_0001';
const OC_SID = 'ses_oc_shape_00000001';

/** Kilo 的库：session + event + message；message 里一条刚说完的 assistant（finish=stop，带 time.completed）
 *
 *  列/表要写全：kilo.js 的 listKiloSessions 一条 SELECT 里带了 summary_files / summary_additions /
 *  summary_deletions，少一列整条查询就报错回空（那样测到的就不是"形状"而是"查不到"）；
 *  `event` 表也要摆上 —— hasCoreTables 按 session + event + message 三张表判定。
 */
{
  const db = new Database(path.join(KILO_HOME, 'kilo.db'));
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, project_id text, directory text, title text,
             agent text, model text, cost real DEFAULT 0,
             summary_files integer, summary_additions integer, summary_deletions integer,
             time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
           CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL,
             data text NOT NULL);
           CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, role text, data text,
             time_created integer NOT NULL, time_updated integer NOT NULL);`);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,0,2,5,1,?,?,NULL)').run(
    KILO_SID, 'p', '/tmp/ProjShape', '刚说完', 'code', '{"id":"kilo-auto/free","providerID":"kilo"}', now - 60_000, now
  );
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?,?)').run(
    `${KILO_SID}#1`, KILO_SID, 'assistant',
    JSON.stringify({ role: 'assistant', finish: 'stop', time: { created: now - 30_000, completed: now - 5_000 } }),
    now - 5_000, now - 5_000
  );
  db.close();
}

/** OpenCode 的库：session_v2 + session_message，同样一条刚说完的（finish=stop） */
{
  const db = new Database(path.join(OC_HOME, 'opencode.db'));
  db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text, parent_id text, slug text,
             directory text NOT NULL, title text, version text, agent text, model text, cost real DEFAULT 0,
             summary_files integer, time_created integer NOT NULL, time_updated integer NOT NULL,
             time_archived integer, time_suspended integer);
           CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
             seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,NULL,?,?,?,?,?,?,0,1,?,?,NULL,NULL)').run(
    OC_SID, 'p', 'slug', '/tmp/ProjShape', '刚说完', '2.0.18', 'build',
    '{"id":"space-bunny-free","providerID":"opencode"}', now - 60_000, now
  );
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(
    `${OC_SID}#1`, OC_SID, 'assistant', 1, now - 5_000, now - 5_000,
    JSON.stringify({ finish: 'stop', time: { created: now - 30_000, completed: now - 5_000 }, content: [{ type: 'text', text: '好了' }] })
  );
  db.close();
}

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail !== undefined ? `  —— ${detail}` : ''}`);
  }
}
function head(label) {
  console.log(`\n${label}`);
}

/* ------------------------------ 起真的服务 ------------------------------ */

const express = require('express');
const { createSessionsRouter } = require('../src/http/routes/sessions');

// workspace 只需要 current() 那一个方法（本路由只读它）
const router = createSessionsRouter({ workspace: { current: () => ({ workspacePath: '/tmp/ProjShape' }) } });
const app = express();
app.use('/api/v1', router);

const server = app.listen(0, '127.0.0.1');
// listen 是异步的：address() 在 listening 之前是 null，要等事件
const listening = new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));

/** 真的打一次 HTTP —— 字段名在中间被改名这件事，只有走完整链路才测得出来 */
let port = 0;
function get(url) {
  return new Promise((resolve, reject) => {
    require('node:http')
      .get({ host: '127.0.0.1', port, path: url }, (res) => {
        let b = '';
        res.on('data', (c) => {
          b += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(new Error(`响应不是 JSON：${b.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

/** 渲染层真正在读的那两个字段（IsoOfficeView 的 fastDoneAt / sameSession） */
function assertRendererShape(label, body, sid) {
  const done = body.done;
  ok(`${label}：done 不是 null（有完成标记）`, done !== null, JSON.stringify(body));
  if (!done) return;
  ok(`${label}：done.at 是数字（渲染层读 fpDone.at）`, typeof done.at === 'number' && done.at > 0, JSON.stringify(done));
  ok(`${label}：done.at 落在合理时间窗（不是 0 / 不是 undefined）`, done.at > 0 && Date.now() - done.at < 60_000, String(done.at));
  ok(`${label}：done.sessionId 与请求的会话一致（渲染层据此精确比对，不串味）`, done.sessionId === sid, `${done.sessionId} vs ${sid}`);
  ok(
    `${label}：**不该**出现会话表形状的字段名（doneAt / doneTitle / doneCount / doneFiles）`,
    !('doneAt' in done) && !('doneTitle' in done) && !('doneCount' in done) && !('doneFiles' in done),
    Object.keys(done).join(',')
  );
}

(async () => {
  port = await listening;

  head('[A] 7F Kilo：finish=stop 的会话 → done 是渲染层在读的形状');
  {
    const body = await get(`/api/v1/reporter-phase?client=kilo&session=${KILO_SID}`);
    assertRendererShape('7F', body, KILO_SID);
    ok('7F：顶层 sessionId 也回显成请求的那条', body.sessionId === KILO_SID, String(body.sessionId));
  }

  head('[B] 8F OpenCode：轮询兜底那一路同样形状');
  {
    const body = await get(`/api/v1/reporter-phase?client=opencode&session=${OC_SID}`);
    assertRendererShape('8F', body, OC_SID);
  }

  head('[C] 没有完成标记时 → done 为 null（不是空对象、不是会话表形状）');
  {
    // 会话 id 用纯 ASCII：URL 里塞中文会被 node 的 http 客户端当未转义字符拒掉（跟本用例无关）
    const MISSING = 'ses_no_such_session_0001';
    const body = await get(`/api/v1/reporter-phase?client=kilo&session=${MISSING}`);
    ok('查不到的会话：done 为 null', body.done === null, JSON.stringify(body.done));
    ok('查不到的会话：phase 为 null（而不是编一个）', body.phase === null, String(body.phase));
    const body2 = await get(`/api/v1/reporter-phase?client=opencode&session=${MISSING}`);
    ok('OpenCode 侧同样：done 为 null', body2.done === null, JSON.stringify(body2.done));
  }

  head('[D] 回归护栏：会话表形状只留在 sessionRegistry 内部');
  {
    // sessionRegistry 铺会话行时**用**的是 doneAt / doneTitle / doneFiles —— 那一层就该是它们。
    const { snapshot } = require('../src/sessionRegistry');
    const snap = snapshot({ workspacePath: '/tmp/ProjShape', force: true });
    const f7 = snap.floors.find((f) => f.id === '7F');
    const s7 = f7 && f7.sessions.find((s) => s.id === KILO_SID);
    ok('sessionRegistry 的会话行仍然带 doneAt（那一层正是它的消费者）', s7 && typeof s7.doneAt === 'number' && s7.doneAt > 0, s7 && String(s7.doneAt));
    const f8 = snap.floors.find((f) => f.id === '8F');
    const s8 = f8 && f8.sessions.find((s) => s.id === OC_SID);
    ok('8F 同样：会话行带 doneAt', s8 && typeof s8.doneAt === 'number' && s8.doneAt > 0, s8 && String(s8.doneAt));

    // 护栏本体：会话行**不该**带 at（那是 reporter 形状的字段名，混进来说明两套形状串了）
    ok('会话行里不该出现 reporter 形状的 at（两套形状不能互相污染）', s7 && !('at' in s7), s7 && Object.keys(s7).join(','));
  }

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail ? '✗' : '✓'} 完成标记形状契约：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.error('[done-shape] 挂了：', e && e.stack);
  process.exit(1);
});
