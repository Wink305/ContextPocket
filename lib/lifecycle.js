'use strict';

/**
 * ContextPocket — 写操作之后的固定动作
 *
 * 每次改动 pocket 内容后要做两件附带的事：刷新用户 hub 的活跃信息、重建搜索索引。
 * 这两件事此前在 CLI、MCP、importer 里一共抄了 7 遍，已经出现分叉
 * （例如 archive 在 CLI 里会跳过 `result.skipped` 的情况，在 MCP 里不会）。
 * 收拢到这里之后，两个入口不可能再走偏。
 *
 * 两件都是 best-effort：记录本身已经落盘，hub 或索引失败不该让命令报错 ——
 * 索引会在下次 search 时懒重建，hub 只是跨项目的活跃度视图。
 */

const { getProjectRoot } = require('./core');
const { touchProject } = require('./userhub');
const { buildIndex } = require('./indexer');

/**
 * @param {string} pocketDir
 * @param {object} [opts]
 * @param {number} [opts.latestT] 给了才更新 hub 的活跃信息（只有"新增一轮"才给）
 * @param {string} [opts.gist] 一并写进 hub 的最近一轮摘要
 * @param {boolean} [opts.index=true] 是否刷新搜索索引；`--no-index` 时传 false
 * @param {object} [opts.indexOpts] 透传给 buildIndex，如 { rebuild: true }
 * @returns {object} { hub: boolean, index: boolean } —— 各做成了没有，供 --json 使用
 */
function afterWrite(pocketDir, opts = {}) {
  const done = { hub: false, index: false };

  if (typeof opts.latestT === 'number' && opts.latestT > 0) {
    try {
      touchProject(getProjectRoot(pocketDir), { latestT: opts.latestT, gist: opts.gist });
      done.hub = true;
    } catch (e) { /* hub 不可用（只读 HOME、并发） */ }
  }

  if (opts.index !== false) {
    try {
      buildIndex(pocketDir, opts.indexOpts || {});
      done.index = true;
    } catch (e) { /* 索引在下次 search 时懒刷新 */ }
  }

  return done;
}

module.exports = { afterWrite };
