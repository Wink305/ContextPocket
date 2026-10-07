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
  TBLOCK_SECTIONS,
} = require('./constants');
const { fileExists, readConfig, getProjectRoot, minNumber, readFileSafe } = require('./core');
const { parseAll, parseLogText, plausibleIds, MAX_PLAUSIBLE_ID } = require('./parser');
const { scanText } = require('./secrets');

/**
 * 运行所有校验
 * @param {string} pocketDir
 * @param {object} [opts]
 * @param {boolean} [opts.drift=false] 启用两项基于目录扫描的漂移检查（开销较大）：
 *        log-cognition-drift（路径覆盖）+ code-newer-than-log（代码比记录新）
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

  // 11. 畸形编号（手改/注入出来的天文数字编号）
  results.push(...checkImplausibleIds(data));

  // 12. log.md 体积 vs config.archive_at（归档由人触发，这里只报阈值）
  results.push(...checkLogSize(data, config));

  // 13. 密钥 / PII 形状扫描（pocket 是要提交进 git 的历史文件，这一条默认就开）
  results.push(...checkSecretLeaks(pocketDir, config));

  // 14. 格式版本落后（登记表里真有可走的一跳才提示）
  results.push(...checkFormatUpgrade(pocketDir));

  // 15. 附件存在性：`### Attachments` 里写着的文件真的在磁盘上吗
  results.push(...checkAttachmentExistence(pocketDir));

  // 16. Log cognition drift + 代码比记录新（仅在显式启用时跑，路径扫描开销较大）
  if (opts.drift) {
    results.push(...checkLogCognitionDrift(pocketDir, data, { lastN: opts.lastN }));
    results.push(...checkCodeNewerThanLog(pocketDir, data));
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
      message: logData.blocks.length > 0
        ? 'log.md has T-block headings but none with a usable T number'
        : 'No T-blocks yet — fresh pocket',
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
        fix: 'context-pocket repair --dry-run to see the plan, then the same without --dry-run to apply it (MCP: context_pocket_repair). Two agents on different machines each compute latestT+1 from their own clone, so the same T-id gets written twice — the lock is per-machine.',
      });
    }
    seen.add(id);
  }

  // 检查连续性（从 1 开始，不间断）
  const sorted = [...new Set(tIds)].sort((a, b) => a - b);

  if (sorted[0] !== 1) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 't-id-continuity',
      message: `T-ids don't start from 1 (starts at T${sorted[0]})`,
      fix: 'If early blocks were archived, this is expected. Otherwise check for missing blocks.',
    });
  }

  // 跳号：只看相邻两个编号之间的差，不去展开整个区间。
  // 旧实现是 `for (let i = sorted[0]; i <= maxId; i++) expected.add(i)`，
  // 于是一个手改出来的 `## T4000000000` 会让它先分配几十亿个元素再报"缺号"，
  // verify 直接挂死 —— 而这正是它要检测的那种输入。
  const missingCount = sorted.length > 1 ? sorted[sorted.length - 1] - sorted[0] + 1 - sorted.length : 0;
  if (missingCount > 0) {
    const listed = [];
    for (let i = 1; i < sorted.length && listed.length < 10; i++) {
      for (let j = sorted[i - 1] + 1; j < sorted[i] && listed.length < 10; j++) {
        listed.push('T' + j);
      }
    }
    results.push({
      severity: SEVERITY.ERROR,
      category: 't-id-continuity',
      message: `Missing T-ids: ${listed.join(', ')}${missingCount > listed.length ? ` … (${missingCount} total)` : ''}`,
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

/**
 * 畸形编号检查。
 *
 * `## T4000000000 · x`、`next_id: R99999999999` 这类值既不是"很多轮"也不是
 * 拼写错误，而是手改或被注入的内容伪造出来的结构行。parser 已经把块/条目收下
 * （内容不能丢），但不让它们参与编号分配；这里负责把"这一行需要修"说清楚，
 * 否则用户只会在 verify 里看到一串莫名其妙的缺号警告。
 *
 * @param {object} data
 * @returns {object[]}
 */
