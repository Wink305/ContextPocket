'use strict';

/**
 * 套件：历史会话导入（lib/importer.js）
 *
 * import 是"中途启用不丢历史"的唯一入口，此前没有任何 fixture 测试：
 * 各家 JSONL 的形状、噪音过滤、T 号接续、limit/truncate/dry-run 全靠肉眼看。
 * 这里用真实的 jsonl 文本喂进去，再看 log.md 里长出来的 T-block。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, test, makePocket, makeV1Pocket, readPocketFile, tmpProject, ROOT } = require('./harness');

const { importSession, parseSession, SUPPORTED_SOURCES } = require(path.join(ROOT, 'lib', 'importer'));
const parser = require(path.join(ROOT, 'lib', 'parser'));
const writer = require(path.join(ROOT, 'lib', 'writer'));
const { verify } = require(path.join(ROOT, 'lib', 'validator'));
const { POCKET_DIR_NAME } = require(path.join(ROOT, 'lib', 'constants'));

const CLI_PATH = path.join(ROOT, 'bin', 'context-pocket.js').split(path.sep).join('/');

/** 把 jsonl 行写成临时会话文件，返回路径 */
function fixture(tag, lines) {
  const dir = tmpProject('import-' + tag);
  const file = path.join(dir, tag + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  return file;
}

/** Claude Code 形状的一轮对话 */
function ccUser(text, ts) {
  return JSON.stringify({ type: 'user', timestamp: ts || '2026-09-01T08:00:00.000Z', message: { role: 'user', content: text } });
}
function ccAssistant(blocks) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-01T08:01:00.000Z',
    message: { role: 'assistant', content: blocks },
  });
}

// ============================================================
// 解析：各家形状
// ============================================================

test('importer: claude-code jsonl (string user, block-array assistant) parses into turns', () => {
  const file = fixture('claude', [
    ccUser('帮我把登录接口改成 JWT'),
    ccAssistant([{ type: 'text', text: '已改完 auth.js' }, { type: 'thinking', thinking: '内部推理不该进记录' }]),
    ccUser('再补个测试', '2026-09-02T09:00:00.000Z'),
    ccAssistant([{ type: 'text', text: '加了 test/auth.spec.js' }]),
  ]);

  const parsed = parseSession(file);
  assert.strictEqual(parsed.source, 'claude-code');
  assert.strictEqual(parsed.turns.length, 2);
  assert.strictEqual(parsed.turns[0].user, '帮我把登录接口改成 JWT');
  assert.strictEqual(parsed.turns[0].ts, '2026-09-01', 'timestamp 只取日期部分');
  assert.strictEqual(parsed.turns[0].summary, '已改完 auth.js', 'thinking 块不能进摘要');
  assert.strictEqual(parsed.turns[1].ts, '2026-09-02');
});

test('importer: codex jsonl (response_item payload) parses, incl. input_text/output_text', () => {
  const file = fixture('codex', [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '系统提示，不该出现' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-03T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '把支付回调做成幂等' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '用 request_id 去重' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }),
  ]);

  const parsed = parseSession(file);
  assert.strictEqual(parsed.source, 'codex');
  assert.strictEqual(parsed.turns.length, 1, 'developer 角色与 function_call 都要丢掉');
  assert.strictEqual(parsed.turns[0].user, '把支付回调做成幂等');
  assert.strictEqual(parsed.turns[0].summary, '用 request_id 去重');
});

test('importer: generic shapes are sniffed, and a source override is respected verbatim', () => {
  const roleFirst = fixture('role', [
    JSON.stringify({ role: 'user', content: '泛化形状 A' }),
    JSON.stringify({ role: 'assistant', content: '回复 A' }),
  ]);
  assert.strictEqual(parseSession(roleFirst).source, 'generic');

  const messageWrapped = fixture('msg', [
    JSON.stringify({ message: { role: 'user', content: '泛化形状 B' } }),
  ]);
  assert.strictEqual(parseSession(messageWrapped).source, 'generic');

  // 显式指定来源时，label 直接进 T-block 的 Action 行，不做二次嗅探
  const forced = fixture('forced', [ccUser('强制来源')]);
  assert.strictEqual(parseSession(forced, { source: 'claude-code' }).source, 'claude-code');
  assert.strictEqual(parseSession(forced, { source: 'auto' }).source, 'claude-code');
});

