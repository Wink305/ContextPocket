'use strict';

/**
 * ContextPocket — Markdown 解析器
 * 把各种 .md 文件解析成结构化 JS 对象
 */

const path = require('path');
const { readFileSafe } = require('./core');
const { TBLOCK_SECTIONS, REQ_STATUSES } = require('./constants');

// ============================================================
// log.md 解析
// ============================================================

/**
 * 解析 log.md
 * @param {string} pocketDir
 * @returns {object} { sessions, blocks: [], latestT, tIds: [] }
 */
function parseLog(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'log.md'));
  return parseLogText(content);
}

/**
 * 解析 log 文本（log.md 与 log-archive.md 共用同一格式）
 * @param {string|null} content
 * @returns {object} { sessions, blocks, latestT, tIds }
 */
function parseLogText(content) {
  if (!content) {
    return { sessions: [], blocks: [], latestT: 0, tIds: [] };
  }

  const lines = content.split('\n');
  const sessions = [];
  const blocks = [];
  let currentSession = null;
  let currentBlock = null;
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Session 分隔线: --- SESSION: YYYY-MM-DD ---
    const sessionMatch = line.match(/^---\s*SESSION:\s*(\d{4}-\d{2}-\d{2})\s*---\s*$/);
    if (sessionMatch) {
      currentSession = {
        date: sessionMatch[1],
        startLine: i,
        blockIds: [],
      };
      sessions.push(currentSession);
      continue;
    }

    // T-block 标题: ## T123 · gist · [tag1] [tag2]
    const tblockMatch = line.match(/^##\s+T(\d+)\s*·\s*(.+?)(?:\s*·\s*(.+))?\s*$/);
    if (tblockMatch) {
      // 保存上一个 block
      if (currentBlock) {
        blocks.push(finalizeBlock(currentBlock));
      }

      const tId = parseInt(tblockMatch[1], 10);
      const gist = tblockMatch[2].trim();
      const tagsStr = tblockMatch[3] || '';
      const tags = parseTags(tagsStr);

      currentBlock = {
        id: tId,
        gist,
        tags,
        startLine: i,
        sections: {},
        session: currentSession ? currentSession.date : null,
      };

      if (currentSession) {
        currentSession.blockIds.push(tId);
      }
      currentSection = null;
      continue;
    }

    // 子节标题: ### User / ### Action / ...
    if (currentBlock && line.startsWith('### ')) {
      const sectionName = line.slice(4).trim();
      if (TBLOCK_SECTIONS.includes(sectionName)) {
        currentSection = sectionName;
        currentBlock.sections[currentSection] = [];
      }
      continue;
    }

    // 子节内容（列表项）
    if (currentBlock && currentSection && line.startsWith('- ')) {
      const item = line.slice(2).trim();
      currentBlock.sections[currentSection].push(item);
      continue;
    }

    // 子节内容（续行，非空行，不以 # 开头）
    if (currentBlock && currentSection && line.trim() && !line.startsWith('#') && !line.startsWith('---')) {
      const section = currentBlock.sections[currentSection];
      if (section && section.length > 0) {
        // 追加到最后一项
        section[section.length - 1] += '\n' + line.trim();
      }
    }
  }

  // 保存最后一个 block
  if (currentBlock) {
    blocks.push(finalizeBlock(currentBlock));
  }

  const tIds = blocks.map(b => b.id);
  const latestT = tIds.length > 0 ? Math.max(...tIds) : 0;

  return { sessions, blocks, latestT, tIds };
}

function finalizeBlock(block) {
  // 解析 Action 节的操作类型和文件
  if (block.sections.Action) {
    block.actions = block.sections.Action.map(parseActionLine);
  }
  return block;
}

function parseActionLine(line) {
  // 格式: <操作类型> <file path> — <what was done>
  // 也可能是普通描述行
  const match = line.match(/^(\S+)\s+(.+?)\s+—\s+(.+)$/);
  if (match) {
    return {
      type: match[1],
      file: match[2].trim(),
      desc: match[3].trim(),
    };
  }
  return { type: null, file: null, desc: line };
}

function parseTags(str) {
  if (!str) return [];
  const tags = [];
  const regex = /\[([^\]]+)\]/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    tags.push(match[1].trim());
  }
  return tags;
}

// ============================================================
// requirements.md 解析
// ============================================================

/**
 * 解析 requirements.md
 * @param {string} pocketDir
 * @returns {object} { items: [], nextId, openCount, doneCount, cancelledCount, uncertainCount }
 */
