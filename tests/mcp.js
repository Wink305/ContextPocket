'use strict';

/**
 * MCP 传输层测试
 *
 * MCP 的 stdio 传输是"换行分隔的 JSON-RPC"，不是 LSP 的 Content-Length 头。
 * 这两个用例锁住这一点：一旦有人把分帧改回去，所有客户端会直接卡死。
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { assert, test, makePocket, makeV1Pocket, readPocketFile, writePocketFile, tmpProject, ROOT } = require('./harness');

const migrate = require(path.join(ROOT, 'lib', 'migrate'));

const SERVER = path.join(ROOT, 'mcp-server.js');
const SMOKE = path.join(ROOT, 'mcp-smoke.js');
const CLI = path.join(ROOT, 'bin', 'context-pocket.js');

function startServer(pocketDir) {
  const child = spawn(process.execPath, [SERVER], { cwd: pocketDir, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const messages = [];
  const waiters = [];

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        messages.push({ parseError: line });
      }
      while (waiters.length && waiters[0].want <= messages.length) waiters.shift().resolve();
    }
  });

  return {
    child,
    messages,
    send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); },
    waitFor(count, timeoutMs = 15000) {
      if (messages.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for ' + count + ' MCP message(s)')), timeoutMs);
        waiters.push({ want: count, resolve: () => { clearTimeout(t); resolve(); } });
      });
    },
  };
}

test('mcp: initialize/tools/list speak newline-delimited JSON-RPC', () => {
  const { projectDir } = makePocket('mcp-transport');
  const srv = startServer(projectDir);

  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });
  srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  srv.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  srv.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  srv.send({ jsonrpc: '2.0', id: 4, method: 'no_such_method' });

  return srv.waitFor(4).then(() => {
    const byId = {};
    for (const m of srv.messages) if (m.id !== undefined) byId[m.id] = m;

    assert.ok(byId[1].result.protocolVersion, 'initialize 必须协商 protocolVersion');
    assert.ok(Array.isArray(byId[2].result.tools) && byId[2].result.tools.length > 20, 'tools/list 应列出全部工具');
    assert.ok(byId[3].result !== undefined, 'ping 要有 result');
    assert.strictEqual(byId[4].error.code, -32601, '未知方法要按 JSON-RPC 报错');

    // 绝不能出现 LSP 式的 Content-Length 头
    const raw = srv.messages.map((m) => JSON.stringify(m)).join('\n');
    assert.ok(!/Content-Length/.test(raw));
    srv.child.kill();
  });
});

test('mcp: log_append round-trips every section over the wire', () => {
  const { projectDir, pocketDir } = makePocket('mcp-append');
  const srv = startServer(projectDir);

  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });
  srv.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'context_pocket_log_append',
      arguments: {
        gist: 'mcp wire probe',
        // 每一节都给一条：小节清单从 AMENDABLE_SECTIONS 推，
        // 所以以后加一节忘了在 MCP 入口接线，这里会直接失败而不是静默丢内容
        ...Object.fromEntries(
          Object.entries(require(path.join(ROOT, 'lib', 'writer')).SECTION_FIELDS)
            .map(([field, title]) => [field, `${title} 通过 MCP 写入`])
        ),
        commits: ['cafe123'],
      },
    },
  });

  return srv.waitFor(2).then(() => {
    const res = srv.messages.find((m) => m.id === 2);
    assert.ok(!res.result.isError, 'log_append 不该报错：' + JSON.stringify(res));
    const text = res.result.content.map((c) => c.text).join('\n');
    assert.ok(/T\d+ added/.test(text), text);

    const parser = require(path.join(ROOT, 'lib', 'parser'));
    const block = parser.parseLog(pocketDir).blocks.slice(-1)[0];
    for (const title of Object.values(require(path.join(ROOT, 'lib', 'writer')).SECTION_FIELDS)) {
      assert.ok(block.sections[title] && block.sections[title].length > 0, title + ' 段必须通过 MCP 写入成功');
    }
    srv.child.kill();
  });
});

test('mcp: mcp-smoke.js passes against a fresh pocket', () => {
  const { projectDir } = makePocket('mcp-smoke');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SMOKE, projectDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('mcp-smoke 超时')); }, 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && /ALL PASS/.test(out)) return resolve();
      reject(new Error('mcp-smoke exit=' + code + '\n' + out.slice(-4000)));
    });
  });
});

// ------------------------------------------------------------
// 双入口一致性
//
// CLI 与 MCP 是同一件事的两个壳；lib/fields.js 收拢字段表之前，
// 同一份载荷在两个壳里会写出不同的 T-block（MCP 的 --commits 不拆逗号，
// 而 amend 在 MCP 里根本没有 commits）。这类差异不会报错，只会静默改变
// 已归档的内容形状，所以直接用"两边写出字节相同的块"来锁。
// ------------------------------------------------------------

const PARITY_TURN = {
  gist: 'parity probe',
  tags: ['alpha', 'beta'],
  user: '用户的原话：把两个入口的字段表合成一份',
  action: '改了 lib/query.js 的搜索回退',
  commits: 'abc1234,def5678',
  decisions: '只用零依赖实现',
  pitfalls: '嵌套量词正则在长行上指数回溯',
  preferences: '解释要完整，不要摘要',
  conflicts: '与 R2 的口径不一致',
  attachments: 'diagram.png',
  uncertain: '要不要保留旧的 splitCsv 签名',
};

const SECTION_FLAGS = ['tags', 'user', 'action', 'commits', 'decisions', 'pitfalls', 'preferences', 'conflicts', 'attachments', 'uncertain'];

function cliAppend(pocketDir, turn) {
  const args = ['log', 'append', '--dir', pocketDir, '--no-index', '--gist', turn.gist];
  for (const key of SECTION_FLAGS) {
    if (turn[key] === undefined) continue;
    args.push('--' + key, String(turn[key]));
  }
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });
}

function mcpCall(projectDir, name, args, waitCount) {
  const srv = startServer(projectDir);
  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });
  srv.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  return srv.waitFor(waitCount).then(() => {
    const res = srv.messages.find((m) => m.id === 2);
    srv.child.kill();
    if (!res) throw new Error('MCP 没有回包：' + name);
    const text = res.result && res.result.content ? res.result.content.map((c) => c.text).join('\n') : JSON.stringify(res);
    if (!res.result || res.result.isError) throw new Error('MCP 调用失败：' + text);
    return text;
  });
}

/** 只看内容形状：id 与写入时刻本来就该不同 */
function lastBlockView(pocketDir) {
  const parser = require(path.join(ROOT, 'lib', 'parser'));
  const block = parser.parseLog(pocketDir).blocks.slice(-1)[0];
  return { gist: block.gist, tags: block.tags, sections: block.sections };
}