function checkImplausibleIds(data) {
  const results = [];
  // parseAll 已经把 log / requirements / decisions 三份清单合成一份（带 source）
  const unique = new Map();
  for (const m of (data.implausible || [])) {
    unique.set(`${m.source}|${m.kind}|${m.rawId}`, m);
  }

  for (const m of unique.values()) {
    results.push({
      severity: SEVERITY.ERROR,
      category: 'implausible-id',
      message: `${m.source} line ${m.line}: implausible ${m.kind} id "${m.rawId}" (must be ≤ ${MAX_PLAUSIBLE_ID})`,
      fix: `Renumber it in ${m.source} — ids are small and sequential (T1, T2, …).`,
    });
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

  // 畸形编号的条目由 checkImplausibleIds 单独报错，这里只看可信的那批，
  // 否则一个 R99999999999 会把"跳号"报成缺了几百亿条需求。
  const ids = plausibleIds(items).sort((a, b) => a - b);
  if (ids.length === 0) return results;
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

  // 跳号：只列前若干个，数量单独算。展开整个区间在真实缺口下没问题，
  // 但缺口宽度是不可信输入决定的（见 T-id 连续性里的同类改动）。
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] - ids[i - 1] > 1) {
      const missing = [];
      for (let j = ids[i - 1] + 1; j < ids[i] && missing.length < 10; j++) {
        missing.push(j);
      }
      const total = ids[i] - ids[i - 1] - 1;
      results.push({
        severity: SEVERITY.WARNING,
        category: 'r-id-continuity',
        message: `Gap in R-ids: ${missing.map(id => 'R' + id).join(', ')}${total > missing.length ? ` … (${total} total)` : ''}`,
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

  // 畸形编号不参与连续性判断，理由同 R-id
  const ids = plausibleIds(adrs).sort((a, b) => a - b);

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

  // 跳号（同 R-id：列出的数量有上界）
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] - ids[i - 1] > 1) {
      const missing = [];
      for (let j = ids[i - 1] + 1; j < ids[i] && missing.length < 10; j++) {
        missing.push(j);
      }
      const total = ids[i] - ids[i - 1] - 1;
      results.push({
        severity: SEVERITY.WARNING,
        category: 'adr-continuity',
        message: `Gap in ADR-ids: ${missing.map(id => 'ADR-' + id).join(', ')}${total > missing.length ? ` … (${total} total)` : ''}`,
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

  // 标题行的 T 号写坏了（手改、或注入出来的畸形行）时 latestT 会被读成 0。
  // 这条必须单独报，否则下面只会说"index 是 T0，log 是 T7"，看不出真正坏在哪一行。
  if (indexData.malformedIndexT) {
    results.push({
      severity: SEVERITY.ERROR,
      category: 'index-consistency',
      message: 'index.md header has a malformed T number — expected "# Index · T<n> · <date>"',
      fix: `Rewrite the first line of index.md as "# Index · T${data.log.latestT} · <date>".`,
    });
  }

  // index 的 latestT vs log 的 latestT
  // bootstrap 空白状态容错：index=T0 且 log.latestT=0（bootstrap 后首次 verify）
  const isBootstrapState = indexData.latestT === 0 && data.log.latestT === 0;
  if (!indexData.malformedIndexT && !isBootstrapState && data.log.latestT !== indexData.latestT) {
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
      const logStart = data.log.tIds.length > 0 ? minNumber(data.log.tIds) : 0;
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
        fix: `context-pocket log amend ${block.id} --user "用户的原话"`,
      });
    }

    // Action 节是必须的
    if (!sections.includes('Action')) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'tblock-format',
        message: `T${block.id} missing Action section`,
        fix: `context-pocket log amend ${block.id} --action "这轮做了什么"`,
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

    // 1.1.0 的写入缺陷：整天区间（`2026-05-01 → 2026-05-03`）的端点没有钟点，取到了
    // undefined，于是 `--- WHEN: undefined → undefined ---` 被写进过记录。写入侧已修
    // （lib/when.js 的 pointValue），这里负责把已经躺在历史里的那几条照出来 ——
    // parseWhenLine 会把这种行当"用户原话"读回，recall 从此显示一句谁都没说过的话。
    // 只认 `unprefixed` 的行：带 `stated: ` 前缀的那一句是用户逐字原话，即便里面真有
    // "undefined" 这个词也不是缺陷，而 ERROR 会拦住 archive/migrate/提交。
    if (block.when && block.when.unprefixed && /\bundefined\b/.test(block.when.text)) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'tblock-format',
        message: `T${block.id} has a broken time line: ${block.when.text}`,
        fix: `那是 1.1.0 的写入缺陷，不是用户说过的话（这一行没有 \`stated: \` 前缀，工具从不用这种形状写原话）。删掉这一行 \`--- WHEN: … ---\`，再跑 context-pocket log amend ${block.id} --when "2026-05-01 → 2026-05-03" 重新记一次（amend 只肯补空行，不会覆盖已记下的时间，所以得先删）。如果这句话你确实要留着，写成 \`--- WHEN: stated: 原话 ---\`。`,
      });
    }

    // 认不出的节名：下面的内容不会被任何查询读到，必须说出来，
    // 否则用户只看到"这一节不见了"，猜不到是自己写错了节名。
    if (block.unknownSections && block.unknownSections.length > 0) {
      results.push({
        severity: SEVERITY.WARNING,
        category: 'tblock-format',
        message: `T${block.id} has unrecognised section(s): ${block.unknownSections.map((s) => '### ' + s).join(', ')}`,
        fix: `Valid sections: ${TBLOCK_SECTIONS.map((s) => '### ' + s).join(', ')}. Rename the heading or move the text into one of them.`,
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
      fix: 'Regenerate the handoff (agent: call context-pocket handoff).',
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
      fix: 'Regenerate the handoff (agent: call context-pocket handoff) before using it.',
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
// 13. Log 认知漂移检查（借鉴 AOCI cognition refresh）
// ============================================================

// 两个漂移检查共用同一份"什么算工作树里的代码文件"，否则两条检查会各自
// 排除不同的目录，同一个项目在两条检查里给出互相矛盾的答案。
const DRIFT_EXCLUDE_DIRS = new Set([
  'ContextPocket', '.git', 'node_modules', 'dist', 'build',
  '.e2e-test', '.e2e-verify-test', '.trae-html-share-packages', '.cp-test',
]);
const DRIFT_CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.py', '.go', '.rs', '.java', '.sh', '.ps1']);

/**
 * 扫描项目工作树里的代码文件
 * @param {string} root
 * @returns {Map<string, number>} 相对路径（小写、正斜杠）→ mtimeMs
 */
function walkCodeFiles(root) {
  const found = new Map();

  (function walk(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (DRIFT_EXCLUDE_DIRS.has(entry.name)) continue;
      // 跳过常见隐藏目录（除保留 .gitignore 之类的）
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.aoci') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        const lower = rel.toLowerCase();
        if (DRIFT_CODE_EXTS.has(path.extname(lower))) {
          try {
            found.set(lower, fs.statSync(path.join(dir, entry.name)).mtimeMs);
          } catch (e) {
            found.set(lower, 0);
          }
        }
      }
    }
  })(root, '');

  return found;
}

/**
 * 「代码比记录新」：文件系统的 mtime 说，有些代码在上一次记录之后又被动过。
 *
 * 这一条补的是 `sync` 的盲区 —— sync 靠 `git diff --staged`，非 git 项目里它
 * 直接跳过（`context-pocket sync` 打印 "not a git repository"），漏记就永远没人说。
 * mtime 不依赖 git，任何项目都能查。
 *
 * 判据是 `log.md` 的落盘时刻（最近一次写入记录的动作），而不是 T-block 里的
 * SESSION 日期：那个日期只有"天"的精度，同一天内的改动一律比不出来。
 *
 * 只报 WARNING：这是提示，不是错误，pre-commit hook 不会因为 warning 拦提交。
 *
 * @param {string} pocketDir
 * @param {object} data parseAll 的结果
 * @returns {object[]}
 */
function checkCodeNewerThanLog(pocketDir, data) {
  const results = [];
  const logPath = path.join(pocketDir, 'log.md');
  if (!fileExists(logPath)) return results;              // 缺文件由 checkFileExistence 报 error
  if (!data.log || !data.log.blocks.length) return results; // 还没记录过任何东西，无从比较

  const recordedAt = fs.statSync(logPath).mtimeMs;
  const files = walkCodeFiles(getProjectRoot(pocketDir));

  // 记录刚落盘的同一批里可能还有别的写在收尾（编辑器格式化、复制文件），
  // 2 秒容差把这些"同时发生"的情况排除掉，否则每次 append 后立刻 verify 都会报警。
  const TOLERANCE_MS = 2000;
  const newer = [];
  for (const [rel, mtime] of files) {
    if (mtime > recordedAt + TOLERANCE_MS) newer.push({ rel, mtime });
  }
  if (newer.length === 0) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'code-newer-than-log',
      message: `No file is newer than the last record (${files.size} code file(s) scanned)`,
    });
    return results;
  }

  newer.sort((a, b) => b.mtime - a.mtime);
  const lagMinutes = Math.max(1, Math.round((newer[0].mtime - recordedAt) / 60000));

  // 整个工作树都比记录新（clone / checkout / 分支切换 / 复制进来的项目）不算漏记，
  // 那只是文件系统时间戳被集体刷新了，报 WARNING 只会教用户忽略警告。
  if (files.size > 20 && newer.length >= files.size * 0.9) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'code-newer-than-log',
      message: `${newer.length}/${files.size} file(s) are all newer than the last record — looks like a clone/checkout/branch switch, not a missed log`,
    });
    return results;
  }

  results.push({
    severity: SEVERITY.WARNING,
    category: 'code-newer-than-log',
    message: `${newer.length} file(s) were modified after the last record (most recent is ~${lagMinutes} min later)`,
    fix: 'If that was real work, record it: append a T-block for this turn (or amend the latest one). In a git repo, "context-pocket sync --auto" backfills it automatically. Ignore this warning if the edits were not yours.',
    details: newer.slice(0, 8).map((f) => f.rel),
  });
  return results;
}

