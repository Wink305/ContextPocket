#!/usr/bin/env node
'use strict';

/**
 * ContextPocket release automation
 *
 * 把「发版」从手工拼装收敛成一条固定流水线：
 *
 *   1. preflight  版本 / 包名 / 干净工作树 / tag 冲突 / edition 契约
 *   2. gates      lint → sync-core → tests → smoke → smoke-live（与 CI 完全一致）
 *   3. pack       npm pack（以 package.json 的 files 白名单为准）
 *   4. zip        解包后生成扁平 GitHub Release 资产 <tag>.zip，内含 <tag>/ 目录
 *   5. notes      从 CHANGELOG + edition.json 生成 release notes
 *   6. publish    gh release create <tag> <zip> --notes-file …
 *
 * 默认是 dry run：只打包、生成 zip 与 notes，不创建 Release。
 * 加 --yes 才会真正调用 gh。
 *
 * 用法：
 *   node scripts/release.js <xi|quan|yuan> [options]
 *
 * Options:
 *   --version <v>     发布版本（必须等于 package.json 的 version；默认取包内版本）
 *   --tag <tag>       覆盖默认 tag（默认 ContextPocket-<version>-<edition>）
 *   --out <dir>       产物目录（默认系统临时目录）
 *   --notes <file>    自定义 release notes（默认自动生成）
 *   --yes             真正创建 GitHub Release（默认只 dry run）
 *   --draft           创建 draft release
 *   --prerelease      标记为 pre-release
 *   --target <ref>    gh release create --target（默认当前 HEAD）
 *   --skip-checks     跳过五道发布门禁（仅限已单独跑过门禁时）
 *   --allow-dirty     允许非干净工作树（默认拒绝）
 *
 * 零依赖：zip 由本脚本内置的 deflate + CRC32 写入器生成，不依赖系统 zip。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const EDITIONS = {
  xi: {
    dir: 'lite',
    bin: 'context-pocket-lite.js',
    name: 'xi',
    label: '溪',
    summary: 'lightweight single-pocket edition',
  },
  quan: {
    dir: '.',
    bin: 'context-pocket.js',
    name: 'quan',
    label: '泉',
    summary: 'general-purpose single-pocket edition',
  },
  yuan: {
    dir: 'lang',
    bin: 'context-pocket-yuan.js',
    name: 'yuan',
    label: '渊',
    summary: 'workspace edition',
  },
};

const GATES = [
  ['npm', ['run', 'lint']],
  ['node', ['scripts/sync-core.js']],
  ['node', ['tests/run.js']],
  ['npm', ['run', 'smoke']],
  ['npm', ['run', 'smoke-live']],
];

// ============================================================
// 小工具
// ============================================================

function die(message) {
  process.stderr.write('release: ' + message + '\n');
  process.exit(1);
}

function log(message) {
  process.stdout.write(message + '\n');
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function quoteArg(value) {
  const text = String(value);
  if (process.platform !== 'win32') return text;
  if (!/[\s"&|<>^]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function run(command, args, options = {}) {
  const printable = [command].concat(args).join(' ');
  log('  $ ' + printable);

  let actual = command;
  let actualArgs = args;
  // Windows 不能直接 execFile 一个 .cmd（EINVAL）；显式走 cmd /c，并给带空格的参数加引号
  if (process.platform === 'win32' && /^npm(\.cmd)?$/.test(command)) {
    actual = process.env.ComSpec || 'cmd.exe';
    actualArgs = ['/d', '/s', '/c', ['npm.cmd'].concat(args.map(quoteArg)).join(' ')];
  }

  return execFileSync(actual, actualArgs, {
    cwd: options.cwd || ROOT,
    encoding: 'utf-8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function parseArgs(argv) {
  const result = { edition: null, flags: {} };
  const valueFlags = new Set(['version', 'tag', 'out', 'notes', 'target']);
  const booleanFlags = new Set(['yes', 'draft', 'prerelease', 'skip-checks', 'allow-dirty', 'help']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      if (!result.edition) result.edition = token;
      else die('unexpected argument: ' + token);
      continue;
    }
    const name = token.replace(/^-+/, '');
    const eq = name.indexOf('=');
    if (eq >= 0) {
      result.flags[name.slice(0, eq)] = name.slice(eq + 1);
      continue;
    }
    if (booleanFlags.has(name)) {
      result.flags[name] = true;
      continue;
    }
    if (valueFlags.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) die('--' + name + ' needs a value');
      result.flags[name] = next;
      i += 1;
      continue;
    }
    die('unknown option: --' + name);
  }
  return result;
}

function usage() {
  const text = fs.readFileSync(__filename, 'utf-8');
  const start = text.indexOf(' * 用法：');
  const end = text.indexOf(' */', start);
  const body = text.slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^ \* ?/, ''))
    .join('\n');
  log(body);
}