test('importer: unsupported source is rejected instead of silently parsing nothing', () => {
  const { pocketDir } = makePocket('import-src');
  const file = fixture('reject', [ccUser('随便一句话')]);
  assert.ok(!SUPPORTED_SOURCES.includes('gemini-cli'));
  assert.throws(
    () => importSession(pocketDir, { file, source: 'gemini-cli' }),
    /Unsupported source "gemini-cli"/
  );
});

// ============================================================
// 噪音与畸形输入
// ============================================================

test('importer: command markers, caveats, interruptions and system reminders are dropped', () => {
  const file = fixture('noise', [
    ccUser('<command-name>/clear</command-name>'),
    ccUser('Caveat: 这是 Claude 注入的提示语'),
    ccUser('[request interrupted by user]'),
    ccUser('<system-reminder>别记这个</system-reminder>'),
    ccUser('   '),
    ccUser('这条才是要记的'),
    ccAssistant([{ type: 'tool_result', content: '一大段工具输出' }]),
    ccAssistant([{ type: 'text', text: '好的，记下了' }]),
  ]);

  const parsed = parseSession(file);
  assert.strictEqual(parsed.turns.length, 1, '五种噪音都不该开出一个 T-block');
  assert.strictEqual(parsed.turns[0].user, '这条才是要记的');
  assert.strictEqual(parsed.turns[0].summary, '好的，记下了', 'tool_result 不进摘要');
});

test('importer: assistant text before any user message is dropped, not orphaned', () => {
  const file = fixture('orphan', [
    ccAssistant([{ type: 'text', text: '没有主人的回复' }]),
    ccUser('先有用户'),
  ]);
  const parsed = parseSession(file);
  assert.strictEqual(parsed.turns.length, 1);
  assert.strictEqual(parsed.turns[0].summary, '', '开场助手文本不能被塞进下一轮');
});

test('importer: blank, garbage and half-written JSON lines are skipped without throwing', () => {
  const file = fixture('malformed', [
    '',
    '   ',
    '# 这不是 JSON（会话文件头信息）',
    '{"role":"user","content":"正常一行"}',
    '{"role":"assistant","content":',
    '{"type":"session","id":"abc"}',
    'null',
    '"just a string"',
    '[1,2,3]',
    '   {"role":"assistant","content":"补一行回复"}   ',
  ]);

  const parsed = parseSession(file);
  assert.strictEqual(parsed.turns.length, 1);
  assert.strictEqual(parsed.turns[0].summary, '补一行回复', '前后带空白的行也要解析');
});

// ============================================================
// 截断与限量
// ============================================================

test('importer: limit caps the turns and truncate caps each field', () => {
  const long = '很长的需求描述'.repeat(40);
  const lines = [];
  for (let i = 1; i <= 6; i++) lines.push(ccUser('第 ' + i + ' 轮：' + long));
  const file = fixture('limit', lines);

  const capped = parseSession(file, { limit: 3, truncate: 50 });
  assert.strictEqual(capped.turns.length, 3, 'limit 必须真的截断轮次');
  assert.ok(capped.turns[0].user.length <= 51, 'truncate=50 → 50 字 + 省略号，实测 ' + capped.turns[0].user.length);
  assert.ok(capped.turns[0].user.endsWith('…'), '被截断的字段要留下省略号');
});

