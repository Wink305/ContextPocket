'use strict';

/**
 * ContextPocket — 校验器
 * 健康检查、格式校验、引用完整性、漂移检测
 */

const fs = require('fs');
const path = require('path');
const {
  CORE_FILES,
  ON_DEMAND_FILES,
  SEVERITY,
} = require('./constants');
const { fileExists, readConfig, getProjectRoot } = require('./core');
const { parseAll } = require('./parser');

/**
 * 运行所有校验
 * @param {string} pocketDir
 * @param {object} [opts]
 * @param {boolean} [opts.drift=false] 启用 cognition drift 检查（路径扫描，开销较大）
 * @param {number} [opts.lastN=5] drift 检查回看的 T-block 数
 * @returns {object} { results: [], errorCount, warningCount, infoCount }
 */
function verify(pocketDir, opts = {}) {
  const results = [];
  const config = readConfig(pocketDir);
  const data = parseAll(pocketDir);

  // 1. 文件存在性
  results.push(...checkFileExistence(pocketDir, config));

  // 2. T-id 连续性
  results.push(...checkTIdContinuity(data.log));

  // 3. R-id 连续性
  results.push(...checkRIdContinuity(data.requirements));

  // 4. ADR 编号连续性
  results.push(...checkAdrContinuity(data.decisions));

  // 5. index.md 计数一致性
  results.push(...checkIndexConsistency(data.index, data));

  // 6. T-block 格式完整性
  results.push(...checkTBlockFormat(data.log));

  // 7. 引用完整性（T-block 引用的 R-id / ADR 是否存在）
  results.push(...checkReferenceIntegrity(data));

  // 8. code-map 漂移检查
  results.push(...checkCodeMapDrift(pocketDir, data));

  // 9. handoff 过期检查
  results.push(...checkHandoffStale(pocketDir, data));

  // 10. 标题行 T 编号一致性
  results.push(...checkHeaderTConsistency(data));

  // 11. Log cognition drift（仅在显式启用时跑，路径扫描开销较大）
  if (opts.drift) {
    results.push(...checkLogCognitionDrift(pocketDir, data, { lastN: opts.lastN }));
  }

  const errorCount = results.filter(r => r.severity === SEVERITY.ERROR).length;
  const warningCount = results.filter(r => r.severity === SEVERITY.WARNING).length;
  const infoCount = results.filter(r => r.severity === SEVERITY.INFO).length;

  return { results, errorCount, warningCount, infoCount, data, config };
}

// ============================================================
// 1. 文件存在性
// ============================================================

function checkFileExistence(pocketDir, config) {
  const results = [];
  const isLite = config.mode === 'lite';
  const requiredFiles = isLite
    ? ['index.md', 'log.md', 'state.md', 'code-map.md', 'readme.md']
    : CORE_FILES.filter(f => f !== 'readme.md'); // readme 是项目的，不是必须

  for (const file of requiredFiles) {
    if (!fileExists(path.join(pocketDir, file))) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'file-existence',
        message: `Missing required file: ${file}`,
        fix: `Create ${file} from template.`,
      });
    }
  }

  // 检查按需文件（如果存在，给个 info）
  for (const file of ON_DEMAND_FILES) {
    if (fileExists(path.join(pocketDir, file))) {
      results.push({
        severity: SEVERITY.INFO,
        category: 'file-existence',
        message: `On-demand file present: ${file}`,
      });
    }
  }

  // 检查 assets 目录
  const assetsDir = path.join(pocketDir, 'assets');
  if (fileExists(assetsDir)) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'file-existence',
      message: 'assets/ directory present',
    });
  }

  return results;
}

// ============================================================
// 2. T-id 连续性
// ============================================================