test('mcp: append writes the same T-block through the CLI and the MCP shell', () => {
  const viaCli = makePocket('parity-append-cli');
  const viaMcp = makePocket('parity-append-mcp');

  cliAppend(viaCli.pocketDir, Object.assign({}, PARITY_TURN, { tags: PARITY_TURN.tags.join(',') }));
  return mcpCall(viaMcp.projectDir, 'context_pocket_log_append', PARITY_TURN, 2).then(() => {
    const a = lastBlockView(viaCli.pocketDir);
    const b = lastBlockView(viaMcp.pocketDir);
    assert.deepStrictEqual(b, a, '两个入口对同一载荷必须写出相同的块');
    assert.deepStrictEqual(a.sections.Commits, ['abc1234', 'def5678'], 'commits 是逗号列表，两边都要拆开');
    assert.deepStrictEqual(a.tags, ['alpha', 'beta']);
    // 文本段里的逗号不能被拆开（否则一句话会被切成两条 pitfall）
    assert.strictEqual(a.sections.Pitfalls.length, 1);
  });
});

test('mcp: amend fills the same sections through the CLI and the MCP shell', () => {
  const viaCli = makePocket('parity-amend-cli');
  const viaMcp = makePocket('parity-amend-mcp');
  const sparse = { gist: 'parity amend probe', user: '只给了 gist 和用户原话' };

  cliAppend(viaCli.pocketDir, sparse);
  const parser = require(path.join(ROOT, 'lib', 'parser'));
  const cliTId = () => parser.parseLog(viaCli.pocketDir).blocks.slice(-1)[0].id;

  return mcpCall(viaMcp.projectDir, 'context_pocket_log_append', sparse, 2).then(() => {
    const mcpTId = () => parser.parseLog(viaMcp.pocketDir).blocks.slice(-1)[0].id;
    assert.strictEqual(mcpTId(), cliTId(), '同一个模板下两边的 T 编号应一致');
    const tId = cliTId();
    execFileSync(process.execPath, [
      CLI, 'log', 'amend', String(tId),
      '--dir', viaCli.pocketDir, '--no-index',
      '--commits', 'cafe1234,beef5678',
      '--action', '补齐了 Commits 与 Action',
    ], { encoding: 'utf-8' });
    return mcpCall(viaMcp.projectDir, 'context_pocket_log_amend', {
      tId,
      commits: 'cafe1234,beef5678',
      action: '补齐了 Commits 与 Action',
    }, 2);
  }).then(() => {
    assert.deepStrictEqual(lastBlockView(viaMcp.pocketDir), lastBlockView(viaCli.pocketDir));
    assert.deepStrictEqual(
      lastBlockView(viaCli.pocketDir).sections.Commits,
      ['cafe1234', 'beef5678'],
      'MCP 的 amend 也必须支持 commits 段'
    );
  });
});

// ------------------------------------------------------------
// search 分页
//
// MCP 的调用方是 agent：它看不到"还有更多"就会以为这就是全部历史，
// 于是把截断当成事实来推理。所以 total / showing / more 必须出现在文本里，
// 而且切片的序列必须与 CLI（同一份 searchAny）一致。
// ------------------------------------------------------------