test('importer: several assistant messages accumulate into one Action summary', () => {
  const file = fixture('accumulate', [
    ccUser('连续回复'),
    ccAssistant([{ type: 'text', text: '第一步' }]),
    ccAssistant([{ type: 'text', text: '第二步' }]),
  ]);
  const parsed = parseSession(file);
  assert.strictEqual(parsed.turns[0].summary, '第一步\n第二步');

  const greedy = fixture('greedy', [
    ccUser('超长回复'),
    ccAssistant([{ type: 'text', text: 'A'.repeat(100) }]),
    ccAssistant([{ type: 'text', text: 'B'.repeat(100) }]),
  ]);
  const capped = parseSession(greedy, { truncate: 120 });
  assert.ok(capped.turns[0].summary.length <= 121, '累加后仍受 truncate 约束');
  assert.ok(capped.turns[0].summary.endsWith('…'));
});

// ============================================================
// 落到 log.md 的结果
// ============================================================

test('importer: import appends [imported] T-blocks continuing the existing numbering', () => {
  const { pocketDir } = makePocket('import-append');

  // 先造一条真实记录，验证 T 号是"接着最新号往后排"
  writer.appendLogBlock(pocketDir, { gist: '已有工作', tags: ['日常'], user: ['已有工作'], action: ['改 src/a.js'] });
  const latest = parser.parseLog(pocketDir).latestT;

  const file = fixture('append', [
    ccUser('把导入这条历史补进来', '2026-09-04T12:00:00Z'),
    ccAssistant([{ type: 'text', text: '已经导入完成' }]),
    ccUser('这一轮没有回复'),
  ]);

  const result = importSession(pocketDir, { file });
  assert.strictEqual(result.imported, 2);
  assert.strictEqual(result.tStart, latest + 1);
  assert.strictEqual(result.tEnd, latest + 2);
  assert.strictEqual(result.source, 'claude-code');

  const log = readPocketFile(pocketDir, 'log.md');
  const blocks = parser.parseLog(pocketDir).blocks;
  const first = blocks.find((b) => b.id === result.tStart);
  const second = blocks.find((b) => b.id === result.tEnd);

  assert.deepStrictEqual(first.tags, ['imported'], '统一打 [imported] 标签');
  assert.deepStrictEqual(first.sections.User, ['[2026-09-04] 把导入这条历史补进来'], '原话带上会话里的日期');
  assert.ok(first.sections.Action[0].includes('导入 claude-code 会话'), '来源与文件名要写进 Action');
  assert.ok(first.sections.Action[1] === '已经导入完成');
  assert.ok(!log.includes('<thinking>'), '内部推理绝不能落到 log.md');
  assert.ok(second.sections.Action.join('\n').includes('（无助手文本回复记录）'), '没有回复也要显式说明');

  // 导入的历史不能把 pocket 弄坏
  const report = verify(pocketDir);
  const errors = report.results.filter((r) => r.severity === 'error');
  assert.strictEqual(report.errorCount, 0, '导入后 verify 不能有 error:\n' + JSON.stringify(errors, null, 2));
});

test('importer: dry-run previews without touching log.md or the index', () => {
  const { pocketDir } = makePocket('import-dry');
  const before = readPocketFile(pocketDir, 'log.md');
  const beforeIndex = readPocketFile(pocketDir, 'index.md');

  const file = fixture('dry', [ccUser('别写我'), ccAssistant([{ type: 'text', text: '好' }]), ccUser('也不要')]);
  const result = importSession(pocketDir, { file, dryRun: true });

  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(result.tStart, null);
  assert.strictEqual(result.plannedTurns, 2);
  assert.strictEqual(result.preview.length, 2);
  assert.strictEqual(result.preview[0].gist, '别写我');
  assert.strictEqual(result.preview[0].ts, '2026-09-01');
  assert.strictEqual(readPocketFile(pocketDir, 'log.md'), before, 'dry-run 必须一个字节都不写');
  assert.strictEqual(readPocketFile(pocketDir, 'index.md'), beforeIndex);
});

test('importer: missing or nonexistent --file fails loudly instead of importing nothing', () => {
  const { pocketDir } = makePocket('import-nofile');
  assert.throws(() => importSession(pocketDir, {}), /--file is required/);

  const gone = path.join(tmpProject('import-gone'), 'nope.jsonl');
  assert.throws(() => importSession(pocketDir, { file: gone }), /Session file not found/);

  // 全是噪音的会话：导入 0 轮，不写任何东西，也不报错
  const empty = fixture('empty', [ccUser('<command-name>/clear</command-name>')]);
  const before = readPocketFile(pocketDir, 'log.md');
  const result = importSession(pocketDir, { file: empty });
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(result.tStart, null);
  assert.strictEqual(readPocketFile(pocketDir, 'log.md'), before, '0 轮导入不能碰 log.md');
});