function checkTIdContinuity(logData) {
  const results = [];
  const { tIds, blocks } = logData;

  if (tIds.length === 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 't-id-continuity',
      message: 'No T-blocks yet — fresh pocket',
    });
    return results;
  }

  // 检查重复
  const seen = new Set();
  for (const id of tIds) {
    if (seen.has(id)) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 't-id-continuity',
        message: `Duplicate T-id: T${id}`,
        fix: 'Rename or merge duplicate blocks.',
      });
    }
    seen.add(id);
  }

  // 检查连续性（从 1 开始，不间断）
  const sorted = [...tIds].sort((a, b) => a - b);
  const maxId = sorted[sorted.length - 1];

  if (sorted[0] !== 1) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 't-id-continuity',
      message: `T-ids don't start from 1 (starts at T${sorted[0]})`,
      fix: 'If early blocks were archived, this is expected. Otherwise check for missing blocks.',
    });
  }

  // 检查跳号
  const expected = new Set();
  for (let i = sorted[0]; i <= maxId; i++) {
    expected.add(i);
  }
  const actual = new Set(sorted);
  const missing = [...expected].filter(x => !actual.has(x));

  if (missing.length > 0) {
    results.push({
      severity: SEVERITY.ERROR,
      category: 't-id-continuity',
      message: `Missing T-ids: ${missing.map(id => 'T' + id).join(', ')}`,
      fix: 'Check if blocks were accidentally deleted. Blocks in log.md are append-only.',
    });
  }

  // 顺序检查（文件中是否按顺序排列）
  let prevId = 0;
  for (const block of blocks) {
    if (block.id <= prevId) {
      results.push({
        severity: SEVERITY.WARNING,
        category: 't-id-continuity',
        message: `T-blocks out of order: T${block.id} comes after T${prevId}`,
        fix: 'Blocks should be in chronological order (T1, T2, T3, ...).',
      });
      break;
    }
    prevId = block.id;
  }

  return results;
}

// ============================================================
// 3. R-id 连续性
// ============================================================

function checkRIdContinuity(reqData) {
  const results = [];
  const { items, nextId } = reqData;

  if (items.length === 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'r-id-continuity',
      message: 'No requirements yet',
    });
    return results;
  }

  const ids = items.map(i => i.id).sort((a, b) => a - b);
  const maxId = ids[ids.length - 1];

  // 重复
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'r-id-continuity',
        message: `Duplicate R-id: R${id}`,
        fix: 'Rename duplicate requirement entry.',
      });
    }
    seen.add(id);
  }

  // next_id 与实际最大 id 的关系
  if (nextId <= maxId) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'r-id-continuity',
      message: `next_id (R${nextId}) is not greater than max R-id (R${maxId})`,
      fix: `Update next_id to R${maxId + 1}.`,
    });
  }

  // 跳号
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] - ids[i - 1] > 1) {
      const missing = [];
      for (let j = ids[i - 1] + 1; j < ids[i]; j++) {
        missing.push(j);
      }
      results.push({
        severity: SEVERITY.WARNING,
        category: 'r-id-continuity',
        message: `Gap in R-ids: ${missing.map(id => 'R' + id).join(', ')}`,
        fix: 'R-ids are permanent — if some were cancelled, they should still exist with Cancelled status.',
      });
    }
  }

  return results;
}

// ============================================================
// 4. ADR 编号连续性
// ============================================================

function checkAdrContinuity(decData) {
  const results = [];
  const { adrs, count } = decData;

  if (count === 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'adr-continuity',
      message: 'No ADRs yet',
    });
    return results;
  }

  const ids = adrs.map(a => a.id).sort((a, b) => a - b);

  // 重复
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'adr-continuity',
        message: `Duplicate ADR-id: ADR-${id}`,
        fix: 'Rename duplicate decision entry.',
      });
    }
    seen.add(id);
  }

  // 跳号
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] - ids[i - 1] > 1) {
      const missing = [];
      for (let j = ids[i - 1] + 1; j < ids[i]; j++) {
        missing.push(j);
      }
      results.push({
        severity: SEVERITY.WARNING,
        category: 'adr-continuity',
        message: `Gap in ADR-ids: ${missing.map(id => 'ADR-' + id).join(', ')}`,
        fix: 'ADR numbers are permanent. If a decision was superseded, update Supersedes field instead of deleting.',
      });
    }
  }

  // Supersedes 引用检查
  for (const adr of adrs) {
    if (adr.supersedes && adr.supersedes !== 'none') {
      // 提取被取代的 ADR 编号
      const supMatch = adr.supersedes.match(/ADR-(\d+)/);
      if (supMatch) {
        const supId = parseInt(supMatch[1], 10);
        if (!ids.includes(supId)) {
          results.push({
            severity: SEVERITY.ERROR,
            category: 'adr-continuity',
            message: `ADR-${adr.id} supersedes ADR-${supId}, but ADR-${supId} doesn't exist`,
            fix: 'Check the Supersedes field for typos.',
          });
        }
      }
    }
  }

  return results;
}

