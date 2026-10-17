/**
 * FloorSelector hover tooltip — storage rows for SQLite-polling floors.
 *
 * Background: 6F Qoder's Plugin route reads the extension's own local.db, but its source spec carried no
 * `dirs` and the server's sourceDirs returns [] for kind 'lingma' (like kilo/opencode) — so the storage
 * row fell back to the "no data directory found" text even though the DB is right there. 7F Kilo / 8F
 * OpenCode already publish their data root; 6F now does too (see floorQoder's lingmaDataDir + dirs).
 *
 * The tooltip is not mounted in these node-only suites and the regression is invisible at the lib level
 * (it only shows on hover), so scan the SFC — same approach as taskTicker.test.mjs — to keep the server
 * half (a real dataPath) and the render half (display it) wired up.
 *
 * Run: `npm run test:floor-tooltip`
 */
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const src = fs.readFileSync(fileURLToPath(new URL('../src/components/FloorSelector.vue', import.meta.url)), 'utf8');

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

console.log('\n[1] A source with a data dir shows the dir, not "no data directory found"');
ok('sourceInfo only falls back to floor.no_data_dir when dataPathLabel is empty', /if\s*\(\s*!src\.dataPathLabel\s*\)/.test(src));
ok('the fallback is floor.no_data_dir', /floor\.no_data_dir/.test(src));
ok('otherwise the row detail is built from dataPathLabel', /detail:\s*`\$\{src\.dataPathLabel\}/.test(src));

console.log('\n[2] Storage rows carry only the directory + on-disk stats — never an explanatory note');
ok('sourceInfo no longer returns a note field', !/note:\s*src\.note/.test(src));
ok('pushSection no longer renders a note line', !/row\.note/.test(src));
ok('tip no longer has a per-kind polling-db predicate', !/isPollingDb/.test(src));
ok('tip passes no note into the storage rows', !/info\.note/.test(src));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