const hitIds = (text) => (text.match(/\*\*T(\d+)\*\*/g) || []).map((s) => parseInt(s.replace(/\D/g, ''), 10));

test('mcp: search reports the true total and pages in the same order', () => {
  const { projectDir, pocketDir } = makePocket('mcp-search-page');
  for (let i = 1; i <= 5; i++) {
    cliAppend(pocketDir, { gist: 'mcp paging turn ' + i, user: 'u' });
  }

  const page1 = (text) => {
    assert.ok(/5 matches found · showing 1–2/.test(text), '首屏要报出全量 total 与本页区间：\n' + text);
    assert.deepStrictEqual(hitIds(text), [5, 4], '同分时按新到旧返回 2 条');
    assert.ok(/3 more — next page: \{"offset": 2\}/.test(text), '截断必须可见：\n' + text);
  };

  return mcpCall(projectDir, 'context_pocket_search', { keyword: 'paging', limit: 2 }, 2)
    .then((text) => {
      page1(text);
      return mcpCall(projectDir, 'context_pocket_search', { keyword: 'paging', limit: 2, offset: 2 }, 2);
    })
    .then((text) => {
      assert.ok(/showing 3–4/.test(text), text);
      assert.ok(/1 more — next page: \{"offset": 4\}/.test(text), text);
      return mcpCall(projectDir, 'context_pocket_search', { keyword: 'paging', limit: 0 }, 2);
    })
    .then((text) => {
      assert.ok(/^5 matches found$/m.test(text), '--limit 0 应给出全部且不再报区间：\n' + text);
      assert.strictEqual(hitIds(text).length, 5);
      assert.ok(!/more — next page/.test(text), '已给全时不该再提示翻页');
      return mcpCall(projectDir, 'context_pocket_search', { keyword: 'paging', limit: 2, offset: 1, noIndex: true }, 2);
    })
    .then((text) => {
      // 扫描路径切的是同一个序列：换 --no-index 不会翻出另一批结果
      assert.ok(/showing 2–3/.test(text), text);
      assert.deepStrictEqual(hitIds(text), [4, 3], '两条路径的顺序必须一致');
    });
});

test('mcp: migrate list over the wire shows the registry, and a bad target is a tool error', () => {
  const { projectDir } = makePocket('mcp-migrate');

  return mcpCall(projectDir, 'context_pocket_migrate', { list: true }, 2).then((text) => {
    assert.ok(/\*\*Latest registered:\*\* v2/.test(text), '要把登记表里的最新版本报出来：\n' + text);
    assert.ok(/\*\*Registered steps:\*\*/.test(text), text);
    assert.ok(/v1 → v1:/.test(text), '内置那条自检跳必须可见：\n' + text);
    assert.ok(/v1 → v2:/.test(text), '真的那一跳也要列出来，否则用户不知道有升级可用：\n' + text);
    assert.ok(/up to date/.test(text), text);

    return mcpCall(projectDir, 'context_pocket_migrate', { dryRun: true }, 2);
  }).then((text) => {
    assert.ok(/Migration skipped/.test(text), '已经是 v2 的项目上不带 --to 就是空跑：\n' + text);
    assert.ok(/Already at v2/.test(text), text);

    return mcpCall(projectDir, 'context_pocket_migrate', { to: 'banana', list: true }, 2)
      .then(() => { throw new Error('坏目标版本本该是 isError'); })
      .catch((e) => {
        assert.ok(/Invalid target version "banana"/.test(e.message), e.message);
      });
  });
});

test('mcp: a v1 pocket upgrades over the wire, and the new time lines come back out of recall', () => {
  const { projectDir, pocketDir } = makeV1Pocket('mcp-when');

  return mcpCall(projectDir, 'context_pocket_migrate', { to: 'v2' }, 2).then((text) => {
    assert.ok(/v1 → v2/.test(text), text);
    assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v2');
    assert.strictEqual(readPocketFile(pocketDir, 'log.md').split('\n').filter((l) => /^--- WHEN: /.test(l)).length, 3,
      '升级要在 MCP 这条路上真的改到文件');

    // 迁移只给到"天"；Agent 之后可以用同一个工具补上更准的时间，且只有这一次机会
    return mcpCall(projectDir, 'context_pocket_log_amend', { tId: 1, when: '2026-05-01 09:00 → 11:30' }, 2);
  }).then((text) => {
    assert.ok(/⏱/.test(text), 'amend 要把时间上的处理结果说回来：\n' + text);
    assert.ok(/2026-05-01 09:00 → 2026-05-01 11:30/.test(text), text);

    return mcpCall(projectDir, 'context_pocket_recall', { tId: 1 }, 2);
  }).then((text) => {
    assert.ok(/When: 2026-05-01 09:00 → 2026-05-01 11:30/.test(text), 'recall 要显示区间：\n' + text);
    assert.ok(/Commits|Action/.test(text), '回归防线：describeWhen 漏 require 会把整个 recall 炸成 isError');

    // 已经记下的时间是历史，第二次 amend 必须拒绝，而不是安静地改掉
    return mcpCall(projectDir, 'context_pocket_log_amend', { tId: 1, when: '2026-05-01 23:00' }, 2);
  }).then((text) => {
    assert.ok(/amend 不覆盖历史/.test(text), text);
    assert.ok(!/23:00/.test(readPocketFile(pocketDir, 'log.md')), '拒绝就等于真的不改：\n' + readPocketFile(pocketDir, 'log.md'));
  });
});

