'use strict';

/**
 * ContextPocket Quan — 知识沉淀（K）存储层
 *
 * Markdown 是真相：ContextPocket/knowledge.md。
 * 本模块只负责读写、来源解析、候选晋升；纯解析/渲染在 shared/knowledge-core.js。
 */

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./io');
const { readFileSafe } = require('./core');
const { parseLogAll, parseDecisions, parseRequirements } = require('./parser');
const { extractFilesFromBlock } = require('./files');
const {
  createKnowledgeNote,
  parseKnowledgeText,
  renderKnowledgeDocument,
  validateKnowledgeDocument,
  nextKnowledgeNumber,
  normalizeTopic,
  knowledgeIdNumber,
  parseSourceList,
  parseTagList,
  uniqueSources,
} = require('./knowledge-core');

const KNOWLEDGE_FILE = 'knowledge.md';

function knowledgePath(pocketDir) {
  return path.join(pocketDir, KNOWLEDGE_FILE);
}

function whenDateOf(block) {
  if (!block || !block.when) return null;
  const when = block.when;
  return when.date || when.from || null;
}

function readKnowledge(pocketDir) {
  const file = knowledgePath(pocketDir);
  if (!fs.existsSync(file)) {
    return { present: false, path: file, maxId: null, notes: [], issues: [] };
  }
  const text = readFileSafe(file);
  const parsed = parseKnowledgeText(text);
  return {
    present: true,
    path: file,
    maxId: parsed.maxId,
    notes: parsed.notes,
    issues: parsed.issues,
  };
}

function writeKnowledge(pocketDir, notes) {
  const file = knowledgePath(pocketDir);
  writeAtomic(file, renderKnowledgeDocument(notes));
  return file;
}

function normalizeRef(ref) {
  const value = String(ref || '').trim();
  const adr = /^adr:(ADR-\d+)$/i.exec(value);
  if (adr) return adr[1];
  const req = /^req:(R\d+)$/i.exec(value);
  if (req) return req[1];
  return value;
}

function nodeIdForRef(ref) {
  const value = normalizeRef(ref);
  if (/^T\d+$/.test(value)) return value;
  const adr = /^ADR-(\d+)$/i.exec(value);
  if (adr) return 'adr:ADR-' + adr[1];
  const req = /^R(\d+)$/i.exec(value);
  if (req) return 'req:R' + req[1];
  if (/^(file|tag|pref):/.test(value)) return value;
  return null;
}

/**
 * 口袋内可被 K 引用的节点索引。
 * T 用归档+当前日志，ADR/R 用活文档；file/tag 从 T-block 与需求聚合。
 */
function buildSourceIndex(pocketDir) {
  const index = new Map();
  const log = parseLogAll(pocketDir);
  const blockDate = new Map();
  for (const block of log.blocks) {
    blockDate.set(block.id, whenDateOf(block));
    const tRef = 'T' + block.id;
    index.set(tRef, {
      ref: tRef,
      nodeId: tRef,
      type: 'turn',
      label: block.gist || '',
      date: whenDateOf(block),
    });
    for (const tag of block.tags || []) {
      const ref = 'tag:' + String(tag).trim();
      if (!index.has(ref)) index.set(ref, { ref, nodeId: ref, type: 'tag', label: String(tag).trim(), date: whenDateOf(block) });
    }
    for (const file of extractFilesFromBlock(block) || []) {
      const ref = 'file:' + String(file).replace(/\\/g, '/');
      if (!index.has(ref)) index.set(ref, { ref, nodeId: ref, type: 'file', label: String(file), date: whenDateOf(block) });
    }
  }

  for (const adr of parseDecisions(pocketDir).adrs) {
    const ref = 'ADR-' + adr.id;
    index.set(ref, {
      ref,
      nodeId: 'adr:ADR-' + adr.id,
      type: 'decision',
      label: adr.title || '',
      date: blockDate.get(adr.createdAt) || null,
    });
  }

  for (const req of parseRequirements(pocketDir).items) {
    const ref = 'R' + req.id;
    index.set(ref, {
      ref,
      nodeId: 'req:R' + req.id,
      type: 'requirement',
      label: req.text || '',
      date: blockDate.get(req.openedAt) || null,
    });
  }

  return index;
}

function resolveSources(pocketDir, sources, sourceIndex) {
  const index = sourceIndex || buildSourceIndex(pocketDir);
  const resolved = [];
  const missing = [];
  for (const raw of parseSourceList(sources)) {
    const ref = normalizeRef(raw);
    const hit = index.get(ref);
    if (!hit) {
      missing.push(ref);
      continue;
    }
    resolved.push(hit);
  }
  return { resolved, missing };
}

