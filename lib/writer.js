'use strict';

/**
 * ContextPocket — 写入器
 * 所有写入操作，保证格式正确、编号连续、同步更新
 */

const fs = require('fs');
const path = require('path');
const { parseLog, parseIndex, parseRequirements } = require('./parser');
const { readConfig, fileExists, readFileSafe, getProjectRoot } = require('./core');
const { verify } = require('./validator');

// ============================================================
// 工具函数
// ============================================================

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLastSessionDate(logData) {
  if (logData.sessions.length > 0) {
    return logData.sessions[logData.sessions.length - 1].date;
  }
  return null;
}

// ============================================================
// 追加 T-block
// ============================================================

/**
 * 追加一个 T-block 到 log.md
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.gist - 一句话摘要
 * @param {string[]} options.tags - 标签数组
 * @param {string[]} options.user - 用户请求（数组，每行一条）
 * @param {string[]} options.action - 操作列表（数组，每行一条）
 * @param {string[]} [options.commits] - commit 列表
 * @param {string[]} [options.decisions] - 决策与约束
 * @param {string[]} [options.pitfalls] - 坑点
 * @param {string[]} [options.preferences] - 偏好
 * @param {string[]} [options.conflicts] - 冲突
 * @param {string[]} [options.attachments] - 附件
 * @param {string[]} [options.uncertain] - 待确认项
 * @returns {object} { tId, success }
 */
