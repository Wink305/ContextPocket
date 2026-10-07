'use strict';

/**
 * ContextPocket — 编号修复（repair）
 *
 * 为什么需要这个文件：`log append` 的下一号是 `latestT + 1`（lib/writer.js），
 * 而写入锁只在一台机器里有效 —— `withPocketLock` 把锁放在 `os.tmpdir()`
 * （lib/io.js），两个 Agent 在两台机器上各写一轮，彼此看不见对方的锁，
 * 两边都算出同一个 T9。合并之后 `log.md` 里就有两个 `## T9`。
 *
 * verify 早就看得见它：`checkTIdContinuity` 报 `Duplicate T-id: T9`（ERROR），
 * 修法的措辞以前只有一句人话（`Rename or merge duplicate blocks.`）——
 * 工具能检测、不能动手。对 Agent 来说那句答案是死的：手改 markdown 是 skill
 * 明令禁止的，`git commit --no-verify` 又是绕过检查。于是合并之后的 pocket 会卡在
 * "每次 append 都成功写入、然后以 error 退出" 的状态里越来越乱。
 * 现在那句 fix 直接指向本文件（lib/validator.js 的修法文案），而动手的部分在这里。
 *
 * repair 把那一句人话变成一次可回滚的写入，并且把两件不好办的事摊开说：
 *   - 编号动了哪些（映射表）
 *   - 有哪些地方还写着旧编号（引用清单）。引用**默认只列不改**：
 *     `T9` 这个号在历史上同时指过两块，只有读的人知道每一处指的是哪一块。
 *   - 有哪些**附件文件名**还带着旧编号。这一类永不改写：文件名要变是"mv 文件 + 改文本"
 *     两半，只做后一半就是一条断链，所以工具只给准确的 mv 命令。
 */

const path = require('path');
const { writeAtomic, readTextOr, readTextRequired, lockedWrite } = require('./io');
const { fileExists, getTodayStr } = require('./core');
const { toPlausibleId } = require('./parser');
const { verify } = require('./validator');

// 块头。与 lib/parser.js:170 认的是同一个形状，两处必须一致，
// 否则 repair 改完 parser 读不出来（或者反过来：repair 看不见 parser 看见的块）。
const HEADING_RE = /^##\s+T(\d+)\s*·/;

// 每个带 T 编号的文件，以及"编号在头行是派生值还是引用"。
// 头行（第 1 行）上的 `T<n>` 是写入层维护的"截至第几轮"，属于派生计数器；
// 正文里的 `T<n>` 是人写下的引用，属于要给人过目的那一份。
const HEADER_DERIVED = ['state.md', 'requirements.md', 'decisions.md', 'preferences.md', 'code-map.md', 'handoff.md'];

// 正文引用扫描范围。index.md 不在里面：它的每一行都是派生计数（由 updateIndexHeader 重写）。
// log-archive.md 只报不改 —— 归档文件自己写着 "Read-only reference. Do not modify."
const REFERENCE_FILES = [
  { file: 'log-archive.md', writable: false, skipHeadings: true },
  { file: 'requirements.md', writable: true },
  { file: 'decisions.md', writable: true },
  { file: 'absolute.md', writable: true },
  { file: 'state.md', writable: true },
  { file: 'handoff.md', writable: true },
  { file: 'code-map.md', writable: true },
  { file: 'preferences.md', writable: true },
];

/**
 * 按文件顺序取出所有块头。
 * @param {string[]} lines
 * @returns {Array<{line:number, id:number|null, raw:string, heading:string}>} id=null 表示畸形编号
 */
function collectHeadings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (!m) continue;
    out.push({ line: i, raw: m[1], id: toPlausibleId(m[1]), heading: lines[i] });
  }
  return out;
}

/** 是否存在撞号（畸形编号不参与：那一类由 verify 第 11 项单独管） */
function hasDuplicateIds(headings) {
  const seen = new Set();
  for (const h of headings) {
    if (h.id === null) continue;
    if (seen.has(h.id)) return true;
    seen.add(h.id);
  }
  return false;
}