// ============================================================
// 13. 密钥 / PII 形状扫描（lib/secrets.js）
// ============================================================

/**
 * 扫 `ContextPocket/` 里的 markdown，找出长得像凭据或 PII 的片段。
 *
 * 为什么默认开着：pocket 的内容是"用户与 Agent 的原话"，一句"帮我看这个报错"
 * 就能把 API key 抄进历史文件；而 `ContextPocket/` 在同步型项目里是提交进 git 的
 * （config.md 的 gitignore: false）。pre-commit 跑的就是这条 verify，所以带厂商前缀的
 * 凭据报 ERROR（拦住提交），PII 与手写赋值报 WARNING（绝不拦提交 —— 技术文档里出现
 * 示例手机号是正常的）。
 *
 * @param {string} pocketDir
 * @param {object} config
 * @returns {object[]}
 */
function checkSecretLeaks(pocketDir, config) {
  if (config.secret_scan === false || String(config.secret_scan).trim().toLowerCase() === 'false') {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(pocketDir);
  } catch (e) {
    return []; // 目录都读不到，前面的 checkFileExistence 已经报了
  }

  const mdFiles = entries
    .filter((name) => /\.md$/i.test(name))
    .sort((a, b) => rankPocketFile(a) - rankPocketFile(b) || a.localeCompare(b));

  const errorFindings = [];
  const warnFindings = [];

  for (const name of mdFiles) {
    const content = readFileSafe(path.join(pocketDir, name));
    if (!content) continue;
    for (const f of scanText(content, { file: name })) {
      if (f.severity === 'error') errorFindings.push(f);
      else warnFindings.push(f);
    }
  }

  const results = [];
  const FIX = 'Rotate that credential first (it is already in your history). ' +
    'Then edit the named line out of the markdown, or use `log amend <Tn>` to rewrite that section. ' +
    'Whether it also reached the remote depends on .gitignore (bootstrap adds ContextPocket/ by default; `gitignore: false` commits it). ' +
    'assets/search-index.json is a derived cache and rewrites itself on the next write. ' +
    'If this pocket is *supposed* to hold such strings (a key-rotation runbook), set "- secret_scan: false" in config.md.';

  if (errorFindings.length) {
    results.push({
      severity: SEVERITY.ERROR,
      category: 'secret-leak',
      message: `${errorFindings.length} credential-shaped string(s) in the pocket — they get re-read into every new session and quoted into the next turn`,
      fix: FIX,
      details: errorFindings.slice(0, 8).map((f) => `${f.file}:${f.line} ${f.label} ${f.masked}`),
    });
  }

  if (warnFindings.length) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'secret-leak',
      message: `${warnFindings.length} PII/secret-shaped string(s) that look personal rather than machine-issued`,
      fix: 'Warning only — this never blocks a commit. Replace the value with a placeholder, or set "- secret_scan: false" in config.md if these are intentional test numbers.',
      details: warnFindings.slice(0, 8).map((f) => `${f.file}:${f.line} ${f.label} ${f.masked}`),
    });
  }

  if (results.length === 0 && mdFiles.length) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'secret-leak',
      message: `No secret-shaped strings (${mdFiles.length} markdown file(s) scanned)`,
    });
  }
  return results;
}

