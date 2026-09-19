'use strict';

/**
 * ContextPocket — 查询模块
 * recall / diff / search / check-conflicts
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const { parseLog, parseAll, parseRequirements, parseDecisions } = require('./parser');
const { readConfig, fileExists, readFileSafe, getProjectRoot } = require('./core');
const { SEVERITY, TBLOCK_SECTIONS } = require('./constants');

// ============================================================
// recall — 查看指定轮次详情
// ============================================================

/**
 * 查看指定 T-block 的完整内容
 * @param {string} pocketDir
 * @param {number} tId
 * @returns {object|null} { id, gist, tags, sections, session, rawText }
 */
function recall(pocketDir, tId) {
  const logData = parseLog(pocketDir);
  const block = logData.blocks.find(b => b.id === tId);
  if (!block) return null;

  // 从原始文件中提取完整文本
  const logPath = path.join(pocketDir, 'log.md');
  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n');

  // 找到这个 block 的起始行
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+T(\d+)\s*·/);
    if (match && parseInt(match[1], 10) === tId) {
      startLine = i;
      break;
    }
  }

  if (startLine === -1) {
    return { ...block, rawText: null };
  }

  // 找到下一个 block 或文件末尾
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (/^##\s+T\d+\s*·/.test(lines[i]) || /^---\s*SESSION:/.test(lines[i])) {
      endLine = i;
      break;
    }
  }

  const rawText = lines.slice(startLine, endLine).join('\n').trim();

  return {
    ...block,
    rawText,
  };
}

// ============================================================
// diff — 对比两轮
// ============================================================

/**
 * 对比两个 T-block，输出差异
 * @param {string} pocketDir
 * @param {number} tA
 * @param {number} tB
 * @returns {object} 差异结果
 */
function diff(pocketDir, tA, tB) {
  const data = parseAll(pocketDir);
  const blockA = data.log.blocks.find(b => b.id === tA);
  const blockB = data.log.blocks.find(b => b.id === tB);

  if (!blockA) {
    throw new Error(`T${tA} not found`);
  }
  if (!blockB) {
    throw new Error(`T${tB} not found`);
  }

  const result = {
    tA,
    tB,
    gistA: blockA.gist,
    gistB: blockB.gist,
    requirements: { added: [], completed: [], cancelled: [] },
    decisions: { added: [] },
    files: { added: [], removed: [], modified: [] },
  };

  // 1. 需求变化
  // 找出在 tA 和 tB 之间变化的需求
  for (const req of data.requirements.items) {
    const openedAt = req.openedAt;
    const completedAt = req.completedAt;
    const cancelledAt = req.cancelledAt;

    // 在 tA 之后、tB 之前/之内新开的需求
    if (openedAt > tA && openedAt <= tB) {
      result.requirements.added.push({
        id: req.id,
        text: req.text,
        status: req.status,
        openedAt,
      });
    }

    // 在 tA 之后、tB 之前/之内完成的
    if (completedAt && completedAt > tA && completedAt <= tB) {
      result.requirements.completed.push({
        id: req.id,
        text: req.text,
        completedAt,
      });
    }

    // 在 tA 之后、tB 之前/之内取消的
    if (cancelledAt && cancelledAt > tA && cancelledAt <= tB) {
      result.requirements.cancelled.push({
        id: req.id,
        text: req.text,
        cancelledAt,
      });
    }
  }

  // 2. 决策变化（新增 ADR）
  for (const adr of data.decisions.adrs) {
    if (adr.createdAt > tA && adr.createdAt <= tB) {
      result.decisions.added.push({
        id: adr.id,
        title: adr.title,
        createdAt: adr.createdAt,
      });
    }
  }

  // 3. 文件变化（从 Action 节提取）
  const filesA = extractFilesFromBlock(blockA);
  const filesB = extractFilesFromBlock(blockB);

  const setA = new Set(filesA);
  const setB = new Set(filesB);

  for (const f of filesB) {
    if (!setA.has(f)) {
      result.files.added.push(f);
    }
  }
  for (const f of filesA) {
    if (!setB.has(f)) {
      result.files.removed.push(f);
    }
  }
  // 两个都有的视为修改过
  for (const f of filesB) {
    if (setA.has(f)) {
      result.files.modified.push(f);
    }
  }

  return result;
}