function latestDate(items) {
  let latest = null;
  for (const item of items) {
    if (!item || !item.date) continue;
    if (!latest || item.date > latest) latest = item.date;
  }
  return latest;
}

function truncateTitle(text, fallback) {
  const value = String(text || '').replace(/^[-*]\s*/, '').replace(/^❓\s*/, '').trim();
  if (!value) return fallback;
  return value.length > 60 ? value.slice(0, 57).trim() + '...' : value;
}

function kindPriority(kind) {
  return { decision: 5, 'how-to': 4, pitfall: 3, concept: 2, reference: 1 }[kind] || 0;
}

function sectionFor(kind) {
  if (kind === 'pitfall') return 'Pitfalls';
  if (kind === 'decision') return 'Decisions';
  if (kind === 'how-to') return 'How-to';
  if (kind === 'reference') return 'Facts';
  return 'Open questions';
}

/**
 * 从旧 T-block 提取 K 候选。
 * 只认显式 section + tag/file 锚点；没有锚点的纯文本留在 digest 报告。
 */
function buildKnowledgeCandidates(blocks, options = {}) {
  const adrTexts = (options.adrTexts || []).map((text) => String(text || '').toLowerCase());
  const groups = new Map();

  const coveredByAdr = (text) => {
    const needle = String(text || '').toLowerCase();
    if (!needle) return false;
    return adrTexts.some((adr) => adr && (adr.includes(needle) || needle.includes(adr)));
  };

  const add = (block, kind, text) => {
    const clean = String(text || '').replace(/^[-*]\s*/, '').replace(/^❓\s*/, '').trim();
    if (clean.length < 4) return;
    if (kind === 'decision' && coveredByAdr(clean)) return;
    const tags = (block.tags || []).map((tag) => String(tag).trim()).filter(Boolean);
    const files = (extractFilesFromBlock(block) || []).map((file) => String(file).replace(/\\/g, '/'));
    const anchor = tags[0] ? 'tag:' + tags[0] : (files[0] ? 'file:' + files[0] : null);
    if (!anchor) return;
    const topic = normalizeTopic(tags[0] || files[0]);
    if (!topic) return;

    const key = topic;
    let candidate = groups.get(key);
    if (!candidate) {
      candidate = {
        topic,
        kind,
        title: truncateTitle(clean, topic),
        sources: new Set(['T' + block.id, anchor]),
        tags: new Set(tags),
        sections: {},
        updated: whenDateOf(block) || '',
        confidence: 'inferred',
        status: 'draft',
      };
      groups.set(key, candidate);
    } else if (kindPriority(kind) > kindPriority(candidate.kind)) {
      candidate.kind = kind;
      candidate.title = truncateTitle(clean, topic);
    }
    candidate.sources.add('T' + block.id);
    candidate.sources.add(anchor);
    for (const tag of tags) candidate.tags.add(tag);
    const section = sectionFor(kind);
    if (!candidate.sections[section]) candidate.sections[section] = [];
    if (!candidate.sections[section].includes('- ' + clean)) {
      candidate.sections[section].push('- ' + clean);
    }
    const date = whenDateOf(block);
    if (date && (!candidate.updated || date > candidate.updated)) candidate.updated = date;
  };

  for (const block of blocks || []) {
    for (const item of (block.sections && block.sections.Pitfalls) || []) {
      add(block, 'pitfall', item);
    }
    for (const item of (block.sections && block.sections.Uncertain) || []) {
      if (String(item).includes('❓')) add(block, 'concept', item);
    }
    for (const item of (block.sections && block.sections['Decisions & Constraints']) || []) {
      add(block, 'decision', item);
    }
  }

  return [...groups.values()]
    .map((candidate) => ({
      ...candidate,
      sources: [...candidate.sources],
      tags: [...candidate.tags],
    }))
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.topic.localeCompare(b.topic))
    .slice(0, options.max || 50);
}