function editionFor(key) {
  const edition = EDITIONS[key];
  if (!edition) {
    die('edition must be one of ' + Object.keys(EDITIONS).join(', ') + ' (got ' + key + ')');
  }
  return edition;
}

function buildTag(version, edition, override) {
  if (override) return override;
  return 'ContextPocket-' + version + '-' + edition.name;
}

function git(args, optional) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (optional) return null;
    die('git ' + args.join(' ') + ' failed: ' + String(e.stderr || e.message).trim());
  }
}

// ============================================================
// ZIP 写入（store / deflate，零依赖）
// ============================================================

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value >>> 0, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function walkFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(absolute, base, out);
    else if (entry.isFile()) out.push({ absolute, relative: path.relative(base, absolute).replace(/\\/g, '/') });
  }
  return out;
}

/**
 * 把目录写成 zip。文件头使用 UTF-8 标志，跨平台解压不会乱码。
 * @param {string} sourceDir
 * @param {string} zipPath
 * @param {string} [prefix] zip 内的顶层目录名（GitHub 资产习惯带一个根目录）
 */
function createZip(sourceDir, zipPath, prefix) {
  const entries = [];
  const chunks = [];
  let offset = 0;

  for (const file of walkFiles(sourceDir)) {
    const data = fs.readFileSync(file.absolute);
    const stat = fs.statSync(file.absolute);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const relative = prefix ? prefix + '/' + file.relative : file.relative;
    const name = Buffer.from(relative, 'utf-8');
    const { date, time } = dosDateTime(stat.mtime);

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(time), u16(date),
      u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0),
      name,
    ]);
    chunks.push(local, body);
    entries.push({
      name,
      crc,
      size: data.length,
      compressed: body.length,
      method,
      time,
      date,
      offset,
    });
    offset += local.length + body.length;
  }

  const centralStart = offset;
  for (const entry of entries) {
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(entry.method),
      u16(entry.time), u16(entry.date), u32(entry.crc), u32(entry.compressed),
      u32(entry.size), u16(entry.name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(entry.offset), entry.name,
    ]);
    chunks.push(central);
    offset += central.length;
  }

  const centralSize = offset - centralStart;
  chunks.push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralSize), u32(centralStart), u16(0),
  ]));

  fs.writeFileSync(zipPath, Buffer.concat(chunks));
  return { path: zipPath, files: entries.length, bytes: fs.statSync(zipPath).size };
}

// ============================================================
// preflight / pack / notes
// ============================================================