function parseRequirements(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'requirements.md'));
  if (!content) {
    return { items: [], nextId: 1, openCount: 0, doneCount: 0, cancelledCount: 0, uncertainCount: 0 };
  }

  const lines = content.split('\n');
  const items = [];
  let currentStatus = null;
  let nextId = 1;

  // 从标题行提取 next_id
  const headerMatch = lines[0] && lines[0].match(/next_id:\s*R(\d+)/);
  if (headerMatch) {
    nextId = parseInt(headerMatch[1], 10);
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // 状态标题: ## Open / ## Done / ## Cancelled
    if (trimmed.startsWith('## ')) {
      const statusName = trimmed.slice(3).trim();
      if (REQ_STATUSES.includes(statusName)) {
        currentStatus = statusName;
      }
      continue;
    }

    // 需求项: - [ ] R123 text [tags] (opened T<n>) · impl: <files>
    const reqMatch = trimmed.match(
      /^-\s*\[([ x])\]\s*(?:(❓)\s*)?R(\d+)\s+(.+?)\s*(?:\[([^\]]+)\])?\s*\((opened|cancelled)\s+T(\d+)(?:,\s*(?:completed|cancelled)\s+T(\d+))?\)\s*(?:·\s*impl:\s*(.+))?$/
    );

    if (reqMatch && currentStatus) {
      const [, checkbox, uncertain, rId, text, tags, actionType, openedT, completedT, impl] = reqMatch;
      items.push({
        id: parseInt(rId, 10),
        text: text.trim(),
        status: currentStatus,
        uncertain: uncertain === '❓',
        tags: tags ? tags.split(',').map(t => t.trim()) : [],
        openedAt: parseInt(openedT, 10),
        completedAt: completedT ? parseInt(completedT, 10) : null,
        cancelledAt: currentStatus === 'Cancelled' ? (completedT ? parseInt(completedT, 10) : null) : null,
        impl: impl ? impl.split(',').map(f => f.trim()).filter(Boolean) : [],
      });
    }
  }

  // 如果标题行没有 next_id，从数据推导
  if (!headerMatch && items.length > 0) {
    nextId = Math.max(...items.map(i => i.id)) + 1;
  }

  const openCount = items.filter(i => i.status === 'Open').length;
  const doneCount = items.filter(i => i.status === 'Done').length;
  const cancelledCount = items.filter(i => i.status === 'Cancelled').length;
  const uncertainCount = items.filter(i => i.uncertain).length;

  return { items, nextId, openCount, doneCount, cancelledCount, uncertainCount };
}

// ============================================================
// decisions.md 解析
// ============================================================

/**
 * 解析 decisions.md
 * @param {string} pocketDir
 * @returns {object} { adrs: [], count }
 */
function parseDecisions(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'decisions.md'));
  if (!content) {
    return { adrs: [], count: 0 };
  }

  const lines = content.split('\n');
  const adrs = [];
  let currentAdr = null;
  let currentField = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // ADR 标题: ## ADR-1 · title · T<n>
    const adrMatch = trimmed.match(/^##\s+ADR-(\d+)\s*·\s*(.+?)\s*·\s*T(\d+)\s*$/);
    if (adrMatch) {
      if (currentAdr) {
        adrs.push(currentAdr);
      }
      currentAdr = {
        id: parseInt(adrMatch[1], 10),
        title: adrMatch[2].trim(),
        createdAt: parseInt(adrMatch[3], 10),
        context: '',
        options: '',
        decision: '',
        consequences: '',
        supersedes: 'none',
      };
      currentField = null;
      continue;
    }

    // 字段行: - Context: ... / - Options: ... / ...
    if (currentAdr && trimmed.startsWith('- ')) {
      const fieldMatch = trimmed.match(/^-\s*(Context|Options|Decision|Consequences|Supersedes):\s*(.+)$/);
      if (fieldMatch) {
        const field = fieldMatch[1].toLowerCase();
        const value = fieldMatch[2].trim();
        if (field === 'supersedes') {
          currentAdr.supersedes = value;
        } else {
          currentAdr[field] = value;
        }
        currentField = field;
        continue;
      }
    }

    // 字段续行
    if (currentAdr && currentField && trimmed && !trimmed.startsWith('## ') && !trimmed.startsWith('>')) {
      if (currentField !== 'supersedes' && currentAdr[currentField]) {
        currentAdr[currentField] += '\n' + trimmed;
      }
    }
  }

  if (currentAdr) {
    adrs.push(currentAdr);
  }

  return { adrs, count: adrs.length };
}

// ============================================================
// index.md 解析
// ============================================================

/**
 * 解析 index.md
 * @param {string} pocketDir
 * @returns {object} { latestT, date, entries: {}, hasArchive, handoffGenerated }
 */