function appendUnique(target, values) {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

/**
 * 把候选写进 knowledge.md。默认只写 draft；activate 才允许 active。
 * 已有同 Topic 的 K 只追加来源/标签/正文，不覆盖人工正文。
 */
function promoteKnowledge(pocketDir, candidates, options = {}) {
  const current = readKnowledge(pocketDir);
  const notes = current.notes.map((note) => ({
    ...note,
    meta: { ...note.meta },
    sections: Object.fromEntries(Object.entries(note.sections || {}).map(([key, value]) => [key, value.slice()])),
  }));
  const byTopic = new Map();
  for (const note of notes) {
    const key = normalizeTopic(note.topic);
    if (key) byTopic.set(key, note);
  }
  const sourceIndex = buildSourceIndex(pocketDir);
  let next = nextKnowledgeNumber(notes);
  const result = {
    added: 0,
    updated: 0,
    skipped: 0,
    activated: 0,
    missingSources: [],
    notes,
    applied: false,
    path: knowledgePath(pocketDir),
  };

  for (const candidate of candidates || []) {
    const topic = normalizeTopic(candidate.topic);
    if (!topic) {
      result.skipped += 1;
      continue;
    }
    const { resolved, missing } = resolveSources(pocketDir, candidate.sources, sourceIndex);
    if (missing.length > 0) result.missingSources.push(...missing);
    const date = latestDate(resolved) || candidate.updated || '';
    const sources = uniqueSources((candidate.sources || []).map(normalizeRef));
    const tags = parseTagList(candidate.tags || []);

    const existing = byTopic.get(topic);
    if (existing) {
      existing.sources = uniqueSources(existing.sources.concat(sources));
      existing.meta.sources = existing.sources.join(', ');
      existing.tags = [...new Set(existing.tags.concat(tags))];
      existing.meta.tags = existing.tags.join(', ');
      if (date && (!existing.updated || date > existing.updated)) existing.updated = date;
      existing.meta.updated = existing.updated;
      for (const [section, lines] of Object.entries(candidate.sections || {})) {
        if (!existing.sections[section]) existing.sections[section] = [];
        appendUnique(existing.sections[section], lines);
      }
      if (options.activate && existing.status === 'draft' && missing.length === 0
        && existing.sources.length > 0 && existing.updated) {
        existing.status = 'active';
        existing.meta.status = 'active';
        existing.confidence = existing.sources.length >= 2 ? 'confirmed' : 'inferred';
        existing.meta.confidence = existing.confidence;
        result.activated += 1;
      }
      result.updated += 1;
      continue;
    }

    const canActivate = !!options.activate && resolved.length > 0 && missing.length === 0 && !!date;
    const status = canActivate ? 'active' : 'draft';
    const confidence = status === 'active'
      ? (resolved.length >= 2 ? 'confirmed' : 'inferred')
      : 'inferred';
    const note = createKnowledgeNote(
      'K' + next++,
      candidate.title || topic,
      {
        topic,
        kind: candidate.kind || 'concept',
        status,
        confidence,
        sources: sources.join(', '),
        tags: tags.join(', '),
        updated: date,
        supersedes: '',
        conflicts: '',
      },
      candidate.sections || {}
    );
    notes.push(note);
    byTopic.set(topic, note);
    result.added += 1;
    if (status === 'active') result.activated += 1;
  }

  notes.sort((a, b) => (knowledgeIdNumber(a.id) || 0) - (knowledgeIdNumber(b.id) || 0));
  if (options.apply && (result.added > 0 || result.updated > 0)) {
    writeKnowledge(pocketDir, notes);
    result.applied = true;
  }
  return result;
}

function inspectKnowledge(pocketDir) {
  const parsed = readKnowledge(pocketDir);
  const issues = parsed.issues.concat(validateKnowledgeDocument(parsed.notes.map((note) => note), { scope: 'pocket' }));
  const sourceIndex = buildSourceIndex(pocketDir);
  let missingSources = 0;
  const byStatus = {};
  const byKind = {};
  for (const note of parsed.notes) {
    byStatus[note.status] = (byStatus[note.status] || 0) + 1;
    byKind[note.kind] = (byKind[note.kind] || 0) + 1;
    const { missing } = resolveSources(pocketDir, note.sources, sourceIndex);
    missingSources += missing.length;
  }
  return {
    present: parsed.present,
    path: parsed.path,
    maxId: parsed.maxId,
    notes: parsed.notes.length,
    byStatus,
    byKind,
    issues,
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    missingSources,
  };
}

module.exports = {
  KNOWLEDGE_FILE,
  knowledgePath,
  whenDateOf,
  readKnowledge,
  writeKnowledge,
  normalizeRef,
  nodeIdForRef,
  buildSourceIndex,
  resolveSources,
  buildKnowledgeCandidates,
  promoteKnowledge,
  inspectKnowledge,
};
