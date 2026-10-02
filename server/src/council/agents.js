'use strict';

/**
 * 四层 agent 的**命令行配方** —— 议事厅里唯一碰各 CLI 细节的地方。
 *
 * 每个配方记三件事：怎么把提示词递进去、**怎么保证它没有工具**、怎么把它吐出来的东西读成
 * 「发言 + 票」。前两件是本文件的重点，下面每层都写了它是怎么验过的（2026-10-01 本机实测）。
 *
 * 关于"只读、不给工具"（用户定的口径，也是能进议事厅的前提）：
 *   · 1F CodeBuddy / 4F Claude Code —— `--tools ""` 关掉全部内置工具（两家 help 里都写着
 *     `Use "" to disable all tools`）。
 *   · 7F Kilo / 8F OpenCode —— 这两家没有关工具的开关（`kilo --pure` 只关**外部插件**，
 *     跟工具无关；别被名字骗了）。它们靠**注入一份权限全 deny 的配置**：
 *       - kilo 用 `KILO_CONFIG_CONTENT`，实测 `kilo debug config` 里 permission 变成 deny；
 *       - opencode 用 `OPENCODE_CONFIG_CONTENT`，实测做过对照：不锁时它能读出临时目录里的
 *         标记文件，锁上后工具调用直接被拒、标记文件读不出来。
 *   · 8F 顺带把 HOME 之外的目录也挡在 `external_directory` 里（缺省就是 ask，不是 allow，
 *     叠加 deny 之后更不出去）。
 *
 * 还有一条**必须做**的事：7F 要 `"plugin": []` 把插件摘掉。kilo 的全局配置里装着
 * WorkGremlin 自己的上报插件（`packages/reporter/src/plugin/index.js`），不摘的话议事厅的
 * 参与者会被上报进办公室 —— 直接违反"隔离，只在议事厅看"。`--pure` **摘不掉**它（实测），
 * 只有配置里的 `plugin: []` 管用。
 *
 * 另一条贯穿全文件的规矩：**解析不出来就说解析不出来**。模型换个格式、CLI 改了输出，
 * 都要落到 status='unparsed' 并把原文留着，绝不能猜一个"大概是同意吧"。
 */

const { DEFAULTS } = require('@workgremlin/shared');

/**
 * 关掉 WorkGremlin **自己**的上报 —— 每条配方都注入，两种模式都注入。
 *
 * 为什么是必须的：隔离模式靠 cwd 在 /tmp 就够（参与者上报的工程路径是那个临时目录，
 * 办公室根本看不见）。**工程模式下 cwd 是用户的真实工程**，`~/.claude/settings.json` /
 * `~/.codebuddy/settings.json` 里装着的上报 hook 会带着真实工程路径上报 —— 参与者当场
 * 变成"你工程里的一个成员"，直接违反"只在议事厅看得见"。所以这里不再依赖 cwd，
 * 改成显式关掉上报：hook（packages/reporter/src/hook.js）与插件
 * （packages/reporter/src/plugin/index.js）都认这一条，认到就原地退出。
 */
const QUIET_ENV = Object.freeze({ WORKGREMLIN_DISABLE: '1' });

/**
 * 7F / 8F 参与者会话的固定标题 —— 这两家没有 1F/4F 那种"不落盘"开关，
 * 会话一定会记进它们的**全局** SQLite（`session.directory` = 当时的 cwd）。
 * 隔离模式下 cwd 在 /tmp，办公室按工程过滤看不见；工程模式下 cwd 就是用户的工程，
 * 不挡的话参与者会直接出现在办公室的 7F/8F 上。挡法是"打一个固定标题"，
 * 由 server/src/kilo.js 与 server/src/opencode.js 列出会话时跳过它 —— 理由与代价
 * 都写在 shared/index.js 的 COUNCIL_SESSION_TITLE 那一段。
 */
const SESSION_TITLE = DEFAULTS.COUNCIL_SESSION_TITLE;

/** 7F / 8F 的权限表要逐项写全（`*` 是兜底，列出来的是明写一遍好读、也方便断言） */
const PERMISSION_KEYS = Object.freeze([
  'bash', 'edit', 'write', 'read', 'glob', 'grep', 'list',
  'webfetch', 'websearch', 'task', 'skill', 'todowrite', 'external_directory',
]);

/** 7F / 8F 共用的权限封锁：把工具按类别全 deny —— 隔离模式用这份 */
const DENY_ALL_PERMISSION = Object.freeze(
  Object.fromEntries([['*', 'deny'], ...PERMISSION_KEYS.map((k) => [k, 'deny'])])
);

