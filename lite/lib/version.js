'use strict';

/**
 * ContextPocket Lite — 版本号的唯一读取点
 *
 * 与主包 lib/version.js 同一套实现（读到什么就报什么，读不到才用兜底值），
 * 差别只在两处常量：lite/package.json 与兜底值 2.0.0。
 *
 * 对外展示两位（2.0-lite）；package.json 内保持三位 semver（2.0.0）——
 * npm 的世界里 semver 是硬约束，「不要 2.0.0」落在外观层而不是包元数据层
 * （docs/ROADMAP-2.0.md §8 / §12 的拍板）。
 */

/** 拿不到 package.json 时的兜底值。改动它必须同时改 lite/package.json。 */
const FALLBACK_VERSION = '2.0.0';

/** 对外展示的两位版本（README / --version 的标题行），不进任何包元数据。 */
const DISPLAY_VERSION = '2.0-lite';

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
