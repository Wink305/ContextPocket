'use strict';

/**
 * ContextPocket yuan — 版本内模式
 *
 * `edition.json` 声明了 focus / audit / migrate 三种模式；这里把它们落成
 * **默认值预设**，而不是新的输出格式：
 *
 *   focus    最少上下文：小预算、默认不带 repo map、检索只取前几条
 *   audit    全证据链：大预算、带 repo map、检索取完整一页
 *   migrate  大版本迁移：超大预算、带 repo map、检索不截断
 *
 * 显式参数永远优先：`--edition-mode focus --max-tokens 9000` 仍然是 9000。
 * 不传 `--edition-mode` 时保持命令原有默认值，不改变既有行为。
 */

const MODES = ['focus', 'audit', 'migrate'];

const PROFILES = {
  focus: { maxTokens: 1500, includeRepoMap: false, searchLimit: 5 },
  audit: { maxTokens: 12000, includeRepoMap: true, searchLimit: 20 },
  migrate: { maxTokens: 50000, includeRepoMap: true, searchLimit: 0 },
};

/**
 * @param {object} [options] CLI 的 `edition-mode` 或 MCP 的 `editionMode`
 * @returns {{name: string|null, profile: object}}
 */
function resolveMode(options = {}) {
  const raw = options['edition-mode'] !== undefined ? options['edition-mode'] : options.editionMode;
  if (raw === undefined || raw === null || raw === '') return { name: null, profile: {} };
  if (raw === true) {
    throw new Error('--edition-mode needs a value: focus, audit or migrate');
  }
  const name = String(raw).trim().toLowerCase();
  if (!MODES.includes(name)) {
    throw new Error('unknown edition mode "' + raw + '" (expected focus, audit or migrate)');
  }
  return { name, profile: PROFILES[name] };
}

module.exports = {
  MODES,
  PROFILES,
  resolveMode,
};
