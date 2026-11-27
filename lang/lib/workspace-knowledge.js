'use strict';

/**
 * ContextPocket Yuan — 工作区知识沉淀（K）
 *
 * 持久真相：工作区根 knowledge/index.md + knowledge/K-*.md。
 * 派生缓存：.contextpocket/knowledge-index.json（签名/编号水位）。
 * 工作区图缓存会把 K 节点作为 kb:* 节点并入。
 *
 * 所有来源必须限定到口袋：api:T5 / api:ADR-2 / api:file:src/a.js。
 * Markdown 是内容与 Sources 的真相源；这里只做读写、构建、校验。
 */

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./io');
const { readFileSafe } = require('./core');
const { readManifest, resolvePocket, parsePocketAll } = require('./workspace');
const { extractFilesFromBlock } = require('./files');
const {
  createKnowledgeNote,
  parseKnowledgeNote,
  parseSourceList,
  parseTagList,
  renderKnowledgeIndex,
  renderKnowledgeNote,
  validateKnowledgeDocument,
  normalizeTopic,
  normalizeKey,
  knowledgeIdNumber,
  nextKnowledgeNumber,
  uniqueSources,
} = require('./knowledge-core');

const KNOWLEDGE_DIR = 'knowledge';
const KNOWLEDGE_INDEX = 'index.md';
const KNOWLEDGE_CACHE = 'knowledge-index.json';
const MAX_CANDIDATES = 200;

function knowledgeDir(root) {
  return path.join(root, KNOWLEDGE_DIR);
}

function knowledgeIndexPath(root) {
  return path.join(knowledgeDir(root), KNOWLEDGE_INDEX);
}

function knowledgeCachePath(root) {
  return path.join(root, '.contextpocket', KNOWLEDGE_CACHE);
}

function whenDateOf(block) {
  if (!block || !block.when) return null;
  const when = block.when;
  return when.date || when.from || null;
}

function latestDate(values) {
  let latest = null;
  for (const value of values) {
    if (!value) continue;
    if (!latest || value > latest) latest = value;
  }
  return latest;
}

function truncateTitle(text, fallback) {
  const value = String(text || '').replace(/^[-*]\s*/, '').replace(/^❓\s*/, '').trim();
  if (!value) return fallback;
  return value.length > 60 ? value.slice(0, 57).trim() + '...' : value;
}

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function noteFileName(note) {
  const slug = slugify(note.title);
  return note.id + (slug ? '-' + slug : '') + '.md';
}

function parseIndexHeader(text) {
  const match = /^\s*#\s+Knowledge\s+Index\s*·\s*(K-\d+)\s*$/mi.exec(String(text || ''));
  return match ? knowledgeIdNumber(match[1]) : null;
}

function parseIndexRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 9) continue;
    const id = cells[1];
    if (!/^K-\d+$/.test(id)) continue;
    rows.push({
      id,
      topic: cells[2],
      title: cells[3],
      kind: cells[4],
      status: cells[5],
      confidence: cells[6],
      sources: cells[7],
      updated: cells[8],
    });
  }
  return rows;
}

/**
 * 读取整个知识库。index.md 只用于对账；笔记文件才是内容真相。
 */