/**
 * 工程模式（allow='read'）给 7F / 8F 的权限表：**只**放行读类工具，其余照旧全 deny。
 *
 * 7F Kilo / 8F OpenCode 没有 1F/4F 那种 `--tools` 开关（`kilo --pure` 只关外部插件，
 * 跟工具无关），所以"只读"只能靠喂这份配置。两处**必须**保持 deny：
 *   · `bash` / `write` / `edit` —— 参与者不许改用户的代码，也不许在用户机器上跑命令；
 *   · `external_directory` —— 工程模式只许看工程里。缺省它是 ask，而议事厅的参与者
 *     没人应答权限询问，ask 会变成"卡住到超时"；明写 deny 才是确定的行为。
 */
const READ_PERMISSION = Object.freeze(
  Object.fromEntries([
    ['*', 'deny'],
    ...PERMISSION_KEYS.map((k) => [k, ['read', 'glob', 'grep', 'list'].includes(k) ? 'allow' : 'deny']),
  ])
);

/** @param {string} allow 'none'（缺省，隔离模式的"没有工具"）或 'read'（工程模式的只读工具） */
function permissionFor(allow) {
  return allow === 'read' ? READ_PERMISSION : DENY_ALL_PERMISSION;
}

/**
 * 1F / 4F 的只读工具白名单。给 `--tools` 与 `--allowedTools` **同一份**：
 *   · `--tools`        —— 限制它**能用**哪些内置工具（其余根本不出现）；
 *   · `--allowedTools` —— 允许这些工具**不用问**就直接用。
 * `-p` 是非交互的，没人应答权限询问，只给前一个的话读文件会被拒（每一步都要问），
 * 于是参与者只能干瞪眼 —— 那不是只读，那是读不了。
 */
const READ_TOOLS = 'Read,Grep,Glob';

/**
 * 每层一个配方。
 *
 * build({ bin, prompt, allow }) → { bin, args, env, stdin }
 *   · `allow` = 'none'（缺省）| 'read' —— 见上面 READ_TOOLS / READ_PERMISSION。
 *     **两种取值都必须把工具的出口堵死或窄成只读**，没有"给一半"的中间态。
 *   · env 是**叠加**在 process.env 之上的（不是替换）—— 各 CLI 的登录凭据在 ~/.claude、
 *     ~/.config/kilo 这些目录里，靠 HOME 找。挡掉 HOME 等于挡掉登录，所以隔离靠
 *     cwd + 工具收敛 + QUIET_ENV，不靠改环境变量。
 *   · stdin 非 null 时提示词走管道（不进 argv）：长文本不会撞 ARG_MAX，也不会出现在
 *     `ps` 的命令行里被同机其他进程看到。
 *
 * 1F / 4F 都带 `--no-session-persistence`（两家 help 里都有，均限 `--print` 下有效）：
 * 参与者的对话**不落盘**。工程模式下这条是隔离的必需品 —— 落了盘，各 CLI 会把参与者
 * 按**用户真实工程路径**记进它自己的历史（`~/.claude/projects/<工程>/`），
 * 全局会话列表里就会多出几个"你工程里的活跃会话"。隔离模式同样受益：不再留
 * `tmp-wg-council-*` 那种一次性工程的残骸。
 *
 * `--strict-mcp-config` 且不给 `--mcp-config`：不加载用户配置里的 MCP server。
 * `--tools ""` 管的是**内置**工具集，MCP 工具不在其中 —— 不挡的话"没有工具的参与者"
 * 这句话就不成立（顺带说明：这一条是对既有行为的收紧，不是本次新开的口子）。
 */
