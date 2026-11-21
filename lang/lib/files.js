'use strict';

/**
 * 从 T-block 的 actions 里提取「这一轮真正动过的文件」。
 *
 * 优先用 parser 给出的 files（Action 文本里能识别的全部路径），
 * 没有时回落到单个 file。强/弱证据的分层由 parser 决定，这里只做折叠。
 */

function extractFilesFromBlock(block) {
  const files = [];
  if (block && block.actions) {
    for (const action of block.actions) {
      if (!action) continue;
      if (action.files && action.files.length > 0) {
        files.push(...action.files);
      } else if (action.file) {
        files.push(action.file);
      }
    }
  }
  return files;
}

module.exports = {
  extractFilesFromBlock,
};
