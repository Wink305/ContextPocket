'use strict';

/**
 * ContextPocket — 一轮的时间（v2 新增）
 *
 * v1 的 T-block 只有"哪天"：日期来自它前面的 `--- SESSION: <date> ---`，同一天里的
 * 三轮记录在文件顺序之外完全无法排先后，也不知道一轮花了多久。
 * v2 给每一轮加一条结构行，紧跟在 `## T<n> ·` 标题之后：
 *
 *     --- WHEN: 2026-10-03 09:00 → 2026-10-03 11:30 ---   区间
 *     --- WHEN: 2026-10-03 14:47 ---                       时刻（默认 = 写下这一轮的那一刻）
 *     --- WHEN: 2026-10-03 (day) ---                       只有天（v1 搬过来的、或用户只说了日期）
 *     --- WHEN: stated: 上周三下午 ---                     用户原话，工具不做换算
 *
 * 三条设计约束，都是"别撒谎"：
 * 1. **宽化而不是替换**（借自 hindsight 的时间列：event_date 保留，occurred_* 新增可空）。
 *    SESSION 行照旧写、照旧读，`## T<n>` 标题一字不动，所以 v1 的 reader 遇到这一行会
 *    走它原有的"不在小节里就忽略"分支 —— v2 的 pocket 用旧版工具读只是看不到时间，不会读坏。
 * 2. **没有的信息就留空**。v1→v2 迁移只能从 SESSION 行拿到"日"，所以它写 `(day)`，
 *    绝不编造分针，也绝不拿文件 mtime 冒充记录时刻（归档、复制、git checkout 都会改 mtime）。
 * 3. **不做算术**。`09:00 → 11:30` 里的 11:30 缺日期时只补"同一天的 11:30"（这是补全，不是推算）；
 *    用户说"两个小时"不会被打成区间。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { readFileSafe } = require('./core');

/** 结构行本体（一行）；与 SESSION 行同一族视觉语法，前后各三个连字符 */
const WHEN_LINE_RE = /^---\s*WHEN:\s*(.+?)\s*---\s*$/;

/** 自由文本的前缀标记：`stated: 上周三下午` */
const STATED_PREFIX = 'stated: ';

const DAY_MARKER = ' (day)';

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
const TIME_RE = /(\d{1,2}):(\d{2})/;
/** 区间分隔符：全角箭头与 ASCII 箭头都收，其余（`~`、`-`）留给时刻本身 */
const RANGE_SPLIT_RE = /\s*(?:→|->)\s*/;

/**
 * 本地时刻，分钟精度：`2026-10-03 14:47`
 * @param {Date} [date]
 * @returns {string}
 */