// ============================================================
// CLI 入口：参数必须真的生效
// ============================================================

/** 跑一次 CLI，返回 { status, json, stdout } */
function runCli(args) {
  const run = spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf-8' });
  const out = (run.stdout || '').trim();
  let json = null;
  try {
    json = JSON.parse(out.split('\n').pop());
  } catch (e) { /* 人类模式 */ }
  return { status: run.status, json, stdout: out, stderr: run.stderr || '' };
}

test('importer: CLI import --truncate / --limit take real values (not silent no-ops)', () => {
  const { projectDir } = makePocket('import-cli');
  const long = '这一轮的用户原话特意写得很长很长，用来验证截断参数是否真的生效而不是被当成开关无声忽略掉；'
    + '后面这些字在默认 60 字上限的 preview 里必须被截掉，正好也验证 gist 自己的截断。';
  const lines = [];
  for (let i = 1; i <= 4; i++) lines.push(ccUser(long + i));
  const file = fixture('cli-truncate', lines);
  assert.ok(long.length > 60, '样本必须长于 60 字才能验证 gist 上限（实测 ' + long.length + '）');

  // 不传参数：preview 的 gist 截到 60 字
  const plain = runCli(['import', '--dir', projectDir, '--file', file, '--dry-run', '--json']);
  assert.strictEqual(plain.status, 0, plain.stdout + plain.stderr);
  assert.strictEqual(plain.json.ok, true);
  assert.strictEqual(plain.json.plannedTurns, 4);
  assert.strictEqual(plain.json.preview[0].gist, long.slice(0, 60) + '…', 'preview 的 gist 上限是 60 字');

  // --truncate 20：parseSession 层先截到 20 字
  const cut = runCli(['import', '--dir', projectDir, '--file', file, '--dry-run', '--truncate', '20', '--json']);
  assert.strictEqual(cut.status, 0, cut.stdout + cut.stderr);
  assert.strictEqual(cut.json.preview[0].gist, long.slice(0, 20) + '…',
    '--truncate 20 必须生效（旧实现把它当开关，20 掉进位置参数被无声忽略）');

  // --limit 2：只计划 2 轮
  const few = runCli(['import', '--dir', projectDir, '--file', file, '--dry-run', '--limit', '2', '--json']);
  assert.strictEqual(few.json.plannedTurns, 2);

  // 真导入一轮，检查落盘
  const real = runCli(['import', '--dir', projectDir, '--file', file, '--limit', '1', '--json']);
  assert.strictEqual(real.json.imported, 1);
  const log = fs.readFileSync(path.join(projectDir, POCKET_DIR_NAME, 'log.md'), 'utf-8');
  assert.ok(/\[imported\]/.test(log), 'CLI 导入的块同样带 [imported] 标签');
});

test('importer: CLI import without a pocket fails as machine-readable JSON', () => {
  const bare = tmpProject('import-no-pocket');
  const file = fixture('cli-nopocket', [ccUser('随便一句话')]);
  const run = runCli(['import', '--dir', bare, '--file', file, '--json']);

  assert.strictEqual(run.status, 1, '没有 pocket 必须退 1');
  assert.strictEqual(run.json.ok, false, '失败也得是一行可 parse 的 JSON，不是 emoji 文本');
  assert.match(run.json.error, /ContextPocket\/ directory found/);
});

// ============================================================
// v2：源时间戳有几分精度就搬几分
// ============================================================

