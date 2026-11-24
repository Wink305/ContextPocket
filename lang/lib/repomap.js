'use strict';

/**
 * ContextPocket yuan — repo map
 *
 * 零依赖的文件级 + 顶层符号扫描，服务 context build 与 workspace 视图。
 * 不写进 pocket Markdown；缓存放在工作区 `.contextpocket/repo-map.json`。
 *
 * 首版语言：JS / JSX / TS / TSX / Python。解析是正则级的，失败只降级为文件条目，
 * 不假装理解语义。
 */

const fs = require('fs');
const path = require('path');

const { readManifest, resolvePocket, CACHE_DIR } = require('./workspace');

const MAP_VERSION = 1;
const MAP_FILE = 'repo-map.json';
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SYMBOLS_PER_FILE = 40;
const DEFAULT_MAX_FILES = 500;

const EXT_LANGUAGE = {
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.ts': 'ts',
  '.tsx': 'ts',
  '.py': 'py',
};

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'ContextPocket', '.contextpocket',
]);

const JS_SYMBOLS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
];

const PY_SYMBOLS = [
  /^\s*(?:async\s+)?def\s+(\w+)/,
  /^\s*class\s+(\w+)/,
];

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function mapPath(root) {
  return path.join(root, CACHE_DIR, MAP_FILE);
}

function languageOf(file) {
  return EXT_LANGUAGE[path.extname(file).toLowerCase()] || null;
}

function extractSymbols(text, language) {
  const patterns = language === 'py' ? PY_SYMBOLS : JS_SYMBOLS;
  const found = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    for (const re of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        found.push(name);
      }
      break;
    }
    if (found.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return found;
}

function shouldIgnoreDir(name) {
  return IGNORE_DIRS.has(name);
}

function scanProject(root, projectRoot, pocketName, budget, options = {}) {
  const cache = options.cache || null;
  const metadataOnly = !!options.metadataOnly;
  const files = [];
  const walk = (dir) => {
    if (budget.files >= budget.maxFiles) {
      budget.truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (budget.files >= budget.maxFiles) {
        budget.truncated = true;
        return;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldIgnoreDir(entry.name)) walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const language = languageOf(entry.name);
      if (!language) continue;
      if (/\.min\.(js|mjs|cjs)$/i.test(entry.name)) continue;
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch (e) {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      const relative = toPosix(path.relative(root, absolute));
      const mtimeMs = Math.round(stat.mtimeMs);
      const cached = cache ? cache.get(relative) : null;
      const reusable = !metadataOnly && cached
        && cached.size === stat.size
        && cached.mtimeMs === mtimeMs
        && cached.language === language
        && Array.isArray(cached.symbols);

      let symbols = [];
      if (reusable) {
        // size + mtime + language 都没变：文件内容不可能变，直接复用旧符号
        symbols = cached.symbols;
        budget.reused += 1;
      } else if (!metadataOnly) {
        try {
          symbols = extractSymbols(fs.readFileSync(absolute, 'utf-8'), language);
        } catch (e) { /* 文件读不了就只留文件条目 */ }
        budget.rescanned += 1;
      }

      files.push({
        path: relative,
        pocket: pocketName,
        language,
        size: stat.size,
        mtimeMs,
        symbols,
      });
      budget.files += 1;
    }
  };
  walk(projectRoot);
  return files;
}

/**
 * @param {string} root
 * @param {object} manifest
 * @param {object} [options]
 * @param {Map<string, object>} [options.cache] 旧 map 的 path → 文件条目
 * @param {boolean} [options.metadataOnly] 只比 size/mtime，不读文件、不解析符号（verify 用）
 */
function scanWorkspace(root, manifest, options = {}) {
  const maxFiles = (manifest.repoMap && manifest.repoMap.maxFiles) || DEFAULT_MAX_FILES;
  const languages = (manifest.repoMap && manifest.repoMap.languages) || null;
  const budget = { files: 0, maxFiles, truncated: false, reused: 0, rescanned: 0 };
  const byPath = new Map();
  for (const entry of manifest.pockets) {
    const resolved = resolvePocket(root, entry);
    if (!resolved.exists) continue;
    const scanned = scanProject(root, resolved.projectRoot, entry.name, budget, options);
    for (const file of scanned) {
      if (languages && !languages.includes(file.language)) continue;
      if (!byPath.has(file.path)) byPath.set(file.path, file);
    }
  }
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    truncated: budget.truncated,
    maxFiles,
    reused: budget.reused,
    rescanned: budget.rescanned,
  };
}

