'use strict';

/**
 * ContextPocket — 查询模块
 * recall / diff / search / check-conflicts
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const { parseLogAll, parseAll } = require('./parser');
const { readConfig, readFileSafe, intOption } = require('./core');
const { TBLOCK_SECTIONS } = require('./constants');
const { searchWithIndex, scanAll } = require('./indexer');

// search 一页默认多少条：够一次屏幕，又不至于把 800 轮历史全量打印
const DEFAULT_SEARCH_LIMIT = 50;

// ============================================================
// recall — 查看指定轮次详情
// ============================================================

/**
 * 取某个 T-block 的原始文本：先 log.md，再 log-archive.md。
 * @returns {{rawText: string|null, source: string|null}}
 */
function rawBlockText(pocketDir, tId) {
  for (const file of ['log.md', 'log-archive.md']) {
    const content = readFileSafe(path.join(pocketDir, file));
    if (!content) continue;

    const lines = content.split('\n');
    let startLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^##\s+T(\d+)\s*·/);
      if (match && parseInt(match[1], 10) === tId) {
        startLine = i;
        break;
      }
    }
    if (startLine === -1) continue;

    let endLine = lines.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      if (/^##\s+T\d+\s*·/.test(lines[i]) || /^---\s*SESSION:/.test(lines[i])) {
        endLine = i;
        break;
      }
    }

    return { rawText: lines.slice(startLine, endLine).join('\n').trim(), source: file };
  }

  return { rawText: null, source: null };
}

/**
 * 查看指定 T-block 的完整内容（含已归档轮次）
 * @param {string} pocketDir
 * @param {number} tId
 * @returns {object|null} { id, gist, tags, sections, session, rawText, source }
 */
function recall(pocketDir, tId) {
  const logData = parseLogAll(pocketDir);
  const block = logData.blocks.find(b => b.id === tId);
  if (!block) return null;

  const { rawText, source } = rawBlockText(pocketDir, tId);
  return { ...block, rawText, source, archived: source === 'log-archive.md' };
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
  // 块可以来自 log.md 或 log-archive.md：归档不应该让 diff 报 "T<n> not found"
  const blocks = parseLogAll(pocketDir).blocks;
  const blockA = blocks.find(b => b.id === tA);
  const blockB = blocks.find(b => b.id === tB);

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
      if (!action) continue;
      // 优先用 files（含自然语言 Action 里提到的所有路径），回落 file
      if (action.files && action.files.length > 0) {
        files.push(...action.files);
      } else if (action.file) {
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
 * 全量扫描搜索：索引不可用（缺失 / 损坏 / `--no-index`）时的检索路径。
 *
 * 实现只有一份，在 lib/indexer.js 的 scanAll：它与倒排索引共用同一个分词器、
 * 同一套"分词 AND"判定、同一份命中整形与排序，所以两条路径必然给出数量、顺序、
 * 形状都相同的结果。旧实现在这里是第二套匹配逻辑（子串包含、只扫 T-block、不扫 tags），
 * 于是"索引坏了"不只是变慢，而是结果与走索引时不一致 —— 分页更无法自洽。
 *
 * @param {string} pocketDir
 * @param {string} keyword
 * @returns {object[]} 与索引命中同形状的列表
 */
function search(pocketDir, keyword) {
  return scanAll(pocketDir, keyword);
}

/**
 * 搜索的统一入口：选路径（倒排 / 现场扫描）+ 分页。
 *
 * 索引优先是历史规模下的性能保证，扫描是索引缺失/损坏时的正确性保证，
 * 两条路径的匹配与排序完全一致（都走 lib/indexer.js 的同一份实现），
 * 所以这里的 offset / limit 与走哪条路径无关 —— 第 2 页不会重复第 1 页的条目。
 *
 * 截断不再是静默的：结果带 total / hasMore，`--limit 0` 明确取全量。
 * 旧行为是倒排路径硬截 50 条却报告"50 matches found"，800 轮历史时用户
 * 以为只有 50 条相关；而扫描路径根本不截，两条路径连"命中多少"都不一致。
 *
 * @param {string} pocketDir
 * @param {string} keyword
 * @param {object} [opts]
 * @param {boolean} [opts.useIndex=true] - false 时强制全量扫描（CLI 的 --no-index）
 * @param {number} [opts.limit=50] - 本页条数；0 或负数 = 不限
 * @param {number} [opts.offset=0] - 跳过前 N 条
 * @returns {{ results: object[], total: number, offset: number, limit: number|null, hasMore: boolean, viaIndex: boolean }}
 */
function searchAny(pocketDir, keyword, opts = {}) {
  let rows = null;
  let viaIndex = false;

  if (opts.useIndex !== false) {
    const indexed = searchWithIndex(pocketDir, keyword);
    if (indexed !== null) {
      rows = indexed;
      viaIndex = true;
    }
  }
  if (rows === null) rows = search(pocketDir, keyword);

  const total = rows.length;
  const offset = Math.max(0, intOption(opts.offset, 0));
  const wanted = intOption(opts.limit, DEFAULT_SEARCH_LIMIT);
  const limit = wanted > 0 ? wanted : null;
  const results = limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);

  return {
    results,
    total,
    offset,
    limit,
    hasMore: offset + results.length < total,
    viaIndex,
  };
}

// ============================================================
// why — 反向检索：按文件路径找相关 T-block（借鉴 ThoughtDAG）
// ============================================================

/**
 * 给定文件路径，找出提到该文件的所有 T-block，并区分证据强度。
 * 适用于回答"这个文件为什么被改"、"什么时候被引入"
 *
 * 证据分级（一个文件"出现在一轮里"不等于"这一轮改了它"）：
 * - `evidence: 'changed'`  —— Action 小节里有这个路径：这一轮确实动了它。
 * - `evidence: 'mentioned'` —— 只在别的小节里出现（Attachments 挂的截图、
 *   Uncertain 里待查的路径、Conflicts 点名的模块、Pitfalls 举的例子……）。
 * 返回值按 changed 在前、mentioned 在后排序，各组内最近的在前面，所以截断到
 * limit 时先掉的是"只提到过"的轮次，不会把真正的改动记录挤掉。
 *
 * @param {string} pocketDir
 * @param {string} filePath - 完整或部分文件路径
 * @param {object} [opts]
 * @param {number} [opts.limit=10] - 最多返回 N 条
 * @returns {object[]} 匹配的 T-block 列表（改过的在前面，组内最近的在前面）
 */
function why(pocketDir, filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return [];
  }

  const logData = parseLogAll(pocketDir);
  const limit = opts.limit || 10;
  // 统一路径分隔符（Windows/Unix 兼容）
  const needle = filePath.toLowerCase().replace(/\\/g, '/');
  const changed = [];
  const mentioned = [];

  // 文件引用在任何一节都可能出现：Action 改的文件、Attachments 挂的截图、
  // Uncertain 里待查的路径、Conflicts 里点名的模块……所以直接扫 constants 里那份
  // 唯一的节名清单。旧写法硬编码了 'Changes' / 'Notes' —— 这两个不是本项目的节名，
  // 白扫之外还静默漏掉了真实存在的 Attachments / Conflicts / Decisions。
  const SEARCHABLE = TBLOCK_SECTIONS;

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

    if (references.length === 0) continue;

    // Action 里的引用排前面，读的人先看到"这轮改了什么"
    references.sort((a, b) => (a.section === 'Action' ? -1 : 0) - (b.section === 'Action' ? -1 : 0));
    const match = {
      id: block.id,
      gist: block.gist,
      tags: block.tags,
      archived: !!block.archived,
      evidence: references.some((r) => r.section === 'Action') ? 'changed' : 'mentioned',
      references: references.slice(0, 5),
      refCount: references.length,
    };
    (match.evidence === 'changed' ? changed : mentioned).push(match);
  }

  // 组内倒序（最近的在前面），strong 组整体优先，最后截断到 limit
  changed.reverse();
  mentioned.reverse();
  return changed.concat(mentioned).slice(0, limit);
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
  return summarizeConflictCategories(runConflictChecks(parseAll(pocketDir), readConfig(pocketDir)));
}

