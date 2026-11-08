'use strict';

/**
 * ContextPocket — 文件 I/O 基础层
 *
 * 三件事：
 *   1) 原子写：临时文件 + fsync + rename，避免读到半截文件
 *   2) 进程间锁：read-modify-write 期间互斥，避免并发覆盖
 *   3) 换行/BOM 归一：读进来统一 \n，写出去统一 \n
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 25;
// 超过这个时长还持有锁的进程视为已崩溃，锁可被回收
const LOCK_STALE_MS = 15000;

// ============================================================
// 换行 / BOM 归一
// ============================================================

/**
 * 把文本归一为 LF、去 BOM。所有读入口都过这里。
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
function normalizeText(text) {
  if (text === null || text === undefined) return null;
  let out = String(text);
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  if (out.indexOf('\r') !== -1) out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return out;
}

/**
 * 会被当成"结构行"的行首标记：标题、列表、引用、分隔线、有序列表、Setext 下划线。
 * 我们的解析器按行首匹配这些模式，Markdown 渲染器也一样，所以必须一并处理。
 */
const STRUCTURE_LINE = /^[ \t]*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|={3,}|-{3,}|\*{3,})[^\n]*$/gm;

/**
 * 把一行"看起来像结构行"的文本降级成普通文本。
 *
 * 用反斜杠转义而不是缩进：CommonMark 允许标题/列表前有 0–3 个空格，
 * 只加一个空格的写法在 GitHub 上照样渲染成标题，等于没防住；
 * `\#`、`\-`、`\>` 都是合法转义，渲染为字面文本，而解析器的
 * `^##` / `^- ` / `^---` 一律不再命中。
 */
function escapeStructureLines(text) {
  return String(text).replace(STRUCTURE_LINE, (m) => '\\' + m.trim());
}

/**
 * 清洗用户传入的单行/多行值，防止内容伪造结构行。
 *
 * log.md 用 `## T<n>` 分块、用 `### Section` 分节，requirements.md/decisions.md
 * 用 `- R1 …` / `- Key: …` 分字段，所以正文里出现以这些模式开头的行会被
 * 解析器当成新结构 —— 一个 gist 里塞 `\n## T9999 · 伪造` 就能造出一条所有
 * 下游都信任的条目。这里把这类行降级为普通文字，保留内容不保留结构语义。
 * @param {string} value
 * @returns {string}
 */
function sanitizeInline(value) {
  if (value === null || value === undefined) return '';
  return escapeStructureLines(normalizeText(String(value))).trim();
}

/**
 * 多行正文：每行加 blockquote 前缀，与 addAbsoluteEntry 的写法保持一致
 * @param {string} value
 * @returns {string}
 */
function sanitizeBlockquote(value) {
  const text = normalizeText(String(value === null || value === undefined ? '' : value));
  return text
    .split('\n')
    .map((line) => `> ${escapeStructureLines(line.trim())}`)
    .join('\n');
}

// ============================================================
// 读
// ============================================================

/**
 * 安全读取文本文件（归一换行），不存在返回 null
 * @param {string} filePath
 * @returns {string|null}
 */
