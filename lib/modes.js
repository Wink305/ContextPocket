'use strict';

/**
 * quan 的版本内模式。
 *
 * solo：人驱动（默认）。完整人类输出，允许交互式命令。
 * agent：Agent / 脚本驱动。禁止交互式提问，输出去掉 ANSI 颜色。
 *
 * 模式不是输出分级：`--brief` / `--full` 仍由各命令自己处理。
 */

const MODES = ['solo', 'agent'];

function resolveEditionMode(options = {}, entry = 'cli') {
  const raw = options['edition-mode'];
  if (raw === undefined) return entry === 'mcp' ? 'agent' : 'solo';
  if (raw === true) {
    throw new Error('--edition-mode needs a value: solo or agent');
  }
  const value = String(raw).trim().toLowerCase();
  if (!value) {
    throw new Error('--edition-mode needs a value: solo or agent');
  }
  if (!MODES.includes(value)) {
    throw new Error('unknown edition mode "' + raw + '" (expected solo or agent)');
  }
  return value;
}

module.exports = {
  MODES,
  resolveEditionMode,
};
