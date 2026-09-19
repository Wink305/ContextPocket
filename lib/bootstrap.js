'use strict';

/**
 * ContextPocket — Bootstrap 模块
 * 初始化 ContextPocket 目录，复制模板文件，预填内容
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const {
  CORE_FILES,
  LITE_CORE_FILES,
  POCKET_DIR_NAME,
  DEFAULT_CONFIG,
} = require('./constants');
const { fileExists, readFileSafe } = require('./core');

// ============================================================
// 项目类型检测
// ============================================================

/**
 * 检测项目类型
 * @param {string} projectRoot - 项目根目录
 * @returns {string} frontend / backend / fullstack / data / mobile
 */
function detectProjectType(projectRoot) {
  const markers = {
    frontend: [
      'package.json',
      ['src', 'App.tsx'],
      ['src', 'App.jsx'],
      ['src', 'App.vue'],
      'vite.config.ts',
      'vite.config.js',
      'webpack.config.js',
      'next.config.js',
      'next.config.ts',
      'nuxt.config.js',
      'svelte.config.js',
    ],
    backend: [
      'package.json',
      ['src', 'server.ts'],
      ['src', 'server.js'],
      ['src', 'app.ts'],
      ['src', 'app.js'],
      'requirements.txt',
      'pyproject.toml',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
      'build.gradle',
    ],
    fullstack: [
      ['package.json'], // 需进一步判断
    ],
    data: [
      'requirements.txt',
      'pyproject.toml',
      'Dockerfile',
      ['notebooks'],
      ['data'],
    ],
    mobile: [
      'pubspec.yaml',
      'android/',
      'ios/',
      'app.json',
    ],
  };

  const scores = {
    frontend: 0,
    backend: 0,
    fullstack: 0,
    data: 0,
    mobile: 0,
  };

  for (const [type, files] of Object.entries(markers)) {
    for (const file of files) {
      const filePath = Array.isArray(file)
        ? path.join(projectRoot, ...file)
        : path.join(projectRoot, file);
      if (fileExists(filePath)) {
        scores[type]++;
      }
    }
  }

  // 特殊逻辑：如果有 package.json，进一步判断
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      const frontendDeps = ['react', 'vue', 'angular', 'svelte', 'vite', 'webpack'];
      const backendDeps = ['express', 'koa', 'nest', 'fastify', 'django', 'flask'];

      for (const dep of frontendDeps) {
        if (deps[dep]) scores.frontend += 2;
      }
      for (const dep of backendDeps) {
        if (deps[dep]) scores.backend += 2;
      }

      // 如果前后端都有，判为 fullstack
      if (scores.frontend >= 2 && scores.backend >= 2) {
        scores.fullstack += 3;
      }
    } catch (e) {
      // 忽略解析错误
    }
  }

  // 返回最高分的类型
  let bestType = 'fullstack';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  return bestScore === 0 ? 'fullstack' : bestType;
}

// ============================================================
// 扫描项目目录结构（生成顶层目录树）
// ============================================================

/**
 * 扫描项目目录，生成顶层目录树（用于 code-map 预填）
 * @param {string} projectRoot - 项目根目录
 * @param {number} maxDepth - 最大深度
 * @returns {string} 目录树字符串
 */
function scanProjectTree(projectRoot, maxDepth = 2) {
  const ignoreDirs = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'out', '.next', '.nuxt',
    '__pycache__', '.venv', 'venv', 'env',
    '.idea', '.vscode', '.DS_Store',
    'ContextPocket',
  ]);

  const lines = [];

  function scan(dir, depth, prefix) {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      // 过滤掉忽略的目录，先排目录再排文件
      const dirs = entries.filter(e => e.isDirectory() && !ignoreDirs.has(e.name));
      const files = entries.filter(e => e.isFile() && !e.name.startsWith('.'));

      const allItems = [
        ...dirs.map(d => ({ name: d.name, isDir: true })),
        ...files.map(f => ({ name: f.name, isDir: false })),
      ].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        const isLast = i === allItems.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const nextPrefix = prefix + (isLast ? '    ' : '│   ');

        const line = prefix + connector + item.name + (item.isDir ? '/' : '');
        lines.push(line);

        if (item.isDir && depth < maxDepth) {
          scan(path.join(dir, item.name), depth + 1, nextPrefix);
        }
      }
    } catch (e) {
      // 权限不足等情况跳过
    }
  }

  scan(projectRoot, 1, '');

  return lines.join('\n');
}

