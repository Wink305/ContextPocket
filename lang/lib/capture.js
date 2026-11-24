'use strict';

/**
 * ContextPocket yuan — CI / PR 摘要捕获（阶段 2）
 *
 * 把一个 PR 描述 / CI 结果摘要变成标准 T-block，写进选定的工作区口袋。
 * 三种输入，都不引入服务端：
 *   - `file`：本地保存的摘要文件（原有能力）；
 *   - `pr`：本机 `gh pr view` 的 JSON；
 *   - `run`：本机 `gh run view` 的元数据 + `--log-failed` 失败日志。
 *
 * 抓取只发生在用户显式传 `--pr` / `--run` 时；没有 gh 或未登录就当场报错，
 * 并提示改存成本地文件再 capture。
 *
 * 安全边界：
 *   - 只摘标题、列表要点和第一个链接，不整段抄正文 / 日志；
 *   - 写盘前对**将要写入的内容**做密钥扫描，error 级凭据直接拒绝；
 *   - 默认只出计划，`--apply` 才调用 writer.appendLogBlock。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { readManifest, resolvePocket } = require('./workspace');
const { scanText } = require('./secrets');
const writer = require('./writer');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_GIST = 120;
const MAX_BULLETS = 5;
const MAX_BULLET = 300;
const GH_TIMEOUT_MS = 30 * 1000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_CI_LOG_LINES = 40;

function truncate(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + '…';
}

function firstHeading(text) {
  for (const line of text.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) return match[1].trim();
  }
  return '';
}

function extractGist(text, override) {
  const given = String(override || '').trim();
  if (given) return truncate(given, MAX_GIST);
  const heading = firstHeading(text);
  if (heading) return truncate(heading, MAX_GIST);
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    const stripped = value
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '');
    if (stripped) return truncate(stripped, MAX_GIST);
  }
  return '';
}

function extractBullets(text, gist) {
  const bullets = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (!match) continue;
    const value = match[1].trim().replace(/^\[[ xX]\]\s+/, '');
    if (!value || value === gist || seen.has(value)) continue;
    seen.add(value);
    bullets.push(truncate(value, MAX_BULLET));
    if (bullets.length >= MAX_BULLETS) break;
  }
  return bullets;
}

function extractUrl(text, override) {
  const given = String(override || '').trim();
  if (/^https?:\/\//i.test(given)) return given;
  const match = text.match(/https?:\/\/[^\s<>"'()]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, '');
}

function normalizeKind(value) {
  const kind = String(value || 'pr').trim().toLowerCase();
  if (kind !== 'pr' && kind !== 'ci') {
    throw new Error('--kind must be pr or ci (got ' + value + ')');
  }
  return kind;
}

// ============================================================
// gh 连接器（只在本机执行，不引入服务端）
// ============================================================

function gh(args, optional) {
  const bin = process.env.CONTEXTPOCKET_GH || 'gh';
  try {
    return execFileSync(bin, args, {
      encoding: 'utf-8',
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (optional) return '';
    if (e.code === 'ENOENT') {
      throw new Error('gh CLI not found — install GitHub CLI, or save the PR / CI summary '
        + 'to a file and capture that file instead');
    }
    const stderr = String(e.stderr || '').trim().split('\n')[0];
    throw new Error('gh ' + args.slice(0, 2).join(' ') + ' failed'
      + (stderr ? ': ' + truncate(stderr, 200) : ''));
  }
}

/**
 * `gh pr view --json title,body,url,number,state` → 可捕获的摘要文本。
 * 纯函数，方便单测；不访问网络。
 */
function summarizePrJson(jsonText) {
  const data = JSON.parse(jsonText);
  const title = String(data.title || '').trim();
  const body = String(data.body || '').trim();
  const url = String(data.url || '').trim();
  const number = data.number ? '#' + data.number : '';
  const state = data.state ? ' (' + String(data.state).toLowerCase() + ')' : '';
  const label = number ? 'PR ' + number : 'PR';
  const gist = truncate(label + (title ? ' · ' + title : '') + state, MAX_GIST);
  const lines = ['# ' + (title || label), ''];
  if (body) {
    lines.push(body, '');
  }
  if (url) lines.push('Source: ' + url);
  return { text: lines.join('\n'), gist, url: url || null };
}