/** 让报告顺序稳定且可预期：核心文件在前，按需文件（log-archive / handoff）在后 */
function rankPocketFile(name) {
  const core = CORE_FILES.indexOf(name);
  if (core >= 0) return core;
  const onDemand = ON_DEMAND_FILES.indexOf(name);
  if (onDemand >= 0) return CORE_FILES.length + onDemand;
  return CORE_FILES.length + ON_DEMAND_FILES.length + 1;
}

// ============================================================
// 15. 附件存在性
// ============================================================

/**
 * `### Attachments` 里声明的文件到底在不在磁盘上。
 *
 * 为什么要单独一条：Attachments 是历史里唯一会"指着不存在的东西"的一节。图被删了、
 * 改名了、或者当初只写了路径没保存文件，`reference-integrity` 查不到（它只管 T/R/ADR
 * 号），`log-cognition-drift` 也查不到（要 `--drift` 才跑、只回看最近几块、且只报
 * info）。而 repair 现在明确不改附件文件名，只给 `mv` 命令 —— 命令没执行、文本却改了
 * 的话，需要有一条 error 能兜住，不然断链要等到下次有人去点开图才发现。
 *
 * 判据宁可不报也不误报（这条会挡住 pre-commit，误报的代价是把人的提交拦下来）：
 *   - 模板占位（含 `<` `>`）、URL/`mailto:`/`data:`、页内锚点 `#…` 一律跳过
 *   - 绝对路径与 `~` 开头跳过：换一台机器/换一个 checkout 目录就必然"不存在"
 *   - 含 `..` 的跳过：那已经跳出 pocket 自己的地盘，存在性不归它管
 *   - 已经按规范标了 `[missing: …]` 的那一条跳过（`SKILL-advanced.md`「assets/ file
 *     not found → `[missing: T<n> <file>]`; don't block」），那正是这件事被记下来的样子
 *   - 扩展名必须含字母，`1.0` 这类版本号不当文件
 * 一个候选路径在这些位置里任一存在就算对上：`ContextPocket/<p>`、项目根 `<p>`；
 * 写法是裸文件名（`T01-x.png`）时再加 `ContextPocket/assets/<p>` 与
 * `ContextPocket/assets/archive/<p>`（归档目录布局见 `SKILL-advanced.md`，
 * 块搬进 log-archive.md 时附件仍留在 assets/ 下）。
 *
 * @param {string} pocketDir
 * @returns {object[]}
 */