const RECIPES = {
  '1F': {
    agent: 'codebuddy',
    name: 'CodeBuddy',
    // 实测：`-p` 不带消息即读管道（help 原文 "useful for pipes"）
    build({ bin, prompt, allow }) {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
      if (allow === 'read') args.push('--tools', READ_TOOLS, '--allowedTools', READ_TOOLS);
      else args.push('--tools', '');
      return { bin, args, env: { ...QUIET_ENV }, stdin: prompt };
    },
  },

  '4F': {
    agent: 'claude',
    name: 'Claude Code',
    build({ bin, prompt, allow }) {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
      if (allow === 'read') {
        // `--permission-prompts none` = 没人应答就拒（不是"挂在那儿等"）。排在
        // `--allowedTools` **前面**：那个开关收的是变长参数，放后面会被它吃掉。
        args.push('--permission-prompts', 'none', '--tools', READ_TOOLS, '--allowedTools', READ_TOOLS);
      } else {
        args.push('--tools', '');
      }
      return { bin, args, env: { ...QUIET_ENV }, stdin: prompt };
    },
  },

  '7F': {
    agent: 'kilo',
    name: 'Kilo Code',
    // 提示词走位置参数（kilo run <message>）：这两家不读 stdin。
    // 我们的提示词永远以自己那段模板开头，不会以 '-' 打头，所以不必再塞 '--' 分隔符
    // （塞了反而可能被 yargs 当成分隔符吃掉，得不偿失）。
    build({ bin, prompt, allow }) {
      return {
        bin,
        args: ['run', prompt, '--format', 'json', '--title', SESSION_TITLE],
        env: {
          KILO_CONFIG_CONTENT: JSON.stringify({
            plugin: [], // 摘掉 WorkGremlin 自己的上报插件（否则参与者会被上报进办公室）
            permission: permissionFor(allow),
          }),
          ...QUIET_ENV,
        },
        stdin: null,
      };
    },
  },

  '8F': {
    agent: 'opencode',
    name: 'OpenCode',
    build({ bin, prompt, allow }) {
      return {
        bin,
        args: ['run', prompt, '--format', 'json', '--title', SESSION_TITLE],
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: permissionFor(allow) }),
          ...QUIET_ENV,
        },
        stdin: null,
      };
    },
  },
};

/* ---------------------------------- 输出解析 ---------------------------------- */

/** 从各种可能的字段里抠出正文。CLI 各写各的，这里只认见过的形状，认不出返回 '' */
function textOf(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) {
    return obj.map(textOf).filter(Boolean).join('\n');
  }
  if (typeof obj !== 'object') return '';
  // 按"最可能是正文"的顺序试。`result` 是 claude/codebuddy 的收尾文本；
  // `text` / `content` 是 kilo/opencode 事件流里的分片。
  //
  // `part` 是 **opencode 实测的形态**（2026-10-01 真机烟测）：
  //   {"type":"text","sessionID":"...","part":{"type":"text","text":"正文…"}}
  // 正文不在顶层，在 part 里。它**单数**，和 `parts`（复数）不是一回事 ——
  // 当初只照猜的形状写了 `parts`，结果真跑起来 8F 每一轮都判成"解析不出内容"，
  // 而单测是照着同一个猜测写的，全绿。教训：照着猜的线格式写单测，等于没测。
  for (const key of ['result', 'text', 'content', 'message', 'parts', 'part', 'output']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') {
      const nested = textOf(v);
      if (nested) return nested;
    }
  }
  return '';
}

/** usage 各家字段名不一，尽量归一；取不到的一律 null（**不写 0**，见铁律） */
function tokensOf(obj) {
  const usage = (obj && (obj.usage || (obj.message && obj.message.usage) || obj.tokens)) || null;
  if (!usage || typeof usage !== 'object') return null;
  const num = (...keys) => {
    for (const k of keys) {
      const v = usage[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  const out = {
    input: num('input_tokens', 'prompt_tokens', 'input'),
    output: num('output_tokens', 'completion_tokens', 'output'),
    cacheRead: num('cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens'),
    cacheWrite: num('cache_creation_input_tokens', 'cache_write_tokens'),
  };
  // 四项全取不到 = 这家没给 usage，返回 null 而不是一个全 0 的对象
  return Object.values(out).some((v) => v != null) ? out : null;
}

/** 这条事件是不是"用户那一侧"的回显（提问原文 / 系统提示）。正文绝不能把它捎上 */
function isUserEcho(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.role === 'user') return true;
  const inner = e.part || e.message;
  return Boolean(inner && typeof inner === 'object' && inner.role === 'user');
}

/**
 * 从一份**完整对话记录**里挑出"它说的那一段"。
 *
 * 1F CodeBuddy `--output-format json` 实测给的就是这个（2026-10-01）：一个数组，
 * `user 消息 → file-history-snapshot → reasoning → assistant 消息 → result`，
 * 一路记全。按老办法把每条 content 拼起来，**提问原文（连 CLI 自己塞的 memory 系统提示）
 * 会被当成它的发言**，末尾还会把答复再重复一遍 —— 界面上就是每张发言卡前半截是自己的提示词。
 * 实测那次 16KB 的正文里，真正它说的话只在最后 1KB。
 *
 * 所以这里只认两样，按可信度排：
 *   1. 收尾事件里的 `result` 字段（CodeBuddy / Claude Code 都给，且**只有它**是最终答复）；
 *   2. 退一步，最后一条 assistant 消息的输出。
 * 两样都找不到 → null：宁可说"解析不出"，也不把提示词端上来说成它的话。
 *
 * @param {Array} list
 * @returns {{text:string, tokens:object|null}|null}
 */
function pickFromTranscript(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.result === 'string' && e.result.trim()) {
      return { text: e.result, tokens: tokensOf(e) };
    }
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (e && typeof e === 'object' && e.role === 'assistant') {
      const t = textOf(e);
      if (t) return { text: t, tokens: tokensOf(e) };
    }
  }
  return null;
}

