'use strict';

/**
 * ContextPocket yuan — context build
 *
 * 把工作区里的记忆组装成固定预算的上下文：
 *   0 · Start here  红线 / 待确认 / 下一步（永不裁）
 *   1 · Facts       state / open requirements / ADRs / recent turns
 *   2 · Related     workspace search + repo map
 *
 * 预算不够时按 Related → Facts 的顺序整段裁，裁了什么写进输出；
 * 不返回未标注来源的内容，也不假装读过没读过的文件。
 */

const { statusWorkspace, readManifest } = require('./workspace');
const { searchWorkspaceIndexed } = require('./workspace-index');
const { readMap, summarizeMap } = require('./repomap');
const {
  GRAPH_EDGE_GROUPS,
  ensureWorkspaceGraph,
  expandWorkspaceGraph,
  seedIdsFromSearch,
  seedIdsFromStatus,
  resolveAsOfDate,
} = require('./workspace-graph');
const { estimateTokens } = require('./budget');

function bullets(lines) {
  const oneLine = (line) => String(line).replace(/\s*\n\s*/g, ' ').trim();
  return lines.length === 0
    ? '- (none)\n'
    : lines.map((line) => '- ' + oneLine(line)).join('\n') + '\n';
}

function buildFixed(status) {
  const lines = [];
  lines.push('## 0 · Start here');
  lines.push('> STOP CONDITION: read this section, confirm every ❓ and obey every 🔒 line, then act.');
  lines.push('');
  lines.push('### 🔒 Red lines');
  const red = [];
  for (const pocket of status.pockets) {
    if (!pocket.ok) continue;
    for (const entry of pocket.absolute) red.push(pocket.name + ':T' + entry.tId + ' — ' + (entry.content || entry.gist));
  }
  lines.push(bullets(red).trimEnd());
  lines.push('');
  lines.push('### ❓ Must confirm');
  const ask = [];
  for (const pocket of status.pockets) {
    if (!pocket.ok) continue;
    for (const item of pocket.uncertain) ask.push(pocket.name + ':T' + item.tId + ' — ' + item.text);
  }
  lines.push(bullets(ask).trimEnd());
  lines.push('');
  lines.push('### Next');
  const next = [];
  for (const pocket of status.pockets) {
    if (!pocket.ok) continue;
    for (const step of pocket.nextSteps) next.push(pocket.name + ' — ' + step);
  }
  lines.push(bullets(next).trimEnd());
  return lines.join('\n') + '\n';
}