test('mcp: a v1 pocket refuses an append time and says what to run', () => {
  const { projectDir, pocketDir } = makeV1Pocket('mcp-when-v1');

  return mcpCall(projectDir, 'context_pocket_log_append', {
    gist: '在 v1 里给了时间',
    user: '用户原话',
    action: '改了 lib/when.js',
    when: '2026-05-01 09:00 → 11:30',
  }, 2).then((text) => {
    assert.ok(/⚠️/.test(text), 'Agent 给的 when 没落盘，必须回话：\n' + text);
    assert.ok(/v1 格式/.test(text) && /migrate/.test(text), text);
    assert.ok(!/⏱/.test(text), '⏱ 只说真的记下的时间：\n' + text);
    assert.ok(!/^--- WHEN: /m.test(readPocketFile(pocketDir, 'log.md')),
      'v1 的内容不能超出它自己声明的格式版本');
  });
});

test('mcp: every CLI command has exactly one tool of the same name', () => {
  // docs/COMPATIBILITY.md 承诺"CLI 子命令与 MCP 工具一一对应，工具名 = 子命令名加前缀"。
  // 这句话以前只是文档；现在由 help --json（命令的唯一来源）对着 tools/list 核一遍。
  const help = JSON.parse(execFileSync(process.execPath, [CLI, 'help', '--json'], { encoding: 'utf-8' }).trim());
  const cliNames = help.groups
    .reduce((acc, g) => acc.concat(g.commands.map((c) => c.command)), [])
    .map((c) => c.replace(/<[^>]*>/g, '').trim().replace(/[- ]/g, '_'))
    .sort();

  const { projectDir } = makePocket('mcp-tool-parity');
  const srv = startServer(projectDir);
  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });
  srv.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  return srv.waitFor(2).then(() => {
    srv.child.kill();
    const tools = srv.messages.find((m) => m.id === 2);
    assert.ok(tools && tools.result, 'tools/list 没有回包');
    const PREFIX = 'context_pocket_';
    const toolNames = tools.result.tools.map((t) => t.name);
    assert.ok(toolNames.every((n) => n.startsWith(PREFIX)), '有工具名不带前缀：' + toolNames.filter((n) => !n.startsWith(PREFIX)).join(', '));
    const stripped = toolNames.map((n) => n.slice(PREFIX.length)).sort();
    assert.deepStrictEqual(stripped, cliNames,
      'MCP 工具与 CLI 命令必须一一对应。只在一边有的：' +
      stripped.filter((n) => !cliNames.includes(n)).concat(cliNames.filter((n) => !stripped.includes(n))).join(', '));
  });
});

test('mcp: the write-time conflict gate comes back in the tool text', () => {
  const { projectDir, pocketDir } = makePocket('mcp-gate');
  // 前面的轮次和那条决定用 CLI 铺：本测试要钉的是 MCP 这一层的回话，不是准备步骤。
  // decision add 盖的是 `latestT + 1`（也就是"紧接着要记的那一轮"），所以顺序是
  // T1 → 决定（认领 T2）→ T2 记下这个决定 → 从 T3 起才算"撞在决定之后"。
  execFileSync(process.execPath, [CLI, 'log', 'append', '--gist', '第一轮', '--user', 'u',
    '--action', 'a', '--json', '--dir', pocketDir], { encoding: 'utf-8' });
  execFileSync(process.execPath, [CLI, 'decision', 'add', '--title', 'use react for the frontend',
    '--context', '选型', '--options', 'react / vue', '--decision', 'react',
    '--consequences', '生态统一', '--json', '--dir', pocketDir], { encoding: 'utf-8' });
  execFileSync(process.execPath, [CLI, 'log', 'append', '--gist', '定了前端框架', '--user', 'u',
    '--action', 'a', '--json', '--dir', pocketDir], { encoding: 'utf-8' });

  const srv = startServer(projectDir);
  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });
  srv.send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: {
      name: 'context_pocket_log_append',
      arguments: { gist: '首页改用 vue', user: 'u', action: 'a', author: 'agent-via-mcp' },
    },
  });
  srv.send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: {
      name: 'context_pocket_log_append',
      arguments: { gist: '又一次改用 vue', user: 'u', action: 'a', conflictCheck: false },
    },
  });

  return srv.waitFor(3).then(() => {
    const res = srv.messages.find((m) => m.id === 2);
    const text = res.result.content.map((c) => c.text).join('\n');
    assert.ok(!res.result.isError, text);
    assert.ok(/⚔️/.test(text), 'Agent 必须在工具回话里看见冲突：\n' + text);
    assert.ok(/ADR-1/.test(text), JSON.stringify(text));
    assert.ok(/### Author\n- agent-via-mcp\n/.test(readPocketFile(pocketDir, 'log.md')),
      'author 要真的落成 Author 节');

    const off = srv.messages.find((m) => m.id === 3);
    const offText = off.result.content.map((c) => c.text).join('\n');
    assert.ok(!/⚔️/.test(offText), 'conflictCheck:false 就是别检查、也别写：\n' + offText);
    const lastBlock = readPocketFile(pocketDir, 'log.md').split('## T').slice(-1)[0];
    assert.ok(!/\[auto\]/.test(lastBlock), JSON.stringify(lastBlock));
    srv.child.kill();
  });
});