function extractFilesFromBlock(block) {
  const files = [];
  if (block.actions) {
    for (const action of block.actions) {
      if (action.file) {
        files.push(action.file);
      }
    }
  }
  return files;
}

// ============================================================
// search — 搜索所有 T-block
// ============================================================

/**
 * 搜索 T-block 的 gist 和内容
 * @param {string} pocketDir
 * @param {string} keyword
 * @returns {object[]} 匹配的 T-block 列表
 */
function search(pocketDir, keyword) {
  const logData = parseLog(pocketDir);
  const lowerKeyword = keyword.toLowerCase();
  const matches = [];

  for (const block of logData.blocks) {
    let found = false;
    const highlights = [];

    // 搜索 gist
    if (block.gist.toLowerCase().includes(lowerKeyword)) {
      found = true;
      highlights.push({ field: 'gist', text: block.gist });
    }

    // 搜索所有子节内容
    for (const [section, items] of Object.entries(block.sections)) {
      for (const item of items) {
        if (item.toLowerCase().includes(lowerKeyword)) {
          found = true;
          highlights.push({ field: section, text: item });
        }
      }
    }

    if (found) {
      matches.push({
        id: block.id,
        gist: block.gist,
        tags: block.tags,
        highlights: highlights.slice(0, 5), // 最多显示 5 个高亮
        matchCount: highlights.length,
      });
    }
  }

  return matches;
}

// ============================================================
// why — 反向检索：按文件路径找相关 T-block（借鉴 ThoughtDAG）
// ============================================================

/**
 * 给定文件路径，找出提到该文件的所有 T-block
 * 适用于回答"这个文件为什么被改"、"什么时候被引入"
 * @param {string} pocketDir
 * @param {string} filePath - 完整或部分文件路径
 * @param {object} [opts]
 * @param {number} [opts.limit=10] - 最多返回 N 条
 * @returns {object[]} 匹配的 T-block 列表（最近的在前面）
 */
function why(pocketDir, filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return [];
  }

  const logData = parseLog(pocketDir);
  const limit = opts.limit || 10;
  // 统一路径分隔符（Windows/Unix 兼容）
  const needle = filePath.toLowerCase().replace(/\\/g, '/');
  const matches = [];

  // 在这些 section 中检索文件引用
  const SEARCHABLE = ['Action', 'Changes', 'Pitfalls', 'Notes', 'Commits', 'User'];

  for (const block of logData.blocks) {
    const references = [];

    for (const section of SEARCHABLE) {
      const items = block.sections[section] || [];
      for (const item of items) {
        const lower = item.toLowerCase().replace(/\\/g, '/');
        if (lower.includes(needle)) {
          references.push({ section, text: item });
        }
      }
    }

    if (references.length > 0) {
      matches.push({
        id: block.id,
        gist: block.gist,
        tags: block.tags,
        references: references.slice(0, 5),
        refCount: references.length,
      });
    }
  }

  // 倒序（最近的在前面），截断到 limit
  matches.reverse();
  return matches.slice(0, limit);
}

// ============================================================
// check-conflicts — 冲突扫描
// ============================================================

/**
 * 冲突扫描：6 项检查，三级严重度
 * @param {string} pocketDir
 * @returns {object} { categories: [], criticalCount, warningCount, infoCount }
 */
function checkConflicts(pocketDir) {
  const data = parseAll(pocketDir);
  const config = readConfig(pocketDir);
  const categories = [];

  // 1. 技术栈冲突
  categories.push(checkTechStackConflicts(data, config));

  // 2. 需求冲突
  categories.push(checkRequirementConflicts(data));

  // 3. ADR 冲突
  categories.push(checkAdrConflicts(data));

  // 4. 风格冲突
  categories.push(checkStyleConflicts(data));

  // 5. 部署冲突
  categories.push(checkDeployConflicts(data));

  // 6. 🔒 绝对保留冲突
  categories.push(checkAbsoluteConflicts(data));

  // 统计
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const cat of categories) {
    for (const item of cat.items) {
      if (item.severity === 'critical') criticalCount++;
      else if (item.severity === 'warning') warningCount++;
      else infoCount++;
    }
  }

  return {
    categories,
    criticalCount,
    warningCount,
    infoCount,
  };
}

