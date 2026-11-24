#!/usr/bin/env node
'use strict';

/**
 * ContextPocket Yuan CLI
 *
 * Workspace / repo-map / context commands. Pocket read/write stays in the
 * standard ContextPocket/ format; this entry point only adds the workspace layer.
 *
 * Zero-dependency. Works with Node.js 14+.
 */

const path = require('path');
const {
  HELP_GROUPS,
  HELP_OPTIONS,
  commandHelp,
} = require('../lib/help');
const {
  findWorkspaceRoot,
  initWorkspace,
  addPocket,
  removePocket,
  listPockets,
  statusWorkspace,
  recallRef,
} = require('../lib/workspace');
const { updateMap, viewMap, verifyMap } = require('../lib/repomap');
const { buildContext, buildExplain } = require('../lib/context');
const { buildRecap } = require('../lib/recap');
const { forgetWorkspace } = require('../lib/forget');
const { consolidateWorkspace } = require('../lib/consolidate');
const { mergeWorkspace } = require('../lib/merge-workspace');
const { indexWorkspace, searchWorkspaceIndexed } = require('../lib/workspace-index');
const { auditWorkspace } = require('../lib/audit');
const { decayWorkspace } = require('../lib/decay');
const { captureWorkspace } = require('../lib/capture');
const { resolveMode } = require('../lib/modes');
const { verifyWorkspace, repairWorkspace } = require('../lib/diagnostics');
const { pkgVersion } = require('../lib/version');

const VERSION = pkgVersion();

function parseCli(argv) {
  const args = argv.slice(2);
  const result = { command: null, action: null, positional: [], options: {} };
  if (args.length === 0) return result;

  if (!args[0].startsWith('-')) {
    result.command = args[0];
    let rest = args.slice(1);
    if (rest.length > 0 && !rest[0].startsWith('-')) {
      result.action = rest[0];
      rest = rest.slice(1);
    }
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === '--') {
        result.positional.push(...rest.slice(i + 1));
        break;
      }
      if (!token.startsWith('-')) {
        result.positional.push(token);
        continue;
      }
      const name = token.replace(/^-+/, '');
      const eq = name.indexOf('=');
      if (eq >= 0) {
        result.options[name.slice(0, eq)] = name.slice(eq + 1);
        continue;
      }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        result.options[name] = next;
        i += 1;
      } else {
        result.options[name] = true;
      }
    }
  } else {
    // --version / --help 这类裸旗标
    for (const token of args) result.options[token.replace(/^-+/, '')] = true;
  }
  return result;
}

function emitJson(data, code) {
  process.stdout.write(JSON.stringify(data) + '\n');
  if (code !== undefined) process.exitCode = code;
}

function fail(options, message) {
  if (options && options.json) emitJson({ ok: false, error: message }, 1);
  else {
    process.stderr.write('Error: ' + message + '\n');
    process.exitCode = 1;
  }
}

function workspaceRootFor(options, mustExist = true) {
  const start = options.dir ? path.resolve(options.dir) : process.cwd();
  const found = findWorkspaceRoot(start);
  if (found) return found;
  if (!mustExist) return start;
  throw new Error('No contextpocket.workspace.json found from ' + start + ' (run "context-pocket-yuan workspace init")');
}

function printHelp(options) {
  if (options.json) {
    emitJson({
      ok: true,
      name: 'context-pocket-yuan',
      edition: VERSION.edition,
      display: VERSION.display,
      groups: HELP_GROUPS.map((group) => ({
        group: group.group,
        commands: group.commands.map(([command, summary]) => ({ command, summary })),
      })),
      options: HELP_OPTIONS.map(([option, summary]) => ({ option, summary })),
    });
    return;
  }
  process.stdout.write('\n  ContextPocket Yuan ' + VERSION.display + '\n\n');
  for (const group of HELP_GROUPS) {
    process.stdout.write('  ' + group.group + '\n');
    for (const [command, summary] of group.commands) {
      process.stdout.write('    ' + command.padEnd(18) + summary + '\n');
    }
    process.stdout.write('\n');
  }
  process.stdout.write('  Options\n');
  for (const [option, summary] of HELP_OPTIONS) {
    process.stdout.write('    ' + option.padEnd(18) + summary + '\n');
  }
  process.stdout.write('\n');
}

