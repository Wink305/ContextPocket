'use strict';

/**
 * ContextPocket — 密钥 / PII 形态扫描
 *
 * 为什么需要这一层：ContextPocket 的写入路径是"把用户和 Agent 的原话抄进 markdown"，
 * 而 `ContextPocket/` 在很多项目里是**提交进 git 的**（`bootstrap --gitignore false`，
 * 见 templates/config.md 的 gitignore 行）。用户贴一段"帮我看这个报错"就把 API key
 * 抄进了历史文件，之后每次 clone 都带着它。这类事故靠事后轮换密钥补救太慢，
 * 所以在写进 git 之前拦一道。
 *
 * 分级（决定 verify 是 ERROR 还是 WARNING）：
 * - error：带厂商前缀的凭据串（`sk-ant-…` / `AKIA…` / `ghp_…` / `-----BEGIN PRIVATE KEY-----` …）。
 *   这些前缀在正常中文/英文技术描述里不会出现，误报率接近 0，可以直接拦提交。
 * - warning：形状像 PII 或手写密钥（身份证 / 美国 SSN / 中国大陆手机号 / 通过 Luhn 校验的卡号 /
 *   `password: xxxx` 这类赋值）。这些在技术文档里有正当用途（示例、测试号、演示数据），
 *   所以只提醒、不拦提交 —— 与 `verify` 里"warning 绝不拦提交"的同一条规则一致
 *   （lib/hooks.js 生成的 pre-commit 只在 error 时退非 0）。
 *
 * 刻意不扫的：邮箱、URL、IP、人名。它们在项目文档里是常态信息，报出来只会训练用户忽略警告。
 *
 * 输出永远打码：`mask()` 只留前 6 个字符 + 长度。这条不是洁癖 —— 扫描结果会被 Agent 转述进
 * 下一轮记录，原文回显等于把密钥又抄了一遍。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

// ============================================================
// 规则表
// ============================================================

/**
 * 每条规则：label（给人看的名字）、severity、pattern（源码，扫描时统一加 g 标志）。
 * 规则本身只用"前缀 + 长度"这类强特征，避免嵌套量词在长行上回溯爆炸
 * （parser 那一层已经踩过一次，见 CHANGELOG 的 ReDoS 条目）。
 */