test('mcp: context_pocket_repair gives the plan first, then does the renumbering', () => {
  const { projectDir, pocketDir } = makePocket('mcp-repair');
  const writer = require(path.join(ROOT, 'lib', 'writer'));
  for (const gist of ['第一轮', '第二轮', '第三轮', '第四轮']) {
    writer.appendLogBlock(pocketDir, {
      gist,
      tags: ['测试'],
      user: ['用户：' + gist],
      action: ['改了 ' + gist + '.js'],
      conflictCheck: false,
    });
  }
  // 对岸的副本也算出 T3 写了第四轮：合并后 log.md 里有两个 ## T3
  writePocketFile(pocketDir, 'log.md',
    readPocketFile(pocketDir, 'log.md').replace(/^## T4 · /gm, '## T3 · '));

  const srv = startServer(projectDir);
  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });
  srv.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context_pocket_repair', arguments: { dryRun: true } } });

  // 两次调用必须分开等：dry-run 的"没写盘"只能在第二次调用之前验，
  // 等两个回包都到了再读文件，看到的已经是改完的 log.md。
  return srv.waitFor(2).then(() => {
    const plan = srv.messages.find((m) => m.id === 2);
    assert.ok(!plan.result.isError, JSON.stringify(plan));
    const planText = plan.result.content.map((c) => c.text).join('\n');
    assert.match(planText, /Repair plan \(dry-run\)/, planText);
    assert.match(planText, /T3 → T4/, planText);
    assert.match(planText, /dry-run: no files were modified/, planText);
    assert.match(readPocketFile(pocketDir, 'log.md'), /## T3 · 第四轮/, 'dry-run 之后历史里还是两个 T3');

    srv.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context_pocket_repair', arguments: { author: 'agent-merge' } } });
    return srv.waitFor(3);
  }).then(() => {
    const done = srv.messages.find((m) => m.id === 3);
    assert.ok(!done.result.isError, JSON.stringify(done));
    const doneText = done.result.content.map((c) => c.text).join('\n');
    assert.match(doneText, /Repair completed/, doneText);
    assert.match(doneText, /T3 → T4/, doneText);
    assert.match(doneText, /Record block: T5/, doneText);

    const parser = require(path.join(ROOT, 'lib', 'parser'));
    assert.deepStrictEqual(parser.parseLog(pocketDir).blocks.map((b) => b.id), [1, 2, 3, 4, 5]);
    assert.match(readPocketFile(pocketDir, 'log.md'), /### Author\n- agent-merge/,
      '署名要能穿过 MCP 这条入口落到记录块里');
    assert.strictEqual(require(path.join(ROOT, 'lib', 'validator')).verify(pocketDir).errorCount, 0);
    srv.child.kill();
  });
});

test('mcp: context_pocket_bootstrap noHub leaves the user hub untouched, default still registers', async () => {
  // 与 CLI 同规则：注册是可选项。常驻的 MCP 进程常常被脚本/CI 唤起来跑一次 bootstrap，
  // 那一次就该在家目录里留不下任何东西。
  const key = (dir) => path.resolve(dir).replace(/\\/g, '/');
  const hubFile = path.join(process.env.CONTEXTPOCKET_HOME, 'hub.json');
  const hubKeys = () => {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(hubFile, 'utf-8')).projects || {});
    } catch (e) {
      return [];
    }
  };

  const skipped = tmpProject('mcp-nohub');
  const outSkip = await mcpCall(skipped, 'context_pocket_bootstrap', { noHub: true }, 2);
  assert.ok(fs.existsSync(path.join(skipped, 'ContextPocket', 'log.md')), 'pocket 照样要建出来：' + outSkip);
  assert.match(outSkip, /\*\*Hub:\*\* skipped \(noHub\)/, outSkip);
  assert.ok(hubKeys().indexOf(key(skipped)) < 0, 'noHub 之后 hub.json 不该有这一条：' + JSON.stringify(hubKeys()));

  const registered = tmpProject('mcp-hub-default');
  const outDefault = await mcpCall(registered, 'context_pocket_bootstrap', {}, 2);
  assert.match(outDefault, /\*\*Hub:\*\* registered/, outDefault);
  assert.ok(hubKeys().indexOf(key(registered)) >= 0, '默认行为不能被改坏：' + JSON.stringify(hubKeys()));

  // 幂等分支也要说：文档让用户"去掉 noHub 再跑一次补登记"，不说就等于没做
  const outSkipAgain = await mcpCall(skipped, 'context_pocket_bootstrap', { noHub: true }, 2);
  assert.match(outSkipAgain, /already exists/, outSkipAgain);
  assert.match(outSkipAgain, /\*\*Hub:\*\* skipped \(noHub\)/, outSkipAgain);
  assert.ok(hubKeys().indexOf(key(skipped)) < 0, '第二次 noHub 照样不写：' + JSON.stringify(hubKeys()));

  const outRegAgain = await mcpCall(registered, 'context_pocket_bootstrap', {}, 2);
  assert.match(outRegAgain, /already exists/, outRegAgain);
  assert.match(outRegAgain, /\*\*Hub:\*\* registered/, outRegAgain);
});

