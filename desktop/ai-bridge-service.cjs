'use strict';

// Local MCP Streamable HTTP server for the StageForge desktop AI bridge.
// Runs in the Electron main process, bound strictly to 127.0.0.1, off by default,
// with per-enable random bearer token, Origin/Host/body/rate/concurrency guards,
// exact 26-tool allowlist, and main-process output-interlock coordination.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  AI_BRIDGE_RESOURCES,
  AI_BRIDGE_TOOL_MAP,
  AI_BRIDGE_TOOLS,
  validateToolArguments,
} = require('./ai-bridge-tools.cjs');

const DEFAULT_PORT = 47821;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const MAX_CONNECTIONS = 16;
const MAX_ACTIVE_HTTP = 8;
const MAX_SESSIONS = 8;
const SESSION_IDLE_MS = 10 * 60 * 1000;
const MAX_INFLIGHT_TOOLS = 4;
const RATE_LIMIT_PER_SEC = 20;
const RATE_WINDOW_MS = 1000;
const CAPTURE_MIN_INTERVAL_MS = 1000;
const CAPTURE_MAX_BYTES = 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 5000;
const TOOL_TIMEOUT_MS = 10_000;
const CAPTURE_TIMEOUT_MS = 5000;
const QUIESCE_TIMEOUT_MS = 1500;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;

function loadMcpSdk(options = {}) {
  if (options.sdk) return options.sdk;
  const bundledPath = path.join(__dirname, 'mcp-sdk.cjs');
  if (fs.existsSync(bundledPath)) {
    return require(bundledPath);
  }
  if (options.isPackaged) {
    throw new Error('Bundled MCP SDK (mcp-sdk.cjs) is missing from the packaged desktop app.');
  }
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const types = require('@modelcontextprotocol/sdk/types.js');
  return {
    Server,
    StreamableHTTPServerTransport,
    ListToolsRequestSchema: types.ListToolsRequestSchema,
    CallToolRequestSchema: types.CallToolRequestSchema,
    ListResourcesRequestSchema: types.ListResourcesRequestSchema,
    ReadResourceRequestSchema: types.ReadResourceRequestSchema,
    McpError: types.McpError,
    ErrorCode: types.ErrorCode,
  };
}

function loadCanonicalShowSchema() {
  const preparedPath = path.join(__dirname, 'show-v9.schema.json');
  if (fs.existsSync(preparedPath)) {
    return fs.readFileSync(preparedPath, 'utf8');
  }
  const sourcePath = path.resolve(__dirname, '..', 'src', 'schemas', 'show-v9.schema.json');
  return fs.readFileSync(sourcePath, 'utf8');
}

function defaultMonotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function sha256Buf(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest();
}

function timingSafeTokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || !b.length) return false;
  return crypto.timingSafeEqual(sha256Buf(a), sha256Buf(b));
}

function getRawHeaderValues(rawHeaders, lowerName) {
  const out = [];
  if (!Array.isArray(rawHeaders)) return out;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === lowerName) {
      out.push(String(rawHeaders[i + 1]));
    }
  }
  return out;
}

