import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const {
  CSP,
  isAppPage,
  createRendererHandler,
  parseUsbId,
  isFtdiSerialPort,
  serialDeviceKey,
  selectVisibleSerialPorts,
} = require('../desktop/protocol.cjs');
const { isPermissiveSpdx, readLicenseField, thirdPartyNotices } = await import('../desktop/prepare.mjs');

test('isAppPage enforces scheme, exact host, no port and no credentials', () => {
  assert.equal(isAppPage('stageforge://app/'), true);
  assert.equal(isAppPage('stageforge://app/index.html'), true);
  assert.equal(isAppPage('stageforge://app/assets/main.js'), true);
  assert.equal(isAppPage('stageforge://evil/'), false);
  assert.equal(isAppPage('stageforge://app:1/'), false);
  assert.equal(isAppPage('stageforge://user@app/'), false);
  assert.equal(isAppPage('stageforge://user:pass@app/'), false);
  assert.equal(isAppPage('https://app/'), false);
  assert.equal(isAppPage('not a url'), false);
  assert.equal(isAppPage(null), false);
});

test('serveRenderer blocks hostile paths/methods and attaches CSP + nosniff to every response including case variants', async () => {
  const fetched = [];
  const handler = createRendererHandler({
    rendererRoot: path.join(root, 'desktop', 'build', 'app', 'renderer'),
    fetchFile: async (url) => {
      fetched.push(url);
      return new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });

  // Case variants on Windows/macOS must NEVER bypass CSP.
  for (const url of [
    'stageforge://app/',
    'stageforge://app/index.html',
    'stageforge://app/Index.html',
    'stageforge://app/INDEX.HTML',
    'stageforge://app/assets/index.js',
  ]) {
    const res = await handler(new Request(url, { method: 'GET' }));
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('content-security-policy'), CSP, `CSP present on ${url}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `nosniff present on ${url}`);
  }

  // Hostile methods, hosts, ports, userinfo, traversal, backslashes, NUL, drive letters.
  const countBefore = fetched.length;
  for (const [req, expected] of [
    [{ method: 'POST', url: 'stageforge://app/' }, 404],
    [{ method: 'GET', url: 'stageforge://evil/index.html' }, 404],
    [{ method: 'GET', url: 'stageforge://app:8080/index.html' }, 404],
    [{ method: 'GET', url: 'stageforge://user@app/index.html' }, 404],
    [{ method: 'GET', url: 'stageforge://app/..%2f..%2fpackage.json' }, 404],
    [{ method: 'GET', url: 'stageforge://app/%5cwindows%5csystem.ini' }, 400],
    [{ method: 'GET', url: 'stageforge://app/index.html%00.png' }, 400],
    [{ method: 'GET', url: 'stageforge://app/C:/Windows/win.ini' }, 400],
    [{ method: 'GET', url: 'stageforge://app/%E0%A4%A' }, 404],
  ]) {
    const res = await handler(req);
    assert.equal(res.status, expected, `${req.method} ${req.url}`);
  }
  assert.equal(fetched.length, countBefore, 'hostile requests must never call fetchFile');
});

test('serveRenderer returns 204 with CSP when /demo/track.json is absent, 200 when present, and 404 for other missing files', async () => {
  let present = false;
  const handler = createRendererHandler({
    rendererRoot: path.join(root, 'desktop', 'build', 'app', 'renderer'),
    fetchFile: async (url) => {
      if (present && url.endsWith('/demo/track.json')) {
        return new Response('{"format":"stageforge-demo-track"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('ENOENT');
    },
  });

  const missingMap = await handler(new Request('stageforge://app/demo/track.json', { method: 'GET' }));
  assert.equal(missingMap.status, 204);
  assert.equal(missingMap.headers.get('content-security-policy'), CSP);
  assert.equal(missingMap.headers.get('x-content-type-options'), 'nosniff');

  const otherMissing = await handler(new Request('stageforge://app/demo/missing.mp3', { method: 'GET' }));
  assert.equal(otherMissing.status, 404);

  present = true;
  const presentMap = await handler(new Request('stageforge://app/demo/track.json', { method: 'GET' }));
  assert.equal(presentMap.status, 200);
  assert.equal(presentMap.headers.get('content-security-policy'), CSP);
  assert.equal(presentMap.headers.get('x-content-type-options'), 'nosniff');
});

test('preload enforces command/payload whitelist, DMX validation, replays pending once, and isolates throwing listeners', async () => {
  const ipcHandlers = new Map();
  const sentMessages = [];
  const invokedMessages = [];
  let exposedApi;
  const fakeElectron = {
    ipcRenderer: {
      on(channel, fn) {
        ipcHandlers.set(channel, fn);
      },
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
      async invoke(channel, ...args) {
        invokedMessages.push([channel, ...args]);
        return { ok: true };
      },
    },
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, 'stageforgeDesktop');
        exposedApi = api;
      },
    },
  };
  const preloadPath = path.join(root, 'desktop', 'preload.cjs');
  delete require.cache[preloadPath];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = origLoad;
  }
  assert.ok(exposedApi && typeof exposedApi.onRigCommand === 'function');
  assert.deepEqual(Object.keys(exposedApi), [
    'onRigCommand',
    'sendDmxFrame',
    'sendDmxHeartbeat',
    'dmxControl',
    'onDmxStatus',
    'showControl',
    'onShowControlEvent',
    'onShowControlStatus',
    'setViewerMode',
    'aiBridgeControl',
    'onAiBridgeStatus',
    'onAiBridgeRequest',
    'replyAiBridgeRequest',
    'outputClaim',
  ]);
  const fire = ipcHandlers.get('stageforge:rig-command');
  const fireStatus = ipcHandlers.get('stageforge:dmx-status');
  assert.ok(typeof fire === 'function');
  assert.ok(typeof fireStatus === 'function');

  // Pending command queued before any listener registers is delivered once.
  fire({}, 'open', '{"rig":true}');
  const firstReceived = [];
  const unsub1 = exposedApi.onRigCommand((...args) => firstReceived.push(args));
  assert.deepEqual(firstReceived, [['open', '{"rig":true}']]);
  const secondReceived = [];
  const unsub2 = exposedApi.onRigCommand((...args) => secondReceived.push(args));
  assert.deepEqual(secondReceived, [], 'pending command must only replay once');

  // Disallowed commands and mismatched payload types are dropped.
  fire({}, 'rm -rf', '/');
  fire({}, 'open', new Uint8Array([1, 2]));
  fire({}, 'openBundle', 'not-bytes');
  fire({}, 'openMvr', 'not-bytes');
  fire({}, 'openViewer', 12345);
  fire({}, 'openViewer', null);
  fire({}, 'openViewer');
  assert.equal(firstReceived.length, 1);

  // Valid ArrayBuffer payload for openMvr is converted to Uint8Array; openViewer accepts string, Uint8Array, or ArrayBuffer;
  // non-open commands strip extra payload.
  const buf = new Uint8Array([9, 8, 7]).buffer;
  fire({}, 'openMvr', buf);
  fire({}, 'mvr', 'ignored-payload');
  fire({}, 'openViewer', '{"format":"stageforge-show"}');
  fire({}, 'openViewer', new Uint8Array([5, 6]).buffer);
  assert.equal(firstReceived.length, 5);
  assert.equal(firstReceived[1][0], 'openMvr');
  assert.ok(firstReceived[1][1] instanceof Uint8Array);
  assert.deepEqual([...firstReceived[1][1]], [9, 8, 7]);
  assert.deepEqual(firstReceived[2], ['mvr']);
  assert.deepEqual(firstReceived[3], ['openViewer', '{"format":"stageforge-show"}']);
  assert.equal(firstReceived[4][0], 'openViewer');
  assert.ok(firstReceived[4][1] instanceof Uint8Array);
  assert.deepEqual([...firstReceived[4][1]], [5, 6]);

  // Throwing listener must not block other listeners.
  unsub1();
  unsub2();
  const survived = [];
  const unsubBad = exposedApi.onRigCommand(() => { throw new Error('boom'); });
  const unsubGood = exposedApi.onRigCommand((...args) => survived.push(args));
  fire({}, 'export');
  assert.deepEqual(survived, [['export']]);
  unsubBad();
  unsubGood();
  assert.throws(() => exposedApi.onRigCommand('not-a-fn'), TypeError);

  // DMX frame channel validation: only universe 1|2 and exact Uint8Array(512).
  assert.equal(exposedApi.sendDmxFrame(0, new Uint8Array(512)), false);
  assert.equal(exposedApi.sendDmxFrame(3, new Uint8Array(512)), false);
  assert.equal(exposedApi.sendDmxFrame(1, new Uint8Array(511)), false);
  assert.equal(exposedApi.sendDmxFrame(1, new Uint8Array(513)), false);
  assert.equal(exposedApi.sendDmxFrame(1, new Int8Array(512)), false);
  assert.equal(sentMessages.length, 0);
  const validFrame = new Uint8Array(512);
  validFrame[0] = 123;
  assert.equal(exposedApi.sendDmxFrame(1, validFrame), true);
  assert.equal(exposedApi.sendDmxFrame(2, validFrame), true);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0][0], 'stageforge:dmx-frame');

  // DMX control whitelist
  await assert.rejects(() => exposedApi.dmxControl({ type: 'exec' }), TypeError);
  await assert.rejects(() => exposedApi.dmxControl(null), TypeError);
  await exposedApi.dmxControl({ type: 'getStatus' });
  assert.equal(invokedMessages.length, 1);
  assert.equal(invokedMessages[0][0], 'stageforge:dmx-control');

  // DMX status replay & listener isolation
  fireStatus({}, { enabled: false, state: 'idle' });
  const seenStatuses = [];
  const unsubBadStatus = exposedApi.onDmxStatus(() => { throw new Error('status boom'); });
  const unsubGoodStatus = exposedApi.onDmxStatus((st) => seenStatuses.push(st));
  assert.equal(seenStatuses.length, 1);
  fireStatus({}, { enabled: true, state: 'running' });
  assert.equal(seenStatuses.length, 2);
  assert.equal(seenStatuses[1].enabled, true);
  unsubBadStatus();
  unsubGoodStatus();
  assert.throws(() => exposedApi.onDmxStatus('nope'), TypeError);

  // Show control whitelist & event/status isolation
  await assert.rejects(() => exposedApi.showControl({ type: 'exec' }), TypeError);
  await assert.rejects(() => exposedApi.showControl(null), TypeError);
  await exposedApi.showControl({ type: 'getStatus' });
  assert.equal(invokedMessages.at(-1)[0], 'stageforge:show-control');

  const fireScEvent = ipcHandlers.get('stageforge:show-control-event');
  const fireScStatus = ipcHandlers.get('stageforge:show-control-status');
  const seenScEvents = [];
  const unsubScBad = exposedApi.onShowControlEvent(() => { throw new Error('sc boom'); });
  const unsubScGood = exposedApi.onShowControlEvent((ev) => seenScEvents.push(ev));
  fireScEvent({}, { kind: 'bogus' });
  fireScEvent({}, { source: 'osc', kind: 'trigger', command: 'go', at: 1 });
  assert.equal(seenScEvents.length, 1);
  unsubScBad();
  unsubScGood();
  assert.throws(() => exposedApi.onShowControlEvent('nope'), TypeError);

  fireScStatus({}, { active: false });
  const seenScStatus = [];
  const unsubScSt = exposedApi.onShowControlStatus((st) => seenScStatus.push(st));
  assert.equal(seenScStatus.length, 1);
  unsubScSt();
  assert.throws(() => exposedApi.onShowControlStatus('nope'), TypeError);

  // Viewer mode IPC whitelist: strictly boolean.
  await assert.rejects(() => exposedApi.setViewerMode('true'), TypeError);
  await assert.rejects(() => exposedApi.setViewerMode(1), TypeError);
  await assert.rejects(() => exposedApi.setViewerMode(null), TypeError);
  await exposedApi.setViewerMode(true);
  assert.deepEqual(invokedMessages.at(-1), ['stageforge:viewer-mode', true]);
  await exposedApi.setViewerMode(false);
  assert.deepEqual(invokedMessages.at(-1), ['stageforge:viewer-mode', false]);

  // AI bridge & output claim IPC whitelists.
  await assert.rejects(() => exposedApi.aiBridgeControl({ type: 'exec' }), TypeError);
  await assert.rejects(() => exposedApi.aiBridgeControl(null), TypeError);
  await exposedApi.aiBridgeControl({ type: 'getStatus' });
  assert.equal(invokedMessages.at(-1)[0], 'stageforge:ai-bridge-control');

  await assert.rejects(() => exposedApi.replyAiBridgeRequest(null), TypeError);
  await assert.rejects(() => exposedApi.replyAiBridgeRequest({ ok: true }), TypeError);
  await exposedApi.replyAiBridgeRequest({ requestId: 'r1', bridgeGeneration: 1, ok: true, result: {} });
  assert.equal(invokedMessages.at(-1)[0], 'stageforge:ai-bridge-reply');

  await assert.rejects(() => exposedApi.outputClaim({ type: 'claim', kind: 'laser' }), TypeError);
  await assert.rejects(() => exposedApi.outputClaim({ type: 'other', kind: 'armed' }), TypeError);
  await exposedApi.outputClaim({ type: 'claim', kind: 'armed' });
  assert.deepEqual(invokedMessages.at(-1), ['stageforge:output-claim', { type: 'claim', kind: 'armed' }]);

  const fireAiStatus = ipcHandlers.get('stageforge:ai-bridge-status');
  const fireAiReq = ipcHandlers.get('stageforge:ai-bridge-request');
  fireAiStatus({}, { enabled: false, state: 'off' });
  const seenAiStatus = [];
  const unsubAiSt = exposedApi.onAiBridgeStatus((s) => seenAiStatus.push(s));
  assert.equal(seenAiStatus.length, 1);
  unsubAiSt();
  assert.throws(() => exposedApi.onAiBridgeStatus('nope'), TypeError);

  const seenAiReqs = [];
  const unsubAiReq = exposedApi.onAiBridgeRequest((r) => seenAiReqs.push(r));
  fireAiReq({}, { bogus: true });
  fireAiReq({}, { requestId: 'req-1', tool: 'get_state', arguments: {} });
  assert.equal(seenAiReqs.length, 1);
  unsubAiReq();
  assert.throws(() => exposedApi.onAiBridgeRequest('nope'), TypeError);
});

test('serial port helpers prioritize FTDI devices, cap at 8, and desktop/prepare.mjs copies every local main.cjs require', async () => {
  assert.equal(parseUsbId('1027'), 0x0403);
  assert.equal(parseUsbId('0x0403'), 0x0403);
  assert.equal(parseUsbId('0403'), 0x0403);
  assert.equal(parseUsbId('invalid'), null);
  assert.equal(isFtdiSerialPort({ vendorId: '1027' }), true);
  assert.equal(isFtdiSerialPort({ vendorId: '2341' }), false);

  assert.equal(
    serialDeviceKey({ vendorId: '1027', productId: '24577', serialNumber: 'EN12345' }),
    '403:6001:EN12345',
  );
  const ports = Array.from({ length: 10 }, (_, i) => ({
    portId: `p${i}`,
    vendorId: i === 9 ? '1027' : '1234',
    productId: '0001',
    portName: `COM${i + 1}`,
  }));
  const visible = selectVisibleSerialPorts(ports, 8);
  assert.equal(visible.length, 8);
  assert.equal(visible[0].portId, 'p9', 'FTDI DMX interface must be listed first');

  // Guard: every local require('./...') reachable from desktop/main.cjs must be copied by desktop/prepare.mjs.
  const prepareSource = await readFile(path.join(root, 'desktop', 'prepare.mjs'), 'utf8');
  const queue = ['main.cjs'];
  const visited = new Set(queue);
  const localRequires = [];
  while (queue.length > 0) {
    const file = queue.shift();
    const source = await readFile(path.join(root, 'desktop', file), 'utf8');
    for (const match of source.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
      const mod = match[1];
      if (!visited.has(mod)) {
        visited.add(mod);
        localRequires.push(mod);
        queue.push(mod);
      }
    }
  }
  assert.ok(localRequires.includes('dmx-packets.cjs'));
  assert.ok(localRequires.includes('dmx-sender.cjs'));
  assert.ok(localRequires.includes('dmx-ipc.cjs'));
  assert.ok(localRequires.includes('osc-packets.cjs'));
  assert.ok(localRequires.includes('artnet-rx.cjs'));
  assert.ok(localRequires.includes('show-control-service.cjs'));
  assert.ok(localRequires.includes('show-control-ipc.cjs'));
  assert.ok(localRequires.includes('viewer-ipc.cjs'));
  for (const mod of localRequires) {
    assert.ok(
      prepareSource.includes(`'${mod}'`),
      `desktop/prepare.mjs must copy ${mod} reachable from desktop/main.cjs`,
    );
  }
});

test('main-process DMX IPC handlers enforce sender, mainFrame, window ownership (M2) and post-bind liveness (H1)', async () => {
  const { createDmxIpcHandlers } = require('../desktop/dmx-ipc.cjs');
  let ownerId = null;
  let running = false;
  let active = false;
  let shutdownReason = null;
  let lastUpdate = null;
  const fakeDmx = {
    get ownerId() { return ownerId; },
    get active() { return active; },
    isRunning: () => running,
    listInterfaces: () => [{ name: 'Loopback', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: null, internal: true }],
    getStatus: () => ({ enabled: running, state: running ? 'running' : 'idle' }),
    update: (u, data) => { lastUpdate = { u, byte0: data[0], len: data.byteLength }; return true; },
    enable: async (_cfg, id) => { ownerId = id; running = true; active = true; return { enabled: true }; },
    shutdown: async (reason) => { shutdownReason = reason; ownerId = null; running = false; active = false; return { enabled: false }; },
    discover: async () => ({ nodes: [], warning: null }),
  };
  const { onFrame, onControl } = createDmxIpcHandlers(() => fakeDmx);

  function makeEvent({ id = 1, url = 'stageforge://app/', frameUrl = url, isSubframe = false, destroyed = false } = {}) {
    const mainFrame = { url };
    const senderFrame = isSubframe ? { url: frameUrl } : mainFrame;
    let isDestroyedFlag = destroyed;
    let bgThrottling = true;
    return {
      senderFrame,
      sender: {
        id,
        mainFrame,
        getURL: () => url,
        isDestroyed: () => isDestroyedFlag,
        setDestroyed: (v) => { isDestroyedFlag = v; },
        setBackgroundThrottling: (v) => { bgThrottling = v; },
        get bgThrottling() { return bgThrottling; },
      },
    };
  }

  // Reject hostile origin, subframe, destroyed sender, and unknown command keys.
  await assert.rejects(() => onControl(makeEvent({ url: 'https://evil.example/' }), { type: 'getStatus' }), /Unauthorized/);
  await assert.rejects(() => onControl(makeEvent({ isSubframe: true }), { type: 'getStatus' }), /Unauthorized/);
  await assert.rejects(() => onControl(makeEvent({ destroyed: true }), { type: 'getStatus' }), /Unauthorized/);
  await assert.rejects(() => onControl(makeEvent(), { type: 'getStatus', extra: 1 }), /Unexpected/);

  // Window 1 enables live output.
  const win1 = makeEvent({ id: 1 });
  await onControl(win1, { type: 'enable', config: { protocol: 'sacn' } });
  assert.equal(win1.sender.bgThrottling, false);

  // Offset Uint8Array(512) slice from owning window succeeds; wrong length / Int8Array / wrong owner fail.
  const backing = new Uint8Array(600);
  backing[16] = 177;
  const slice512 = backing.subarray(16, 528);
  assert.equal(onFrame(win1, 1, slice512), true);
  assert.deepEqual(lastUpdate, { u: 1, byte0: 177, len: 512 });
  assert.equal(onFrame(win1, 1, new Int8Array(512)), false);
  assert.equal(onFrame(win1, 3, slice512), false);

  // M2 & Pass 2 L4: Window 2 cannot send frames, sees enabled: false, cannot disable, and cannot hijack enable while Window 1 owns live output.
  const win2 = makeEvent({ id: 2 });
  assert.equal(onFrame(win2, 1, slice512), false);
  const win2Status = await onControl(win2, { type: 'getStatus' });
  assert.equal(win2Status.enabled, false, 'non-owner window must not falsely report LIVE');
  await assert.rejects(() => onControl(win2, { type: 'disable' }), /owned by another/);
  await assert.rejects(() => onControl(win2, { type: 'enable', config: { protocol: 'sacn' } }), /already active in another/);

  // Window 1 disables cleanly.
  await onControl(win1, { type: 'disable' });
  assert.equal(shutdownReason, 'disable');

  // H1: if sender is destroyed during async enable(), handler shuts down immediately and rejects.
  const dyingWin = makeEvent({ id: 3 });
  fakeDmx.enable = async (_cfg, id) => {
    ownerId = id; running = true; active = true;
    dyingWin.sender.setDestroyed(true);
    return { enabled: true };
  };
  await assert.rejects(() => onControl(dyingWin, { type: 'enable', config: { protocol: 'sacn' } }), /closed or navigated/);
  assert.equal(shutdownReason, 'owner-gone');
  assert.equal(running, false);
});

test('viewer-ipc enforces sender/type checks, disables mutating File menus, and blocks DMX & show-control activation while allowing disable/stop', async () => {
  const { MUTATING_FILE_MENU_IDS, createViewerModeTracker, createViewerIpcHandler } = require('../desktop/viewer-ipc.cjs');
  const { createDmxIpcHandlers } = require('../desktop/dmx-ipc.cjs');
  const { createShowControlIpcHandlers } = require('../desktop/show-control-ipc.cjs');

  const tracker = createViewerModeTracker();
  const menuItems = new Map(MUTATING_FILE_MENU_IDS.map((id) => [id, { id, enabled: true }]));
  const openViewerItem = { id: 'file-open-viewer', enabled: true };
  menuItems.set('file-open-viewer', openViewerItem);
  const fakeMenu = { getMenuItemById: (id) => menuItems.get(id) ?? null };

  let enterCalls = [];
  let stateChanges = [];
  const onSetViewerMode = createViewerIpcHandler({
    tracker,
    onEnterViewer: async (wcId) => { enterCalls.push(wcId); },
    onStateChanged: (wcId, active) => {
      stateChanges.push([wcId, active]);
      tracker.applyMenuRestrictions(fakeMenu, active);
    },
  });

  function makeEvent({ id = 7, url = 'stageforge://app/', isSubframe = false } = {}) {
    const mainFrame = { url };
    return {
      senderFrame: isSubframe ? { url } : mainFrame,
      sender: { id, mainFrame, getURL: () => url, isDestroyed: () => false, setBackgroundThrottling: () => {} },
    };
  }

  // Reject hostile sender, subframe, and non-boolean flag.
  await assert.rejects(() => onSetViewerMode(makeEvent({ url: 'https://evil.example/' }), true), /Unauthorized/);
  await assert.rejects(() => onSetViewerMode(makeEvent({ isSubframe: true }), true), /Unauthorized/);
  await assert.rejects(() => onSetViewerMode(makeEvent(), 'yes'), /boolean/);

  // Enter viewer mode -> tracker marks window, calls onEnterViewer, disables mutating File menus, keeps Open in viewer enabled.
  const win = makeEvent({ id: 7 });
  assert.deepEqual(await onSetViewerMode(win, true), { viewer: true });
  assert.equal(tracker.isViewerWindow(7), true);
  assert.deepEqual(enterCalls, [7]);
  for (const id of MUTATING_FILE_MENU_IDS) {
    assert.equal(menuItems.get(id).enabled, false, `menu ${id} must be disabled in viewer mode`);
  }
  assert.equal(openViewerItem.enabled, true, 'file-open-viewer must remain enabled in viewer mode');

  // DMX & show-control handlers reject activation/frames while restricted, but allow disable/stop/getStatus.
  const dmxShutdowns = [];
  const scShutdowns = [];
  const fakeDmx = {
    ownerId: 7,
    active: false,
    isRunning: () => true,
    listInterfaces: () => [],
    getStatus: () => ({ enabled: true, state: 'running' }),
    update: () => true,
    enable: async () => ({ enabled: true }),
    shutdown: async (reason) => { dmxShutdowns.push(reason); return { enabled: false, state: 'idle' }; },
    discover: async () => ({ nodes: [], warning: null }),
  };
  const fakeSc = {
    ownerId: 7,
    active: false,
    getStatus: () => ({ active: true, oscRxListening: true }),
    configure: async () => ({ active: true }),
    send: () => true,
    shutdown: async () => { scShutdowns.push('stop'); return { active: false }; },
  };
  const isRestricted = (wcId) => tracker.isViewerWindow(wcId);
  const dmxHandlers = createDmxIpcHandlers(() => fakeDmx, { isRestricted });
  const scHandlers = createShowControlIpcHandlers(() => fakeSc, { isRestricted });

  assert.equal(dmxHandlers.onFrame(win, 1, new Uint8Array(512)), false);
  await assert.rejects(() => dmxHandlers.onControl(win, { type: 'enable', config: { protocol: 'sacn' } }), /pitch viewer/);
  await assert.rejects(() => dmxHandlers.onControl(win, { type: 'discover', iface: '127.0.0.1' }), /pitch viewer/);
  assert.equal((await dmxHandlers.onControl(win, { type: 'getStatus' })).enabled, false);
  await dmxHandlers.onControl(win, { type: 'disable' });
  assert.deepEqual(dmxShutdowns, ['disable']);

  await assert.rejects(() => scHandlers.onControl(win, { type: 'configure', config: {} }), /pitch viewer/);
  assert.equal(await scHandlers.onControl(win, { type: 'send', payload: { kind: 'feedback' } }), false);
  assert.equal((await scHandlers.onControl(win, { type: 'getStatus' })).active, false);
  await scHandlers.onControl(win, { type: 'stop' });
  assert.deepEqual(scShutdowns, ['stop']);

  // Exit viewer mode -> re-enables all File menu items.
  assert.deepEqual(await onSetViewerMode(win, false), { viewer: false });
  assert.equal(tracker.isViewerWindow(7), false);
  for (const id of MUTATING_FILE_MENU_IDS) {
    assert.equal(menuItems.get(id).enabled, true, `menu ${id} must re-enable on exit`);
  }

  // QA regression (post-bind race): entering viewer mode while async enable/configure is in-flight
  // must immediately shut down the bound service and reject.
  dmxShutdowns.length = 0;
  scShutdowns.length = 0;
  fakeDmx.enable = async () => {
    tracker.setViewerWindow(7, true);
    return { enabled: true };
  };
  await assert.rejects(
    () => dmxHandlers.onControl(win, { type: 'enable', config: { protocol: 'sacn' } }),
    /pitch viewer/,
  );
  assert.deepEqual(dmxShutdowns, ['viewer-mode']);

  tracker.setViewerWindow(7, false);
  fakeSc.configure = async () => {
    tracker.setViewerWindow(7, true);
    return { active: true };
  };
  await assert.rejects(
    () => scHandlers.onControl(win, { type: 'configure', config: {} }),
    /pitch viewer/,
  );
  assert.deepEqual(scShutdowns, ['stop']);
});

test('prepare.mjs validates SPDX licences, resolves nested node_modules and skips licence directories', async () => {
  assert.equal(isPermissiveSpdx('MIT'), true);
  assert.equal(isPermissiveSpdx('ISC'), true);
  assert.equal(isPermissiveSpdx('BSD-2-Clause'), true);
  assert.equal(isPermissiveSpdx('BSD-3-Clause'), true);
  assert.equal(isPermissiveSpdx('0BSD'), true);
  assert.equal(isPermissiveSpdx('Apache-2.0'), true);
  assert.equal(isPermissiveSpdx('(MIT OR Apache-2.0)'), true);
  assert.equal(isPermissiveSpdx('(GPL-3.0 OR MIT)'), true);
  assert.equal(isPermissiveSpdx('(MIT AND BSD-3-Clause)'), true);
  assert.equal(isPermissiveSpdx('GPL-3.0'), false);
  assert.equal(isPermissiveSpdx('LGPL-2.1'), false);
  assert.equal(isPermissiveSpdx('(MIT AND GPL-3.0)'), false);
  assert.equal(isPermissiveSpdx('MIT WITH CustomException'), false);
  assert.equal(isPermissiveSpdx('UNKNOWN'), false);

  assert.equal(readLicenseField({ license: { type: 'MIT' } }), 'MIT');
  assert.equal(readLicenseField({ licenses: [{ type: 'MIT' }, { type: 'ISC' }] }), 'MIT AND ISC');
  assert.equal(readLicenseField({}), 'UNKNOWN');

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sf-notices-'));
  try {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'demo', version: '1.0.0', dependencies: { 'pkg-a': '1.0.0' },
    }));
    const pkgA = path.join(tmp, 'node_modules', 'pkg-a');
    const nestedB = path.join(pkgA, 'node_modules', 'pkg-b');
    await mkdir(path.join(pkgA, 'licenses'), { recursive: true });
    await mkdir(nestedB, { recursive: true });
    await writeFile(path.join(pkgA, 'package.json'), JSON.stringify({
      name: 'pkg-a', version: '1.0.0', license: { type: 'MIT' }, dependencies: { 'pkg-b': '2.0.0' },
    }));
    await writeFile(path.join(pkgA, 'LICENSE'), 'MIT License A');
    await writeFile(path.join(nestedB, 'package.json'), JSON.stringify({
      name: 'pkg-b', version: '2.0.0', license: '(Apache-2.0 OR GPL-3.0)',
    }));
    await writeFile(path.join(nestedB, 'NOTICE.txt'), 'Apache Notice B');

    const notices = await thirdPartyNotices(tmp);
    assert.match(notices, /pkg-a 1\.0\.0 — MIT/);
    assert.match(notices, /MIT License A/);
    assert.match(notices, /pkg-b 2\.0\.0 — \(Apache-2\.0 OR GPL-3\.0\)/);
    assert.match(notices, /Apache Notice B/);

    // Non-permissive licence fails the build.
    await writeFile(path.join(nestedB, 'package.json'), JSON.stringify({
      name: 'pkg-b', version: '2.0.0', license: 'GPL-3.0-only',
    }));
    await assert.rejects(() => thirdPartyNotices(tmp), /non-permissive licence/);

    // Missing required dependency fails the build.
    await rm(nestedB, { recursive: true, force: true });
    await assert.rejects(() => thirdPartyNotices(tmp), /pkg-b is not installed/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // Real repo dependency tree must pass the fail-closed permissive-licence gate cleanly.
  const realNotices = await thirdPartyNotices(root);
  assert.match(realNotices, /fast-xml-parser/);
  assert.match(realNotices, /three/);
});
