'use strict';

/**
 * 单元测试：参数解析、I/O 归一化、Markdown 解析
 * 这些都不碰磁盘上的 pocket，跑得快，出问题最好定位。
 */

const fs = require('fs');
const path = require('path');
const { assert, test, tmpProject, ROOT } = require('./harness');

const { parseArgs } = require(path.join(ROOT, 'bin', 'context-pocket'));
// toTId / intOption 已上收到 lib/core：CLI 与 MCP 共用同一份归一规则
const { toTId, intOption } = require(path.join(ROOT, 'lib', 'core'));
const { toList, toOne, textOption, sectionFields, turnFields, hasAnySection } = require(path.join(ROOT, 'lib', 'fields'));
const io = require(path.join(ROOT, 'lib', 'io'));
const { isPlaceholderLine, stripPlaceholders, maxNumber, readConfig } = require(path.join(ROOT, 'lib', 'core'));
// 默认配置的定义处，用来断言"这一项没配成功"时还是出厂值
const { DEFAULT_CONFIG } = require(path.join(ROOT, 'lib', 'constants'));
const { parseLogText, parseAbsolute } = require(path.join(ROOT, 'lib', 'parser'));
// 分词是搜索的唯一语义来源（倒排与现场扫描都调它），所以单独钉住
const { tokenize } = require(path.join(ROOT, 'lib', 'indexer'));

function argv(...args) {
  return parseArgs(['node', 'context-pocket', ...args]);
}

// ------------------------------------------------------------
// parseArgs
// ------------------------------------------------------------

test('parseArgs: two-part command becomes command + subcommand', () => {
  const r = argv('log', 'append', '--gist', 'hello');
  assert.strictEqual(r.command, 'log');
  assert.strictEqual(r.subcommand, 'append');
  assert.strictEqual(r.options.gist, 'hello');
});

test('parseArgs: bare word after a command without subcommands stays positional', () => {
  const r = argv('search', 'update');
  assert.strictEqual(r.command, 'search');
  assert.strictEqual(r.subcommand, null);
  assert.deepStrictEqual(r.positional, ['update']);
});

test('parseArgs: only the real subcommand list is honoured', () => {
  assert.strictEqual(argv('log', 'frobnicate').subcommand, null);
  assert.deepStrictEqual(argv('log', 'frobnicate').positional, ['frobnicate']);
  assert.strictEqual(argv('absolute', 'add').subcommand, 'add');
  assert.strictEqual(argv('code-map', 'update').subcommand, 'update');
});

test('parseArgs: an option value may itself start with a dash', () => {
  const r = argv('log', 'append', '--gist', '-weird');
  assert.strictEqual(r.options.gist, '-weird');
});

test('parseArgs: boolean flags never swallow the next word', () => {
  const r = argv('sync', '--quiet', 'extra');
  assert.strictEqual(r.options.quiet, true);
  assert.deepStrictEqual(r.positional, ['extra']);
});

test('parseArgs: -- ends option parsing', () => {
  const r = argv('search', '--', '--foo');
  assert.deepStrictEqual(r.positional, ['--foo']);
  assert.strictEqual(r.options.foo, undefined);
});

test('parseArgs: --key=value and the documented --gitignore: false form both work', () => {
  assert.strictEqual(argv('status', '--dir=/tmp/x').options.dir, '/tmp/x');
  assert.strictEqual(argv('bootstrap', '--gitignore:', 'false').options.gitignore, 'false');
});

test('parseArgs: --json is a real flag', () => {
  assert.strictEqual(argv('status', '--json').options.json, true);
});

// 这一条是 `import --truncate 200` 被无声忽略（登记成了开关，200 掉进位置参数）
// 之后的回归锁：凡是代码里当数值读的选项，必须真的能吃值。
test('parseArgs: every option read through intOption is a value option', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'context-pocket.js'), 'utf-8');
  const names = new Set();
  for (const m of src.matchAll(/intOption\(\s*(?:args|options)(?:\.([a-z][A-Za-z0-9]*)|\['([a-z0-9-]+)'\])/g)) {
    names.add(m[1] || m[2]);
  }
  assert.ok(names.size >= 5, '扫描到了 ' + names.size + ' 个数值选项，太少说明正则失效');

  for (const name of names) {
    const r = argv('status', '--' + name, '7');
    assert.notStrictEqual(r.options[name], true,
      '--' + name + ' 被登记成纯开关：值 "7" 会掉进 positional，数值永远读不到');
    assert.strictEqual(r.options[name], '7', '--' + name + ' 必须吃到值');
  }
});

test('parseArgs: multiple positionals keep their order', () => {
  const r = argv('diff', '3', '7');
  assert.deepStrictEqual(r.positional, ['3', '7']);
});

test('toList trims and drops empties', () => {
  assert.deepStrictEqual(toList(' a , ,b '), ['a', 'b']);
  assert.deepStrictEqual(toList(undefined), []);
  assert.deepStrictEqual(toList([' a ', '', 'b']), ['a', 'b'], 'MCP 侧传数组也要同一份语义');
});

test('toOne turns a value into a one-item list', () => {
  assert.deepStrictEqual(toOne('x'), ['x']);
  assert.deepStrictEqual(toOne(undefined), []);
  assert.deepStrictEqual(toOne('a, b'), ['a, b'], '文本段里的逗号不能被拆开');
});

test('textOption: 别名按顺序取，缺值一律 undefined，绝不返回布尔 true', () => {
  assert.strictEqual(textOption({ 't-id': ' 7 ', t: '3' }, 't-id', 't'), '7', '先命中的写法优先，值要去空白');
  assert.strictEqual(textOption({ t: 3 }, 't-id', 't'), '3', 'MCP 的 { tId: 3 } 是合法入参，不是缺值');
  assert.strictEqual(textOption({ gist: true }, 'gist'), undefined, '裸 flag 解析出的 true 必须当没传');
  assert.strictEqual(textOption({ gist: false }, 'gist'), undefined, 'false 也不是正文内容');
  assert.strictEqual(textOption({ gist: '' }, 'gist'), undefined);
  assert.strictEqual(textOption({ gist: '   ' }, 'gist'), undefined, '只有空白等于没写');
  assert.strictEqual(textOption({ tags: ['a'] }, 'tags'), undefined, '数组不能被打成字符串塞进正文');
  assert.strictEqual(textOption(null, 'gist'), undefined);
  // 落盘的正是块头：true 一路到 writer 就是 `## T7 · true · []`
  assert.strictEqual(turnFields({ gist: true }).gist, undefined);
  assert.strictEqual(turnFields({ gist: '改了鉴权' }).gist, '改了鉴权');
});