function readKnowledgeBase(root) {
  const dir = knowledgeDir(root);
  const indexFile = knowledgeIndexPath(root);
  if (!fs.existsSync(dir)) {
    return { present: false, dir, indexFile, maxId: null, notes: [], issues: [], indexDrift: [] };
  }
  const issues = [];
  const notes = [];
  const files = fs.readdirSync(dir).filter((name) => /^K-\d+.*\.md$/.test(name)).sort();
  const seen = new Set();
  for (const file of files) {
    const full = path.join(dir, file);
    const text = readFileSafe(full);
    const parsed = parseKnowledgeNote(text);
    if (!parsed.note) {
      issues.push({ file, problem: 'missing or invalid K heading' });
      continue;
    }
    const note = parsed.note;
    note.file = full;
    const expected = noteFileName(note);
    if (file !== expected) {
      issues.push({ file, problem: `filename should be ${expected}` });
    }
    if (seen.has(note.id)) {
      issues.push({ file, problem: `duplicate K id ${note.id}` });
    }
    seen.add(note.id);
    notes.push(note);
  }
  notes.sort((a, b) => (knowledgeIdNumber(a.id) || 0) - (knowledgeIdNumber(b.id) || 0));

  const indexText = readFileSafe(indexFile);
  const headerMax = indexText ? parseIndexHeader(indexText) : null;
  const indexRows = indexText ? parseIndexRows(indexText) : [];
  const indexDrift = [];
  if (indexText) {
    const rowIds = new Set(indexRows.map((row) => row.id));
    for (const note of notes) {
      if (!rowIds.has(note.id)) indexDrift.push({ id: note.id, problem: 'missing from index.md' });
    }
    const noteIds = new Set(notes.map((note) => note.id));
    for (const row of indexRows) {
      if (!noteIds.has(row.id)) indexDrift.push({ id: row.id, problem: 'index.md lists a missing note' });
    }
    if (headerMax !== null) {
      const actual = notes.reduce((max, note) => Math.max(max, knowledgeIdNumber(note.id) || 0), 0);
      if (headerMax < actual) indexDrift.push({ id: 'header', problem: `index header ${headerMax} < ${actual}` });
    }
  } else if (notes.length > 0) {
    indexDrift.push({ id: 'index.md', problem: 'missing index.md' });
  }

  const maxId = notes.reduce((max, note) => Math.max(max, knowledgeIdNumber(note.id) || 0), 0);
  return { present: true, dir, indexFile, maxId, notes, issues, indexDrift };
}

function knowledgeSignature(root) {
  const dir = knowledgeDir(root);
  if (!fs.existsSync(dir)) return null;
  const signature = {};
  const indexFile = knowledgeIndexPath(root);
  if (fs.existsSync(indexFile)) {
    const stat = fs.statSync(indexFile);
    signature[KNOWLEDGE_INDEX] = stat.mtimeMs + ':' + stat.size;
  }
  for (const name of fs.readdirSync(dir).filter((item) => /^K-\d+.*\.md$/.test(item)).sort()) {
    const stat = fs.statSync(path.join(dir, name));
    signature[name] = stat.mtimeMs + ':' + stat.size;
  }
  return signature;
}

function writeKnowledgeBase(root, notes) {
  const dir = knowledgeDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const note of notes) {
    const file = note.file && fs.existsSync(note.file)
      ? note.file
      : path.join(dir, noteFileName(note));
    writeAtomic(file, renderKnowledgeNote(note));
    written.push(file);
  }
  const indexFile = knowledgeIndexPath(root);
  writeAtomic(indexFile, renderKnowledgeIndex(notes));
  const cacheFile = knowledgeCachePath(root);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeAtomic(cacheFile, JSON.stringify({
    version: 1,
    builtAt: new Date().toISOString(),
    signature: knowledgeSignature(root),
    nextId: nextKnowledgeNumber(notes),
    notes: notes.map((note) => ({ id: note.id, topic: note.topic, status: note.status })),
  }, null, 2) + '\n');
  return { dir, notes: written.length, indexFile, cacheFile };
}

/**
 * 工作区来源索引：把每个口袋的 T / ADR / R / file / tag / pref 限定成 pocket:*。
 */
function buildSourceIndex(root, manifest) {
  const refs = new Map();
  const pockets = [];
  for (const entry of manifest.pockets) {
    const resolved = resolvePocket(root, entry);
    if (!resolved.exists) continue;
    const data = parsePocketAll(resolved.pocketDir);
    const blocks = data.log.blocks || [];
    const byT = new Map();
    for (const block of blocks) {
      byT.set(block.id, whenDateOf(block));
      const tRef = entry.name + ':T' + block.id;
      refs.set(tRef, {
        ref: tRef,
        nodeId: tRef,
        type: 'turn',
        label: block.gist || '',
        date: whenDateOf(block),
      });
      for (const tag of block.tags || []) {
        const ref = entry.name + ':tag:' + String(tag).trim();
        if (!refs.has(ref)) refs.set(ref, { ref, nodeId: ref, type: 'tag', label: String(tag).trim(), date: whenDateOf(block) });
      }
      for (const file of extractFilesFromBlock(block) || []) {
        const ref = entry.name + ':file:' + String(file).replace(/\\/g, '/');
        if (!refs.has(ref)) refs.set(ref, { ref, nodeId: ref, type: 'file', label: String(file), date: whenDateOf(block) });
      }
    }
    for (const adr of data.decisions.adrs) {
      const ref = entry.name + ':ADR-' + adr.id;
      refs.set(ref, {
        ref,
        nodeId: ref,
        type: 'decision',
        label: adr.title || '',
        date: byT.get(adr.createdAt) || null,
      });
    }
    for (const req of data.requirements.items) {
      const ref = entry.name + ':R' + req.id;
      refs.set(ref, {
        ref,
        nodeId: ref,
        type: 'requirement',
        label: req.text || '',
        date: byT.get(req.openedAt) || null,
      });
    }
    const latestT = data.preferences && data.preferences.latestT;
    const latestDateValue = latestT ? (byT.get(latestT) || null) : null;
    for (const text of (data.preferences && data.preferences.items) || []) {
      const colon = text.indexOf(':');
      const key = normalizeKey(colon > -1 ? text.slice(0, colon) : text);
      if (!key) continue;
      const ref = entry.name + ':pref:' + key;
      if (!refs.has(ref)) {
        refs.set(ref, { ref, nodeId: ref, type: 'pref', label: text, date: latestDateValue });
      }
    }
    pockets.push({ name: entry.name, data, blocks });
  }
  return { refs, pockets };
}

