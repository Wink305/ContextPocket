'use strict';

/**
 * ContextPocket — 核心工具
 * 路径解析、目录检测、配置读取
 */

const fs = require('fs');
const path = require('path');
const { readText, readTextOr } = require('./io');
const {
  POCKET_DIR_NAME,
  DEFAULT_CONFIG,
  EN_TAGS,
} = require('./constants');

/**
 * 从指定目录向上查找 ContextPocket/
 * @param {string} startDir - 起始目录
 * @returns {string|null} ContextPocket 目录的绝对路径，找不到返回 null
 */
function findPocketDir(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (current !== root) {
    const pocketPath = path.join(current, POCKET_DIR_NAME);
    if (fs.existsSync(pocketPath) && fs.statSync(pocketPath).isDirectory()) {
      return pocketPath;
    }
    current = path.dirname(current);
  }

  // 检查根目录
  const pocketPath = path.join(root, POCKET_DIR_NAME);
  if (fs.existsSync(pocketPath) && fs.statSync(pocketPath).isDirectory()) {
    return pocketPath;
  }

  return null;
}

/**
 * 检查给定目录是否是 ContextPocket 目录
 * @param {string} dir
 * @returns {boolean}
 */
function isPocketDir(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return false;
  }
  // 至少有 index.md 和 log.md
  return (
    fs.existsSync(path.join(dir, 'index.md')) &&
    fs.existsSync(path.join(dir, 'log.md'))
  );
}

/**
 * 获取项目根目录（ContextPocket 的父目录）
 * @param {string} pocketDir
 * @returns {string}
 */
function getProjectRoot(pocketDir) {
  return path.dirname(pocketDir);
}

/**
 * 读取并解析 config.md
 * @param {string} pocketDir
 * @returns {object} 配置对象
 */
function readConfig(pocketDir) {
  const configPath = path.join(pocketDir, 'config.md');
  const config = { ...DEFAULT_CONFIG };

  if (!fs.existsSync(configPath)) {
    return config;
  }

  try {
    const content = readTextOr(configPath, '');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // 跳过注释和空行
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('>')) {
        continue;
      }

      // 匹配 "- key: value" 格式
      const match = trimmed.match(/^-\s*(\w+):\s*(.+)$/);
      if (match) {
        const [, key, rawValue] = match;
        const value = parseConfigValue(key, rawValue.trim());
        if (value !== undefined) {
          config[key] = value;
        }
      }
    }
  } catch (e) {
    // 配置解析失败，返回默认值
    console.warn(`Warning: Failed to parse config.md, using defaults. ${e.message}`);
  }

  // 根据 language 调整标签
  if (config.language === 'en') {
    config.tags_default = EN_TAGS;
  }

  return config;
}

/**
 * 解析配置值
 * @param {string} key
 * @param {string} raw
 * @returns {*}
 */
function parseConfigValue(key, raw) {
  // 先把行尾注释摘掉。以前只在"字符串"分支里摘，于是 templates/config.md
  // 那种 `quiet: false   # 说明` 的写法解析出来是字符串 'false' —— 真值判断为"开着"，
  // 用户关掉每轮确认提示从来没有效果；`archive_at: 800   # 说明` 同理退化成字符串。
  raw = stripTrailingComment(raw);
  // `- key:   # 只写了注释` 等同于没配这一项，让默认值继续生效
  if (raw === '') return undefined;

  // 数组 [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => s.trim());
  }

  // 数字
  if (/^\d+$/.test(raw)) {
    return parseInt(raw, 10);
  }

  // 布尔值
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  return raw;
}

/**
 * 去掉 `value   # 注释`。只有 `#` 前面是空白时才当注释，
 * 这样 `language: zh#1` 这类真的取值不会被截断；
 * 数组整段保留判断（标签本身可能带 #）。
 * @param {string} raw
 * @returns {string}
 */
function stripTrailingComment(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s || s.startsWith('[')) return s;
  // 找第一个"空白 + #"：`zh#1   # 说明` 要截到第二个 #，不是第一个
  const i = s.search(/\s#/);
  if (i < 0) return s.startsWith('#') ? '' : s;
  return s.slice(0, i).trim();
}

/**
 * 安全读取文件（归一 BOM / CRLF）
 * @param {string} filePath
 * @returns {string|null}
 */
function readFileSafe(filePath) {
  return readText(filePath);
}

/**
 * 检查文件是否存在
 * @param {string} filePath
 * @returns {boolean}
 */
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (e) {
    return false;
  }
}

// ============================================================
// 模板占位符识别
// ============================================================

/**
 * 判断一个条目是不是模板占位符（而非真实内容）
 *
 * 两种形态：
 *   1) 整行被 <> 包裹        `- <2-3 lines: what to do first>`
 *   2) key + 占位符值        `- build: <command>`
 *
 * 只在这两种"整段都是占位符"的情况下返回 true，避免误伤真实内容里
 * 合法出现的尖括号（泛型 `Map<T>`、HTML 标签、`git log --format=<...>` 等）。
 * @param {string} text
 * @returns {boolean}
 */
