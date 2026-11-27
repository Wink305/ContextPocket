'use strict';

/**
 * 3.0 家族一致性锁：
 *   - shared/ 是跨版本核心的唯一真值，lib/ 与 lite/lib/ 必须逐字一致
 *   - 四个版本的包名 / 版本线 / 可安装状态必须与规划一致
 * 漂开时只报红，不自动改文件；修复用 `node scripts/sync-core.js --write`。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assert, test, ROOT } = require('./harness');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'manifest.json'), 'utf8'));

test('shared core: every edition carries a byte-identical copy', () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 5,
    'shared/manifest.json 的 files 太少，像是清单失效');
  assert.ok(Array.isArray(manifest.targets) && manifest.targets.length >= 2,
    'shared/manifest.json 必须覆盖 quan 与 xi 两个目标');

  const targetsFor = (file) => (manifest.targetsByFile && manifest.targetsByFile[file]) || manifest.targets;
  for (const file of manifest.files) {
    const targets = targetsFor(file);
    assert.ok(Array.isArray(targets) && targets.length > 0, 'shared/' + file + ' 没有同步目标');
    for (const target of targets) {
      const canonical = path.join(ROOT, 'shared', file);
      const copy = path.join(ROOT, target, file);
      assert.ok(fs.existsSync(canonical), 'shared/' + file + ' 缺失');
      assert.ok(fs.existsSync(copy), target + '/' + file + ' 缺失');
      assert.ok(fs.readFileSync(canonical).equals(fs.readFileSync(copy)),
        target + '/' + file + ' 与 shared/' + file + ' 漂开；跑 node scripts/sync-core.js --write');
    }
  }

  for (const file of Object.keys(manifest.targetsByFile || {})) {
    assert.ok(manifest.files.includes(file), 'targetsByFile 里的 ' + file + ' 不在 files 清单里');
  }
});

test('shared core: pure links and budget stay free of cache and edition modules', () => {
  const linksCore = fs.readFileSync(path.join(ROOT, 'shared', 'links-core.js'), 'utf8');
  for (const banned of ["require('./query')", "require('./core')", "require('./constants')", 'writeAtomic']) {
    assert.ok(!linksCore.includes(banned), 'links-core 不能依赖 ' + banned + '：纯派生层必须可被 yuan 直接复用');
  }
  const budget = fs.readFileSync(path.join(ROOT, 'shared', 'budget.js'), 'utf8');
  assert.ok(!/require\(/.test(budget), 'budget 必须是零依赖纯函数');
  const files = fs.readFileSync(path.join(ROOT, 'shared', 'files.js'), 'utf8');
  assert.ok(!/require\(/.test(files), 'files 必须是零依赖纯函数');
  const rank = fs.readFileSync(path.join(ROOT, 'shared', 'rank.js'), 'utf8');
  assert.ok(!/require\(/.test(rank), 'rank 必须是零依赖纯函数，quan / yuan 才能共用同一份公式');
  const runtime = fs.readFileSync(path.join(ROOT, 'shared', 'mcp-runtime.js'), 'utf8');
  assert.ok(!/require\(/.test(runtime), 'mcp-runtime 必须只依赖 Node 内建能力，保持零 require');
});

test('shared core: the sync script stays wired to the same manifest', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-core.js'), 'utf8');
  assert.ok(script.includes("path.join(ROOT, 'shared')"), 'sync-core.js 必须从 shared/ 读真值');
  assert.ok(script.includes("--write"), 'sync-core.js 必须提供 --write 修复路径');
  assert.ok(script.includes('manifest.targets'), 'sync-core.js 必须按 manifest 同步，不能写死版本目录');
});

test('3.2 family: package names, version lines and installability are declared', () => {
  const editions = [
    ['package.json', 'context-pocket-quan', 'stable'],
    ['lite/package.json', 'context-pocket-xi', 'stable'],
    ['lang/package.json', 'context-pocket-yuan', 'stable'],
    ['hai/package.json', 'context-pocket-hai', 'planned'],
  ];

  for (const [rel, name, state] of editions) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.strictEqual(pkg.name, name, rel + ' 的包名必须是 ' + name);
    assert.strictEqual(pkg.version, '3.2', rel + ' 必须跟 3.2 家族版本线');
    if (state === 'stable') {
      assert.ok(pkg.bin && pkg.bin[name], rel + ' 必须暴露 ' + name + ' 命令');
      assert.ok(Object.keys(pkg.bin).length >= 2, rel + ' 必须同时暴露 CLI 与 MCP 入口');
    } else if (state === 'preview') {
      assert.strictEqual(pkg.private, true, rel + ' 在发布前必须标记 private');
      assert.ok(pkg.bin && pkg.bin[name], rel + ' 预览版也要暴露 ' + name + ' 命令');
      assert.ok(pkg.bin[name + '-mcp'], rel + ' 预览版也要暴露 MCP 入口');
    } else {
      assert.strictEqual(pkg.private, true, rel + ' 在发布前必须标记 private');
      assert.ok(!pkg.bin, rel + ' 还没有可安装命令，不能声明 bin');
    }
  }

  // 三个可运行版本的 version --json 必须报同一个 edition 字段
  const bins = [
    ['bin/context-pocket.js', 'quan'],
    ['lite/bin/context-pocket-lite.js', 'xi'],
    ['lang/bin/context-pocket-yuan.js', 'yuan'],
  ];
  for (const [bin, edition] of bins) {
    const info = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, bin), 'version', '--json'], {
      encoding: 'utf8', env: process.env,
    }));
    assert.strictEqual(info.edition, edition, bin + ' 的 version --json 必须带 edition=' + edition);
    assert.strictEqual(info.display, '3.2-' + edition, bin + ' 的展示版本漂开');
  }
});

test('edition manifests match the commands, files and modes each package ships', () => {
  const constants = require(path.join(ROOT, 'lib', 'constants'));
  const liteConstants = require(path.join(ROOT, 'lite', 'lib', 'constants'));
  const mainVersion = require(path.join(ROOT, 'lib', 'version'));
  const liteVersion = require(path.join(ROOT, 'lite', 'lib', 'version'));
  const langVersion = require(path.join(ROOT, 'lang', 'lib', 'version'));

  assert.strictEqual(mainVersion.EDITION, 'quan');
  assert.strictEqual(liteVersion.EDITION, 'xi');
  assert.strictEqual(langVersion.EDITION, 'yuan');

  const stable = [
    ['edition.json', 'package.json', 'bin/context-pocket.js', 'quan', constants.CORE_FILES.length, 29],
    ['lite/edition.json', 'lite/package.json', 'lite/bin/context-pocket-lite.js', 'xi', liteConstants.LITE_CORE_FILES.length, 11],
    // yuan 复用 shared/ 核心，没有自己的一套 constants 清单；coreFiles 传 null 表示跳过该断言
    ['lang/edition.json', 'lang/package.json', 'lang/bin/context-pocket-yuan.js', 'yuan', null, 10],
  ];

  for (const [editionRel, pkgRel, binRel, name, coreFiles, commands] of stable) {
    const edition = JSON.parse(fs.readFileSync(path.join(ROOT, editionRel), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, pkgRel), 'utf8'));
    assert.strictEqual(edition.edition, name, editionRel + ' 的 edition 必须是 ' + name);
    assert.strictEqual(edition.package, pkg.name, editionRel + ' 与 ' + pkgRel + ' 的包名漂开');
    assert.strictEqual(edition.family, pkg.version, editionRel + ' 与 ' + pkgRel + ' 的版本线漂开');
    assert.strictEqual(edition.status, 'stable', editionRel + ' 应是 stable');
    assert.strictEqual(edition.dataFormat, 'v2', editionRel + ' 必须声明数据格式 v2');
    if (coreFiles !== null) {
      assert.strictEqual(edition.coreFiles, coreFiles, editionRel + ' 的 coreFiles 与 constants 不一致');
    }
    assert.strictEqual(edition.commands, commands, editionRel + ' 的 commands 与契约不一致');
    assert.strictEqual(edition.tools, edition.commands, editionRel + ' 的 tools 必须与 commands 对齐');
    assert.ok(Array.isArray(edition.modes) && edition.modes.length > 0, editionRel + ' 必须声明版本内模式');
    assert.strictEqual(edition.plannedCommands, undefined,
      editionRel + ' 转 stable 后不能再保留 plannedCommands（API 已冻结）');
    assert.strictEqual(edition.plannedTools, undefined,
      editionRel + ' 转 stable 后不能再保留 plannedTools（API 已冻结）');

    const bin = path.join(ROOT, binRel);
    const help = JSON.parse(execFileSync(process.execPath, [bin, 'help', '--json'], {
      encoding: 'utf8', env: process.env,
    }));
    const count = help.groups.reduce((sum, group) => sum + group.commands.length, 0);
    assert.strictEqual(edition.commands, count, editionRel + ' 的 commands 与 help --json 实际数量漂开');
  }

  const planned = [
    ['hai/edition.json', 'hai/package.json', 'hai', 45],
  ];
  for (const [editionRel, pkgRel, name, plannedCommands] of planned) {
    const edition = JSON.parse(fs.readFileSync(path.join(ROOT, editionRel), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, pkgRel), 'utf8'));
    assert.strictEqual(edition.edition, name, editionRel + ' 的 edition 必须是 ' + name);
    assert.strictEqual(edition.package, pkg.name, editionRel + ' 与 ' + pkgRel + ' 的包名漂开');
    assert.strictEqual(edition.status, 'planned', editionRel + ' 应是 planned');
    assert.strictEqual(edition.plannedCommands, plannedCommands, editionRel + ' 的目标命令数漂开');
    assert.strictEqual(edition.plannedTools, plannedCommands, editionRel + ' 的目标工具数必须与命令对齐');
    assert.ok(Array.isArray(edition.modes) && edition.modes.length > 0, editionRel + ' 必须声明规划模式');
  }
});
