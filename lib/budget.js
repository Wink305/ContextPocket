'use strict';

/**
 * 粗略 token 估算与按预算裁剪。
 *
 * 估算口径：CJK 字符按 1 token，其余按 4 字符 1 token；只用于上下文预算，
 * 不作为精确计费口径。
 *
 * applyHandoffBudget 是 handoff 的裁剪策略：只裁 1 · On demand 下的可选小节
 * 与 2 · Pointers，0 · Start here 永不裁。yuan 的 context build 复用
 * estimateTokens，但按自己的分层策略裁剪。
 */

function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text || '')) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 给已生成的 handoff 套 token 预算。
 * @param {string} content
 * @param {number} maxTokens
 * @returns {{content:string, estimatedTokens:number, trimmed:string[], overBudget:boolean}}
 */
function applyHandoffBudget(content, maxTokens) {
  if (estimateTokens(content) <= maxTokens) {
    return { content, estimatedTokens: estimateTokens(content), trimmed: [], overBudget: false };
  }

  // 从信息密度最低的小节开始丢，保持文件里剩余小节的原有顺序。
  const DROP_ORDER = ['### Code Map', '### Key Decisions', '### Open Requirements', '### Recent', '### Node chains'];
  const trimmed = [];
  let sections = content.split(/\n(?=## )/);

  for (const marker of DROP_ORDER) {
    if (estimateTokens(sections.join('\n')) <= maxTokens) break;
    let removed = false;
    sections = sections.map((sec) => {
      if (!sec.includes('## 1 ·')) return sec;
      const parts = sec.split(/\n(?=### )/);
      const kept = parts.filter((p) => {
        if (p.startsWith(marker)) { removed = true; return false; }
        return true;
      });
      return kept.join('\n');
    });
    if (removed) trimmed.push(marker.replace(/^### /, ''));
  }

  let finalContent = sections.join('\n');
  if (estimateTokens(finalContent) > maxTokens) {
    const before = estimateTokens(finalContent);
    sections = sections.filter((sec) => !sec.startsWith('## 2 ·'));
    finalContent = sections.join('\n');
    if (estimateTokens(finalContent) < before) trimmed.push('Pointers');
  }

  const estimated = estimateTokens(finalContent);
  const overBudget = estimated > maxTokens;
  const note = '- (token budget: ~' + estimated + ' / ' + maxTokens + ' tokens'
    + (trimmed.length > 0 ? '; trimmed: ' + trimmed.join(', ') : '')
    + (overBudget ? '; section 0 alone exceeds the budget — raise --max-tokens' : '')
    + ')\n';
  finalContent = finalContent.replace(/\n*$/, '\n') + note;
  return { content: finalContent, estimatedTokens: estimated, trimmed, overBudget };
}

module.exports = {
  estimateTokens,
  applyHandoffBudget,
};
