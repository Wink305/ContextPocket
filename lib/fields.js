'use strict';

/**
 * ContextPocket — 入口参数形状
 *
 * CLI（`context-pocket log append --user "…"`）和 MCP（`log_append({user:"…"})`）
 * 是同一件事的两个壳。此前"一轮由哪些字段组成"在 4 个地方各抄了一遍
 * （bin 的 append/amend、mcp 的 append/amend），加一节时要改 4 处，
 * 漏掉的那处不会报错，只会把那一节的内容静默丢掉。
 *
 * 现在形状只在这里定义一次；两个入口的差异被收敛成"值本身是字符串还是数组"，
 * 由下面两个归一函数吸收，而不是各自复制一张字段表。
 */

const { pickFirst } = require('./core');

/** 可以一次给多条的字段：CLI 传逗号串，MCP 传 JSON 数组 */
const MULTI_FIELDS = ['tags', 'commits'];

/** 每轮最多一条文本的字段（顺序与 log.md 的节顺序一致） */
const TEXT_FIELDS = [
  'author',
  'user',
  'action',
  'decisions',
  'pitfalls',
  'preferences',
  'conflicts',
  'attachments',
  'uncertain',
];

/** 参数缺值的形态：CLI 把裸 flag 解析成 true，JSON 侧可能是 null/空串 */
function isMissing(value) {
  return value === undefined || value === null || value === true || value === '';
}

/**
 * "带值的入参"取文本：同一概念的多种写法按顺序取第一个真给了值的，都没给值则 undefined。
 *
 * 为什么不能直接读 `obj.key`：CLI 里 `state update --summary --json` 会被 parseArgs 解析成
 * `summary === true`（flag 后面跟着别的选项，没有值可吃），直接存盘就在 state.md 里留下
 * 一行 `- true`；`decision add --context` 同理留下 `- Context: true`。记录里出现 "true"
 * 是谎话 —— 用户一个字都没写。只写 flag 等于没传，调用方据此报 "… is required"。
 *
 * 与 isMissing 的差别：isMissing 认的是"已知的缺值形状"，本函数只接受字符串/数字，
 * 因此 `false`、数组、对象这类同样不该进正文的值也一并挡掉。数字要收，因为 MCP 的
 * JSON 里 `{ tId: 3 }` 是合法入参，不是缺值。
 *
 * @param {object} obj - 参数对象（CLI 的 options / MCP 的 args）
 * @param {...string} keys - 候选键名，按优先级排列
 * @returns {string|undefined} 去掉首尾空白的文本；全都没给值则 undefined
 */
function textOption(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const text = String(v).trim();
    if (text !== '') return text;
  }
  return undefined;
}

/**
 * `--when`：这一轮发生的时间。**不是小节**，所以不进 TEXT_FIELDS ——
 * 它落在块头的 `--- WHEN: … ---` 结构行里（见 lib/when.js），内容由工具规范化，
 * 不是用户能逐字写进历史的一句话。
 * @param {*} value
 * @returns {string|null}
 */
function whenValue(value) {
  if (isMissing(value)) return null;
  const text = String(value).trim();
  return text || null;
}

/** 逗号串或数组 → 去空 trim 后的字符串数组 */
function toList(value) {
  if (isMissing(value)) return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return parts.map((s) => String(s).trim()).filter(Boolean);
}

/** 单条文本 → 0/1 元素数组（句子中的逗号不拆分） */
function toOne(value) {
  if (isMissing(value)) return [];
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return [String(value)];
}

/**
 * 各节内容（append 与 amend 共用）——不含 gist/tags，即 amend 的全部字段。
 * @param {object} src CLI options 或 MCP args
 * @returns {object} writer.appendLogBlock / amendLogBlock 的节字段
 */
function sectionFields(src) {
  const source = src || {};
  const out = {};
  for (const key of MULTI_FIELDS) {
    if (key !== 'tags') out[key] = toList(source[key]);
  }
  for (const key of TEXT_FIELDS) {
    // 兼容单数别名：Agent 常写 --pitfall 而不是 --pitfalls
    out[key] = toOne(key === 'pitfalls' ? pickFirst(source, 'pitfalls', 'pitfall') : source[key]);
  }
  out.when = whenValue(source.when);
  return out;
}

/**
 * 一整轮的字段（含 gist 与 tags）。
 *
 * gist 也走 textOption：`{ gist: true }` 在 MCP 侧是真的会发生的入参（Agent 把开关
 * 当值传），而它落在块头 `## T7 · <gist> · [标签]` 上就是一行谎话。
 * @param {object} src
 * @returns {object}
 */
function turnFields(src) {
  const source = src || {};
  return Object.assign({ gist: textOption(source, 'gist'), tags: toList(source.tags) }, sectionFields(source));
}

/**
 * 是否至少给了一节内容（amend 的"你没打算改任何东西"检查）。
 * 小节是数组，`when` 是字符串或 null，两种都算"打算改点东西"。
 * @param {object} fields sectionFields() 的返回值
 * @returns {boolean}
 */
function hasAnySection(fields) {
  return Object.keys(fields || {}).some((k) => {
    const value = fields[k];
    return Array.isArray(value) ? value.length > 0 : !!value;
  });
}

module.exports = {
  MULTI_FIELDS,
  TEXT_FIELDS,
  toList,
  toOne,
  whenValue,
  textOption,
  sectionFields,
  turnFields,
  hasAnySection,
};
