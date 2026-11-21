'use strict';

/**
 * ContextPocket yuan — workspace 审计视图（阶段 2）
 *
 * 只读地把"现在能不能安全接手"讲清楚：
 *   1. Health   verify --deep 的结果、repo map 漂移、索引新鲜度、待复核 merge
 *   2. Activity 指定窗口内每个口袋发生了什么（轮次 / 新 ADR / 关闭的需求）
 *   3. Open     当前仍然悬着的东西（未关闭需求、❓ 待确认、冲突、复核）
 *
 * 不写任何文件：索引只检查签名，不触发重建；repo map 只比对缓存。
 */

const { readManifest, resolvePocket, parsePocketAll } = require('./workspace');
const { verifyWorkspace, pendingMergeReviews } = require('./diagnostics');
const { inspectIndex } = require('./workspace-index');
const { whenDate } = require('./recap');

function positiveInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function buildWindow(options) {
  return {
    sinceT: positiveInt(options.sinceT),
    untilT: positiveInt(options.untilT),
    fromDate: options.fromDate || undefined,
    toDate: options.toDate || undefined,
  };
}

function inTWindow(id, window) {
  if (window.sinceT && id < window.sinceT) return false;
  if (window.untilT && id > window.untilT) return false;
  return true;
}

function hasDateWindow(window) {
  return !!(window.fromDate || window.toDate);
}

function inDateWindow(date, window) {
  if (!hasDateWindow(window)) return true;
  if (!date) return false;
  if (window.fromDate && date < window.fromDate) return false;
  if (window.toDate && date > window.toDate) return false;
  return true;
}

function rangeLabel(window) {
  const parts = [];
  if (window.sinceT || window.untilT) {
    parts.push('T' + (window.sinceT || '1') + '–T' + (window.untilT || 'latest'));
  }
  if (hasDateWindow(window)) {
    parts.push((window.fromDate || 'start') + ' → ' + (window.toDate || 'today'));
  }
  return parts.length > 0 ? parts.join(' · ') : 'all history';
}

function blockWindowDate(block) {
  return whenDate(block) || '';
}

function auditPocket(entry, resolved, window) {
  const base = { name: entry.name, path: entry.path };
  let data;
  try {
    data = parsePocketAll(resolved.pocketDir);
  } catch (e) {
    return Object.assign(base, { ok: false, error: e.message });
  }

  const turnDates = new Map();
  for (const block of data.log.blocks) turnDates.set(block.id, blockWindowDate(block));

  const turns = data.log.blocks.filter((block) =>
    inTWindow(block.id, window) && inDateWindow(blockWindowDate(block), window));

  const uncertain = [];
  const conflicts = [];
  for (const block of data.log.blocks) {
    for (const item of block.sections.Uncertain || []) {
      uncertain.push({ tId: block.id, text: String(item).replace(/^❓\s*/, '') });
    }
    for (const item of block.sections.Conflicts || []) {
      conflicts.push({ tId: block.id, text: String(item) });
    }
  }

  const openRequirements = data.requirements.items
    .filter((item) => item.status === 'Open')
    .map((item) => ({ id: item.id, text: item.text, uncertain: !!item.uncertain }));

  const adrsInRange = data.decisions.adrs.filter((adr) =>
    inTWindow(adr.createdAt, window)
    && inDateWindow(turnDates.get(adr.createdAt) || '', window));

  const closed = data.requirements.items
    .filter((item) => {
      const at = item.status === 'Done' ? item.completedAt : (item.status === 'Cancelled' ? item.cancelledAt : null);
      if (!at) return false;
      return inTWindow(at, window) && inDateWindow(turnDates.get(at) || '', window);
    })
    .map((item) => ({ id: item.id, text: item.text, status: item.status }));

  const ids = turns.map((block) => block.id).sort((a, b) => a - b);

  return Object.assign(base, {
    ok: true,
    latestT: data.log.latestT,
    turns: turns.length,
    firstT: ids.length > 0 ? ids[0] : null,
    lastT: ids.length > 0 ? ids[ids.length - 1] : null,
    recent: turns.slice(-5).reverse().map((block) => ({
      id: block.id,
      when: blockWindowDate(block) || null,
      gist: block.gist || '',
    })),
    openRequirements,
    uncertain,
    conflicts,
    adrs: data.decisions.adrs.length,
    adrsInRange: adrsInRange.map((adr) => ({ id: adr.id, title: adr.title })),
    closed,
    reviews: pendingMergeReviews(resolved.pocketDir),
  });
}

