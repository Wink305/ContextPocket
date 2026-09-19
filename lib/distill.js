'use strict';

/**
 * ContextPocket — 旧信息蒸馏（digest）
 * 借鉴 Basic Memory 的「活文档」思路：归档不等于埋葬。
 *
 * ContextPocket 的时间线是 append-only 的，旧 T-block 归档后就被埋在
 * log-archive.md 里；本模块扫描归档与旧轮次，把仍然有价值的
 * 决策 / 坑点 / 偏好 / 待确认项 提取成一份可执行的蒸馏报告
 * （ContextPocket/digest-<date>.md），由 Agent 或用户逐条判断后
 * 合回 decisions.md / state.md / preferences.md 这些活文档。
 *
 * 报告只读不改活文档 —— 合并动作由 Agent 完成（需人工判断是否仍然有效），
 * 报告本身不是真相源，合并完可删。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const { readFileSafe } = require('./core');
const { parseLogText, parseDecisions, parseState, parsePreferences } = require('./parser');
const { readConfig } = require('./core');

const MAX_PER_CATEGORY = 50;

// ============================================================
// 工具
// ============================================================

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 提取文本关键词：拉丁词（≥4 字符）+ CJK 连续段（≥2 字符）
 */
function keywords(text) {
  const lower = String(text || '').toLowerCase().replace(/\\/g, '/');
  const words = (lower.match(/[a-z0-9][a-z0-9._\-]{3,}/g) || [])
    .map(w => w.replace(/[._\-]+$/, ''));
  const cjk = (lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g) || []);
  return [...new Set([...words, ...cjk])].filter(k => k.length >= 2);
}

/**
 * 候选是否已被现有条目覆盖
 * @returns {string|null} 覆盖它的现有条目，未覆盖返回 null
 */
function findCover(candidate, existingEntries) {
  const kws = keywords(candidate);
  if (kws.length === 0) return null;
  let latinHits = 0;
  let cjkHits = 0;
  for (const entry of existingEntries) {
    const hay = String(entry || '').toLowerCase().replace(/\\/g, '/');
    let score = 0;
    for (const kw of kws) {
      if (hay.includes(kw)) {
        score++;
        if (/^[a-z0-9]/.test(kw)) latinHits++;
        else cjkHits++;
      }
    }
    // 关键词命中过半（或命中了含拉丁关键词）视为可能重复
    if (score > 0 && (score >= Math.ceil(kws.length / 2) || latinHits > 0)) {
      return entry;
    }
  }
  return null;
}

function collectSection(blocks, section) {
  const out = [];
  for (const b of blocks) {
    const items = (b.sections && b.sections[section]) || [];
    for (const item of items) {
      out.push({ tId: b.id, text: item });
    }
  }
  return out;
}

// ============================================================
// 蒸馏主函数
// ============================================================

/**
 * 扫描归档与旧轮次，生成蒸馏报告
 * @param {string} pocketDir
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - 只返回结果，不写报告文件
 * @param {number} [opts.recentKeep] - log.md 中最近 N 个 T 视为新信息，不参与蒸馏（默认取 config.recent_keep）
 * @returns {object} { scannedBlocks, tRange, candidates: {decisions, pitfalls, preferences, uncertain}, tagStats, outFile, dryRun }
 */