function appendLogBlock(pocketDir, options) {
  const logPath = path.join(pocketDir, 'log.md');
  const logData = parseLog(pocketDir);
  const config = readConfig(pocketDir);

  const nextT = logData.latestT + 1;
  const today = getTodayStr();
  const lastSessionDate = getLastSessionDate(logData);

  // 构建 T-block 内容
  let blockContent = '';

  // 如果日期变了，加 session 分隔线
  if (lastSessionDate !== today) {
    blockContent += `\n--- SESSION: ${today} ---\n\n`;
  }

  // 标题行
  const tagsStr = (options.tags || []).map(t => `[${t}]`).join(' ');
  blockContent += `## T${nextT} · ${options.gist || ''}`;
  if (tagsStr) {
    blockContent += ` · ${tagsStr}`;
  }
  blockContent += '\n\n';

  // User 节
  if (options.user && options.user.length > 0) {
    blockContent += '### User\n';
    for (const item of options.user) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // Action 节
  if (options.action && options.action.length > 0) {
    blockContent += '### Action\n';
    for (const item of options.action) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // Commits 节（有内容才加）
  if (options.commits && options.commits.length > 0) {
    blockContent += '### Commits\n';
    for (const item of options.commits) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // Decisions & Constraints 节（有内容才加）
  if (options.decisions && options.decisions.length > 0) {
    blockContent += '### Decisions & Constraints\n';
    for (const item of options.decisions) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // Pitfalls 节（有内容才加）
  if (options.pitfalls && options.pitfalls.length > 0) {
    blockContent += '### Pitfalls\n';
    for (const item of options.pitfalls) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // Preferences 节（有内容才加）
  if (options.preferences && options.preferences.length > 0) {
    blockContent += '### Preferences\n';
    for (const item of options.preferences) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // Conflicts 节（有内容才加）
  if (options.conflicts && options.conflicts.length > 0) {
    blockContent += '### Conflicts\n';
    for (const item of options.conflicts) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // Attachments 节（有内容才加）
  if (options.attachments && options.attachments.length > 0) {
    blockContent += '### Attachments\n';
    for (const item of options.attachments) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // Uncertain 节（有内容才加）
  if (options.uncertain && options.uncertain.length > 0) {
    blockContent += '### Uncertain\n';
    for (const item of options.uncertain) {
      blockContent += `- ${item}\n`;
    }
    blockContent += '\n';
  }

  // 写入 log.md（追加到末尾）
  let logContent = fs.readFileSync(logPath, 'utf-8');

  // 确保末尾有空行
  if (!logContent.endsWith('\n')) {
    logContent += '\n';
  }

  logContent += blockContent;
  fs.writeFileSync(logPath, logContent, 'utf-8');

  // 同步更新 index.md
  updateIndexHeader(pocketDir, nextT, today);

  return { tId: nextT, success: true };
}

// ============================================================
// 更新 index.md 标题行
// ============================================================

function updateIndexHeader(pocketDir, latestT, date) {
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  let content = fs.readFileSync(indexPath, 'utf-8');
  const lines = content.split('\n');

  // 更新标题行
  lines[0] = `# Index · T${latestT} · ${date}`;

  // 更新 log.md 的 T 范围
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('log.md →')) {
      // 提取当前范围
      const rangeMatch = lines[i].match(/T(\d+)–T(\d+)/);
      if (rangeMatch) {
        const start = rangeMatch[1];
        lines[i] = lines[i].replace(/T\d+–T\d+/, `T${start}–T${latestT}`);
      }
      break;
    }
  }

  fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8');
}

// ============================================================
// 新增需求
// ============================================================

/**
 * 新增一个需求
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.text - 需求描述
 * @param {string[]} [options.tags] - 标签
 * @param {string} [options.status='Open'] - 状态
 * @param {boolean} [options.uncertain=false] - 是否为推断未确认
 * @param {number} [options.openedAt] - 开启的 T-id（默认当前最新+1）
 * @param {string[]} [options.impl] - 实现文件
 * @returns {object} { rId, success }
 */
function addRequirement(pocketDir, options) {
  const reqPath = path.join(pocketDir, 'requirements.md');
  const reqData = parseRequirements(pocketDir);
  const logData = parseLog(pocketDir);

  // 安全校验：确保 nextId 大于所有已有 R-id
  const maxR = reqData.items.length > 0
    ? Math.max(...reqData.items.map(i => i.id))
    : 0;
  const nextR = Math.max(reqData.nextId, maxR + 1);
  const openedAt = options.openedAt || logData.latestT + 1;
  const status = options.status || 'Open';

  // 构建需求项
  let line = '- [';
  line += status === 'Done' ? 'x' : ' ';
  line += '] ';

  if (options.uncertain) {
    line += '❓ ';
  }

  line += `R${nextR} ${options.text}`;

  if (options.tags && options.tags.length > 0) {
    line += ` [${options.tags.join(', ')}]`;
  }

  line += ` (opened T${openedAt}`;
  if (status === 'Done') {
    line += `, completed T${openedAt}`;
  } else if (status === 'Cancelled') {
    line += `, cancelled T${openedAt}`;
  }
  line += ')';

  if (options.impl && options.impl.length > 0) {
    line += ` · impl: ${options.impl.join(', ')}`;
  }

  // 插入到对应状态的列表末尾
  let content = fs.readFileSync(reqPath, 'utf-8');
  const lines = content.split('\n');

  let sectionStart = -1;
  let sectionEnd = -1;

  // 找到目标状态节的位置
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].slice(3).trim() === status) {
      sectionStart = i + 1;
      // 找到下一个 ## 或文件末尾
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith('## ')) {
          sectionEnd = j - 1;
          break;
        }
      }
      if (sectionEnd === -1) {
        sectionEnd = lines.length - 1;
      }
      break;
    }
  }

  if (sectionStart === -1) {
    // 找不到对应节，追加到文件末尾
    lines.push('');
    lines.push(`## ${status}`);
    lines.push(line);
  } else {
    // 插入到节的末尾（最后一个列表项之后）
    let insertPos = sectionEnd;
    // 从后往前找第一个列表项
    for (let i = sectionEnd; i >= sectionStart; i--) {
      if (lines[i].startsWith('- [')) {
        insertPos = i + 1;
        break;
      }
    }
    lines.splice(insertPos, 0, line);
  }

  // 更新 next_id
  const newNextId = nextR + 1;
  lines[0] = lines[0].replace(/next_id:\s*R\d+/, `next_id: R${newNextId}`);

  fs.writeFileSync(reqPath, lines.join('\n'), 'utf-8');

  // 更新 index.md 中的需求计数
  updateIndexReqCount(pocketDir);

  return { rId: nextR, success: true };
}

function updateIndexReqCount(pocketDir) {
  const reqData = parseRequirements(pocketDir);
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  let content = fs.readFileSync(indexPath, 'utf-8');
  const total = reqData.items.length;
  const uncertain = reqData.uncertainCount;

  // 更新计数
  content = content.replace(
    /requirements\.md → .+?(\(\d+ items)/,
    `requirements.md → open/done/cancelled/❓ (${total} items`
  );

  fs.writeFileSync(indexPath, content, 'utf-8');
}

// ============================================================
// 新增 ADR
// ============================================================

/**
 * 新增一个架构决策
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.title - 决策标题
 * @param {string} options.context - 背景
 * @param {string} options.options - 选项
 * @param {string} options.decision - 决策
 * @param {string} options.consequences - 后果
 * @param {string} [options.supersedes='none'] - 取代的 ADR
 * @param {number} [options.createdAt] - 创建的 T-id
 * @returns {object} { adrId, success }
 */
function addDecision(pocketDir, options) {
  const decPath = path.join(pocketDir, 'decisions.md');
  const decData = require('./parser').parseDecisions(pocketDir);
  const logData = parseLog(pocketDir);

  // 安全校验：用最大 id + 1，而不是 count + 1（防止编号跳号）
  const maxAdr = decData.adrs.length > 0
    ? Math.max(...decData.adrs.map(a => a.id))
    : 0;
  const nextAdr = maxAdr + 1;
  const createdAt = options.createdAt || logData.latestT + 1;

  // 构建 ADR 内容
  let adrContent = `\n## ADR-${nextAdr} · ${options.title} · T${createdAt}\n`;
  adrContent += `- Context: ${options.context || ''}\n`;
  adrContent += `- Options: ${options.options || ''}\n`;
  adrContent += `- Decision: ${options.decision || ''}\n`;
  adrContent += `- Consequences: ${options.consequences || ''}\n`;
  adrContent += `- Supersedes: ${options.supersedes || 'none'}\n`;

  // 追加到文件末尾
  let content = fs.readFileSync(decPath, 'utf-8');
  if (!content.endsWith('\n')) {
    content += '\n';
  }
  content += adrContent;
  fs.writeFileSync(decPath, content, 'utf-8');

  // 更新 index.md 计数
  updateIndexAdrCount(pocketDir, nextAdr);

  return { adrId: nextAdr, success: true };
}

function updateIndexAdrCount(pocketDir, count) {
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  let content = fs.readFileSync(indexPath, 'utf-8');
  content = content.replace(
    /decisions\.md → \d+ ADRs?/,
    `decisions.md → ${count} ADR${count !== 1 ? 's' : ''}`
  );
  fs.writeFileSync(indexPath, content, 'utf-8');
}

// ============================================================
// 生成 handoff
// ============================================================

/**
 * 生成 handoff.md
 * @param {string} pocketDir
 * @returns {object} { success, tId }
 */
function generateHandoff(pocketDir) {
  const data = require('./parser').parseAll(pocketDir);
  const config = readConfig(pocketDir);
  const today = getTodayStr();
  const latestT = data.log.latestT;

  let content = `# Handoff · T${latestT} · ${today}\n`;
  content += '> ⚠️ STALE if log.md\'s latest T > T' + latestT + '. Regenerate with /handoff before relying on this.\n\n';

  // Project Identity
  content += '## Project Identity\n';
  const readmeContent = readFileSafe(path.join(pocketDir, 'readme.md'));
  if (readmeContent) {
    const firstLine = readmeContent.split('\n').find(l => l.trim() && !l.startsWith('#'));
    content += (firstLine || '').trim() + '\n\n';
  } else {
    content += '(see project readme)\n\n';
  }

  // State
  content += '## State\n';
  if (data.state.summary.length > 0) {
    content += data.state.summary.join('\n') + '\n';
  }
  if (data.state.pitfalls.length > 0) {
    content += '\nPitfalls:\n';
    for (const p of data.state.pitfalls) {
      content += `- ${p}\n`;
    }
  }
  content += '\n';

  // Recent (last 5)
  content += '## Recent (last 5 T gists)\n';
  const recent = data.log.blocks.slice(-5).reverse();
  for (const block of recent) {
    content += `- T${block.id}: ${block.gist}\n`;
  }
  content += '\n';

  // Open Requirements
  content += '## Open Requirements\n';
  const openReqs = data.requirements.items.filter(r => r.status === 'Open');
  if (openReqs.length === 0) {
    content += '(none)\n';
  } else {
    for (const req of openReqs) {
      let line = `- ${req.uncertain ? '❓ ' : ''}R${req.id}: ${req.text}`;
      if (req.impl && req.impl.length > 0) {
        line += ` (impl: ${req.impl.join(', ')})`;
      }
      content += line + '\n';
    }
  }
  content += '\n';

  // Next Steps
  content += '## Next Steps\n';
  if (data.state.nextSteps.length > 0) {
    for (const step of data.state.nextSteps) {
      content += `- ${step}\n`;
    }
  } else {
    content += '(see state.md)\n';
  }
  content += '\n';

  // Code Map (top-level only)
  content += '## Code Map (top-level only; full detail in code-map.md)\n';
  const codeMapPath = path.join(pocketDir, 'code-map.md');
  if (fileExists(codeMapPath)) {
    const mapContent = fs.readFileSync(codeMapPath, 'utf-8');
    const treeMatch = mapContent.match(/```\n([\s\S]*?)```/);
    if (treeMatch) {
      const treeLines = treeMatch[1].split('\n');
      for (const line of treeLines) {
        const fileMatch = line.match(/([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\s*→\s*(.+)/);
        if (fileMatch && !fileMatch[1].includes('/')) {
          content += `- ${fileMatch[1]} → ${fileMatch[2].trim().split('\n')[0]}\n`;
        }
      }
    }
  }
  content += '\n';

  // Key Decisions
  content += '## Key Decisions\n';
  if (data.decisions.count === 0) {
    content += '(none)\n';
  } else {
    for (const adr of data.decisions.adrs) {
      content += `- ADR-${adr.id}: ${adr.title}\n`;
    }
  }
  content += '\n';

  // Open ❓
  content += '## Open ❓\n';
  const uncertainReqs = data.requirements.items.filter(r => r.uncertain);
  const uncertainFromLog = [];
  for (const block of data.log.blocks) {
    if (block.sections.Uncertain) {
      for (const item of block.sections.Uncertain) {
        uncertainFromLog.push({ tId: block.id, text: item });
      }
    }
  }

  if (uncertainReqs.length === 0 && uncertainFromLog.length === 0) {
    content += '(none)\n';
  } else {
    for (const req of uncertainReqs) {
      content += `- [R${req.id}] ${req.text}\n`;
    }
    for (const u of uncertainFromLog) {
      content += `- [T${u.tId}] ${u.text.replace(/^❓\s*/, '')}\n`;
    }
  }
  content += '\n';

  // 🔒 Index
  content += '## 🔒 Index\n';
  if (data.absolute.count === 0) {
    content += '(none)\n';
  } else {
    for (const entry of data.absolute.entries) {
      content += `- T${entry.tId}: ${entry.gist}\n`;
    }
  }
  content += '\n';

  // Resume
  content += '## Resume\n';
  content += 'Read code-map.md + state.md first. Open log.md / assets/ for detail.\n';
  content += '/openpocket to continue. Run /verify before formal handoff.\n';

  // 写入文件
  const handoffPath = path.join(pocketDir, 'handoff.md');
  fs.writeFileSync(handoffPath, content, 'utf-8');

  // 更新 index.md
  updateIndexHandoff(pocketDir, today);

  return { success: true, tId: latestT, date: today };
}

function updateIndexHandoff(pocketDir, date) {
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  let content = fs.readFileSync(indexPath, 'utf-8');
  content = content.replace(
    /handoff\.md → last generated: [^\n]+/,
    `handoff.md → last generated: ${date}`
  );
  fs.writeFileSync(indexPath, content, 'utf-8');
}

// ============================================================
// 归档功能
// ============================================================

/**
 * 归档旧的 T-block 到 log-archive.md
 * @param {string} pocketDir
 * @param {object} options
 * @param {number} [options.keepLast=20] - 保留最新 N 轮
 * @param {boolean} [options.dryRun=false] - 只显示计划，不实际写入
 * @returns {object} { archivedCount, keptCount, archivedIds, summary, dryRun }
 */
function archiveLog(pocketDir, options = {}) {
  const keepLast = options.keepLast || 20;
  const dryRun = !!options.dryRun;

  const logPath = path.join(pocketDir, 'log.md');
  const archivePath = path.join(pocketDir, 'log-archive.md');
  const indexPath = path.join(pocketDir, 'index.md');

  // 归档前先跑 verify
  const preVerify = require('./validator').verify(pocketDir);
  if (preVerify.errorCount > 0) {
    throw new Error(`Cannot archive: verify found ${preVerify.errorCount} error(s). Fix errors first.`);
  }

  const logData = parseLog(pocketDir);

  if (logData.blocks.length <= keepLast) {
    return {
      archivedCount: 0,
      keptCount: logData.blocks.length,
      archivedIds: [],
      summary: [],
      dryRun,
      skipped: true,
      reason: `Only ${logData.blocks.length} blocks, no need to archive (keep ${keepLast})`,
    };
  }

  // 确定要归档的 block（前 N 个）
  const archiveCount = logData.blocks.length - keepLast;
  const blocksToArchive = logData.blocks.slice(0, archiveCount);
  const blocksToKeep = logData.blocks.slice(archiveCount);

  const archivedIds = blocksToArchive.map(b => b.id);
  const firstKeptId = blocksToKeep[0].id;
  const lastKeptId = blocksToKeep[blocksToKeep.length - 1].id;
  const firstArchivedId = blocksToArchive[0].id;
  const lastArchivedId = blocksToArchive[archiveCount - 1].id;

  // 生成归档摘要
  const summary = blocksToArchive.map(b => `T${b.id}: ${b.gist}`);

  if (dryRun) {
    return {
      archivedCount: archiveCount,
      keptCount: keepLast,
      archivedIds,
      summary,
      dryRun: true,
      firstArchivedId,
      lastArchivedId,
      firstKeptId,
      lastKeptId,
    };
  }

  // 备份原始文件（用于回滚）
  const logBackup = fs.readFileSync(logPath, 'utf-8');
  const archiveBackup = fileExists(archivePath)
    ? fs.readFileSync(archivePath, 'utf-8')
    : null;
  const indexBackup = fs.readFileSync(indexPath, 'utf-8');

  try {
    // 1. 将归档块写入/追加到 log-archive.md
    let archiveContent = '';
    if (fileExists(archivePath)) {
      archiveContent = fs.readFileSync(archivePath, 'utf-8');
      if (!archiveContent.endsWith('\n')) {
        archiveContent += '\n';
      }
    } else {
      archiveContent = '# ContextPocket · LOG ARCHIVE\n\n';
      archiveContent += '> Archived T-blocks. Read-only reference. Do not modify.\n\n';
    }

    // 从 log.md 中提取要归档的原始文本
    const fullLogContent = fs.readFileSync(logPath, 'utf-8');
    const fullLogLines = fullLogContent.split('\n');

    // 找到第一个保留 block 的起始行
    let firstKeepLine = -1;
    for (let i = 0; i < fullLogLines.length; i++) {
      const match = fullLogLines[i].match(/^##\s+T(\d+)\s*·/);
      if (match && parseInt(match[1], 10) === firstKeptId) {
        firstKeepLine = i;
        break;
      }
    }

    if (firstKeepLine === -1) {
      throw new Error(`Could not find T${firstKeptId} in log.md`);
    }

    // 归档内容 = 第一个保留 block 之前的所有内容（去掉 header）
    let archiveSection = '';
    const headerEnd = findLogHeaderEnd(fullLogLines);
    archiveSection = fullLogLines.slice(headerEnd, firstKeepLine).join('\n').trim();

    if (archiveSection) {
      archiveContent += '\n' + archiveSection + '\n';
    }

    fs.writeFileSync(archivePath, archiveContent, 'utf-8');

    // 2. 更新 log.md（只保留最新的 block）
    const newLogHeader = fullLogLines.slice(0, headerEnd).join('\n');
    const keptSection = fullLogLines.slice(firstKeepLine).join('\n').trim();
    const newLogContent = newLogHeader + '\n\n' + keptSection + '\n';

    fs.writeFileSync(logPath, newLogContent, 'utf-8');

    // 3. 更新 index.md
    updateIndexForArchive(pocketDir, firstArchivedId, lastArchivedId, firstKeptId, lastKeptId);

    // 4. 归档后跑 verify
    const postVerify = require('./validator').verify(pocketDir);
    if (postVerify.errorCount > 0) {
      // 回滚
      fs.writeFileSync(logPath, logBackup, 'utf-8');
      if (archiveBackup !== null) {
        fs.writeFileSync(archivePath, archiveBackup, 'utf-8');
      } else if (fileExists(archivePath)) {
        fs.unlinkSync(archivePath);
      }
      fs.writeFileSync(indexPath, indexBackup, 'utf-8');
      throw new Error(`Post-archive verify failed (${postVerify.errorCount} error(s)). Rolled back.`);
    }

    return {
      archivedCount: archiveCount,
      keptCount: keepLast,
      archivedIds,
      summary,
      dryRun: false,
      firstArchivedId,
      lastArchivedId,
      firstKeptId,
      lastKeptId,
    };
  } catch (e) {
    // 失败回滚
    try {
      fs.writeFileSync(logPath, logBackup, 'utf-8');
      if (archiveBackup !== null) {
        fs.writeFileSync(archivePath, archiveBackup, 'utf-8');
      } else if (fileExists(archivePath)) {
        fs.unlinkSync(archivePath);
      }
      fs.writeFileSync(indexPath, indexBackup, 'utf-8');
    } catch (rollbackErr) {
      // 回滚也失败了，抛出原始错误
      throw new Error(`${e.message} (rollback also failed: ${rollbackErr.message})`);
    }
    throw e;
  }
}

function findLogHeaderEnd(lines) {
  // header 是从开头到第一个 T-block 或 SESSION 之前的部分
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+T\d+\s*·/.test(lines[i]) || /^---\s*SESSION:/.test(lines[i])) {
      // 回退到上一个空行
      let end = i;
      while (end > 0 && lines[end - 1].trim() === '') {
        end--;
      }
      return end;
    }
  }
  return lines.length;
}

function updateIndexForArchive(pocketDir, firstArchivedId, lastArchivedId, firstKeptId, lastKeptId) {
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  let content = fs.readFileSync(indexPath, 'utf-8');
  const lines = content.split('\n');

  // 更新 log.md 的 T 范围
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('log.md →')) {
      lines[i] = lines[i].replace(/T\d+–T\d+[^\n]*/, `T${firstKeptId}–T${lastKeptId}`);
      break;
    }
  }

  // 检查是否已有 log-archive.md 条目
  let archiveLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('log-archive.md →')) {
      archiveLineIdx = i;
      break;
    }
  }

  if (archiveLineIdx === -1) {
    // 插入到 log.md 条目之后
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('log.md →')) {
        lines.splice(i + 1, 0, `- log-archive.md → T${firstArchivedId}–T${lastArchivedId}`);
        break;
      }
    }
  } else {
    // 更新已有条目
    lines[archiveLineIdx] = lines[archiveLineIdx].replace(
      /T\d+–T\d+/,
      `T1–T${lastArchivedId}`
    );
  }

  fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8');
}

