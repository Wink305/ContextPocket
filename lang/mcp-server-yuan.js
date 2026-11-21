#!/usr/bin/env node
'use strict';

/**
 * ContextPocket Yuan MCP server
 *
 * Minimal newline-delimited JSON-RPC over stdio. Exposes the workspace,
 * repo-map and context tools; pocket commands remain in quan / xi.
 */

const { TOOL_DESCRIPTIONS, SERVER_INSTRUCTIONS } = require('./lib/help');
const {
  findWorkspaceRoot,
  initWorkspace,
  addPocket,
  removePocket,
  listPockets,
  statusWorkspace,
  recallRef,
} = require('./lib/workspace');
const { updateMap, viewMap, verifyMap } = require('./lib/repomap');
const { indexWorkspace, searchWorkspaceIndexed } = require('./lib/workspace-index');
const { buildContext, buildExplain } = require('./lib/context');
const { buildRecap } = require('./lib/recap');
const { auditWorkspace } = require('./lib/audit');
const { decayWorkspace } = require('./lib/decay');
const { captureWorkspace } = require('./lib/capture');
const { resolveMode } = require('./lib/modes');
const { forgetWorkspace } = require('./lib/forget');
const { consolidateWorkspace } = require('./lib/consolidate');
const { mergeWorkspace } = require('./lib/merge-workspace');
const { verifyWorkspace, repairWorkspace } = require('./lib/diagnostics');
const { pkgVersion } = require('./lib/version');

const VERSION = pkgVersion();