/**
 * 解析一次调用的 stdout。
 *
 * 两种形态都要吃：
 *   · **单个 JSON**（1F/4F 的 `--output-format json`）—— 整个 stdout 就是一个对象；
 *   · **JSONL 事件流**（7F/8F 的 `--format json`）—— 一行一个事件，正文在若干行里拼起来。
 *
 * 做法：先当整块 JSON 试，不行再逐行试。**两种都失败 = 解析不出来**，此时文本留空、
 * 把原始 stdout 原样带回（排障要看它），绝不假装读到了内容。
 *
 * @param {string} stdout
 * @returns {{ok:boolean, text:string, tokens:object|null, events:number}}
 */
function parseOutput(stdout) {
  const raw = String(stdout == null ? '' : stdout);
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, text: '', tokens: null, events: 0 };

  // 先当整块 JSON
  try {
    const one = JSON.parse(trimmed);
    if (Array.isArray(one)) {
      // 一整个数组 = 一份完整对话记录，只挑它说的那段（见 pickFromTranscript）
      const got = pickFromTranscript(one);
      if (got) return { ok: true, text: got.text, tokens: got.tokens, events: one.length };
      return { ok: false, text: '', tokens: null, events: one.length };
    }
    const text = textOf(one);
    if (text) return { ok: true, text, tokens: tokensOf(one), events: 1 };
  } catch {
    /* 不是单个 JSON，往下走 JSONL */
  }

  // 再当 JSONL：逐行解析，正文按出现顺序拼，usage 取**最后**一个非空的
  // （事件流里 usage 常挂在收尾那条上，累加会在重试时重复计费）
  let events = 0;
  const parts = [];
  let tokens = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // 单行坏了不代表整条流坏了（CLI 会往 stdout 混日志）
    }
    events += 1;
    // 流里混着用户消息（提示词回显）的形态：跳过它，别把提问当成它的发言
    if (isUserEcho(obj)) continue;
    const t = textOf(obj);
    if (t) parts.push(t);
    const tk = tokensOf(obj);
    if (tk) tokens = tk;
  }
  if (events > 0 && parts.length) return { ok: true, text: parts.join('\n'), tokens, events };
  // 有事件但一句正文都没读到 —— 也算解析不出来（可能全是状态事件，或字段名又变了）
  return { ok: false, text: '', tokens: tokens || null, events };
}

/* ---------------------------------- 投票解析 ---------------------------------- */

/**
 * 参与者必须在发言末尾附一段结构化投票。约定的形状（提示词里会写死）：
 *
 * ```json
 * {"vote":"agree|disagree|abstain","reason":"一句话","proposal":"（投反对时给修订案）","second":"4F"}
 * ```
 *
 * 解析策略（宽进严出）：
 *   1. 找**最后一个** ```json 围栏块（模型爱在中间举例，最后一块才是它的结论）；
 *   2. 没有围栏就在全文里找最后一个含 `"vote"` 的 {...} 片段；
 *   3. 再不行认 `VOTE: agree` 这样的一行；
 *   4. 全都认不出 → 返回 vote=null（**未表态**），绝不按语气猜。
 *
 * @param {string} text
 * @returns {{vote:string|null, reason:string|null, proposal:string|null, second:string|null}}
 */
function parseVoteBlock(text) {
  const empty = { vote: null, reason: null, proposal: null, second: null };
  const s = String(text == null ? '' : text);
  if (!s.trim()) return empty;

  const obj = lastJsonBlock(s, (o) => 'vote' in o);
  if (obj) {
    const vote = normalizeVoteToken(obj.vote);
    if (vote) {
      return {
        vote,
        reason: strOrNull(obj.reason),
        // 修订案照收（提示词只要求投反对的人给，但投了同意却附一版也一并留着 ——
        // 选下一轮提案时按 consensus.js 的规则走，这里不做取舍）
        proposal: strOrNull(obj.proposal),
        second: strOrNull(obj.second || obj.second_floor || obj.endorse),
      };
    }
  }

  // 兜底：`VOTE: agree` / `立场：反对` 这样的一行
  const line = s.match(/(?:^|\n)\s*(?:VOTE|立场|投票)\s*[:：]\s*([^\n]{1,40})/i);
  if (line) {
    const vote = normalizeVoteToken(line[1]);
    if (vote) return { vote, reason: null, proposal: null, second: null };
  }
  return empty;
}

