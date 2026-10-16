/**
 * TaskTicker (scrolling screen) phase-suffix liveness guard.
 *
 * Background: the running line's phase suffix used to be baked into each scroll **segment** at creation
 * time (`makeSeg` copies `runningItems`). A segment is an immutable snapshot, and a screen-wide line
 * lasts ~20-30s at 70px/s, so the phase was sampled once per segment —— a brief tool phase was almost
 * never caught and the line read "thinking" nearly always. The fix resolves a running line's suffix
 * live from the session snapshot on every render (`lineSuffix`), while an ended line keeps the terminal
 * suffix baked when it entered the track.
 *
 * Why a source scan: TaskTicker.vue is not mounted in these node-only suites, and the regression is
 * invisible at the lib level —— it only shows on screen. Scan the SFC so a future edit cannot silently
 * re-bake the running suffix into the segment.
 *
 * Run: `npm run test:ticker`
 */
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const root = fileURLToPath(new URL('../src', import.meta.url));
const tickerPath = path.join(root, 'components', 'TaskTicker.vue');
const src = fs.readFileSync(tickerPath, 'utf8');

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

console.log('\n[1] Running lines are resolved live at render time');
ok('running lines are marked live', /\blive:\s*true/.test(src));
ok('running lines carry sessionId (so the live lookup can find the session)', /\bsessionId:\s*it\.sessionId/.test(src));
ok('a lineSuffix helper exists', /const\s+lineSuffix\s*=/.test(src));
ok('a lineSuffixColor helper exists', /const\s+lineSuffixColor\s*=/.test(src));

console.log('\n[2] Only running lines go live; ended lines keep their baked terminal suffix');
ok('lineSuffix branches on it.live', /it\.live\s*\?/.test(src));
ok('ended lines are NOT marked live (exactly one live:true —— the running branch)', (src.match(/\blive:\s*true/g) || []).length === 1);

console.log('\n[3] The template renders the suffix through the live helper, never the baked field');
const template = src.slice(src.indexOf('<template>'));
ok('suffix span uses v-if="lineSuffix(it)"', /v-if="lineSuffix\(it\)"/.test(template));
ok('suffix span uses lineSuffix(it) as text', /class="suf"[^>]*>\{\{\s*lineSuffix\(it\)\s*\}\}/.test(template));
ok('suffix colour uses lineSuffixColor(it)', /:style="\{\s*color:\s*lineSuffixColor\(it\)\s*\}"/.test(template));
ok('the template no longer reads the baked it.suffix / it.suffixColor', !/\{\{\s*it\.suffix\s*\}\}/.test(template) && !/color:\s*it\.suffixColor/.test(template));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