test('mcp: verify names its drift window the way the CLI does (driftLastN), lastN still honoured', async () => {
  // CLI 是 `verify --drift --drift-last-n <N>`；MCP 从前只有 lastN，而 lastN 在
  // context_pocket_sync 里指的是另一件事（同步看几轮）。同一个名字在两个工具里
  // 表示两个窗口，Agent 就会拿错参数。新名对齐，旧名继续认。
  const { projectDir } = makePocket('mcp-driftn');
  const srv = startServer(projectDir);
  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });
  srv.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await srv.waitFor(2);
  const byId = {};
  for (const m of srv.messages) if (m.id !== undefined) byId[m.id] = m;
  const verifyTool = byId[2].result.tools.find((t) => t.name === 'context_pocket_verify');
  assert.ok(verifyTool.inputSchema.properties.driftLastN, 'verify 的 schema 里要有 driftLastN');
  assert.ok(verifyTool.inputSchema.properties.lastN, '旧名 lastN 不能直接摘掉：已存在的调用方要还能跑');
  srv.child.kill();

  const withNew = await mcpCall(projectDir, 'context_pocket_verify', { drift: true, driftLastN: 1 }, 2);
  assert.match(withNew, /Verify/, withNew);
  const withOld = await mcpCall(projectDir, 'context_pocket_verify', { drift: true, lastN: 1 }, 2);
  assert.match(withOld, /Verify/, withOld);
});

// ============================================================
// 参数管道：把没在过线跑过的工具一个个真调用一遍
//
// 此前 tests/mcp.js 只在 `context_pocket_log_append` / `log_amend` / `recall` /
// `search` / `sync` / `verify` / `migrate` / `repair` / `bootstrap` 上真发过
// tools/call，其余 18 个只被"名字对不对得上 CLI 命令"那条断言核对过。名字对上
// 不等于参数对上：schema 写的 `filePath`、handler 读的 `args.file` 这类漂法，
// 只有真发一次调用才会露出来（这一族的 T 号漂移就是这么抓到的）。
// ============================================================

/** 一个进程里连发多个 tools/call：服务端串行处理，回包按 id 取 */
function mcpBatch(projectDir, calls) {
  const srv = startServer(projectDir);
  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });
  calls.forEach((c, i) => {
    srv.send({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: c.name, arguments: c.args || {} } });
  });
  return srv.waitFor(calls.length + 1).then(() => {
    const out = {};
    for (const c of calls.map((x, i) => ({ key: x.name, id: i + 2 }))) {
      const res = srv.messages.find((m) => m.id === c.id);
      if (!res) throw new Error('没有回包：' + c.key);
      if (!res.result || res.result.isError) {
        throw new Error(c.key + ' 调用失败：' + JSON.stringify(res));
      }
      out[c.key] = res.result.content.map((x) => x.text).join('\n');
    }
    srv.child.kill();
    return out;
  });
}

