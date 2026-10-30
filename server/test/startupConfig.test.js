/**
 * Startup settings: host / port / TLS can come from ~/.workgremlin/config.json ("server" section).
 *
 * Pinned rules:
 *   · precedence per field: command line > environment > config.json > default;
 *   · invalid file values are ignored (never "allow by accident");
 *   · `--tls=false` disables a file that says true;
 *   · the dispatch section is unrelated and must not leak into server settings.
 *
 * Run: `npm run test:startup-config`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readFileSettings, resolveStartupSettings } = require('../src/startupConfig');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-startup-'));
const FILE = path.join(TMP, 'config.json');

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

function writeConfig(value) {
  fs.writeFileSync(FILE, JSON.stringify(value, null, 2));
}

function resolve(extra = {}) {
  return resolveStartupSettings({ file: FILE, env: {}, ...extra });
}

(async () => {
  head('默认值：没有配置文件');
  {
    fs.rmSync(FILE, { force: true });
    const s = resolve();
    ok('host 默认回环', s.host === '127.0.0.1', s.host);
    ok('port 默认不指定（让服务端自行探测）', s.port === undefined, String(s.port));
    ok('tls 默认关闭', s.tls === false, String(s.tls));
  }

  head('从 config.json 的 server 段读取');
  {
    writeConfig({
      server: { host: '0.0.0.0', port: 21800, tls: true },
      dispatch: { mode: 'auto' },
    });
    const file = readFileSettings(FILE);
    ok('host 读到了', file.host === '0.0.0.0', file.host);
    ok('port 读到了', file.port === 21800, String(file.port));
    ok('tls 读到了', file.tls === true, String(file.tls));
    const s = resolve();
    ok('解析结果使用文件', s.host === '0.0.0.0' && s.port === 21800 && s.tls === true);
    ok('dispatch 不会混进 server 设置', s.host === '0.0.0.0');
  }

  head('优先级：命令行 > 环境变量 > 文件');
  {
    const env = {
      WORKGREMLIN_HOST: '10.0.0.2',
      WORKGREMLIN_PORT: '23000',
      WORKGREMLIN_TLS: '1',
    };
    let s = resolve({ env });
    ok('环境变量覆盖文件 host', s.host === '10.0.0.2', s.host);
    ok('环境变量覆盖文件 port', s.port === 23000, String(s.port));
    ok('环境变量打开 TLS', s.tls === true, String(s.tls));

    s = resolve({
      env,
      args: { host: '127.0.0.1', port: '22000', tls: 'false' },
    });
    ok('命令行覆盖环境变量 host', s.host === '127.0.0.1', s.host);
    ok('命令行覆盖环境变量 port', s.port === 22000, String(s.port));
    ok('--tls=false 关闭 TLS', s.tls === false, String(s.tls));
  }

  head('非法值被忽略，不会误开');
  {
    writeConfig({ server: { host: '', port: 99999, tls: 'maybe' }, dispatch: { mode: 'off' } });
    const s = resolve();
    ok('空 host 被忽略', s.host === '127.0.0.1', s.host);
    ok('越界 port 被忽略', s.port === undefined, String(s.port));
    ok('非布尔 tls 被忽略', s.tls === false, String(s.tls));
  }

  head('损坏 / 非对象文件');
  {
    fs.writeFileSync(FILE, '{ not json');
    let s = resolve();
    ok('损坏 JSON 回落到默认值', s.host === '127.0.0.1' && s.port === undefined && !s.tls);
    writeConfig({ server: ['not', 'an', 'object'] });
    s = resolve();
    ok('server 不是对象时忽略', s.host === '127.0.0.1' && s.port === undefined && !s.tls);
  }

  head('数字字符串与布尔值');
  {
    writeConfig({ server: { port: '21900' } });
    ok('port 数字字符串可用', resolve().port === 21900);
    writeConfig({ server: { port: true } });
    ok('port=true 不被当成 1', resolve().port === undefined);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n异常终止：', err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