function parseIndex(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'index.md'));
  if (!content) {
    return { latestT: 0, date: null, entries: {}, hasArchive: false, handoffGenerated: null };
  }

  const lines = content.split('\n');
  const result = {
    latestT: 0,
    date: null,
    entries: {},
    hasArchive: false,
    handoffGenerated: null,
  };

  // 标题行: # Index · T<n> · <date>
  const headerMatch = lines[0] && lines[0].match(/^#\s+Index\s*·\s*T(\d+)\s*·\s*(.+)$/);
  if (headerMatch) {
    result.latestT = parseInt(headerMatch[1], 10);
    result.date = headerMatch[2].trim();
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;

    // state.md → state, next steps, run commands, environment, pitfalls
    const entryMatch = trimmed.match(/^-\s*(\S+)\s*→\s*(.+)$/);
    if (entryMatch) {
      const file = entryMatch[1];
      const desc = entryMatch[2].trim();
      result.entries[file] = desc;

      if (file === 'log-archive.md') {
        result.hasArchive = true;
      }
      if (file === 'handoff.md') {
        const handoffMatch = desc.match(/last generated:\s*(.+)/);
        if (handoffMatch) {
          const val = handoffMatch[1].trim();
          result.handoffGenerated = val === '(not yet generated)' ? null : val;
        }
      }
    }
  }

  return result;
}

// ============================================================
// state.md 解析
// ============================================================

/**
 * 解析 state.md（简化版，提取关键节）
 * @param {string} pocketDir
 * @returns {object} { latestT, summary: [], nextSteps: [], pitfalls: [] }
 */
function parseState(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'state.md'));
  if (!content) {
    return { latestT: 0, summary: [], nextSteps: [], pitfalls: [] };
  }

  const lines = content.split('\n');
  const result = {
    latestT: 0,
    summary: [],
    nextSteps: [],
    pitfalls: [],
  };

  // 标题行
  const headerMatch = lines[0] && lines[0].match(/^#\s+State\s*·\s*T(\d+)/);
  if (headerMatch) {
    result.latestT = parseInt(headerMatch[1], 10);
  }

  let currentSection = null;
  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('## ')) {
      currentSection = trimmed.slice(3).trim();
      continue;
    }

    if (trimmed.startsWith('- ') && currentSection) {
      const item = trimmed.slice(2).trim();
      if (currentSection === 'Summary') result.summary.push(item);
      else if (currentSection === 'Next Steps') result.nextSteps.push(item);
      else if (currentSection === 'Pitfalls') result.pitfalls.push(item);
    }
  }

  return result;
}

// ============================================================
// preferences.md 解析
// ============================================================

/**
 * 解析 preferences.md
 * @param {string} pocketDir
 * @returns {object} { latestT, items: [], count }
 */
function parsePreferences(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'preferences.md'));
  if (!content) {
    return { latestT: 0, items: [], count: 0 };
  }

  const lines = content.split('\n');
  const result = {
    latestT: 0,
    items: [],
    count: 0,
  };

  const headerMatch = lines[0] && lines[0].match(/^#\s+Preferences\s*·\s*T(\d+)/);
  if (headerMatch) {
    result.latestT = parseInt(headerMatch[1], 10);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      result.items.push(trimmed.slice(2).trim());
    }
  }
  result.count = result.items.length;

  return result;
}

// ============================================================
// absolute.md 解析
// ============================================================

/**
 * 解析 absolute.md
 * @param {string} pocketDir
 * @returns {object} { entries: [], count }
 */
function parseAbsolute(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'absolute.md'));
  if (!content) {
    return { entries: [], count: 0 };
  }

  const lines = content.split('\n');
  const entries = [];
  let currentEntry = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // 标题: ## 🔒 T<n> · <gist>
    const entryMatch = trimmed.match(/^##\s+🔒\s+T(\d+)\s*·\s*(.+)$/);
    if (entryMatch) {
      if (currentEntry) {
        entries.push(currentEntry);
      }
      currentEntry = {
        tId: parseInt(entryMatch[1], 10),
        gist: entryMatch[2].trim(),
        content: '',
      };
      continue;
    }

    if (currentEntry && trimmed && !trimmed.startsWith('>')) {
      currentEntry.content += (currentEntry.content ? '\n' : '') + trimmed;
    }
  }

  if (currentEntry) {
    entries.push(currentEntry);
  }

  return { entries, count: entries.length };
}

// ============================================================
// 一次性解析所有文件
// ============================================================

/**
 * 解析整个 ContextPocket
 * @param {string} pocketDir
 * @returns {object}
 */
function parseAll(pocketDir) {
  return {
    log: parseLog(pocketDir),
    requirements: parseRequirements(pocketDir),
    decisions: parseDecisions(pocketDir),
    index: parseIndex(pocketDir),
    state: parseState(pocketDir),
    preferences: parsePreferences(pocketDir),
    absolute: parseAbsolute(pocketDir),
  };
}

module.exports = {
  parseLog,
  parseLogText,
  parseRequirements,
  parseDecisions,
  parseIndex,
  parseState,
  parsePreferences,
  parseAbsolute,
  parseAll,
};