function resolveSources(refs, sources) {
  const resolved = [];
  const missing = [];
  for (const raw of parseSourceList(sources)) {
    const hit = refs.get(raw);
    if (!hit) {
      missing.push(raw);
      continue;
    }
    resolved.push(hit);
  }
  return { resolved, missing };
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

function addCandidate(groups, candidate) {
  const topic = normalizeTopic(candidate.topic);
  if (!topic) return;
  let current = groups.get(topic);
  if (!current) {
    current = {
      topic,
      kind: candidate.kind,
      title: candidate.title,
      sources: new Set(),
      tags: new Set(),
      sections: {},
      updated: candidate.updated || '',
      confidence: 'inferred',
      status: 'draft',
    };
    groups.set(topic, current);
  } else if (kindPriority(candidate.kind) > kindPriority(current.kind)) {
    current.kind = candidate.kind;
    current.title = candidate.title;
  }
  for (const source of candidate.sources || []) current.sources.add(source);
  for (const tag of candidate.tags || []) current.tags.add(tag);
  for (const [section, lines] of Object.entries(candidate.sections || {})) {
    if (!current.sections[section]) current.sections[section] = [];
    for (const line of lines) {
      if (!current.sections[section].includes(line)) current.sections[section].push(line);
    }
  }
  if (candidate.updated && (!current.updated || candidate.updated > current.updated)) {
    current.updated = candidate.updated;
  }
}

/**
 * 从工作区候选子图构建 K 提案。默认只返回差异，不写文件。
 */
function buildKnowledge(root, options = {}) {
  const manifest = readManifest(root);
  const sourceIndex = buildSourceIndex(root, manifest);
  const groups = new Map();

  for (const pocket of sourceIndex.pockets) {
    for (const block of pocket.blocks) {
      const tags = (block.tags || []).map((tag) => String(tag).trim()).filter(Boolean);
      const files = (extractFilesFromBlock(block) || []).map((file) => String(file).replace(/\\/g, '/'));
      const anchor = tags[0] ? pocket.name + ':tag:' + tags[0]
        : (files[0] ? pocket.name + ':file:' + files[0] : null);
      if (!anchor) continue;
      const topic = normalizeTopic(tags[0] || files[0]);
      if (!topic) continue;
      const baseSources = [pocket.name + ':T' + block.id, anchor];
      const add = (kind, text) => {
        const clean = String(text || '').replace(/^[-*]\s*/, '').replace(/^❓\s*/, '').trim();
        if (clean.length < 4) return;
        const section = sectionFor(kind);
        addCandidate(groups, {
          topic,
          kind,
          title: truncateTitle(clean, topic),
          sources: baseSources,
          tags,
          sections: { [section]: ['- ' + clean] },
          updated: whenDateOf(block) || '',
        });
      };
      for (const item of (block.sections && block.sections.Pitfalls) || []) add('pitfall', item);
      for (const item of (block.sections && block.sections.Uncertain) || []) {
        if (String(item).includes('❓')) add('concept', item);
      }
      for (const item of (block.sections && block.sections['Decisions & Constraints']) || []) {
        add('decision', item);
      }
    }
  }

  // 跨口袋同 ADR 标题 → 一个综合 decision K（单口袋 ADR 不晋升，避免复制 decisions.md）。
  const adrGroups = new Map();
  for (const pocket of sourceIndex.pockets) {
    for (const adr of pocket.data.decisions.adrs) {
      const key = normalizeKey(adr.title);
      if (!key) continue;
      if (!adrGroups.has(key)) adrGroups.set(key, []);
      adrGroups.get(key).push({ pocket: pocket.name, adr });
    }
  }
  for (const group of adrGroups.values()) {
    if (new Set(group.map((item) => item.pocket)).size < 2) continue;
    const first = group[0].adr;
    addCandidate(groups, {
      topic: normalizeTopic(first.title),
      kind: 'decision',
      title: truncateTitle(first.title, normalizeTopic(first.title)),
      sources: group.flatMap((item) => [
        item.pocket + ':ADR-' + item.adr.id,
        ...(sourceIndex.refs.has(item.pocket + ':T' + item.adr.createdAt)
          ? [item.pocket + ':T' + item.adr.createdAt] : []),
      ]),
      tags: [],
      sections: { Summary: ['- ' + (first.decision || first.title)] },
      updated: latestDate(group.map((item) => {
        const hit = sourceIndex.refs.get(item.pocket + ':ADR-' + item.adr.id);
        return hit ? hit.date : null;
      })) || '',
    });
  }

  // 跨口袋同需求文本 → concept K。
  const reqGroups = new Map();
  for (const pocket of sourceIndex.pockets) {
    for (const req of pocket.data.requirements.items) {
      const key = normalizeKey(req.text);
      if (!key) continue;
      if (!reqGroups.has(key)) reqGroups.set(key, []);
      reqGroups.get(key).push({ pocket: pocket.name, req });
    }
  }
  for (const group of reqGroups.values()) {
    if (new Set(group.map((item) => item.pocket)).size < 2) continue;
    const first = group[0].req;
    const baseTopic = normalizeTopic(first.text);
    const topic = first.tags && first.tags[0]
      ? first.tags[0]
      : 'req/' + (baseTopic ? baseTopic.slice(0, 40) : 'unknown');
    addCandidate(groups, {
      topic: normalizeTopic(topic),
      kind: 'concept',
      title: truncateTitle(first.text, normalizeTopic(topic)),
      sources: group.flatMap((item) => [
        item.pocket + ':R' + item.req.id,
        ...(item.req.openedAt && sourceIndex.refs.has(item.pocket + ':T' + item.req.openedAt)
          ? [item.pocket + ':T' + item.req.openedAt] : []),
      ]),
      tags: first.tags || [],
      sections: { Facts: ['- ' + first.text] },
      updated: latestDate(group.map((item) => {
        const hit = sourceIndex.refs.get(item.pocket + ':R' + item.req.id);
        return hit ? hit.date : null;
      })) || '',
    });
  }

  // 跨口袋同偏好 key+value → reference K。
  const prefGroups = new Map();
  for (const pocket of sourceIndex.pockets) {
    const latestT = pocket.data.preferences && pocket.data.preferences.latestT;
    for (const text of (pocket.data.preferences && pocket.data.preferences.items) || []) {
      const colon = text.indexOf(':');
      const key = normalizeKey(colon > -1 ? text.slice(0, colon) : text);
      const value = colon > -1 ? normalizeKey(text.slice(colon + 1)) : '';
      if (!key) continue;
      const groupKey = key + '\u0000' + value;
      if (!prefGroups.has(groupKey)) prefGroups.set(groupKey, []);
      prefGroups.get(groupKey).push({ pocket: pocket.name, key, value, latestT, text });
    }
  }
  for (const group of prefGroups.values()) {
    if (new Set(group.map((item) => item.pocket)).size < 2) continue;
    const first = group[0];
    addCandidate(groups, {
      topic: 'pref/' + first.key,
      kind: 'reference',
      title: first.text,
      sources: group.flatMap((item) => [
        item.pocket + ':pref:' + item.key,
        ...(item.latestT && sourceIndex.refs.has(item.pocket + ':T' + item.latestT)
          ? [item.pocket + ':T' + item.latestT] : []),
      ]),
      tags: [],
      sections: { Facts: ['- ' + first.text] },
      updated: latestDate(group.map((item) => {
        const hit = sourceIndex.refs.get(item.pocket + ':T' + item.latestT);
        return hit ? hit.date : null;
      })) || '',
    });
  }

  const candidates = [...groups.values()]
    .map((candidate) => ({
      ...candidate,
      sources: uniqueSources([...candidate.sources]),
      tags: [...candidate.tags],
    }))
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.topic.localeCompare(b.topic))
    .slice(0, typeof options.max === 'number' ? options.max : MAX_CANDIDATES);

  const kb = readKnowledgeBase(root);
  const byTopic = new Map();
  for (const note of kb.notes) {
    const key = normalizeTopic(note.topic);
    if (key) byTopic.set(key, note);
  }

  const proposals = [];
  for (const candidate of candidates) {
    const existing = byTopic.get(candidate.topic);
    if (!existing) {
      proposals.push({ proposal: 'add', ...candidate });
      continue;
    }
    const existingSources = new Set(existing.sources);
    const newSources = candidate.sources.filter((source) => !existingSources.has(source));
    const claimsOf = (value) => (value.sections && value.sections.Decisions ? value.sections.Decisions : [])
      .map((line) => normalizeKey(line));
    const existingClaims = claimsOf(existing);
    const candidateClaims = claimsOf(candidate);
    const conflicting = existingClaims.length > 0 && candidateClaims.length > 0
      && !existingClaims.some((claim) => candidateClaims.includes(claim));
    if (conflicting) {
      proposals.push({ proposal: 'conflict', existingId: existing.id, ...candidate });
    } else if (newSources.length === 0) {
      proposals.push({ proposal: 'duplicate', existingId: existing.id, ...candidate });
    } else {
      proposals.push({ proposal: 'update', existingId: existing.id, ...candidate });
    }
  }

  const counts = { add: 0, update: 0, duplicate: 0, conflict: 0 };
  for (const proposal of proposals) counts[proposal.proposal] += 1;
  return {
    present: kb.present,
    notes: kb.notes.length,
    candidates,
    proposals,
    counts,
    maxId: kb.maxId,
  };
}

