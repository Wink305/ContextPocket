'use strict';

/**
 * ContextPocket Lite — 校验器
 *
 * verify 的「结构 + 安全」子集，函数体从主包 lib/validator.js 逐字搬运：
 *   保留：文件存在性（lite 的 5 核心文件）、T-id 连续性、畸形编号、
 *         T-block 格式完整性、标题行 T 一致性、log 体积阈值、密钥/PII 扫描。
 *   裁掉：R/ADR/index 计数一致性（lite 口袋没有这些文件）、引用完整性、
 *         code-map 漂移、handoff 过期、附件存在性、--drift 两项目录扫描、
 *         跨轮矛盾检测（六维冲突引擎属 full 包）、格式版本落后提示（migrate 属 full 包）。
 *
 * 密钥扫描是安全底线，任何裁剪都不碰它 —— pocket 是要进 git 的历史文件。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const {
  LITE_CORE_FILES,
  ON_DEMAND_FILES,
  SEVERITY,
  TBLOCK_SECTIONS,
} = require('./constants');
const { fileExists, readConfig, readFileSafe } = require('./core');
const { parseAll, plausibleIds, MAX_PLAUSIBLE_ID } = require('./parser');
const { scanText } = require('./secrets');

/**
 * 运行所有校验（lite 子集）
 * @param {string} pocketDir
 * @param {object} [opts] 收下但忽略：--drift 两项目录扫描不在 lite 的能力面
 * @returns {object} { results: [], errorCount, warningCount, infoCount }
 */
function verify(pocketDir, opts = {}) {
  void opts; // drift / lastN 是 full 包的参数；lite 收下不认，不报错
  const results = [];
  const config = readConfig(pocketDir);
  const data = parseAll(pocketDir);

  // 1. 文件存在性（lite 的 5 个核心文件；readme 是项目的门面，同样要建）
  results.push(...checkFileExistence(pocketDir));

  // 2. T-id 连续性
  results.push(...checkTIdContinuity(data.log));

  // 3. T-block 格式完整性
  results.push(...checkTBlockFormat(data.log));

  // 4. 标题行 T 编号一致性
  results.push(...checkHeaderTConsistency(data));

  // 5. 畸形编号（手改/注入出来的天文数字编号）
  results.push(...checkImplausibleIds(data));

  // 6. log.md 体积 vs config.archive_at（归档由人触发，这里只报阈值）
  results.push(...checkLogSize(data, config));

  // 7. 密钥 / PII 形状扫描（pocket 是要提交进 git 的历史文件，这一条默认就开）
  results.push(...checkSecretLeaks(pocketDir, config));

  const errorCount = results.filter(r => r.severity === SEVERITY.ERROR).length;
  const warningCount = results.filter(r => r.severity === SEVERITY.WARNING).length;
  const infoCount = results.filter(r => r.severity === SEVERITY.INFO).length;

  return { results, errorCount, warningCount, infoCount, data, config };
}

// ============================================================
// 1. 文件存在性
// ============================================================

function checkFileExistence(pocketDir) {
  const results = [];
  // Lite 的 verify 量的是 lite 口袋：5 个核心文件一个不能少。
  // 读 full 口袋（主包建的）时多余文件不算问题 —— 口袋只会更全。
  const requiredFiles = LITE_CORE_FILES;

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
        fix: 'Renumbering needs the full package (context-pocket repair); lite only reads and appends.',
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
// 3. T-block 格式完整性
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
        fix: `context-pocket-lite log append 下一次写全 --user；这一轮手补 "### User" 小节也可以`,
      });
    }

    // Action 节是必须的
    if (!sections.includes('Action')) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'tblock-format',
        message: `T${block.id} missing Action section`,
        fix: `手补 "### Action" 小节（lite 没有 log amend，直接编辑 log.md 的这一块）`,
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
    // "undefined" 这个词也不是缺陷，而 ERROR 会拦住提交。
    if (block.when && block.when.unprefixed && /\bundefined\b/.test(block.when.text)) {
      results.push({
        severity: SEVERITY.ERROR,
        category: 'tblock-format',
        message: `T${block.id} has a broken time line: ${block.when.text}`,
        fix: `那是 1.1.0 的写入缺陷，不是用户原话行（这一行没有 \`stated: \` 前缀，工具从不用这种形状写原话）。删掉这一行 \`--- WHEN: … ---\`，手补一行正确的时间（或用 full 包的 log amend --when 重新记）。如果这句话你确实要留着，写成 \`--- WHEN: stated: 原话 ---\`。`,
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
// 4. 标题行 T 编号一致性
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

  return results;
}

// ============================================================
// 5. log.md 体积 / 归档阈值
// ============================================================

/**
 * `archive_at` 在 config.md 模板、README 里都写着"log.md 超过多少行触发归档"。
 * 归档本身仍然只在用户/Agent 明确要求时才做（搬动历史数据不该是自动副作用；
 * Lite 甚至不带 archive 命令 —— 那是 full 包的维护面），这里负责把阈值
 * 变成看得见的一条检查结果。
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
      fix: `归档属 full 包的维护面（context-pocket archive --keep-last）；Lite 只读不搬历史`,
    });
  } else if (lines >= threshold * 0.8) {
    results.push({
      severity: SEVERITY.INFO,
      category: 'log-size',
      message: `log.md is ${lines}/${threshold} lines — archiving is due soon`,
      fix: `归档属 full 包的维护面（context-pocket archive --keep-last）；Lite 只读不搬历史`,
    });
  }

  return results;
}

// ============================================================
// 6. 密钥 / PII 形状扫描（安全底线，不裁）
// ============================================================

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
    'Then edit the named line out of the markdown. ' +
    'Whether it also reached the remote depends on .gitignore (bootstrap adds ContextPocket/ by default; `gitignore: false` commits it). ' +
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
  const core = LITE_CORE_FILES.indexOf(name);
  if (core >= 0) return core;
  const onDemand = ON_DEMAND_FILES.indexOf(name);
  if (onDemand >= 0) return 100 + onDemand;
  return 200;
}

module.exports = {
  verify,
};