function isPlaceholderLine(text) {
  if (!text) return false;

  // 剥掉列表符号 / 引用符号 / 缩进
  const t = String(text)
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s?/, '')
    .trim();

  if (t.length < 3) return false;
  if (!t.startsWith('<')) return false;

  // 形态 1：整行就是 <...>
  if (t.endsWith('>') && !t.slice(1, -1).includes('<')) return true;

  // 形态 2：key: <...>（值整段是占位符）
  const keyed = t.match(/^[^:<>]{1,40}:\s*(<[^<>]*>)$/);
  return Boolean(keyed);
}

/**
 * 过滤掉模板占位符，只保留真实内容
 * @param {string[]} items
 * @returns {string[]}
 */
function stripPlaceholders(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => !isPlaceholderLine(item));
}

/**
 * 清理一行"分段用 · 拼接"的摘要（readme.md 的 Project Identity 行）
 *
 * 模板行形如：
 *   project: cp-e2e · <one line: what this project does> · stack: <tech, ...> · type: frontend
 * 其中真实值和占位符混在一起。这里逐段判断，丢掉占位符段，
 * 保留真实段；`key: <占位符>` 整段丢弃。
 * @param {string} line
 * @returns {string} 清理后的行；若无任何真实段则返回空串
 */
function cleanIdentityLine(line) {
  if (!line) return '';

  const segments = String(line)
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);

  const kept = [];
  for (const seg of segments) {
    // 整段是占位符 → 丢
    if (isPlaceholderLine(seg)) continue;
    // `key: <占位符>` → 丢
    if (/^[^:<>]{1,40}:\s*<[^<>]*>$/.test(seg)) continue;
    kept.push(seg);
  }

  return kept.join(' · ');
}

/**
 * 取第一个有值的参数（用于同一语义的参数别名）
 *
 * 背景：`state update` 历史上用单数 `--pitfall`，`log append` / `log amend`
 * 用复数 `--pitfalls`。改名会破坏已有脚本，所以两个名字都收，按给出的顺序
 * 取先命中的那个。
 *
 * @param {object} obj - 参数对象
 * @param {...string} keys - 候选键名，按优先级排列
 * @returns {*} 第一个有值的键的值；都没有则 undefined
 */
function pickFirst(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * 取数组最大值。
 *
 * 不用 `Math.max(...arr)`：展开参数在 V8 上有实参个数上限，
 * T-block 编号累积到几万时 `Math.max(...tIds)` 会抛 RangeError，
 * 而这个调用点在每次解析 log.md 的路径上。
 * @param {number[]} nums
 * @param {number} [fallback] - 空数组时的返回值
 * @returns {number}
 */
function maxNumber(nums, fallback = 0) {
  if (!nums || nums.length === 0) return fallback;
  let max = -Infinity;
  for (const n of nums) {
    const v = typeof n === 'number' ? n : Number(n);
    if (!Number.isNaN(v) && v > max) max = v;
  }
  return max === -Infinity ? fallback : max;
}

/**
 * 取数组最小值，同 maxNumber 避免展开参数上限
 * @param {number[]} nums
 * @param {number} [fallback]
 * @returns {number}
 */
function minNumber(nums, fallback = 0) {
  if (!nums || nums.length === 0) return fallback;
  let min = Infinity;
  for (const n of nums) {
    const v = typeof n === 'number' ? n : Number(n);
    if (!Number.isNaN(v) && v < min) min = v;
  }
  return min === Infinity ? fallback : min;
}

/**
 * 数值参数解析：非数字回落到默认值。
 * 旧写法 `parseInt(x,10) || 5` 会把 0 也当成缺省，而 `parseInt(x,10)` 直接
 * 把 NaN 传进阈值计算（`maxT - NaN` → 比较恒 false → 静默变成"没有可蒸馏内容"）。
 * CLI 与 MCP 两个入口共用这一份，MCP 侧原先是裸 parseInt，"limit: abc" 会变成 NaN
 * 一路渗进 distill 的截断阈值。
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function intOption(value, fallback) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * "T3" / "3" → 3；其余（含 0、负数、非数字）→ NaN
 * @param {*} value
 * @returns {number}
 */
function toTId(value) {
  const n = parseInt(String(value || '').replace(/^T/i, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * 本地日期的 YYYY-MM-DD。log.md 的 SESSION 分隔线、digest 文件名、index.md 的日期
 * 都用它 —— 三处原先各有一份同样的实现，改格式时很容易只改一处，
 * 于是 SESSION 行与日期列逐渐对不上。
 * @returns {string}
 */
function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  findPocketDir,
  isPocketDir,
  getProjectRoot,
  readConfig,
  readFileSafe,
  fileExists,
  isPlaceholderLine,
  stripPlaceholders,
  cleanIdentityLine,
  pickFirst,
  maxNumber,
  minNumber,
  intOption,
  toTId,
  getTodayStr,
};
