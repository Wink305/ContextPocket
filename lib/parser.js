'use strict';

/**
 * ContextPocket — Markdown 解析器
 * 把各种 .md 文件解析成结构化 JS 对象
 */

const path = require('path');
const { readFileSafe, isPlaceholderLine, maxNumber, minNumber } = require('./core');
const { TBLOCK_SECTIONS, REQ_STATUSES, SESSION_LINE_RE } = require('./constants');
const { WHEN_LINE_RE, parseWhenLine } = require('./when');

// ============================================================
// 编号健壮性
// ============================================================

/**
 * 编号可信上限。
 *
 * 真实项目一年也攒不到 1e5 轮，这里留两个数量级余量；超过它就不是"记得多"，
 * 而是手改或注入出来的畸形数据（`## T99999999999999999999 · x`）。这种值一旦
 * 流进 latestT / nextId，writer 的 `latestT + 1` 就会写出天文数字的编号，
 * index.md 的 T 范围和连续性检查也一起废掉。
 *
 * 处理方式：块/条目本身照常保留（内容不能丢），但编号换成畸形号段，
 * 并且不参与编号分配与连续性检查 —— 由 verify 单独报错。
 */
const MAX_PLAUSIBLE_ID = 10000000;
const MALFORMED_ID_BASE = MAX_PLAUSIBLE_ID + 1;

/**
 * 把标题里的数字编号解析成"可信编号"，不可信时返回 null。
 * @param {string} digits
 * @returns {number|null}
 */
function toPlausibleId(digits) {
  const n = parseInt(digits, 10);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_PLAUSIBLE_ID ? n : null;
}

/**
 * 取编号可信条目的 id 列表，供编号分配与连续性检查使用。
 * @param {object[]} entries 带 .id 的条目（T-block / requirement / ADR）
 * @returns {number[]}
 */
function plausibleIds(entries) {
  return (entries || []).filter((e) => e && !e.implausibleId).map((e) => e.id);
}

/**
 * 畸形编号只用来显示，不参与任何计算。parseInt 出一串 9 会得到 Infinity，
 * 而 Infinity 进 JSON 会变成 null、进比较运算会变成噪音，所以夹一个可读的值。
 * @param {string} digits
 * @returns {number}
 */
function clampForDisplay(digits) {
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : MAX_PLAUSIBLE_ID;
}

/** 两个 firstT 里取真实存在的最小二（0 表示"这个文件没有块"） */
function minPositive(a, b) {
  const xs = [a, b].filter((x) => x > 0);
  return xs.length > 0 ? Math.min(...xs) : 0;
}

/** 可信编号里的最小者；一个都没有时返回 0（"没有真实轮次"） */
function firstReal(ids) {
  return ids.length > 0 ? minNumber(ids) : 0;
}

// ============================================================
// log.md 解析
// ============================================================

/**
 * 解析 log.md
 * @param {string} pocketDir
 * @returns {object} { sessions, blocks: [], latestT, tIds: [], implausible: [] }
 */
function parseLog(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'log.md'));
  const data = parseLogText(content);
  for (const m of data.implausible) m.source = 'log.md';
  return data;
}

/**
 * 解析 log.md + log-archive.md 的全部 T-block。
 *
 * 归档只把块从 log.md 搬到 log-archive.md，索引（lib/indexer.js）会读两个文件，
 * 但 query 侧旧实现只读 log.md —— 于是归档之后老轮次就 recall 不到、
 * search 的无索引回退也搜不到，同一个查询因为索引是否存在给出不同答案。
 * 这里统一成"归档≠丢失"。log.md 优先（同名 id 以未归档的那份为准）。
 *
 * @param {string} pocketDir
 * @returns {object} { sessions, blocks, latestT, firstT, tIds, implausible, lineCount }
 */
