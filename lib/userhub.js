'use strict';

/**
 * ContextPocket — 用户级 Hub（跨项目记忆中枢）
 * 灵感来自 Basic Memory 的用户级知识库定位：项目级 ContextPocket/ 之外，
 * 再给开发者一层「跟着人走」的注册表 + 全局偏好。
 *
 * 存储：~/.contextpocket/hub.json（可用环境变量 CONTEXTPOCKET_HOME 重定向，
 * 便于放进网盘 / dotfiles 仓库实现多机共享）。
 *
 * 内容：
 *   - projects：注册过的项目（路径 → 名称 / 类型 / 最新 T / 最近活跃时间）
 *   - prefs：   用户级全局偏好（跨项目生效，项目 preferences.md 缺失时兜底）
 *
 * 设计原则：
 *   - hub 只是注册表，项目数据永远在各自项目的 ContextPocket/ 里
 *   - 所有写入都是 best-effort，hub 故障绝不影响正常记录
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HUB_VERSION = 1;

// ============================================================
// 路径与读写
// ============================================================

/**
 * Hub 目录（默认 ~/.contextpocket，可用 CONTEXTPOCKET_HOME 重定向）
 * @returns {string}
 */
function getHubDir() {
  const custom = process.env.CONTEXTPOCKET_HOME;
  if (custom && String(custom).trim()) {
    return path.resolve(String(custom).trim());
  }
  return path.join(os.homedir(), '.contextpocket');
}

function getHubFile() {
  return path.join(getHubDir(), 'hub.json');
}

function readHub() {
  const file = getHubFile();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (raw && raw.version === HUB_VERSION) return raw;
    }
  } catch (e) {
    // 损坏的 hub 文件 → 重新开始（注册表可随时重建，不丢项目数据）
  }
  return {
    version: HUB_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    projects: {},
    prefs: {},
  };
}

function writeHub(hub) {
  const dir = getHubDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  hub.updatedAt = new Date().toISOString();
  fs.writeFileSync(getHubFile(), JSON.stringify(hub, null, 2), 'utf-8');
}

// ============================================================
// 项目注册表
// ============================================================

function projectKey(projectRoot) {
  // 统一为绝对路径 + 正斜杠，Windows / macOS / Linux 混用同一份 hub
  return path.resolve(projectRoot).replace(/\\/g, '/');
}

/**
 * 注册 / 更新一个项目
 * @param {string} projectRoot
 * @param {object} [info] { name, projectType, mode, latestT, gist }
 * @returns {object} { key, registered, hubFile }
 */
function registerProject(projectRoot, info = {}) {
  const hub = readHub();
  const key = projectKey(projectRoot);
  const existing = hub.projects[key] || {};
  const now = new Date().toISOString();

  hub.projects[key] = {
    name: info.name || existing.name || path.basename(projectRoot),
    projectType: info.projectType || existing.projectType || null,
    mode: info.mode || existing.mode || null,
    latestT: typeof info.latestT === 'number' ? info.latestT : (existing.latestT || 0),
    lastGist: info.gist || existing.lastGist || null,
    registeredAt: existing.registeredAt || now,
    lastActiveAt: now,
  };

  writeHub(hub);
  return { key, registered: !existing.registeredAt, hubFile: getHubFile(), project: hub.projects[key] };
}

/**
 * 更新项目活跃信息（append T-block 时调用）
 * @param {string} projectRoot
 * @param {object} info { latestT, gist }
 */
function touchProject(projectRoot, info = {}) {
  try {
    const hub = readHub();
    const key = projectKey(projectRoot);
    if (!hub.projects[key]) {
      // 未注册的项目直接活跃记录补注册（bootstrap 之外的静默兜底）
      registerProject(projectRoot, info);
      return;
    }
    const p = hub.projects[key];
    if (typeof info.latestT === 'number') p.latestT = Math.max(p.latestT, info.latestT);
    if (info.gist) p.lastGist = info.gist;
    p.lastActiveAt = new Date().toISOString();
    writeHub(hub);
  } catch (e) {
    // best-effort：hub 故障不影响记录
  }
}

/**
 * 移除一个项目（不删项目内的 ContextPocket/，只清注册表）
 * @param {string} projectRoot
 * @returns {boolean} 是否真的删除了
 */
function removeProject(projectRoot) {
  const hub = readHub();
  const key = projectKey(projectRoot);
  if (!hub.projects[key]) return false;
  delete hub.projects[key];
  writeHub(hub);
  return true;
}

/**
 * 列出所有项目（按最近活跃倒序）
 * @returns {Array<{key: string, project: object}>}
 */
function listProjects() {
  const hub = readHub();
  return Object.entries(hub.projects)
    .map(([key, project]) => ({ key, project }))
    .sort((a, b) => String(b.project.lastActiveAt || '').localeCompare(String(a.project.lastActiveAt || '')));
}

// ============================================================
// 用户级全局偏好
// ============================================================

/**
 * 设置全局偏好
 * @param {string} key
 * @param {string} value
 * @returns {{isNew: boolean}}
 */
function setGlobalPref(key, value) {
  const hub = readHub();
  const isNew = !(key in hub.prefs);
  hub.prefs[key] = value;
  writeHub(hub);
  return { isNew };
}

/**
 * 读取全局偏好
 * @param {string} [key] - 省略则返回全部
 * @returns {string|object|null}
 */
function getGlobalPref(key) {
  const hub = readHub();
  if (key === undefined) return hub.prefs;
  return Object.prototype.hasOwnProperty.call(hub.prefs, key) ? hub.prefs[key] : null;
}

module.exports = {
  getHubDir,
  getHubFile,
  readHub,
  registerProject,
  touchProject,
  removeProject,
  listProjects,
  setGlobalPref,
  getGlobalPref,
};
