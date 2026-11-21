'use strict';

/**
 * ContextPocket yuan — 记忆衰减策略（阶段 2）
 *
 * 只读地给出"哪些记忆已经变冷"的策略视图：
 *   - 轮次：早于 max-age 且不在最近 keep-last 之内的连续前缀，可以直接
 *     `forget` 归档（前缀语义，和 forget 完全一致）；
 *   - 需求 / ❓ / ADR：按它们关联轮次的时间判断是否变冷，提示先复盘；
 *   - 没有 WHEN 的轮次单独报 undated，绝不按文件 mtime 猜年龄。
 *
 * 本命令不写任何文件，也不自动执行 forget / consolidate；它只把策略和
 * 建议命令算清楚，真正动手仍由用户显式运行对应命令。
 */

const { readManifest, resolvePocket, parsePocketAll } = require('./workspace');
const { whenDate } = require('./recap');
const { todayDate } = require('./when');

function positiveInt(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(label + ' must be a non-negative integer (got ' + value + ')');
  }
  return number;
}

function shiftDays(date, days) {
  const parts = String(date).split('-').map(Number);
  const time = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const shifted = new Date(time + days * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function checkDate(value, label) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(label + ' must be YYYY-MM-DD (got ' + value + ')');
  }
  return text;
}

function decayPocket(entry, resolved, policy) {
  const base = { name: entry.name, path: entry.path };
  let data;
  try {
    data = parsePocketAll(resolved.pocketDir);
  } catch (e) {
    return Object.assign(base, { ok: false, error: e.message });
  }

  const allBlocks = data.log.blocks;
  const live = allBlocks.filter((block) => !block.archived);
  const turnDates = new Map();
  for (const block of allBlocks) turnDates.set(block.id, whenDate(block) || '');

  const undated = live.filter((block) => !whenDate(block)).length;
  const cold = (block) => {
    const date = whenDate(block);
    return !!date && date < policy.cutoff;
  };

  // 归档前缀：只从最旧一端连续切，且永远保留最新 keepLast 轮与至少一轮
  const keepFrom = Math.max(0, live.length - policy.keepLast);
  let cut = 0;
  while (cut < live.length - 1 && cut < keepFrom && cold(live[cut])) cut += 1;
  const candidates = live.slice(0, cut);

  const coldUncertain = [];
  let uncertain = 0;
  for (const block of live) {
    const items = (block.sections && block.sections.Uncertain) || [];
    uncertain += items.length;
    if (!cold(block)) continue;
    for (const item of items) {
      coldUncertain.push({ tId: block.id, text: String(item).replace(/^❓\s*/, '') });
    }
  }

  const openRequirements = data.requirements.items.filter((item) => item.status === 'Open');
  const coldRequirements = openRequirements.filter((item) => {
    const date = turnDates.get(item.openedAt) || '';
    return !!date && date < policy.cutoff;
  });

  const coldAdrs = data.decisions.adrs.filter((adr) => {
    const date = turnDates.get(adr.createdAt) || '';
    return !!date && date < policy.cutoff;
  });

  const recommendation = candidates.length > 0 && live.length >= policy.minTurns
    ? {
      pocket: entry.name,
      command: 'context-pocket-yuan forget --before T' + live[cut].id
        + ' --pockets ' + entry.name + ' --apply',
      reason: candidates.length + ' turn(s) older than ' + policy.cutoff
        + ' (keep last ' + policy.keepLast + ')',
    }
    : null;

  return Object.assign(base, {
    ok: true,
    turns: live.length,
    archived: allBlocks.length - live.length,
    undated,
    coldTurns: live.filter(cold).length,
    candidate: {
      count: candidates.length,
      fromT: candidates.length > 0 ? candidates[0].id : null,
      toT: candidates.length > 0 ? candidates[candidates.length - 1].id : null,
      keep: live.length - candidates.length,
    },
    openRequirements: openRequirements.length,
    coldRequirements: coldRequirements.map((item) => ({ id: item.id, text: item.text })),
    uncertain,
    coldUncertain,
    adrs: data.decisions.adrs.length,
    coldAdrs: coldAdrs.map((adr) => ({ id: adr.id, title: adr.title })),
    recommendation,
  });
}