/** 三行不同精度的时间戳：带时区、只写钟点、只写日期 */
function tsFixture(tag) {
  const line = (role, text, ts) => JSON.stringify(
    ts ? { type: role, timestamp: ts, message: { role, content: text } }
       : { type: role, message: { role, content: text } }
  );
  return fixture(tag, [
    line('user', '带时区的 UTC 时刻', '2026-09-01T08:00:00.000Z'),
    line('assistant', '收到'),
    line('user', '没写时区的钟点', '2026-09-02T21:30:00'),
    line('assistant', '收到'),
    line('user', '只有日期', '2026-09-03'),
    line('assistant', '收到'),
  ]);
}

test('importer: a source timestamp keeps exactly the precision it had', () => {
  const parsed = parseSession(tsFixture('when-ts'));
  assert.strictEqual(parsed.turns.length, 3, JSON.stringify(parsed.turns));

  // 带 Z 的时间戳换成本地钟点 —— 与实时 `log append` 记下的口径一致，
  // 否则同一台机器上"导入的历史"和"当场记的"会差一个时区
  const d = new Date('2026-09-01T08:00:00.000Z');
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  assert.strictEqual(parsed.turns[0].when, local, JSON.stringify(parsed.turns[0]));

  // 没写时区的钟点原样照抄：猜它是哪个时区就可能错一小时
  assert.strictEqual(parsed.turns[1].when, '2026-09-02 21:30');

  // 只有日期就只给日期，绝不补一个 00:00 冒充钟点
  assert.strictEqual(parsed.turns[2].when, '2026-09-03');
  assert.strictEqual(parsed.turns[2].ts, '2026-09-03', 'User 行里的 [日期] 前缀照旧');
});

test('importer: imported blocks land with the right WHEN line shape', () => {
  const { pocketDir } = makePocket('import-when');
  const result = importSession(pocketDir, { file: tsFixture('import-when') });
  assert.strictEqual(result.imported, 3);

  const blocks = parser.parseLog(pocketDir).blocks;
  const first = blocks.find((b) => b.id === result.tStart);
  const second = blocks.find((b) => b.id === result.tStart + 1);
  const third = blocks.find((b) => b.id === result.tEnd);

  assert.strictEqual(first.when.kind, 'instant', JSON.stringify(first.when));
  assert.strictEqual(second.when.kind, 'instant');
  assert.strictEqual(second.when.from, '2026-09-02 21:30', '钟点要落在块头那一行');
  assert.strictEqual(third.when.kind, 'day', '源里只有日期，落盘就得是 (day)：' + JSON.stringify(third.when));
  assert.strictEqual(third.when.from, undefined, '不许为了一天而造一个时刻');

  const log = readPocketFile(pocketDir, 'log.md');
  assert.ok(log.includes('--- WHEN: 2026-09-03 (day) ---'), log);
  assert.ok(!/--- WHEN: 2026-09-03 00:00/.test(log), '绝不能把"只知道天"写成"零点整"：\n' + log);
  assert.ok(!/\\---/.test(log), '转义过的结构行解析器读不到：\n' + log);
  assert.strictEqual(verify(pocketDir).errorCount, 0);
});

test('importer: importing into a v1 pocket adds no time line at all', () => {
  const { pocketDir } = makeV1Pocket('import-v1-when');
  const before = readPocketFile(pocketDir, 'log.md');
  const result = importSession(pocketDir, { file: tsFixture('import-v1') });
  assert.ok(result.imported > 0, '测试前提：确实导入了轮次');

  const after = readPocketFile(pocketDir, 'log.md');
  assert.strictEqual(after.split(/\r?\n/).filter((l) => /^--- WHEN: /.test(l)).length, 0,
    'v1 的 pocket 里冒出一行 v2 的东西，等于内容超出它自己声明的版本：\n' + after);

  const blocks = parser.parseLog(pocketDir).blocks;
  assert.ok(blocks.every((b) => !b.when), 'v1 块读不出时间才是对的：' + JSON.stringify(blocks.map((b) => b.when)));
  // 导入的历史轮次仍然必须在（升级前也合法的）文件里
  assert.ok(after.includes('[imported]'), after);
  assert.notStrictEqual(after, before);
  assert.strictEqual(verify(pocketDir).errorCount, 0);
});