function parseLogAll(pocketDir) {
  const live = parseLogText(readFileSafe(path.join(pocketDir, 'log.md')));
  const archived = parseLogText(readFileSafe(path.join(pocketDir, 'log-archive.md')));
  for (const m of live.implausible) m.source = 'log.md';
  for (const m of archived.implausible) m.source = 'log-archive.md';

  const byId = new Map();
  for (const block of archived.blocks) {
    // 只在归档里出现的块标记 archived，让 recall/search 的调用方能显示
    // "这一轮已经归档"，而不是把它当成丢失
    block.archived = true;
    byId.set(block.id, block);
  }
  for (const block of live.blocks) byId.set(block.id, block);

  const blocks = [...byId.values()].sort((a, b) => a.id - b.id);

  return {
    sessions: archived.sessions.concat(live.sessions),
    blocks,
    latestT: Math.max(live.latestT, archived.latestT),
    firstT: minPositive(live.firstT, archived.firstT),
    tIds: plausibleIds(blocks),
    implausible: archived.implausible.concat(live.implausible),
    // archive_at 只管 log.md，归档文件多大都与触发阈值无关
    lineCount: live.lineCount,
  };
}

/**
 * 解析 log 文本（log.md 与 log-archive.md 共用同一格式）
 * @param {string|null} content
 * @returns {object} { sessions, blocks, latestT, firstT, tIds, implausible, lineCount }
 */
function parseLogText(content) {
  if (!content) {
    return { sessions: [], blocks: [], latestT: 0, firstT: 0, tIds: [], implausible: [], lineCount: 0 };
  }

  const lines = content.split('\n');
  const sessions = [];
  const blocks = [];
  const implausible = [];
  let currentSession = null;
  let currentBlock = null;
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Session 分隔线: --- SESSION: YYYY-MM-DD ---（定义见 constants，archive 切分要用同一份）
    const sessionMatch = line.match(SESSION_LINE_RE);
    if (sessionMatch) {
      currentSession = {
        date: sessionMatch[1],
        startLine: i,
        blockIds: [],
      };
      sessions.push(currentSession);
      continue;
    }

    // 时间结构行（v2）: --- WHEN: 2026-10-03 09:00 → 11:30 ---
    // 紧跟在 `## T<n>` 之后，属于这个块。v1 的文件里不会有这一行；v1 的 reader 走到
    // 下面的"不在小节里就忽略"分支，所以新版写出的 pocket 用旧版读只是看不到时间。
    if (currentBlock && !currentBlock.when && WHEN_LINE_RE.test(line)) {
      currentBlock.when = parseWhenLine(line);
      continue;
    }

    // T-block 标题: ## T123 · gist · [tag1] [tag2]
    const tblockMatch = line.match(/^##\s+T(\d+)\s*·\s*(.+?)(?:\s*·\s*(.+))?\s*$/);
    if (tblockMatch) {
      // 保存上一个 block
      if (currentBlock) {
        blocks.push(finalizeBlock(currentBlock));
      }

      const parsedId = toPlausibleId(tblockMatch[1]);
      // 畸形编号不能丢掉整轮内容：换成畸形号段，块仍然可被 recall/搜索到，
      // 但不会污染 latestT（下一轮的 id 由可信的 latestT 决定）。
      const tId = parsedId !== null
        ? parsedId
        : MALFORMED_ID_BASE + implausible.length;
      if (parsedId === null) {
        implausible.push({ kind: 'T', rawId: 'T' + tblockMatch[1], id: tId, line: i + 1 });
      }
      const gist = tblockMatch[2].trim();
      const tagsStr = tblockMatch[3] || '';
      const tags = parseTags(tagsStr);

      currentBlock = {
        id: tId,
        implausibleId: parsedId === null,
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
      } else {
        // 认不出的节名（手误写成 `### Note`、或者用了中文 `### 行动`）：
        // 底下的内容会被整段忽略，块看起来像缺了这一节。不在这里报出来的话,
        // 用户只会觉得"我明明记了但 recall 里没有"。
        currentSection = null;
        currentBlock.unknownSections = currentBlock.unknownSections || [];
        if (sectionName && !currentBlock.unknownSections.includes(sectionName)) {
          currentBlock.unknownSections.push(sectionName);
        }
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

  const realIds = plausibleIds(blocks);
  const latestT = realIds.length > 0 ? maxNumber(realIds) : 0;
  // log.md 里第一条真实存在的 T，不是"历史上最早的那条"：归档会把旧块搬走，
  // 这时范围必须从剩下的第一条算起（index.md 的 `T<start>–T<latest>` 用它）。
  const firstT = realIds.length > 0 ? minNumber(realIds) : 0;
  // 末尾换行会多出一个空段，去掉它才等于 `wc -l` 的行数（archive_at 按行数比较）
  const lineCount = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);

  return { sessions, blocks, latestT, firstT, tIds: realIds, implausible, lineCount };
}

function finalizeBlock(block) {
  block.unknownSections = block.unknownSections || [];
  // v2 的时间行；v1 的块一律是 null，读取方要能区分"没记"和"记了但只有天"
  block.when = block.when || null;
  // 解析 Action 节的操作类型和文件
  if (block.sections.Action) {
    block.actions = block.sections.Action.map(parseActionLine);
  }
  // 弱证据：Action 以外的小节里出现的路径（见 weakMentions 的说明）
  block.mentions = weakMentions(block);
  return block;
}

/**
 * 弱证据路径：Action **以外**的小节里出现的路径。
 *
 * 为什么要分层：一轮里"改了什么"和"谈到了什么"不是一回事。
 * `### Uncertain` 写"要不要一起改 server/store.js"、`### Attachments` 挂一张
 * `shots/diagram.png`，都不表示这一轮动过那个文件。混在一起会出两种错：
 * - `why` 把"只在待确认里出现过"的轮次答成"这文件是这轮改的"；
 * - 任何拿它当"已记录"判据的检查看到幻影覆盖。
 *
 * 所以：Action 里的路径（`block.actions[].files`）= 强证据，算覆盖；
 * 这里返回的 = 弱证据，只用于反查与提示，绝不算覆盖。
 *
 * @param {object} block 已经填好 sections/actions 的 T-block
 * @returns {Array<{path:string, section:string, text:string}>} 按 (小节, 路径) 去重、保序
 */
function weakMentions(block) {
  const out = [];
  const seen = new Set();
  for (const section of TBLOCK_SECTIONS) {
    if (section === 'Action') continue;                  // 强证据走 block.actions
    for (const item of block.sections[section] || []) {
      for (const p of extractPaths(item)) {
        const key = section + '\u0000' + p;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: p, section, text: item });
      }
    }
  }
  return out;
}