function nowStamp(date) {
  const now = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 本地日期：`2026-10-03`（与 core.getTodayStr 同口径） */
function todayDate(date) {
  return nowStamp(date).slice(0, 10);
}

/** `2026-10-03 14:47` → 'HH:mm' 部分（补全区间右端用） */
function timePart(stamp) {
  const m = TIME_RE.exec(stamp);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/**
 * 把用户/Agent 给的一句话解析成时间值。**认不出来就原样留着**，不猜。
 *
 * @param {string} raw 例如 `2026-10-03 09:00 → 11:30` / `上周三下午`
 * @param {object} [opts]
 * @param {string} [opts.today] 缺日期时用来补全的日期（默认今天）
 * @param {Date}   [opts.now]   注入时钟，给测试用
 * @returns {{kind:'instant'|'range'|'day'|'text', from?:string, to?:string, date?:string, text?:string}}
 */
function parseWhen(raw, opts = {}) {
  const today = opts.today || todayDate(opts.now);
  const text = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const parts = text.split(RANGE_SPLIT_RE);
  if (parts.length >= 2) {
    const from = normalizePoint(parts[0], today);
    // 右端只写钟点时继承左端的日期 —— 补全，不推算
    const to = normalizePoint(parts[1], from.date);
    if (from.ok && to.ok) {
      return {
        kind: 'range',
        date: from.date,
        from: from.stamp,
        to: to.stamp,
      };
    }
    return { kind: 'text', text };
  }

  const one = normalizePoint(text, today);
  if (!one.ok) return { kind: 'text', text };
  if (one.precision === 'day') return { kind: 'day', date: one.date };
  return { kind: 'instant', date: one.date, from: one.stamp };
}

/**
 * 单个时间点：`2026-10-03 09:00` / `09:00`（今天）/ `2026-10-03`（只有天）
 * @returns {{ok:boolean, stamp?:string, date?:string, precision?:string}}
 */
function normalizePoint(value, fallbackDate) {
  const s = String(value || '').trim();
  if (!s) return { ok: false };
  const dateM = DATE_RE.exec(s);
  const timeM = TIME_RE.exec(s);
  if (dateM && timeM) {
    return {
      ok: true,
      precision: 'minute',
      date: dateM[0],
      stamp: `${dateM[0]} ${timeM[1].padStart(2, '0')}:${timeM[2]}`,
    };
  }
  if (dateM && !timeM) return { ok: true, precision: 'day', date: dateM[0] };
  if (!dateM && timeM && fallbackDate) {
    return { ok: true, precision: 'minute', date: fallbackDate, stamp: `${fallbackDate} ${timeM[1].padStart(2, '0')}:${timeM[2]}` };
  }
  return { ok: false };
}

/**
 * 时间值 → 结构行里 `WHEN:` 后面那段规范文本
 * @param {object} when parseWhen() / parseWhenLine() 的返回值
 * @returns {string|null}
 */
function formatWhen(when) {
  if (!when) return null;
  switch (when.kind) {
    case 'range':
      return `${when.from} → ${when.to}`;
    case 'instant':
      return when.from;
    case 'day':
      return `${when.date}${DAY_MARKER}`;
    case 'text':
      return STATED_PREFIX + when.text;
    default:
      return null;
  }
}

/**
 * 反解一行 `--- WHEN: … ---`。认不出的形状一律当自由文本留着，
 * 这样手改过的行也能被 recall 原样显示，而不是凭空变成"没有时间"。
 * @param {string} line
 * @returns {object|null}
 */
function parseWhenLine(line) {
  const m = String(line || '').match(WHEN_LINE_RE);
  if (!m) return null;
  let body = m[1].trim();
  if (!body) return null;

  if (body.startsWith(STATED_PREFIX)) {
    return { kind: 'text', text: body.slice(STATED_PREFIX.length).trim() };
  }
  if (body.endsWith(DAY_MARKER)) {
    const date = body.slice(0, -DAY_MARKER.length).trim();
    return DATE_RE.test(date) ? { kind: 'day', date } : { kind: 'text', text: body };
  }
  const parsed = parseWhen(body);
  return parsed || { kind: 'text', text: body };
}

/** 给人看的一行：区间、时刻、只有天、原话 */
function describeWhen(when) {
  if (!when) return '';
  if (when.kind === 'range') return `${when.from} → ${when.to}`;
  if (when.kind === 'instant') return `${when.from} (recorded at)`;
  if (when.kind === 'day') return `${when.date} (day only)`;
  return `“${when.text}” (as stated)`;
}

/**
 * 同样给人看，但吃的是**落盘的那条结构行**（`log append` 回给调用方的就是它）。
 *
 * 直接把 `--- WHEN: … ---` 打给用户读的是格式，不是时间；这一层把行还原成
 * 一句话，同时保证 `--json` 里的 `when` 仍是文件里逐字的那一行（机器要的是真相）。
 * @param {string|null} line
 * @returns {string}
 */
function describeWhenLine(line) {
  if (!line) return '';
  return describeWhen(parseWhenLine(String(line)));
}

/**
 * 结构行本体：`--- WHEN: 2026-10-03 14:47 ---`
 *
 * 这一行**不能**再过 `io.sanitizeInline()`：那道防护的正则里有 `-{3,}`，
 * 会把我们自己的 `--- WHEN:` 当成"用户想伪造结构行"逃生成 `\--- WHEN:`，
 * 于是解析器再也读不到它（`lib/io.js:45`）。安全性由这里自己保证：
 * 空白压成一行（换行一旦能进来就真能被伪造出第二个结构行），
 * 连续三个以上连字符会提前关掉本行的 ` --- `，甚至伪装成 SESSION/WHEN 行，
 * 所以换成 em dash —— 不改变语义，只保住行本身的形状。
 *
 * @param {object} when
 * @returns {string|null}
 */
function whenLine(when) {
  let body = formatWhen(when);
  if (!body) return null;
  body = body.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  body = body.replace(/-{3,}/g, '—');
  if (!body) return null;
  return `--- WHEN: ${body} ---`;
}

/**
 * 这个 pocket 是不是 v2（或更高）格式 —— 决定写入方要不要产出 WHEN 行。
 *
 * 为什么不问 lib/migrate.js：migrate require 了 validator，validator require 了 parser，
 * 而 parser 要读这里的时间行 —— 绕回 migrate 就成环了。版本戳本体就是 readme.md 第一行，
 * 这里直接读它，和 detectFormatVersion 同一个真相源。
 *
 * @param {string} pocketDir
 * @returns {boolean}
 */
function formatSupportsWhen(pocketDir) {
  const content = readFileSafe(path.join(pocketDir, 'readme.md')) || '';
  const m = content.match(/format:\s*v(\d+)/i);
  return !!m && Number(m[1]) >= 2;
}

module.exports = {
  WHEN_LINE_RE,
  DAY_MARKER,
  nowStamp,
  todayDate,
  parseWhen,
  formatWhen,
  parseWhenLine,
  describeWhen,
  describeWhenLine,
  whenLine,
  formatSupportsWhen,
};