function appendUnique(target, values) {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

/**
 * 应用提案：只写 add / update；duplicate / conflict 永远留给人处理。
 */
function applyKnowledge(root, options = {}) {
  const build = buildKnowledge(root, options);
  const kb = readKnowledgeBase(root);
  const notes = kb.notes.map((note) => ({
    ...note,
    meta: { ...note.meta },
    sections: Object.fromEntries(Object.entries(note.sections || {}).map(([key, value]) => [key, value.slice()])),
  }));
  const byTopic = new Map();
  for (const note of notes) {
    const key = normalizeTopic(note.topic);
    if (key) byTopic.set(key, note);
  }
  const manifest = readManifest(root);
  const sourceIndex = buildSourceIndex(root, manifest);
  let next = nextKnowledgeNumber(notes);
  const result = {
    applied: false,
    added: 0,
    updated: 0,
    activated: 0,
    skipped: 0,
    conflicts: 0,
    duplicates: 0,
    missingSources: [],
    notes,
    dir: knowledgeDir(root),
  };

  for (const proposal of build.proposals) {
    if (proposal.proposal === 'conflict') {
      result.conflicts += 1;
      result.skipped += 1;
      continue;
    }
    if (proposal.proposal === 'duplicate') {
      result.duplicates += 1;
      result.skipped += 1;
      continue;
    }
    const { resolved, missing } = resolveSources(sourceIndex.refs, proposal.sources);
    if (missing.length > 0) result.missingSources.push(...missing);
    const date = latestDate(resolved.map((item) => item.date)) || proposal.updated || '';
    const sources = uniqueSources(proposal.sources);
    const tags = parseTagList(proposal.tags || []);

    if (proposal.proposal === 'update' && proposal.existingId) {
      const existing = notes.find((note) => note.id === proposal.existingId);
      if (!existing) {
        result.skipped += 1;
        continue;
      }
      existing.sources = uniqueSources(existing.sources.concat(sources));
      existing.meta.sources = existing.sources.join(', ');
      existing.tags = [...new Set(existing.tags.concat(tags))];
      existing.meta.tags = existing.tags.join(', ');
      if (date && (!existing.updated || date > existing.updated)) existing.updated = date;
      existing.meta.updated = existing.updated;
      for (const [section, lines] of Object.entries(proposal.sections || {})) {
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
    const confidence = status === 'active' ? (resolved.length >= 2 ? 'confirmed' : 'inferred') : 'inferred';
    const note = createKnowledgeNote(
      'K-' + String(next++).padStart(4, '0'),
      proposal.title || proposal.topic,
      {
        topic: proposal.topic,
        kind: proposal.kind || 'concept',
        status,
        confidence,
        sources: sources.join(', '),
        tags: tags.join(', '),
        updated: date,
        supersedes: '',
        conflicts: '',
      },
      proposal.sections || {}
    );
    notes.push(note);
    const key = normalizeTopic(note.topic);
    if (key) byTopic.set(key, note);
    result.added += 1;
    if (status === 'active') result.activated += 1;
  }

  notes.sort((a, b) => (knowledgeIdNumber(a.id) || 0) - (knowledgeIdNumber(b.id) || 0));
  if (result.added > 0 || result.updated > 0) {
    writeKnowledgeBase(root, notes);
    result.applied = true;
  }
  return result;
}

function listKnowledge(root, options = {}) {
  const kb = readKnowledgeBase(root);
  let notes = kb.notes;
  if (options.status) notes = notes.filter((note) => note.status === options.status);
  if (options.kind) notes = notes.filter((note) => note.kind === options.kind);
  if (options.topic) {
    const topic = normalizeTopic(options.topic);
    notes = notes.filter((note) => normalizeTopic(note.topic) === topic);
  }
  const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : 20;
  const total = notes.length;
  const results = (limit === 0 ? notes : notes.slice(0, limit)).map((note) => ({
    id: note.id,
    title: note.title,
    topic: note.topic,
    kind: note.kind,
    status: note.status,
    confidence: note.confidence,
    sources: note.sources.length,
    updated: note.updated,
  }));
  return { present: kb.present, total, limit, results };
}

function viewKnowledge(root, id) {
  const kb = readKnowledgeBase(root);
  const note = kb.notes.find((item) => item.id === id);
  if (!note) return null;
  return note;
}

function verifyKnowledge(root, options = {}) {
  const kb = readKnowledgeBase(root);
  const manifest = readManifest(root);
  const sourceIndex = buildSourceIndex(root, manifest);
  const issues = kb.issues.slice();
  for (const issue of kb.indexDrift) {
    issues.push({ code: 'k-index-drift', severity: 'warning', message: `${issue.id}: ${issue.problem}` });
  }
  for (const issue of validateKnowledgeDocument(kb.notes, { scope: 'workspace' })) {
    issues.push(issue);
  }
  let missingSources = 0;
  for (const note of kb.notes) {
    const { missing } = resolveSources(sourceIndex.refs, note.sources);
    for (const ref of missing) {
      missingSources += 1;
      issues.push({
        code: 'k-source',
        severity: 'error',
        message: `${note.id} references missing source "${ref}"`,
      });
    }
  }
  const errors = issues.filter((issue) => issue.severity === 'error' || issue.severity === 'critical').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    ok: errors === 0,
    present: kb.present,
    notes: kb.notes.length,
    maxId: kb.maxId,
    errors,
    warnings,
    missingSources,
    issues,
  };
}

/** status / audit 用的轻量只读摘要：不解析所有来源。 */
function inspectKnowledge(root) {
  const kb = readKnowledgeBase(root);
  const byStatus = {};
  const byKind = {};
  let disputed = 0;
  for (const note of kb.notes) {
    byStatus[note.status] = (byStatus[note.status] || 0) + 1;
    byKind[note.kind] = (byKind[note.kind] || 0) + 1;
    if (note.confidence === 'disputed') disputed += 1;
  }
  return {
    present: kb.present,
    dir: kb.dir,
    notes: kb.notes.length,
    maxId: kb.maxId,
    byStatus,
    byKind,
    active: byStatus.active || 0,
    draft: byStatus.draft || 0,
    stale: byStatus.stale || 0,
    disputed,
    indexDrift: kb.indexDrift.length,
    issues: kb.issues.length,
  };
}

module.exports = {
  KNOWLEDGE_DIR,
  KNOWLEDGE_INDEX,
  KNOWLEDGE_CACHE,
  knowledgeDir,
  knowledgeIndexPath,
  knowledgeCachePath,
  whenDateOf,
  readKnowledgeBase,
  knowledgeSignature,
  writeKnowledgeBase,
  buildSourceIndex,
  resolveSources,
  buildKnowledge,
  applyKnowledge,
  listKnowledge,
  viewKnowledge,
  verifyKnowledge,
  inspectKnowledge,
  noteFileName,
};