function parseActionLine(line) {
  // 首选格式: <操作类型> <file path> — <what was done>
  const match = line.match(/^(\S+)\s+(.+?)\s+—\s+(.+)$/);

  const parsed = match
    ? { type: match[1], file: match[2].trim(), desc: match[3].trim() }
    : { type: null, file: null, desc: line };

  // files：这一行里出现过的所有路径 —— **强证据**，`sync` 用它判"这一轮记过了"。
  //
  // 为什么要它：`sync`（git 漏记兜底）和 `why`（反查文件）都只认严格的
  // `<操作> <文件> — <描述>` 格式，Agent 按自然语言写 Action（比如
  // `新增 src/a.ts 和 src/b.ts`）时 file 解析为 null → sync 误判为"未记录"，
  // 于是**每次提交都多出一个冗余的 [auto] T-block**。
  //
  // 取舍：Action 小节整行都算强证据，因此"在 Action 的描述里提到但没实际改动"
  // 的文件也会被当成已覆盖。方向上这是安全的一侧——宁可多记一条带免责声明的
  // [auto]，也不要放过真实的漏记；而且这个性质在原有 em-dash 格式下本来就存在。
  // 真正不该算覆盖的是**别的小节**里的路径，那部分走 weakMentions()，
  // 不进这个集合。
  parsed.files = extractPaths(line);
  if (parsed.file && !parsed.files.includes(parsed.file)) {
    parsed.files.push(parsed.file);
  }

  return parsed;
}