function render(result) {
  const lines = [
    '# Audit · ' + result.workspace,
    '',
    '- Range: ' + result.range,
    '- Pockets: ' + (result.pockets.length > 0 ? result.pockets.map((p) => p.name).join(', ') : '(none)'),
    '',
    '## Health',
    '- verify: ' + (result.health.verifyOk ? 'ok' : 'failed')
      + ' · ' + result.health.errors.length + ' error(s)'
      + ' · ' + result.health.warnings.length + ' warning(s)',
  ];

  const repo = result.health.repoMap;
  if (repo) {
    lines.push('- repo map: ' + (repo.ok
      ? (repo.missing ? 'missing (run "context-pocket-yuan map update")' : 'in sync')
      : 'drift · added ' + repo.added.length + ', removed ' + repo.removed.length + ', changed ' + repo.changed.length));
  }

  const index = result.health.index;
  lines.push('- index: ' + (index.present
    ? (index.fresh ? 'fresh' : 'stale (run "context-pocket-yuan workspace index")') + ' · ' + index.docsCount + ' doc(s)'
    : 'missing (run "context-pocket-yuan workspace index")'));
  lines.push('- pending merge reviews: ' + result.totals.pendingReviews);

  for (const warning of result.health.warnings) lines.push('- ⚠️ ' + warning);
  for (const error of result.health.errors) lines.push('- ❌ ' + error);
  lines.push('');

  lines.push('## Activity');
  for (const pocket of result.pockets) {
    lines.push('### ' + pocket.name);
    if (!pocket.ok) {
      lines.push('- unavailable: ' + pocket.error);
      lines.push('');
      continue;
    }
    const span = pocket.turns > 0
      ? 'T' + pocket.firstT + ' → T' + pocket.lastT + ' · ' + pocket.turns + ' turn(s)'
      : '(none in range)';
    lines.push('- ' + span);
    for (const turn of pocket.recent) {
      lines.push('- T' + turn.id + (turn.when ? ' · ' + turn.when : '') + ' · ' + turn.gist);
    }
    if (pocket.adrsInRange.length > 0) {
      lines.push('- ADRs in range: ' + pocket.adrsInRange.map((adr) => 'ADR-' + adr.id).join(', '));
    }
    if (pocket.closed.length > 0) {
      lines.push('- Closed in range: ' + pocket.closed.map((req) => 'R' + req.id).join(', '));
    }
    lines.push('');
  }

  lines.push('## Open items');
  let openCount = 0;
  for (const pocket of result.pockets) {
    if (!pocket.ok) continue;
    const items = [];
    for (const req of pocket.openRequirements) {
      items.push('R' + req.id + ': ' + req.text + (req.uncertain ? ' ❓' : ''));
    }
    for (const item of pocket.uncertain) items.push('❓ T' + item.tId + ': ' + item.text);
    for (const conflict of pocket.conflicts) items.push('⚠️ T' + conflict.tId + ': ' + conflict.text);
    for (const review of pocket.reviews) items.push('review ' + review.file + '#' + review.id);
    if (items.length === 0) continue;
    openCount += items.length;
    lines.push('### ' + pocket.name);
    for (const item of items) lines.push('- ' + item);
    lines.push('');
  }
  if (openCount === 0) {
    lines.push('- (none)');
    lines.push('');
  }

  return lines.join('\n').replace(/\n*$/, '\n');
}

/**
 * @param {string} root
 * @param {object} [options]
 * @param {string|number} [options.sinceT]
 * @param {string|number} [options.untilT]
 * @param {string} [options.fromDate] YYYY-MM-DD
 * @param {string} [options.toDate] YYYY-MM-DD
 * @param {string} [options.pockets] 逗号分隔的口袋名
 */
function auditWorkspace(root, options = {}) {
  const manifest = readManifest(root);
  const window = buildWindow(options);
  const verify = verifyWorkspace(root, { deep: true });
  const index = inspectIndex(root);

  let entries = manifest.pockets;
  if (options.pockets) {
    const wanted = new Set(String(options.pockets).split(',').map((name) => name.trim()).filter(Boolean));
    entries = manifest.pockets.filter((entry) => wanted.has(entry.name));
  }

  const pockets = entries.map((entry) => {
    const resolved = resolvePocket(root, entry);
    if (!resolved.exists) {
      return { name: entry.name, path: entry.path, ok: false, error: 'missing ContextPocket/log.md' };
    }
    return auditPocket(entry, resolved, window);
  });

  const sum = (key) => pockets.reduce((total, pocket) => total + (pocket.ok && pocket[key] ? pocket[key].length || 0 : 0), 0);
  const totals = {
    pockets: pockets.length,
    turns: pockets.reduce((total, pocket) => total + (pocket.ok ? pocket.turns : 0), 0),
    openRequirements: sum('openRequirements'),
    uncertain: sum('uncertain'),
    conflicts: sum('conflicts'),
    adrs: pockets.reduce((total, pocket) => total + (pocket.ok ? pocket.adrs : 0), 0),
    adrsInRange: sum('adrsInRange'),
    closed: sum('closed'),
    pendingReviews: sum('reviews'),
  };

  const result = {
    ok: verify.ok,
    root,
    workspace: manifest.name,
    range: rangeLabel(window),
    health: {
      verifyOk: verify.ok,
      errors: verify.errors,
      warnings: verify.warnings,
      missingPockets: verify.checks.missingPockets,
      repoMap: verify.checks.repoMap,
      index,
      pendingReviews: totals.pendingReviews,
    },
    totals,
    pockets,
  };
  result.content = render(result);
  return result;
}

module.exports = {
  auditWorkspace,
};