/**
 * 从 `gh run view --log-failed` 里取最后几条可读的失败行。
 * GitHub 的日志带时间戳 / `##[group]` 包装，先剥掉再截断。
 */
function extractFailureLines(logText) {
  const lines = [];
  for (const raw of String(logText || '').split('\n')) {
    const line = raw
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '')
      .trim();
    if (!line) continue;
    // GitHub 的 group / command 包装不是失败内容
    if (/^##\[(group|endgroup|debug|command)\]/i.test(line)) continue;
    lines.push(truncate(line.replace(/^##\[(error|warning)\]/i, '$1: '), MAX_BULLET));
  }
  return lines.slice(-MAX_CI_LOG_LINES);
}

/**
 * `gh run view --json ...` + 失败日志 → 可捕获的摘要文本。
 * 纯函数，方便单测；不访问网络。
 */
function summarizeRunOutput(metaJson, logText) {
  const data = JSON.parse(metaJson);
  const name = String(data.workflowName || 'CI').trim();
  const title = String(data.displayTitle || '').trim();
  const conclusion = String(data.conclusion || 'failed').toLowerCase();
  const url = String(data.url || '').trim();
  const gist = truncate(name + (title ? ' · ' + title : '') + ' (' + conclusion + ')', MAX_GIST);
  const lines = ['# ' + gist, ''];
  if (data.headBranch) lines.push('Branch: ' + data.headBranch);
  if (url) lines.push('Run: ' + url);
  const failures = extractFailureLines(logText).slice(-MAX_BULLETS);
  if (failures.length > 0) {
    lines.push('', 'Failed log (last ' + failures.length + ' line(s)):');
    for (const line of failures) lines.push('- ' + line);
  }
  return { text: lines.join('\n'), gist, url: url || null };
}

function requireOption(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (value === true) throw new Error(label + ' needs a value');
  return String(value).trim();
}

/**
 * 读取 capture 的输入源。文件读取沿用原有大小上限；gh 输出在内存里
 * 先摘要，不落临时文件。
 */
function readSource(options) {
  const file = requireOption(options.file, 'file');
  const pr = requireOption(options.pr, '--pr');
  const run = requireOption(options.run, '--run');
  const given = [file && 'file', pr && '--pr', run && '--run'].filter(Boolean);
  if (given.length === 0) {
    throw new Error('capture needs one source: <file>, --pr <number|url> or --run <id>');
  }
  if (given.length > 1) {
    throw new Error('capture takes only one source (got ' + given.join(', ') + ')');
  }

  if (file) {
    const absolute = path.resolve(file);
    if (!fs.existsSync(absolute)) throw new Error('File not found: ' + absolute);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error('Not a file: ' + absolute);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error('Summary file is too large (' + stat.size + ' bytes; max ' + MAX_FILE_BYTES + ')');
    }
    const text = fs.readFileSync(absolute, 'utf-8');
    if (!text.trim()) throw new Error('Summary file is empty: ' + absolute);
    return {
      type: 'file',
      text,
      file: absolute,
      name: path.basename(absolute),
      bytes: stat.size,
      kind: 'pr',
      gist: null,
      url: null,
    };
  }

  const repo = requireOption(options.repo, '--repo');
  if (pr) {
    const args = ['pr', 'view', pr, '--json', 'title,body,url,number,state'];
    if (repo) args.push('--repo', repo);
    const summary = summarizePrJson(gh(args));
    return {
      type: 'gh-pr',
      text: summary.text,
      file: null,
      name: 'PR ' + pr,
      bytes: Buffer.byteLength(summary.text, 'utf-8'),
      kind: 'pr',
      gist: summary.gist,
      url: summary.url,
    };
  }

  const args = ['run', 'view', run, '--json', 'displayTitle,conclusion,workflowName,url,headBranch'];
  if (repo) args.push('--repo', repo);
  const meta = gh(args);
  const logArgs = ['run', 'view', run, '--log-failed'];
  if (repo) logArgs.push('--repo', repo);
  // 没有失败日志（例如取消 / 超时）时仍然允许记录元数据
  const summary = summarizeRunOutput(meta, gh(logArgs, true));
  return {
    type: 'gh-run',
    text: summary.text,
    file: null,
    name: 'run ' + run,
    bytes: Buffer.byteLength(summary.text, 'utf-8'),
    kind: 'ci',
    gist: summary.gist,
    url: summary.url,
  };
}

function normalizeTags(value, kind) {
  const tags = [kind];
  if (value) {
    for (const item of String(value).split(',')) {
      const tag = item.replace(/[\[\]\r\n]/g, '').trim();
      if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
        tags.push(tag);
      }
    }
  }
  return tags;
}

function pickPocket(manifest, requested) {
  const name = String(requested || '').trim();
  if (name) {
    const entry = manifest.pockets.find((pocket) => pocket.name === name);
    if (!entry) throw new Error('Pocket not found: ' + name);
    return entry;
  }
  if (manifest.pockets.length === 1) return manifest.pockets[0];
  throw new Error('capture needs --pocket <name> (workspace has '
    + manifest.pockets.length + ' pockets: '
    + manifest.pockets.map((pocket) => pocket.name).join(', ') + ')');
}

/**
 * @param {string} root
 * @param {object} options
 * @param {string} [options.file] 本地 PR / CI 摘要文件
 * @param {string} [options.pr] GitHub PR 编号或 URL（走本机 gh）
 * @param {string} [options.run] GitHub Actions run id（走本机 gh）
 * @param {string} [options.repo] gh --repo owner/name（默认当前仓库）
 * @param {string} [options.pocket] 目标口袋名；只有一个口袋时可省略
 * @param {string} [options.kind=pr] pr | ci
 * @param {string} [options.gist] 覆盖标题
 * @param {string} [options.tags] 额外标签，逗号分隔
 * @param {string} [options.url] 覆盖从正文提取的链接
 * @param {string} [options.when] 透传给 T-block 的时间
 * @param {boolean} [options.apply] 写盘（默认 false：只出计划）
 */
function captureWorkspace(root, options = {}) {
  const source = readSource(options);

  const manifest = readManifest(root);
  const entry = pickPocket(manifest, options.pocket);
  const resolved = resolvePocket(root, entry);
  if (!resolved.exists) throw new Error('Pocket is missing on disk: ' + entry.name);

  const kind = normalizeKind(options.kind || source.kind);
  const gist = extractGist(source.text, options.gist || source.gist);
  if (!gist) throw new Error('Could not extract a summary title; pass --gist <text>');
  const tags = normalizeTags(options.tags, kind);
  const url = extractUrl(source.text, options.url || source.url);
  const bullets = extractBullets(source.text, gist);

  const user = ['Captured ' + kind + ' summary from ' + source.name];
  const action = ['[' + kind + '] ' + gist].concat(bullets);
  if (url) action.push('Source: ' + url);

  // 只扫描将要写入的内容：正文里的密钥不会因为"没摘进 T-block"而进入口袋
  const findings = scanText([user[0]].concat(action).join('\n'), { file: source.name });
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    throw new Error('capture refused: summary contains credential(s) — '
      + errors.map((finding) => finding.label + ' (' + finding.masked + ')').join(', ')
      + '. Remove them from the summary or write a sanitized excerpt.');
  }

  const apply = !!options.apply;
  const base = {
    ok: true,
    root,
    workspace: manifest.name,
    mode: apply ? 'apply' : 'plan',
    pocket: { name: entry.name, path: entry.path },
    source: {
      type: source.type,
      ref: source.type === 'file' ? null : source.name,
      file: source.file,
      name: source.name,
      bytes: source.bytes,
    },
    kind,
    gist,
    tags,
    url: url || null,
    user,
    action,
    warnings: findings.filter((finding) => finding.severity === 'warning'),
  };

  if (!apply) return Object.assign(base, { captured: false, tId: null, when: null });

  const result = writer.appendLogBlock(resolved.pocketDir, {
    gist,
    tags,
    user,
    action,
    when: options.when,
  });

  return Object.assign(base, {
    captured: true,
    tId: result.tId,
    when: result.when,
    autoConflicts: result.autoConflicts,
    conflictCheckError: result.conflictCheckError,
  });
}

module.exports = {
  captureWorkspace,
  summarizePrJson,
  summarizeRunOutput,
  extractFailureLines,
};