// 路径形态：可选的目录段 + `stem.ext`，扩展名必须以字母开头。
// 这样 `src/a.ts` / `README.md` 命中，而 `3.0` / `v1.2.3` / `500` 不命中。
//
// 目录段刻意不含 `/` 和 `\`，并且每段长度有上界。原写法
// `(?:[A-Za-z0-9_.\-\\[\]]+[\/\\])*` 里字符类**包含**分隔符，量词又是嵌套的，
// 回溯就是平方级：实测一条 20k 字符的 Action 行要让 parseLogText 花 914ms
// （5k→57ms、10k→237ms，翻倍输入四倍耗时）。CLI 和 MCP server 都在单进程里
// 串行解析，一条脏 Action 就等于把整个工具的响应时间挂上去。
// 分隔符唯一 + 段长 ≤128 之后，每个起始位置的尝试次数是常数，整体回到线性。
const PATH_SEG = '[A-Za-z0-9_.\\[\\]-]{1,128}';
const PATH_FILE = '[A-Za-z0-9_.\\-\\[\\]]{1,128}\\.[A-Za-z][A-Za-z0-9]{0,7}';
// 开头的 `[A-Za-z]:` 与分隔符各自最多一次，不参与量词嵌套，所以不影响线性。
const PATH_TOKEN_RE = new RegExp(
  `(?:[A-Za-z]:)?[\\\\/]?(?:${PATH_SEG}[\\\\/])+${PATH_FILE}|[A-Za-z0-9_.\\-\\[\\]]{1,128}\\.[A-Za-z][A-Za-z0-9]{0,7}`,
  'g'
);

