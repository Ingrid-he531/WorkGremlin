'use strict';

/**
 * 10F installer self-test: the DSH reporter is a local Cordis plugin mounted by
 * the home-level `cordis.patch.yml`, not a JSON hooks file.
 *
 * Run: `npm run test:dsh` (this file is the installer half).
 *
 * Locks:
 *   - install copies the plugin into `$DSH_HOME/workgremlin/plugin.mjs`;
 *   - the patch row is absolute-path based and mounted by `insert`;
 *   - an empty `[]` patch is replaced (two YAML root nodes would be invalid);
 *   - a user's existing patch rows survive both install and uninstall;
 *   - uninstall removes only our marked block.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dsh-install-'));
const HOME = path.join(TMP, 'home');
const DSH_HOME = path.join(HOME, '.dsh');
fs.mkdirSync(DSH_HOME, { recursive: true });
process.env.HOME = HOME;
process.env.DSH_HOME = DSH_HOME;
process.env.WORKGREMLIN_NO_AUTO_HOOKS = '1';

const { installHooks, DSH_PLUGIN_SRC, mergeDshPatch } = require('../../scripts/install-hooks');

const PATCH = path.join(DSH_HOME, 'cordis.patch.yml');
const PLUGIN = path.join(DSH_HOME, 'workgremlin', 'plugin.mjs');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail !== undefined ? `  — ${detail}` : ''}`);
  }
}

console.log('\n[A] mergeDshPatch: empty / non-empty / marker replacement');
{
  const empty = mergeDshPatch('[]\n', PLUGIN, false);
  ok('an empty array is replaced, not followed by a second root node', !empty.includes('[]') && empty.includes('workgremlin-dsh-reporter'), empty);
  const commented = mergeDshPatch('# template comment\n[]\n', PLUGIN, false);
  ok('a commented template keeps its comment and drops the empty array', commented.startsWith('# template comment') && !/\n\[\]\n/.test(commented) && commented.includes('workgremlin-dsh-reporter'), commented);
  ok('the row uses an absolute plugin path', empty.includes(`name: '${PLUGIN}'`), empty);
  const withUser = mergeDshPatch("- id: user-row\n  name: '@scope/user-plugin'\n", PLUGIN, false);
  ok('a user patch row is preserved', withUser.includes('user-row') && withUser.includes('workgremlin-dsh-reporter'), withUser);
  const replaced = mergeDshPatch(`${withUser}\n`, '/new/checkout/plugin.mjs', false);
  ok('reinstall replaces the old absolute path instead of appending a second row', replaced.includes('/new/checkout/plugin.mjs') && !replaced.includes(`name: '${PLUGIN}'`));
  const removedOnly = mergeDshPatch(mergeDshPatch('[]\n', PLUGIN, false), PLUGIN, true);
  ok('uninstalling a block-only patch leaves a valid empty array', removedOnly.trim() === '[]', JSON.stringify(removedOnly));
}

console.log('\n[B] install: plugin file + patch row');
{
  fs.writeFileSync(PATCH, "- id: user-row\n  name: '@scope/user-plugin'\n", 'utf8');
  installHooks({ targets: 'dsh-plugin' });
  ok('the plugin file was copied', fs.existsSync(PLUGIN));
  ok('the copied file is the repo plugin source', fs.readFileSync(PLUGIN, 'utf8') === fs.readFileSync(DSH_PLUGIN_SRC, 'utf8'));
  const patch = fs.readFileSync(PATCH, 'utf8');
  ok('the patch has our managed block', patch.includes('# >>> workgremlin dsh reporter (managed) >>>'));
  ok('the patch mounts our local plugin by absolute path', patch.includes(`name: '${PLUGIN}'`));
  ok('the user row is untouched', patch.includes('user-row') && patch.includes('@scope/user-plugin'));
  ok('a backup of the pre-existing patch was made', fs.existsSync(`${PATCH}.bak-workgremlin`));
}

console.log('\n[C] reinstall is idempotent');
{
  const before = fs.readFileSync(PATCH, 'utf8');
  installHooks({ targets: 'dsh-plugin' });
  ok('the patch did not change', before === fs.readFileSync(PATCH, 'utf8'));
  ok('only one managed block exists', (fs.readFileSync(PATCH, 'utf8').match(/workgremlin dsh reporter \(managed\)/g) || []).length === 2);
}

console.log('\n[D] uninstall removes only our block');
{
  installHooks({ targets: 'dsh-plugin', uninstall: true });
  const patch = fs.readFileSync(PATCH, 'utf8');
  ok('our block is gone', !patch.includes('workgremlin dsh reporter'));
  ok('the user row is still there', patch.includes('user-row') && patch.includes('@scope/user-plugin'));
  ok('the plugin file was removed', !fs.existsSync(PLUGIN));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