function preflight(context) {
  const { edition, pkg, editionJson, version, tag, flags } = context;

  if (!fs.existsSync(path.join(context.packageDir, 'edition.json'))) {
    die(edition.dir + '/edition.json is missing');
  }
  if (editionJson.package !== pkg.name) {
    die('edition.json package (' + editionJson.package + ') does not match package.json name (' + pkg.name + ')');
  }
  if (editionJson.family !== pkg.version) {
    die('edition.json family (' + editionJson.family + ') does not match package.json version (' + pkg.version + ')');
  }
  if (editionJson.status !== 'stable') {
    die('edition ' + edition.name + ' is not stable (status: ' + editionJson.status + ') — freeze the API first');
  }
  if (String(pkg.version) !== version) {
    die('package.json version is ' + pkg.version + ', but --version is ' + version);
  }
  if (editionJson.edition !== edition.name) {
    die('edition.json edition (' + editionJson.edition + ') does not match ' + edition.name);
  }
  if (!pkg.bin || !pkg.bin[pkg.name]) {
    die('package.json must expose "' + pkg.name + '" in bin');
  }

  const dirty = git(['status', '--porcelain'], true);
  if (dirty) {
    if (!flags['allow-dirty']) {
      die('working tree is not clean:\n' + dirty + '\ncommit or stash first, or pass --allow-dirty');
    }
    log('  ! working tree is dirty (allowed by --allow-dirty)');
  }

  const existing = git(['rev-parse', '-q', '--verify', 'refs/tags/' + tag], true);
  if (existing) {
    if (flags.yes) die('tag ' + tag + ' already exists at ' + existing + ' — pick another --tag or delete it first');
    log('  ! tag ' + tag + ' already exists; a real release would refuse');
  }

  context.head = git(['rev-parse', 'HEAD']);
}

function runGates() {
  log('\n[2/6] release gates (same five as CI)');
  for (const [command, args] of GATES) {
    const bin = command === 'npm' ? npmBin() : process.execPath;
    run(bin, args, { inherit: true });
  }
}

function extractTarball(tarball, destination) {
  fs.mkdirSync(destination, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', destination]);
  const packageDir = path.join(destination, 'package');
  if (!fs.existsSync(packageDir)) die('npm pack tarball did not contain a package/ directory');
  return packageDir;
}

function verifyPacked(packageDir, pkg, edition, editionJson) {
  const required = ['package.json', 'edition.json', 'README.md'];
  for (const relative of Object.values(pkg.bin || {})) required.push(relative);
  if (fs.existsSync(path.join(ROOT, edition.dir, 'SKILL.md'))) required.push('SKILL.md');
  for (const file of required) {
    if (!fs.existsSync(path.join(packageDir, file))) {
      die('packed tarball is missing ' + file + ' — check package.json files whitelist');
    }
  }
  if (editionJson.commands !== editionJson.tools) {
    die('edition.json commands and tools must match for a stable release');
  }
}

function changelogSection(version) {
  const file = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf-8');

  // 未发布段优先：转正 / hotfix 的改动通常先落在这里
  const unreleased = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|$(?![\s\S]))/m.exec(text);
  if (unreleased && unreleased[1].trim()) return unreleased[1].trim();

  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('^## \\[' + escaped + '\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|$(?![\\s\\S]))', 'm').exec(text);
  if (!match) return '';
  return match[1].trim();
}

function buildNotes(context) {
  const { edition, editionJson, pkg, version, tag, display, zipPath } = context;
  const changelog = changelogSection(pkg.version);
  const lines = [
    '## ContextPocket ' + display + ' (' + edition.label + ')',
    '',
    pkg.description || edition.summary,
    '',
    '- Edition: `' + edition.name + '` · commands: ' + editionJson.commands
      + ' · MCP tools: ' + editionJson.tools,
    '- Data format: `' + editionJson.dataFormat + '` — the same `ContextPocket/` folder as the other editions',
    '- Package: `' + pkg.name + '` · no runtime dependencies',
    '',
    '### Download',
    '',
    '`' + path.basename(zipPath) + '` — unzip it and run the CLI from the extracted folder:',
    '',
    '```bash',
    'node ' + tag + '/bin/' + edition.bin + ' --help',
    '```',
    '',
    'Or link it locally with `npm link` inside the extracted folder.',
    '',
    'This project has never been published to the npm registry.',
  ];
  if (changelog) {
    lines.push('', '### Changes', '', changelog);
  }
  lines.push('', 'Full history: [CHANGELOG.md](https://github.com/Wink305/ContextPocket/blob/main/CHANGELOG.md).');
  return lines.join('\n') + '\n';
}