function writeJsonResponse(res, statusCode, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function readBoundedJsonBody(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const parsedLen = Number(declared);
      if (!Number.isInteger(parsedLen) || parsedLen < 0) {
        reject(Object.assign(new Error('Invalid Content-Length header.'), { httpStatus: 400 }));
        return;
      }
      if (parsedLen > maxBytes) {
        reject(Object.assign(new Error(`Request body exceeds ${maxBytes} byte limit.`), { httpStatus: 413 }));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error('Request body timed out.'), { httpStatus: 408 }));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    function cleanup() {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    }

    function onData(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        reject(Object.assign(new Error(`Request body exceeds ${maxBytes} byte limit.`), { httpStatus: 413 }));
        return;
      }
      chunks.push(buf);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      if (total === 0) {
        reject(Object.assign(new Error('Empty JSON-RPC body.'), { httpStatus: 400 }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON in request body.'), { httpStatus: 400 }));
        return;
      }
      if (Array.isArray(parsed)) {
        reject(Object.assign(new Error('JSON-RPC batch requests are not supported.'), { httpStatus: 400 }));
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        reject(Object.assign(new Error('JSON-RPC request must be an object.'), { httpStatus: 400 }));
        return;
      }
      resolve(parsed);
    }

    function onError(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error(err?.message || 'Stream error reading request body.'), { httpStatus: 400 }));
    }

    function onAborted() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error('Request aborted by client.'), { httpStatus: 400 }));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function createAiBridgeService(options = {}) {
  let sdk = options.sdk || null;
  let schemaText = typeof options.schemaText === 'string' ? options.schemaText : null;
  const interlock = options.interlock || null;
  const allowZeroPort = Boolean(options.allowZeroPort);
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : defaultMonotonicMs;
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const dispatchToRenderer = typeof options.dispatchToRenderer === 'function' ? options.dispatchToRenderer : null;
  const onQuiesceWait = typeof options.onQuiesceWait === 'function' ? options.onQuiesceWait : null;
  const toolTimeoutMs = Number.isFinite(options.toolTimeoutMs) ? options.toolTimeoutMs : TOOL_TIMEOUT_MS;
  const captureTimeoutMs = Number.isFinite(options.captureTimeoutMs) ? options.captureTimeoutMs : CAPTURE_TIMEOUT_MS;
  const captureMinIntervalMs = Number.isFinite(options.captureMinIntervalMs)
    ? options.captureMinIntervalMs
    : CAPTURE_MIN_INTERVAL_MS;
  const rateLimitPerSec = Number.isFinite(options.rateLimitPerSec) ? options.rateLimitPerSec : RATE_LIMIT_PER_SEC;
  const maxInflightTools = Number.isFinite(options.maxInflightTools) ? options.maxInflightTools : MAX_INFLIGHT_TOOLS;

  let state = 'off'; // 'off' | 'starting' | 'on' | 'stopping'
  let generation = 0;
  let ownerId = null;
  let server = null;
  let boundPort = null;
  let token = null;
  let lastError = null;

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  /** @type {Map<string, { server: any, transport: any, generation: number, lastUsedMs: number, activeCount: number, sessionId: string | null }>} */
  const sessions = new Map();
  let initializingSessions = 0;
  /** @type {Map<string, { resolve: Function, reject: Function, timer: any, ownerId: number, generation: number, tool: string }>} */
  const pendingCalls = new Map();
  /** @type {number[]} */
  let rateTimestamps = [];
  let activeHttpRequests = 0;
  let activeToolCalls = 0;
  let captureInFlight = false;
  let lastCaptureStartMs = -Infinity;
  let quiesceResolvers = [];

  function getStatus(includeToken = true) {
    return {
      enabled: state === 'on',
      state,
      generation,
      port: state === 'on' ? boundPort : null,
      url: state === 'on' && boundPort ? `http://127.0.0.1:${boundPort}/mcp` : null,
      token: includeToken && state === 'on' ? token : null,
      activeSessions: sessions.size,
      activeToolCalls,
      lastError,
    };
  }

  function emitStatus(targetOwnerId) {
    const target = targetOwnerId !== undefined ? targetOwnerId : ownerId;
    onStatus(getStatus(true), target);
  }

  function admitRateLimit() {
    const now = nowMs();
    const cutoff = now - RATE_WINDOW_MS;
    if (rateTimestamps.length > 0 && rateTimestamps[rateTimestamps.length - 1] > now) {
      // Guard against backwards synthetic clocks in tests
      rateTimestamps = [];
    }
    let keepFrom = 0;
    while (keepFrom < rateTimestamps.length && rateTimestamps[keepFrom] <= cutoff) {
      keepFrom++;
    }
    if (keepFrom > 0) rateTimestamps.splice(0, keepFrom);
    if (rateTimestamps.length >= rateLimitPerSec) {
      return false;
    }
    rateTimestamps.push(now);
    return true;
  }

  function pruneIdleSessions() {
    const now = nowMs();
    for (const [sid, entry] of sessions.entries()) {
      if (entry.activeCount === 0 && now - entry.lastUsedMs >= SESSION_IDLE_MS) {
        sessions.delete(sid);
        void Promise.resolve(entry.transport.close()).catch(() => {});
      }
    }
  }

  function callRenderer(toolName, args, expectedGen, signal) {
    if (!dispatchToRenderer) {
      return Promise.reject(new Error('Renderer bridge is not attached.'));
    }
    if (state !== 'on' || generation !== expectedGen || ownerId === null) {
      return Promise.reject(new Error('AI bridge is no longer enabled.'));
    }
    if (signal && signal.aborted) {
      return Promise.reject(new Error('Request was cancelled.'));
    }

    const requestId = crypto.randomUUID();
    const timeout = toolName === 'capture_frame' ? captureTimeoutMs : toolTimeoutMs;
    const deadlineMs = Date.now() + timeout;
    const targetOwnerId = ownerId;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        pendingCalls.delete(requestId);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = () => {
        finish(new Error('Tool call cancelled by client.'));
      };
      const timer = setTimeout(() => {
        finish(new Error(`Tool "${toolName}" timed out after ${Math.round(timeout / 1000)} s.`));
      }, timeout);
      if (timer.unref) timer.unref();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      pendingCalls.set(requestId, {
        resolve: (value) => finish(null, value),
        reject: (err) => finish(err instanceof Error ? err : new Error(String(err))),
        timer,
        ownerId: targetOwnerId,
        generation: expectedGen,
        tool: toolName,
      });

      try {
        dispatchToRenderer({
          requestId,
          bridgeGeneration: expectedGen,
          deadlineMs,
          tool: toolName,
          arguments: args,
        }, targetOwnerId);
      } catch (err) {
        finish(err instanceof Error ? err : new Error('Failed to send tool call to renderer.'));
      }
    });
  }

  function handleRendererReply(reply, senderId) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return false;
    const { requestId, bridgeGeneration, ok, result, error } = reply;
    if (typeof requestId !== 'string') return false;
    const entry = pendingCalls.get(requestId);
    if (!entry) return false;
    if (senderId !== entry.ownerId) return false;
    if (bridgeGeneration !== entry.generation || bridgeGeneration !== generation) {
      entry.reject(new Error('AI bridge generation changed before reply arrived.'));
      return false;
    }
    try {
      const approxBytes = Buffer.byteLength(JSON.stringify(ok ? result : error ?? ''), 'utf8');
      if (approxBytes > MAX_REPLY_BYTES) {
        entry.reject(new Error('Renderer reply exceeded size limit.'));
        return false;
      }
    } catch {
      entry.reject(new Error('Renderer reply was not serializable.'));
      return false;
    }
    if (ok) {
      entry.resolve(result);
    } else {
      entry.reject(new Error(typeof error === 'string' && error ? error : 'Tool call failed.'));
    }
    return true;
  }

  function markRendererQuiesced(senderId, gen) {
    if (typeof gen !== 'number' || gen !== generation) return false;
    if (ownerId !== null && senderId !== ownerId) return false;
    const waiters = quiesceResolvers;
    quiesceResolvers = [];
    for (const resolve of waiters) resolve(true);
    return true;
  }

  function buildMcpSession(sessionGen) {
    const mcpServer = new sdk.Server(
      { name: 'stageforge-ai-bridge', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {} } },
    );

    mcpServer.setRequestHandler(sdk.ListToolsRequestSchema, async () => {
      if (state !== 'on' || generation !== sessionGen) {
        throw new sdk.McpError(sdk.ErrorCode.InvalidRequest, 'AI bridge session is no longer active.');
      }
      return {
        tools: AI_BRIDGE_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    });

    mcpServer.setRequestHandler(sdk.ListResourcesRequestSchema, async () => {
      if (state !== 'on' || generation !== sessionGen) {
        throw new sdk.McpError(sdk.ErrorCode.InvalidRequest, 'AI bridge session is no longer active.');
      }
      return { resources: [...AI_BRIDGE_RESOURCES] };
    });

    mcpServer.setRequestHandler(sdk.ReadResourceRequestSchema, async (request) => {
      if (state !== 'on' || generation !== sessionGen) {
        throw new sdk.McpError(sdk.ErrorCode.InvalidRequest, 'AI bridge session is no longer active.');
      }
      const uri = request?.params?.uri;
      if (uri !== 'stageforge://schema/show') {
        throw new sdk.McpError(sdk.ErrorCode.InvalidParams, `Unknown resource URI "${String(uri)}".`);
      }
      return {
        contents: [
          {
            uri: 'stageforge://schema/show',
            mimeType: 'application/schema+json',
            text: schemaText,
          },
        ],
      };
    });

    mcpServer.setRequestHandler(sdk.CallToolRequestSchema, async (request, extra) => {
      if (state !== 'on' || generation !== sessionGen) {
        throw new sdk.McpError(sdk.ErrorCode.InvalidRequest, 'AI bridge session is no longer active.');
      }
      const toolName = request?.params?.name;
      // Server-side exact allowlist enforcement (independent of tools/list).
      if (typeof toolName !== 'string' || !AI_BRIDGE_TOOL_MAP.has(toolName)) {
        throw new sdk.McpError(sdk.ErrorCode.MethodNotFound, `Tool "${String(toolName)}" is not allowed.`);
      }

      const validation = validateToolArguments(toolName, request?.params?.arguments);
      if (!validation.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: validation.error }],
        };
      }

      // Main serves the canonical latest schema directly.
      if (toolName === 'get_schema') {
        return {
          content: [{ type: 'text', text: schemaText }],
        };
      }

      if (activeToolCalls >= maxInflightTools) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'AI bridge is busy (too many concurrent tool calls); retry shortly.' }],
        };
      }

      const isCapture = toolName === 'capture_frame';
      if (isCapture) {
        const now = nowMs();
        if (captureInFlight || now - lastCaptureStartMs < captureMinIntervalMs) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'capture_frame is rate-limited to at most 1 capture per second.' }],
          };
        }
        captureInFlight = true;
        lastCaptureStartMs = now;
      }

      activeToolCalls++;
      try {
        const result = await callRenderer(toolName, validation.args, sessionGen, extra?.signal);
        // Re-check generation after awaiting renderer reply.
        if (state !== 'on' || generation !== sessionGen) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'AI bridge was disabled while the request was in flight.' }],
          };
        }

        if (isCapture) {
          if (
            !result ||
            typeof result !== 'object' ||
            typeof result.base64 !== 'string' ||
            !result.base64.startsWith('/9j/') ||
            typeof result.width !== 'number' ||
            result.width <= 0 ||
            result.width > 1280
          ) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'Viewport capture failed to produce a valid JPEG image.' }],
            };
          }
          const decodedBytes = Buffer.from(result.base64, 'base64');
          if (decodedBytes.byteLength === 0 || decodedBytes.byteLength > CAPTURE_MAX_BYTES) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'Captured JPEG exceeded size limit.' }],
            };
          }
          if (decodedBytes[0] !== 0xff || decodedBytes[1] !== 0xd8 || decodedBytes[2] !== 0xff) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'Captured image failed JPEG magic-byte verification.' }],
            };
          }
          return {
            content: [
              {
                type: 'image',
                data: result.base64,
                mimeType: 'image/jpeg',
              },
            ],
          };
        }

        const isToolError = Boolean(result && typeof result === 'object' && result.isError === true);
        if (isToolError && typeof result.message === 'string') {
          return {
            isError: true,
            content: [{ type: 'text', text: result.message }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'Tool call failed.' }],
        };
      } finally {
        activeToolCalls = Math.max(0, activeToolCalls - 1);
        if (isCapture) captureInFlight = false;
      }
    });

    const entry = {
      server: mcpServer,
      transport: null,
      generation: sessionGen,
      lastUsedMs: nowMs(),
      activeCount: 0,
      sessionId: null,
    };

    const transport = new sdk.StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        if (state === 'on' && generation === sessionGen) {
          entry.sessionId = sessionId;
          sessions.set(sessionId, entry);
        }
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    entry.transport = transport;
    return entry;
  }

  async function handleHttpRequest(req, res) {
    const reqGen = generation;
    const reqUrl = String(req.url || '');
    const pathname = reqUrl.split('?')[0];

    // 1. Path admission (never advertise OAuth metadata)
    if (pathname.startsWith('/.well-known/')) {
      writeJsonResponse(res, 404, { error: 'Not found' });
      return;
    }
    if (pathname !== '/mcp') {
      writeJsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    // 2. Method admission
    const method = String(req.method || '').toUpperCase();
    if (method !== 'POST' && method !== 'DELETE') {
      writeJsonResponse(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, DELETE' });
      return;
    }

    // 3. Raw header security checks (Origin & Host) BEFORE body read
    const originHeaders = getRawHeaderValues(req.rawHeaders, 'origin');
    if (originHeaders.length > 0) {
      writeJsonResponse(res, 403, { error: 'Origin header is not allowed on the local AI bridge.' });
      return;
    }

    const hostHeaders = getRawHeaderValues(req.rawHeaders, 'host');
    if (hostHeaders.length !== 1) {
      writeJsonResponse(res, 403, { error: 'Invalid Host header.' });
      return;
    }
    const normalizedHost = hostHeaders[0].trim().toLowerCase();
    const expectedLocalIp = `127.0.0.1:${boundPort}`;
    const expectedLocalhost = `localhost:${boundPort}`;
    if (normalizedHost !== expectedLocalIp && normalizedHost !== expectedLocalhost) {
      writeJsonResponse(res, 403, { error: 'Host header rejected (DNS rebinding protection).' });
      return;
    }

    // 4. Global rate limit (counts unauthenticated requests to stop brute-force probing)
    if (!admitRateLimit()) {
      writeJsonResponse(res, 429, { error: 'Rate limit exceeded (max 20 requests/second).' }, { 'Retry-After': '1' });
      return;
    }

    // 5. Bearer token authentication (constant-time, no OAuth WWW-Authenticate header)
    const authHeaders = getRawHeaderValues(req.rawHeaders, 'authorization');
    if (authHeaders.length !== 1) {
      writeJsonResponse(res, 401, { error: 'Unauthorized: missing Bearer token.' });
      return;
    }
    const authMatch = /^Bearer\s+(\S+)$/.exec(authHeaders[0].trim());
    if (!authMatch || !token || !timingSafeTokenEquals(authMatch[1], token)) {
      writeJsonResponse(res, 401, { error: 'Unauthorized: invalid or expired Bearer token.' });
      return;
    }

    if (state !== 'on' || generation !== reqGen) {
      writeJsonResponse(res, 503, { error: 'AI bridge is shutting down.' });
      return;
    }

    if (activeHttpRequests >= MAX_ACTIVE_HTTP) {
      writeJsonResponse(res, 503, { error: 'Too many concurrent HTTP requests.' });
      return;
    }

    activeHttpRequests++;
    let sessionEntry = null;
    try {
      const encodingHeaders = getRawHeaderValues(req.rawHeaders, 'content-encoding');
      if (encodingHeaders.some((v) => v.trim().toLowerCase() !== 'identity')) {
        writeJsonResponse(res, 415, { error: 'Unsupported Content-Encoding.' });
        return;
      }

      const sidHeaders = getRawHeaderValues(req.rawHeaders, 'mcp-session-id');
      if (sidHeaders.length > 1) {
        writeJsonResponse(res, 400, { error: 'Duplicate Mcp-Session-Id header.' });
        return;
      }
      const sid = sidHeaders.length === 1 ? sidHeaders[0].trim() : null;

      if (method === 'DELETE') {
        if (!sid) {
          writeJsonResponse(res, 400, { error: 'Missing Mcp-Session-Id header.' });
          return;
        }
        const existing = sessions.get(sid);
        if (!existing || existing.generation !== reqGen) {
          writeJsonResponse(res, 404, { error: 'Unknown MCP session.' });
          return;
        }
        sessions.delete(sid);
        await existing.transport.close();
        if (!res.writableEnded) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
        }
        return;
      }

      // POST
      const ctHeaders = getRawHeaderValues(req.rawHeaders, 'content-type');
      if (ctHeaders.length !== 1 || !ctHeaders[0].toLowerCase().split(';')[0].trim().endsWith('application/json')) {
        writeJsonResponse(res, 415, { error: 'Content-Type must be application/json.' });
        return;
      }

      let parsedBody;
      try {
        parsedBody = await readBoundedJsonBody(req, MAX_BODY_BYTES, BODY_READ_TIMEOUT_MS);
      } catch (err) {
        const status = Number.isInteger(err?.httpStatus) ? err.httpStatus : 400;
        writeJsonResponse(res, status, { error: err instanceof Error ? err.message : 'Invalid request body.' });
        return;
      }

      // Re-check bridge generation after async body read.
      if (state !== 'on' || generation !== reqGen) {
        writeJsonResponse(res, 503, { error: 'AI bridge was disabled.' });
        return;
      }

      pruneIdleSessions();

      let isNewSession = false;
      if (sid) {
        sessionEntry = sessions.get(sid) || null;
        if (!sessionEntry || sessionEntry.generation !== reqGen) {
          writeJsonResponse(res, 404, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found or expired. Re-run initialize.' },
            id: parsedBody.id ?? null,
          });
          return;
        }
      } else {
        if (parsedBody.method !== 'initialize') {
          writeJsonResponse(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Missing Mcp-Session-Id header (call initialize first).' },
            id: parsedBody.id ?? null,
          });
          return;
        }
        // Atomic session cap check including concurrent in-flight initialize attempts (L3).
        if (sessions.size + initializingSessions >= MAX_SESSIONS) {
          writeJsonResponse(res, 503, {
            jsonrpc: '2.0',
            error: { code: -32000, message: `Maximum concurrent MCP sessions (${MAX_SESSIONS}) reached.` },
            id: parsedBody.id ?? null,
          });
          return;
        }
        isNewSession = true;
        initializingSessions++;
        try {
          sessionEntry = buildMcpSession(reqGen);
          await sessionEntry.server.connect(sessionEntry.transport);
        } catch (connectErr) {
          initializingSessions = Math.max(0, initializingSessions - 1);
          if (sessionEntry?.transport) {
            void Promise.resolve(sessionEntry.transport.close()).catch(() => {});
          }
          throw connectErr;
        }
      }

      sessionEntry.activeCount++;
      sessionEntry.lastUsedMs = nowMs();
      try {
        await sessionEntry.transport.handleRequest(req, res, parsedBody);
      } finally {
        sessionEntry.activeCount = Math.max(0, sessionEntry.activeCount - 1);
        sessionEntry.lastUsedMs = nowMs();
        if (isNewSession) {
          initializingSessions = Math.max(0, initializingSessions - 1);
          // Reap failed/unregistered initialize Server+transport pairs immediately (L3).
          if (!sessionEntry.sessionId || !sessions.has(sessionEntry.sessionId)) {
            void Promise.resolve(sessionEntry.transport.close()).catch(() => {});
          }
        }
      }
    } catch (err) {
      if (!res.writableEnded && !res.destroyed) {
        writeJsonResponse(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal AI bridge error.' },
          id: null,
        });
      }
    } finally {
      activeHttpRequests = Math.max(0, activeHttpRequests - 1);
    }
  }

  async function enable(config = {}, targetOwnerId = 0) {
    const rawPort = config.port !== undefined ? config.port : DEFAULT_PORT;
    const isZeroAllowed = allowZeroPort && rawPort === 0;
    if (!isZeroAllowed && (!Number.isInteger(rawPort) || rawPort < MIN_PORT || rawPort > MAX_PORT)) {
      throw new Error(`Port must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
    }

    // Lazy-load the MCP SDK and canonical schema on first enable so boot has zero overhead
    // and a missing bundle cannot crash Electron app.whenReady() (M5).
    try {
      if (!sdk) sdk = loadMcpSdk(options);
      if (schemaText === null) schemaText = loadCanonicalShowSchema();
    } catch (loadErr) {
      const msg = loadErr instanceof Error ? loadErr.message : 'AI bridge MCP SDK is unavailable.';
      lastError = msg;
      emitStatus(targetOwnerId);
      throw new Error(msg);
    }

    if (interlock) {
      const check = interlock.tryBeginBridgeStart(targetOwnerId);
      if (!check.ok) {
        throw new Error(check.reason);
      }
    } else if (state !== 'off') {
      throw new Error('AI bridge is already enabled or changing state.');
    }

    state = 'starting';
    ownerId = targetOwnerId;
    lastError = null;
    generation++;
    const startGen = generation;
    const freshToken = crypto.randomBytes(32).toString('base64url');
    const localSockets = new Set();

    const httpServer = http.createServer((req, res) => {
      void handleHttpRequest(req, res);
    });
    httpServer.maxConnections = MAX_CONNECTIONS;
    httpServer.headersTimeout = 5000;
    httpServer.requestTimeout = 15_000;
    httpServer.keepAliveTimeout = 5000;
    httpServer.on('upgrade', (_req, socket) => {
      socket.destroy();
    });
    httpServer.on('connect', (_req, socket) => {
      socket.destroy();
    });
    httpServer.on('connection', (socket) => {
      localSockets.add(socket);
      sockets.add(socket);
      socket.once('close', () => {
        localSockets.delete(socket);
        sockets.delete(socket);
      });
    });

    try {
      await new Promise((resolve, reject) => {
        const onErr = (err) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onErr);
          resolve();
        };
        httpServer.once('error', onErr);
        httpServer.once('listening', onListening);
        httpServer.listen({ host: '127.0.0.1', port: rawPort, exclusive: true });
      });

      // Check if disable() raced while bind was pending.
      if (state !== 'starting' || generation !== startGen) {
        try { httpServer.close(); } catch { /* ignore */ }
        for (const s of [...localSockets]) { try { s.destroy(); } catch { /* ignore */ } }
        localSockets.clear();
        throw new Error('AI bridge startup was cancelled.');
      }

      const addr = httpServer.address();
      if (!addr || typeof addr !== 'object' || !addr.port) {
        throw new Error('Failed to determine bound loopback port.');
      }

      server = httpServer;
      boundPort = addr.port;
      token = freshToken;
      state = 'on';
      rateTimestamps = [];
      lastCaptureStartMs = -Infinity;
      if (interlock) interlock.markBridgeOn(targetOwnerId);
      emitStatus(targetOwnerId);
      return getStatus(true);
    } catch (err) {
      try { httpServer.close(); } catch { /* ignore */ }
      for (const s of [...localSockets]) { try { s.destroy(); } catch { /* ignore */ } }
      localSockets.clear();
      const msg = err && err.code === 'EADDRINUSE'
        ? `Port ${rawPort} is already in use on 127.0.0.1. Choose another port.`
        : (err instanceof Error ? err.message : 'Could not start AI bridge server.');
      // Only clear shared bridge state & interlock if no newer disable/enable superseded this start (L1).
      if (generation === startGen) {
        server = null;
        boundPort = null;
        token = null;
        lastError = msg;
        state = 'off';
        ownerId = null;
        if (interlock) interlock.finishBridgeStop();
        emitStatus(targetOwnerId);
      }
      throw new Error(msg);
    }
  }

  async function disable(reason = 'disable', opts = {}) {
    if (state === 'off') {
      return getStatus(false);
    }
    const prevOwnerId = ownerId;
    state = 'stopping';
    generation++;
    const stopGen = generation;
    token = null;
    boundPort = null;
    if (interlock) interlock.beginBridgeStop();

    // Immediately cancel all in-flight renderer RPCs.
    for (const [reqId, entry] of [...pendingCalls.entries()]) {
      pendingCalls.delete(reqId);
      entry.reject(new Error(`AI bridge stopped (${reason}).`));
    }

    // Notify renderer so it cancels queued work, clears proposals, and turns off auto-accept.
    emitStatus(prevOwnerId);

    // Close all MCP sessions.
    const closingSessions = [...sessions.values()];
    sessions.clear();
    await Promise.all(
      closingSessions.map((entry) => Promise.resolve(entry.transport.close()).catch(() => {})),
    );

    // Close HTTP server and destroy all open sockets.
    const srv = server;
    server = null;
    for (const sock of [...sockets]) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
    if (srv) {
      await new Promise((resolve) => {
        try {
          if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    // Wait briefly for renderer quiescence ack when owner is still alive (never block forever).
    const skipQuiesce = Boolean(opts.skipQuiesceWait || !onQuiesceWait);
    if (!skipQuiesce && prevOwnerId !== null && onQuiesceWait(prevOwnerId, stopGen)) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, QUIESCE_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        quiesceResolvers.push(finish);
      });
    }
    quiesceResolvers = [];

    if (generation === stopGen) {
      state = 'off';
      ownerId = null;
      rateTimestamps = [];
      activeToolCalls = 0;
      captureInFlight = false;
      if (interlock) interlock.finishBridgeStop();
      emitStatus(prevOwnerId);
    }
    return getStatus(false);
  }

  return {
    get active() { return state !== 'off'; },
    get state() { return state; },
    get ownerId() { return ownerId; },
    get generation() { return generation; },
    get port() { return boundPort; },
    getStatus,
    enable,
    disable,
    handleRendererReply,
    markRendererQuiesced,
  };
}

module.exports = {
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  MAX_CONNECTIONS,
  MAX_SESSIONS,
  MAX_INFLIGHT_TOOLS,
  RATE_LIMIT_PER_SEC,
  createAiBridgeService,
};