test('mcp: every writing tool lands its arguments in the markdown', () => {
  const { projectDir, pocketDir } = makePocket('mcp-pipe-write');

  return mcpBatch(projectDir, [
    { name: 'context_pocket_state_update', args: {
      summary: '状态管道实测', nextStep: '把 MCP 用例补齐', pitfall: '裸 flag 会把 true 写进记录' } },
    { name: 'context_pocket_preferences_update', args: { key: '回复语言', value: '中文，逐条讲透' } },
    { name: 'context_pocket_decision_add', args: {
      title: '判据只留一份',
      context: '两个入口各写一遍参数解析',
      options: 'A 各自实现 / B 共享 lib',
      decision: 'B',
      consequences: '漂一次全查一遍' } },
    { name: 'context_pocket_req_add', args: {
      text: 'MCP 侧参数管道要有过线用例',
      status: '进行中',
      tags: 'mcp,tests',
      impl: 'tests/mcp.js',
      uncertain: '要不要连 isError 形状一起断' } },
    { name: 'context_pocket_absolute_add', args: { text: '不许手改 log.md 的历史块', gist: '红线', tId: 1 } },
    { name: 'context_pocket_hub', args: { action: 'pref', key: '默认语言', value: 'zh-CN' } },
  ]).then((text) => {
    const state = readPocketFile(pocketDir, 'state.md');
    assert.match(state, /状态管道实测/);
    assert.match(state, /把 MCP 用例补齐/);
    assert.match(state, /裸 flag 会把 true 写进记录/);

    const prefs = readPocketFile(pocketDir, 'preferences.md');
    assert.match(prefs, /回复语言/);
    assert.match(prefs, /中文，逐条讲透/);

    const decisions = readPocketFile(pocketDir, 'decisions.md');
    assert.match(decisions, /判据只留一份/);
    for (const needle of ['两个入口各写一遍参数解析', 'A 各自实现 / B 共享 lib', '漂一次全查一遍']) {
      assert.ok(decisions.includes(needle), 'decision_add 的 ' + needle + ' 没落盘：\n' + decisions);
    }

    const reqs = readPocketFile(pocketDir, 'requirements.md');
    assert.match(reqs, /MCP 侧参数管道要有过线用例/);
    assert.match(reqs, /## 进行中/, 'status 是分组标题，两边都得写成同一个样子');
    assert.match(reqs, /tests\/mcp\.js/);

    const absolute = readPocketFile(pocketDir, 'absolute.md');
    assert.match(absolute, /## 🔒 T1 ·/, 'tId=1 要盖在 T1 上，不是默认的 latest T');
    assert.match(absolute, /不许手改 log\.md 的历史块/);

    // hub 写在用户级 HOME 里（harness 已把它重定向到临时目录）
    const hubFile = path.join(process.env.CONTEXTPOCKET_HOME, 'hub.json');
    assert.ok(fs.existsSync(hubFile), 'hub.json 该在 CONTEXTPOCKET_HOME 下：' + hubFile);
    const hub = JSON.parse(fs.readFileSync(hubFile, 'utf-8'));
    assert.strictEqual(hub.prefs['默认语言'], 'zh-CN', JSON.stringify(hub.prefs));

    // 回话不能是空壳：Agent 只读这段文本判断成功
    assert.match(text['context_pocket_state_update'].concat(text['context_pocket_hub']), /\S/);
  });
});

test('mcp: maintenance tools do over the wire what they claim — and dry runs touch nothing', () => {
  const { projectDir, pocketDir } = makePocket('mcp-pipe-maintain');
  for (let i = 1; i <= 3; i++) {
    cliAppend(pocketDir, {
      gist: '维护管道第 ' + i + ' 轮', user: '把归档与索引这条路走通',
      action: '改了 app.js — 第 ' + i + ' 轮', tags: 'x',
    });
  }
  const indexFile = path.join(pocketDir, 'assets', 'search-index.json');
  if (fs.existsSync(indexFile)) fs.unlinkSync(indexFile);

  const session = path.join(tmpProject('mcp-pipe-session'), 'sess.jsonl');
  fs.writeFileSync(session, JSON.stringify({
    type: 'user', timestamp: '2026-09-01T08:00:00.000Z', message: { role: 'user', content: '导入这条会不会写盘' },
  }) + '\n' + JSON.stringify({
    type: 'assistant', timestamp: '2026-09-01T08:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: '不会，这是 dry-run' }] },
  }) + '\n', 'utf-8');

  const logBefore = readPocketFile(pocketDir, 'log.md');

  return mcpBatch(projectDir, [
    { name: 'context_pocket_index', args: { rebuild: true } },
    { name: 'context_pocket_import', args: { file: session, dryRun: true } },
    { name: 'context_pocket_distill', args: { dryRun: true } },
  ]).then((t) => {
    assert.ok(fs.existsSync(indexFile), 'index --rebuild 必须真的把缓存建出来');
    assert.match(t['context_pocket_index'], /\S/);

    // dry-run 的两次必须在这里验：后面 archive 真会改 log.md，那时就分不清是谁动的
    assert.strictEqual(logBefore.split('\n').filter((l) => /^## T/.test(l)).length, 3, '前置条件：三轮');
    assert.strictEqual(readPocketFile(pocketDir, 'log.md').split('\n').filter((l) => /^## T/.test(l)).length, 3,
      'import dryRun 不该追加轮次');
    assert.ok(!/导入这条会不会写盘/.test(readPocketFile(pocketDir, 'log.md')), 'dryRun 的会话内容不该进 log');
    const digests = fs.readdirSync(pocketDir).filter((f) => /^digest-.*\.md$/.test(f));
    assert.deepStrictEqual(digests, [], 'distill --dry-run 不该落报告文件');

    // archive 是真会动文件的那一个：保留 1 轮，前两轮进归档
    return mcpCall(projectDir, 'context_pocket_archive', { keepLast: 1 }, 2);
  }).then((archiveText) => {
    assert.match(archiveText, /\S/);
    const kept = readPocketFile(pocketDir, 'log.md').split('\n').filter((l) => /^## T/.test(l));
    assert.strictEqual(kept.length, 1, 'keepLast=1 之后 log.md 只该留一轮：\n' + kept.join('\n'));
    const archivedText = readPocketFile(pocketDir, 'log-archive.md');
    assert.match(archivedText, /## T1 ·/);
    assert.match(archivedText, /## T2 ·/);
  });
});

test('mcp: reading tools and the hook pair answer over the wire with real content', () => {
  const { projectDir, pocketDir } = makePocket('mcp-pipe-read');
  cliAppend(pocketDir, {
    gist: '第一轮读侧管道', user: '把 why 与 handoff 走通', action: '改了 app.js — 读侧',
    tags: 'x',
  });
  cliAppend(pocketDir, {
    gist: '第二轮读侧管道', user: 'diff 要比出差异', action: '改了 lib/query.js — 读侧',
    tags: 'y',
  });

  // install-hook 需要 git 仓库；没有 .git 时它必须老实报错而不是崩
  return mcpBatch(projectDir, [
    { name: 'context_pocket_status' },
    { name: 'context_pocket_diff', args: { tA: 1, tB: 2 } },
    { name: 'context_pocket_why', args: { filePath: 'app.js' } },
    { name: 'context_pocket_check_conflicts' },
    { name: 'context_pocket_handoff' },
    { name: 'context_pocket_code_map_update' },
  ]).then((t) => {
    assert.match(t['context_pocket_status'], /\S/);
    assert.match(t['context_pocket_diff'], /T1/);
    assert.match(t['context_pocket_diff'], /T2/);
    assert.match(t['context_pocket_why'], /app\.js/, 'why 的参数名是 filePath（schema 写的就是这个）');
    assert.match(t['context_pocket_check_conflicts'], /\S/);
    assert.match(t['context_pocket_handoff'], /\S/);
    const codeMap = readPocketFile(pocketDir, 'code-map.md');
    assert.match(codeMap, /app\.js/, 'code_map_update 要真的重新扫描目录');

    // 钩子这一对需要真 git 仓库：另开一个临时项目就地 init
    const gitProj = tmpProject('mcp-pipe-hook');
    execFileSync('git', ['init', '-q', gitProj], { stdio: ['ignore', 'pipe', 'pipe'] });
    fs.mkdirSync(path.join(gitProj, 'app'), { recursive: true });
    fs.writeFileSync(path.join(gitProj, 'app', 'main.js'), '// hook target\n', 'utf-8');
    const hookPath = path.join(gitProj, '.git', 'hooks', 'pre-commit');

    return mcpCall(gitProj, 'context_pocket_bootstrap', { noHub: true }, 2)
      .then(() => mcpCall(gitProj, 'context_pocket_install_hook', {}, 2))
      .then((installed) => {
        assert.match(installed, /\S/);
        assert.ok(fs.existsSync(hookPath), 'install_hook 之后 .git/hooks/pre-commit 必须存在');
        const body = fs.readFileSync(hookPath, 'utf-8');
        assert.match(body, /context-pocket install-hook/, '托管标记要在文件里，否则下次升级认不出自己写的块');
        return mcpCall(gitProj, 'context_pocket_uninstall_hook', {}, 2);
      })
      .then((uninstalled) => {
        assert.match(uninstalled, /\S/);
        const after = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf-8') : '';
        assert.ok(!/context-pocket install-hook/.test(after), '卸载后托管块不该留在文件里：\n' + after);
      });
  });
});

test('mcp: initialize reports the same version the CLI prints', () => {
  // 两个入口读同一处（lib/version.js → package.json）。以前兜底值硬写在 mcp-server.js 的
  // IIFE 里、CLI 压根没有版本可报，所以这条断言是双向的：回包的号必须等于 package.json，
  // 也必须等于 `context-pocket --version`。升级版本号漏改一处，这里就会红。
  const { projectDir } = makePocket('mcp-version');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const srv = startServer(projectDir);

  srv.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } });

  return srv.waitFor(1).then(() => {
    const byId = {};
    for (const m of srv.messages) if (m.id !== undefined) byId[m.id] = m;
    assert.strictEqual(byId[1].result.serverInfo.version, pkg.version,
      'initialize 回包的 serverInfo.version 必须来自 package.json');

    const cli = execFileSync(process.execPath, [CLI, '--version', '--json'], { encoding: 'utf-8' });
    assert.strictEqual(JSON.parse(cli.trim()).version, byId[1].result.serverInfo.version,
      'CLI 与 MCP 报了两个版本号：某一处没走 lib/version.js');
    srv.child.kill();
  });
});