function buildFacts(status) {
  const lines = ['## 1 · Facts', ''];
  for (const pocket of status.pockets) {
    if (!pocket.ok) {
      lines.push('### ' + pocket.name + ' (unavailable)');
      lines.push('- ' + (pocket.error || 'pocket is missing'));
      lines.push('');
      continue;
    }
    lines.push('### ' + pocket.name + ' · T' + pocket.latestT + ' · ' + pocket.blocks + ' block(s)');
    if (pocket.stateSummary.length > 0) {
      lines.push('- ' + pocket.name + ' — State: ' + pocket.stateSummary.join(' / '));
    }
    for (const req of pocket.openRequirementTexts) {
      lines.push('- ' + pocket.name + ':' + req.id + (req.uncertain ? ' ❓' : '') + ' — ' + req.text);
    }
    for (const adr of pocket.adrTitles) {
      lines.push('- ' + pocket.name + ':' + adr.id + ' — ' + adr.title);
    }
    for (const turn of pocket.recent) {
      lines.push('- ' + pocket.name + ':T' + turn.id + ' — ' + turn.gist);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function parseExpand(value) {
  if (value === undefined || value === null || value === '' || value === false) return 0;
  if (value === true) throw new Error('--expand needs a depth: 1 or 2');
  const depth = Number(value);
  if (depth === 1 || depth === 2) return depth;
  throw new Error('--expand must be 1 or 2 (got ' + value + ')');
}

function parseGraphEdges(value) {
  if (value === undefined || value === null || value === '' || value === false) return [];
  if (value === true) {
    throw new Error('--graph-edges needs a list: ' + GRAPH_EDGE_GROUPS.join(', ') + ', all');
  }
  const wanted = new Set();
  for (const raw of String(value).split(',')) {
    const token = raw.trim();
    if (!token) continue;
    if (token === 'all') return GRAPH_EDGE_GROUPS.slice();
    if (!GRAPH_EDGE_GROUPS.includes(token)) {
      throw new Error('unknown --graph-edges value "' + token + '" (use '
        + GRAPH_EDGE_GROUPS.join(', ') + ' or all)');
    }
    wanted.add(token);
  }
  return GRAPH_EDGE_GROUPS.filter((group) => wanted.has(group));
}

function parseNearDays(value) {
  if (value === undefined || value === null || value === '') return 7;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('--graph-near-days must be a positive integer (got ' + value + ')');
  }
  return days;
}

function graphOptionsFor(root, options) {
  const expand = parseExpand(options.expand);
  const edges = parseGraphEdges(options.graphEdges);
  const nearDays = parseNearDays(options.graphNearDays);
  const asOf = resolveAsOfDate(root, options.asOf);
  if (asOf && expand === 0) {
    throw new Error('--as-of requires --expand');
  }
  if (edges.length > 0 && expand === 0) {
    throw new Error('--graph-edges requires --expand');
  }
  return { expand, asOf, edges, nearDays };
}

function formatGraphPath(item) {
  return item.path.map((edge) => {
    const anchor = edge.type === 'x-ref'
      ? edge.from
      : (edge.basis
        ? edge.basis
        : String(edge.source || '') + (edge.tId === null || edge.tId === undefined ? '' : ' T' + edge.tId));
    return edge.from + ' → ' + edge.type + ' → ' + edge.to
      + ' [' + anchor + (edge.date ? ' · ' + edge.date : '') + ']';
  }).join(' ; ');
}

function buildRelated(root, query, mapEnabled, graphOptions = {}, status = null) {
  const lines = ['## 2 · Related', ''];
  let hasContent = false;
  let searchCount = 0;
  let repoMapFiles = 0;
  let repoMapPresent = false;
  let graphNeighbors = 0;
  let graphPresent = false;
  let graphCrossEdges = 0;
  let graphDerivedEdges = 0;
  let search = null;

  if (query) {
    search = searchWorkspaceIndexed(root, query, { limit: 10 });
    searchCount = search.total;
    lines.push('### Search: "' + query + '"');
    lines.push(bullets(search.results.map((row) =>
      row.pocket + ':' + row.id + ' [' + row.type + '] ' + row.label)).trimEnd());
    lines.push('');
    hasContent = true;
  }

  if (mapEnabled) {
    const map = readMap(root);
    repoMapPresent = !!map;
    lines.push('### Repo map');
    if (!map) {
      lines.push('- (no cache — run "context-pocket-yuan map update")');
    } else {
      repoMapFiles = map.files.length;
      const summary = summarizeMap(map);
      const langs = Object.entries(summary.byLanguage).map(([k, v]) => k + ' ' + v).join(', ');
      lines.push('- Files: ' + summary.files + (langs ? ' (' + langs + ')' : '') + ' · symbols: ' + summary.symbols);
      for (const file of map.files.slice(0, 8)) {
        const symbols = file.symbols.length > 0 ? ' — ' + file.symbols.slice(0, 6).join(', ') : '';
        lines.push('- [' + file.pocket + '] ' + file.path + symbols);
      }
      hasContent = true;
      lines.push('');
    }
  }

  if (graphOptions.expand > 0) {
    const built = ensureWorkspaceGraph(root);
    graphPresent = true;
    graphCrossEdges = (built.stats && built.stats.crossPocketEdges) || 0;

    const seeds = [...new Set(
      seedIdsFromSearch(search ? search.results : [])
        .concat(seedIdsFromStatus(status))
    )].slice(0, 50);

    lines.push('### Graph');
    if (seeds.length === 0) {
      lines.push('- (no seeds to expand)');
    } else {
      const expansion = expandWorkspaceGraph(built.graph, seeds, graphOptions.expand, {
        asOf: graphOptions.asOf || null,
        maxNodes: 30,
        maxDegree: 32,
        exclude: seeds,
        groups: graphOptions.edges,
        nearDays: graphOptions.nearDays,
      });
      graphNeighbors = expansion.results.length;
      graphDerivedEdges = expansion.derivedEdges || 0;

      if (expansion.results.length === 0) {
        lines.push('- (no graph neighbors)');
      } else {
        for (const item of expansion.results) {
          lines.push('- ' + item.id + (item.label ? ' · ' + item.label : '')
            + ' (' + item.distance + ' hop' + (item.distance === 1 ? '' : 's') + ', ' + item.scope + ')');
          lines.push('  Path: ' + formatGraphPath(item));
        }
        if (expansion.hasMore) {
          lines.push('- (additional graph neighbors omitted at the safety limit)');
        }
      }

      const derivedStats = expansion.derivedStats;
      if (derivedStats && derivedStats.total > 0) {
        const labels = [
          ['duplicateAdr', 'duplicate-adr'],
          ['duplicateReq', 'duplicate-req'],
          ['duplicatePref', 'duplicate-pref'],
          ['sharedFile', 'shared-file'],
          ['sameTag', 'same-tag'],
          ['temporalNear', 'temporal-near'],
        ];
        const parts = labels
          .filter(([key]) => derivedStats[key] > 0)
          .map(([key, label]) => label + ' ' + derivedStats[key]);
        lines.push('- Derived: ' + derivedStats.total + ' edge(s) — ' + parts.join(', ')
          + (derivedStats.truncated ? ' · truncated' : ''));
        const shown = (expansion.derivedList || []).slice(0, 8);
        for (const edge of shown) {
          lines.push('- ' + edge.from + ' ↔ ' + edge.to + ' · ' + edge.type);
        }
        if ((expansion.derivedList || []).length > shown.length) {
          lines.push('- (' + (expansion.derivedList.length - shown.length) + ' more derived edge(s) omitted)');
        }
      }
    }
    hasContent = true;
    lines.push('');
  }

  return {
    content: lines.join('\n'),
    hasContent,
    searchCount,
    repoMapFiles,
    repoMapPresent,
    graphNeighbors,
    graphPresent,
    graphCrossEdges,
    graphDerivedEdges,
  };
}

/**
 * 按预算裁剪三层内容。build 与 explain 共用这一份逻辑，解释里的模拟结果
 * 才不可能和真正 build 出来的东西不一致。
 */
function assemble(fixed, facts, related, maxTokens) {
  const trimmed = [];
  let content = fixed + '\n' + facts + '\n' + related.content;
  if (estimateTokens(content) > maxTokens && related.hasContent) {
    content = fixed + '\n' + facts;
    trimmed.push('Related');
  }
  if (estimateTokens(content) > maxTokens) {
    content = fixed;
    trimmed.push('Facts');
  }
  const estimated = estimateTokens(content);
  return { content, trimmed, estimated, overBudget: estimated > maxTokens };
}

function budgetFooter(estimated, maxTokens, trimmed, overBudget) {
  if (trimmed.length === 0 && !overBudget) return '';
  return '- (token budget: ~' + estimated + ' / ' + maxTokens + ' tokens'
    + (trimmed.length > 0 ? '; trimmed: ' + trimmed.join(', ') : '')
    + (overBudget ? '; section 0 alone exceeds the budget — raise --max-tokens' : '')
    + ')\n';
}

function buildContext(root, options = {}) {
  const manifest = readManifest(root);
  const defaultBudget = (manifest.context && manifest.context.defaultMaxTokens) || 6000;
  const maxTokens = Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0
    ? Number(options.maxTokens)
    : defaultBudget;
  const query = options.query ? String(options.query).trim() : '';
  const mapEnabled = options.includeRepoMap !== false
    && (!manifest.context || manifest.context.includeRepoMap !== false);
  const graphOptions = graphOptionsFor(root, options);

  const status = statusWorkspace(root);
  const fixed = buildFixed(status);
  const facts = buildFacts(status);
  const related = buildRelated(root, query, mapEnabled, graphOptions, status);
  const assembled = assemble(fixed, facts, related, maxTokens);
  const content = assembled.content.replace(/\n*$/, '\n')
    + budgetFooter(assembled.estimated, maxTokens, assembled.trimmed, assembled.overBudget);

  return {
    ok: true,
    root,
    workspace: manifest.name,
    maxTokens,
    estimatedTokens: assembled.estimated,
    trimmed: assembled.trimmed,
    overBudget: assembled.overBudget,
    sources: {
      pockets: manifest.pockets.map((p) => ({ name: p.name, path: p.path })),
      query: query || null,
      repoMap: related.repoMapPresent,
      graph: {
        enabled: graphOptions.expand > 0,
        asOf: graphOptions.asOf || null,
        edges: graphOptions.edges,
        neighbors: related.graphNeighbors,
        derivedEdges: related.graphDerivedEdges,
        crossPocketEdges: related.graphCrossEdges,
      },
    },
    content,
  };
}

function renderExplain(result) {
  const lines = [
    '# Context explain · ' + result.workspace,
    '',
    '- Budget: ' + result.maxTokens + ' · estimated ' + result.estimatedTokens + ' token(s)'
      + (result.overBudget ? ' · over budget' : ''),
    '- Query: ' + (result.query || '(none)'),
    '',
    '## Sections',
    '- 0 · Start here: ~' + result.sections.startHere.tokens + ' token(s) · '
      + result.sections.startHere.redLines + ' red line(s) · '
      + result.sections.startHere.mustConfirm + ' must-confirm · '
      + result.sections.startHere.nextSteps + ' next step(s)',
    '- 1 · Facts: ~' + result.sections.facts.tokens + ' token(s) · '
      + result.sections.facts.pockets.length + ' pocket(s)',
    '- 2 · Related: ~' + result.sections.related.tokens + ' token(s) · '
      + (result.query ? result.sections.related.searchHits + ' search hit(s)' : 'no query')
      + ' · repo map ' + (result.sections.related.repoMap.present
        ? result.sections.related.repoMap.files + ' file(s)'
        : 'not available')
      + (result.sections.related.graph.enabled
        ? ' · graph ' + result.sections.related.graph.neighbors + ' neighbor(s) · '
          + result.sections.related.graph.crossPocketEdges + ' cross edge(s)'
          + (result.sections.related.graph.derivedEdges > 0
            ? ' · ' + result.sections.related.graph.derivedEdges + ' derived'
            : '')
          + (result.sections.related.graph.edges.length > 0
            ? ' · edges=' + result.sections.related.graph.edges.join(',')
            : '')
          + (result.sections.related.graph.asOf ? ' · as-of ' + result.sections.related.graph.asOf : '')
        : ''),
    '',
    '## Budget simulation',
  ];

  for (const budget of result.budgets) {
    lines.push('- ' + budget.maxTokens + ': '
      + (budget.trimmed.length > 0 ? 'trim ' + budget.trimmed.join(' → ') : 'keep all')
      + (budget.overBudget ? ' · over budget' : ''));
  }

  lines.push('');
  lines.push(result.trimmed.length > 0
    ? 'At the requested budget, trimmed: ' + result.trimmed.join(' → ')
    : 'At the requested budget, nothing is trimmed.');
  lines.push('');

  return lines.join('\n');
}

/**
 * 解释一次 context build：各层 token、每个预算下会裁什么、来源有哪些。
 * 不返回完整上下文，避免把解释本身变成另一份要读的长文本。
 */
function buildExplain(root, options = {}) {
  const manifest = readManifest(root);
  const defaultBudget = (manifest.context && manifest.context.defaultMaxTokens) || 6000;
  const maxTokens = Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0
    ? Number(options.maxTokens)
    : defaultBudget;
  const query = options.query ? String(options.query).trim() : '';
  const mapEnabled = options.includeRepoMap !== false
    && (!manifest.context || manifest.context.includeRepoMap !== false);
  const graphOptions = graphOptionsFor(root, options);

  const status = statusWorkspace(root);
  const fixed = buildFixed(status);
  const facts = buildFacts(status);
  const related = buildRelated(root, query, mapEnabled, graphOptions, status);
  const chosen = assemble(fixed, facts, related, maxTokens);

  let redLines = 0;
  let mustConfirm = 0;
  let nextSteps = 0;
  for (const pocket of status.pockets) {
    if (!pocket.ok) continue;
    redLines += pocket.absolute.length;
    mustConfirm += pocket.uncertain.length;
    nextSteps += pocket.nextSteps.length;
  }

  const result = {
    ok: true,
    root,
    workspace: manifest.name,
    maxTokens,
    query: query || null,
    sections: {
      startHere: {
        tokens: estimateTokens(fixed),
        redLines,
        mustConfirm,
        nextSteps,
      },
      facts: {
        tokens: estimateTokens(facts),
        pockets: status.pockets.map((pocket) => ({
          name: pocket.name,
          ok: pocket.ok,
          latestT: pocket.ok ? pocket.latestT : null,
          blocks: pocket.ok ? pocket.blocks : 0,
          openRequirements: pocket.ok ? pocket.openRequirementTexts.length : 0,
          adrs: pocket.ok ? pocket.adrTitles.length : 0,
          recent: pocket.ok ? pocket.recent.length : 0,
        })),
      },
      related: {
        tokens: estimateTokens(related.content),
        hasContent: related.hasContent,
        searchHits: related.searchCount,
        repoMap: {
          enabled: mapEnabled,
          present: related.repoMapPresent,
          files: related.repoMapFiles,
        },
        graph: {
          enabled: graphOptions.expand > 0,
          asOf: graphOptions.asOf || null,
          edges: graphOptions.edges,
          neighbors: related.graphNeighbors,
          derivedEdges: related.graphDerivedEdges,
          crossPocketEdges: related.graphCrossEdges,
        },
      },
    },
    estimatedTokens: chosen.estimated,
    trimmed: chosen.trimmed,
    overBudget: chosen.overBudget,
    budgets: [2000, 6000, 12000].map((budget) => {
      const simulated = assemble(fixed, facts, related, budget);
      return {
        maxTokens: budget,
        estimatedTokens: simulated.estimated,
        trimmed: simulated.trimmed,
        overBudget: simulated.overBudget,
      };
    }),
  };
  result.content = renderExplain(result);
  return result;
}

module.exports = {
  buildContext,
  buildExplain,
  buildFixed,
  buildFacts,
  buildRelated,
};