/** 票型词表跟 council/consensus.js 保持一套（那里是权威，这里只做同样的归一） */
function normalizeVoteToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(abstain|neutral|none|弃权|中立|不表态|无所谓)$/.test(s)) return 'abstain';
  if (/^(agree|yes|approve|accept|同意|赞成|支持|通过)$/.test(s)) return 'agree';
  if (/^(disagree|no|reject|oppose|反对|不同意|否决)$/.test(s)) return 'disagree';
  return null;
}

function strOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/* ---------------------------------- 分析解析 ---------------------------------- */

/**
 * 分析模式的结构化尾块。约定的形状（提示词里写死，见 prompt.js 的 ANALYSIS_PROTOCOL）：
 *
 * ```json
 * {"stance":"support|oppose|unsure","points":[…],"risks":[…],"questions":[…]}
 * ```
 *
 * 两条与表决解析同一套的规矩：
 *   · 认不出就留 null —— `stance` 读了半天读不出就是"未表态"，never 按语气猜；
 *   · `findings` 的 null 与空对象**不是一回事**：null = 整个尾块没解析出来，
 *     `{points:[],risks:[],questions:[]}` = 它答了，只是三条都空。界面上这两种写法不同。
 *
 * @param {string} text
 * @returns {{stance:string|null, findings:{points:string[],risks:string[],questions:string[]}|null}}
 */
function parseAnalysisBlock(text) {
  const empty = { stance: null, findings: null };
  const s = String(text == null ? '' : text);
  if (!s.trim()) return empty;
  const obj = lastJsonBlock(
    s,
    (o) => 'stance' in o || 'points' in o || 'risks' in o || 'questions' in o
  );
  if (!obj) return empty;
  return { stance: normalizeStanceToken(obj.stance), findings: findingsOf(obj) };
}

/** 立场词表。归一规则与 normalizeVoteToken 一个路子：认识的归一，不认识的返 null */
function normalizeStanceToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(support|yes|pro|for|agree|赞成|支持|可行|同意)$/.test(s)) return 'support';
  if (/^(oppose|no|against|con|disagree|反对|不可行|不同意)$/.test(s)) return 'oppose';
  if (/^(unsure|unknown|maybe|unclear|不确定|存疑|拿不准|说不准|待定)$/.test(s)) return 'unsure';
  return null;
}

/**
 * 三个列表字段。**一个都没给**（或给的不是数组）→ null（= 没解析出来）；
 * 只要有一个是数组，就返回三个键都齐的对象（缺的那些是空数组）。
 * 元素只收非空字符串 —— 模型偶尔塞个 `{"point":"…"}` 进来，那不是我们要的形状，丢掉。
 */
function findingsOf(obj) {
  const listOf = (v) =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
  if (!['points', 'risks', 'questions'].some((k) => Array.isArray(obj[k]))) return null;
  return { points: listOf(obj.points), risks: listOf(obj.risks), questions: listOf(obj.questions) };
}

/**
 * 从一段文本里找**最后一个**满足判据的 JSON 对象。
 * 先试 ```json 围栏（从后往前），再退化成全文扫括号配对。
 * 表决块与分析块共用这一套（判据不同：一个认 `vote`，一个认 `stance`/`points`）。
 *
 * @param {string} s
 * @param {(obj:object)=>boolean} ok
 */
function lastJsonBlock(s, ok) {
  const fenced = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const obj = tryParseJsonObject(fenced[i], ok);
    if (obj) return obj;
  }
  // 没有围栏：从每个 '{' 起做括号配对，取最后一个满足判据的
  for (let i = s.lastIndexOf('{'); i >= 0; i = s.lastIndexOf('{', i - 1)) {
    const obj = tryParseJsonObject(extractBalanced(s, i), ok);
    if (obj) return obj;
    if (i === 0) break;
  }
  return null;
}

function tryParseJsonObject(chunk, ok) {
  if (!chunk) return null;
  try {
    const obj = JSON.parse(chunk.trim());
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && ok(obj)) return obj;
  } catch {
    /* 解析不了就换下一个候选 */
  }
  return null;
}

/** 从 s[from]=='{' 起取一个括号配平的片段（会跳过字符串里的括号） */
function extractBalanced(s, from) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  return '';
}

module.exports = {
  RECIPES,
  DENY_ALL_PERMISSION,
  READ_PERMISSION,
  READ_TOOLS,
  QUIET_ENV,
  parseOutput,
  parseVoteBlock,
  normalizeVoteToken,
  parseAnalysisBlock,
  normalizeStanceToken,
};