// ============================================================
// state.md 更新
// ============================================================

/**
 * 更新 state.md
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} [options.summary] - 替换/追加状态摘要
 * @param {boolean} [options.appendSummary=false] - 追加而非替换
 * @param {string} [options.nextStep] - 追加下一步
 * @param {string} [options.pitfall] - 追加坑点
 * @returns {object} { success, updatedFields }
 */
function updateState(pocketDir, options = {}) {
  const statePath = path.join(pocketDir, 'state.md');
  const logData = parseLog(pocketDir);
  const latestT = logData.latestT;
  const today = getTodayStr();

  let content = fileExists(statePath)
    ? fs.readFileSync(statePath, 'utf-8')
    : `# State · T0 · ${today}\n\n## Summary\n- (empty)\n\n## Next Steps\n- (empty)\n\n## Pitfalls\n- (empty)\n`;

  const updatedFields = [];

  // 更新标题行的 T
  content = content.replace(/^# State · T\d+ · .+$/m, `# State · T${latestT} · ${today}`);

  // 更新 Summary
  if (options.summary !== undefined) {
    if (options.appendSummary) {
      // 追加到 Summary 节
      content = appendToSection(content, 'Summary', `- ${options.summary}`);
    } else {
      // 替换 Summary 节内容
      content = replaceSection(content, 'Summary', [`- ${options.summary}`]);
    }
    updatedFields.push('summary');
  }

  // 追加 Next Step
  if (options.nextStep !== undefined) {
    content = appendToSection(content, 'Next Steps', `- ${options.nextStep}`);
    updatedFields.push('nextStep');
  }

  // 追加 Pitfall
  if (options.pitfall !== undefined) {
    content = appendToSection(content, 'Pitfalls', `- ${options.pitfall}`);
    updatedFields.push('pitfall');
  }

  fs.writeFileSync(statePath, content, 'utf-8');

  return { success: true, updatedFields, latestT };
}

// ============================================================
// preferences.md 更新
// ============================================================

/**
 * 更新 preferences.md
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.key - 偏好项 key
 * @param {string} options.value - 偏好项 value
 * @returns {object} { success, key, value, isNew }
 */
function updatePreferences(pocketDir, options) {
  const prefsPath = path.join(pocketDir, 'preferences.md');
  const logData = parseLog(pocketDir);
  const latestT = logData.latestT;

  let content = fileExists(prefsPath)
    ? fs.readFileSync(prefsPath, 'utf-8')
    : `# Preferences · T0\n\n`;

  // 更新标题行的 T
  content = content.replace(/^# Preferences · T\d+/m, `# Preferences · T${latestT}`);

  const key = options.key;
  const value = options.value;
  let isNew = true;

  // 查找是否已存在该 key
  const lines = content.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('- ')) {
      const prefText = trimmed.slice(2).trim();
      const colonIdx = prefText.indexOf(':');
      if (colonIdx > -1) {
        const existingKey = prefText.slice(0, colonIdx).trim().toLowerCase();
        if (existingKey === key.toLowerCase()) {
          // 更新已有的偏好
          lines[i] = `- ${key}: ${value}`;
          found = true;
          isNew = false;
          break;
        }
      }
    }
  }

  if (!found) {
    // 追加新偏好
    lines.push(`- ${key}: ${value}`);
  }

  content = lines.join('\n');
  fs.writeFileSync(prefsPath, content, 'utf-8');

  // 更新 index.md 的 preferences 计数
  updateIndexPrefCount(pocketDir);

  return { success: true, key, value, isNew, latestT };
}