const TOOLS = [
  {
    name: 'context_pocket_workspace',
    description: TOOL_DESCRIPTIONS.context_pocket_workspace,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'add', 'remove', 'list', 'status', 'search', 'recall', 'index', 'verify', 'repair'],
          description: 'list = registered pockets (default); init/add/remove manage the manifest; search/recall read across pockets; index builds the local BM25 cache; verify/repair check and safely fix the workspace',
          default: 'list',
        },
        name: { type: 'string', description: 'Pocket name (action=add/remove)' },
        path: { type: 'string', description: 'Project root or ContextPocket/ path (action=add)' },
        keyword: { type: 'string', description: 'Search keyword (action=search)' },
        ref: { type: 'string', description: 'Qualified id like api:T12 (action=recall)' },
        limit: { type: 'integer', description: 'Max search results (default 20; 0 = all)' },
        pockets: { type: 'string', description: 'Comma-separated pocket names (action=search; default: all)' },
        types: { type: 'string', description: 'Comma-separated types for search: T, FIX, ADR, R, pref, absolute' },
        noIndex: { type: 'boolean', description: 'Force a live scan instead of the local index (action=search)', default: false },
        rebuild: { type: 'boolean', description: 'Rebuild the local index from scratch (action=index)', default: false },
        editionMode: { type: 'string', enum: ['focus', 'audit', 'migrate'], description: 'Default presets for search limit (explicit limit wins)' },
        deep: { type: 'boolean', description: 'Deep checks for verify (cross-refs, repo map, pending reviews)', default: false },
        apply: { type: 'boolean', description: 'Apply safe repairs only (action=repair)', default: false },
      },
    },
  },
  {
    name: 'context_pocket_map',
    description: TOOL_DESCRIPTIONS.context_pocket_map,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['update', 'view', 'verify'],
          description: 'update = rebuild cache; view = print summary; verify = report drift',
          default: 'view',
        },
        limit: { type: 'integer', description: 'Rows shown by view (default 20; 0 = all)' },
      },
    },
  },
  {
    name: 'context_pocket_context',
    description: TOOL_DESCRIPTIONS.context_pocket_context,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['build', 'explain'], description: 'build the context view, or explain section tokens and budget trims', default: 'build' },
        maxTokens: { type: 'integer', description: 'Approximate token budget (default: workspace manifest)' },
        query: { type: 'string', description: 'Include workspace search hits for this query' },
        includeRepoMap: { type: 'boolean', description: 'Include the repo map section', default: true },
        editionMode: { type: 'string', enum: ['focus', 'audit', 'migrate'], description: 'Default budget / repo-map presets (explicit args win)' },
      },
    },
  },
  {
    name: 'context_pocket_recap',
    description: TOOL_DESCRIPTIONS.context_pocket_recap,
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'First T id' },
        until: { type: 'integer', description: 'Last T id' },
        from: { type: 'string', description: 'First date (YYYY-MM-DD)' },
        to: { type: 'string', description: 'Last date (YYYY-MM-DD)' },
        pockets: { type: 'string', description: 'Comma-separated pocket names' },
        maxTokens: { type: 'integer', description: 'Approximate budget (default 4000)' },
        editionMode: { type: 'string', enum: ['focus', 'audit', 'migrate'], description: 'Default budget preset (explicit maxTokens wins)' },
      },
    },
  },
  {
    name: 'context_pocket_forget',
    description: TOOL_DESCRIPTIONS.context_pocket_forget,
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: 'Archive turns older than this T id (e.g. T12)' },
        beforeDate: { type: 'string', description: 'Archive turns dated before YYYY-MM-DD' },
        keepLast: { type: 'integer', description: 'Keep only the newest n turns' },
        pockets: { type: 'string', description: 'Comma-separated pocket names (default: all)' },
        apply: { type: 'boolean', description: 'Write log-archive.md (default false: plan only)', default: false },
      },
    },
  },
  {
    name: 'context_pocket_consolidate',
    description: TOOL_DESCRIPTIONS.context_pocket_consolidate,
    inputSchema: {
      type: 'object',
      properties: {
        pockets: { type: 'string', description: 'Comma-separated pocket names (default: all)' },
        apply: { type: 'boolean', description: 'Remove exact duplicate preference lines (default false: plan only)', default: false },
      },
    },
  },
  {
    name: 'context_pocket_merge',
    description: TOOL_DESCRIPTIONS.context_pocket_merge,
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source pocket name (workspace manifest)' },
        target: { type: 'string', description: 'Target pocket name (workspace manifest)' },
        includeArchive: { type: 'boolean', description: 'Also merge the source log-archive.md', default: false },
        apply: { type: 'boolean', description: 'Write the merge (default false: dry run)', default: false },
      },
      required: ['source', 'target'],
    },
  },
  {
    name: 'context_pocket_audit',
    description: TOOL_DESCRIPTIONS.context_pocket_audit,
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'First T id' },
        until: { type: 'integer', description: 'Last T id' },
        from: { type: 'string', description: 'First date (YYYY-MM-DD)' },
        to: { type: 'string', description: 'Last date (YYYY-MM-DD)' },
        pockets: { type: 'string', description: 'Comma-separated pocket names' },
      },
    },
  },
  {
    name: 'context_pocket_decay',
    description: TOOL_DESCRIPTIONS.context_pocket_decay,
    inputSchema: {
      type: 'object',
      properties: {
        maxAgeDays: { type: 'integer', description: 'Cold threshold in days (default 180)' },
        keepLast: { type: 'integer', description: 'Always keep the newest n turns (default 50)' },
        minTurns: { type: 'integer', description: 'Do not recommend forget below this many turns (default 10)' },
        pockets: { type: 'string', description: 'Comma-separated pocket names' },
        today: { type: 'string', description: 'Override today (YYYY-MM-DD; tests / backfill)' },
      },
    },
  },
  {
    name: 'context_pocket_capture',
    description: TOOL_DESCRIPTIONS.context_pocket_capture,
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Local PR / CI summary file' },
        pocket: { type: 'string', description: 'Target pocket name (required unless the workspace has one)' },
        kind: { type: 'string', description: 'Summary kind: pr or ci', default: 'pr' },
        gist: { type: 'string', description: 'Override the extracted title' },
        tags: { type: 'string', description: 'Extra tags, comma-separated' },
        url: { type: 'string', description: 'Override the extracted link' },
        when: { type: 'string', description: 'Forwarded to the T-block WHEN line' },
        apply: { type: 'boolean', description: 'Write the T-block (default false: plan only)', default: false },
      },
      required: ['file'],
    },
  },
];

function workspaceRoot(args, mustExist = true) {
  const start = process.cwd();
  const found = findWorkspaceRoot(start);
  if (found) return found;
  if (!mustExist) return start;
  throw new Error('No contextpocket.workspace.json found from ' + start);
}

function toolWorkspace(args) {
  const action = args.action || 'list';
  if (action === 'init') {
    const result = initWorkspace(workspaceRoot(args, false), { name: args.name });
    return { ok: true, root: result.root, file: result.file, name: result.manifest.name };
  }
  const root = workspaceRoot(args);
  if (action === 'add') return addPocket(root, args.name, args.path);
  if (action === 'remove') return removePocket(root, args.name);
  if (action === 'status') return statusWorkspace(root);
  if (action === 'search') return searchWorkspaceIndexed(root, args.keyword, {
    limit: args.limit !== undefined ? args.limit : resolveMode(args).profile.searchLimit,
    pockets: args.pockets,
    types: args.types,
    noIndex: !!args.noIndex,
    rebuildIndex: !!args.rebuild,
  });
  if (action === 'index') return indexWorkspace(root, { rebuild: !!args.rebuild });
  if (action === 'recall') return recallRef(root, args.ref);
  if (action === 'verify') return verifyWorkspace(root, { deep: !!args.deep });
  if (action === 'repair') return repairWorkspace(root, { apply: !!args.apply });
  if (action === 'list') {
    const result = listPockets(root);
    return { ok: true, root, name: result.manifest.name, count: result.pockets.length, pockets: result.pockets };
  }
  throw new Error('unknown workspace action: ' + action);
}