function publish(context) {
  const args = [
    'release', 'create', context.tag, context.zipPath,
    '--title', 'ContextPocket ' + context.display,
    '--notes-file', context.notesPath,
    '--target', context.flags.target || context.head,
  ];
  if (context.flags.draft) args.push('--draft');
  if (context.flags.prerelease) args.push('--prerelease');

  log('\n[6/6] creating GitHub Release');
  const output = run('gh', args);
  log(output.trim());
  log('\n  ✅ release published: ' + context.tag);
}

// ============================================================
// main
// ============================================================

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || !args.edition) {
    usage();
    process.exit(args.flags.help ? 0 : 2);
  }

  const edition = editionFor(args.edition);
  const packageDir = path.resolve(ROOT, edition.dir);
  const pkgPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(pkgPath)) die('missing ' + pkgPath);
  const pkg = readJson(pkgPath);
  const editionJson = readJson(path.join(packageDir, 'edition.json'));

  const version = String(args.flags.version || pkg.version);
  const tag = buildTag(version, edition, args.flags.tag);
  const display = version + '-' + edition.name;

  const outRoot = args.flags.out
    ? path.resolve(args.flags.out)
    : path.join(os.tmpdir(), 'contextpocket-release-' + tag);
  const zipPath = path.join(outRoot, tag + '.zip');
  const notesPath = args.flags.notes
    ? path.resolve(args.flags.notes)
    : path.join(outRoot, tag + '-notes.md');

  const context = {
    edition,
    editionJson,
    pkg,
    version,
    tag,
    display,
    packageDir,
    outRoot,
    zipPath,
    notesPath,
    flags: args.flags,
  };

  log('ContextPocket release · ' + display);
  log('  package: ' + pkg.name + ' · tag: ' + tag);

  log('\n[1/6] preflight');
  preflight(context);

  if (args.flags['skip-checks']) {
    log('\n[2/6] release gates skipped (--skip-checks)');
  } else {
    runGates();
  }

  log('\n[3/6] npm pack');
  fs.mkdirSync(outRoot, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-pack-'));
  const packJson = run(npmBin(), [
    'pack', packageDir, '--pack-destination', stage, '--json', '--ignore-scripts',
  ]);
  let packed;
  try {
    const start = packJson.indexOf('[');
    const end = packJson.lastIndexOf(']');
    packed = JSON.parse(packJson.slice(start, end + 1))[0];
  } catch (e) {
    die('could not parse npm pack --json output:\n' + packJson);
  }
  const tarball = path.join(stage, packed.filename);
  if (!fs.existsSync(tarball)) die('npm pack did not create ' + tarball);
  log('  ' + packed.filename + ' · ' + packed.files.length + ' file(s) · ' + packed.size + ' bytes');

  log('\n[4/6] unpack + zip');
  const unpacked = extractTarball(tarball, path.join(stage, 'unpacked'));
  verifyPacked(unpacked, pkg, edition, editionJson);
  const artifactDir = path.join(stage, 'artifact', tag);
  fs.mkdirSync(path.dirname(artifactDir), { recursive: true });
  fs.renameSync(unpacked, artifactDir);
  const zip = createZip(artifactDir, zipPath, tag);
  log('  ' + zip.path + ' · ' + zip.files + ' file(s) · ' + zip.bytes + ' bytes');

  log('\n[5/6] release notes');
  if (!args.flags.notes) fs.writeFileSync(notesPath, buildNotes(context), 'utf-8');
  log('  ' + notesPath);

  if (!args.flags.yes) {
    log('\n[6/6] dry run — no GitHub Release created');
    log('  re-run with --yes to publish, or upload manually:');
    log('  gh release create ' + tag + ' "' + zipPath + '" --title "ContextPocket ' + display
      + '" --notes-file "' + notesPath + '"');
  } else {
    publish(context);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    die(e.message);
  }
}

module.exports = {
  EDITIONS,
  buildTag,
  createZip,
  crc32,
  parseArgs,
};
