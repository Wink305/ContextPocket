'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const {
  assert,
  test,
  makeLitePocket,
  runCli,
  runCliJson,
  runMcp,
  ROOT,
  MAIN_ROOT,
} = require('./harness');

const liteConstants = require(path.join(ROOT, 'lib', 'constants'));
const mainConstants = require(path.join(MAIN_ROOT, 'lib', 'constants'));
const liteBin = path.join(ROOT, 'bin', 'context-pocket-lite.js');
const mainBin = path.join(MAIN_ROOT, 'bin', 'context-pocket.js');
const mainMcp = path.join(MAIN_ROOT, 'mcp-server.js');
const liteQuery = require(path.join(ROOT, 'lib', 'query'));
const mainQuery = require(path.join(MAIN_ROOT, 'lib', 'query'));

function countCommands(bin, cwd) {
  const result = spawnSync(process.execPath, [bin, 'help', '--json'], { cwd, env: process.env, encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, `help failed for ${bin}: ${result.stderr}`);
  const help = JSON.parse(result.stdout);
  return help.groups.reduce((sum, group) => sum + group.commands.length, 0);
}

function packStats(cwd) {
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  // --loglevel=notice 必须显式给：`npm test --silent` 会往子进程环境注入
  // npm_config_loglevel=silent，内层 npm pack 继承后 notice 行全部静默，
  // 只剩 stdout 一行文件名，下面的正则必然解析失败。显式 CLI 旗标优先于
  // 环境配置，保证套件无论以何种 loglevel 启动都能量到体积。
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm pack --dry-run --loglevel=notice']
    : ['pack', '--dry-run', '--loglevel=notice'];
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  assert.strictEqual(result.status, 0, `npm pack --dry-run failed in ${cwd}: ${output}`);
  const files = /npm notice total files:\s*(\d+)/i.exec(output);
  const size = /npm notice package size:\s*([\d.]+)\s*kB/i.exec(output);
  assert.ok(files, `could not parse "npm notice total files" from npm output:\n${output}`);
  assert.ok(size, `could not parse "npm notice package size" from npm output:\n${output}`);
  return { files: Number(files[1]), sizeKb: Number(size[1]) };
}

function cachedModuleCount(binPath) {
  // 只统计这个包自己的模块。IDE / 运行时可能往 require.cache 里注入 shim
  // （fs 代理、ipc 客户端之类），那些不是本包的重量，算进来会让绝对基线在
  // 本地与 CI 之间漂：同一条锁在 ubuntu runner 上是 17，在注入 shim 的
  // 编辑器里是 21。过滤到项目目录后，两边数的是同一批文件。
  const projectRoot = path.resolve(path.dirname(binPath), '..') + path.sep;
  const script = `require(${JSON.stringify(binPath)});
const root = ${JSON.stringify(projectRoot)};
console.log(Object.keys(require.cache).filter(k => k.startsWith(root)).length);`;
  const result = spawnSync(process.execPath, ['-e', script], { env: process.env, encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, `module-count probe failed for ${binPath}: ${result.stderr}`);
  return Number(result.stdout.trim());
}

function bestStatusMs(bin, cwd) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [bin, 'status'], { cwd, env: process.env, encoding: 'utf8', timeout: 15000 });
    const elapsed = performance.now() - start;
    if (result.error) throw result.error;
    assert.strictEqual(result.status, 0, `status cold-start failed for ${bin}: ${result.stderr}`);
    samples.push(elapsed);
  }
  return Math.min(...samples);
}

function medianExactIdMs(search, pocketDir) {
  search(pocketDir, 'T1');
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    search(pocketDir, 'T1');
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[2];
}

