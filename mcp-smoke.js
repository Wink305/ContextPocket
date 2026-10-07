#!/usr/bin/env node
'use strict';
// ContextPocket MCP 冒烟测试
// 用法: node mcp-smoke.js [<project-dir>]
//       CONTEXTPOCKET_HOME=<hub-dir> node mcp-smoke.js <project-dir>
// 说明: 通过 spawn 起 mcp-server.js，按 MCP stdio 协议收发 —— 一条消息一行 JSON，
//       行内不得有裸换行，没有 Content-Length 头（那是 LSP 的分帧，MCP 不用）。
// 注意: 本脚本会真的写 <project-dir>/ContextPocket/（log append / absolute add / hub pref），
//       请对着临时项目跑，或把它当作 e2e 的一部分。
//       不传 <project-dir> 时自动在 OS 临时目录里造一个一次性 pocket（并把 hub 隔离到同一个
//       临时目录），退出时删除 —— 所以 `npm run smoke` 可以单独跑，也不会碰你的真实项目。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = path.resolve(__dirname, 'mcp-server.js');

let projectDir = process.argv[2];
let throwaway = null;
if (!projectDir) {
  const { bootstrap } = require('./lib/bootstrap');
  throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-smoke-'));
  if (!process.env.CONTEXTPOCKET_HOME) {
    process.env.CONTEXTPOCKET_HOME = path.join(throwaway, 'hub');
  }
  projectDir = path.join(throwaway, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'app.js'), '// source file so code-map has something to scan\n');
  bootstrap(projectDir);
  console.log('  [no <project-dir> — using throwaway pocket: ' + projectDir + ']');
} else if (!process.env.CONTEXTPOCKET_HOME) {
  console.log('  [note: CONTEXTPOCKET_HOME unset — hub writes go to your real ~/.contextpocket]');
}

