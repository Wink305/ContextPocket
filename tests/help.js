'use strict';

/**
 * 帮助文本单源测试
 *
 * lib/help.js 是帮助文本的唯一来源（CLI 各命令 --help、主帮助页、MCP 工具描述、
 * initialize instructions）。这里钉着"各入口输出 === 单源内容"：
 * 谁在 bin/mcp-server 里重新内联一段文本、或改了单源忘了它会被两个入口一起用，
 * 这里直接红。
 */

const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { assert, test, makePocket, ROOT } = require('./harness');

const {
  HELP_GROUPS, HELP_OPTIONS, COMMAND_HELP, commandHelp, SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS,
} = require(path.join(ROOT, 'lib', 'help'));

const CLI = path.join(ROOT, 'bin', 'context-pocket.js');
const SERVER = path.join(ROOT, 'mcp-server.js');

const norm = (s) => String(s).replace(/\r\n/g, '\n');

function runHelp(argv) {
  return execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 启动 MCP 子进程，收 newline-delimited JSON-RPC，返回 initialize 与 tools/list 的回包 */
function mcpRoundtrip() {
  return new Promise((resolve, reject) => {
    const { projectDir } = makePocket('help-mcp');
    const child = spawn(process.execPath, [SERVER], { cwd: projectDir, stdio: ['pipe', 'pipe', 'ignore'] });
    const results = {};
    let buffer = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) results.init = msg.result;
        if (msg.id === 2) results.toolsList = msg.result;
        if (results.init && results.toolsList) {
          child.kill();
          resolve(results);
          return;
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    setTimeout(() => { child.kill(); reject(new Error('mcp timeout')); }, 15000);
  });
}

test('help: every command --help prints exactly the single-source text', () => {
  const keys = Object.keys(COMMAND_HELP);
  assert.ok(keys.length >= 25, 'COMMAND_HELP 至少应覆盖全部命令，实际 ' + keys.length);
  for (const key of keys) {
    const entry = COMMAND_HELP[key];
    const out = norm(runHelp([...entry.argv, '--help']));
    assert.strictEqual(out, norm(entry.text) + '\n', key + ' 的 --help 输出与 lib/help.js 不一致');
  }
});

test('help: commandHelp() is the accessor the CLI prints from', () => {
  for (const key of Object.keys(COMMAND_HELP)) {
    assert.strictEqual(commandHelp(key), COMMAND_HELP[key].text);
  }
  assert.throws(() => commandHelp('no-such-command'), /unknown command/);
});

test('help: main help page lists exactly the commands that have detailed help', () => {
  const listed = HELP_GROUPS.flatMap((g) => g.commands.map((c) => c[0].replace(/ <.*>/g, '')));
  assert.deepStrictEqual(
    [...listed].sort(),
    Object.keys(COMMAND_HELP).sort(),
    'help 主帮助页的命令清单与 COMMAND_HELP 脱节'
  );
});

test('help: help --json renders the same table as the human page', () => {
  const out = norm(runHelp(['help', '--json'])).trim();
  const data = JSON.parse(out);
  assert.deepStrictEqual(
    data.groups.map((g) => ({ group: g.group, commands: g.commands.map((c) => [c.command, c.summary]) })),
    HELP_GROUPS.map((g) => ({ group: g.group, commands: g.commands.map((c) => [c[0], c[1]]) }))
  );
  assert.deepStrictEqual(
    data.options.map((o) => [o.option, o.summary]),
    HELP_OPTIONS.map((o) => [o[0], o[1]])
  );
});

test('help: human help page shows every command and option line', () => {
  const out = norm(runHelp(['help']));
  for (const g of HELP_GROUPS) {
    for (const [name] of g.commands) {
      assert.ok(out.includes('    ' + name), '人类帮助页缺命令 ' + name);
    }
  }
  for (const [name] of HELP_OPTIONS) {
    assert.ok(out.includes('    ' + name), '人类帮助页缺选项 ' + name);
  }
});

test('help: MCP tools/list descriptions are the single-source strings', async () => {
  const { toolsList } = await mcpRoundtrip();
  const tools = toolsList.tools;
  assert.ok(tools.length >= 25, 'tools/list 工具数 ' + tools.length);

  const wire = new Set(tools.map((t) => t.name));
  const src = new Set(Object.keys(TOOL_DESCRIPTIONS));
  for (const name of wire) assert.ok(src.has(name), '工具 ' + name + ' 在 lib/help.js 里没有描述');
  for (const name of src) assert.ok(wire.has(name), 'lib/help.js 里的 ' + name + ' 不在 tools/list 上');

  for (const tool of tools) {
    assert.strictEqual(tool.description, TOOL_DESCRIPTIONS[tool.name], tool.name + ' 的描述与 lib/help.js 不一致');
  }
});

test('help: MCP initialize instructions are the single-source string', async () => {
  const { init } = await mcpRoundtrip();
  assert.strictEqual(init.instructions, SERVER_INSTRUCTIONS);
});