/**
 * 生成重编号方案：撞号块及其之后的块整体后移一格。
 *
 * 为什么是"及其之后"而不是"只动重复的那一块"：log.md 是按时间追加的，
 * 编号应当随文件顺序递增。A、B 两台机器各写一轮都得到 T9，B 后来又写了 T10，
 * 那么合并后正确的读法是「T8, T9(A), T10(B 的第一轮), T11(B 的第二轮)」，
 * 而不是把 B 的第一轮塞到一个凭空出现的 99 上。
 *
 * 没有撞号时这个遍历是恒等的（每个 id 都大于前一个），所以 repair 不会
 * 顺手改写它没被要求改的东西。
 *
 * @param {object[]} headings collectHeadings() 的返回值
 * @returns {Array<{line:number, from:number, to:number, heading:string}>}
 */
function planIdRenumber(headings) {
  const changes = [];
  let prev = 0;
  for (const h of headings) {
    if (h.id === null) continue; // 畸形编号原地留着：它的修法不是挪号
    const target = Math.max(h.id, prev + 1);
    if (target !== h.id) {
      changes.push({ line: h.line, from: h.id, to: target, heading: h.heading });
    }
    prev = target;
  }
  return changes;
}

/**
 * 引用：一个**独立**的 `T<数字>`。
 *
 * 两边的边界都必须判，否则 `--apply-refs` 会改坏正文（都有过复现）：
 *   - 前面不能接字母/数字/下划线：`GPT4`、`RTX4090`、`HTTP2` 里的 `T4`/`T2`
 *     不是引用，映射里有 4 就会被写成 `GPT5`。
 *   - 前面不能是 `/` 或 `\`：那是路径里的一截，交给 `findFileTokens` 当文件名处理。
 *   - 后面不能紧跟字母/数字/下划线/`-`：`T3-diagram.png` 是文件名不是引用。
 *   - 后面是 `.png` 这类扩展名时也不算引用；句子结尾的 `见 T9.` 必须仍然算，
 *     所以只排除"点 + 2~4 个字母"这种扩展形状。
 */
const T_REF_RE = /(?<![\w/.\\])T(\d+)(?![\w-])(?!\.\w{2,4}\b)/g;

