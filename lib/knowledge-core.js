'use strict';

/**
 * ContextPocket — 知识沉淀（K）纯契约层（quan / yuan 共用）
 *
 * 只做 Markdown 解析 / 渲染 / 归一化 / 校验，不读写文件、不碰缓存。
 * 存储外壳在 Quan 的 lib/knowledge.js 与 Yuan 的 lang/lib/workspace-knowledge.js。
 *
 * K 的核心约束：
 *   - Markdown 是内容与 Sources 的真相源；
 *   - 无 Sources 只能 draft，不能 active；
 *   - 时间只用显式 Updated / 来源 WHEN，不猜 mtime。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const { normalizeKey } = require('./graph-core');

const K_STATUSES = ['draft', 'active', 'stale', 'superseded', 'archived'];
const K_KINDS = ['concept', 'decision', 'how-to', 'pitfall', 'reference'];
const K_CONFIDENCES = ['confirmed', 'inferred', 'disputed'];

const K_SECTIONS = [
  'Summary',
  'Facts',
  'Decisions',
  'How-to',
  'Pitfalls',
  'Open questions',
  'Related',
  'Conflicts',
];

const META_ORDER = [
  'topic',
  'kind',
  'status',
  'confidence',
  'sources',
  'tags',
  'updated',
  'supersedes',
  'supersededBy',
  'conflicts',
];

const META_LABELS = {
  topic: 'Topic',
  kind: 'Kind',
  status: 'Status',
  confidence: 'Confidence',
  sources: 'Sources',
  tags: 'Tags',
  updated: 'Updated',
  supersedes: 'Supersedes',
  supersededBy: 'SupersededBy',
  conflicts: 'Conflicts',
};

function parseSourceList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return [];
  return text.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

function parseTagList(value) {
  return parseSourceList(value).map((tag) => tag.replace(/^#/, ''));
}

/** 'K1' / 'K-0001' / 'K-1' → 1；其它 → null */
function knowledgeIdNumber(id) {
  const match = /^K-?(\d+)$/i.exec(String(id || '').trim());
  return match ? parseInt(match[1], 10) : null;
}

function normalizeKnowledgeId(id) {
  const number = knowledgeIdNumber(id);
  if (number === null) return null;
  return 'K-' + String(number).padStart(4, '0');
}

/** Quan 用 K1，Yuan 用 K-0001；这里只负责数字部分。 */
function formatKnowledgeId(number, options = {}) {
  if (!Number.isInteger(number) || number < 1) return null;
  return options.padded === false ? 'K' + number : 'K-' + String(number).padStart(4, '0');
}

/** 主题 slug：保留层级斜杠与 Unicode 字母（中文 tag 也能成为 Topic）。 */
function normalizeTopic(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}/_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 80);
}