test('Lite metrics stay below the full package and exact T-id search skips unrelated metadata', () => {
  const { projectDir, pocketDir } = makeLitePocket('metrics');
  const liteCoreFiles = liteConstants.LITE_CORE_FILES.length;
  const mainCoreFiles = mainConstants.CORE_FILES.length;
  const liteCommands = countCommands(liteBin, projectDir);
  const mainCommands = countCommands(mainBin, projectDir);
  const liteMcpTools = runMcp(projectDir).tools.length;
  const mainMcpResult = spawnSync(process.execPath, [mainMcp], {
    cwd: projectDir,
    env: process.env,
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '',
    ].join('\n'),
    encoding: 'utf8',
    timeout: 15000,
  });
  if (mainMcpResult.error) throw mainMcpResult.error;
  assert.strictEqual(mainMcpResult.status, 0, `main MCP exited ${mainMcpResult.status}: ${mainMcpResult.stderr}`);
  const mainMcpResponses = mainMcpResult.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.strictEqual(mainMcpResponses.length, 2, `unexpected main MCP output: ${mainMcpResult.stdout}`);
  const mainMcpTools = mainMcpResponses[1].result.tools.length;

  const litePack = packStats(ROOT);
  const mainPack = packStats(MAIN_ROOT);
  const liteModules = cachedModuleCount(liteBin);
  const mainModules = cachedModuleCount(mainBin);
  const liteColdMs = bestStatusMs(liteBin, projectDir);
  const mainColdMs = bestStatusMs(mainBin, projectDir);

  fs.writeFileSync(
    path.join(pocketDir, 'preferences.md'),
    '# Preferences · T1\n' + Array.from({ length: 5000 }, (_, i) => '- preference entry ' + i + ' with descriptive words').join('\n') + '\n',
    'utf8'
  );
  const liteExactIdMs = medianExactIdMs(liteQuery.searchAny, pocketDir);
  const mainExactIdMs = medianExactIdMs((dir, keyword) => mainQuery.searchAny(dir, keyword, { useIndex: false }), pocketDir);

  const measured = [
    ['core files', liteCoreFiles, mainCoreFiles, 5, 10],
    ['CLI commands', liteCommands, mainCommands, 11, 28],
    ['MCP tools', liteMcpTools, mainMcpTools, 11, 28],
    ['package files', litePack.files, mainPack.files, 28, 61],
    ['cold-start module count', liteModules, mainModules, 17, null],
    // 117.7 / 411.8：2.6-Lite-preview / 2.4-preview 定版实测（图扩展上限 + 截断提示
    // + 整图同源回移与回归测试落地后的体积），按「基线随每次定版更新」追平
    ['package size kB', litePack.sizeKb, mainPack.sizeKb, 117.7, 411.8],
  ];
  for (const [label, liteValue, mainValue, expectedLite, expectedMain] of measured) {
    assert.ok(liteValue < mainValue, `${label}: Lite ${liteValue} must be below full ${mainValue}`);
    if (expectedLite !== null) {
      if (label === 'package size kB') {
        // 体积是压缩后的 tarball 大小，README / CHANGELOG / SKILL 这类文本改动就会让它
        // 浮动零点几 kB —— 逐次追基线是白费劲（同一版里连追了三次）。所以容差按
        // 百分比给：1%，且不低于 2 kB。400 kB 的包涨 4 kB（1%）才红，真膨胀挡得住；
        // 写一段文档导致的 1-2 kB 浮动不会。基线随每次定版更新，容差不用动。
        const tol = (expected) => Math.max(2.0, expected * 0.01);
        assert.ok(Math.abs(liteValue - expectedLite) <= tol(expectedLite), `${label}: Lite baseline ${expectedLite} kB drifted to ${liteValue} kB`);
      } else {
        assert.strictEqual(liteValue, expectedLite, `${label}: Lite absolute value drifted`);
      }
    }
    if (expectedMain !== null) {
      if (label === 'package size kB') {
        const tol = (expected) => Math.max(2.0, expected * 0.01);
        assert.ok(Math.abs(mainValue - expectedMain) <= tol(expectedMain), `${label}: full baseline ${expectedMain} kB drifted to ${mainValue} kB`);
      } else {
        assert.strictEqual(mainValue, expectedMain, `${label}: full absolute baseline drifted`);
      }
    }
  }

  assert.ok(liteColdMs < mainColdMs,
    `cold status startup (best-of-5): Lite ${liteColdMs.toFixed(1)} ms must be below full ${mainColdMs.toFixed(1)} ms`);
  // P2 回移后两包的精确 T-id 扫描都只读轮次日志，5000 行偏好不再拖累完整包，
  // 旧「Lite 必须更快」的排序锁失去前提（那是完整包还先解析全部元数据时的对照）。
  // 改锁单向带宽：完整包不得慢过 Lite 的 2×。谁把捷径退回 collectDocs 之后，
  // 5000 行偏好会让完整包慢到 Lite 的 ~6×，当场红；完整包正常比 Lite 快不会误报。
  assert.ok(mainExactIdMs < liteExactIdMs * 2,
    `exact T-id search (median-of-5): full scan ${mainExactIdMs.toFixed(1)} ms must stay below 2x Lite ${liteExactIdMs.toFixed(1)} ms (both skip unrelated metadata)`);
  console.log(`  metrics: modules Lite ${liteModules} / full ${mainModules}; cold status best-of-5 Lite ${liteColdMs.toFixed(1)} ms / full ${mainColdMs.toFixed(1)} ms; exact T-id median Lite ${liteExactIdMs.toFixed(1)} ms / full scan ${mainExactIdMs.toFixed(1)} ms`);
});
