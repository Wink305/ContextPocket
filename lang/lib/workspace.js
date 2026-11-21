'use strict';

/**
 * ContextPocket yuan — workspace 多口袋
 *
 * 工作区清单是 `contextpocket.workspace.json`，放在工作区根，可提交到 git。
 * 清单只存相对路径与策略；口袋本身仍是标准 `ContextPocket/` + format v2。
 *
 * 跨口袋引用必须限定口袋名：`api:T12`。裸 T 号只在单口袋命令里有效。
 */

const fs = require('fs');
const path = require('path');

const { parseAll, parseLogAll, parseLogText, mergeLogs } = require('./parser');
const { stripPlaceholders, readFileSafe } = require('./core');

const MANIFEST_FILE = 'contextpocket.workspace.json';
const MANIFEST_VERSION = 1;
const CACHE_DIR = '.contextpocket';

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function manifestPath(root) {
  return path.join(root, MANIFEST_FILE);
}

/**
 * yuan 侧统一的口袋解析入口：log 部分把 log-archive.md 合进来。
 *
 * quan 的 parseAll 只读 log.md（当前日志才是 index/verify 的判定对象），
 * 但工作区命令承诺"归档≠丢失"——forget 之后 recall / search / recap 仍要读得到。
 */
function parsePocketAll(pocketDir) {
  const data = parseAll(pocketDir);
  data.log = mergeLogs(data.log, parseLogText(readFileSafe(path.join(pocketDir, 'log-archive.md'))));
  return data;
}

function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, MANIFEST_FILE))) return current;
    current = path.dirname(current);
  }
  if (fs.existsSync(path.join(root, MANIFEST_FILE))) return root;
  return null;
}

function readManifest(root) {
  const file = manifestPath(root);
  if (!fs.existsSync(file)) {
    throw new Error('No ' + MANIFEST_FILE + ' at ' + root + ' (run "context-pocket-yuan workspace init")');
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error('Invalid ' + MANIFEST_FILE + ': ' + e.message);
  }
  if (!data || data.version !== MANIFEST_VERSION || !Array.isArray(data.pockets)) {
    throw new Error('Unsupported workspace manifest (expected version ' + MANIFEST_VERSION + ')');
  }
  return data;
}

function writeManifest(root, data) {
  const file = manifestPath(root);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return file;
}

function initWorkspace(root, options = {}) {
  const dir = path.resolve(root);
  if (fs.existsSync(manifestPath(dir))) {
    throw new Error('Workspace already exists at ' + dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  const data = {
    version: MANIFEST_VERSION,
    name: options.name || path.basename(dir),
    pockets: [],
    context: { defaultMaxTokens: 6000, includeRepoMap: true },
    repoMap: { languages: ['js', 'jsx', 'ts', 'tsx', 'py'], maxFiles: 500 },
    index: { mode: 'scan' },
  };
  const file = writeManifest(dir, data);
  return { root: dir, file, manifest: data };
}

/** 接受项目根、ContextPocket/ 目录或任意指向 pocket 的路径，返回相对 pocket 路径。 */
function normalizePocket(root, input) {
  const absolute = path.resolve(root, input);
  const candidates = [
    path.join(absolute, 'ContextPocket'),
    absolute,
  ];
  let pocketDir = null;
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'log.md'))) {
      pocketDir = candidate;
      break;
    }
  }
  if (!pocketDir) {
    throw new Error('No ContextPocket/ (log.md) found at ' + absolute);
  }
  const relative = toPosix(path.relative(root, pocketDir));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Pocket must live inside the workspace root: ' + pocketDir);
  }
  return {
    pocketDir,
    projectRoot: path.dirname(pocketDir),
    relative,
    name: path.basename(path.dirname(pocketDir)),
  };
}

