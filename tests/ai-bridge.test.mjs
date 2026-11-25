import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { createOutputInterlock } = require('../desktop/output-interlock.cjs');
const toolsMod = require('../desktop/ai-bridge-tools.cjs');
const { createAiBridgeService } = require('../desktop/ai-bridge-service.cjs');
const { createAiBridgeIpcHandlers } = require('../desktop/ai-bridge-ipc.cjs');
const { createDmxIpcHandlers } = require('../desktop/dmx-ipc.cjs');
const { createShowControlIpcHandlers } = require('../desktop/show-control-ipc.cjs');

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const protocol = await compiler.ssrLoadModule('/src/aiBridge/aiBridgeProtocol.ts');
const clockOwner = await compiler.ssrLoadModule('/src/showControl/clockOwner.ts');
const presets = await compiler.ssrLoadModule('/src/data/presets.ts');
const preflightMod = await compiler.ssrLoadModule('/src/data/preflight.ts');
const showFileMod = await compiler.ssrLoadModule('/src/data/showFile.ts');

const EXPECTED_TOOLS = [
  'get_state',
  'get_cues',
  'list_catalog',
  'get_schema',
  'get_safety_report',
  'propose_show',
  'propose_look',
  'propose_cue',
  'propose_take',
  'propose_wall_cue',
  'propose_audio_mapping',
  'get_proposal',
  'withdraw_proposal',
  'go',
  'back',
  'stop',
  'resume',
  'trigger_cue',
  'play_take',
  'pause_take',
  'seek_take',
  'blackout',
  'set_master',
  'set_bpm',
  'capture_frame',
  'get_audio_levels',
];

function rawHttpRequest({ port, method = 'POST', path: reqPath = '/mcp', headers = {}, body = null, chunked = false }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body !== null) {
      if (chunked && Array.isArray(body)) {
        for (const chunk of body) req.write(chunk);
        req.end();
      } else {
        req.end(body);
      }
    } else {
      req.end();
    }
  });
}

