import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { CSP, isAppPage, createRendererHandler } = require('../desktop/protocol.cjs');
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

test('preload enforces command/payload whitelist, replays pending once, and isolates throwing listeners', () => {
  const ipcHandlers = new Map();
  let exposedApi;
  const fakeElectron = {
    ipcRenderer: {
      on(channel, fn) {
        ipcHandlers.set(channel, fn);
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
  const fire = ipcHandlers.get('stageforge:rig-command');
  assert.ok(typeof fire === 'function');

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
  assert.equal(firstReceived.length, 1);

  // Valid ArrayBuffer payload for openMvr is converted to Uint8Array; non-open commands strip extra payload.
  const buf = new Uint8Array([9, 8, 7]).buffer;
  fire({}, 'openMvr', buf);
  fire({}, 'mvr', 'ignored-payload');
  assert.equal(firstReceived.length, 3);
  assert.equal(firstReceived[1][0], 'openMvr');
  assert.ok(firstReceived[1][1] instanceof Uint8Array);
  assert.deepEqual([...firstReceived[1][1]], [9, 8, 7]);
  assert.deepEqual(firstReceived[2], ['mvr']);

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
