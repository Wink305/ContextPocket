#!/usr/bin/env node
'use strict';
// ContextPocket MCP 冒烟测试
// 用法: CONTEXTPOCKET_HOME=<hub-dir> node mcp-smoke.js <project-dir>
// 说明: 通过 spawn 起 mcp-server.js，按 MCP stdio 协议（Content-Length 帧，UTF-8 字节）收发。
const { spawn } = require('child_process');
const path = require('path');

const server = path.resolve(__dirname, 'mcp-server.js');
const projectDir = process.argv[2];
if (!projectDir) {
  console.error('usage: node mcp-smoke.js <project-dir>');
  process.exit(2);
}

const child = spawn(process.execPath, [server], { cwd: projectDir, env: process.env });
let stderr = '';
let serverExited = null;
child.stderr.on('data', d => { stderr += d.toString(); });
child.on('exit', (code, sig) => { serverExited = (code === 0 ? 'clean' : 'code=' + code) + (sig ? ' sig=' + sig : ''); console.log('  [server exited: ' + serverExited + ']'); });
child.on('error', e => { console.log('  [server spawn error: ' + e.message + ']'); });

// --- MCP 帧解析：字节级（Content-Length 按 UTF-8 字节计），容忍 banner/垃圾前缀 ---
let buf = Buffer.alloc(0);
let nextId = 0;
const pending = new Map();

child.stdout.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (true) {
    const m = buf.toString('latin1').match(/Content-Length:\s*(\d+)\r\n\r\n/);
    if (!m) break;
    // 丢弃 header 之前的垃圾（如启动 banner），只保留 header + body 区域
    const headerStart = m.index;
    buf = buf.slice(headerStart);
    const len = parseInt(m[1], 10);
    const bodyStart = m[0].length;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len).toString('utf-8');
    buf = buf.slice(bodyStart + len);
    let msg;
    try { msg = JSON.parse(body); } catch (e) { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function frame(payload) {
  const body = JSON.stringify(payload);
  child.stdin.write('Content-Length: ' + Buffer.byteLength(body, 'utf-8') + '\r\n\r\n' + body);
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

// 连发间隔（毫秒）—— 服务端健壮，但背靠背连发在 stdio 帧解析层偶发粘包/丢响应，
// 留 80ms 让上一帧的字节有时间被消费。raw pipe 单独发没问题不代表冒烟连发没问题。
const INTER_REQUEST_DELAY_MS = 80;

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
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  check('initialize', !init.timedOut && init.result && init.result.serverInfo && init.result.serverInfo.name === 'context-pocket',
    init.timedOut ? 'TIMED OUT' : JSON.stringify(init.result && init.result.serverInfo));
  notify('notifications/initialized', {});

  const list = await request('tools/list', {});
  const names = (list.result && list.result.tools || []).map(t => t.name);
  for (const want of ['context_pocket_index', 'context_pocket_distill', 'context_pocket_import', 'context_pocket_hub', 'context_pocket_search', 'context_pocket_bootstrap', 'context_pocket_archive', 'context_pocket_log_append']) {
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
  const append = await call('context_pocket_log_append', { gist: 'mcp smoke append', user: 'smoke test request', action: '创建 test/smoke.js — mcp 冒烟', tags: ['测试'] });
  check('log append', !append.timedOut && !append.result.isError && textOf(append).includes('added'), append.timedOut ? 'TIMED OUT' : textOf(append).split('\n')[0]);

  console.log('  [before import] serverExited=' + serverExited);
  const importMissing = await call('context_pocket_import', {});
  check('import requires file', !importMissing.timedOut && importMissing.result.isError === true, importMissing.timedOut ? 'TIMED OUT' : textOf(importMissing).split('\n')[0]);

  child.stdin.end();
  child.kill();
  if (stderr.trim()) console.log('server stderr: ' + stderr.trim());
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
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