function updateIndexPrefCount(pocketDir) {
  const prefsData = require('./parser').parsePreferences(pocketDir);
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  let content = fs.readFileSync(indexPath, 'utf-8');
  content = content.replace(
    /preferences\.md → \d+ prefs?/,
    `preferences.md → ${prefsData.count} prefs`
  );
  fs.writeFileSync(indexPath, content, 'utf-8');
}

// ============================================================
// code-map.md 更新（重新扫描）
// ============================================================

/**
 * 重新扫描项目目录，更新 code-map.md
 * @param {string} pocketDir
 * @returns {object} { success, addedCount, removedCount, existingCount }
 */
function updateCodeMap(pocketDir) {
  const codeMapPath = path.join(pocketDir, 'code-map.md');
  const projectRoot = getProjectRoot(pocketDir);
  const logData = parseLog(pocketDir);
  const latestT = logData.latestT;
  const today = getTodayStr();

  if (!fileExists(codeMapPath)) {
    throw new Error('code-map.md not found');
  }

  let content = fs.readFileSync(codeMapPath, 'utf-8');

  // 更新标题行
  content = content.replace(/^# Code Map · T\d+ · .+$/m, `# Code Map · T${latestT} · ${today}`);

  // 解析现有 code-map 中的文件及其描述
  const existingEntries = parseCodeMapEntries(content);

  // 扫描当前项目目录
  const { scanProjectTree } = require('./bootstrap');
  // 重新扫描，但保留已有描述
  const currentFiles = scanProjectFiles(projectRoot, 3);

  // 对比：新增的、已存在的、删除的
  const existingPaths = new Set(Object.keys(existingEntries));
  const currentPaths = new Set(currentFiles);

  const added = [];
  const removed = [];
  const existing = [];

  for (const f of currentFiles) {
    if (existingPaths.has(f)) {
      existing.push(f);
    } else {
      added.push(f);
    }
  }

  for (const f of Object.keys(existingEntries)) {
    if (!currentPaths.has(f)) {
      removed.push(f);
    }
  }

  // 重建 Structure 节
  const newTree = buildCodeMapTree(currentFiles, existingEntries, added);
  content = replaceStructureSection(content, newTree);

  fs.writeFileSync(codeMapPath, content, 'utf-8');

  // 更新 index.md 的 code-map 计数
  updateIndexCodeMapCount(pocketDir, currentFiles.length);

  return {
    success: true,
    addedCount: added.length,
    removedCount: removed.length,
    existingCount: existing.length,
    added,
    removed,
  };
}

function parseCodeMapEntries(content) {
  const entries = {};
  const treeMatch = content.match(/## Structure\n```\n([\s\S]*?)```/);
  if (!treeMatch) return entries;

  const lines = treeMatch[1].split('\n');
  for (const line of lines) {
    // 匹配 "filename → description" 格式
    const match = line.match(/([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\s*→\s*(.+)/);
    if (match) {
      const filePath = match[1].trim();
      const desc = match[2].trim().split('\n')[0];
      entries[filePath] = desc;
    }
    // 也匹配目录
    const dirMatch = line.match(/([a-zA-Z0-9_./-]+\/)\s*→\s*(.+)/);
    if (dirMatch) {
      const dirPath = dirMatch[1].trim();
      const desc = dirMatch[2].trim().split('\n')[0];
      entries[dirPath] = desc;
    }
  }

  return entries;
}

function scanProjectFiles(projectRoot, maxDepth) {
  const ignoreDirs = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'out', '.next', '.nuxt',
    '__pycache__', '.venv', 'venv', 'env',
    '.idea', '.vscode',
    'ContextPocket',
  ]);

  const files = [];

  function scan(dir, depth) {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (ignoreDirs.has(entry.name)) continue;

        const relPath = path.relative(projectRoot, path.join(dir, entry.name));
        const normalized = relPath.replace(/\\/g, '/');

        if (entry.isDirectory()) {
          files.push(normalized + '/');
          scan(path.join(dir, entry.name), depth + 1);
        } else {
          files.push(normalized);
        }
      }
    } catch (e) {
      // skip
    }
  }

  scan(projectRoot, 1);
  return files.sort();
}