function printVersion(options) {
  if (options.json) {
    emitJson({
      ok: true,
      name: 'context-pocket-yuan',
      version: VERSION.version,
      display: VERSION.display,
      edition: VERSION.edition,
      source: VERSION.source,
      node: process.version,
    });
    return;
  }
  process.stdout.write('\n  ContextPocket Yuan ' + VERSION.display + '\n');
  process.stdout.write('    version: ' + VERSION.version + ' (source: ' + VERSION.source + ')\n\n');
}

function cmdWorkspace(options) {
  const action = options.action || 'list';

  if (action === 'init') {
    const root = workspaceRootFor(options, false);
    const result = initWorkspace(root, { name: options.name });
    if (options.json) {
      emitJson({ ok: true, root: result.root, file: result.file, name: result.manifest.name, pockets: 0 });
    } else {
      process.stdout.write('\n  Workspace created: ' + result.root + '\n');
      process.stdout.write('     File: ' + result.file + '\n\n');
    }
    return;
  }

  const root = workspaceRootFor(options);

  if (action === 'add') {
    const [name, pocketPath] = options.positional;
    if (!name || !pocketPath) throw new Error('usage: workspace add <name> <path>');
    const result = addPocket(root, name, pocketPath);
    if (options.json) emitJson({ ok: true, root, name: result.name, path: result.path });
    else process.stdout.write('\n  Added ' + result.name + ' → ' + result.path + '\n\n');
    return;
  }

  if (action === 'remove') {
    const [name] = options.positional;
    if (!name) throw new Error('usage: workspace remove <name>');
    const result = removePocket(root, name);
    if (options.json) emitJson({ ok: true, root, removed: result.removed });
    else process.stdout.write('\n  Removed ' + result.removed + '\n\n');
    return;
  }

  if (action === 'list') {
    const result = listPockets(root);
    if (options.json) {
      emitJson({
        ok: true,
        root,
        name: result.manifest.name,
        count: result.pockets.length,
        pockets: result.pockets,
      });
      return;
    }
    process.stdout.write('\n  Workspace ' + result.manifest.name + ' · ' + result.pockets.length + ' pocket(s)\n');
    for (const pocket of result.pockets) {
      const state = pocket.ok ? 'T' + pocket.latestT + ' · ' + pocket.blocks + ' block(s)' : 'unavailable';
      process.stdout.write('    ' + pocket.name.padEnd(12) + state + '  ' + pocket.path + '\n');
    }
    process.stdout.write('\n');
    return;
  }

  if (action === 'status') {
    const result = statusWorkspace(root, { health: true });
    if (options.json) { emitJson(Object.assign({ ok: true }, result)); return; }
    process.stdout.write('\n  Workspace ' + result.name + '\n');
    for (const pocket of result.pockets) {
      if (!pocket.ok) {
        process.stdout.write('    ' + pocket.name + ': ' + (pocket.error || 'unavailable') + '\n');
        continue;
      }
      process.stdout.write('    ' + pocket.name + ': T' + pocket.latestT
        + ' · ' + pocket.blocks + ' block(s) · ' + pocket.openRequirements + ' open req · '
        + pocket.adrs + ' ADR\n');
    }
    const index = result.health.index;
    const map = result.health.repoMap;
    process.stdout.write('    Health\n');
    process.stdout.write('      index: ' + (index.present
      ? (index.fresh ? 'fresh' : 'stale') + ' · ' + index.docsCount + ' doc(s)'
      : 'missing') + (index.present ? '' : ' (run "workspace index")') + '\n');
    process.stdout.write('      repo map: ' + (map.present
      ? map.files + ' file(s) · ' + map.symbols + ' symbol(s)'
      : 'missing') + (map.present ? '' : ' (run "map update")') + '\n');
    const graph = result.health.graph;
    process.stdout.write('      graph: ' + (graph.present
      ? (graph.fresh ? 'fresh' : 'stale') + ' · ' + graph.nodes + ' node(s) · '
        + graph.crossPocketEdges + ' cross-pocket edge(s)'
      : 'missing') + (graph.present ? '' : ' (run "context build --expand 1")') + '\n');
    process.stdout.write('\n');
    return;
  }

  if (action === 'index') {
    const result = indexWorkspace(root, { rebuild: !!options.rebuild });
    if (options.json) { emitJson(result); return; }
    process.stdout.write('\n  Workspace index · ' + result.workspace + '\n');
    process.stdout.write('    Docs: ' + result.docsCount + ' · terms: ' + result.termsCount
      + ' · pockets: ' + result.pockets + '\n');
    process.stdout.write('    ' + (result.unchanged ? 'unchanged' : 'rebuilt')
      + ' · ' + result.rebuiltPockets + ' pocket(s) rescanned · '
      + result.reusedPockets + ' reused · ' + result.tookMs + 'ms\n');
    process.stdout.write('    ' + result.path + '\n\n');
    return;
  }

  if (action === 'search') {
    const keyword = (options.positional || []).join(' ').trim();
    const mode = resolveMode(options);
    const limit = options.limit !== undefined ? options.limit : mode.profile.searchLimit;
    const result = searchWorkspaceIndexed(root, keyword, {
      limit,
      pockets: options.pockets || options.pocket,
      types: options.type,
      noIndex: !!options['no-index'],
      rebuildIndex: !!options['rebuild-index'],
    });
    if (options.json) { emitJson(result); return; }
    process.stdout.write('\n  Workspace search: "' + result.keyword + '" · ' + result.total
      + ' match(es) · ' + result.mode + '\n');
    for (const row of result.results) {
      process.stdout.write('    ' + (row.pocket + ':' + row.id).padEnd(18) + '[' + row.type + '] ' + row.label + '\n');
    }
    if (result.hasMore) process.stdout.write('    … ' + (result.total - result.count) + ' more\n');
    process.stdout.write('\n');
    return;
  }

  if (action === 'recall') {
    const [ref] = options.positional;
    const result = recallRef(root, ref);
    if (options.json) { emitJson(result); return; }
    process.stdout.write('\n  ' + result.pocket + ':T' + result.block.id + ' · ' + result.block.gist + '\n');
    for (const [section, value] of Object.entries(result.block.sections || {})) {
      process.stdout.write('\n  ' + section + '\n');
      for (const line of Array.isArray(value) ? value : [value]) process.stdout.write('    - ' + line + '\n');
    }
    process.stdout.write('\n');
    return;
  }

  if (action === 'verify') {
    const result = verifyWorkspace(root, { deep: !!options.deep });
    if (options.json) { emitJson(result, result.ok ? 0 : 1); return; }
    process.stdout.write('\n  Workspace verify: ' + (result.ok ? 'ok' : 'failed') + ' · '
      + result.pockets + ' pocket(s) · ' + (result.deep ? 'deep' : 'shallow') + '\n');
    for (const error of result.errors) process.stdout.write('    ❌ ' + error + '\n');
    for (const warning of result.warnings) process.stdout.write('    ⚠️  ' + warning + '\n');
    process.stdout.write('\n');
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (action === 'repair') {
    const result = repairWorkspace(root, { apply: !!options.apply });
    if (options.json) { emitJson(result, result.ok ? 0 : 1); return; }
    process.stdout.write('\n  Workspace repair ' + (options.apply ? '(applied)' : '(plan)') + '\n');
    if (options.apply) {
      for (const item of result.applied) process.stdout.write('    ✅ ' + item.id + (item.count !== undefined ? ' · ' + item.count + ' file(s)' : '') + '\n');
      for (const item of result.skipped) process.stdout.write('    ↳ manual: ' + item.command + '  (' + item.reason + ')\n');
    } else {
      for (const item of result.actions) {
        process.stdout.write('    ' + (item.safe ? '✅ safe' : '↳ manual') + '  ' + item.command + '  (' + item.reason + ')\n');
      }
      if (result.actions.length === 0) process.stdout.write('    (nothing to repair)\n');
    }
    process.stdout.write('\n');
    return;
  }

  throw new Error('unknown workspace action: ' + action);
}

function cmdMap(options) {
  const action = options.action || 'view';
  const root = workspaceRootFor(options);
  if (action === 'update') {
    const result = updateMap(root);
    if (options.json) emitJson(Object.assign({ ok: true }, result, { map: undefined }));
    else process.stdout.write('\n  Repo map updated: ' + result.count + ' file(s)'
      + ' · ' + result.reused + ' reused · ' + result.rescanned + ' rescanned'
      + (result.truncated ? ' (truncated at maxFiles)' : '') + '\n     ' + result.path + '\n\n');
    return;
  }
  if (action === 'view') {
    const result = viewMap(root, { limit: options.limit });
    if (options.json) { emitJson(result); return; }
    process.stdout.write('\n  Repo map · ' + result.files + ' file(s) · ' + result.symbols + ' symbol(s)\n');
    for (const row of result.rows) {
      process.stdout.write('    ' + row.path + (row.symbols.length ? ' — ' + row.symbols.join(', ') : '') + '\n');
    }
    process.stdout.write('\n');
    return;
  }
  if (action === 'verify') {
    const result = verifyMap(root);
    if (options.json) emitJson(result, result.ok ? 0 : 1);
    else {
      process.stdout.write('\n  Repo map verify: ' + (result.ok ? 'in sync' : 'drift') + '\n');
      for (const key of ['added', 'removed', 'changed']) {
        if (result[key] && result[key].length > 0) process.stdout.write('    ' + key + ': ' + result[key].join(', ') + '\n');
      }
      process.stdout.write('\n');
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error('unknown map action: ' + action);
}

function cmdContext(options) {
  const action = options.action || 'build';
  const root = workspaceRootFor(options);
  const mode = resolveMode(options);
  const params = {
    maxTokens: options['max-tokens'] !== undefined ? options['max-tokens'] : mode.profile.maxTokens,
    query: options.query,
    includeRepoMap: options['no-repo-map']
      ? false
      : (mode.profile.includeRepoMap !== undefined ? mode.profile.includeRepoMap : true),
    expand: options.expand,
    asOf: options['as-of'],
    graphEdges: options['graph-edges'],
    graphNearDays: options['graph-near-days'],
  };
  if (action === 'build') {
    const result = buildContext(root, params);
    if (options.json) { emitJson(result); return; }
    process.stdout.write('\n' + result.content + '\n');
    return;
  }
  if (action === 'explain') {
    const result = buildExplain(root, params);
    if (options.json) { emitJson(result); return; }
    process.stdout.write('\n' + result.content + '\n');
    return;
  }
  throw new Error('unknown context action: ' + action);
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function cmdRecap(options) {
  const root = workspaceRootFor(options);
  const mode = resolveMode(options);
  const result = buildRecap(root, {
    sinceT: positiveInt(options.since),
    untilT: positiveInt(options.until),
    fromDate: options.from,
    toDate: options.to,
    pockets: options.pockets,
    maxTokens: options['max-tokens'] !== undefined ? options['max-tokens'] : mode.profile.maxTokens,
  });
  if (options.json) { emitJson(result); return; }
  process.stdout.write('\n' + result.content + '\n');
}

function cmdAudit(options) {
  const root = workspaceRootFor(options);
  const result = auditWorkspace(root, {
    sinceT: positiveInt(options.since),
    untilT: positiveInt(options.until),
    fromDate: options.from,
    toDate: options.to,
    pockets: options.pockets,
  });
  if (options.json) { emitJson(result, result.ok ? 0 : 1); return; }
  process.stdout.write('\n' + result.content + '\n');
  if (!result.ok) process.exitCode = 1;
}

function cmdDecay(options) {
  const root = workspaceRootFor(options);
  const result = decayWorkspace(root, {
    maxAgeDays: options['max-age-days'],
    keepLast: options['keep-last'],
    minTurns: options['min-turns'],
    pockets: options.pockets,
    today: options.today,
    apply: !!options.apply,
  });
  if (options.json) { emitJson(result, result.ok ? 0 : 1); return; }
  process.stdout.write('\n' + result.content + '\n');
  if (!result.ok) process.exitCode = 1;
}

function cmdCapture(options) {
  const root = workspaceRootFor(options);
  const file = options.action || (options.positional || [])[0];
  const result = captureWorkspace(root, {
    file,
    pr: options.pr,
    run: options.run,
    repo: options.repo,
    pocket: options.pocket,
    kind: options.kind,
    gist: options.gist,
    tags: options.tags,
    url: options.url,
    when: options.when,
    apply: !!options.apply,
  });
  if (options.json) { emitJson(result); return; }

  process.stdout.write('\n  Capture (' + result.mode + ') · ' + result.workspace + '\n');
  process.stdout.write('    Pocket: ' + result.pocket.name + ' · kind: ' + result.kind
    + ' · tags: ' + result.tags.join(', ') + '\n');
  process.stdout.write('    ' + (result.captured ? '✅ T' + result.tId + ' · ' : '') + result.gist + '\n');
  for (const line of result.action) process.stdout.write('      - ' + line + '\n');
  for (const warning of result.warnings) {
    process.stdout.write('    ⚠️ ' + warning.label + ' (' + warning.masked + ')\n');
  }
  if (result.when) process.stdout.write('    ' + result.when + '\n');
  if (!result.captured) process.stdout.write('    (run with --apply to write)\n');
  process.stdout.write('\n');
}

function cmdForget(options) {
  const root = workspaceRootFor(options);
  const result = forgetWorkspace(root, {
    beforeT: options.before,
    beforeDate: options['before-date'],
    keepLast: options['keep-last'],
    pockets: options.pockets,
    apply: !!options.apply,
  });
  if (options.json) { emitJson(result, result.ok ? 0 : 1); return; }

  process.stdout.write('\n  Workspace forget (' + result.mode + ') · ' + result.workspace + '\n');
  for (const pocket of result.pockets) {
    if (!pocket.ok) {
      process.stdout.write('    ❌ ' + pocket.name + ': ' + pocket.error + '\n');
      continue;
    }
    if (pocket.plannedArchived === 0) {
      process.stdout.write('    ↳ ' + pocket.name + ': nothing to archive (' + pocket.reason + ')\n');
      continue;
    }
    const ids = pocket.archivedIds;
    const range = ids.length === 1 ? 'T' + ids[0] : 'T' + ids[0] + '–T' + ids[ids.length - 1];
    const keptRange = pocket.kept > 0 ? pocket.kept + ' kept' : 'none kept';
    process.stdout.write('    ' + (pocket.applied ? '✅ ' : '') + pocket.name + ': '
      + range + ' → log-archive.md · ' + pocket.plannedArchived + ' turn(s) · ' + keptRange + '\n');
  }
  process.stdout.write('    Total: ' + result.totals.plannedArchived + ' planned · '
    + result.totals.archived + ' archived · ' + result.totals.failed + ' failed'
    + (result.mode === 'plan' ? ' (run with --apply to write)' : '') + '\n\n');
  if (!result.ok) process.exitCode = 1;
}

function printConsolidatePocket(pocket) {
  const counts = [
    pocket.adrs.duplicates + ' ADR',
    pocket.requirements.duplicates + ' req',
    pocket.preferences.duplicates.length + ' pref line(s)',
    pocket.preferences.conflicts.length + ' pref conflict(s)',
  ];
  process.stdout.write('    ' + pocket.name + ': ' + counts.join(' · ') + '\n');
  for (const group of pocket.adrs.groups) {
    const others = group.items.filter((item) => item.id !== group.keep).map((item) => 'ADR-' + item.id);
    process.stdout.write('      ↳ keep ADR-' + group.keep + ' ← ' + others.join(', ')
      + (group.conflict ? ' · conflicting decisions' : ' · same title/decision') + ' (manual)\n');
  }
  for (const group of pocket.requirements.groups) {
    const others = group.items.filter((item) => item.id !== group.keep).map((item) => 'R' + item.id);
    process.stdout.write('      ↳ keep R' + group.keep + ' ← ' + others.join(', ') + ' (manual)\n');
  }
  for (const duplicate of pocket.preferences.duplicates) {
    process.stdout.write('      ↳ pref line ' + duplicate.line + ' duplicates line '
      + duplicate.keepLine + (pocket.preferences.applied ? ' (removed)' : ' (safe)') + '\n');
  }
  for (const conflict of pocket.preferences.conflicts) {
    process.stdout.write('      ↳ pref conflict "' + conflict.key + '": lines '
      + conflict.lines.map((line) => line.line).join(', ') + ' (manual)\n');
  }
}

function printConsolidateCross(cross) {
  const adrs = cross.adrs.groups;
  const requirements = cross.requirements.groups;
  const preferences = cross.preferences.duplicates.concat(cross.preferences.conflicts);
  if (adrs.length === 0 && requirements.length === 0 && preferences.length === 0) return;

  process.stdout.write('    Cross-pocket (manual)\n');
  for (const group of adrs) {
    const items = group.items.map((item) => item.pocket + ' ' + item.id).join(', ');
    process.stdout.write('      ↳ ADR "' + group.key + '": ' + items
      + (group.conflict ? ' · conflicting decisions' : '') + '\n');
  }
  for (const group of requirements) {
    const items = group.items.map((item) => item.pocket + ' ' + item.id).join(', ');
    process.stdout.write('      ↳ req "' + group.key + '": ' + items
      + (group.conflict ? ' · status differs' : '') + '\n');
  }
  for (const group of cross.preferences.duplicates) {
    const items = group.items.map((item) => item.pocket + ' L' + item.line).join(', ');
    process.stdout.write('      ↳ pref "' + group.key + '": ' + items + ' · same value\n');
  }
  for (const group of cross.preferences.conflicts) {
    const items = group.items.map((item) => item.pocket + ' L' + item.line).join(', ');
    process.stdout.write('      ↳ pref conflict "' + group.key + '": ' + items + '\n');
  }
}

function cmdConsolidate(options) {
  const root = workspaceRootFor(options);
  const result = consolidateWorkspace(root, {
    pockets: options.pockets,
    apply: !!options.apply,
  });
  if (options.json) { emitJson(result, result.ok ? 0 : 1); return; }

  process.stdout.write('\n  Workspace consolidate (' + result.mode + ') · ' + result.workspace + '\n');
  for (const pocket of result.pockets) {
    if (!pocket.ok) {
      process.stdout.write('    ❌ ' + pocket.name + ': ' + pocket.error + '\n');
      continue;
    }
    printConsolidatePocket(pocket);
  }
  printConsolidateCross(result.crossPocket);
  const totals = result.totals;
  const crossGroups = totals.crossPocketAdrGroups + totals.crossPocketRequirementGroups
    + totals.crossPocketPreferenceDuplicates + totals.crossPocketPreferenceConflicts;
  process.stdout.write('    Total: ' + totals.duplicateAdrs + ' ADR duplicate(s) · '
    + totals.duplicateRequirements + ' requirement duplicate(s) · '
    + totals.preferenceDuplicates + ' pref duplicate(s) · '
    + totals.preferenceConflicts + ' pref conflict(s) · '
    + totals.removedPreferences + ' removed · '
    + crossGroups + ' cross-pocket group(s)'
    + (result.mode === 'plan' ? ' (run with --apply to remove exact preference duplicates)' : '') + '\n\n');
  if (!result.ok) process.exitCode = 1;
}

function cmdMerge(options) {
  const root = workspaceRootFor(options);
  const positional = options.positional || [];
  const source = options.action || positional[0];
  const rest = options.action ? positional : positional.slice(1);
  const target = options.into || rest[0];

  const result = mergeWorkspace(root, source, target, {
    apply: !!options.apply,
    includeArchive: !!options['include-archive'],
  });
  if (options.json) { emitJson(result, result.ok ? 0 : 1); return; }

  process.stdout.write('\n  Workspace merge (' + result.mode + ') · ' + result.workspace + '\n');
  process.stdout.write('    ' + result.source.name + ' → ' + result.target.name + '\n');
  if (!result.ok) {
    process.stdout.write('    ❌ ' + (result.merge.error || 'merge failed') + '\n\n');
    process.exitCode = 1;
    return;
  }

  const merge = result.merge;
  if (merge.alreadyMerged) {
    process.stdout.write('    ↳ already merged (no new turns or records)\n\n');
    return;
  }
  process.stdout.write('    Turns: +' + merge.turns.added + ' · ' + merge.turns.duplicates
    + ' duplicate(s) · +' + merge.turns.fixesAdded + ' fix(es)\n');
  process.stdout.write('    Docs: +' + merge.docs.adrsAdded + ' ADR · +' + merge.docs.reqsAdded + ' req · +'
    + merge.docs.absoluteAdded + ' 🔒 · +' + merge.docs.prefsAdded + ' pref'
    + (merge.docs.reqStatusConflicts.length ? ' · ' + merge.docs.reqStatusConflicts.length + ' status conflict' : '')
    + (merge.docs.prefConflicts.length ? ' · ' + merge.docs.prefConflicts.length + ' pref conflict' : '') + '\n');
  if (merge.attachments.copied.length > 0 || merge.attachments.conflicts.length > 0 || merge.attachments.missing.length > 0) {
    process.stdout.write('    Attachments: ' + merge.attachments.copied.length + ' copied · '
      + merge.attachments.conflicts.length + ' conflict · ' + merge.attachments.missing.length + ' missing\n');
  }
  if (merge.reportPath) process.stdout.write('    Report: ' + merge.reportPath + '\n');
  if (result.mode === 'plan') process.stdout.write('    (dry run — run with --apply to write)\n');
  process.stdout.write('\n');
}

function main() {
  const args = parseCli(process.argv);
  const command = args.command;
  const options = args.options;
  options.action = args.action;
  options.positional = args.positional;

  try {
    if (options.version || options.v || command === 'version') { printVersion(options); return; }
    if (options.help || options.h || command === 'help' || command === null) {
      if (command && command !== 'help' && commandHelp(command)) {
        process.stdout.write(commandHelp(command) + '\n');
        return;
      }
      printHelp(options);
      return;
    }
    if (command === 'workspace') { cmdWorkspace(options); return; }
    if (command === 'map') { cmdMap(options); return; }
    if (command === 'context') { cmdContext(options); return; }
    if (command === 'recap') { cmdRecap(options); return; }
    if (command === 'audit') { cmdAudit(options); return; }
    if (command === 'decay') { cmdDecay(options); return; }
    if (command === 'forget') { cmdForget(options); return; }
    if (command === 'consolidate') { cmdConsolidate(options); return; }
    if (command === 'merge') { cmdMerge(options); return; }
    if (command === 'capture') { cmdCapture(options); return; }
    fail(options, 'Unknown command: ' + command);
  } catch (e) {
    fail(options, e.message);
  }
}

main();