const ATTACH_MISSING_RE = /\[missing[:：\]]|缺失|已丢失|已删除/i;
const ATTACH_LINK_RE = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const ATTACH_PATH_RE = /(?:\.{1,2}\/)?[\w.\-\/]*[\w\-]\.[A-Za-z][A-Za-z0-9]{0,7}/g;
const ATTACH_WHOLE_RE = /^\.?\/?[\w.\-\/]*[\w\-]\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** 这一条路径值不值得查（判据见本节开头的注释） */
function isCheckableAttachmentRef(ref) {
  const r = String(ref).trim().replace(/\\/g, '/');
  if (!r || /[<>]/.test(r)) return false;
  if (/^(https?:|mailto:|data:|ftp:|\/\/)/i.test(r)) return false;
  if (r.startsWith('#')) return false;
  if (r.startsWith('/') || r.startsWith('~') || /^[a-zA-Z]:\//.test(r)) return false;
  if (r.split('/').indexOf('..') >= 0) return false;
  // 首段带点的是主机名（`example.com/a.png`），不是 pocket 里的相对路径
  const first = r.split('/')[0];
  if (r.indexOf('/') >= 0 && first.indexOf('.') >= 0 && first !== '.' && first !== '..') return false;
  // 必须像文件名：结尾是"点 + 以字母开头的扩展名"（`1.0` 这种版本号不算）
  return /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(r);
}

/**
 * 从一条 Attachments 记录里取出候选路径。
 *
 * 命名规范是 `- T<n> <label>: assets/T<nn>-<slug>.<ext> — <what>`，而 label 自己
 * 经常长得像文件名（`T1 project-structure.png: assets/T01-project-structure.png`）。
 * 整行无差别扫会把 label 那份也当成一次声明，于是"文件在、只是标签里带个点"就报
 * error。所以只认三个位置：markdown 链接的目标、行内含 `/` 的路径、冒号后那一段
 * （以及整行就是一个路径的写法）。路径一律归一成 `/` 分隔，Windows 写法也能查。
 */
function attachmentRefs(item) {
  const text = String(item).replace(/\\/g, '/');
  const stripped = text.replace(/^[-*+]\s+/, '').trim();
  const refs = new Set();

  for (const m of text.matchAll(ATTACH_LINK_RE)) refs.add(m[1]);
  for (const m of text.matchAll(ATTACH_PATH_RE)) {
    if (m[0].indexOf('/') >= 0) refs.add(m[0]);
  }

  const value = stripped.match(/^[^:/]{1,80}:\s*(\S+)/);
  if (value) refs.add(value[1]);

  if (ATTACH_WHOLE_RE.test(stripped)) refs.add(stripped);

  return [...refs].map((r) => r.replace(/[)）\],;；,，]+$/, '')).filter(isCheckableAttachmentRef);
}

