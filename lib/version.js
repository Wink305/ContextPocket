'use strict';

/**
 * ContextPocket — 版本号的唯一读取点
 *
 * package.json 的 `version` 是本包版本唯一的真值来源。此前只有 MCP 入口读它
 * （mcp-server.js 里一个 IIFE），CLI 没有 `--version`，用户问"我装的是哪版"时
 * 只能拿到整页 help；两处又各写一遍回退值，升级时漏一处就会两个入口报两个号。
 *
 * 现在两个入口都调这里：读到什么就报什么，读不到（拷进 skills 目录、只带了
 * bin/ 与 lib/ 那种安装方式）才用下面的兜底值，并且由用例断言兜底值与
 * package.json 一致——版本号写两遍这件事，必须有一条用例盯着它俩不许漂。
 */

/** 拿不到 package.json 时的兜底值。改动它必须同时改 package.json。 */
const FALLBACK_VERSION = '1.2.1';

/**
 * @param {string} [dir] 包根目录（默认本文件所在 lib 的上一级）
 * @returns {{version: string, source: 'package.json'|'fallback'}}
 */
function pkgVersion(dir) {
  const path = require('path');
  const fs = require('fs');
  const root = dir || path.join(__dirname, '..');
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    if (raw && typeof raw.version === 'string' && raw.version.trim()) {
      return { version: raw.version.trim(), source: 'package.json' };
    }
  } catch (e) {
    // 文件不在 / 不是合法 JSON / 没有 version 字段 —— 一律走兜底值
  }
  return { version: FALLBACK_VERSION, source: 'fallback' };
}

module.exports = {
  pkgVersion,
  FALLBACK_VERSION,
};
