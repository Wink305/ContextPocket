'use strict';

/**
 * ContextPocket — 核心工具
 * 路径解析、目录检测、配置读取
 */

const fs = require('fs');
const path = require('path');
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
    const content = fs.readFileSync(configPath, 'utf-8');
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

  // 字符串（去掉行尾注释）
  const commentIdx = raw.indexOf('#');
  if (commentIdx > 0) {
    return raw.slice(0, commentIdx).trim();
  }
  return raw;
}

/**
 * 安全读取文件
 * @param {string} filePath
 * @returns {string|null}
 */
function readFileSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
  } catch (e) {
    return null;
  }
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

/**
 * 获取 assets 目录路径
 * @param {string} pocketDir
 * @returns {string}
 */
function getAssetsDir(pocketDir) {
  return path.join(pocketDir, 'assets');
}

module.exports = {
  findPocketDir,
  isPocketDir,
  getProjectRoot,
  readConfig,
  readFileSafe,
  fileExists,
  getAssetsDir,
};