/** 按原 token 的位数补齐 0（`T03`→`T04`、`T3`→`T4`、≥100 保持三位） */
function padId(n, width) {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/**
 * 把一行里所有"命中映射表"的 `T<旧号>` 同时换成新号。
 *
 * 必须是**同时**替换而不是逐条 replace：级联方案里 `T9→T10` 和 `T10→T11`
 * 同时存在，先替换 9→10 再替换 10→11 会把同一个引用挪两次。
 *
 * @param {string} text
 * @param {Map<number,number>} map from → to
 * @returns {{text:string, hits:number[]}}
 */
function remapTRefs(text, map) {
  const hits = [];
  const out = String(text).replace(T_REF_RE, (whole, digits) => {
    const n = parseInt(digits, 10);
    if (!map.has(n)) return whole;
    hits.push(n);
    return 'T' + map.get(n);
  });
  return { text: out, hits };
}

/** 只列出引用（不改写）：与 remapTRefs 同一套判据，避免"清单和改写不一致" */
function findTRefs(text, map) {
  const hits = [];
  String(text).replace(T_REF_RE, (whole, digits) => {
    const n = parseInt(digits, 10);
    if (map.has(n)) hits.push(n);
    return whole;
  });
  return hits;
}

/**
 * 挑出这一行里"文件名形状的 T 号"，并算出改名的另一半。
 *
 * 判据按空格/顿号/括号切成 token，再要求整个 token 是 `[前缀/]T<数字>[-.其余]`
 * 这种形状（`-` 是命名规范里的 slug 分隔，`.` 是扩展名）。行尾标点先剥掉，
 * 否则 `- T3-diagram.png:` 因为那个冒号就认不出来了。
 *
 * 这类 token **永不进改写**：把正文写成 `assets/T4-diagram.png` 而磁盘上仍叫
 * `T03-diagram.png`，等于 repair 自己造出一条断链，零填充也丢了
 * （`SKILL-reference.md`「Asset filenames: T01, T02 … zero-padded」）。
 * 改名是两步（mv 文件 + 改文本），工具不做第一步，所以也不做第二步，
 * 只把准确的 mv 命令列出来交给人执行。
 *
 * @param {string} text
 * @param {Map<number,number>} map from → to
 * @returns {Array<{from:number,to:number,name:string,renamed:string,command:string}>}
 */
function findFileTokens(text, map) {
  const out = [];
  for (const raw of String(text).split(/[\s,，、;；()（）\[\]]+/)) {
    const token = raw.replace(/[:：.。!！?？]+$/, '');
    const m = token.match(/^(.*\/)?T(\d+)([-.][^\s]+)$/);
    if (!m) continue;
    const n = parseInt(m[2], 10);
    if (!map.has(n)) continue;
    const renamed = (m[1] || '') + 'T' + padId(map.get(n), m[2].length) + (m[3] || '');
    out.push({
      from: n,
      to: map.get(n),
      name: token,
      renamed,
      command: `mv "${token}" "${renamed}"`,
    });
  }
  return out;
}

/**
 * 头行里的 `T<n>` 是"截至第几轮"的派生值：撞号之后要么跟着映射走，
 * 要么（它还指着旧的最新轮时）直接对齐到新的最新轮。
 * @param {string} firstLine
 * @param {object} ctx { map, oldLatest, newLatest }
 * @returns {{line:string, changed:boolean}}
 */
function remapDerivedHeader(firstLine, ctx) {
  const m = firstLine.match(/T(\d+)/);
  if (!m) return { line: firstLine, changed: false };
  const n = parseInt(m[1], 10);
  let target = null;
  if (ctx.map.has(n)) target = ctx.map.get(n);
  else if (ctx.oldLatest > 0 && n === ctx.oldLatest) target = ctx.newLatest;
  if (target === null || target === n) return { line: firstLine, changed: false };
  return { line: firstLine.replace(/T\d+/, 'T' + target), changed: true };
}

function readLines(pocketDir, file) {
  const p = path.join(pocketDir, file);
  if (!fileExists(p)) return null;
  return readTextRequired(p).split('\n');
}

/**
 * 修复 log.md 里撞号的 T 编号。
 *
 * 保证：
 * - 写前把要动的文件整份读进内存，任何一步失败（含改完后 verify 变差）都原样回滚
 * - 只动 `log.md` 的块头编号；块里的每一行文字逐字保留
 * - 归档文件不改（它声明只读），只报告
 * - 正文引用默认只列不改，`applyRefs` 才动手
 *
 * @param {string} pocketDir
 * @param {object} [options]
 * @param {boolean} [options.dryRun] 只出方案，不写盘
 * @param {boolean} [options.applyRefs] 同时重写 pocket 内的旧编号引用
 * @param {string} [options.author] 记录块署名（谁跑的 repair）
 * @returns {object}
 */
function repairLogIds(pocketDir, options = {}) {
  const dryRun = !!options.dryRun;
  const applyRefs = !!options.applyRefs;

  const logPath = path.join(pocketDir, 'log.md');
  if (!fileExists(logPath)) {
    return { success: false, error: 'log.md not found' };
  }

  const lines = readTextRequired(logPath).split('\n');
  const headings = collectHeadings(lines);
  const beforeVerify = verify(pocketDir);

  if (!hasDuplicateIds(headings)) {
    return {
      success: true,
      changed: false,
      dryRun,
      renumbered: [],
      references: [],
      fileNames: [],
      duplicates: 0,
      latestT: headings.length > 0 ? headings[headings.length - 1].id : 0,
      message: '没有撞号的 T 编号 —— log.md 里没有需要重排的块',
      verifyBefore: errorSummary(beforeVerify),
    };
  }

  const changes = planIdRenumber(headings);
  const map = new Map(changes.map((c) => [c.from, c.to]));
  const oldLatest = Math.max.apply(null, headings.filter((h) => h.id !== null).map((h) => h.id).concat([0]));
  const newLatest = Math.max.apply(null, changes.map((c) => c.to).concat([oldLatest]));

  // 归档里已有的号：重排后的号如果撞上它，那块会在 recall/search 里被 log.md 遮住
  // （parseLogAll 是 live 优先）。repair 不擅自搬归档，只把这件事说出来。
  const archivedIds = new Set(collectHeadings(readLines(pocketDir, 'log-archive.md') || []).map((h) => h.id));
  const stillShadowed = [...map.values()].filter((to) => archivedIds.has(to));

  // ---------- 1. 重写 log.md：块头按行号改，其余行的引用按映射同时改 ----------
  const references = [];
  const fileNames = [];
  const newLogLines = lines.slice();
  for (let i = 0; i < lines.length; i++) {
    const change = changes.find((c) => c.line === i);
    if (change) {
      // 换的是 planIdRenumber 记下的那一行，所以直接改那串数字就行。
      // 别用 `from` 去拼正则：手写补零的 `## T02 ·` parser 认成 2，
      // 用 "T2" 去匹配就找不到行，repair 会安静地什么都没改。
      // 回调用函数拼接：'$1' + 3 在字符串里会被读成分组 $13。
      newLogLines[i] = lines[i].replace(/^(##\s+T)\d+/, (whole, prefix) => prefix + change.to);
      continue;
    }
    // 块头行不是引用：`## T2 · …` 声明的是"这一块的号是 2"。
    // 留下没动的号（撞号里保留原号的那一块）也命中映射表， substitute 会把保留块改走。
    if (HEADING_RE.test(lines[i])) continue;
    const remapped = applyRefs ? remapTRefs(lines[i], map) : { text: lines[i], hits: findTRefs(lines[i], map) };
    newLogLines[i] = remapped.text;
    for (const from of remapped.hits) {
      references.push({ file: 'log.md', line: i + 1, from, to: map.get(from), text: lines[i].trim(), rewritten: applyRefs });
    }
    // 文件名只列不改：改文本不改文件 = 造断链，所以这一步永远交给用户
    for (const f of findFileTokens(lines[i], map)) {
      fileNames.push(Object.assign({ file: 'log.md', line: i + 1 }, f));
    }
  }

  // ---------- 2. 其余文件：派生头行总是对齐，正文引用按 applyRefs 决定 ----------
  const touched = { 'log.md': newLogLines.join('\n') };
  for (const file of HEADER_DERIVED) {
    const fileLines = readLines(pocketDir, file);
    if (!fileLines) continue;
    const header = remapDerivedHeader(fileLines[0], { map, oldLatest, newLatest });
    let mutated = header.changed;
    if (header.changed) fileLines[0] = header.line;

    for (let i = 1; i < fileLines.length; i++) {
      const hits = findTRefs(fileLines[i], map);
      for (const from of hits) {
        references.push({ file, line: i + 1, from, to: map.get(from), text: fileLines[i].trim(), rewritten: applyRefs });
      }
      for (const f of findFileTokens(fileLines[i], map)) {
        fileNames.push(Object.assign({ file, line: i + 1 }, f));
      }
      if (applyRefs && hits.length > 0) {
        fileLines[i] = remapTRefs(fileLines[i], map).text;
        mutated = true;
      }
    }
    if (mutated) touched[file] = fileLines.join('\n');
  }

  for (const spec of REFERENCE_FILES) {
    const file = spec.file;
    if (HEADER_DERIVED.includes(file)) continue;
    const fileLines = readLines(pocketDir, file);
    if (!fileLines) continue;
    let mutated = false;
    for (let i = 0; i < fileLines.length; i++) {
      // 归档里的 `## T<n> ·` 是块定义而不是引用，而且这份文件声明只读
      if (spec.skipHeadings && HEADING_RE.test(fileLines[i])) continue;
      const hits = findTRefs(fileLines[i], map);
      for (const from of hits) {
        references.push({ file, line: i + 1, from, to: map.get(from), text: fileLines[i].trim(), rewritten: applyRefs && spec.writable });
      }
      for (const f of findFileTokens(fileLines[i], map)) {
        fileNames.push(Object.assign({ file, line: i + 1, readOnly: !spec.writable }, f));
      }
      if (applyRefs && spec.writable && hits.length > 0) {
        fileLines[i] = remapTRefs(fileLines[i], map).text;
        mutated = true;
      }
    }
    if (mutated) touched[file] = fileLines.join('\n');
  }

  if (dryRun) {
    return {
      success: true,
      changed: true,
      dryRun: true,
      renumbered: changes.map((c) => ({ from: c.from, to: c.to, line: c.line + 1, heading: c.heading.trim() })),
      references,
      fileNames,
      duplicates: changes.length,
      latestTBefore: oldLatest,
      latestTAfter: newLatest,
      stillShadowed,
      applyRefs,
      message: `dry-run：${changes.length} 个块要重编号，${references.length} 处引用${applyRefs ? '会被改写' : '只列出'}`
        + (fileNames.length > 0 ? `，另有 ${fileNames.length} 个附件文件名带旧编号（只列，工具不改文件）` : ''),
      verifyBefore: errorSummary(beforeVerify),
    };
  }

  // ---------- 3. 落盘（先备份内存副本，失败全量回滚） ----------
  const backups = new Map();
  for (const key of Object.keys(touched)) {
    backups.set(key, readTextOr(path.join(pocketDir, key), ''));
  }
  // index.md 不在 touched 里（它的 T 号是算出来的，不是映射出来的），
  // 但回滚必须把它一起恢复：否则编号回到了旧值、索引头却写着新值，
  // repair 自己就成了那个把 pocket 改坏的东西。
  if (fileExists(path.join(pocketDir, 'index.md'))) {
    backups.set('index.md', readTextOr(path.join(pocketDir, 'index.md'), ''));
  }

  const restore = () => {
    for (const [key, content] of backups) writeAtomic(path.join(pocketDir, key), content);
  };

  try {
    for (const [key, content] of Object.entries(touched)) {
      writeAtomic(path.join(pocketDir, key), content);
    }

    // index.md 的头行与 `log.md → Ta–Tb` 范围是派生值，重算而不是映射
    const writer = require('./writer');
    writer.updateIndexHeader(pocketDir, parseLatestT(pocketDir), getTodayStr());

    // 4. 记录块：编号被工具动过这件事本身要进历史
    const record = appendRepairRecord(pocketDir, {
      changes,
      references,
      fileNames,
      applyRefs,
      author: options.author,
      language: options.language,
    });

    const afterVerify = verify(pocketDir);
    if (afterVerify.errorCount > beforeVerify.errorCount
      || hasDuplicateHeading(collectHeadings(readTextRequired(logPath).split('\n')))) {
      restore();
      return {
        success: false,
        error: `repair rolled back: verify still reports ${afterVerify.errorCount} error(s) after renumbering`
          + ` (was ${beforeVerify.errorCount}). Nothing was changed.`,
        renumbered: changes.map((c) => ({ from: c.from, to: c.to, line: c.line + 1 })),
        references,
        fileNames,
      };
    }

    return {
      success: true,
      changed: true,
      dryRun: false,
      renumbered: changes.map((c) => ({ from: c.from, to: c.to, line: c.line + 1, heading: c.heading.trim() })),
      references,
      fileNames,
      duplicates: changes.length,
      latestTBefore: oldLatest,
      latestTAfter: parseLatestT(pocketDir),
      filesWritten: Object.keys(touched).concat(record.wroteRecord ? ['log.md (记录块)', 'index.md'] : ['index.md']),
      recordTId: record.tId,
      stillShadowed,
      applyRefs,
      verifyBefore: errorSummary(beforeVerify),
      verifyAfter: errorSummary(afterVerify),
      message: `已重编号 ${changes.length} 个块`
        + (applyRefs ? `，并改写 ${references.filter((r) => r.rewritten).length} 处引用`
          : `，${references.length} 处旧引用已列出（未改写）`),
    };
  } catch (e) {
    try {
      restore();
    } catch (rollbackErr) {
      throw new Error(`${e.message} (rollback also failed: ${rollbackErr.message})`);
    }
    throw e;
  }
}

/** 改完之后还有没有重复块头（回滚判据；畸形编号不算，它们本来就不参与编号） */
function hasDuplicateHeading(headings) {
  return hasDuplicateIds(headings);
}

function parseLatestT(pocketDir) {
  const { parseLog } = require('./parser');
  return parseLog(pocketDir).latestT;
}

function errorSummary(result) {
  return { errorCount: result.errorCount, warningCount: result.warningCount, infoCount: result.infoCount };
}

/**
 * 追加一条记录块，写明"哪些号被工具挪走了、哪些引用还没改"。
 *
 * 为什么值得占一轮：repair 改变的是别的一切东西赖以索引的坐标。历史里如果不留
 * 这一手，下一次读 pocket 的人（或 Agent）只能从编号本身猜"这里是不是被重排过"。
 * 内容全部是事实陈述：映射表、引用计数、有没有动引用。不写 `--- WHEN ---` 之外的
 * 任何推断，也不做冲突扫描（那只是工具自己的一次改号动作，不是一轮工作）。
 */
function appendRepairRecord(pocketDir, ctx) {
  const { appendLogBlock } = require('./writer');
  const { readConfig } = require('./core');
  const lang = readConfig(pocketDir).language === 'en' ? 'en' : 'zh';

  const mapping = ctx.changes.map((c) => `T${c.from}→T${c.to}`);
  const shown = mapping.slice(0, 12);
  if (mapping.length > shown.length) shown.push(`… (+${mapping.length - shown.length})`);

  const pending = ctx.references.filter((r) => !r.rewritten);
  const byFile = new Map();
  for (const r of pending) byFile.set(r.file, (byFile.get(r.file) || 0) + 1);

  const zh = lang === 'zh';
  const fields = {
    gist: zh
      ? `repair：${ctx.changes.length} 个撞号的 T-block 已重编号`
      : `repair: renumbered ${ctx.changes.length} T-block(s) with duplicate ids`,
    tags: ['auto'],
    user: [zh
      ? '（由 context-pocket repair 自动记录 —— 这不是用户的一轮，是工具改过编号这个事实。）'
      : '(Recorded automatically by context-pocket repair — not a user turn, but the fact that the tool moved T-ids.)'],
    action: [
      (zh ? '修改 log.md — 撞号块及其后的块整体后移：' : 'Modified log.md — the colliding block and everything after it shifted up: ')
        + shown.join(', '),
      ctx.applyRefs
        ? (zh ? `并重写了 ${ctx.references.filter((r) => r.rewritten).length} 处旧编号引用`
          : `and rewrote ${ctx.references.filter((r) => r.rewritten).length} stale T-id reference(s)`)
        : (zh ? '（未改写任何引用）' : '(no references rewritten)'),
    ],
  };
  if (ctx.author) fields.author = [ctx.author];

  if (pending.length > 0) {
    fields.uncertain = [zh
      ? `正文里还有 ${pending.length} 处写着旧 T 号（${[...byFile].map(([f, n]) => `${f}×${n}`).join('、')}）：`
        + '这些引用指的是撞号前的哪一块，只有读的人知道，所以 repair 没有代改。核对后用 context-pocket repair --apply-refs 或手工更正。'
      : `${pending.length} reference(s) still name the old T-ids (${[...byFile].map(([f, n]) => `${f}×${n}`).join(', ')}): `
        + 'only a reader knows which of the two colliding blocks each one meant, so repair left them. Run repair --apply-refs or fix them by hand.',
    ];
  }

  // 附件文件名是"文件 + 文本"两半：只改文本会当场造出断链，所以 repair 两半都不碰，
  // 把准确的 mv 命令留在历史里，由人执行（执行后 `verify` 会确认链接不再断）。
  const files = ctx.fileNames || [];
  if (files.length > 0) {
    const uniq = [...new Map(files.map((f) => [f.name, f])).values()];
    const listed = uniq.slice(0, 6).map((f) => f.command).join(zh ? '；' : '; ');
    fields.uncertain = (fields.uncertain || []).concat(zh
      ? `另有 ${files.length} 处附件文件名仍带旧编号（${listed}${uniq.length > 6 ? '；…' : ''}）：`
        + '改文件是 mv，不是改文本，repair 不替历史改名。先执行 mv，再 `context-pocket verify` 确认附件链接没断。'
      : `${files.length} attachment filename(s) still carry the old ids (${listed}${uniq.length > 6 ? '; …' : ''}): `
        + 'renaming means mv, not rewriting text, and repair does not move history. Run the mv, then `context-pocket verify` to confirm the links hold.',
    );
  }

  const r = appendLogBlock(pocketDir, Object.assign(fields, { conflictCheck: false }));
  return { tId: r.tId, wroteRecord: !!r.success };
}

module.exports = {
  repairLogIds: lockedWrite(repairLogIds),
  // 纯函数导出给单元测试：方案生成和引用判定这两步必须能在不落盘的情况下验证
  collectHeadings,
  hasDuplicateIds,
  planIdRenumber,
  remapTRefs,
  findTRefs,
  findFileTokens,
  remapDerivedHeader,
  HEADING_RE,
};
