'use strict';

/**
 * ContextPocket Lite — 版本号的唯一读取点
 *
 * 与主包 lib/version.js 同一套实现（读到什么就报什么，读不到才用兜底值），
 * 差别只在常量：lite/package.json、兜底值与对外展示串。
 *
 * 展示规则（ROADMAP §12 + hotfix 追加）：稳定版对外两位加产品后缀
 * （2.1 → `2.1-lite`）；带 `-` 的预发布/hotfix 版显示完整串
 * （`2.0.1-Lite-hotfix1`）——后缀有语义，不能砍。
 */

/** 拿不到 package.json 时的兜底值。改动它必须同时改 lite/package.json。 */
const FALLBACK_VERSION = '2.6-Lite-preview2';

/** 对外展示版本（--version 标题行 / version --json 的 display），不进任何包元数据。 */
const DISPLAY_VERSION = '2.6-Lite-preview2';

/**
 * @param {string} [dir] 包根目录（默认本文件所在 lib 的上一级）
 * @returns {{version: string, display: string, source: 'package.json'|'fallback'}}
 */
function pkgVersion(dir) {
  const path = require('path');
  const fs = require('fs');
  const root = dir || path.join(__dirname, '..');
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    if (raw && typeof raw.version === 'string' && raw.version.trim()) {
      return { version: raw.version.trim(), display: DISPLAY_VERSION, source: 'package.json' };
    }
  } catch (e) {
    // 文件不在 / 不是合法 JSON / 没有 version 字段 —— 一律走兜底值
  }
  return { version: FALLBACK_VERSION, display: DISPLAY_VERSION, source: 'fallback' };
}

module.exports = {
  pkgVersion,
  FALLBACK_VERSION,
  DISPLAY_VERSION,
};