function normalizedMetaKey(key) {
  const raw = String(key || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (raw === 'supersededby') return 'supersededBy';
  return raw;
}

function parseMetaLine(line) {
  const match = /^\s*[-*]\s*([A-Za-z][A-Za-z0-9 _-]*)\s*:\s*(.*)$/.exec(line);
  if (!match) return null;
  return { key: normalizedMetaKey(match[1]), value: match[2].trim() };
}

function parseBodySections(lines) {
  const sections = {};
  let current = null;
  for (const line of lines) {
    const heading = /^\s*###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  for (const key of Object.keys(sections)) {
    while (sections[key].length > 0 && !sections[key][0].trim()) sections[key].shift();
    while (sections[key].length > 0 && !sections[key][sections[key].length - 1].trim()) sections[key].pop();
  }
  return sections;
}

function makeNote(id, title, meta, sections) {
  return {
    id,
    title: String(title || '').trim(),
    meta,
    sections,
    topic: meta.topic || '',
    kind: meta.kind || '',
    status: meta.status || '',
    confidence: meta.confidence || '',
    sources: parseSourceList(meta.sources),
    tags: parseTagList(meta.tags),
    updated: meta.updated || '',
    supersedes: parseSourceList(meta.supersedes),
    supersededBy: parseSourceList(meta.supersededBy),
    conflicts: parseSourceList(meta.conflicts),
  };
}

/**
 * 解析 Quan 的 knowledge.md（多个 `## K<n> · Title`）。
 * @param {string} text
 * @returns {{maxId:number|null, notes:Array, issues:Array}}
 */
function parseKnowledgeText(text) {
  const content = String(text || '');
  const issues = [];
  const header = /^\s*#\s+Knowledge(?:\s+Index)?\s*·\s*(K-?\d+)\s*$/mi.exec(content);
  const maxId = header ? knowledgeIdNumber(header[1]) : null;

  const notes = [];
  const seen = new Set();
  const blocks = content.split(/^(?=##\s+K-?\d+\s*·)/m);
  for (const block of blocks) {
    const heading = /^##\s+(K-?\d+)\s*·\s*(.+?)\s*$/m.exec(block);
    if (!heading) continue;
    const id = heading[1];
    const number = knowledgeIdNumber(id);
    if (number === null) {
      issues.push({ id, problem: 'invalid knowledge id' });
      continue;
    }
    if (seen.has(id)) issues.push({ id, problem: 'duplicate knowledge id' });
    seen.add(id);

    const lines = block.split('\n');
    const headingIndex = lines.findIndex((line) => /^##\s+K-?\d+\s*·/.test(line));
    const body = lines.slice(headingIndex + 1);
    const meta = {};
    const bodyStart = body.findIndex((line) => /^\s*###\s+/.test(line));
    const metaLines = bodyStart === -1 ? body : body.slice(0, bodyStart);
    for (const line of metaLines) {
      const parsed = parseMetaLine(line);
      if (parsed) meta[parsed.key] = parsed.value;
    }
    const sections = parseBodySections(bodyStart === -1 ? [] : body.slice(bodyStart));
    notes.push(makeNote(id, heading[2], meta, sections));
  }

  notes.sort((a, b) => (knowledgeIdNumber(a.id) || 0) - (knowledgeIdNumber(b.id) || 0));
  if (maxId !== null && notes.length > 0) {
    const actualMax = Math.max(...notes.map((note) => knowledgeIdNumber(note.id) || 0));
    if (maxId < actualMax) {
      issues.push({ id: 'header', problem: `header max ${maxId} is below K${actualMax}` });
    }
  }
  return { maxId, notes, issues };
}

/** 解析 Yuan 的单篇笔记（`# K-0001 · Title`）。 */
function parseKnowledgeNote(text) {
  const content = String(text || '');
  const heading = /^\s*#\s+(K-?\d+)\s*·\s*(.+?)\s*$/m.exec(content);
  if (!heading) return { note: null, issues: [{ id: null, problem: 'missing K heading' }] };
  const lines = content.split('\n');
  const headingIndex = lines.findIndex((line) => /^\s*#\s+K-?\d+\s*·/.test(line));
  const body = lines.slice(headingIndex + 1);
  const bodyStart = body.findIndex((line) => /^\s*###\s+/.test(line));
  const meta = {};
  for (const line of (bodyStart === -1 ? body : body.slice(0, bodyStart))) {
    const parsed = parseMetaLine(line);
    if (parsed) meta[parsed.key] = parsed.value;
  }
  return {
    note: makeNote(heading[1], heading[2], meta, parseBodySections(bodyStart === -1 ? [] : body.slice(bodyStart))),
    issues: [],
  };
}

function renderMeta(note) {
  const lines = [];
  for (const key of META_ORDER) {
    const label = META_LABELS[key];
    let value = note.meta[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value = value.join(', ');
    lines.push('- ' + label + ': ' + value);
  }
  return lines;
}

function renderNoteBody(note) {
  const lines = [];
  const order = K_SECTIONS.concat(Object.keys(note.sections || {}).filter((name) => !K_SECTIONS.includes(name)));
  for (const name of order) {
    const items = note.sections && note.sections[name];
    if (!items || items.length === 0) continue;
    lines.push('');
    lines.push('### ' + name);
    lines.push(...items);
  }
  return lines;
}

/** 渲染 Quan 的单条 K 块。 */
function renderKnowledgeBlock(note) {
  const lines = ['## ' + note.id + ' · ' + note.title];
  lines.push(...renderMeta(note));
  lines.push(...renderNoteBody(note));
  return lines.join('\n');
}

/** 渲染 Quan 的整份 knowledge.md。 */
function renderKnowledgeDocument(notes, options = {}) {
  const sorted = notes.slice().sort((a, b) => (knowledgeIdNumber(a.id) || 0) - (knowledgeIdNumber(b.id) || 0));
  const max = sorted.reduce((value, note) => Math.max(value, knowledgeIdNumber(note.id) || 0), 0);
  const headerId = options.headerId || (max > 0 ? 'K' + max : 'K0');
  const lines = ['# Knowledge · ' + headerId, ''];
  lines.push('> ContextPocket 记忆沉淀。每条 K 必须能沿 Sources 回到证据；无来源只能 draft。');
  lines.push('');
  for (const note of sorted) {
    lines.push(renderKnowledgeBlock(note));
    lines.push('');
  }
  return lines.join('\n');
}

/** 渲染 Yuan 的单篇笔记文件。 */
function renderKnowledgeNote(note) {
  const lines = ['# ' + note.id + ' · ' + note.title];
  lines.push(...renderMeta(note));
  lines.push(...renderNoteBody(note));
  return lines.join('\n') + '\n';
}

function escapeCell(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\|/g, '\\|');
}

/** 渲染 Yuan 的 knowledge/index.md。 */
function renderKnowledgeIndex(notes, options = {}) {
  const sorted = notes.slice().sort((a, b) => (knowledgeIdNumber(a.id) || 0) - (knowledgeIdNumber(b.id) || 0));
  const max = sorted.reduce((value, note) => Math.max(value, knowledgeIdNumber(note.id) || 0), 0);
  const headerId = options.headerId || (max > 0 ? 'K-' + String(max).padStart(4, '0') : 'K-0000');
  const lines = ['# Knowledge Index · ' + headerId, ''];
  lines.push('| Id | Topic | Title | Kind | Status | Confidence | Sources | Updated |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const note of sorted) {
    lines.push('| ' + [
      note.id,
      note.topic,
      note.title,
      note.kind,
      note.status,
      note.confidence,
      note.sources.length,
      note.updated,
    ].map(escapeCell).join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

/**
 * 纯校验：不读文件，不解析来源是否存在。
 * @param {object} note
 * @param {object} [options]
 * @param {'pocket'|'workspace'} [options.scope='pocket']
 * @returns {Array<{code:string, severity:'error'|'warning', message:string}>}
 */
function validateKnowledgeNote(note, options = {}) {
  const issues = [];
  const scope = options.scope || 'pocket';
  const push = (code, severity, message) => issues.push({ code, severity, message });

  if (!note || !note.id) push('k-id', 'error', 'missing knowledge id');
  if (!note.title) push('k-title', 'error', 'missing knowledge title');
  if (!note.topic) push('k-topic', 'error', note.id + ' is missing Topic');
  if (!K_KINDS.includes(note.kind)) push('k-kind', 'error', note.id + ' has invalid Kind "' + note.kind + '"');
  if (!K_STATUSES.includes(note.status)) push('k-status', 'error', note.id + ' has invalid Status "' + note.status + '"');
  if (!K_CONFIDENCES.includes(note.confidence)) {
    push('k-confidence', 'error', note.id + ' has invalid Confidence "' + note.confidence + '"');
  }
  if (note.updated && !/^\d{4}-\d{2}-\d{2}$/.test(note.updated)) {
    push('k-updated', 'error', note.id + ' has invalid Updated "' + note.updated + '"');
  }
  if (note.status === 'active' && note.sources.length === 0) {
    push('k-sources', 'error', note.id + ' is active but has no Sources');
  }
  if (note.status === 'active' && !note.updated) {
    push('k-updated', 'error', note.id + ' is active but has no Updated date');
  }
  if (note.status === 'draft' && note.sources.length === 0) {
    push('k-orphan', 'warning', note.id + ' is a draft with no Sources (allowed, but not promotable)');
  }
  for (const source of note.sources) {
    const localKind = /^(file|tag|pref):/.test(source);
    if (scope === 'workspace' && (localKind || !/^[a-z][a-z0-9_-]*:/.test(source))) {
      push('k-source-scope', 'error', note.id + ' source "' + source + '" must be pocket-qualified in a workspace');
    }
    if (scope === 'pocket' && !localKind && /^[a-z][a-z0-9_-]*:/.test(source)) {
      push('k-source-scope', 'warning', note.id + ' source "' + source + '" looks workspace-qualified in a pocket');
    }
  }
  if (note.supersedes.length > 0 && note.supersedes.some((id) => knowledgeIdNumber(id) === null)) {
    push('k-supersedes', 'error', note.id + ' has invalid Supersedes id');
  }
  return issues;
}

/** 校验整份文档：编号、重复 Topic、引用关系。 */
function validateKnowledgeDocument(notes, options = {}) {
  const issues = [];
  const seenIds = new Set();
  const activeByTopic = new Map();
  for (const note of notes) {
    for (const issue of validateKnowledgeNote(note, options)) issues.push(issue);
    if (seenIds.has(note.id)) {
      issues.push({ code: 'k-id', severity: 'error', message: 'duplicate knowledge id ' + note.id });
    }
    seenIds.add(note.id);
    if (note.status === 'active' && note.topic) {
      const key = normalizeTopic(note.topic);
      if (activeByTopic.has(key)) {
        issues.push({
          code: 'k-duplicate-topic',
          severity: 'warning',
          message: note.id + ' and ' + activeByTopic.get(key) + ' share active Topic "' + key + '"',
        });
      } else {
        activeByTopic.set(key, note.id);
      }
    }
    for (const target of note.supersedes) {
      if (!seenIds.has(target) && !notes.some((item) => item.id === target)) {
        issues.push({ code: 'k-supersedes', severity: 'error', message: note.id + ' supersedes missing ' + target });
      }
    }
  }
  return issues;
}

/** 由现有 K 计算下一个编号；永不重用。 */
function nextKnowledgeNumber(notes, options = {}) {
  let max = Number.isInteger(options.min) ? options.min : 0;
  for (const note of notes) {
    max = Math.max(max, knowledgeIdNumber(note.id) || 0);
  }
  return max + 1;
}

function uniqueSources(sources) {
  return unique(sources.map((source) => String(source).trim()));
}

module.exports = {
  K_STATUSES,
  K_KINDS,
  K_CONFIDENCES,
  K_SECTIONS,
  createKnowledgeNote: makeNote,
  parseSourceList,
  parseTagList,
  parseKnowledgeText,
  parseKnowledgeNote,
  renderKnowledgeBlock,
  renderKnowledgeDocument,
  renderKnowledgeNote,
  renderKnowledgeIndex,
  normalizeKnowledgeId,
  normalizeTopic,
  knowledgeIdNumber,
  formatKnowledgeId,
  validateKnowledgeNote,
  validateKnowledgeDocument,
  nextKnowledgeNumber,
  uniqueSources,
  normalizeKey,
};