function checkAttachmentExistence(pocketDir) {
  const results = [];
  const projectRoot = getProjectRoot(pocketDir);

  // 两个文件分开解析：parseLogAll 会按 id 合并，归档那份的附件就看不见了一部分
  const sources = [
    { file: 'log.md', text: readFileSafe(path.join(pocketDir, 'log.md')) },
    { file: 'log-archive.md', text: readFileSafe(path.join(pocketDir, 'log-archive.md')) },
  ];

  const missing = [];
  let checked = 0;
  for (const src of sources) {
    if (!src.text) continue;
    const parsed = parseLogText(src.text);
    for (const block of parsed.blocks) {
      for (const item of (block.sections.Attachments || [])) {
        if (ATTACH_MISSING_RE.test(item)) continue;
        for (const ref of attachmentRefs(item)) {
          checked++;
          // 四个落点：pocket 相对、项目根相对、裸文件名（在 assets/ 下）、归档后的 assets/archive/
          const candidates = [path.join(pocketDir, ref), path.join(projectRoot, ref)];
          if (!ref.startsWith('assets/') && !ref.startsWith('ContextPocket/')) {
            candidates.push(path.join(pocketDir, 'assets', ref));
            candidates.push(path.join(pocketDir, 'assets', 'archive', ref));
          }
          if (candidates.some((c) => fileExists(c))) continue;
          missing.push({
            file: src.file,
            tId: block.id,
            ref,
            record: item.trim().slice(0, 120),
            tried: [...new Set(candidates.map((c) => path.relative(projectRoot, c).replace(/\\/g, '/')))],
          });
        }
      }
    }
  }

  if (missing.length === 0) {
    if (checked > 0) {
      results.push({
        severity: SEVERITY.INFO,
        category: 'attachment-existence',
        message: `All ${checked} declared attachment path(s) found on disk`,
      });
    }
    return results;
  }

  // 逐条报，最多 12 条；剩下的并成一条，别让一次归档把整屏输出吃掉
  for (const m of missing.slice(0, 12)) {
    results.push({
      severity: SEVERITY.ERROR,
      category: 'attachment-existence',
      message: `T${m.tId} (${m.file}) declares ${m.ref}, which is not on disk`,
      fix: `Put the file back where the record says, or mark the entry as missing so the pocket stops claiming it — append " [missing: T${m.tId} ${m.ref}]" to that line (SKILL-advanced.md「assets/ file not found」). Looked for: ${m.tried.join(' · ')}. Then re-run: context-pocket verify --dir "${projectRoot}"`,
      details: [m.record],
    });
  }
  if (missing.length > 12) {
    results.push({
      severity: SEVERITY.ERROR,
      category: 'attachment-existence',
      message: `${missing.length - 12} more declared attachment(s) missing from disk`,
      fix: `context-pocket verify --json --dir "${projectRoot}" lists every one of them (category "attachment-existence")`,
      details: missing.slice(12).map((m) => `T${m.tId} ${m.file} ${m.ref}`),
    });
  }
  return results;
}

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
  // 与 query.why 同一份节名清单：路径在任何一节都可能出现，硬编码旧节名
  // （'Changes' / 'Notes' 本项目根本不用）会既白扫又漏扫
  const PATH_SECTIONS = TBLOCK_SECTIONS;
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
  const actualFiles = new Set(walkCodeFiles(projectRoot).keys());

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