function addPocket(root, name, input) {
  const manifest = readManifest(root);
  const normalized = normalizePocket(root, input);
  const pocketName = String(name || normalized.name).trim();
  if (!pocketName) throw new Error('Pocket name is required');
  if (manifest.pockets.some((p) => p.name === pocketName)) {
    throw new Error('Pocket name already exists: ' + pocketName);
  }
  if (manifest.pockets.some((p) => p.path === normalized.relative)) {
    throw new Error('Pocket already registered: ' + normalized.relative);
  }
  manifest.pockets.push({ name: pocketName, path: normalized.relative });
  manifest.pockets.sort((a, b) => a.name.localeCompare(b.name));
  writeManifest(root, manifest);
  return { root, name: pocketName, path: normalized.relative, pocketDir: normalized.pocketDir, manifest };
}

function removePocket(root, name) {
  const manifest = readManifest(root);
  const before = manifest.pockets.length;
  manifest.pockets = manifest.pockets.filter((p) => p.name !== name);
  if (manifest.pockets.length === before) {
    throw new Error('Pocket not found: ' + name);
  }
  writeManifest(root, manifest);
  return { root, removed: name, manifest };
}

function resolvePocket(root, entry) {
  const pocketDir = path.resolve(root, entry.path);
  return {
    name: entry.name,
    path: entry.path,
    pocketDir,
    projectRoot: path.dirname(pocketDir),
    exists: fs.existsSync(path.join(pocketDir, 'log.md')),
  };
}

function listPockets(root) {
  const manifest = readManifest(root);
  return {
    manifest,
    pockets: manifest.pockets.map((entry) => {
      const resolved = resolvePocket(root, entry);
      if (!resolved.exists) {
        return Object.assign(resolved, { ok: false, error: 'missing ContextPocket/log.md' });
      }
      try {
        const log = parseLogAll(resolved.pocketDir);
        return Object.assign(resolved, { ok: true, latestT: log.latestT, blocks: log.blocks.length });
      } catch (e) {
        return Object.assign(resolved, { ok: false, error: e.message });
      }
    }),
  };
}

function statusWorkspace(root) {
  const manifest = readManifest(root);
  const pockets = manifest.pockets.map((entry) => {
    const resolved = resolvePocket(root, entry);
    if (!resolved.exists) {
      return Object.assign(resolved, { ok: false, error: 'missing ContextPocket/log.md' });
    }
    try {
      const data = parsePocketAll(resolved.pocketDir);
      const uncertain = [];
      for (const block of data.log.blocks) {
        for (const item of block.sections.Uncertain || []) {
          uncertain.push({ tId: block.id, text: String(item).replace(/^❓\s*/, '') });
        }
      }
      return Object.assign(resolved, {
        ok: true,
        latestT: data.log.latestT,
        blocks: data.log.blocks.length,
        openRequirements: data.requirements.openCount,
        openRequirementTexts: data.requirements.items
          .filter((item) => item.status === 'Open')
          .map((item) => ({ id: 'R' + item.id, text: item.text, uncertain: item.uncertain })),
        adrs: data.decisions.adrs.length,
        adrTitles: data.decisions.adrs.map((adr) => ({ id: 'ADR-' + adr.id, title: adr.title })),
        absolute: data.absolute.entries.map((entry) => ({ tId: entry.tId, gist: entry.gist, content: entry.content })),
        uncertain,
        stateSummary: stripPlaceholders(data.state.summary),
        nextSteps: stripPlaceholders(data.state.nextSteps),
        pitfalls: stripPlaceholders(data.state.pitfalls),
        recent: data.log.blocks.slice(-3).reverse().map((block) => ({ id: block.id, gist: block.gist })),
      });
    } catch (e) {
      return Object.assign(resolved, { ok: false, error: e.message });
    }
  });
  return { root, name: manifest.name, manifest, pockets };
}

function flattenBlockText(block) {
  const parts = [block.gist || '', (block.tags || []).join(' ')];
  for (const [section, value] of Object.entries(block.sections || {})) {
    parts.push(section);
    if (Array.isArray(value)) parts.push(value.join(' '));
    else if (value) parts.push(String(value));
  }
  return parts.join('\n');
}