const SECRET_RULES = [
  // ---- error：厂商前缀凭据 ----
  { label: 'Anthropic API key', severity: 'error', pattern: 'sk-ant-[A-Za-z0-9_-]{20,}' },
  { label: 'OpenAI project key', severity: 'error', pattern: 'sk-proj-[A-Za-z0-9_-]{40,}' },
  { label: 'OpenAI API key', severity: 'error', pattern: 'sk-(?!ant-|proj-)[A-Za-z0-9_-]{20,}' },
  { label: 'Stripe key', severity: 'error', pattern: '(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}' },
  { label: 'AWS access key id', severity: 'error', pattern: '(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}' },
  { label: 'GitHub token', severity: 'error', pattern: 'gh[pousr]_[A-Za-z0-9]{36,}' },
  { label: 'GitHub fine-grained token', severity: 'error', pattern: 'github_pat_[0-9A-Za-z_]{40,}' },
  { label: 'GitLab token', severity: 'error', pattern: 'glpat-[A-Za-z0-9_-]{20,}' },
  { label: 'Google API key', severity: 'error', pattern: 'AIza[0-9A-Za-z_-]{35}' },
  { label: 'Slack token', severity: 'error', pattern: 'xox[abprs]-[0-9A-Za-z-]{10,}' },
  { label: 'Slack webhook', severity: 'error', pattern: 'hooks\\.slack\\.com/services/T[A-Za-z0-9_]{6,}/B[A-Za-z0-9_]{6,}/[A-Za-z0-9_]{20,}' },
  { label: 'npm token', severity: 'error', pattern: 'npm_[A-Za-z0-9]{36}' },
  { label: 'Twilio credential', severity: 'error', pattern: 'AC[0-9a-f]{32}' },
  { label: 'SendGrid key', severity: 'error', pattern: 'SG\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}' },
  { label: 'Google OAuth token', severity: 'error', pattern: 'ya29\\.[0-9A-Za-z_-]{20,}' },
  { label: 'private key block', severity: 'error', pattern: '-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----', guard: false },
  { label: 'JWT', severity: 'error', pattern: 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}' },

  // ---- warning：PII 与手写密钥赋值 ----
  { label: 'CN identity number', severity: 'warning', pattern: '\\b[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\\d|3[01])\\d{3}[\\dXx]\\b', guard: false },
  { label: 'US SSN', severity: 'warning', pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b', guard: false },
  { label: 'CN mobile number', severity: 'warning', pattern: '\\b1[3-9]\\d{9}\\b', guard: false },
  // 不做左边界限制：`user_password=abc123456` 里 `password` 前面是下划线，
  // 加了左边界就等于把最常见的真实写法放过。
  // 值只吃 ASCII 可见字符（`!` 到 `~`）：真实凭据都是 ASCII，而 `[^\s]` 会把紧跟其后的
  // 中文标点一起吞进"值"，于是文档里一句 `password: xxxx）` 也能凑够长度被当成凭据报出来。
  { label: 'credential assignment', severity: 'warning', pattern: '(?:password|passwd|pwd|secret|access[_-]?token|api[_-]?key|client[_-]?secret)["\']?\\s*[:=]\\s*["\']?[\\x21-\\x7e]{6,}', guard: false },
];

/** 卡号候选（13-19 位、允许空格或破折号分隔），再过 Luhn */
const CARD_CANDIDATE_RE = /\b(?:\d[ \-]?){12,18}\d\b/g;

/**
 * 编译一次。带边界的规则用 `(?<!…)/(?!…)` 而不是 `\b`：`\b` 以"是否单词字符"为界，
 * 中文/全角字符紧跟其后时判定会失真（`密钥：AKIA…` 这种写法很常见）。
 * 边界只排除"再接一个单词字符"，不排除 `/`、`:`、`-`，否则
 * `https://hooks.slack.com/services/…` 这种以斜杠结尾的 URL 反而扫不到。
 */
const COMPILED = SECRET_RULES.map((rule) => ({
  label: rule.label,
  severity: rule.severity,
  re: rule.guard === false
    ? new RegExp(rule.pattern, 'g')
    : new RegExp('(?<![A-Za-z0-9_])(?:' + rule.pattern + ')(?![A-Za-z0-9_])', 'g'),
}));

// ============================================================
// 降噪
// ============================================================

/**
 * 文档里的占位值不是密钥：`api_key: <your-key>`、`${TOKEN}`、`password: xxxxxxxx`。
 * 这一层判定只为 warning 级的"赋值"规则服务（error 级都有真实前缀，占位写法不会命中）。
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholderValue(value) {
  if (!value) return true;
  const v = String(value).trim().replace(/^["'`]|["'`]$/g, '');
  if (v.length < 6) return true;
  if (/^[<{[].*[>}\]]$/.test(v)) return true; // <key> ${ENV} {{var }}
  if (/^[\s.*_-]+$/.test(v)) return true; // ----- xxxx
  if (/^(?:x{3,}|\*{3,}|0{3,}|={3,})$/i.test(v)) return true;
  if (/^(?:changeme|placeholder|example|dummy|your[_-]|my[_-]|todo|tbd|none|null|nil|redacted|secret|token|value)/i.test(v)) return true;
  if (/^\$\{?[A-Z0-9_]+\}?$/.test(v)) return true; // ${ENV_VAR}
  if (/^[A-Z0-9_]{6,}$/.test(v) && /[A-Z]/.test(v) && !/\d/.test(v)) return true; // 全大写的常量名/环境变量名
  if (/(?:example|test|localhost|sample|placeholder)/i.test(v)) return true;
  return false;
}

/** Luhn 校验：过不了就不是卡号，避免把时间戳/订单号报成 PII */
function passesLuhn(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

/** 只留前 6 个字符与总长度；密钥的熵在尾部，所以尾部一律不回显 */
function mask(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (s.length <= 8) return s.slice(0, 3) + '…(' + s.length + ' chars)';
  return s.slice(0, 6) + '…(' + s.length + ' chars)';
}

// ============================================================
// 扫描
// ============================================================

/**
 * 扫一段文本，找出密钥 / PII 形状的片段。
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.file] 随结果带上的文件名（调用方给）
 * @param {number} [opts.lineOffset=0] 行号偏移（用于只扫文件片段的调用方）
 * @returns {Array<{label:string,severity:string,masked:string,line:number,file?:string}>}
 */
function scanText(text, opts = {}) {
  const findings = [];
  if (!text || typeof text !== 'string') return findings;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const lineNo = i + 1 + (opts.lineOffset || 0);

    for (const rule of COMPILED) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        if (m[0] === '') {
          rule.re.lastIndex++;
          continue;
        }
        if (rule.label === 'credential assignment') {
          const value = m[0].slice(m[0].search(/[:=]/) + 1);
          if (isPlaceholderValue(value)) continue;
        }
        findings.push(shape(rule, m[0], lineNo, opts.file));
      }
    }

    // 卡号：形状候选 + Luhn 双条件
    CARD_CANDIDATE_RE.lastIndex = 0;
    let c;
    while ((c = CARD_CANDIDATE_RE.exec(line)) !== null) {
      const digits = c[0].replace(/[ \-]/g, '');
      if (passesLuhn(digits)) {
        findings.push(shape(
          { label: 'card number', severity: 'warning' },
          c[0],
          lineNo,
          opts.file
        ));
      }
    }
  }

  // 同一行同一规则命中多次只报一条：fix 文案按"文件 + 行"处理，多条重复只吵不解决问题
  const seen = new Set();
  return findings.filter((f) => {
    const key = f.line + '\u0000' + f.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shape(rule, matched, line, file) {
  const found = { label: rule.label, severity: rule.severity, masked: mask(matched), line };
  if (file) found.file = file;
  return found;
}

/**
 * 把文本里的命中片段换成 `[REDACTED:<label>]`。
 * **只在调用方明确要求时使用**：🔒 绝对标记按定义要逐字保存用户原话，
 * 默认静默改写等于撒谎（见 SKILL.md 的 absolute 一节）。
 * @param {string} text
 * @returns {{text:string,redacted:number,labels:string[]}}
 */
function redactText(text) {
  if (!text) return { text: text || '', redacted: 0, labels: [] };
  let out = String(text);
  let redacted = 0;
  const labels = [];

  for (const rule of COMPILED) {
    const re = new RegExp(rule.re.source, 'g');
    out = out.replace(re, (match) => {
      if (rule.label === 'credential assignment' &&
          isPlaceholderValue(match.slice(match.search(/[:=]/) + 1))) {
        return match;
      }
      redacted++;
      labels.push(rule.label);
      return '[REDACTED:' + rule.label + ']';
    });
  }
  return { text: out, redacted, labels };
}

/** 命中条数按严重度汇总，调用方拼文案用 */
function tally(findings) {
  const out = { error: 0, warning: 0 };
  for (const f of findings) {
    if (out[f.severity] !== undefined) out[f.severity]++;
  }
  return out;
}

module.exports = {
  SECRET_RULES,
  scanText,
  redactText,
  tally,
  isPlaceholderValue,
  passesLuhn,
  mask,
};