function removeThrowaway() {
  if (!throwaway) return true;
  try {
    if (fs.rmSync) fs.rmSync(throwaway, { recursive: true, force: true });
    else fs.rmdirSync(throwaway, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

process.on('exit', () => {
  // 兜底：异常路径（超时 / 抛错）也尽力清一次；清不掉就留着，OS 的临时目录清理会接手
  if (throwaway && !removeThrowaway()) {
    console.log('  [left behind: ' + throwaway + ' — child still held it open]');
  }
});

/**
 * 正常出口：先等一次性目录真的删掉再退。
 * Windows 上刚 kill 掉的 server 进程可能还占着 projectDir 当 cwd，
 * 立刻 rmSync 会 EPERM/EBUSY —— 所以是"重试 + 超时"而不是一次性 try/catch。
 */
function finish(code) {
  if (!throwaway) process.exit(code);
  const deadline = Date.now() + 3000;
  const attempt = () => {
    if (removeThrowaway()) {
      console.log('  [throwaway pocket removed]');
      process.exit(code);
      return;
    }
    if (Date.now() >= deadline) {
      console.log('  [left behind: ' + throwaway + ' — delete it manually if it matters]');
      process.exit(code);
      return;
    }
    setTimeout(attempt, 100);
  };
  setTimeout(attempt, 50);
}

const child = spawn(process.execPath, [server], { cwd: projectDir, env: process.env });
let stderr = '';
let serverExited = null;
child.stderr.on('data', d => { stderr += d.toString(); });
child.on('exit', (code, sig) => { serverExited = (code === 0 ? 'clean' : 'code=' + code) + (sig ? ' sig=' + sig : ''); console.log('  [server exited: ' + serverExited + ']'); });
child.on('error', e => { console.log('  [server spawn error: ' + e.message + ']'); });

// --- 换行分隔的 JSON-RPC 解析：逐行读，忽略不属于 JSON-RPC 的行 ---
let lineBuf = '';
let nextId = 0;
const pending = new Map();

child.stdout.setEncoding('utf-8');
child.stdout.on('data', (chunk) => {
  lineBuf += chunk;
  let idx;
  while ((idx = lineBuf.indexOf('\n')) !== -1) {
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    const items = Array.isArray(msg) ? msg : [msg];
    for (const m of items) {
      if (m && m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    }
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function frame(payload) {
  child.stdin.write(JSON.stringify(payload) + '\n');
}

function request(method, params, timeoutMs) {
  return new Promise(resolve => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ timedOut: true, method });
      }
    }, timeoutMs || 20000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    frame({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  frame({ jsonrpc: '2.0', method, params });
}

// 请求之间留一点间隔：分帧是逐行的、服务端也是同步处理，
// 20ms 只是为了让输出更易读，不承担协议层同步职责。
const INTER_REQUEST_DELAY_MS = 20;

let failures = 0;
function check(label, ok, extra) {
  let extraStr = '';
  try { extraStr = extra === undefined ? '' : String(extra); } catch (e) { extraStr = '(unavailable)'; }
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extraStr ? ' :: ' + extraStr : ''));
  if (!ok) failures++;
}
function textOf(msg, idx) {
  try { return msg && msg.result && msg.result.content && msg.result.content[idx || 0] ? msg.result.content[idx || 0].text : '<no-content>'; } catch (e) { return '<no-content>'; }
}

(async () => {
  // 分帧断言必须在最前面：上一版冒烟脚本自己用 Content-Length 收发，
  // 于是服务端"对着自己定的协议全绿"，而真实客户端一个都连不上。
  let sawHeaderFrame = false;
  child.stdout.on('data', (chunk) => {
    if (/Content-Length:/i.test(chunk.toString('latin1'))) sawHeaderFrame = true;
  });

  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  check('initialize', !init.timedOut && init.result && init.result.serverInfo && init.result.serverInfo.name === 'context-pocket',
    init.timedOut ? 'TIMED OUT' : JSON.stringify(init.result && init.result.serverInfo));
  check('initialize echoes negotiated protocolVersion',
    !init.timedOut && init.result && init.result.protocolVersion === '2024-11-05',
    init.result && init.result.protocolVersion);
  check('stdout is newline-delimited JSON (no Content-Length frames)', !sawHeaderFrame);

  const ping = await request('ping', {});
  check('ping', !ping.timedOut && ping.result && typeof ping.result === 'object', ping.timedOut ? 'TIMED OUT' : JSON.stringify(ping.result));

  const unknownMethod = await request('nonexistent/method', {});
  check('unknown method → JSON-RPC -32601',
    !unknownMethod.timedOut && unknownMethod.error && unknownMethod.error.code === -32601,
    unknownMethod.error && unknownMethod.error.code);

  notify('notifications/initialized', {});

  const list = await request('tools/list', {});
  const names = (list.result && list.result.tools || []).map(t => t.name);
  for (const want of ['context_pocket_index', 'context_pocket_distill', 'context_pocket_import', 'context_pocket_hub', 'context_pocket_search', 'context_pocket_bootstrap', 'context_pocket_archive', 'context_pocket_log_append', 'context_pocket_log_amend', 'context_pocket_absolute_add']) {
    check('tools/list has ' + want, !list.timedOut && names.includes(want));
  }
  console.log('  total tools: ' + names.length);

  const call = async (name, args) => { await sleep(INTER_REQUEST_DELAY_MS); return request('tools/call', { name, arguments: args || {} }); };

  const status = await call('context_pocket_status');
  check('status', !status.timedOut && !status.result.isError, textOf(status));

  const search = await call('context_pocket_search', { keyword: 'parser' });
  check('search parser', !search.timedOut && !search.result.isError, textOf(search).split('\n')[1]);

  const idx = await call('context_pocket_index', { rebuild: true });
  check('index rebuild', !idx.timedOut && !idx.result.isError && textOf(idx).includes('Docs indexed'), textOf(idx).split('\n')[1]);

  const distill = await call('context_pocket_distill', { dryRun: true });
  check('distill dryRun', !distill.timedOut && !distill.result.isError, textOf(distill).split('\n')[0]);

  const hub = await call('context_pocket_hub', { action: 'list' });
  check('hub list', !hub.timedOut && !hub.result.isError && textOf(hub).includes('Hub'), textOf(hub).split('\n')[0]);

  const hubPref = await call('context_pocket_hub', { action: 'pref', key: 'smoke-test', value: 'ok' });
  check('hub pref set', !hubPref.timedOut && !hubPref.result.isError && textOf(hubPref).includes('ok'), textOf(hubPref).split('\n')[0]);

  console.log('  [before log_append] serverExited=' + serverExited);
  // 附件必须真的存在：`### Attachments` 声明了却找不到文件，verify 第 15 项会报 error，
  // 冒烟就该以"0 error"收尾。这里先落一个占位文件，再按模板的 `<label>: <path>` 形式声明它。
  const smokeAssetDir = path.join(projectDir, 'ContextPocket', 'assets');
  fs.mkdirSync(smokeAssetDir, { recursive: true });
  fs.writeFileSync(path.join(smokeAssetDir, 'T01-smoke-diagram.png'), 'placeholder png for mcp smoke\n');
  const append = await call('context_pocket_log_append', { gist: 'mcp smoke append', user: 'smoke test request', action: '创建 test/smoke.js — mcp 冒烟', tags: ['测试'], commits: 'deadbee', conflicts: 'none yet', attachments: 'T1 smoke diagram: assets/T01-smoke-diagram.png', uncertain: '是否需要回滚' });
  check('log append', !append.timedOut && !append.result.isError && textOf(append).includes('added'), append.timedOut ? 'TIMED OUT' : textOf(append).split('\n')[0]);
  // 用真实返回的 T 号做后续 amend 断言：写死 T1 会让第二次冒烟（同一个项目）必然失败
  const appendedT = parseInt((textOf(append).match(/T(\d+)/) || [])[1] || '0', 10);
  check('log append returns a T id', appendedT > 0, 'T' + appendedT);

  // append 必须把 CLI 独有的 4 个字段也写进去（历史上 MCP 侧静默丢弃过它们）
  const appendedBlock = await call('context_pocket_recall', { tId: appendedT });
  const blockText = textOf(appendedBlock);
  for (const section of ['Commits', 'Conflicts', 'Attachments', 'Uncertain']) {
    check('log append persisted ' + section, blockText.includes(section), '');
  }

  console.log('  [before import] serverExited=' + serverExited);
  const importMissing = await call('context_pocket_import', {});
  check('import requires file', !importMissing.timedOut && importMissing.result.isError === true, importMissing.timedOut ? 'TIMED OUT' : textOf(importMissing).split('\n')[0]);

  // --- 🔒 absolute add: the red-line area had NO write path before; verify it works over MCP ---
  const absAdd = await call('context_pocket_absolute_add', { text: 'MCP 冒烟：绝不改动 /api/v1 响应字段', gist: 'MCP 红线' });
  check('absolute add', !absAdd.timedOut && !absAdd.result.isError && textOf(absAdd).includes('absolute.md'), absAdd.timedOut ? 'TIMED OUT' : textOf(absAdd).split('\n')[0]);

  // --- log amend: must fill a missing section AND never overwrite an existing one ---
  // appendedT 是上面那次 smoke append，它已经带 User 小节。
  const amendNoop = await call('context_pocket_log_amend', { tId: appendedT, user: '这句应该被拒绝写入' });
  check('log amend does not overwrite', !amendNoop.timedOut && !amendNoop.result.isError && textOf(amendNoop).includes('unchanged'), amendNoop.timedOut ? 'TIMED OUT' : textOf(amendNoop).split('\n')[0]);

  const amendBad = await call('context_pocket_log_amend', { tId: 9999, user: 'x' });
  check('log amend unknown T is error', !amendBad.timedOut && amendBad.result.isError === true, amendBad.timedOut ? 'TIMED OUT' : textOf(amendBad).split('\n')[0]);

  const amendBad2 = await call('context_pocket_log_amend', { tId: appendedT });
  check('log amend requires a section', !amendBad2.timedOut && amendBad2.result.isError === true, amendBad2.timedOut ? 'TIMED OUT' : textOf(amendBad2).split('\n')[0]);

  // 冒烟收尾必须是"体检干净"：append 带了 user、声明的附件在磁盘上、🔒 计数也对得上。
  // 旧断言只查"工具没报错"，把 ❌ 1 error found 念出来照样 PASS——第 15 项检查刚加上时
  // 就是这么漏掉了冒烟自己那条指向不存在文件的附件声明，所以这里断的是结论文本。
  const verify = await call('context_pocket_verify', {});
  check('verify after smoke writes', !verify.timedOut && !verify.result.isError && textOf(verify).includes('All checks passed'), verify.timedOut ? 'TIMED OUT' : (textOf(verify).split('\n').find((l) => /✅|❌/.test(l)) || ''));

  child.stdin.end();
  child.kill();
  if (stderr.trim()) console.log('server stderr: ' + stderr.trim());
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
  finish(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error('SMOKE ERROR: ' + e.message);
  if (stderr) console.error('server stderr: ' + stderr);
  process.exit(1);
});

// 全局兜底：防止某步协议层死锁时无限挂起
setTimeout(() => {
  console.error('GLOBAL TIMEOUT — protocol deadlock. Failing.');
  process.exit(3);
}, 120000);
