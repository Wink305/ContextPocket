'use strict';

/**
 * ContextPocket yuan — CI / PR 摘要捕获（阶段 2）
 *
 * 把一个**本地保存**的 PR 描述 / CI 结果摘要变成标准 T-block，写进选定的
 * 工作区口袋。刻意不联网：CI/PR 的抓取交给用户或后续连接器，这里只负责
 * "把已经拿到的文本安全、可复述地记进记忆"。
 *
 * 安全边界：
 *   - 只摘标题、列表要点和第一个链接，不整段抄正文；
 *   - 写盘前对**将要写入的内容**做密钥扫描，error 级凭据直接拒绝；
 *   - 默认只出计划，`--apply` 才调用 writer.appendLogBlock。
 */

const fs = require('fs');
const path = require('path');

const { readManifest, resolvePocket } = require('./workspace');
const { scanText } = require('./secrets');
const writer = require('./writer');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_GIST = 120;
const MAX_BULLETS = 5;
const MAX_BULLET = 300;

function truncate(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + '…';
}

function firstHeading(text) {
  for (const line of text.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) return match[1].trim();
  }
  return '';
}

function extractGist(text, override) {
  const given = String(override || '').trim();
  if (given) return truncate(given, MAX_GIST);
  const heading = firstHeading(text);
  if (heading) return truncate(heading, MAX_GIST);
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    const stripped = value
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '');
    if (stripped) return truncate(stripped, MAX_GIST);
  }
  return '';
}

function extractBullets(text, gist) {
  const bullets = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (!match) continue;
    const value = match[1].trim().replace(/^\[[ xX]\]\s+/, '');
    if (!value || value === gist || seen.has(value)) continue;
    seen.add(value);
    bullets.push(truncate(value, MAX_BULLET));
    if (bullets.length >= MAX_BULLETS) break;
  }
  return bullets;
}

function extractUrl(text, override) {
  const given = String(override || '').trim();
  if (/^https?:\/\//i.test(given)) return given;
  const match = text.match(/https?:\/\/[^\s<>"'()]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, '');
}

function normalizeKind(value) {
  const kind = String(value || 'pr').trim().toLowerCase();
  if (kind !== 'pr' && kind !== 'ci') {
    throw new Error('--kind must be pr or ci (got ' + value + ')');
  }
  return kind;
}

function normalizeTags(value, kind) {
  const tags = [kind];
  if (value) {
    for (const item of String(value).split(',')) {
      const tag = item.replace(/[\[\]\r\n]/g, '').trim();
      if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
        tags.push(tag);
      }
    }
  }
  return tags;
}

function pickPocket(manifest, requested) {
  const name = String(requested || '').trim();
  if (name) {
    const entry = manifest.pockets.find((pocket) => pocket.name === name);
    if (!entry) throw new Error('Pocket not found: ' + name);
    return entry;
  }
  if (manifest.pockets.length === 1) return manifest.pockets[0];
  throw new Error('capture needs --pocket <name> (workspace has '
    + manifest.pockets.length + ' pockets: '
    + manifest.pockets.map((pocket) => pocket.name).join(', ') + ')');
}

/**
 * @param {string} root
 * @param {object} options
 * @param {string} options.file 本地 PR / CI 摘要文件
 * @param {string} [options.pocket] 目标口袋名；只有一个口袋时可省略
 * @param {string} [options.kind=pr] pr | ci
 * @param {string} [options.gist] 覆盖标题
 * @param {string} [options.tags] 额外标签，逗号分隔
 * @param {string} [options.url] 覆盖从正文提取的链接
 * @param {string} [options.when] 透传给 T-block 的时间
 * @param {boolean} [options.apply] 写盘（默认 false：只出计划）
 */
function captureWorkspace(root, options = {}) {
  const file = path.resolve(String(options.file || ''));
  if (!options.file) throw new Error('capture needs a summary file');
  if (!fs.existsSync(file)) throw new Error('File not found: ' + file);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Not a file: ' + file);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('Summary file is too large (' + stat.size + ' bytes; max ' + MAX_FILE_BYTES + ')');
  }

  const text = fs.readFileSync(file, 'utf-8');
  if (!text.trim()) throw new Error('Summary file is empty: ' + file);

  const manifest = readManifest(root);
  const entry = pickPocket(manifest, options.pocket);
  const resolved = resolvePocket(root, entry);
  if (!resolved.exists) throw new Error('Pocket is missing on disk: ' + entry.name);

  const kind = normalizeKind(options.kind);
  const gist = extractGist(text, options.gist);
  if (!gist) throw new Error('Could not extract a summary title; pass --gist <text>');
  const tags = normalizeTags(options.tags, kind);
  const url = extractUrl(text, options.url);
  const bullets = extractBullets(text, gist);

  const user = ['Captured ' + kind + ' summary from ' + path.basename(file)];
  const action = ['[' + kind + '] ' + gist].concat(bullets);
  if (url) action.push('Source: ' + url);

  // 只扫描将要写入的内容：正文里的密钥不会因为"没摘进 T-block"而进入口袋
  const findings = scanText([user[0]].concat(action).join('\n'), { file: path.basename(file) });
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    throw new Error('capture refused: summary contains credential(s) — '
      + errors.map((finding) => finding.label + ' (' + finding.masked + ')').join(', ')
      + '. Remove them from the summary or write a sanitized excerpt.');
  }

  const apply = !!options.apply;
  const base = {
    ok: true,
    root,
    workspace: manifest.name,
    mode: apply ? 'apply' : 'plan',
    pocket: { name: entry.name, path: entry.path },
    source: { file, name: path.basename(file), bytes: stat.size },
    kind,
    gist,
    tags,
    url: url || null,
    user,
    action,
    warnings: findings.filter((finding) => finding.severity === 'warning'),
  };

  if (!apply) return Object.assign(base, { captured: false, tId: null, when: null });

  const result = writer.appendLogBlock(resolved.pocketDir, {
    gist,
    tags,
    user,
    action,
    when: options.when,
  });

  return Object.assign(base, {
    captured: true,
    tId: result.tId,
    when: result.when,
    autoConflicts: result.autoConflicts,
    conflictCheckError: result.conflictCheckError,
  });
}

module.exports = {
  captureWorkspace,
};