function distill(pocketDir, opts = {}) {
  const config = readConfig(pocketDir);
  const recentKeep = typeof opts.recentKeep === 'number'
    ? opts.recentKeep
    : (typeof config.recent_keep === 'number' ? config.recent_keep : 30);

  // --- 收集源块：log-archive.md 全部 + log.md 中超出 recent_keep 的旧块 ---
  const blocks = [];

  const archiveText = readFileSafe(path.join(pocketDir, 'log-archive.md'));
  if (archiveText) {
    blocks.push(...parseLogText(archiveText).blocks);
  }

  const logText = readFileSafe(path.join(pocketDir, 'log.md'));
  if (logText) {
    const logData = parseLogText(logText);
    const maxT = logData.latestT;
    const threshold = maxT - recentKeep;
    blocks.push(...logData.blocks.filter(b => b.id <= threshold));
  }

  if (blocks.length === 0) {
    return {
      scannedBlocks: 0,
      tRange: null,
      candidates: { decisions: [], pitfalls: [], preferences: [], uncertain: [] },
      tagStats: [],
      outFile: null,
      dryRun: !!opts.dryRun,
      nothing: true,
    };
  }

  // --- 与活文档对账，去掉已覆盖的 ---
  const adrEntries = [];
  for (const adr of parseDecisions(pocketDir).adrs) {
    adrEntries.push(`ADR-${adr.id} ${adr.title} ${adr.decision || ''}`);
  }
  const pitfallEntries = parseState(pocketDir).pitfalls;
  const prefEntries = parsePreferences(pocketDir).items;

  const rawDecisions = collectSection(blocks, 'Decisions & Constraints');
  const rawPitfalls = collectSection(blocks, 'Pitfalls');
  const rawPrefs = collectSection(blocks, 'Preferences');
  const rawUncertain = collectSection(blocks, 'Uncertain').filter(u => u.text.includes('❓'));

  const annotate = (list, existing) => list.map(item => ({
    ...item,
    coveredBy: findCover(item.text, existing),
  }));

  const candidates = {
    decisions: annotate(rawDecisions, adrEntries).slice(0, MAX_PER_CATEGORY),
    pitfalls: annotate(rawPitfalls, pitfallEntries).slice(0, MAX_PER_CATEGORY),
    preferences: annotate(rawPrefs, prefEntries).slice(0, MAX_PER_CATEGORY),
    uncertain: rawUncertain.slice(0, MAX_PER_CATEGORY),
  };

  // --- 标签统计 ---
  const tagCount = {};
  for (const b of blocks) {
    for (const t of b.tags || []) {
      tagCount[t] = (tagCount[t] || 0) + 1;
    }
  }
  const tagStats = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const tIds = blocks.map(b => b.id);
  const result = {
    scannedBlocks: blocks.length,
    tRange: { min: Math.min(...tIds), max: Math.max(...tIds) },
    candidates,
    tagStats,
    truncated: {
      decisions: rawDecisions.length - candidates.decisions.length,
      pitfalls: rawPitfalls.length - candidates.pitfalls.length,
      preferences: rawPrefs.length - candidates.preferences.length,
      uncertain: rawUncertain.length - candidates.uncertain.length,
    },
    outFile: null,
    dryRun: !!opts.dryRun,
    nothing: false,
  };

  // --- 写报告 ---
  if (!opts.dryRun) {
    const outFile = path.join(pocketDir, `digest-${getTodayStr()}.md`);
    fs.writeFileSync(outFile, renderReport(result), 'utf-8');
    result.outFile = outFile;
  }

  return result;
}

// ============================================================
// 报告渲染
// ============================================================

function renderSection(title, target, items, fmt) {
  const lines = [];
  lines.push(`## ${title}（→ ${target}）· ${items.length} 条`);
  lines.push('');
  if (items.length === 0) {
    lines.push('-（无）');
    lines.push('');
    return lines.join('\n');
  }
  for (const item of items) {
    let line = `- [T${item.tId}] ${fmt ? fmt(item) : item.text}`;
    if (item.coveredBy) {
      const ref = item.coveredBy.split('\n')[0].slice(0, 60);
      line += `  ← 可能已覆盖：「${ref}」`;
    }
    lines.push(line);
  }
  lines.push('');
  return lines.join('\n');
}

function renderReport(result) {
  const lines = [];
  lines.push(`# Digest · ${getTodayStr()} · 源：T${result.tRange.min}–T${result.tRange.max}（${result.scannedBlocks} 块）`);
  lines.push('');
  lines.push('> 由 `context-pocket distill` / `/digest` 生成：从归档与旧轮次中提取的可提升内容。');
  lines.push('> 逐条判断后，把仍然有效的条目合入对应活文档（decisions.md / state.md / preferences.md / requirements.md），并注明来源 T 编号。');
  lines.push('> 「可能已覆盖」的条目先核对再决定；本文件是报告不是真相源，合并完成后可删除。');
  lines.push('');

  lines.push(renderSection('候选架构决策', 'decisions.md', result.candidates.decisions));
  lines.push(renderSection('候选坑点', 'state.md Pitfalls', result.candidates.pitfalls));
  lines.push(renderSection('候选偏好', 'preferences.md', result.candidates.preferences));
  lines.push(renderSection('归档中的 ❓ 待确认项', 'requirements.md / 用户确认', result.candidates.uncertain));

  // 截断提示
  const t = result.truncated;
  const truncatedParts = [];
  if (t.decisions > 0) truncatedParts.push(`决策 ${t.decisions} 条`);
  if (t.pitfalls > 0) truncatedParts.push(`坑点 ${t.pitfalls} 条`);
  if (t.preferences > 0) truncatedParts.push(`偏好 ${t.preferences} 条`);
  if (t.uncertain > 0) truncatedParts.push(`❓ ${t.uncertain} 条`);
  if (truncatedParts.length > 0) {
    lines.push(`> ⚠️ 内容量过大，本报告已截断：${truncatedParts.join('、')} 未列入。可对更窄的 T 范围分段蒸馏。`);
    lines.push('');
  }

  if (result.tagStats.length > 0) {
    lines.push('## 主题统计（归档轮次的标签分布）');
    lines.push('');
    lines.push('- ' + result.tagStats.map(([tag, n]) => `${tag} ×${n}`).join(' · '));
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  distill,
};
