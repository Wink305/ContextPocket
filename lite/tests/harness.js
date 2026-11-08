'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN_ROOT = path.join(ROOT, '..');
const cases = [];
const tmpDirs = [];

const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lite-test-hub-'));
if (!process.env.CONTEXTPOCKET_HOME) process.env.CONTEXTPOCKET_HOME = ISOLATED_HOME;
tmpDirs.push(ISOLATED_HOME);

function test(name, fn) {
  cases.push({ name, fn });
}

function tmpProject(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cp-lite-test-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function makeLitePocket(tag, options = {}) {
  const { bootstrap } = require(path.join(ROOT, 'lib', 'bootstrap'));
  const projectDir = tmpProject(tag);
  fs.writeFileSync(path.join(projectDir, 'app.js'), '// test source\n');
  const result = bootstrap(projectDir, options);
  return { projectDir, pocketDir: result.pocketDir };
}

function writePocketFile(pocketDir, file, content) {
  fs.writeFileSync(path.join(pocketDir, file), content, 'utf8');
}

function readPocketFile(pocketDir, file) {
  return fs.readFileSync(path.join(pocketDir, file), 'utf8');
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'context-pocket-lite.js'), ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runCliJson(args, cwd) {
  const result = runCli(args, cwd);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.strictEqual(lines.length, 1, `expected exactly one JSON line; status=${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`);
  return { ...result, json: JSON.parse(lines[0]) };
}

function runMcp(cwd, calls = []) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ...calls.map((call, index) => ({
      jsonrpc: '2.0',
      id: index + 3,
      method: 'tools/call',
      params: { name: call.name, arguments: call.arguments || {} },
    })),
  ];
  const result = spawnSync(process.execPath, [path.join(ROOT, 'mcp-server-lite.js')], {
    cwd,
    env: process.env,
    input: messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Lite MCP exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  const responses = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.strictEqual(responses.length, calls.length + 2, `unexpected MCP response count: ${result.stdout}`);
  return {
    initialize: responses[0].result,
    tools: responses[1].result.tools,
    calls: responses.slice(2).map((response) => response.result),
  };
}

function cleanup() {
  for (const dir of tmpDirs.splice(0)) {
    try {
      if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
      else rimraf(dir);
    } catch (e) {
      // Best-effort temp cleanup must not hide a test result.
    }
  }
}

function rimraf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rimraf(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

async function runAll() {
  let passed = 0;
  const failures = [];
  const list = cases.splice(0);

  for (const item of list) {
    try {
      await item.fn();
      passed++;
      console.log(`  ok   ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.log(`  FAIL ${item.name}`);
    }
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`  ${passed} passed · 0 failed`);
  } else {
    console.log(`  ${passed} passed · ${failures.length} FAILED`);
    for (const failure of failures) {
      console.log(`--- ${failure.name} ---`);
      console.log((failure.error && failure.error.stack) || String(failure.error));
      console.log('');
    }
  }
  return failures.length;
}

module.exports = {
  assert,
  test,
  tmpProject,
  tmpDirs,
  makeLitePocket,
  writePocketFile,
  readPocketFile,
  runCli,
  runCliJson,
  runMcp,
  cleanup,
  runAll,
  ROOT,
  MAIN_ROOT,
};