// ============================================================
// 5. index.md 计数一致性
// ============================================================

function checkIndexConsistency(indexData, data) {
  const results = [];

  // index 的 latestT vs log 的 latestT
  // bootstrap 空白状态容错：index=T0 且 log.latestT=0（bootstrap 后首次 verify）
  const isBootstrapState = indexData.latestT === 0 && data.log.latestT === 0;
  if (!isBootstrapState && data.log.latestT !== indexData.latestT) {
    results.push({
      severity: SEVERITY.ERROR,
      category: 'index-consistency',
      message: `index.md says latest is T${indexData.latestT}, but log.md has T${data.log.latestT}`,
      fix: 'Update index.md header to match log.md.',
    });
  }

  // requirements 计数
  if (indexData.entries['requirements.md']) {
    const entry = indexData.entries['requirements.md'];
    const countMatch = entry.match(/(\d+)\s+items/);
    if (countMatch) {
      const indexCount = parseInt(countMatch[1], 10);
      const actualCount = data.requirements.items.length;
      if (indexCount !== actualCount) {
        results.push({
          severity: SEVERITY.WARNING,
          category: 'index-consistency',
          message: `index.md says ${indexCount} requirements, but there are ${actualCount}`,
          fix: 'Update requirements count in index.md.',
        });
      }
    }
  }

  // decisions 计数
  if (indexData.entries['decisions.md']) {
    const entry = indexData.entries['decisions.md'];
    const countMatch = entry.match(/(\d+)\s+ADRs?/i);
    if (countMatch) {
      const indexCount = parseInt(countMatch[1], 10);
      const actualCount = data.decisions.count;
      if (indexCount !== actualCount) {
        results.push({
          severity: SEVERITY.WARNING,
          category: 'index-consistency',
          message: `index.md says ${indexCount} ADRs, but there are ${actualCount}`,
          fix: 'Update decisions count in index.md.',
        });
      }
    }
  }

  // preferences 计数
  if (indexData.entries['preferences.md']) {
    const entry = indexData.entries['preferences.md'];
    const countMatch = entry.match(/(\d+)\s+prefs?/i);
    if (countMatch) {
      const indexCount = parseInt(countMatch[1], 10);
      const actualCount = data.preferences.count;
      if (indexCount !== actualCount) {
        results.push({
          severity: SEVERITY.WARNING,
          category: 'index-consistency',
          message: `index.md says ${indexCount} preferences, but there are ${actualCount}`,
          fix: 'Update preferences count in index.md.',
        });
      }
    }
  }

  // log 的 T 范围
  if (indexData.entries['log.md']) {
    const entry = indexData.entries['log.md'];
    const rangeMatch = entry.match(/T(\d+)–T(\d+)/);
    if (rangeMatch) {
      const [, startStr, endStr] = rangeMatch;
      const indexStart = parseInt(startStr, 10);
      const indexEnd = parseInt(endStr, 10);
      const logStart = data.log.tIds.length > 0 ? Math.min(...data.log.tIds) : 0;
      const logEnd = data.log.latestT;

      if (indexEnd !== logEnd) {
        results.push({
          severity: SEVERITY.ERROR,
          category: 'index-consistency',
          message: `index.md says log ends at T${indexEnd}, but log ends at T${logEnd}`,
          fix: 'Update log.md T-range in index.md.',
        });
      }
      if (indexStart !== logStart && !indexData.hasArchive) {
        results.push({
          severity: SEVERITY.WARNING,
          category: 'index-consistency',
          message: `index.md says log starts at T${indexStart}, but log starts at T${logStart}`,
          fix: 'If blocks were archived, ensure log-archive.md exists and is indexed.',
        });
      }
    }
  }

  return results;
}

// ============================================================
// 6. T-block 格式完整性
// ============================================================