/** 从一行文本里抽取所有路径 token（去重、保序） */
function extractPaths(text) {
  if (!text) return [];
  const found = String(text).match(PATH_TOKEN_RE) || [];
  const seen = new Set();
  const out = [];
  for (const f of found) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
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
  const implausible = [];
  let currentStatus = null;
  let nextId = 1;

  // 从标题行提取 next_id（畸形值不可信，留给下面按实际条目推导）
  const headerMatch = lines[0] && lines[0].match(/next_id:\s*R(\d+)/);
  if (headerMatch) {
    const parsed = toPlausibleId(headerMatch[1]);
    if (parsed === null) {
      implausible.push({ kind: 'R', source: 'requirements.md', rawId: 'R' + headerMatch[1], line: 1 });
    } else {
      nextId = parsed;
    }
  }

  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
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
      const parsedId = toPlausibleId(rId);
      if (parsedId === null) {
        implausible.push({ kind: 'R', source: 'requirements.md', rawId: 'R' + rId, line: lineNo });
      }
      items.push({
        // 条目保留（需求本身是有信息量的），但畸形编号不参与分配与连续性检查
        id: parsedId !== null ? parsedId : clampForDisplay(rId),
        implausibleId: parsedId === null,
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

  // 只认编号可信的条目：一个畸形 R 号就能让下一条需求跟着飞到天上去。
  const realIds = plausibleIds(items);
  if (realIds.length > 0) {
    const maxReal = maxNumber(realIds);
    // 标题行缺失（或值不可信）时按条目推导，否则保证 next_id 不小于已有编号
    nextId = headerMatch && nextId > maxReal ? nextId : maxReal + 1;
  }

  const openCount = items.filter(i => i.status === 'Open').length;
  const doneCount = items.filter(i => i.status === 'Done').length;
  const cancelledCount = items.filter(i => i.status === 'Cancelled').length;
  const uncertainCount = items.filter(i => i.uncertain).length;

  return { items, nextId, openCount, doneCount, cancelledCount, uncertainCount, implausible };
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
    return { adrs: [], count: 0, implausible: [] };
  }

  const lines = content.split('\n');
  const adrs = [];
  const implausible = [];
  let currentAdr = null;
  let currentField = null;

  let adrLineNo = 0;
  for (const line of lines) {
    adrLineNo++;
    const trimmed = line.trim();

    // ADR 标题: ## ADR-1 · title · T<n>
    const adrMatch = trimmed.match(/^##\s+ADR-(\d+)\s*·\s*(.+?)\s*·\s*T(\d+)\s*$/);
    if (adrMatch) {
      if (currentAdr) {
        adrs.push(currentAdr);
      }
      const parsedId = toPlausibleId(adrMatch[1]);
      if (parsedId === null) {
        implausible.push({ kind: 'ADR', source: 'decisions.md', rawId: 'ADR-' + adrMatch[1], line: adrLineNo });
      }
      currentAdr = {
        id: parsedId !== null ? parsedId : clampForDisplay(adrMatch[1]),
        implausibleId: parsedId === null,
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

  return { adrs, count: adrs.length, implausible };
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
    return { latestT: 0, date: null, entries: {}, hasArchive: false, handoffGenerated: null, malformedIndexT: false };
  }

  const lines = content.split('\n');
  const result = {
    latestT: 0,
    date: null,
    entries: {},
    hasArchive: false,
    handoffGenerated: null,
    malformedIndexT: false,
  };

  // 标题行: # Index · T<n> · <date>
  const headerMatch = lines[0] && lines[0].match(/^#\s+Index\s*·\s*T(\d+)\s*·\s*(.+)$/);
  if (headerMatch) {
    // T0 是合法状态：bootstrap 之后、第一条记录之前就是这个值（lib/bootstrap.js 写的模板就是 T0）。
    // 这里绝不能套用 toPlausibleId()（它的 `>= 1` 是给"真实存在的 T 块编号"用的），
    // 否则每个刚初始化的项目都会被 verify 报成 ERROR，而 pre-commit 跑的就是 verify --quiet，
    // 结果是新项目第一次提交被拦下 —— 与"没有 pocket 的仓库绝不能锁死提交"是同一类事故。
    const parsedT = parseInt(headerMatch[1], 10);
    const usable = Number.isSafeInteger(parsedT) && parsedT >= 0 && parsedT <= MAX_PLAUSIBLE_ID;
    result.malformedIndexT = !usable;
    result.latestT = usable ? parsedT : 0;
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

  // 标题行（编号不可信时读作 0="未知"，别让手改的 `# State · T99999…` 冒充进度）
  const headerMatch = lines[0] && lines[0].match(/^#\s+State\s*·\s*T(\d+)/);
  if (headerMatch) {
    result.latestT = toPlausibleId(headerMatch[1]) || 0;
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

    if (currentEntry && trimmed) {
      // addAbsoluteEntry 把正文按 `> text` 的 blockquote 形式写入
      // （`>` 正是防止正文里的 `## T<n>` 被误认成新条目的手段），
      // 所以这里必须剥掉前缀收下，否则 content 永远是空串。
      const body = trimmed.replace(/^>\s?/, '');
      if (isPlaceholderLine(body)) continue;
      currentEntry.content += (currentEntry.content ? '\n' : '') + body;
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
  const log = parseLog(pocketDir);
  const requirements = parseRequirements(pocketDir);
  const decisions = parseDecisions(pocketDir);
  return {
    log,
    requirements,
    decisions,
    index: parseIndex(pocketDir),
    state: parseState(pocketDir),
    preferences: parsePreferences(pocketDir),
    absolute: parseAbsolute(pocketDir),
    // 三个带编号的文件共用一份畸形编号清单，verify 用它报"这一行需要修"
    implausible: log.implausible.concat(requirements.implausible, decisions.implausible),
  };
}

module.exports = {
  parseLog,
  parseLogAll,
  parseLogText,
  parseRequirements,
  parseDecisions,
  parseIndex,
  parseState,
  parsePreferences,
  parseAbsolute,
  parseAll,
  plausibleIds,
  toPlausibleId,
  MAX_PLAUSIBLE_ID,
};