function buildCodeMapTree(files, existingEntries, addedFiles) {
  // 构建树形结构字符串
  const lines = [];
  const addedSet = new Set(addedFiles);

  // 按目录分组
  const tree = {};
  for (const f of files) {
    const parts = f.split('/').filter(Boolean);
    let current = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const isDir = f.endsWith('/') || !isLast;
      const key = isDir ? part + '/' : part;

      if (!current[key]) {
        current[key] = { __dir: isDir, __children: {} };
      }
      current = current[key].__children;
    }
  }

  function render(node, prefix, depth) {
    const entries = Object.entries(node).sort((a, b) => {
      const aDir = a[1].__dir ? 0 : 1;
      const bDir = b[1].__dir ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a[0].localeCompare(b[0]);
    });

    for (let i = 0; i < entries.length; i++) {
      const [name, data] = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      const isDir = data.__dir;
      const displayName = isDir ? name : name;
      let line = prefix + connector + displayName;

      // 查找已有描述
      // 构建这个条目的完整路径
      const fullPath = buildFullPath(node, name, depth, isDir);
      const desc = existingEntries[fullPath];

      if (desc && !desc.startsWith('<') && !desc.includes('待补充')) {
        line += ' → ' + desc.split('\n')[0];
      } else if (addedSet.has(fullPath)) {
        line += ' → ⚠️ TODO: add description';
      }

      lines.push(line);

      if (Object.keys(data.__children).length > 0) {
        render(data.__children, nextPrefix, depth + 1);
      }
    }
  }

  render(tree, '', 0);
  return lines.join('\n');
}