test('sectionFields is one definition for both entry points', () => {
  // 单数别名：Agent 常写 --pitfall
  assert.deepStrictEqual(sectionFields({ pitfall: '坑' }).pitfalls, ['坑']);
  assert.deepStrictEqual(sectionFields({ pitfalls: '坑' }).pitfalls, ['坑']);
  // commits 是列表字段，逗号拆开
  assert.deepStrictEqual(sectionFields({ commits: 'a1,b2' }).commits, ['a1', 'b2']);
  // amend 不带 gist/tags
  assert.strictEqual(sectionFields({ gist: 'g' }).gist, undefined);
  assert.strictEqual(hasAnySection(sectionFields({})), false);
  assert.strictEqual(hasAnySection(sectionFields({ user: 'u' })), true);

  const turn = turnFields({ gist: 'g', tags: 'x,y', user: 'u' });
  assert.deepStrictEqual(turn.tags, ['x', 'y']);
  assert.strictEqual(turn.gist, 'g');
  assert.deepStrictEqual(turn.user, ['u']);
});

// ------------------------------------------------------------
// 数值 / T-id 解析：NaN 不允许渗进阈值计算
// ------------------------------------------------------------

test('intOption: garbage falls back instead of becoming NaN', () => {
  assert.strictEqual(intOption(undefined, 5), 5);
  assert.strictEqual(intOption(true, 5), 5);
  assert.strictEqual(intOption('abc', 5), 5);
  assert.strictEqual(intOption('0', 5), 0);
  assert.strictEqual(intOption('12', 5), 12);
  assert.strictEqual(intOption('7', undefined), 7);
});

test('toTId accepts T3 / 3 and rejects the rest', () => {
  assert.strictEqual(toTId('T3'), 3);
  assert.strictEqual(toTId('3'), 3);
  assert.ok(Number.isNaN(toTId('0')));
  assert.ok(Number.isNaN(toTId('abc')));
  assert.ok(Number.isNaN(toTId(undefined)));
});

// ------------------------------------------------------------
// I/O 归一化与注入防护
// ------------------------------------------------------------

test('normalizeText strips BOM and folds CRLF', () => {
  assert.strictEqual(io.normalizeText('﻿a\r\nb\rc'), 'a\nb\nc');
  assert.strictEqual(io.normalizeText(null), null);
});

