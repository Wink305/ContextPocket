'use strict';

/**
 * ContextPocket yuan — 生命周期（forget）
 *
 * 把最旧的一批轮次从 log.md 搬进 log-archive.md。归档不是删除：
 * `parseLogAll` 依然读得到，search / recap / context 也都还能命中。
 *
 * 默认只出计划（plan），`--apply` 才写盘；真正的搬运交给 quan 的
 * `writer.archiveLog()`（先 verify、备份、归档后复检、失败回滚），
 * yuan 这一层只负责"哪些口袋、切在哪一轮"。
 *
 * 选区三选一（同时给多个直接报错）：
 *   --before T<n>       归档 id 小于 n 的连续前缀
 *   --before-date <d>   归档日期早于 d 的连续前缀（没有 WHEN 的轮次会截断前缀）
 *   --keep-last <n>     只保留最近 n 轮
 *
 * 前缀语义是刻意的：归档只从最旧的一端连续切，绝不从中间挖洞。
 */

const { readManifest, resolvePocket } = require('./workspace');
const { parseLog } = require('./parser');
const { archiveLog } = require('./writer');
const { whenDate } = require('./recap');

function parsePositiveInt(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(label + ' must be a positive integer (got ' + value + ')');
  }
  return number;
}

function parseBeforeT(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const match = /^T?(\d+)$/i.exec(String(value).trim());
  if (!match) throw new Error('--before must be a T id like T12 (got ' + value + ')');
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('--before must be a positive T id (got ' + value + ')');
  }
  return number;
}

function parseBeforeDate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('--before-date must be YYYY-MM-DD (got ' + value + ')');
  }
  return text;
}

function selectPockets(root, wanted) {
  const manifest = readManifest(root);
  if (!wanted) return { manifest, entries: manifest.pockets, unknown: [] };
  const names = String(wanted).split(',').map((name) => name.trim()).filter(Boolean);
  const known = new Set(manifest.pockets.map((entry) => entry.name));
  const unknown = names.filter((name) => !known.has(name));
  return {
    manifest,
    entries: manifest.pockets.filter((entry) => names.includes(entry.name)),
    unknown,
  };
}

/**
 * 计算从最旧一端连续切掉多少轮。
 * @param {object[]} blocks log.md 的 T-block（按文件顺序）
 * @param {object} selector { beforeT, beforeDate, keepLast }
 * @returns {{cut: number, reason: string|null}}
 */
function cutFor(blocks, selector) {
  if (selector.keepLast !== undefined) {
    const cut = Math.max(0, blocks.length - selector.keepLast);
    return {
      cut,
      reason: cut === 0 ? 'only ' + blocks.length + ' turn(s); keep-last is ' + selector.keepLast : null,
    };
  }

  if (selector.beforeT !== undefined) {
    let cut = 0;
    while (cut < blocks.length && blocks[cut].id < selector.beforeT) cut += 1;
    return {
      cut,
      reason: cut === 0 ? 'no turn older than T' + selector.beforeT : null,
    };
  }

  let cut = 0;
  while (cut < blocks.length) {
    const date = whenDate(blocks[cut]);
    // 没有日期的轮次不能证明"更旧"：停在这里，让前缀保持可解释
    if (!date || date >= selector.beforeDate) break;
    cut += 1;
  }
  return {
    cut,
    reason: cut === 0 ? 'no turn dated before ' + selector.beforeDate : null,
  };
}

function forgetPocket(root, entry, selector, apply) {
  const resolved = resolvePocket(root, entry);
  const base = { name: entry.name, path: entry.path };
  if (!resolved.exists) {
    return Object.assign(base, { ok: false, error: 'missing ContextPocket/log.md' });
  }

  let blocks;
  try {
    blocks = parseLog(resolved.pocketDir).blocks;
  } catch (e) {
    return Object.assign(base, { ok: false, error: e.message });
  }

  const { cut, reason } = cutFor(blocks, selector);
  const kept = blocks.length - cut;
  const planned = blocks.slice(0, cut);
  const result = Object.assign(base, {
    ok: true,
    blocks: blocks.length,
    plannedArchived: cut,
    kept,
    archivedIds: planned.map((block) => block.id),
    applied: false,
    archivedCount: 0,
    skipped: cut === 0,
    reason: reason || null,
  });

  if (!apply) return result;

  if (cut === 0) return result;
  if (kept < 1) {
    return Object.assign(result, {
      ok: false,
      error: 'refusing to archive every turn (log.md must keep at least one)',
    });
  }

  try {
    // archiveLog 只按"保留最后 n 轮"切；前缀语义已经在这里算好
    const archived = archiveLog(resolved.pocketDir, { keepLast: kept });
    if (!archived.dryRun && archived.archivedCount !== cut) {
      return Object.assign(result, {
        ok: false,
        error: 'archive moved ' + archived.archivedCount + ' turn(s), expected ' + cut
          + ' (log.md changed while planning?)',
      });
    }
    return Object.assign(result, {
      applied: true,
      archivedCount: archived.archivedCount,
      archivedIds: archived.archivedIds,
    });
  } catch (e) {
    return Object.assign(result, { ok: false, error: e.message });
  }
}

/**
 * @param {string} root
 * @param {object} [options]
 * @param {string|number} [options.beforeT]   --before T<n>
 * @param {string} [options.beforeDate]       --before-date YYYY-MM-DD
 * @param {string|number} [options.keepLast]  --keep-last <n>
 * @param {string} [options.pockets]          comma-separated pocket names
 * @param {boolean} [options.apply]           write log-archive.md (default: plan only)
 */
function forgetWorkspace(root, options = {}) {
  const selector = {
    beforeT: parseBeforeT(options.beforeT),
    beforeDate: parseBeforeDate(options.beforeDate),
    keepLast: parsePositiveInt(options.keepLast, '--keep-last'),
  };
  const given = ['beforeT', 'beforeDate', 'keepLast'].filter((key) => selector[key] !== undefined);
  if (given.length === 0) {
    throw new Error('forget needs one selector: --before <Tn>, --before-date <YYYY-MM-DD> or --keep-last <n>');
  }
  if (given.length > 1) {
    throw new Error('forget takes only one selector (got ' + given.join(', ') + ')');
  }

  const apply = !!options.apply;
  const { manifest, entries, unknown } = selectPockets(root, options.pockets);
  const pockets = entries.map((entry) => forgetPocket(root, entry, selector, apply));
  for (const name of unknown) {
    pockets.push({ name, ok: false, error: 'pocket not found in workspace manifest' });
  }

  const failed = pockets.filter((pocket) => !pocket.ok).length;
  const plannedArchived = pockets.reduce((sum, pocket) => sum + (pocket.plannedArchived || 0), 0);
  const archived = pockets.reduce((sum, pocket) => sum + (pocket.archivedCount || 0), 0);

  return {
    ok: failed === 0,
    root,
    workspace: manifest.name,
    mode: apply ? 'apply' : 'plan',
    selector,
    totals: {
      pockets: pockets.length,
      plannedArchived,
      archived,
      failed,
    },
    pockets,
  };
}

module.exports = {
  forgetWorkspace,
};