/**
 * 六个维度的扫描，输入是内存里的数据（不读盘）。
 *
 * 拆出来只为一件事：`log append` 想在**写之前**问"这一块记进去会不会撞上既有记录"。
 * 那时新块还不存在于任何文件里，只能拿一份合成数据再跑一遍同样的检查 ——
 * 复制一套关键词规则放在 writer 里一定会和这里漂移，所以复用的是同一个函数。
 * @param {object} data parseAll() 形状的内存数据
 * @param {object} config readConfig() 的返回值
 * @returns {object[]} categories
 */
function runConflictChecks(data, config) {
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

  return categories;
}

/** 把 categories 汇总成 checkConflicts 的返回值（计数规则见下方注释） */
function summarizeConflictCategories(categories) {
  // 统计
  //
  // `benign: true` 的项是"该维度没有冲突"这类占位说明，不是发现。
  // 它们仍然会被打印（让人知道每个维度都扫过了），但不计入 infoCount ——
  // 否则一次干净扫描会显示成 "info: 6"，读起来像有 6 条发现。
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const cat of categories) {
    for (const item of cat.items) {
      if (item.severity === 'critical') criticalCount++;
      else if (item.severity === 'warning') warningCount++;
      else if (!item.benign) infoCount++;
    }
  }

  return {
    categories,
    criticalCount,
    warningCount,
    infoCount,
  };
}

/**
 * 假定一个新 T-block 已经写进 log.md，会**新出现**哪些冲突。
 *
 * 只回"这块记进去之前不存在"的发现：既有冲突早就该由 `check-conflicts` 处理，
 * 把它们重复抄进新块只会让 Conflicts 节变成噪音。
 *
 * @param {string} pocketDir
 * @param {object} draft { id, gist, tags: string[], sections: {小节标题: string[]} }
 * @returns {Array<{category:string, severity:string, message:string, detail:string|null}>}
 */
function conflictsIntroducedBy(pocketDir, draft) {
  const data = parseAll(pocketDir);
  const config = readConfig(pocketDir);
  const keyOf = (item) => item.severity + '\u0000' + item.message;

  const before = new Set();
  for (const cat of runConflictChecks(data, config)) {
    for (const item of cat.items) before.add(keyOf(item));
  }

  const preview = Object.assign({}, data, {
    log: Object.assign({}, data.log, {
      blocks: data.log.blocks.concat([{
        id: draft.id,
        gist: draft.gist || '',
        tags: Array.isArray(draft.tags) ? draft.tags : [],
        sections: draft.sections || {},
        when: null,
      }]),
    }),
  });

  const found = [];
  for (const cat of runConflictChecks(preview, config)) {
    for (const item of cat.items) {
      if (item.benign) continue;
      if (before.has(keyOf(item))) continue;
      found.push({
        category: cat.name,
        severity: item.severity,
        message: item.message,
        detail: item.detail || null,
      });
    }
  }
  return found;
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
      benign: true,
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
      benign: true,
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
      benign: true,
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
      benign: true,
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
      benign: true,
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
      benign: true,
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
  searchAny,
  why,
  checkConflicts,
  // 写时冲突闸用：runConflictChecks 是六维规则的单一出处，
  // conflictsIntroducedBy 在它之上做一次"假如这一轮已经写进去"的差分
  runConflictChecks,
  conflictsIntroducedBy,
};