function buildFullPath(node, name, depth, isDir) {
  // 简化版：直接返回 name，完整路径需要递归构建
  return name;
}

function replaceStructureSection(content, newTree) {
  const match = content.match(/(## Structure\n```\n)([\s\S]*?)(```)/);
  if (match) {
    return content.replace(match[0], match[1] + newTree + '\n' + match[3]);
  }
  return content;
}

function updateIndexCodeMapCount(pocketDir, count) {
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  let content = fs.readFileSync(indexPath, 'utf-8');
  content = content.replace(
    /code-map\.md → \d+ files\/modules? documented/,
    `code-map.md → ${count} files/modules documented`
  );
  fs.writeFileSync(indexPath, content, 'utf-8');
}

// ============================================================
// 辅助函数：操作 markdown section
// ============================================================

function appendToSection(content, sectionName, line) {
  const lines = content.split('\n');
  let inSection = false;
  let sectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].slice(3).trim() === sectionName) {
      inSection = true;
      continue;
    }
    if (inSection && lines[i].startsWith('## ')) {
      sectionEnd = i - 1;
      break;
    }
  }

  if (inSection && sectionEnd === -1) {
    sectionEnd = lines.length - 1;
  }

  if (!inSection) {
    // section 不存在，追加到末尾
    lines.push('');
    lines.push(`## ${sectionName}`);
    lines.push(line);
  } else {
    // 找到最后一个列表项后插入
    let insertPos = sectionEnd;
    for (let i = sectionEnd; i >= 0; i--) {
      if (lines[i].startsWith('- ')) {
        insertPos = i + 1;
        break;
      }
    }
    // 如果 section 是空的（只有标题），在标题后插入
    if (insertPos === sectionEnd && lines[insertPos].startsWith('## ')) {
      insertPos = insertPos + 1;
    }
    lines.splice(insertPos, 0, line);
  }

  return lines.join('\n');
}

function replaceSection(content, sectionName, newLines) {
  const lines = content.split('\n');
  let inSection = false;
  let sectionStart = -1;
  let sectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].slice(3).trim() === sectionName) {
      inSection = true;
      sectionStart = i + 1;
      continue;
    }
    if (inSection && lines[i].startsWith('## ')) {
      sectionEnd = i - 1;
      break;
    }
  }

  if (inSection && sectionEnd === -1) {
    sectionEnd = lines.length - 1;
  }

  if (!inSection) {
    // section 不存在，追加
    lines.push('');
    lines.push(`## ${sectionName}`);
    for (const l of newLines) {
      lines.push(l);
    }
  } else {
    // 替换
    lines.splice(sectionStart, sectionEnd - sectionStart + 1, ...newLines);
  }

  return lines.join('\n');
}

module.exports = {
  appendLogBlock,
  addRequirement,
  addDecision,
  generateHandoff,
  updateIndexHeader,
  archiveLog,
  updateState,
  updatePreferences,
  updateCodeMap,
};
