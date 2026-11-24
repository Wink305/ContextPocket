'use strict';

/**
 * ContextPocket shared MCP stdio runtime
 *
 * quan 与 yuan 的工具定义必须分开，但 JSON-RPC 传输层不该各写一份：
 *   - 换行分隔的 JSON-RPC（MCP 规范，不是 LSP 的 Content-Length）
 *   - initialize / protocolVersion 协商
 *   - ping / tools/list / tools/call / 通知 / 批量
 *   - 错误封套与 parse error
 *
 * 工具 schema、tool dispatch、业务错误仍留在各自的 server 里。parse cache 也
 * 由 server 在启动前显式开启，runtime 不替它做决定。
 *
 * 零依赖，Node.js 14+。
 */

// 从新到老：客户端协商时优先落在它请求的版本上
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * 创建一个 runtime。`write` 可注入，方便单测不碰 stdout。
 *
 * @param {object} options
 * @param {string} options.name serverInfo.name
 * @param {string} options.version serverInfo.version
 * @param {object[]} options.tools tools/list 返回的工具定义
 * @param {(name: string, args: object) => object} options.callTool 返回 MCP result
 * @param {string} [options.instructions] initialize 的 instructions
 * @param {(message: object) => void} [options.write] 默认写 stdout 一行
 */
function createRuntime(options) {
  const name = options.name;
  const version = options.version || '0.0.0';
  const tools = Array.isArray(options.tools) ? options.tools : [];
  const callTool = options.callTool;
  const instructions = options.instructions;
  const write = options.write || ((message) => {
    // 单行写出：JSON.stringify 不会产出裸换行，天然满足分帧要求
    process.stdout.write(JSON.stringify(message) + '\n');
  });

  function send(message) {
    write(message);
  }

  function sendResponse(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function sendError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function handleInitialize(id, params) {
    const requested = params && params.protocolVersion;
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;

    const result = {
      protocolVersion: negotiated,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: { name, version },
    };
    if (instructions) result.instructions = instructions;
    sendResponse(id, result);
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      sendError((msg && msg.id) || null, -32600, 'Invalid Request: jsonrpc version mismatch');
      return;
    }

    // 通知（无 id）不应有回应
    if (msg.id === undefined || msg.id === null) return;

    switch (msg.method) {
      case 'initialize':
        handleInitialize(msg.id, msg.params || {});
        break;
      case 'ping':
        sendResponse(msg.id, {});
        break;
      case 'tools/list':
        sendResponse(msg.id, { tools });
        break;
      case 'tools/call': {
        const params = msg.params || {};
        const toolName = params.name;
        const args = params.arguments || {};
        let result;
        try {
          result = callTool(toolName, args);
        } catch (e) {
          // tool 自己通常会捕获业务错误；这里兜底，保证 stdio 进程不会因为
          // 一个未捕获异常把整条 JSON-RPC 连接留在半开状态。
          result = {
            content: [{ type: 'text', text: 'Error: ' + e.message }],
            isError: true,
          };
        }
        sendResponse(msg.id, result);
        break;
      }
      default:
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  function handleLine(line) {
    const trimmed = String(line === undefined || line === null ? '' : line).trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (e) {
      sendError(null, -32700, 'Parse error: ' + e.message);
      return;
    }

    // JSON-RPC 批量：规范允许数组，逐个处理
    if (Array.isArray(message)) {
      for (const item of message) handleMessage(item);
      return;
    }
    handleMessage(message);
  }

  return {
    handleLine,
    handleMessage,
    send,
    sendResponse,
    sendError,
    protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  };
}

/**
 * 接上 stdin，开始服务。
 * @param {object} options 同 createRuntime
 * @returns {object} runtime
 */
function startServer(options) {
  const runtime = createRuntime(options);
  let pending = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    let idx;
    while ((idx = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      runtime.handleLine(line);
    }
  });

  process.stdin.on('end', () => {
    // 处理最后没有换行符的一行
    if (pending.trim()) runtime.handleLine(pending);
    pending = '';
  });

  return runtime;
}

module.exports = {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  createRuntime,
  startServer,
};