function checkTBlockFormat(logData) {
  const results = [];

  for (const block of logData.blocks) {
    const sections = Object.keys(block.sections);

    // User 节是必须的
    if (!sections.includes('User')) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'tblock-format',
        message: `T${block.id} missing User section`,
        fix: 'Add ### User section with the user\'s full request.',
      });
    }

    // Action 节是必须的
    if (!sections.includes('Action')) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'tblock-format',
        message: `T${block.id} missing Action section`,
        fix: 'Add ### Action section listing what was done.',
      });
    }

    // gist 不能为空
    if (!block.gist || block.gist === '<one-line gist>') {
      results.push({
        severity: SEVERITY.WARNING,
        category: 'tblock-format',
        message: `T${block.id} has empty/placeholder gist`,
        fix: 'Write a one-line summary of this turn in the T-block header.',
      });
    }
  }

  if (results.length === 0 && logData.blocks.length > 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'tblock-format',
      message: `All ${logData.blocks.length} T-blocks have required sections`,
    });
  }

  return results;
}

// ============================================================
// 7. 引用完整性
// ============================================================

function checkReferenceIntegrity(data) {
  const results = [];
  const { log, requirements, decisions } = data;
  const rIds = new Set(requirements.items.map(i => i.id));
  const adrIds = new Set(decisions.adrs.map(a => a.id));
  const tIds = new Set(log.tIds);

  for (const block of log.blocks) {
    // 检查 Conflicts 节中的 T/R/ADR 引用
    if (block.sections.Conflicts) {
      for (const line of block.sections.Conflicts) {
        const tRefs = [...line.matchAll(/T(\d+)/g)].map(m => parseInt(m[1], 10));
        const rRefs = [...line.matchAll(/R(\d+)/g)].map(m => parseInt(m[1], 10));
        const adrRefs = [...line.matchAll(/ADR-(\d+)/g)].map(m => parseInt(m[1], 10));

        for (const tRef of tRefs) {
          if (!tIds.has(tRef)) {
            results.push({
              severity: SEVERITY.WARNING,
              category: 'reference-integrity',
              message: `T${block.id} Conflicts references T${tRef}, which doesn't exist`,
            });
          }
        }
        for (const rRef of rRefs) {
          if (!rIds.has(rRef)) {
            results.push({
              severity: SEVERITY.WARNING,
              category: 'reference-integrity',
              message: `T${block.id} Conflicts references R${rRef}, which doesn't exist`,
            });
          }
        }
        for (const adrRef of adrRefs) {
          if (!adrIds.has(adrRef)) {
            results.push({
              severity: SEVERITY.WARNING,
              category: 'reference-integrity',
              message: `T${block.id} Conflicts references ADR-${adrRef}, which doesn't exist`,
            });
          }
        }
      }
    }

    // 检查 Action 节中的需求引用（格式：R3 / R5）
    if (block.sections.Action) {
      for (const line of block.sections.Action) {
        const rRefs = [...line.matchAll(/R(\d+)/g)].map(m => parseInt(m[1], 10));
        for (const rRef of rRefs) {
          if (rRef > 0 && !rIds.has(rRef)) {
            // 可能是误匹配（比如端口号 R22），只 warning
            if (rRef <= 1000) {
              results.push({
                severity: SEVERITY.INFO,
                category: 'reference-integrity',
                message: `T${block.id} Action mentions R${rRef}, which doesn't exist in requirements (may be unrelated)`,
              });
            }
          }
        }
      }
    }
  }

  return results;
}

// ============================================================
// 8. code-map 漂移检查
// ============================================================

