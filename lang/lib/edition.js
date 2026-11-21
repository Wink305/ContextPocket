'use strict';

/**
 * 读取本版的 edition.json（能力清单）。
 *
 * 这是"这一版到底提供什么"的机器可读真值：包名、版本线、核心文件数、
 * 命令 / 工具数、模式与缓存能力。help、README、MCP 与测试都从这里取数，
 * 避免文档和实现对不上。
 */

const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'edition.json');

function readEdition() {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  manifestPath,
  readEdition,
};