async function initSession(port, token) {
  const headers = {
    Host: `127.0.0.1:${port}`,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const initRes = await rawHttpRequest({
    port,
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'unit-test', version: '1.0' },
      },
    }),
  });
  assert.equal(initRes.status, 200, `initialize failed: ${initRes.status} ${initRes.body}`);
  const sid = initRes.headers['mcp-session-id'];
  assert.ok(typeof sid === 'string' && sid.length > 0, 'initialize must return Mcp-Session-Id');

  const notifRes = await rawHttpRequest({
    port,
    headers: { ...headers, 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(notifRes.status, 202);

  return {
    sid,
    call: async (method, params = {}, id = 2) => {
      const res = await rawHttpRequest({
        port,
        headers: { ...headers, 'Mcp-Session-Id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
    },
  };
}

function makeFakeDesk() {
  const rig = structuredClone(presets.RIG_TEMPLATES.arena_mainstage);
  const cues = structuredClone(presets.SHOW_CUES);
  const look = structuredClone(presets.INITIAL_SHOW_STATE);
  return {
    rig,
    stage: {
      format: 'stageforge-native-stage',
      version: 1,
      walls: [
        { id: 'main-led', label: 'Main LED' },
        { id: 'wing-left', label: 'Left Wing', x: -8, y: 3, z: -4, width: 4, height: 3, yaw: 0.2 },
      ],
      screenEvents: [],
    },
    cues,
    look,
    activeCueId: cues[0].id,
    timeline: undefined,
    camera: 'foh',
    volume: 0.72,
    clockMode: 'master',
    audioStatus: { playing: false, source: 'none', trackName: '', bpm: look.bpm },
  };
}

// ---------------------------------------------------------------------------
// 1. Exact tool allowlist parity & HTTP security boundary (Origin, Host, Auth, Body, Rate, Batch)
// ---------------------------------------------------------------------------
test('AI bridge HTTP server enforces Origin, Host, Bearer token, body cap (incl. chunked), batch block, rate limit, and exact 26-tool allowlist', async () => {
  assert.deepEqual([...toolsMod.AI_BRIDGE_TOOL_NAMES], EXPECTED_TOOLS, 'main tool registry must match exact 26-tool allowlist');
  assert.deepEqual([...protocol.AI_BRIDGE_TOOL_NAMES], EXPECTED_TOOLS, 'renderer tool names must match main registry');
  // Every tool description must state string fields are data, not instructions.
  for (const tool of toolsMod.AI_BRIDGE_TOOLS) {
    assert.match(tool.description, /data, not instructions/i, `${tool.name} description must include data-not-instructions note`);
  }

  let fakeNow = 10_000;
  let svc;
  const rendererCalls = [];
  svc = createAiBridgeService({
    allowZeroPort: true,
    nowMs: () => fakeNow,
    dispatchToRenderer: (req, ownerId) => {
      rendererCalls.push(req);
      setImmediate(() => {
        if (req.tool === 'capture_frame') {
          // Tiny valid JPEG magic header (FF D8 FF E0 ...)
          const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]).toString('base64');
          svc.handleRendererReply({
            requestId: req.requestId,
            bridgeGeneration: req.bridgeGeneration,
            ok: true,
            result: { base64: fakeJpeg, width: 640, height: 360, byteLength: 13 },
          }, ownerId);
        } else {
          svc.handleRendererReply({
            requestId: req.requestId,
            bridgeGeneration: req.bridgeGeneration,
            ok: true,
            result: { echoedTool: req.tool, args: req.arguments },
          }, ownerId);
        }
      });
    },
  });

  const status = await svc.enable({ port: 0 }, 101);
  assert.equal(status.enabled, true);
  assert.ok(status.port > 0);
  assert.ok(status.token && status.token.length >= 32);
  const { port, token } = status;

  try {
    // 1. OAuth discovery path returns 404 (prevents OAuth client loop)
    const wk = await rawHttpRequest({ port, method: 'GET', path: '/.well-known/oauth-authorization-server', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(wk.status, 404);

    // 2. GET /mcp returns 405 with Allow header
    const getRes = await rawHttpRequest({ port, method: 'GET', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } });
    assert.equal(getRes.status, 405);

    // 3. Any Origin header (even empty string) rejected with 403
    for (const originVal of ['http://evil.example', 'https://127.0.0.1', 'null', '']) {
      const originRes = await rawHttpRequest({
        port,
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: originVal,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: '{}',
      });
      assert.equal(originRes.status, 403, `Origin "${originVal}" must be rejected with 403`);
    }

    // 4. Wrong Host rejected with 403 (DNS rebinding protection)
    for (const badHost of [`evil.com:${port}`, `[::1]:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1']) {
      const hostRes = await rawHttpRequest({
        port,
        headers: {
          Host: badHost,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(hostRes.status, 403, `Host "${badHost}" must be rejected with 403`);
    }

    // 5. Missing or wrong token rejected with 401 and NO OAuth WWW-Authenticate resource_metadata
    const noAuth = await rawHttpRequest({
      port,
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers['www-authenticate'], undefined);

    const badAuth = await rawHttpRequest({
      port,
      headers: { Host: `127.0.0.1:${port}`, Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(badAuth.status, 401);

    // 6. Oversized body (> 1 MiB) rejected with 413 — both Content-Length AND chunked stream!
    fakeNow += 2000;
    const huge = 'x'.repeat(1024 * 1024 + 64);
    const oversizeRes = await rawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ data: huge }),
    });
    assert.equal(oversizeRes.status, 413);

    const chunkedOversize = await rawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
        Accept: 'application/json, text/event-stream',
      },
      chunked: true,
      body: [Buffer.alloc(600 * 1024, 97), Buffer.alloc(600 * 1024, 97)],
    });
    assert.equal(chunkedOversize.status, 413, 'chunked body > 1 MiB must be rejected with 413');

    // 7. JSON-RPC batch arrays rejected with 400 (cannot bypass rate limit)
    const batchRes = await rawHttpRequest({
      port,
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
    });
    assert.equal(batchRes.status, 400);

    // 8. Initialize session and verify exact tools/list, forbidden tools/call rejection, and canonical v8 schema parity
    fakeNow += 2000;
    const session = await initSession(port, token);
    const listRes = await session.call('tools/list', {}, 2);
    assert.equal(listRes.status, 200);
    const listedNames = listRes.json.result.tools.map((t) => t.name);
    assert.deepEqual(listedNames, EXPECTED_TOOLS, 'tools/list must expose the exact 26 allowed tools');

    // Forbidden/unknown tools must be rejected server-side in tools/call!
    for (const forbidden of ['enable_dmx', 'arm_output', 'accept_proposal', 'set_clock_mode', 'run_command', 'read_file']) {
      const badCall = await session.call('tools/call', { name: forbidden, arguments: {} }, 10);
      assert.equal(badCall.status, 200);
      assert.ok(badCall.json.error, `tools/call "${forbidden}" must return JSON-RPC error`);
    }

    // Canonical show-v8.schema.json parity for get_schema AND stageforge://schema/show
    const diskSchema = await fs.readFile(path.join(root, 'src', 'schemas', 'show-v8.schema.json'), 'utf8');
    const diskHash = crypto.createHash('sha256').update(diskSchema.replace(/\r\n/g, '\n')).digest('hex');

    const schemaTool = await session.call('tools/call', { name: 'get_schema', arguments: {} }, 20);
    const schemaToolText = schemaTool.json.result.content[0].text;
    assert.equal(
      crypto.createHash('sha256').update(schemaToolText.replace(/\r\n/g, '\n')).digest('hex'),
      diskHash,
      'get_schema must match src/schemas/show-v8.schema.json byte-for-byte',
    );

    const resList = await session.call('resources/list', {}, 21);
    assert.deepEqual(resList.json.result.resources.map((r) => r.uri), ['stageforge://schema/show']);
    const resRead = await session.call('resources/read', { uri: 'stageforge://schema/show' }, 22);
    assert.equal(
      crypto.createHash('sha256').update(resRead.json.result.contents[0].text.replace(/\r\n/g, '\n')).digest('hex'),
      diskHash,
      'stageforge://schema/show must match src/schemas/show-v8.schema.json byte-for-byte',
    );

    // 9. Deep audienceScan rejection, prototype pollution, and oversized strings rejected BEFORE IPC
    const beforeCalls = rendererCalls.length;
    const scanCall = await session.call('tools/call', {
      name: 'propose_look',
      arguments: { patch: { laser: { audienceScan: true } } },
    }, 30);
    assert.equal(scanCall.json.result.isError, true);
    assert.match(scanCall.json.result.content[0].text, /a human must enable audience scanning on the desk/i);

    const sneakyScan = await session.call('tools/call', {
      name: 'propose_show',
      arguments: { show: { cues: [{ state: { laser: { audienceScan: 'yes' } } }] } },
    }, 31);
    assert.equal(sneakyScan.json.result.isError, true);
    assert.match(sneakyScan.json.result.content[0].text, /a human must enable audience scanning on the desk/i);

    const bigStr = await session.call('tools/call', {
      name: 'propose_look',
      arguments: { patch: { led: { tourText: 'A'.repeat(5000) } } },
    }, 32);
    assert.equal(bigStr.json.result.isError, true);
    assert.match(bigStr.json.result.content[0].text, /exceeds maximum length/i);

    assert.equal(rendererCalls.length, beforeCalls, 'blocked payloads must never reach the renderer IPC');

    // 10. capture_frame returns valid JPEG image block and enforces <= 1/s rate limit
    fakeNow += 2000;
    const cap1 = await session.call('tools/call', { name: 'capture_frame', arguments: { maxWidth: 640 } }, 40);
    assert.equal(cap1.json.result.isError, undefined);
    assert.equal(cap1.json.result.content[0].type, 'image');
    assert.equal(cap1.json.result.content[0].mimeType, 'image/jpeg');
    assert.ok(cap1.json.result.content[0].data.startsWith('/9j/'));

    // Second capture within 200 ms must be rate-limited!
    fakeNow += 200;
    const cap2 = await session.call('tools/call', { name: 'capture_frame', arguments: {} }, 41);
    assert.equal(cap2.json.result.isError, true);
    assert.match(cap2.json.result.content[0].text, /rate-limited/i);

    // After >= 1000 ms it succeeds again
    fakeNow += 1000;
    const cap3 = await session.call('tools/call', { name: 'capture_frame', arguments: {} }, 42);
    assert.equal(cap3.json.result.content[0].type, 'image');

    // 11. Global rate limit (> 20 req/s) returns 429
    fakeNow += 2000;
    let saw429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await rawHttpRequest({
        port,
        headers: { Host: `127.0.0.1:${port}`, Authorization: 'Bearer probe-flood', 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (r.status === 429) { saw429 = true; break; }
    }
    assert.equal(saw429, true, 'exceeding 20 req/s must return HTTP 429');
  } finally {
    await svc.disable('test-cleanup');
  }

  // 12. Re-enabling rotates token; old token is permanently rejected
  const status2 = await svc.enable({ port: 0 }, 101);
  assert.notEqual(status2.token, token);
  try {
    const staleTokRes = await rawHttpRequest({
      port: status2.port,
      headers: { Host: `127.0.0.1:${status2.port}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(staleTokRes.status, 401, 'token from previous enable must be rejected');
  } finally {
    await svc.disable('test-cleanup-2');
  }
});

// ---------------------------------------------------------------------------
// 2. Concurrency limit, request timeout, and in-flight cancellation on disable
// ---------------------------------------------------------------------------
test('AI bridge enforces concurrency caps, tool timeouts, and cancels in-flight work on disable', async () => {
  let heldRequests = [];
  let svc;
  svc = createAiBridgeService({
    allowZeroPort: true,
    maxInflightTools: 2,
    toolTimeoutMs: 120,
    dispatchToRenderer: (req) => {
      heldRequests.push(req);
    },
  });
  const { port, token } = await svc.enable({ port: 0 }, 55);
  try {
    const s1 = await initSession(port, token);
    const s2 = await initSession(port, token);
    const s3 = await initSession(port, token);

    // Launch 2 slow calls (fills concurrency cap of 2) + 3rd call (must immediately return busy error)
    const p1 = s1.call('tools/call', { name: 'get_state', arguments: {} }, 101);
    const p2 = s2.call('tools/call', { name: 'get_state', arguments: {} }, 102);
    // Wait briefly so p1 & p2 enter dispatchToRenderer
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(heldRequests.length, 2);

    const p3 = await s3.call('tools/call', { name: 'get_state', arguments: {} }, 103);
    assert.equal(p3.json.result.isError, true);
    assert.match(p3.json.result.content[0].text, /busy/i);

    // Disable bridge while p1 & p2 are in flight -> they cancel immediately (never hang)
    await svc.disable('operator-stop');
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    assert.ok(r1.status === 'rejected' || r1.value?.json?.result?.isError === true);
    assert.ok(r2.status === 'rejected' || r2.value?.json?.result?.isError === true);
  } finally {
    await svc.disable('cleanup');
  }

  // Test timeout path separately
  heldRequests = [];
  const { port: pTimeout, token: tTimeout } = await svc.enable({ port: 0 }, 55);
  try {
    const s = await initSession(pTimeout, tTimeout);
    const res = await s.call('tools/call', { name: 'get_state', arguments: {} }, 200);
    assert.equal(res.json.result.isError, true);
    assert.match(res.json.result.content[0].text, /timed out/i);
  } finally {
    await svc.disable('cleanup-timeout');
  }
});

// ---------------------------------------------------------------------------
// 3. Output interlock & IPC mutual exclusion (DMX, Armed, Serial, Show Control TX, Viewer)
// ---------------------------------------------------------------------------
test('Output interlock enforces strict mutual exclusion between AI bridge and DMX/Armed/Serial/ShowControl TX', async () => {
  let dmxActive = false;
  const interlock = createOutputInterlock({ isDmxActive: () => dmxActive });
  const fakeDmx = {
    get active() { return dmxActive; },
    ownerId: null,
    isRunning: () => dmxActive,
    enable: async (_cfg, id) => { dmxActive = true; fakeDmx.ownerId = id; return { enabled: true }; },
    shutdown: async () => { dmxActive = false; fakeDmx.ownerId = null; return { enabled: false }; },
    getStatus: () => ({ enabled: dmxActive, state: dmxActive ? 'running' : 'idle', nodes: [] }),
  };
  let sentSc = 0;
  const fakeSc = {
    active: true,
    ownerId: 10,
    send: () => { sentSc++; return true; },
    getStatus: () => ({ active: true }),
    shutdown: async () => ({ active: false }),
  };

  let viewerRestricted = false;
  const isRestricted = () => viewerRestricted;
  const bridge = createAiBridgeService({ allowZeroPort: true, interlock });
  const dmxHandlers = createDmxIpcHandlers(() => fakeDmx, { isRestricted, interlock });
  const scHandlers = createShowControlIpcHandlers(() => fakeSc, { isRestricted, interlock });
  const aiHandlers = createAiBridgeIpcHandlers(() => bridge, () => interlock, { isRestricted });

  const makeEvent = (id = 10) => {
    const frame = { url: 'stageforge://app/' };
    return {
      senderFrame: frame,
      sender: { id, mainFrame: frame, isDestroyed: () => false, getURL: () => 'stageforge://app/', setBackgroundThrottling: () => {} },
    };
  };
  const ev = makeEvent(10);

  // 1. Armed claim blocks enabling AI bridge
  assert.deepEqual(await aiHandlers.onOutputClaim(ev, { type: 'claim', kind: 'armed' }), { ok: true, reason: null });
  await assert.rejects(() => aiHandlers.onControl(ev, { type: 'enable', config: { port: 0 } }), /Disarm live DMX output/i);
  await aiHandlers.onOutputClaim(ev, { type: 'release', kind: 'armed' });

  // 2. Serial claim blocks enabling AI bridge
  assert.deepEqual(await aiHandlers.onOutputClaim(ev, { type: 'claim', kind: 'serial' }), { ok: true, reason: null });
  await assert.rejects(() => aiHandlers.onControl(ev, { type: 'enable', config: { port: 0 } }), /USB Serial DMX/i);
  await aiHandlers.onOutputClaim(ev, { type: 'release', kind: 'serial' });

  // 3. Enabled AI bridge blocks arming, serial claim, DMX enable, AND outbound Show Control TX
  const st = await aiHandlers.onControl(ev, { type: 'enable', config: { port: 0 } });
  assert.equal(st.enabled, true);
  assert.equal((await aiHandlers.onOutputClaim(ev, { type: 'claim', kind: 'armed' })).ok, false);
  assert.equal((await aiHandlers.onOutputClaim(ev, { type: 'claim', kind: 'serial' })).ok, false);
  await assert.rejects(() => dmxHandlers.onControl(ev, { type: 'enable', config: {} }), /Disable the AI bridge/i);
  assert.equal(await scHandlers.onControl(ev, { type: 'send', payload: { kind: 'feedback', bpm: 128 } }), false);
  assert.equal(sentSc, 0, 'outbound OSC/TC feedback must be suspended while AI bridge is active');

  // 4. Disabling AI bridge restores DMX/arm/show-control TX
  await aiHandlers.onControl(ev, { type: 'disable' });
  assert.equal(await scHandlers.onControl(ev, { type: 'send', payload: { kind: 'feedback', bpm: 128 } }), true);
  assert.equal(sentSc, 1);

  // 5. Active desktop DMX blocks AI bridge enable
  await dmxHandlers.onControl(ev, { type: 'enable', config: {} });
  await assert.rejects(() => aiHandlers.onControl(ev, { type: 'enable', config: { port: 0 } }), /Stop live DMX output/i);
  await dmxHandlers.onControl(ev, { type: 'disable' });

  // 6. Pitch viewer mode blocks AI bridge enable & output claims
  viewerRestricted = true;
  await assert.rejects(() => aiHandlers.onControl(ev, { type: 'enable', config: { port: 0 } }), /pitch viewer mode/i);
  assert.equal((await aiHandlers.onOutputClaim(ev, { type: 'claim', kind: 'armed' })).ok, false);
});

// ---------------------------------------------------------------------------
// 4. Proposal lifecycle, validation, bounded store, audienceScan deep check & safety report
// ---------------------------------------------------------------------------
test('AI proposal compiler & bounded store validate strictly, reject audienceScan everywhere, detect staleness, and enforce 8-proposal cap', () => {
  const desk = makeFakeDesk();
  const baseRev = protocol.computeDeskRevision(desk);

  // Valid partial look proposal + diff
  const lookProp = protocol.compileLookProposal({ primaryColor: '#ff0066', beamIntensity: 0.9, laser: { intensity: 0.7 } }, 'Hot pink beams', desk);
  assert.equal(lookProp.candidate.look.primaryColor, '#ff0066');
  assert.equal(lookProp.candidate.look.beamIntensity, 0.9);
  assert.equal(lookProp.candidate.look.laser.intensity, 0.7);
  assert.ok(lookProp.diffLines.some((l) => l.includes('primaryColor')));

  // Unknown field rejected (no silent stripping via makeShowFile!)
  assert.throws(
    () => protocol.compileLookProposal({ unknownHackerKey: 123 }, undefined, desk),
    /unexpected|unknown/i,
  );

  // audienceScan: true rejected on look, cue, take, and full show
  assert.throws(
    () => protocol.compileLookProposal({ laser: { audienceScan: true } }, undefined, desk),
    /a human must enable audience scanning on the desk/i,
  );
  assert.throws(
    () => protocol.compileCueProposal({
      action: 'create',
      cue: { id: 'bad-cue', name: 'Bad', tag: 'X', accent: '#fff', state: { laser: { ...desk.look.laser, audienceScan: true } } },
    }, desk),
    /a human must enable audience scanning on the desk/i,
  );
  assert.throws(
    () => protocol.compileTakeProposal({
      durationMs: 2000,
      events: [{ atMs: 0, look: { ...desk.look, laser: { ...desk.look.laser, audienceScan: true } } }],
    }, undefined, desk),
    /a human must enable audience scanning on the desk/i,
  );
  const fullShowWithScan = showFileMod.makeShowFile(desk.rig, desk.cues, { ...desk.look, laser: { ...desk.look.laser, audienceScan: true } }, desk.activeCueId);
  assert.throws(
    () => protocol.compileShowProposal(fullShowWithScan, undefined, desk),
    /a human must enable audience scanning on the desk/i,
  );

  // Invalid full show rejected cleanly
  assert.throws(() => protocol.compileShowProposal({ format: 'stageforge-show', version: 8, rig: 'bad' }, undefined, desk));

  // Cue create / edit / reorder (exact permutation) / remove
  const created = protocol.compileCueProposal({
    action: 'create',
    cue: { id: 'ai-cue-1', name: 'AI Drop', tag: 'AI', accent: '#ff00aa', state: { masterDimmer: 0.9 } },
  }, desk);
  assert.equal(created.candidate.cues.length, desk.cues.length + 1);

  assert.throws(
    () => protocol.compileCueProposal({ action: 'reorder', order: ['nonexistent'] }, desk),
    /length|permutation/i,
  );
  const reversedIds = [...desk.cues.map((c) => c.id)].reverse();
  const reordered = protocol.compileCueProposal({ action: 'reorder', order: reversedIds }, desk);
  assert.deepEqual(reordered.candidate.cues.map((c) => c.id), reversedIds);

  // Audio mapping validation (enforces haze inertia and non-negative strobe)
  assert.throws(
    () => protocol.compileAudioMappingProposal({
      action: 'upsert',
      mapping: {
        id: 'bad-haze',
        name: 'Fast Haze',
        enabled: true,
        source: 'bass',
        target: { group: 'haze', param: 'dimmer' },
        amount: 0.5,
        attackMs: 10,
        releaseMs: 50,
        threshold: 0.1,
        curve: 'linear',
      },
    }, desk),
    /haze requires/i,
  );
  const goodMap = protocol.compileAudioMappingProposal({
    action: 'upsert',
    audioReactive: true,
    mapping: {
      id: 'kick-wash',
      name: 'Kick Wash',
      enabled: true,
      source: 'bass',
      target: { group: 'wash', param: 'dimmer' },
      amount: 0.7,
      attackMs: 15,
      releaseMs: 150,
      threshold: 0.1,
      curve: 'linear',
    },
  }, desk);
  assert.equal(goodMap.candidate.look.audioMap.mappings.length, 1);
  assert.equal(goodMap.candidate.look.audioReactive, true);

  // Wall cue upsert & remove
  const wallUp = protocol.compileWallCueProposal({
    action: 'upsert',
    event: { atMs: 1500, target: 'wing-left', kind: 'image', name: 'backdrop.png', playing: false },
  }, desk);
  assert.equal(wallUp.candidate.stage.screenEvents.length, 1);
  const deskWithWall = { ...desk, stage: wallUp.candidate.stage };
  const wallRm = protocol.compileWallCueProposal({ action: 'remove', wallId: 'wing-left', atMs: 1500 }, deskWithWall);
  assert.equal(wallRm.candidate.stage?.screenEvents?.length ?? 0, 0);

  // Bounded proposal store: max 8 pending (never evicts oldest!), withdraw frees slot
  const store = new protocol.AiProposalStore();
  for (let i = 0; i < protocol.MAX_PENDING_PROPOSALS; i++) {
    store.add({
      id: `p-${i}`,
      tool: 'propose_look',
      bridgeGeneration: 1,
      documentEpoch: 1,
      baseRevision: baseRev,
      summary: `Edit ${i}`,
      diffLines: ['beamIntensity: 0.8 -> 0.9'],
      createdAt: 1000 + i,
      candidate: lookProp.candidate,
    });
  }
  assert.throws(
    () => store.add({
      id: 'p-overflow',
      tool: 'propose_look',
      bridgeGeneration: 1,
      documentEpoch: 1,
      baseRevision: baseRev,
      summary: 'Overflow',
      diffLines: [],
      createdAt: 2000,
      candidate: lookProp.candidate,
    }),
    /Maximum pending proposals/i,
  );
  assert.ok(store.get('p-0')?.status === 'pending', 'oldest pending proposal must never be silently evicted');
  assert.ok(store.transition('p-0', 'withdrawn'));
  assert.equal(store.countPending(), protocol.MAX_PENDING_PROPOSALS - 1);

  // Desk revision changes when look changes (staleness detection)
  const mutatedDesk = { ...desk, look: { ...desk.look, bpm: 140 } };
  assert.notEqual(protocol.computeDeskRevision(mutatedDesk), baseRev);

  // Read-only safety report integration with Sprint 12 preflight
  const report = preflightMod.evaluatePreflight({
    rig: desk.rig,
    stage: desk.stage,
    cues: desk.cues,
    showState: desk.look,
    acks: preflightMod.EMPTY_PREFLIGHT_ACKS,
  });
  const aiSafety = protocol.buildAiSafetyReport(report);
  assert.equal(aiSafety.readOnly, true);
  assert.equal(aiSafety.overallStatus, report.overallStatus);
  assert.equal(aiSafety.rows.length, report.rows.length);
  assert.equal(aiSafety.laserZones.length, report.laserZones.length);
  assert.match(aiSafety.note, /cannot pass checks|arm live output/i);
});

// ---------------------------------------------------------------------------
// 5. Clock-owner truth table for 'ai' source & cue/take audienceScan guards
// ---------------------------------------------------------------------------
test('Clock owner enforces AI bridge rules across master, caller, and chase modes and blocks indirect audienceScan', () => {
  // Master: cues + take_play + blackout + master + tempo allowed; clock mode change & timecode_transport blocked
  assert.equal(clockOwner.allows('master', 'ai', 'go'), true);
  assert.equal(clockOwner.allows('master', 'ai', 'take_play'), true);
  assert.equal(clockOwner.allows('master', 'ai', 'blackout'), true);
  assert.equal(clockOwner.allows('master', 'ai', 'master'), true);
  assert.equal(clockOwner.allows('master', 'ai', 'tempo'), true);
  assert.equal(clockOwner.allows('master', 'ai', 'remote_clock_mode'), false);
  assert.equal(clockOwner.allows('master', 'ai', 'timecode_transport'), false);
  assert.equal(clockOwner.allows('master', 'ai', 'outbound_timecode'), false);

  // Caller: cues + blackout + master + tempo allowed; take_play blocked
  assert.equal(clockOwner.allows('caller', 'ai', 'go'), true);
  assert.equal(clockOwner.allows('caller', 'ai', 'back'), true);
  assert.equal(clockOwner.allows('caller', 'ai', 'blackout'), true);
  assert.equal(clockOwner.allows('caller', 'ai', 'take_play'), false);
  assert.equal(clockOwner.allows('caller', 'ai', 'remote_clock_mode'), false);

  // Chase: emergency blackout only
  assert.equal(clockOwner.allows('chase', 'ai', 'blackout'), true);
  assert.equal(clockOwner.allows('chase', 'ai', 'go'), false);
  assert.equal(clockOwner.allows('chase', 'ai', 'take_play'), false);
  assert.equal(clockOwner.allows('chase', 'ai', 'master'), false);
  assert.equal(clockOwner.allows('chase', 'ai', 'tempo'), false);

  // Indirect audienceScan guards on existing cues & takes
  assert.equal(
    protocol.cueEnablesAudienceScan({ id: 'c', name: 'Scan', tag: 'L', accent: '#fff', state: { laser: { ...presets.INITIAL_SHOW_STATE.laser, audienceScan: true } } }),
    true,
  );
  assert.equal(
    protocol.timelineEnablesAudienceScan({ durationMs: 1000, events: [{ atMs: 0, look: { laser: { ...presets.INITIAL_SHOW_STATE.laser, audienceScan: true } } }] }),
    true,
  );
});