function checkCodeMapDrift(pocketDir, data) {
  const results = [];
  const projectRoot = getProjectRoot(pocketDir);
  const content = data; // parser 暂时没深度解析 code-map 的结构树

  // 简单检查：code-map.md 是否存在
  const codeMapPath = path.join(pocketDir, 'code-map.md');
  if (!fileExists(codeMapPath)) {
    // file existence 检查已经报过了
    return results;
  }

  const mapContent = require('fs').readFileSync(codeMapPath, 'utf-8');

  // 提取 code-map 中提到的文件路径（粗略）
  // 匹配 tree 结构中的文件路径模式
  const filePaths = new Set();
  const treeMatch = mapContent.match(/```\n([\s\S]*?)```/);
  if (treeMatch) {
    const treeLines = treeMatch[1].split('\n');
    for (const line of treeLines) {
      // 提取文件名（在 → 之前的部分）
      const fileMatch = line.match(/([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\s*→/);
      if (fileMatch) {
        filePaths.add(fileMatch[1].trim());
      }
    }
  }

  if (filePaths.size === 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'code-map-drift',
      message: 'code-map.md Structure section is empty or unparseable',
    });
    return results;
  }

  // 检查文件是否存在
  let missing = 0;
  let found = 0;
  for (const relPath of filePaths) {
    const absPath = path.join(projectRoot, relPath);
    if (fileExists(absPath)) {
      found++;
    } else {
      missing++;
      results.push({
        severity: SEVERITY.WARNING,
        category: 'code-map-drift',
        message: `code-map references ${relPath} but file doesn't exist`,
        fix: 'Remove stale entry from code-map.md, or create the file.',
      });
    }
  }

  if (missing === 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'code-map-drift',
      message: `All ${found} files referenced in code-map.md exist`,
    });
  }

  return results;
}

// ============================================================
// 9. handoff 过期检查
// ============================================================

function checkHandoffStale(pocketDir, data) {
  const results = [];
  const handoffPath = path.join(pocketDir, 'handoff.md');

  if (!fileExists(handoffPath)) {
    return results; // handoff 还没生成过，正常
  }

  const handoffContent = fs.readFileSync(handoffPath, 'utf-8');
  const headerMatch = handoffContent.match(/^#\s+Handoff\s*·\s*T(\d+)/);

  if (!headerMatch) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'handoff-stale',
      message: 'handoff.md has unparseable header',
      fix: 'Regenerate handoff with /handoff.',
    });
    return results;
  }

  const handoffT = parseInt(headerMatch[1], 10);
  const logLatestT = data.log.latestT;

  if (handoffT < logLatestT) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'handoff-stale',
      message: `handoff.md is stale (generated at T${handoffT}, log is at T${logLatestT})`,
      fix: 'Regenerate handoff with /handoff before using it.',
    });
  } else if (handoffT === logLatestT) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'handoff-stale',
      message: `handoff.md is up to date (T${handoffT})`,
    });
  }

  return results;
}

// ============================================================
// 11. Log 认知漂移检查（借鉴 AOCI cognition refresh）
// ============================================================

/**
 * 轻量级 cognition drift 检测：
 * 对比「最近 N 个 T-block 引用的文件」vs「working tree 中实际存在/修改的文件」，
 * 找出未记录的文件变更和幽灵引用。
 *
 * 启发式：从 T-block section 中提取 `path/to/file.ext` 模式，
 *        与项目目录扫描对比。drift 不等于错误，只是提示 Agent 漏记或认知过期。
 *
 * @param {string} pocketDir
 * @param {object} data
 * @param {object} [opts]
 * @param {number} [opts.lastN=5] 回看最近 N 个 T-block
 * @param {number} [opts.windowDays=7] 漂移检测时间窗（天）
 * @returns {object[]}
 */
