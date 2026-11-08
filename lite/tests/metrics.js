'use strict';

const path = require('path');
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

function countCommands(bin, cwd) {
  const result = spawnSync(process.execPath, [bin, 'help', '--json'], { cwd, env: process.env, encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, `help failed for ${bin}: ${result.stderr}`);
  const help = JSON.parse(result.stdout);
  return help.groups.reduce((sum, group) => sum + group.commands.length, 0);
}

function packStats(cwd) {
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm pack --dry-run']
    : ['pack', '--dry-run'];
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
  const script = `require(${JSON.stringify(binPath)}); console.log(Object.keys(require.cache).length);`;
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

test('six Lite metrics stay below the full package and their absolute baselines remain locked', () => {
  const { projectDir } = makeLitePocket('metrics');
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

  const measured = [
    ['core files', liteCoreFiles, mainCoreFiles, 5, 10],
    ['CLI commands', liteCommands, mainCommands, 8, 28],
    ['MCP tools', liteMcpTools, mainMcpTools, 8, 28],
    ['package files', litePack.files, mainPack.files, 27, 61],
    ['cold-start module count', liteModules, mainModules, 17, null],
    ['package size kB', litePack.sizeKb, mainPack.sizeKb, 96.8, 400.8],
  ];
  for (const [label, liteValue, mainValue, expectedLite, expectedMain] of measured) {
    assert.ok(liteValue < mainValue, `${label}: Lite ${liteValue} must be below full ${mainValue}`);
    if (expectedLite !== null) {
      if (label === 'package size kB') {
        assert.ok(Math.abs(liteValue - expectedLite) <= 0.1, `${label}: Lite baseline ${expectedLite} kB drifted to ${liteValue} kB`);
      } else {
        assert.strictEqual(liteValue, expectedLite, `${label}: Lite absolute value drifted`);
      }
    }
    if (expectedMain !== null) {
      if (label === 'package size kB') {
        assert.ok(Math.abs(mainValue - expectedMain) <= 0.1, `${label}: full baseline ${expectedMain} kB drifted to ${mainValue} kB`);
      } else {
        assert.strictEqual(mainValue, expectedMain, `${label}: full absolute baseline drifted`);
      }
    }
  }

  assert.ok(liteColdMs < mainColdMs,
    `cold status startup (best-of-5): Lite ${liteColdMs.toFixed(1)} ms must be below full ${mainColdMs.toFixed(1)} ms`);
  console.log(`  metrics: modules Lite ${liteModules} / full ${mainModules}; cold status best-of-5 Lite ${liteColdMs.toFixed(1)} ms / full ${mainColdMs.toFixed(1)} ms`);
});