// ============================================================
// Bootstrap 主函数
// ============================================================

/**
 * 初始化 ContextPocket 目录
 * @param {string} projectRoot - 项目根目录
 * @param {object} options
 * @param {string} [options.projectType] - 项目类型（自动检测 if not specified）
 * @param {string} [options.mode='full'] - full / lite
 * @param {string} [options.language='zh'] - zh / en
 * @param {string} [options.templatesDir] - 模板目录路径
 * @returns {object} { success, pocketDir, projectType, mode, filesCopied }
 */
function bootstrap(projectRoot, options = {}) {
  const pocketDir = path.join(projectRoot, POCKET_DIR_NAME);
  const mode = options.mode || 'full';
  const language = options.language || 'zh';
  const templatesDir = options.templatesDir || path.join(__dirname, '..', 'templates');

  // 幂等保护：如果 ContextPocket 已存在，报错
  if (fileExists(pocketDir)) {
    const stat = fs.statSync(pocketDir);
    if (stat.isDirectory()) {
      throw new Error(`ContextPocket/ already exists at ${pocketDir}. Bootstrap is idempotent — refusing to overwrite.`);
    }
  }

  // 检测项目类型
  const projectType = options.projectType || detectProjectType(projectRoot);

  // 确定要复制的核心文件
  const coreFiles = mode === 'lite' ? LITE_CORE_FILES : CORE_FILES;

  // 创建目录
  fs.mkdirSync(pocketDir, { recursive: true });

  // 创建 assets/ 子目录
  const assetsDir = path.join(pocketDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const copiedFiles = [];

  // 复制模板文件
  for (const file of coreFiles) {
    const srcPath = path.join(templatesDir, file);
    const destPath = path.join(pocketDir, file);

    if (!fileExists(srcPath)) {
      continue; // 模板不存在则跳过
    }

    let content = fs.readFileSync(srcPath, 'utf-8');

    // 预填内容
    content = prefillTemplate(file, content, {
      projectRoot,
      projectType,
      mode,
      language,
    });

    fs.writeFileSync(destPath, content, 'utf-8');
    copiedFiles.push(file);
  }

  // 更新 config.md 中的配置
  updateConfigValues(pocketDir, { project_type: projectType, mode, language });

  // 更新 .gitignore：默认忽略 ContextPocket/；gitignore: false 时改为移除该条目，
  // 让 pocket 数据进 git，跨设备靠 git 同步（借鉴 Basic Memory 的 "知识库纳入版本管理"）
  const gitResult = updateGitignore(projectRoot, { enabled: options.gitignore !== false });

  return {
    success: true,
    pocketDir,
    projectType,
    mode,
    language,
    filesCopied: copiedFiles,
    gitignore: gitResult,
  };
}

// ============================================================
// 模板预填
// ============================================================

function prefillTemplate(filename, content, ctx) {
  const { projectRoot, projectType, mode, language } = ctx;
  const today = getTodayStr();

  switch (filename) {
    case 'index.md':
      // 初始化 index.md 标题
      content = content.replace('T<n>', 'T0');
      content = content.replace('<date>', today);
      // T-range: bootstrap 后 log.md 是空的，正确描述为 T0 (empty)
      content = content.replace('T<a>–T<b>', 'T0 (empty — bootstrap state)');
      // 移除归档行（还没有归档）
      content = content.replace(/- log-archive\.md → T1–T<a-1> \(if exists\)\n/, '');
      // handoff 状态
      content = content.replace('<date or "(not yet generated)">', '(not yet generated)');
      // 更新 items 计数（模板示例已清理，0 是准确值）
      content = content.replace('N items, R1–R<m>', '0 items');
      content = content.replace('M prefs', '0 prefs');
      content = content.replace('N ADRs', '0 ADRs');
      content = content.replace('K files/modules documented', '0 files/modules');
      content = content.replace('N 🔒 entries', '0 🔒 entries');
      break;

    case 'code-map.md':
      // 预填项目目录结构
      const tree = scanProjectTree(projectRoot, 2);
      // 替换模板中的 Structure 代码块
      const structureMatch = content.match(/## Structure\n```\n([\s\S]*?)```/);
      if (structureMatch) {
        const placeholder = structureMatch[1];
        content = content.replace(placeholder, tree + '\n\n> ⚠️ Auto-scanned top-level structure. Add descriptions for key files.');
      }
      // 更新标题行
      content = content.replace('T<n>', 'T0');
      content = content.replace('<date>', today);
      break;

    case 'readme.md':
      // 预填项目信息
      const projectName = path.basename(projectRoot);
      content = content.replace('<name>', projectName);
      content = content.replace(/type: <[^>]+>/, `type: ${projectType}`);
      break;

    case 'state.md':
      content = content.replace('T<n>', 'T0');
      content = content.replace('<date>', today);
      break;

    case 'preferences.md':
      content = content.replace('T<n>', 'T0');
      break;

    case 'log.md':
      // 移除模板中的 T1 示例块
      content = content.replace(/## T1[\s\S]*$/, '');
      break;

    case 'config.md':
      // config 的更新在 updateConfigValues 中统一处理
      break;

    default:
      break;
  }

  return content;
}

// ============================================================
// 更新 config.md 中的配置值
// ============================================================

function updateConfigValues(pocketDir, values) {
  const configPath = path.join(pocketDir, 'config.md');
  if (!fileExists(configPath)) return;

  let content = fs.readFileSync(configPath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('- ')) continue;

    for (const [key, value] of Object.entries(values)) {
      const pattern = new RegExp(`^-\\s+${key}:\\s+.*$`);
      if (pattern.test(trimmed)) {
        // 保留注释部分
        const commentMatch = trimmed.match(/#.*$/);
        const comment = commentMatch ? '  ' + commentMatch[0] : '';
        lines[i] = `- ${key}: ${value}${comment}`;
      }
    }
  }

  fs.writeFileSync(configPath, lines.join('\n'), 'utf-8');
}

// ============================================================
// 更新 .gitignore
// ============================================================

/**
 * enabled=true  → 确保 ContextPocket/ 被忽略（默认，项目本地数据）
 * enabled=false → 移除 ContextPocket/ 条目，让 pocket 数据进 git 跨设备同步
 * @param {string} projectRoot
 * @param {object} [opts] { enabled }
 * @returns {object} { created|added|existed|removed|absent, entry }
 */
function updateGitignore(projectRoot, opts = {}) {
  const enabled = opts.enabled !== false;
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = 'ContextPocket/';

  if (!fileExists(gitignorePath)) {
    if (!enabled) {
      return { absent: true, entry };
    }
    fs.writeFileSync(gitignorePath, entry + '\n', 'utf-8');
    return { created: true, entry };
  }

  const content = fs.readFileSync(gitignorePath, 'utf-8');
  const lines = content.split('\n');

  // 检查是否已存在
  const existsIdx = lines.findIndex(line => {
    const trimmed = line.trim();
    return trimmed === entry || trimmed === entry.replace('/', '');
  });

  if (enabled) {
    if (existsIdx === -1) {
      const newContent = content.endsWith('\n')
        ? content + entry + '\n'
        : content + '\n' + entry + '\n';
      fs.writeFileSync(gitignorePath, newContent, 'utf-8');
      return { added: true, entry };
    }
    return { existed: true, entry };
  }

  // enabled=false → 移除条目
  if (existsIdx === -1) {
    return { absent: true, entry };
  }
  lines.splice(existsIdx, 1);
  fs.writeFileSync(gitignorePath, lines.join('\n'), 'utf-8');
  return { removed: true, entry };
}

// ============================================================
// 工具函数
// ============================================================

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  bootstrap,
  detectProjectType,
  scanProjectTree,
  updateConfigValues,
  updateGitignore,
};
