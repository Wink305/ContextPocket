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
  secret_scan: true,
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
//
// Author 排在最前：多 Agent 写同一个 ContextPocket/ 时，"这一轮是谁记下的"
// 必须在块的第一行就能看到，否则两份历史混在一起无法分辨来源。
// 它是小节而不是结构行（对比 `--- WHEN: ---`），所以不涉及格式版本 ——
// v1 的 pocket 里出现 `### Author` 完全合法。
const TBLOCK_SECTIONS = [
  'Author',
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

// `--- SESSION: 2026-10-03 ---`：日期分隔线，属于它**后面**那批块。
// parser 用它给块打 session，archive 切分保留块时也必须把它留在保留块前面，
// 两处必须用同一份定义，否则归档会让 surviving 块静默丢掉 session。
const SESSION_LINE_RE = /^---\s*SESSION:\s*(\d{4}-\d{2}-\d{2})\s*---\s*$/;

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
  SESSION_LINE_RE,
  SEVERITY,
};