// ============================================================
// 12. log.md 体积 / 归档阈值
// ============================================================

/**
 * `archive_at` 在 config.md 模板、README 和 SKILL-advanced 里都写着"log.md 超过多少行
 * 触发归档"，但代码从来没有任何地方读它——旧 log.md 会无声长到几千行，直到 search 变慢。
 * 归档本身仍然只在用户/Agent 明确要求时才做（搬动历史数据不该是自动副作用），
 * 这里负责把阈值变成看得见、可执行的一条检查结果。
 *
 * @param {object} data parseAll() 的返回值
 * @param {object} config readConfig() 的返回值
 * @returns {object[]}
 */
function checkLogSize(data, config) {
  const results = [];
  const threshold = Number(config.archive_at);
  const lines = data.log.lineCount || 0;

  if (!Number.isFinite(threshold) || threshold <= 0) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'log-size',
      message: `config.md archive_at is not a usable line count ("${config.archive_at}")`,
      fix: 'Set it to a plain integer, e.g. `- archive_at: 800`.',
    });
    return results;
  }

  if (lines >= threshold) {
    results.push({
      severity: SEVERITY.WARNING,
      category: 'log-size',
      message: `log.md is ${lines} lines, past archive_at ${threshold} — archiving is not automatic, nothing happens on its own`,
      fix: `context-pocket archive --keep-last ${config.recent_keep} (MCP: context_pocket_archive)`,
    });
  } else if (lines >= threshold * 0.8) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'log-size',
      message: `log.md is ${lines}/${threshold} lines — archiving is due soon`,
      fix: `context-pocket archive --keep-last ${config.recent_keep} (MCP: context_pocket_archive)`,
    });
  }

  return results;
}

// ============================================================
// 14. 格式版本落后（有真实可走的一跳才提示，升级本身永远由人触发）
// ============================================================

/**
 * `readme.md` 的版本戳落后于迁移登记表，且**登记表里真能从当前版本走到最新版**时
 * 报一条 WARNING。
 *
 * 为什么值得报：v1 → v2 补的是每个 T-block 的 `--- WHEN: … ---` 时间行，而写入层
 * 是"格式说什么就写什么"——v1 的 pocket 里 `lib/writer.js` 永远不写这一行
 * （`formatSupportsWhen`，见该函数）。用户不主动跑 `migrate --list`，就永远不知道
 * 自己少了这个功能，Agent 也一样。
 *
 * 为什么只是 WARNING：v1 的 pocket 没有任何不对的地方，体检绝不能拿 v2 的要求去
 * 量 v1 的数据；而 pre-commit hook 拦的是 error，把"可以升级"变成"不许提交"是错的。
 *
 * @param {string} pocketDir
 * @returns {object[]}
 */
function checkFormatUpgrade(pocketDir) {
  // lib/migrate.js 在模块顶层 require 了本文件，所以这里必须延迟取：
  // 顶层 require 会让"先加载 validator"的那条路径拿到半成品导出（verify 还没挂上去）。
  const migrate = require('./migrate');
  let info = null;
  try {
    info = migrate.listMigrations(pocketDir);
  } catch (e) {
    // 版本戳读不出来（缺 readme.md / 格式非法）自有别的一条报 error，这里不重复
    return [];
  }
  if (!info || !Array.isArray(info.path) || info.path.length === 0) return [];

  const hops = info.path.map((s) => `${s.from}→${s.to}`).join(' → ');
  return [{
    severity: SEVERITY.WARNING,
    category: 'format-upgrade',
    message: `Data format ${info.currentVersion} is behind ${info.latestVersion} — an upgrade path exists (${hops}); the pocket is valid as it is, upgrading is optional`,
    fix: `context-pocket migrate --to ${info.latestVersion} — run it with --dry-run first. It writes a backup of the pocket and rolls itself back if a step fails (MCP: context_pocket_migrate).`,
    details: info.path.map((s) => s.name || `${s.from}→${s.to}`),
  }];
}

module.exports = {
  verify,
  checkLogCognitionDrift,
  checkLogSize,
  // 附件存在性的两条判据导出给单元测试：误报会挡住 pre-commit，必须能不落盘就验证
  attachmentRefs,
  isCheckableAttachmentRef,
  checkAttachmentExistence,
};