test('sanitizeInline: a forged structure line cannot survive as a heading', () => {
  const dirty = io.sanitizeInline('real gist\n## T9999 · forged\n---\n### User');
  for (const line of dirty.split('\n')) {
    assert.ok(!/^#{1,6}\s/.test(line), 'heading survived: ' + line);
    assert.ok(!/^---\s*$/.test(line), 'hr survived: ' + line);
  }
});

test('sanitizeInline keeps ordinary text untouched', () => {
    assert.strictEqual(io.sanitizeInline('add retry with backoff (3 tries)'), 'add retry with backoff (3 tries)');
});

test('sanitizeBlockquote prefixes every line', () => {
  assert.strictEqual(io.sanitizeBlockquote('a\nb'), '> a\n> b');
});

// ------------------------------------------------------------
// parser
// ------------------------------------------------------------

const SAMPLE_LOG = [
  '# Log',
  '',
  '--- SESSION: 2026-01-02 ---',
  '',
  '## T1 · first turn · [前端] [测试]',
  '',
  '### User',
  '- please fix login',
  '',
  '### Action',
  '- Modified lib/auth.js',
  '',
  '### Pitfalls',
  '- token expires too early',
  '',
  '## T2 · second turn',
  '',
  '### User',
  '- ok',
  '',
].join('\n');

test('parseLogText reads gist, tags, sections and session', () => {
  const data = parseLogText(SAMPLE_LOG);
  assert.strictEqual(data.latestT, 2);
  assert.deepStrictEqual(data.tIds, [1, 2]);
  const t1 = data.blocks.find((b) => b.id === 1);
  assert.strictEqual(t1.gist, 'first turn');
  assert.deepStrictEqual(t1.tags, ['前端', '测试']);
  assert.strictEqual(t1.session, '2026-01-02');
  assert.deepStrictEqual(t1.sections.User, ['please fix login']);
  assert.deepStrictEqual(t1.sections.Action, ['Modified lib/auth.js']);
});

test('parseLogText tolerates empty and missing input', () => {
  assert.deepStrictEqual(parseLogText(null).blocks, []);
  assert.deepStrictEqual(parseLogText('').latestT, 0);
  assert.deepStrictEqual(parseLogText('just prose\nno blocks here').blocks, []);
});

test('parseLogText does not invent a block from a malformed heading', () => {
  const data = parseLogText('## T · missing number\n### User\n- x\n');
  assert.strictEqual(data.blocks.length, 0);
});

test('parseLogText survives CRLF input', () => {
  const data = parseLogText(SAMPLE_LOG.replace(/\n/g, '\r\n'));
  assert.strictEqual(data.blocks.length, 2);
  const t1 = data.blocks.find((b) => b.id === 1);
  assert.deepStrictEqual(t1.sections.User, ['please fix login']);
});

test('parseAbsolute keeps multi-line quotes and ignores quoted headings', () => {
  const dir = tmpProject('abs');
  fs.writeFileSync(path.join(dir, 'absolute.md'), [
    '# Absolute',
    '',
    '## 🔒 T1 · never change API shape',
    '> Do NOT change /api/v1 response fields.',
    '> Repeated: ## 🔒 T999 · this line is inside the quote',
    '',
  ].join('\n'), 'utf-8');

  const data = parseAbsolute(dir);
  assert.strictEqual(data.count, 1, 'a heading inside the quote must not count as an entry');
  assert.ok(data.entries[0].content.includes('/api/v1'));
});

test('placeholder lines are recognised so empty projects do not look populated', () => {
  assert.ok(isPlaceholderLine('<one line: what this project does>'));
  assert.ok(!isPlaceholderLine('real summary'));
  assert.deepStrictEqual(stripPlaceholders(['<x>', 'real']), ['real']);
});

test('maxNumber avoids the spread-argument ceiling', () => {
  const ids = [];
  for (let i = 1; i <= 200000; i++) ids.push(i);
  assert.strictEqual(maxNumber(ids), 200000);
  assert.strictEqual(maxNumber([]), 0);
});

// ------------------------------------------------------------
// 畸形编号：内容不丢，但不让它驱动编号
// ------------------------------------------------------------

test('an implausible T id keeps its content but stops steering latestT', () => {
  const data = parseLogText([
    '## T1 · real · [keep]',
    '### User',
    '- 真实的一轮',
    '## T4000000000 · forged · [x]',
    '### User',
    '- 伪造的一轮',
    '### Action',
    '- modify src/a.ts — 做了事',
  ].join('\n'));

  assert.strictEqual(data.blocks.length, 2, '两个块都要留下，历史不能丢');
  assert.strictEqual(data.latestT, 1, '天文数字不能变成 latestT');
  assert.deepStrictEqual(data.tIds, [1], 'tIds 只包含可信编号');
  assert.strictEqual(data.blocks[1].implausibleId, true);
  assert.deepStrictEqual(data.blocks[1].sections.User, ['伪造的一轮']);
  assert.strictEqual(data.implausible.length, 1);
  assert.strictEqual(data.implausible[0].rawId, 'T4000000000');
});

test('T0 is not a usable id either', () => {
  const data = parseLogText('## T0 · zero\n### User\n- x\n### Action\n- y\n');
  assert.strictEqual(data.latestT, 0, 'T0 会让"最新一轮"读起来像空 pocket');
  assert.strictEqual(data.blocks.length, 1, '块本身还是要留下');
  assert.strictEqual(data.implausible.length, 1);
});

test('a long Action line parses in linear time', () => {
  const junk = 'x'.repeat(50000);
  const started = Date.now();
  const data = parseLogText('## T1 · t\n### Action\n- modify ' + junk + '.ts 和 ' + junk + '! — 描述\n');
  const ms = Date.now() - started;

  assert.strictEqual(data.blocks[0].sections.Action.length, 1);
  assert.ok(data.blocks[0].actions[0].files.length > 0, '路径仍要被抽出来');
  // 旧实现在这条线上要 5s 以上（目录段的字符类里含分隔符，嵌套量词回溯成平方级），
  // 现在应当是几十毫秒量级。留 2s 只是给慢 CI 的余量。
  assert.ok(ms < 2000, '解析用了 ' + ms + 'ms —— 正则回溯回来了');
});

// ------------------------------------------------------------
// config.md 取值解析
//
// templates/config.md 每一行都自带行尾注释，而旧 parseConfigValue 只在"字符串"
// 分支里摘注释：`quiet: false   # 说明` 于是解析成字符串 'false'（真值 = 开着），
// `archive_at: 800   # 说明` 解析成字符串。用户改配置从来没有任何效果。
// ------------------------------------------------------------

test('config values keep their type when the line carries an inline comment', () => {
  const dir = tmpProject('config-types');
  fs.writeFileSync(path.join(dir, 'config.md'), [
    '# ContextPocket · CONFIG',
    '',
    '- mode: full                # full = 10 个核心文件',
    '- quiet: false              # true = 每轮最多一行确认',
    '- archive_at: 800           # log.md 达到多少行提示归档',
    '- secret_scan: false        # 关掉密钥扫描',
    '- language: zh#1            # 井号前没有空格，属于取值本身',
  ].join('\n'), 'utf-8');

  const config = readConfig(dir);
  assert.strictEqual(config.quiet, false, 'false 带注释必须解析成布尔 false，不是字符串 "false"');
  assert.strictEqual(config.secret_scan, false);
  assert.strictEqual(config.archive_at, 800, '数字带注释要还是数字');
  assert.strictEqual(config.mode, 'full');
  assert.strictEqual(config.language, 'zh#1', '只有 `#` 前面是空白才算注释');
});

test('config falls back to defaults when the file is absent or half-written', () => {
  const dir = tmpProject('config-defaults');
  assert.strictEqual(readConfig(dir).secret_scan, true, '没写这一行就该开着扫描');

  fs.writeFileSync(path.join(dir, 'config.md'), '# CONFIG\n\n- quiet:\n- archive_at: 800 lines\n- mode:      # 只写了注释\n', 'utf-8');
  const config = readConfig(dir);
  assert.strictEqual(config.quiet, false, '空取值不覆盖默认值');
  assert.strictEqual(config.mode, DEFAULT_CONFIG.mode, '取值只剩注释时也不覆盖默认值');
  assert.strictEqual(config.archive_at, '800 lines', '非数字原样留着，由 verify 报"配置坏了"');
});

// ------------------------------------------------------------
// lib/secrets.js
// ------------------------------------------------------------

const secrets = require(path.join(ROOT, 'lib', 'secrets'));

const FAKE_KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz1234';

test('the scanner catches vendor credentials and leaves ordinary technical text alone', () => {
  const benign = [
    '这一轮改了 lib/query.js 的搜索回退，端口 3000，超时 2000ms',
    'commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b 里修好了',
    '构建时间戳 1727950000000，重试 30 次',
    '密钥轮换手册：登录控制台轮换 OpenAI key',
    '版本号 v1.2.3，格式 format: v1',
  ].join('\n');
  assert.deepStrictEqual(secrets.scanText(benign), [], '正常技术描述不该报出来：\n' + JSON.stringify(secrets.scanText(benign)));

  const cases = [
    ['sk-ant-abcdefghijklmnopqrstuvwxyz1234', 'Anthropic API key'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS access key id'],
    ['ghp_' + 'a'.repeat(36), 'GitHub token'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private key block'],
    ['https://hooks.slack.com/services/T000000BB/B00000000/' + 'A'.repeat(24), 'Slack webhook'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'd'.repeat(43), 'JWT'],
  ];
  for (const [text, label] of cases) {
    const found = secrets.scanText(text);
    assert.strictEqual(found.length, 1, text + ' 应当命中一条');
    assert.strictEqual(found[0].label, label);
    assert.strictEqual(found[0].severity, 'error');
  }
});

test('scan results never carry the secret itself, only a masked prefix', () => {
  const findings = secrets.scanText('用户贴了 ' + FAKE_KEY + ' 让我看报错');
  assert.strictEqual(findings.length, 1);
  const dump = JSON.stringify(findings);
  assert.ok(!dump.includes(FAKE_KEY), '扫描结果绝不能回显完整密钥：' + dump);
  assert.ok(!dump.includes(FAKE_KEY.slice(10)), '尾部熵段也不能出现在结果里：' + dump);
  assert.ok(/^sk-ant…\(\d+ chars\)$/.test(findings[0].masked), findings[0].masked);
});

test('placeholder and environment-reference values are not reported as credentials', () => {
  for (const line of [
    'api_key: <your-key-here>',
    'password = ${DB_PASSWORD}',
    'password: xxxxxxxx',
    'secret: changeme',
    'token: YOUR_TOKEN_HERE',
    '- secret_scan: true          # verify 是否扫描 pocket 里的密钥 / PII 形状',
    'password 字段至少 8 位，且必须包含数字',
  ]) {
    assert.deepStrictEqual(secrets.scanText(line), [], '不该报：' + line);
  }

  // 真的写进配置里的口令仍然要报（warning：可能是示例，也可能是真的）
  const hit = secrets.scanText('password = hunter2244');
  assert.strictEqual(hit.length, 1, '真实口令必须报出来');
  assert.strictEqual(hit[0].severity, 'warning');
});

test('a card number only counts when it passes Luhn, so timestamps stay quiet', () => {
  assert.deepStrictEqual(secrets.scanText('订单号 4111 1111 1111 1112'), []);
  assert.deepStrictEqual(secrets.scanText('构建时间戳 1727950000000 毫秒'), []);
  const hit = secrets.scanText('卡号 4111 1111 1111 1111');
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].label, 'card number');
  assert.strictEqual(hit[0].severity, 'warning');
});

test('redactText is opt-in and rewrites every hit with a labelled placeholder', () => {
  const out = secrets.redactText('调 ' + FAKE_KEY + ' 与 ghp_' + 'b'.repeat(36) + ' 都不行');
  assert.strictEqual(out.redacted, 2);
  assert.ok(!out.text.includes(FAKE_KEY), out.text);
  assert.ok(out.text.includes('[REDACTED:Anthropic API key]'), out.text);
  assert.deepStrictEqual(secrets.redactText('没有任何密钥的一行').text, '没有任何密钥的一行');
});

// ------------------------------------------------------------
// v2 的时间结构行（lib/when.js）
// ------------------------------------------------------------

const {
  parseWhen, whenLine, parseWhenLine, formatWhen, describeWhen, nowStamp, todayDate,
} = require(path.join(ROOT, 'lib', 'when'));

test('parseWhen turns the four shapes people actually say into the four kinds', () => {
  assert.deepStrictEqual(
    parseWhen('2026-10-03 14:47'),
    { kind: 'instant', date: '2026-10-03', from: '2026-10-03 14:47' }
  );
  assert.deepStrictEqual(parseWhen('2026-10-03'), { kind: 'day', date: '2026-10-03' });
  assert.deepStrictEqual(parseWhen('2026-10-03 09:00 → 2026-10-03 11:30'), {
    kind: 'range', date: '2026-10-03', from: '2026-10-03 09:00', to: '2026-10-03 11:30',
  });
  // ASCII 箭头是同一种写法的另一种手型
  assert.deepStrictEqual(parseWhen('2026-10-03 09:00 -> 11:30'), {
    kind: 'range', date: '2026-10-03', from: '2026-10-03 09:00', to: '2026-10-03 11:30',
  });
});

test('a range that only names the clock on the right inherits the left date — that is completion, not arithmetic', () => {
  const r = parseWhen('2026-10-03 23:30 → 00:20');
  assert.strictEqual(r.kind, 'range');
  assert.strictEqual(r.to, '2026-10-03 00:20',
    '跨夜的"00:20"绝不许被加成 10-04：工具不知道它到底是当天还是次日');

  // 只给钟点时补的是"今天"，而今天来自注入的时钟，不是 new Date() 里那个跑不掉的 now
  assert.deepStrictEqual(parseWhen('09:00', { today: '2026-10-03' }), {
    kind: 'instant', date: '2026-10-03', from: '2026-10-03 09:00',
  });
});

test('parseWhen refuses to compute: durations and vague words are stored verbatim', () => {
  assert.deepStrictEqual(parseWhen('上周三下午'), { kind: 'text', text: '上周三下午' });
  assert.deepStrictEqual(parseWhen('花了两个小时'), { kind: 'text', text: '花了两个小时' });
  assert.deepStrictEqual(parseWhen(''), null);
  assert.strictEqual(whenLine(parseWhen('花了两个小时')), '--- WHEN: stated: 花了两个小时 ---');
  // 原话要能被原样读回来，否则"记下了用户说的话"这件事就是假的
  assert.deepStrictEqual(parseWhenLine('--- WHEN: stated: 上周三下午 ---'), { kind: 'text', text: '上周三下午' });
});

test('whenLine round-trips through parseWhenLine for every kind', () => {
  for (const raw of [
    '2026-10-03 14:47',
    '2026-10-03',
    '2026-10-03 09:00 → 11:30',
    '2026-05-01 → 2026-05-03',
    '2026-05-01 → 11:30',
    'stated 上周三下午',
  ]) {
    const line = whenLine(parseWhen(raw));
    const back = parseWhenLine(line);
    assert.ok(line && /^--- WHEN: .+ ---$/.test(line), '结构行的形状：' + line);
    assert.ok(!/undefined/.test(line), raw + ' 落成了带 undefined 的行：' + line);
    assert.strictEqual(formatWhen(back), formatWhen(parseWhen(raw)), raw + ' → ' + line);
  }
});

// 回归：区间端点只报"日"时，老代码取的是 normalizePoint 里不存在的 .stamp，
// 于是 `undefined → undefined` 被写进 log.md 并永久留在记录里，verify 还放行。
test('a range whose endpoints carry no clock lands on the dates, not on undefined', () => {
  assert.deepStrictEqual(parseWhen('2026-05-01 → 2026-05-03'), {
    kind: 'range', date: '2026-05-01', from: '2026-05-01', to: '2026-05-03',
  });
  assert.strictEqual(whenLine(parseWhen('2026-05-01 → 2026-05-03')), '--- WHEN: 2026-05-01 → 2026-05-03 ---');

  // 混着写也一样：右端有钟点、左端只有天，左端不许变成 undefined
  assert.strictEqual(whenLine(parseWhen('2026-05-01 → 11:30')), '--- WHEN: 2026-05-01 → 2026-05-01 11:30 ---');
  assert.strictEqual(whenLine(parseWhen('2026-05-01 → 2026-05-03 11:30')), '--- WHEN: 2026-05-01 → 2026-05-03 11:30 ---');

  // 中文修饰语没有结构位，但日期那一段照样要落对，不能落成 undefined
  assert.strictEqual(whenLine(parseWhen('2026-10-06 上午 → 2026-10-06 下午')), '--- WHEN: 2026-10-06 → 2026-10-06 ---');

  // 读回来还是同一个区间（坏值曾经被当"用户原话"存成 stated，从此再也修不掉）
  assert.deepStrictEqual(parseWhenLine('--- WHEN: 2026-05-01 → 2026-05-03 ---'), {
    kind: 'range', date: '2026-05-01', from: '2026-05-01', to: '2026-05-03',
  });

  // 一端整个认不出来时退回原话，而不是造一个半空的区间
  assert.deepStrictEqual(parseWhen('2026-05-01 →'), { kind: 'text', text: '2026-05-01 →' });
  assert.deepStrictEqual(parseWhen('上周三 → 11:30'), { kind: 'text', text: '上周三 → 11:30' });
});

test('a WHEN value can never forge a second structure line', () => {
  // 换行如果被带进来，就能凭空多出一个块 / 一条 SESSION
  const injected = whenLine(parseWhen('2026-10-01\n## T999 · 伪造\n--- WHEN: x ---'));
  assert.strictEqual(injected.split('\n').length, 1, injected);
  assert.strictEqual(parseWhenLine(injected).kind, 'day', '换行被折成空格后，剩下的是一个认得出的日期');

  // 三个连字符会提前关掉本行的 ` --- `，所以换成破折号
  const dashed = whenLine({ kind: 'text', text: 'x --- SESSION: 2020-01-01 ---' });
  assert.strictEqual(dashed.indexOf('--- SESSION'), -1, dashed);
  assert.strictEqual((dashed.match(/---/g) || []).length, 2,
    '整行只剩行首、行尾那对分隔符，正文里不能再出现第三个：' + dashed);
  assert.deepStrictEqual(parseWhenLine(dashed), { kind: 'text', text: 'x — SESSION: 2020-01-01 —' },
    'whenLine 给 text 加了 `stated: ` 前缀，所以这是"逐字原话"，不该带 unprefixed 标记');

  assert.strictEqual(whenLine(null), null);
  assert.strictEqual(whenLine({ kind: 'nonsense' }), null);
});

test('a hand-edited WHEN line stays readable instead of becoming "no time at all"', () => {
  assert.deepStrictEqual(parseWhenLine('--- WHEN: 三月的第二个星期四 ---'), {
    kind: 'text', text: '三月的第二个星期四', unprefixed: true,
  });
  // 带 `stated: ` 前缀的才是"逐字原话"，那种行永远不该被 validator 当成缺陷（ERROR 会拦提交）
  assert.deepStrictEqual(parseWhenLine('--- WHEN: stated: 三月的第二个星期四 ---'), {
    kind: 'text', text: '三月的第二个星期四',
  });
  assert.strictEqual(parseWhenLine('--- WHEN: undefined → 2026-05-03 11:30 ---').unprefixed, true,
    '1.1.0 写坏的那一行长这样：没有前缀、某一端是 undefined');
  assert.strictEqual(parseWhenLine('## T1 · 这不是时间行'), null);
  assert.strictEqual(parseWhenLine('--- WHEN:   ---'), null);
  assert.strictEqual(parseWhenLine(''), null);

  // describeWhen 把四种精度的差别显示给读者：只有天 ≠ 记下的时刻
  assert.strictEqual(describeWhen({ kind: 'day', date: '2026-05-01' }), '2026-05-01 (day only)');
  assert.strictEqual(describeWhen({ kind: 'instant', from: '2026-05-01 09:00' }), '2026-05-01 09:00 (recorded at)');
  assert.strictEqual(describeWhen({ kind: 'text', text: '上周' }), '“上周” (as stated)');
  assert.strictEqual(describeWhen(null), '');
});

test('nowStamp / todayDate are local, zero-padded, and take an injected clock', () => {
  const noon = new Date(2026, 9, 3, 9, 7);
  assert.strictEqual(nowStamp(noon), '2026-10-03 09:07', '个位数的月/日/分都要补零');
  assert.strictEqual(todayDate(noon), '2026-10-03');
  assert.strictEqual(nowStamp().length, 16, '不传参数就是此刻的本地时间');
});

test('a v1 reader looks at a v2 log and just does not see the time — nothing else changes', () => {
  const withWhen = [
    '--- SESSION: 2026-05-01 ---',
    '',
    '## T1 · 带时间的块 · [测试]',
    '--- WHEN: 2026-05-01 09:00 → 2026-05-01 11:30 ---',
    '',
    '### User',
    '- 原话',
    '',
    '### Action',
    '- 改了 x',
    '',
  ].join('\n');
  const withoutWhen = withWhen.replace('--- WHEN: 2026-05-01 09:00 → 2026-05-01 11:30 ---\n', '');

  const a = parseLogText(withWhen, 1);
  const b = parseLogText(withoutWhen, 1);
  assert.strictEqual(a.blocks.length, 1);
  assert.deepStrictEqual(b.blocks.length, 1, '去掉时间行不影响解析');
  assert.strictEqual(a.blocks[0].gist, b.blocks[0].gist);
  assert.deepStrictEqual(a.blocks[0].sections, b.blocks[0].sections,
    '小节内容必须一字不差 —— 向后兼容的含义就是旧代码读新文件不丢东西');
  assert.deepStrictEqual(a.blocks[0].when, {
    kind: 'range', date: '2026-05-01', from: '2026-05-01 09:00', to: '2026-05-01 11:30',
  });
  assert.strictEqual(b.blocks[0].when, null, '没有这一行就是没有，不猜');
});

test('fields.whenValue normalizes --when the way the CLI and MCP both need', () => {
  assert.strictEqual(sectionFields({}).when, null, '没给就等于没给，不能变成空串写进行里');
  assert.strictEqual(sectionFields({ when: true }).when, null, '裸 --when 是缺值');
  assert.strictEqual(sectionFields({ when: '   ' }).when, null);
  assert.strictEqual(sectionFields({ when: '  上周三下午  ' }).when, '上周三下午');
  assert.strictEqual(turnFields({ when: '2026-10-03' }).when, '2026-10-03');
  // 只给 --when 也算"打算改点东西"，否则 amend 会把它当成空请求拒掉
  assert.strictEqual(hasAnySection(sectionFields({ when: '2026-10-03' })), true);
  assert.strictEqual(hasAnySection(sectionFields({})), false);
});

// ------------------------------------------------------------
// 搜索分词（lib/indexer.js 的 tokenize）
// ------------------------------------------------------------

test('tokenize: a Chinese phrase matches on bigrams, not on the whole run', () => {
  const doc = tokenize('给搜索加时间分页');
  const q = tokenize('时间分页');

  // 整串 run 当词元时，两侧的 run 必须逐字相同才命中 —— 于是 gist 里嵌着
  // 「时间分页」却查不到。中文查询只能靠二字组。
  assert.ok(!doc.includes('给搜索加时间分页'), '整串 run 不该进词表：' + JSON.stringify(doc));
  assert.ok(!q.includes('时间分页'), '查询整串同样不该进词表：' + JSON.stringify(q));
  for (const term of q) {
    assert.ok(doc.includes(term), `查询词元 ${term} 必须在文档词元里`);
  }

  // 丢掉整串不等于放弃顺序判别：乱序查询多出一个文档里不存在的二字组
  const reversed = tokenize('分页时间');
  assert.ok(reversed.includes('页时') && !doc.includes('页时'),
    '「分页时间」必须因缺少二字组「页时」而命不中');
});

test('tokenize: latin words, separators and mixed CJK/latin fragments all survive', () => {
  // 分隔符就是切词点："parser.js" 天然是 parser + js，"keep-alive" 是 keep + alive
  const latin = tokenize('parser.js keep-alive');
  assert.deepStrictEqual(latin.sort(), ['alive', 'js', 'keep', 'parser'], JSON.stringify(latin));

  // 中英混排（"索引v2"）里汉字和字母之间没有分隔符，会被切成一整串 ——
  // 中文交给二字组，拉丁/数字片段必须单独成词，否则版本号查不到
  const mixed = tokenize('索引v2 分页.js');
  assert.ok(mixed.includes('v2'), '混排里的版本号要能查：' + JSON.stringify(mixed));
  assert.ok(mixed.includes('js'), '混排里的扩展名要能查：' + JSON.stringify(mixed));
  assert.ok(mixed.includes('索引') && mixed.includes('分页'));
  assert.ok(!mixed.includes('索引v2'), '混排整串同样不该进词表：' + JSON.stringify(mixed));

  assert.deepStrictEqual(tokenize('库'), ['库'], '单字 run 只能按整字命中');
  assert.deepStrictEqual(tokenize(''), []);
});

// ============================================================
// lib/repair.js —— 重编号方案与引用判定（纯函数，不落盘）
// ============================================================

const repair = require(path.join(ROOT, 'lib', 'repair'));

test('repair: planIdRenumber shifts the colliding block and everything after it', () => {
  // 两台机器各写两轮都从 T3 开始，合并后文件顺序是 1,2,3,3,4。
  // 只改重复那一块会得到 1,2,4,3 —— verify 的"顺序"检查接着报错；
  // 整体后移才是这段历史本来的读法。
  const headings = repair.collectHeadings([
    '## T1 · 一', '## T2 · 二', '## T3 · 三-A', '## T3 · 三-B', '## T4 · 四-B',
  ]);
  assert.strictEqual(headings.length, 5);
  assert.ok(repair.hasDuplicateIds(headings));

  const changes = repair.planIdRenumber(headings);
  assert.deepStrictEqual(changes.map((c) => c.from + '→' + c.to), ['3→4', '4→5'],
    JSON.stringify(changes));
  // 记录的是行号（0 基），CLI 显示时 +1
  assert.deepStrictEqual(changes.map((c) => c.line), [3, 4]);
});

test('repair: a clean log gets an empty plan — repair never renumbers what it was not asked to touch', () => {
  const headings = repair.collectHeadings(['## T1 · 一', '## T2 · 二', '## T7 · 七']);
  assert.ok(!repair.hasDuplicateIds(headings));
  // 跳号（2→7）是 verify 的 warning 管的，不在 repair 的职责里
  assert.deepStrictEqual(repair.planIdRenumber(headings), []);
});

test('repair: malformed T-ids stay put instead of being invented into the sequence', () => {
  // toPlausibleId 认不出的号（超大/非数字）由 verify 第 11 项单独管。
  // repair 如果顺手给它们排号，就是在凭空制造历史。
  const headings = repair.collectHeadings(['## T99999999999999 · 怪', '## T2 · 二']);
  assert.strictEqual(headings[0].id, null);
  assert.ok(!repair.hasDuplicateIds(headings), '畸形号不参与撞号判定');
  assert.deepStrictEqual(repair.planIdRenumber(headings), []);
});

test('repair: references are remapped in ONE pass, so a cascade cannot move a ref twice', () => {
  const map = new Map([[3, 4], [4, 5]]);
  const out = repair.remapTRefs('先做 T3，后来 T4 推翻了 T3', map);
  // 逐条 replace 的话：3→4 后再 4→5，"先做"那步会被挪成 T5
  assert.strictEqual(out.text, '先做 T4，后来 T5 推翻了 T4');
  assert.deepStrictEqual(out.hits, [3, 4, 3]);

  // 只列不改必须和改写用同一套判据，否则清单和实际改动不一致
  assert.deepStrictEqual(repair.findTRefs('先做 T3，后来 T4 推翻了 T3', map), [3, 4, 3]);
  assert.deepStrictEqual(repair.findTRefs('T9 与本表无关', map), []);
});

test('repair: derived header T-n follows the mapping, else aligns to the new latest', () => {
  const map = new Map([[3, 4], [4, 5]]);

  // 头行还指着"旧的最新轮"：那次改号正是把它自己挪走了
  assert.deepStrictEqual(
    repair.remapDerivedHeader('# Decisions · T4 · 2026-10-05', { map, oldLatest: 4, newLatest: 5 }),
    { line: '# Decisions · T5 · 2026-10-05', changed: true }
  );

  // 头行指着映射表里的号：跟着映射走
  assert.deepStrictEqual(
    repair.remapDerivedHeader('# State · T3', { map, oldLatest: 4, newLatest: 5 }),
    { line: '# State · T4', changed: true }
  );

  // 头行指着没动的号：派生计数器不是引用，不能跟着改
  assert.deepStrictEqual(
    repair.remapDerivedHeader('# State · T2', { map, oldLatest: 4, newLatest: 5 }),
    { line: '# State · T2', changed: false }
  );

  assert.deepStrictEqual(
    repair.remapDerivedHeader('# State · 没有 T 号', { map, oldLatest: 4, newLatest: 5 }),
    { line: '# State · 没有 T 号', changed: false }
  );
});

test('repair: a block heading is a definition, not a reference', () => {
  // 撞号里保留原号的那一块（## T3 · 三-A）也命中映射表 3→4。
  // 把它当引用改掉，就等于把没动的块挪走了 —— dry-run 曾报过这个假引用。
  assert.ok(repair.HEADING_RE.test('## T3 · 三-A · [测试]'));
  assert.ok(repair.HEADING_RE.test('##  T3·紧凑写法'));
  assert.ok(!repair.HEADING_RE.test('- 承接 T3 的结论'));
  assert.ok(!repair.HEADING_RE.test('### T3 · 小节不是块头'));
});

test('repair: word boundaries keep GPT4 and friends out of the reference list', () => {
  const map = new Map([[3, 4], [4, 5]]);

  // 这些都是真实正文里会出现的词。映射表带着 4，一次没有词边界的替换就会把
  // `GPT4` 写成 `GPT5` —— 那不是修编号，那是改历史。
  const prose = '模型换成 GPT4，显卡 RTX4090，编码 UTF8，协议 HTTP2，块是 T3';
  assert.deepStrictEqual(repair.findTRefs(prose, map), [3]);
  assert.strictEqual(
    repair.remapTRefs(prose, map).text,
    '模型换成 GPT4，显卡 RTX4090，编码 UTF8，协议 HTTP2，块是 T4'
  );

  // 下划线/连字符同样算"接着字母"：`T3_slug`、`T3-final` 不是引用
  assert.deepStrictEqual(repair.findTRefs('附件 T3_final.png 与 T3-final.md', map), []);

  // 句末的 `见 T3.` 必须仍然算引用 —— 只排除"点 + 2~4 个字母"这种扩展形状
  assert.deepStrictEqual(repair.findTRefs('结论见 T3.', map), [3]);
  assert.deepStrictEqual(repair.findTRefs('图在 ./T3.png 里', map), []);

  // 前后都独立才命中
  assert.deepStrictEqual(repair.findTRefs('T3 与 T4 都成立', map), [3, 4]);
});

test('repair: attachment file names are listed with an mv command, never rewritten', () => {
  const map = new Map([[3, 4], [4, 5]]);

  const hits = repair.findFileTokens('- 结构图见 T4-diagram.png: assets/T04-diagram.png，另见 T3.png', map);
  assert.deepStrictEqual(hits.map((h) => h.name), ['T4-diagram.png', 'assets/T04-diagram.png', 'T3.png']);
  assert.deepStrictEqual(hits.map((h) => h.renamed), ['T5-diagram.png', 'assets/T05-diagram.png', 'T4.png']);
  // 零填充按原 token 的位数补齐，否则改名会把命名规范改坏
  assert.strictEqual(hits[1].command, 'mv "assets/T04-diagram.png" "assets/T05-diagram.png"');

  // 不在映射表里的号（跳号、别的上下文写的 T9）不打扰
  assert.deepStrictEqual(repair.findFileTokens('assets/T9-diagram.png', map), []);

  // remapTRefs 对同一行一个字都不动：文件名那一半只能由 mv 完成
  const line = 'assets/T04-diagram.png 说明见 T4';
  assert.strictEqual(repair.remapTRefs(line, map).text, 'assets/T04-diagram.png 说明见 T5');

  // ≥100 的号不需要补零，多扩展名的 token 也要认
  const big = new Map([[100, 101]]);
  assert.deepStrictEqual(
    repair.findFileTokens('T100-report.final.png', big).map((h) => h.renamed),
    ['T101-report.final.png']
  );
});

// ============================================================
// lib/validator.js —— 附件声明的取路径判据（误报会挡住 pre-commit）
// ============================================================

const validator = require(path.join(ROOT, 'lib', 'validator'));

test('attachment refs: only the recorded path counts, never the label or a URL', () => {
  // 规范写法 `- T<n> <label>: assets/<file>`：label 里那个 `project-structure.png`
  // 是名字不是声明，整行无差别扫会把它当成第二条附件并报 error。
  assert.deepStrictEqual(
    validator.attachmentRefs('T1 project-structure.png: assets/T01-project-structure.png — 初始目录结构'),
    ['assets/T01-project-structure.png']
  );

  // markdown 图片取链接目标；裸写带 `/` 的路径也算；整行只有一个文件名也算
  assert.deepStrictEqual(validator.attachmentRefs('![T2 ui](assets/T02-ui.png "截图") — 界面'),
    ['assets/T02-ui.png']);
  assert.deepStrictEqual(validator.attachmentRefs('assets/T03-flow.svg'), ['assets/T03-flow.svg']);
  assert.deepStrictEqual(validator.attachmentRefs('T04-diff.txt'), ['T04-diff.txt']);

  // URL / 绝对路径 / `..` / 锚点 / 模板占位 —— 全都不能当本地附件
  assert.deepStrictEqual(validator.attachmentRefs('T5 ref: https://cdn.example.com/T05-a.png'), []);
  assert.deepStrictEqual(validator.attachmentRefs('T5 ref: //cdn.example.com/T05-a.png'), []);
  assert.deepStrictEqual(validator.attachmentRefs('T5 ref: example.com/T05-a.png'), []);
  assert.deepStrictEqual(validator.attachmentRefs('T5 ref: /home/me/T05-a.png'), []);
  assert.deepStrictEqual(validator.attachmentRefs('T5 ref: C:/Users/me/T05-a.png'), []);
  assert.deepStrictEqual(validator.attachmentRefs('T5 ref: ../../outside/T05-a.png'), []);
  assert.deepStrictEqual(validator.attachmentRefs('T5 ref: #section-anchor'), []);
  assert.deepStrictEqual(validator.attachmentRefs('T5 <label>: assets/T05-<slug>.<ext> — <what it is>'), []);

  // 版本号不是文件
  assert.deepStrictEqual(validator.attachmentRefs('T6 bump: 1.0 → 1.2'), []);

  // Windows 分隔符归一之后照样是相对路径（String.raw：`\a` 在普通字符串里会被吃掉）
  assert.deepStrictEqual(validator.attachmentRefs(String.raw`T7 map: ContextPocket\assets\T07-map.png`),
    ['ContextPocket/assets/T07-map.png']);
});

test('isCheckableAttachmentRef keeps the host-like and out-of-pocket shapes out', () => {
  assert.strictEqual(validator.isCheckableAttachmentRef('assets/T01-a.png'), true);
  assert.strictEqual(validator.isCheckableAttachmentRef('T01-a.png'), true);
  assert.strictEqual(validator.isCheckableAttachmentRef('https://x.com/a.png'), false);
  assert.strictEqual(validator.isCheckableAttachmentRef('cdn.x.com/a.png'), false);
  assert.strictEqual(validator.isCheckableAttachmentRef('./a.png'), true);
  assert.strictEqual(validator.isCheckableAttachmentRef('../a.png'), false);
  assert.strictEqual(validator.isCheckableAttachmentRef('T01-<slug>.png'), false);
  assert.strictEqual(validator.isCheckableAttachmentRef(''), false);
});

// ------------------------------------------------------------
// 版本号
// ------------------------------------------------------------

test('pkgVersion reads package.json and degrades to the fallback without one', () => {
  const { pkgVersion, FALLBACK_VERSION } = require(path.join(ROOT, 'lib', 'version'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

  const here = pkgVersion();
  assert.strictEqual(here.source, 'package.json', '在仓库里跑就必须读得到 package.json');
  assert.strictEqual(here.version, pkg.version);

  // 目录式安装（只拷 bin/ 与 lib/，没有 package.json）不能崩，必须还是有号可报
  const bare = pkgVersion(tmpProject('unit-version-no-pkg'));
  assert.strictEqual(bare.source, 'fallback');
  assert.strictEqual(bare.version, FALLBACK_VERSION);
});

// package.json 是唯一真值，其余三处都是它的抄本：静态文件没法自己算，所以只能靠用例逐处比对。
// 少这一条，升级版本号漏改的那处不会在任何入口报错，只会让 CLI、MCP、SKILL.md、CHANGELOG
// 各说一个号——1.1.0 定版之前就是 CHANGELOG 停在 [Unreleased] 而被发现的。
test('every copy of the skill version says the same number as package.json', () => {
  const { FALLBACK_VERSION } = require(path.join(ROOT, 'lib', 'version'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
  const stamped = skill.match(/^version:\s*(\S+)\s*$/m);
  assert.ok(stamped, 'SKILL.md 的 frontmatter 必须有 `version:` 一行');
  assert.strictEqual(stamped[1], pkg.version, 'SKILL.md 的 version 与 package.json 漂开了');

  assert.strictEqual(FALLBACK_VERSION, pkg.version,
    'lib/version.js 的 FALLBACK_VERSION 与 package.json 不一致：兜底值本该就是当前版本号');

  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
  assert.ok(changelog.includes('## [' + pkg.version + '] - '),
    'package.json 已是 ' + pkg.version + '，CHANGELOG 却没有 `## [' + pkg.version + '] - <日期>` 这节定版标题'
    + '（CONTRIBUTING「发布流程」第 2 步没做完）');
});