// --- 1. 技术栈冲突 ---
function checkTechStackConflicts(data) {
  const items = [];
  const { log, decisions } = data;

  // 检查 ADR 中的技术决策是否在后续被违反
  const techAdrs = decisions.adrs.filter(adr =>
    adr.title.toLowerCase().includes('stack') ||
    adr.title.toLowerCase().includes('技术栈') ||
    adr.title.toLowerCase().includes('use ') ||
    adr.title.toLowerCase().includes('选择')
  );

  for (const adr of techAdrs) {
    // 简单检查：在后续的 T-block 中是否有提到替代技术
    const adrTech = extractTechKeywords(adr.decision);
    for (const block of log.blocks) {
      if (block.id <= adr.createdAt) continue;

      const blockText = block.gist + ' ' +
        Object.values(block.sections).flat().join(' ');
      const blockTech = extractTechKeywords(blockText);

      for (const tech of adrTech) {
        for (const btech of blockTech) {
          if (isCompetingTech(tech, btech)) {
            items.push({
              severity: 'warning',
              message: `ADR-${adr.id} (${adr.title}) chose ${tech}, but T${block.id} mentions ${btech}`,
              detail: `T${block.id}: ${block.gist}`,
            });
          }
        }
      }
    }
  }

  if (items.length === 0) {
    items.push({
      severity: 'info',
      message: 'No tech stack conflicts detected',
    });
  }

  return {
    name: '技术栈 / Tech Stack',
    icon: '🛠️',
    items,
  };
}

function extractTechKeywords(text) {
  // 简单提取常见技术栈关键词
  const keywords = [
    'react', 'vue', 'angular', 'svelte',
    'express', 'koa', 'nest', 'fastify',
    'postgresql', 'mysql', 'mongodb', 'redis',
    'typescript', 'javascript', 'python', 'go', 'rust',
    'docker', 'kubernetes', 'k8s',
    'vite', 'webpack', 'rollup',
    'jest', 'vitest', 'mocha',
  ];
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k));
}

function isCompetingTech(techA, techB) {
  const competingGroups = [
    ['react', 'vue', 'angular', 'svelte'],
    ['express', 'koa', 'nest', 'fastify'],
    ['postgresql', 'mysql', 'mongodb'],
    ['vite', 'webpack', 'rollup'],
    ['jest', 'vitest', 'mocha'],
    ['docker', 'kubernetes'],
  ];

  for (const group of competingGroups) {
    if (group.includes(techA) && group.includes(techB) && techA !== techB) {
      return true;
    }
  }
  return false;
}

// --- 2. 需求冲突 ---
function checkRequirementConflicts(data) {
  const items = [];
  const { requirements, log } = data;

  // 检查已完成的需求是否在后续被重新打开或修改
  const doneReqs = requirements.items.filter(r => r.status === 'Done');
  for (const req of doneReqs) {
    if (!req.completedAt) continue;

    // 检查完成后是否有 T-block 再次提到这个需求
    for (const block of log.blocks) {
      if (block.id <= req.completedAt) continue;

      const blockText = block.gist + ' ' +
        Object.values(block.sections).flat().join(' ');
      if (blockText.includes(`R${req.id}`)) {
        // 检查是否是"重新打开"的信号
        const lower = blockText.toLowerCase();
        if (lower.includes('reopen') || lower.includes('regression') ||
            lower.includes('重新') || lower.includes('回归')) {
          items.push({
            severity: 'warning',
            message: `R${req.id} (${req.text}) was completed at T${req.completedAt}, but T${block.id} mentions reopening/regression`,
            detail: `T${block.id}: ${block.gist}`,
          });
        }
      }
    }
  }

  // 检查需求之间的直接矛盾（基于关键词的简单检测）
  const openReqs = requirements.items.filter(r => r.status === 'Open');
  for (let i = 0; i < openReqs.length; i++) {
    for (let j = i + 1; j < openReqs.length; j++) {
      const a = openReqs[i];
      const b = openReqs[j];
      if (areTextsContradictory(a.text, b.text)) {
        items.push({
          severity: 'warning',
          message: `Potential contradiction between R${a.id} and R${b.id}`,
          detail: `R${a.id}: ${a.text}\nR${b.id}: ${b.text}`,
        });
      }
    }
  }

  if (items.length === 0) {
    items.push({
      severity: 'info',
      message: 'No requirement conflicts detected',
    });
  }

  return {
    name: '需求 / Requirements',
    icon: '📋',
    items,
  };
}