function toolMap(args) {
  const action = args.action || 'view';
  const root = workspaceRoot(args);
  if (action === 'update') return updateMap(root);
  if (action === 'view') return viewMap(root, { limit: args.limit });
  if (action === 'verify') return verifyMap(root);
  throw new Error('unknown map action: ' + action);
}

function toolContext(args) {
  const action = args.action || 'build';
  if (action !== 'build' && action !== 'explain') throw new Error('unknown context action: ' + action);
  const root = workspaceRoot(args);
  const mode = resolveMode(args);
  const options = {
    maxTokens: args.maxTokens !== undefined ? args.maxTokens : mode.profile.maxTokens,
    query: args.query,
    includeRepoMap: args.includeRepoMap !== undefined
      ? !!args.includeRepoMap
      : (mode.profile.includeRepoMap !== undefined ? mode.profile.includeRepoMap : true),
  };
  return action === 'explain' ? buildExplain(root, options) : buildContext(root, options);
}

function toolRecap(args) {
  const mode = resolveMode(args);
  return buildRecap(workspaceRoot(args), {
    sinceT: args.since,
    untilT: args.until,
    fromDate: args.from,
    toDate: args.to,
    pockets: args.pockets,
    maxTokens: args.maxTokens !== undefined ? args.maxTokens : mode.profile.maxTokens,
  });
}

function toolForget(args) {
  return forgetWorkspace(workspaceRoot(args), {
    beforeT: args.before,
    beforeDate: args.beforeDate,
    keepLast: args.keepLast,
    pockets: args.pockets,
    apply: !!args.apply,
  });
}

function toolConsolidate(args) {
  return consolidateWorkspace(workspaceRoot(args), {
    pockets: args.pockets,
    apply: !!args.apply,
  });
}

function toolMerge(args) {
  return mergeWorkspace(workspaceRoot(args), args.source, args.target, {
    apply: !!args.apply,
    includeArchive: !!args.includeArchive,
  });
}

function toolAudit(args) {
  return auditWorkspace(workspaceRoot(args), {
    sinceT: args.since,
    untilT: args.until,
    fromDate: args.from,
    toDate: args.to,
    pockets: args.pockets,
  });
}

function toolDecay(args) {
  return decayWorkspace(workspaceRoot(args), {
    maxAgeDays: args.maxAgeDays,
    keepLast: args.keepLast,
    minTurns: args.minTurns,
    pockets: args.pockets,
    today: args.today,
  });
}

function toolCapture(args) {
  return captureWorkspace(workspaceRoot(args), {
    file: args.file,
    pocket: args.pocket,
    kind: args.kind,
    gist: args.gist,
    tags: args.tags,
    url: args.url,
    when: args.when,
    apply: !!args.apply,
  });
}

function callTool(name, args) {
  try {
    let result;
    if (name === 'context_pocket_workspace') result = toolWorkspace(args || {});
    else if (name === 'context_pocket_map') result = toolMap(args || {});
    else if (name === 'context_pocket_context') result = toolContext(args || {});
    else if (name === 'context_pocket_recap') result = toolRecap(args || {});
    else if (name === 'context_pocket_forget') result = toolForget(args || {});
    else if (name === 'context_pocket_consolidate') result = toolConsolidate(args || {});
    else if (name === 'context_pocket_merge') result = toolMerge(args || {});
    else if (name === 'context_pocket_audit') result = toolAudit(args || {});
    else if (name === 'context_pocket_decay') result = toolDecay(args || {});
    else if (name === 'context_pocket_capture') result = toolCapture(args || {});
    else return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: '❌ Error: ' + e.message }], isError: true };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'context-pocket-yuan', version: VERSION.version },
        instructions: SERVER_INSTRUCTIONS,
      },
    });
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    send({ jsonrpc: '2.0', id, result: callTool(name, args) });
    return;
  }
  if (isNotification) return;
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    handle(message);
  }
});

process.stderr.write('ContextPocket Yuan MCP server started\n');