function readText(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return normalizeText(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

/**
 * 读取文本文件，不存在或失败时返回 fallback
 * @param {string} filePath
 * @param {string} fallback
 * @returns {string}
 */
function readTextOr(filePath, fallback) {
  const text = readText(filePath);
  return text === null ? String(fallback === undefined ? '' : fallback) : text;
}

/**
 * 必须存在才能读的场景：给出可操作的错误信息，而不是裸 ENOENT 堆栈
 * @param {string} filePath
 * @param {string} [hint] - 例如 "run `context-pocket bootstrap`"
 * @returns {string}
 */
function readTextRequired(filePath, hint) {
  let text = null;
  try {
    text = normalizeText(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Missing required file: ${filePath}${hint ? ` (${hint})` : ''}`);
    }
    throw e;
  }
  return text;
}

// ============================================================
// 原子写
// ============================================================

function sleepSync(ms) {
  // SharedArrayBuffer + Atomics.wait 是 Node 14 可用的同步等待
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch (e) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 退化忙等 */ }
  }
}

function fsyncWrite(filePath, data) {
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, data);
    try {
      fs.fsyncSync(fd);
    } catch (e) {
      // 某些平台/文件系统不支持 fsync，rename 仍然安全
    }
  } finally {
    fs.closeSync(fd);
  }
}

function uniqueTempPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}.tmp`);
}

/**
 * 原子写入：临时文件 → fsync → rename 覆盖目标
 *
 * @param {string} filePath
 * @param {string} content
 * @param {object} [opts]
 * @param {boolean} [opts.force] - rename 被占用时最后再试一次直写（Windows 上别的进程打开着文件）
 */
function writeAtomic(filePath, content, opts = {}) {
  const data = normalizeText(String(content));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmp = uniqueTempPath(filePath);
  try {
    fsyncWrite(tmp, data);
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      // Windows：目标文件被编辑器/杀毒占用时 rename 会 EPERM/EBUSY
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES' && e.code !== 'EEXIST') {
        throw e;
      }
      let renamed = false;
      for (let i = 0; i < 10 && !renamed; i++) {
        sleepSync(30);
        try {
          fs.renameSync(tmp, filePath);
          renamed = true;
        } catch (e2) {
          if (e2.code !== 'EPERM' && e2.code !== 'EBUSY' && e2.code !== 'EACCES') throw e2;
        }
      }
      if (renamed) return;
      if (opts.force === false) {
        throw new Error(`Cannot replace ${filePath}: file is locked by another program`);
      }
      // 最后兜底：直写。原子性丢失，但内容不会丢。
      fs.writeFileSync(filePath, data, 'utf-8');
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (e) { /* 已被 rename 或无权限，忽略 */ }
  }
}

// ============================================================
// 进程间锁（可重入）
// ============================================================

// 本进程持有的锁：绝对路径 → 引用计数
const heldLocks = new Map();

function lockPathFor(filePath) {
  return `${filePath}.cp-lock`;
}

function readLockOwner(lockPath) {
  try {
    const raw = normalizeText(fs.readFileSync(lockPath, 'utf-8'));
    const parsed = JSON.parse(raw || '{}');
    return { pid: parsed.pid, at: parsed.at };
  } catch (e) {
    return {};
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // 锁文件所在目录可能还不存在（首次写 hub.json 时 ~/.contextpocket 未建）
  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // 持有者已死或锁过期 → 回收
      let stat = null;
      try {
        stat = fs.statSync(lockPath);
      } catch (e2) {
        continue; // 锁刚好被释放，重试
      }
      const owner = readLockOwner(lockPath);
      const age = Date.now() - (stat.mtimeMs || 0);
      let ownerAlive = true;
      if (owner.pid && owner.pid !== process.pid) {
        try {
          process.kill(owner.pid, 0);
        } catch (e3) {
          ownerAlive = false; // ESRCH：进程已不存在
        }
      }
      if (!ownerAlive || age > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch (e4) { /* 别人抢先回收了，重试 */ }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `ContextPocket is busy: another process (pid ${owner.pid || 'unknown'}) ` +
            `holds the lock on ${path.basename(lockPath)}. Wait a moment and retry.`
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

/**
 * 对某个文件加互斥锁执行 fn，支持同进程重入。
 *
 * @param {string} filePath - 被保护的目标文件（锁文件为 filePath + .cp-lock）
 * @param {(function(): T)} fn
 * @returns {T}
 */
function withLock(filePath, fn) {
  const lockPath = path.resolve(lockPathFor(filePath));
  const depth = heldLocks.get(lockPath) || 0;

  if (depth === 0) {
    acquireLock(lockPath);
  }
  heldLocks.set(lockPath, depth + 1);

  try {
    return fn();
  } finally {
    const next = (heldLocks.get(lockPath) || 1) - 1;
    if (next <= 0) {
      heldLocks.delete(lockPath);
      try {
        fs.unlinkSync(lockPath);
      } catch (e) { /* 已被回收 */ }
    } else {
      heldLocks.set(lockPath, next);
    }
  }
}

/**
 * 同时锁多个文件（按路径排序取锁，避免死锁）
 * @param {string[]} filePaths
 * @param {(function(): T)} fn
 * @returns {T}
 */
function withLocks(filePaths, fn) {
  const sorted = [...new Set(filePaths.map((p) => path.resolve(p)))].sort();
  const inner = () => (sorted.length === 0 ? fn() : withLock(sorted[0], () => withLocks(sorted.slice(1), fn)));
  return inner();
}

/**
 * pocket 目录级别的互斥锁。
 *
 * 放在系统临时目录而不是 ContextPocket/ 里，避免污染用户仓库、
 * 也不需要往 .gitignore 加条目。锁名按 pocket 绝对路径哈希，
 * 因此同一项目的多个进程（CLI + MCP server）会互相排队。
 * @param {string} pocketDir
 * @param {(function(): T)} fn
 * @returns {T}
 */
function withPocketLock(pocketDir, fn) {
  const hash = crypto.createHash('sha1').update(path.resolve(pocketDir)).digest('hex').slice(0, 16);
  return withLock(path.join(os.tmpdir(), `contextpocket-${hash}`), fn);
}

/**
 * 把写入函数包成"整段持锁执行"
 * @param {(pocketDir: string, ...rest: any[]) => any} fn
 * @returns {(...args: any[]) => any}
 */
function lockedWrite(fn) {
  return function (pocketDir, ...rest) {
    return withPocketLock(pocketDir, () => fn(pocketDir, ...rest));
  };
}

// ============================================================
// 目录
// ============================================================

/**
 * 幂等创建目录
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 追加若干行到文本文件，已存在的行不重复添加
 * @param {string} filePath
 * @param {string[]} lines
 * @returns {{added: string[]}}
 */
function appendLinesIfMissing(filePath, lines) {
  const content = readTextOr(filePath, '');
  const existing = new Set(content.split('\n').map((l) => l.trim()));
  const added = lines.filter((l) => l && !existing.has(l.trim()));
  if (added.length === 0) return { added: [] };

  let next = content;
  if (next && !next.endsWith('\n')) next += '\n';
  next += added.join('\n') + '\n';
  writeAtomic(filePath, next);
  return { added };
}

module.exports = {
  normalizeText,
  sanitizeInline,
  sanitizeBlockquote,
  readText,
  readTextOr,
  readTextRequired,
  writeAtomic,
  withLock,
  withLocks,
  withPocketLock,
  lockedWrite,
  lockPathFor,
  ensureDir,
  appendLinesIfMissing,
  sleepSync,
};