function updateMap(root) {
  const manifest = readManifest(root);
  const previous = readMap(root);
  const cache = new Map();
  if (previous) {
    for (const file of previous.files) {
      if (file && typeof file.path === 'string') cache.set(file.path, file);
    }
  }
  const scanned = scanWorkspace(root, manifest, { cache });
  const data = {
    version: MAP_VERSION,
    generatedAt: new Date().toISOString(),
    root,
    maxFiles: scanned.maxFiles,
    truncated: scanned.truncated,
    files: scanned.files,
  };
  const file = mapPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return {
    ok: true,
    path: file,
    count: data.files.length,
    truncated: data.truncated,
    reused: scanned.reused,
    rescanned: scanned.rescanned,
    map: data,
  };
}

function readMap(root) {
  const file = mapPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || data.version !== MAP_VERSION || !Array.isArray(data.files)) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function summarizeMap(data) {
  const byLanguage = {};
  let symbols = 0;
  for (const file of data.files) {
    byLanguage[file.language] = (byLanguage[file.language] || 0) + 1;
    symbols += file.symbols.length;
  }
  return {
    ok: true,
    path: mapPath(data.root),
    generatedAt: data.generatedAt,
    files: data.files.length,
    symbols,
    byLanguage,
    truncated: !!data.truncated,
  };
}

function viewMap(root, options = {}) {
  let data = readMap(root);
  let rebuilt = false;
  if (!data) {
    data = updateMap(root).map;
    rebuilt = true;
  }
  const summary = summarizeMap(data);
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : 20;
  const rows = data.files.slice(0, limit).map((file) => ({
    path: file.path,
    pocket: file.pocket,
    language: file.language,
    symbols: file.symbols,
  }));
  return Object.assign(summary, { rebuilt, filesShown: rows.length, rows });
}

function verifyMap(root) {
  const cached = readMap(root);
  if (!cached) {
    return { ok: false, missing: true, error: 'repo map cache is missing (run "context-pocket-yuan map update")' };
  }
  const manifest = readManifest(root);
  // 漂移只看路径 / size / mtime，不读文件正文、不重新解析符号
  const scanned = scanWorkspace(root, manifest, { metadataOnly: true }).files;
  const cachedByPath = new Map(cached.files.map((file) => [file.path, file]));
  const scannedByPath = new Map(scanned.map((file) => [file.path, file]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [filePath, file] of scannedByPath) {
    const old = cachedByPath.get(filePath);
    if (!old) added.push(filePath);
    else if (old.size !== file.size || old.mtimeMs !== file.mtimeMs) changed.push(filePath);
  }
  for (const filePath of cachedByPath.keys()) {
    if (!scannedByPath.has(filePath)) removed.push(filePath);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return {
    ok: added.length === 0 && removed.length === 0 && changed.length === 0 && !!cached.truncated === !!scanned.truncated,
    cachedCount: cached.files.length,
    scannedCount: scanned.length,
    cachedTruncated: !!cached.truncated,
    scannedTruncated: !!scanned.truncated,
    added,
    removed,
    changed,
    truncated: scanned.truncated,
  };
}

module.exports = {
  MAP_VERSION,
  MAP_FILE,
  MAX_FILE_BYTES,
  mapPath,
  languageOf,
  extractSymbols,
  scanWorkspace,
  updateMap,
  readMap,
  summarizeMap,
  viewMap,
  verifyMap,
};