function render(result) {
  const lines = [
    '# Decay · ' + result.workspace,
    '',
    '- Policy: keep last ' + result.policy.keepLast
      + ' · cold before ' + result.policy.cutoff
      + ' (' + result.policy.maxAgeDays + ' day(s) old)'
      + ' · min ' + result.policy.minTurns + ' turn(s)',
    '- Today: ' + result.policy.today,
    '',
  ];

  for (const pocket of result.pockets) {
    lines.push('## ' + pocket.name);
    if (!pocket.ok) {
      lines.push('- unavailable: ' + pocket.error);
      lines.push('');
      continue;
    }
    lines.push('- turns: ' + pocket.turns + ' · archived: ' + pocket.archived
      + ' · undated: ' + pocket.undated + ' · cold: ' + pocket.coldTurns);
    if (pocket.candidate.count > 0) {
      lines.push('- archive candidate: T' + pocket.candidate.fromT
        + '–T' + pocket.candidate.toT + ' (' + pocket.candidate.count
        + ' turn(s), keep ' + pocket.candidate.keep + ')');
    } else {
      lines.push('- archive candidate: none');
    }
    lines.push('- open requirements: ' + pocket.openRequirements
      + ' · cold: ' + pocket.coldRequirements.length);
    lines.push('- uncertain: ' + pocket.uncertain + ' · cold: ' + pocket.coldUncertain.length);
    lines.push('- ADRs: ' + pocket.adrs + ' · cold: ' + pocket.coldAdrs.length);
    if (pocket.recommendation) {
      lines.push('- recommend: ' + pocket.recommendation.command);
    } else {
      lines.push('- recommend: none');
    }
    lines.push('');
  }

  lines.push('## Recommendations');
  const recommendations = result.pockets
    .filter((pocket) => pocket.ok && pocket.recommendation)
    .map((pocket) => pocket.recommendation);
  if (recommendations.length === 0) {
    lines.push('- (none)');
  } else {
    for (const item of recommendations) lines.push('- ' + item.pocket + ': ' + item.command);
  }
  lines.push('');

  return lines.join('\n').replace(/\n*$/, '\n');
}

/**
 * @param {string} root
 * @param {object} [options]
 * @param {number} [options.maxAgeDays=180]
 * @param {number} [options.keepLast=50]
 * @param {number} [options.minTurns=10]
 * @param {string} [options.pockets] 逗号分隔的口袋名
 * @param {string} [options.today] YYYY-MM-DD（测试/回填用；默认今天）
 */
function decayWorkspace(root, options = {}) {
  const manifest = readManifest(root);
  const today = checkDate(options.today, '--today') || todayDate();
  const policy = {
    today,
    maxAgeDays: positiveInt(options.maxAgeDays, 180, '--max-age-days'),
    keepLast: positiveInt(options.keepLast, 50, '--keep-last'),
    minTurns: positiveInt(options.minTurns, 10, '--min-turns'),
  };
  policy.cutoff = shiftDays(today, -policy.maxAgeDays);

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
    return decayPocket(entry, resolved, policy);
  });

  const total = (key) => pockets.reduce((sum, pocket) => sum + (pocket.ok ? (pocket[key] || 0) : 0), 0);
  const result = {
    ok: pockets.every((pocket) => pocket.ok),
    root,
    workspace: manifest.name,
    policy,
    totals: {
      pockets: pockets.length,
      turns: total('turns'),
      archived: total('archived'),
      undated: total('undated'),
      coldTurns: total('coldTurns'),
      archiveCandidates: pockets.reduce((sum, pocket) => sum + (pocket.ok ? pocket.candidate.count : 0), 0),
      openRequirements: total('openRequirements'),
      coldRequirements: pockets.reduce((sum, pocket) => sum + (pocket.ok ? pocket.coldRequirements.length : 0), 0),
      uncertain: total('uncertain'),
      coldUncertain: pockets.reduce((sum, pocket) => sum + (pocket.ok ? pocket.coldUncertain.length : 0), 0),
      adrs: total('adrs'),
      coldAdrs: pockets.reduce((sum, pocket) => sum + (pocket.ok ? pocket.coldAdrs.length : 0), 0),
      recommendations: pockets.filter((pocket) => pocket.ok && pocket.recommendation).length,
    },
    pockets,
  };
  result.content = render(result);
  return result;
}

module.exports = {
  decayWorkspace,
};
