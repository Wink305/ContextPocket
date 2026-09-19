'use strict';

/**
 * ContextPocket — 常量定义
 * Zero-dependency. Works in Node.js 14+.
 */

const POCKET_DIR_NAME = 'ContextPocket';

// 核心文件（bootstrap 必建）
const CORE_FILES = [
  'index.md',
  'log.md',
  'state.md',
  'requirements.md',
  'code-map.md',
  'decisions.md',
  'preferences.md',
  'absolute.md',
  'config.md',
  'readme.md',
];

// 按需文件（用到才创建）
const ON_DEMAND_FILES = [
  'log-archive.md',
  'handoff.md',
];

const ALL_FILES = [...CORE_FILES, ...ON_DEMAND_FILES];

// lite 模式下的核心文件（5 个）
const LITE_CORE_FILES = [
  'index.md',
  'log.md',
  'state.md',
  'code-map.md',
  'readme.md',
];

// 默认配置
const DEFAULT_CONFIG = {
  project_type: 'fullstack',
  mode: 'full',
  archive_at: 800,
  recent_keep: 30,
  language: 'zh',
  quiet: false,
  tags_default: [
    '需求变更', '代码逻辑', '架构决策', 'Bug', '偏好',
    '依赖', '测试', 'UI', 'API', '部署', '文档', '坑点', '冲突', 'correction',
  ],
};

// 英文标签
const EN_TAGS = [
  'requirement-change', 'code-logic', 'arch-decision', 'bug', 'preference',
  'dependency', 'test', 'ui', 'api', 'deploy', 'docs', 'pitfall', 'conflict', 'correction',
];

// T-block 的子节（按顺序）
const TBLOCK_SECTIONS = [
  'User',
  'Action',
  'Commits',
  'Decisions & Constraints',
  'Pitfalls',
  'Preferences',
  'Conflicts',
  'Attachments',
  'Uncertain',
];

// 操作类型（中文）
const ACTION_TYPES_ZH = [
  '新增', '修改', '删除', '重构', '修复', '移动', '重命名',
  '新增文件', '删除文件', '新增依赖', '移除依赖', '配置',
];

// 操作类型（英文）
const ACTION_TYPES_EN = [
  'Added', 'Modified', 'Deleted', 'Refactored', 'Fixed', 'Moved', 'Renamed',
  'Added file', 'Deleted file', 'Added dep', 'Removed dep', 'Configured',
];

// 需求状态
const REQ_STATUSES = ['Open', 'Done', 'Cancelled'];

// 严重程度
const SEVERITY = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

module.exports = {
  POCKET_DIR_NAME,
  CORE_FILES,
  ON_DEMAND_FILES,
  ALL_FILES,
  LITE_CORE_FILES,
  DEFAULT_CONFIG,
  EN_TAGS,
  TBLOCK_SECTIONS,
  ACTION_TYPES_ZH,
  ACTION_TYPES_EN,
  REQ_STATUSES,
  SEVERITY,
};