function searchWorkspace(root, keyword, options = {}) {
  const query = String(keyword || '').trim();
  if (!query) throw new Error('keyword is required');
  const needle = query.toLowerCase();
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : 20;
  const manifest = readManifest(root);
  const results = [];
  let total = 0;

  const split = (value) => (value === undefined || value === null || value === '')
    ? null
    : new Set(String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  const pocketFilter = split(options.pockets);
  const typeFilter = split(options.types);

  for (const entry of manifest.pockets) {
    if (pocketFilter && !pocketFilter.has(entry.name.toLowerCase())) continue;
    const resolved = resolvePocket(root, entry);
    if (!resolved.exists) continue;
    let data;
    try {
      data = parsePocketAll(resolved.pocketDir);
    } catch (e) {
      continue;
    }

    const push = (row) => {
      if (typeFilter && !typeFilter.has(String(row.type).toLowerCase())) return;
      total += 1;
      if (results.length < limit || limit === 0) results.push(Object.assign({ pocket: entry.name, pocketPath: entry.path }, row));
    };

    for (const block of data.log.blocks) {
      if (flattenBlockText(block).toLowerCase().includes(needle)) {
        push({ type: 'T', id: 'T' + block.id, label: block.gist || '' });
      }
    }
    for (const adr of data.decisions.adrs) {
      const text = [adr.title, adr.context, adr.decision, adr.consequences].filter(Boolean).join('\n');
      if (text.toLowerCase().includes(needle)) {
        push({ type: 'ADR', id: 'ADR-' + adr.id, label: adr.title || '' });
      }
    }
    for (const req of data.requirements.items) {
      if (String(req.text || '').toLowerCase().includes(needle)) {
        push({ type: 'R', id: 'R' + req.id, label: req.text || '', status: req.status });
      }
    }
    for (const pref of data.preferences.items || []) {
      if (String(pref).toLowerCase().includes(needle)) {
        push({ type: 'pref', id: 'pref', label: String(pref) });
      }
    }
    for (const entryAbs of (data.absolute.entries || [])) {
      if (String(entryAbs.gist || entryAbs.content || '').toLowerCase().includes(needle)) {
        push({ type: 'absolute', id: 'T' + entryAbs.tId, label: entryAbs.gist || '' });
      }
    }
  }

  return {
    ok: true,
    root,
    keyword: query,
    total,
    count: results.length,
    limit,
    hasMore: limit > 0 && total > results.length,
    results,
  };
}

function recallRef(root, ref) {
  const m = /^([^:\s]+):T(\d+)$/.exec(String(ref || '').trim());
  if (!m) {
    throw new Error('Use a qualified id like api:T12 (workspace recall never guesses a pocket)');
  }
  const manifest = readManifest(root);
  const entry = manifest.pockets.find((p) => p.name === m[1]);
  if (!entry) throw new Error('Pocket not found: ' + m[1]);
  const resolved = resolvePocket(root, entry);
  if (!resolved.exists) throw new Error('Pocket is missing on disk: ' + entry.name);
  const data = parsePocketAll(resolved.pocketDir);
  const block = data.log.blocks.find((b) => b.id === Number(m[2]));
  if (!block) throw new Error('T' + m[2] + ' not found in pocket ' + entry.name);
  return { ok: true, root, pocket: entry.name, pocketPath: entry.path, block };
}

function cacheDir(root) {
  return path.join(root, CACHE_DIR);
}

module.exports = {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  CACHE_DIR,
  manifestPath,
  parsePocketAll,
  findWorkspaceRoot,
  readManifest,
  writeManifest,
  initWorkspace,
  normalizePocket,
  addPocket,
  removePocket,
  resolvePocket,
  listPockets,
  statusWorkspace,
  searchWorkspace,
  recallRef,
  cacheDir,
};
