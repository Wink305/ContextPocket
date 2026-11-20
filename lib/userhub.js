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
 *   - hub 是注册表 + 只读跨项目检索，项目数据永远在各自项目的 ContextPocket/ 里
 *   - 检索强制全文扫描，不写索引、不写 hub；所有写入都是 best-effort
 *   - hub 故障绝不影响正常记录
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const { writeAtomic, readTextRequired, withLock } = require('./io');
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
      const raw = JSON.parse(readTextRequired(file));
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
  writeAtomic(getHubFile(), JSON.stringify(hub, null, 2));
}

/**
 * hub.json 的读-改-写必须整体持锁：两个 agent 同时记录偏好时，
 * 无锁的 readHub()/writeHub() 会让后写者覆盖前者的项目条目。
 * @param {(hub: object) => T} mutator
 * @returns {T}
 */
function mutateHub(mutator) {
  return withLock(getHubFile(), () => {
    const hub = readHub();
    const result = mutator(hub);
    writeHub(hub);
    return result;
  });
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
/**
 * 把一个项目的最新信息合并进 hub 对象（调用方负责持锁与写盘）
 * @returns {{registered: boolean}}
 */
function applyProjectInfo(hub, key, projectRoot, info = {}) {
  const existing = hub.projects[key] || {};
  const now = new Date().toISOString();
  hub.projects[key] = {
    name: info.name || existing.name || path.basename(projectRoot),
    projectType: info.projectType || existing.projectType || null,
    mode: info.mode || existing.mode || null,
    latestT: typeof info.latestT === 'number' ? Math.max(existing.latestT || 0, info.latestT) : (existing.latestT || 0),
    lastGist: info.gist || existing.lastGist || null,
    registeredAt: existing.registeredAt || now,
    lastActiveAt: now,
  };
  return { registered: !existing.registeredAt };
}

function registerProject(projectRoot, info = {}) {
  const key = projectKey(projectRoot);
  const outcome = mutateHub((hub) => ({
    ...applyProjectInfo(hub, key, projectRoot, info),
    project: hub.projects[key],
  }));
  return { key, registered: outcome.registered, hubFile: getHubFile(), project: outcome.project };
}

/**
 * 更新项目活跃信息（append T-block 时调用）；未注册的项目顺带补注册
 * @param {string} projectRoot
 * @param {object} info { latestT, gist }
 */
function touchProject(projectRoot, info = {}) {
  try {
    const key = projectKey(projectRoot);
    mutateHub((hub) => applyProjectInfo(hub, key, projectRoot, info));
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
  const key = projectKey(projectRoot);
  return mutateHub((hub) => {
    if (!hub.projects[key]) return false;
    delete hub.projects[key];
    return true;
  });
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
  return mutateHub((hub) => {
    const isNew = !(key in hub.prefs);
    hub.prefs[key] = value;
    return { isNew };
  });
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

// ============================================================
// 跨项目只读检索
// ============================================================

/**
 * 在 hub 注册的所有项目里做只读检索。
 *
 * 硬约束：
 *   - 强制 useIndex=false：绝不在别人的项目里建/刷新索引；
 *   - 处于隔离状态的项目直接跳过，内容一个字节都不读；
 *   - 单个项目失败只记 skipped，不影响其余项目。
 *
 * 结果按项目最近活跃排序，并用轮转方式选取，避免最新项目吃满全部名额。
 *
 * @param {string} keyword
 * @param {object} [opts] { limit } 跨项目返回上限；<=0 表示全部
 * @returns {object}
 */
function searchProjects(keyword, opts = {}) {
  const kw = String(keyword === undefined || keyword === null ? '' : keyword).trim();
  if (!kw) {
    return { ok: false, error: 'keyword is required', keyword: '' };
  }

  // 惰性加载：hub list / pref 不需要为检索多加载模块
  const { isPocketDir, intOption } = require('./core');
  const { detectIsolation } = require('./isolate');
  const { searchAny } = require('./query');

  const rawLimit = intOption(opts.limit, 20);
  const limit = rawLimit > 0 ? rawLimit : null;

  const projects = listProjects();
  const skipped = [];
  const groups = [];
  const seen = new Set();
  let searched = 0;
  let total = 0;

  for (const { key, project } of projects) {
    const name = project.name || path.basename(key);
    const pocketDir = path.join(key, 'ContextPocket');
    const resolved = path.resolve(pocketDir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    // 隔离优先于"缺失"：物理隔离时 ContextPocket/ 本来就不在原位，
    // 但原因是隔离，不该误报成 missing-pocket。
    let isolation = { isolated: false };
    try {
      isolation = detectIsolation({ cwd: key, pocketDir });
    } catch (e) {
      isolation = { isolated: false };
    }
    if (isolation.isolated) {
      skipped.push({ key, name, reason: 'isolated' });
      continue;
    }

    if (!isPocketDir(pocketDir)) {
      skipped.push({ key, name, reason: 'missing-pocket' });
      continue;
    }

    searched += 1;
    try {
      const hit = searchAny(pocketDir, kw, {
        useIndex: false,
        limit: limit === null ? 0 : limit,
      });
      total += hit.total;
      if (hit.total > 0) {
        groups.push({
          key,
          name,
          projectType: project.projectType || null,
          latestT: project.latestT || 0,
          lastActiveAt: project.lastActiveAt || null,
          total: hit.total,
          rows: hit.results,
          shown: [],
        });
      }
    } catch (e) {
      skipped.push({
        key,
        name,
        reason: 'error',
        message: String(e && e.message ? e.message : e),
      });
    }
  }

  // 轮转选取：先给每个项目一条，再给第二条……保证多项目都能露头
  let picked = 0;
  let round = 0;
  let added = true;
  while (added && (limit === null || picked < limit)) {
    added = false;
    for (const g of groups) {
      if (round >= g.rows.length) continue;
      g.shown.push(g.rows[round]);
      picked += 1;
      added = true;
      if (limit !== null && picked >= limit) break;
    }
    round += 1;
  }

  const results = groups
    .filter((g) => g.shown.length > 0)
    .map((g) => ({
      key: g.key,
      name: g.name,
      projectType: g.projectType,
      latestT: g.latestT,
      lastActiveAt: g.lastActiveAt,
      total: g.total,
      count: g.shown.length,
      hasMore: g.shown.length < g.total,
      rows: g.shown,
    }));

  return {
    ok: true,
    keyword: kw,
    limit,
    projects: projects.length,
    searched,
    matched: groups.length,
    count: picked,
    total,
    hasMore: picked < total,
    skipped,
    results,
  };
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
  searchProjects,
};