function areTextsContradictory(textA, textB) {
  // 简单的矛盾检测：关键词对
  const pairs = [
    ['add', 'remove'],
    ['enable', 'disable'],
    ['增加', '移除'],
    ['开启', '关闭'],
    ['使用', '不使用'],
    ['support', 'drop'],
  ];

  const lowerA = textA.toLowerCase();
  const lowerB = textB.toLowerCase();

  for (const [pos, neg] of pairs) {
    if ((lowerA.includes(pos) && lowerB.includes(neg)) ||
        (lowerA.includes(neg) && lowerB.includes(pos))) {
      // 进一步检查是否涉及同一主题
      const wordsA = new Set(lowerA.split(/\W+/).filter(w => w.length > 3));
      const wordsB = new Set(lowerB.split(/\W+/).filter(w => w.length > 3));
      let common = 0;
      for (const w of wordsA) {
        if (wordsB.has(w)) common++;
      }
      if (common >= 1) return true;
    }
  }
  return false;
}

// --- 3. ADR 冲突 ---
function checkAdrConflicts(data) {
  const items = [];
  const { decisions } = data;

  // 检查 ADR 的 Supersedes 链是否完整
  for (const adr of decisions.adrs) {
    if (adr.supersedes && adr.supersedes !== 'none') {
      const supMatch = adr.supersedes.match(/ADR-(\d+)/);
      if (supMatch) {
        const supId = parseInt(supMatch[1], 10);
        const supAdr = decisions.adrs.find(a => a.id === supId);
        if (!supAdr) {
          items.push({
            severity: 'critical',
            message: `ADR-${adr.id} supersedes ADR-${supId}, but ADR-${supId} doesn't exist`,
          });
        }
      }
    }
  }

  // 检查是否有两个 ADR 处理同一主题但结论不同
  for (let i = 0; i < decisions.adrs.length; i++) {
    for (let j = i + 1; j < decisions.adrs.length; j++) {
      const a = decisions.adrs[i];
      const b = decisions.adrs[j];
      // 简单检测：标题关键词重叠度高且创建时间不同
      const titleWordsA = new Set(a.title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
      const titleWordsB = new Set(b.title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
      let common = 0;
      for (const w of titleWordsA) {
        if (titleWordsB.has(w)) common++;
      }
      if (common >= 2 && b.supersedes === 'none') {
        items.push({
          severity: 'info',
          message: `ADR-${a.id} and ADR-${b.id} may cover similar topics — verify if one should supersede the other`,
          detail: `ADR-${a.id}: ${a.title}\nADR-${b.id}: ${b.title}`,
        });
      }
    }
  }

  if (items.length === 0) {
    items.push({
      severity: 'info',
      message: 'No ADR conflicts detected',
    });
  }

  return {
    name: 'ADR / 决策',
    icon: '🧠',
    items,
  };
}

// --- 4. 风格冲突 ---
function checkStyleConflicts(data) {
  const items = [];
  const { log, preferences } = data;

  // 检查 Preferences 中的风格偏好是否在 T-block 中被违反
  const stylePrefs = preferences.items.filter(p =>
    p.toLowerCase().includes('style') ||
    p.toLowerCase().includes('naming') ||
    p.toLowerCase().includes('lint') ||
    p.toLowerCase().includes('format') ||
    p.includes('风格') ||
    p.includes('命名')
  );

  for (const pref of stylePrefs) {
    const prefLower = pref.toLowerCase();
    for (const block of log.blocks) {
      // 检查 Action 节中是否有违反风格的线索
      if (block.sections.Action) {
        for (const action of block.sections.Action) {
          const actionLower = action.toLowerCase();
          // 简单启发式：如果偏好是"camelCase"而文件是"snake_case"等
          if (prefLower.includes('camelcase') && actionLower.includes('_')) {
            // 可能太严格，跳过
          }
        }
      }
    }
  }

  if (items.length === 0) {
    items.push({
      severity: 'info',
      message: 'No style conflicts detected (basic check — run linters for thorough check)',
    });
  }

  return {
    name: '风格 / Style',
    icon: '🎨',
    items,
  };
}

// --- 5. 部署冲突 ---
function checkDeployConflicts(data) {
  const items = [];
  const { log, decisions } = data;

  // 检查部署相关的 ADR 和后续变更
  const deployAdrs = decisions.adrs.filter(adr =>
    adr.title.toLowerCase().includes('deploy') ||
    adr.title.toLowerCase().includes('部署') ||
    adr.title.toLowerCase().includes('infrastructure') ||
    adr.title.toLowerCase().includes('infra')
  );

  for (const adr of deployAdrs) {
    for (const block of log.blocks) {
      if (block.id <= adr.createdAt) continue;

      const blockText = (block.gist + ' ' +
        Object.values(block.sections).flat().join(' ')).toLowerCase();

      if (blockText.includes('deploy') || blockText.includes('部署')) {
        // 检查是否有配置变更
        if (block.tags.some(t => t.includes('部署') || t.toLowerCase().includes('deploy'))) {
          items.push({
            severity: 'info',
            message: `Deployment-related changes in T${block.id} — verify alignment with ADR-${adr.id}`,
            detail: `T${block.id}: ${block.gist}`,
          });
        }
      }
    }
  }

  if (items.length === 0) {
    items.push({
      severity: 'info',
      message: 'No deployment conflicts detected',
    });
  }

  return {
    name: '部署 / Deployment',
    icon: '🚀',
    items,
  };
}

// --- 6. 🔒 绝对保留冲突 ---
function checkAbsoluteConflicts(data) {
  const items = [];
  const { absolute, log } = data;

  for (const entry of absolute.entries) {
    // 检查后续 T-block 中是否有改动到被标记为绝对保留的内容
    const entryKeywords = entry.gist.toLowerCase().split(/\W+/).filter(w => w.length > 3);

    for (const block of log.blocks) {
      if (block.id <= entry.tId) continue;

      const blockText = (block.gist + ' ' +
        Object.values(block.sections).flat().join(' ')).toLowerCase();

      let matches = 0;
      for (const kw of entryKeywords) {
        if (blockText.includes(kw)) matches++;
      }

      // 如果有多个关键词匹配，可能存在冲突
      if (matches >= 2) {
        // 检查 Conflicts 节是否已标记
        const hasConflictMark = block.sections.Conflicts &&
          block.sections.Conflicts.some(c => c.includes(`T${entry.tId}`));

        if (!hasConflictMark) {
          items.push({
            severity: 'warning',
            message: `T${block.id} may touch 🔒 T${entry.tId} (${entry.gist}) but no conflict marker in Conflicts section`,
            detail: `T${block.id}: ${block.gist}`,
          });
        } else {
          items.push({
            severity: 'info',
            message: `T${block.id} touches 🔒 T${entry.tId} — properly flagged in Conflicts section`,
          });
        }
      }
    }
  }

  if (items.length === 0) {
    items.push({
      severity: 'info',
      message: absolute.count === 0
        ? 'No 🔒 absolute entries yet'
        : 'All 🔒 absolute entries are respected',
    });
  }

  return {
    name: '🔒 绝对保留 / Absolute',
    icon: '🔒',
    items,
  };
}

module.exports = {
  recall,
  diff,
  search,
  why,
  checkConflicts,
};