function checkLogCognitionDrift(pocketDir, data, opts = {}) {
  const results = [];
  const projectRoot = getProjectRoot(pocketDir);
  const lastN = opts.lastN || 5;
  const windowDays = opts.windowDays || 7;

  const recentBlocks = data.log.blocks.slice(-lastN);
  if (recentBlocks.length === 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'log-cognition-drift',
      message: 'No T-blocks yet — cognition drift detection skipped',
    });
    return results;
  }

  // 1. 收集最近 T-block 中提到的文件路径
  const recordedPaths = new Set();
  const PATH_SECTIONS = ['Action', 'Changes', 'Pitfalls', 'Notes', 'Commits', 'User'];
  // 宽松匹配：word + 路径分隔符 + 文件名.扩展名
  const PATH_REGEX = /(?:\.{0,2}\/)?[\w.\-/]+\.[a-zA-Z0-9]{1,8}/g;

  for (const block of recentBlocks) {
    for (const section of PATH_SECTIONS) {
      const items = block.sections[section] || [];
      for (const item of items) {
        const matches = item.match(PATH_REGEX);
        if (matches) {
          for (const m of matches) {
            const normalized = m.toLowerCase().replace(/\\/g, '/');
            // 过滤纯数字、纯字母过短、无意义的匹配
            if (
              normalized.length >= 4 &&
              /\.[a-zA-Z0-9]{1,8}$/.test(normalized) &&
              !/^\d+\.\d+/.test(normalized) // 过滤版本号（如 1.0）
            ) {
              recordedPaths.add(normalized);
            }
          }
        }
      }
    }
  }

  // 2. 扫描 working tree 中的代码文件（排除 ContextPocket/、.git/ 等）
  const EXCLUDE_DIRS = new Set([
    'ContextPocket', '.git', 'node_modules', 'dist', 'build',
    '.e2e-test', '.e2e-verify-test', '.trae-html-share-packages', '.cp-test',
  ]);
  const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.py', '.go', '.rs', '.java', '.sh', '.ps1']);
  const actualFiles = new Set();

  function walk(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      // 跳过常见隐藏目录（除保留 .gitignore 之类的）
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.aoci') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        const lower = rel.toLowerCase();
        const ext = path.extname(lower);
        if (CODE_EXTS.has(ext)) {
          actualFiles.add(lower);
        }
      }
    }
  }

  walk(projectRoot, '');

  // 3. 路径匹配：recorded path 与 actual file 用相对路径宽松匹配
  //    规则：recorded 可能是完整或部分路径，actual 是相对路径
  function matchPath(recorded, fileSet) {
    for (const f of fileSet) {
      if (f === recorded) return true;
      if (f.endsWith('/' + recorded)) return true;
      if (recorded.endsWith('/' + f)) return true;
      if (f.includes(recorded) && recorded.length >= 5) return true;
    }
    return false;
  }

  // Phantom: T-block 引用了但 working tree 中找不到
  const phantom = [];
  for (const r of recordedPaths) {
    if (!matchPath(r, actualFiles)) phantom.push(r);
  }

  // Unrecorded: working tree 中存在但最近 T-block 没提到
  // 仅检查文件名（basename）避免噪音
  const recordedBasenames = new Set();
  for (const r of recordedPaths) {
    const bn = r.split('/').pop();
    if (bn) recordedBasenames.add(bn);
  }
  const unrecorded = [];
  for (const f of actualFiles) {
    const bn = f.split('/').pop();
    if (!recordedBasenames.has(bn) && f.split('/').length <= 2) {
      // 只标记项目根或一级子目录的"重要"文件
      unrecorded.push(f);
    }
  }

  // 4. 报告
  if (unrecorded.length > 0) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'log-cognition-drift',
      message: `${unrecorded.length} file(s) not referenced in recent ${lastN} T-blocks (cognition drift)`,
      fix: 'Run `context-pocket sync --auto` to backfill, or append a T-block documenting these files.',
      details: unrecorded.slice(0, 8),
    });
  }

  if (phantom.length > 0 && phantom.length <= recordedPaths.size) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'log-cognition-drift',
      message: `${phantom.length} file(s) referenced in recent T-blocks not found in working tree`,
      details: phantom.slice(0, 8),
    });
  }

  if (unrecorded.length === 0 && phantom.length === 0 && recordedPaths.size > 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'log-cognition-drift',
      message: `Log cognition aligned: ${recordedPaths.size} file(s) tracked, working tree matches`,
    });
  }

  return results;
}

// ============================================================
// 10. 标题行 T 编号一致性
// ============================================================

function checkHeaderTConsistency(data) {
  const results = [];
  const latestT = data.log.latestT;

  // bootstrap 空白状态容错：log 为空时 T0 是正确状态，不报警
  if (latestT === 0) return results;

  // state.md 的 T
  if (data.state.latestT > 0 && data.state.latestT !== latestT) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'header-t-consistency',
      message: `state.md header says T${data.state.latestT}, but latest is T${latestT}`,
      fix: 'Update state.md header T number.',
    });
  }

  // preferences.md 的 T
  if (data.preferences.latestT > 0 && data.preferences.latestT !== latestT) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'header-t-consistency',
      message: `preferences.md header says T${data.preferences.latestT}, but latest is T${latestT}`,
      fix: 'Update preferences.md header T number.',
    });
  }

  // requirements.md 标题行的 T
  // （parseRequirements 没有提取，这里简单读一下）
  // 暂时跳过，等 parser 完善后再加

  return results;
}

module.exports = {
  verify,
  checkLogCognitionDrift,
};
