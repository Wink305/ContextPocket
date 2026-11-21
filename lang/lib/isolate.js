'use strict';

/**
 * ContextPocket — 隔离开关（isolated run）
 *
 * 用途：测试某个文件夹里的项目、跑一次性实验、CI 评测时，本轮需要
 * 完全不看之前的上下文，也不把测试轮次写回真实历史。
 *
 * 三层，按强度递增：
 *  1. 环境变量 CONTEXTPOCKET_ISOLATED=1 —— 一次性命令 / CI，不落盘。
 *  2. 项目根标记文件 .contextpocket-isolate —— touch 即开、删掉即关。
 *     以上两层由 CLI 与 MCP 统一拒绝所有读写，SKILL.md 也要求 Agent 不发起读取。
 *  3. 物理隔离：把 ContextPocket/ 改名为 ContextPocket.isolated/，
 *     常规路径下历史文件根本不在原位；工具检测到该目录同样进入隔离态。
 *
 * 边界：口袋是纯 Markdown，Agent 有文件系统访问权时，没有任何开关能阻止它
 * 主动翻目录。要物理级保证就用第 3 层（或把目录移出项目）。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');

const ISOLATE_ENV = 'CONTEXTPOCKET_ISOLATED';
const ISOLATE_MARKER = '.contextpocket-isolate';
const QUARANTINE_DIR = 'ContextPocket.isolated';
const POCKET_DIR = 'ContextPocket';

const ISOLATED_NOTE = [
  '# ContextPocket · ISOLATED',
  '',
  'This project is in isolated mode. Do NOT read any previous context,',
  'do NOT call recall / search / why / graph / handoff, and do NOT write',
  'any turn back into the pocket.',
  '',
  'Treat this as a brand-new project. The real history lives in',
  '`' + QUARANTINE_DIR + '/` (or was moved out of the project).',
  '',
  'To restore: remove the `.contextpocket-isolate` marker / unset the env var,',
  'then rename `' + QUARANTINE_DIR + '/` back to `ContextPocket/`.',
  '',
].join('\n');

function envIsolated() {
  const v = String(process.env[ISOLATE_ENV] || '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** 从 startDir 向上找标记文件，最多 5 层（不扫全盘，避免误命中家目录） */
function findMarker(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 5; i++) {
    const marker = path.join(dir, ISOLATE_MARKER);
    if (fs.existsSync(marker)) return marker;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * @param {object} [opts] { cwd, pocketDir }
 * @returns {{isolated:boolean, source:string|null, reason:string, marker:string|null, quarantine:string|null}}
 */
function detectIsolation(opts) {
  const options = opts || {};
  const cwd = path.resolve(options.cwd || process.cwd());
  if (envIsolated()) {
    return { isolated: true, source: 'env', reason: ISOLATE_ENV + ' is set', marker: null, quarantine: null };
  }

  const markerRoots = [cwd];
  if (options.pocketDir) markerRoots.push(path.dirname(path.resolve(options.pocketDir)));
  for (const root of markerRoots) {
    const marker = findMarker(root);
    if (marker) {
      return { isolated: true, source: 'marker', reason: 'marker file ' + marker, marker: marker, quarantine: null };
    }
  }

  for (const root of markerRoots) {
    const q = path.join(root, QUARANTINE_DIR);
    try {
      if (fs.existsSync(q) && fs.statSync(q).isDirectory()) {
        return { isolated: true, source: 'quarantine', reason: 'quarantined pocket at ' + q, marker: null, quarantine: q };
      }
    } catch (err) {
      // 权限问题不该让检测本身炸掉；当作不存在。
    }
  }
  return { isolated: false, source: null, reason: '', marker: null, quarantine: null };
}

function isolationMessage(state, command) {
  return 'ISOLATED (' + state.source + '): ' + (command ? '`' + command + '` ' : '') +
    'is blocked — this run must not read or write previous context. ' + state.reason +
    '. Remove the marker / unset ' + ISOLATE_ENV + ' / restore ContextPocket/ to continue.';
}

function isolatedPayload(state, command) {
  return {
    ok: false,
    error: 'isolated',
    isolated: true,
    source: state.source,
    reason: state.reason,
    command: command || null,
    message: isolationMessage(state, command),
  };
}

function isolatedStatusPayload(state) {
  return {
    ok: true,
    isolated: true,
    source: state.source,
    reason: state.reason,
    message: isolationMessage(state, 'status'),
  };
}

module.exports = {
  ISOLATE_ENV: ISOLATE_ENV,
  ISOLATE_MARKER: ISOLATE_MARKER,
  QUARANTINE_DIR: QUARANTINE_DIR,
  POCKET_DIR: POCKET_DIR,
  ISOLATED_NOTE: ISOLATED_NOTE,
  detectIsolation: detectIsolation,
  isolationMessage: isolationMessage,
  isolatedPayload: isolatedPayload,
  isolatedStatusPayload: isolatedStatusPayload,
};
