'use strict';

/**
 * ContextPocket yuan — recap
 *
 * 只读的周期回顾：按 T 区间或日期窗口汇总多个口袋的轮次、当前状态、
 * 未关闭需求与 ADR。预算不够时从最旧的轮次开始裁，当前事实保留。
 */

const { readManifest, resolvePocket, parsePocketAll } = require('./workspace');
const { estimateTokens } = require('./budget');
const { stripPlaceholders } = require('./core');

function whenDate(block) {
  const when = block.when;
  if (!when) return '';
  if (when.kind === 'range') return String(when.from || '').slice(0, 10);
  if (when.kind === 'day') return String(when.date || '').slice(0, 10);
  if (when.kind === 'instant') return String(when.from || '').slice(0, 10);
  return '';
}

function inRange(block, options) {
  if (options.sinceT && block.id < options.sinceT) return false;
  if (options.untilT && block.id > options.untilT) return false;
  if (options.fromDate || options.toDate) {
    const when = whenDate(block);
    if (!when) return false;
    if (options.fromDate && when < options.fromDate) return false;
    if (options.toDate && when > options.toDate) return false;
  }
  return true;
}

function actionSummary(block) {
  const action = (block.sections && block.sections.Action) || [];
  if (Array.isArray(action) && action.length > 0) return action[0];
  return '';
}

function collect(root, options) {
  const manifest = readManifest(root);
  const wanted = options.pockets
    ? new Set(String(options.pockets).split(',').map((name) => name.trim()).filter(Boolean))
    : null;
  const pockets = [];

  for (const entry of manifest.pockets) {
    if (wanted && !wanted.has(entry.name)) continue;
    const resolved = resolvePocket(root, entry);
    if (!resolved.exists) {
      pockets.push({ name: entry.name, ok: false, error: 'missing ContextPocket/log.md' });
      continue;
    }
    let data;
    try {
      data = parsePocketAll(resolved.pocketDir);
    } catch (e) {
      pockets.push({ name: entry.name, ok: false, error: e.message });
      continue;
    }
    const blocks = data.log.blocks.filter((block) => inRange(block, options));
    pockets.push({
      name: entry.name,
      ok: true,
      blocks,
      stateSummary: stripPlaceholders(data.state.summary),
      nextSteps: stripPlaceholders(data.state.nextSteps),
      openRequirements: data.requirements.items
        .filter((item) => item.status === 'Open')
        .map((item) => 'R' + item.id + ': ' + item.text),
      adrs: data.decisions.adrs.map((adr) => 'ADR-' + adr.id + ': ' + adr.title),
    });
  }

  return { manifest, pockets };
}

function rangeLabel(options) {
  const t = options.sinceT || options.untilT
    ? 'T' + (options.sinceT || '1') + '–T' + (options.untilT || 'latest')
    : null;
  const d = options.fromDate || options.toDate
    ? (options.fromDate || 'start') + ' → ' + (options.toDate || 'today')
    : null;
  return t || d || 'all history';
}

function render(root, collected, options) {
  const { manifest, pockets } = collected;
  const lines = [
    '# Recap · ' + manifest.name,
    '',
    '- Range: ' + rangeLabel(options),
    '- Pockets: ' + pockets.map((p) => p.name).join(', '),
    '',
  ];
  for (const pocket of pockets) {
    lines.push('## ' + pocket.name);
    if (!pocket.ok) {
      lines.push('- unavailable: ' + pocket.error);
      lines.push('');
      continue;
    }
    lines.push('### Turns in range (' + pocket.blocks.length + ')');
    if (pocket.blocks.length === 0) {
      lines.push('- (none)');
    } else {
      for (const block of pocket.blocks) {
        const when = whenDate(block);
        const action = actionSummary(block);
        lines.push('- T' + block.id + (when ? ' · ' + when : '') + ' · ' + (block.gist || '')
          + (action ? ' — ' + action : ''));
      }
    }
    lines.push('');
    lines.push('### Current');
    if (pocket.stateSummary.length > 0) lines.push('- State: ' + pocket.stateSummary.join(' / '));
    if (pocket.nextSteps.length > 0) lines.push('- Next: ' + pocket.nextSteps.join(' / '));
    for (const req of pocket.openRequirements) lines.push('- Open ' + req);
    for (const adr of pocket.adrs) lines.push('- ' + adr);
    lines.push('');
  }
  return lines.join('\n');
}

function buildRecap(root, options = {}) {
  const maxTokens = Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0
    ? Number(options.maxTokens)
    : 4000;
  const collected = collect(root, options);
  let content = render(root, collected, options);
  let removed = 0;

  while (estimateTokens(content) > maxTokens) {
    let target = null;
    for (const pocket of collected.pockets) {
      if (!pocket.ok || pocket.blocks.length === 0) continue;
      if (!target || pocket.blocks.length > target.blocks.length) target = pocket;
    }
    if (!target) break;
    target.blocks.shift();
    removed += 1;
    content = render(root, collected, options);
  }

  const estimated = estimateTokens(content);
  const overBudget = estimated > maxTokens;
  if (removed > 0 || overBudget) {
    content = content.replace(/\n*$/, '\n')
      + '\n- (recap budget: ~' + estimated + ' / ' + maxTokens + ' tokens'
      + (removed > 0 ? '; dropped ' + removed + ' oldest turn(s)' : '')
      + (overBudget ? '; current facts alone exceed the budget' : '')
      + ')\n';
  }

  return {
    ok: true,
    root,
    workspace: collected.manifest.name,
    range: rangeLabel(options),
    maxTokens,
    estimatedTokens: estimated,
    droppedTurns: removed,
    overBudget,
    pockets: collected.pockets.map((p) => ({
      name: p.name,
      ok: p.ok,
      turns: p.ok ? p.blocks.map((block) => ({ id: block.id, when: whenDate(block) || null, gist: block.gist })) : [],
      error: p.ok ? undefined : p.error,
    })),
    content,
  };
}

module.exports = {
  buildRecap,
  whenDate,
};
