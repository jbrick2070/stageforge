import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const { uuidV5, isUuid } = await compiler.ssrLoadModule('/src/interchange/mvr/uuid.ts');
const coords = await compiler.ssrLoadModule('/src/interchange/mvr/coords.ts');
const { writeArchive, readArchive } = await compiler.ssrLoadModule('/src/interchange/mvr/archive.ts');
const { parseXml, buildXml, list, attr, text } = await compiler.ssrLoadModule('/src/interchange/mvr/xml.ts');
const { boxGlb, glbBounds } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');
const THREE = await compiler.ssrLoadModule('three');

const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('UUID v5 matches the RFC example and is stable', () => {
  // Python: uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.com')
  assert.equal(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  const a = uuidV5('fixture:pod-front:f-ds-beams:3');
  assert.ok(isUuid(a));
  assert.equal(a, uuidV5('fixture:pod-front:f-ds-beams:3'));
  assert.notEqual(a, uuidV5('fixture:pod-front:f-ds-beams:4'));
});

test('StageForge metres map to MVR millimetres with Z up and the audience toward −Y', () => {
  assert.deepEqual(coords.toMvrPoint({ x: 1, y: 2, z: 3 }), { x: 1000, y: -3000, z: 2000 });
  const back = coords.fromMvrPoint(coords.toMvrPoint({ x: -4.25, y: 7.5, z: 1.125 }));
  close(back.x, -4.25, 1e-12); close(back.y, 7.5, 1e-12); close(back.z, 1.125, 1e-12);
});

test('yaw about StageForge +Y becomes the same-signed yaw about MVR +Z, and round-trips', () => {
  for (const yaw of [-170, -90, -30, 0, 30, 90, 135, 180]) {
    // Ground truth: a three.js object yawed about +Y, its local axes mapped through C = (x, −z, y).
    const o = new THREE.Object3D();
    o.rotation.y = THREE.MathUtils.degToRad(yaw);
    o.updateMatrixWorld();
    const sfX = new THREE.Vector3(1, 0, 0).transformDirection(o.matrixWorld);
    const m = coords.poseMatrix({ x: 0, y: 8, z: -4 }, yaw);
    const expectedU = coords.toMvrPoint({ x: sfX.x, y: sfX.y, z: sfX.z });
    close(m.u.x, expectedU.x / 1000, 1e-9); close(m.u.y, expectedU.y / 1000, 1e-9); close(m.u.z, expectedU.z / 1000, 1e-9);
    const pose = coords.readPose(coords.parseMatrix(coords.matrixText(m)));
    close(pose.position.x, 0, 1e-6); close(pose.position.y, 8, 1e-6); close(pose.position.z, -4, 1e-6);
    close(Math.abs(((pose.yawDeg - yaw + 540) % 360) - 180), 0, 0.05);
    assert.equal(pose.standing, false);
  }
});

test('a standing fixture is flipped 180° about X and reads back as standing with its yaw', () => {
  const m = coords.poseMatrix({ x: 2, y: 1, z: 3 }, 30, true);
  close(m.w.z, -1, 1e-12);
  const pose = coords.readPose(m);
  assert.equal(pose.standing, true);
  close(pose.yawDeg, 30, 1e-9);
  // Right-handed: u × v = w.
  const cross = { x: m.u.y * m.v.z - m.u.z * m.v.y, y: m.u.z * m.v.x - m.u.x * m.v.z, z: m.u.x * m.v.y - m.u.y * m.v.x };
  close(cross.x, m.w.x, 1e-12); close(cross.y, m.w.y, 1e-12); close(cross.z, m.w.z, 1e-12);
});

test('matrix text uses the {u}{v}{w}{o} layout and malformed text falls back to identity', () => {
  assert.equal(coords.matrixText(coords.poseMatrix({ x: 1, y: 0, z: 0 }, 90)), '{0,1,0}{-1,0,0}{0,0,1}{1000,0,0}');
  assert.deepEqual(coords.parseMatrix('{1,2}{3}'), coords.IDENTITY);
  assert.deepEqual(coords.parseMatrix(undefined), coords.IDENTITY);
});

test('archives keep a flat root, refuse case-only name clashes and read nested entries by base name', () => {
  const bytes = writeArchive([
    { name: 'GeneralSceneDescription.xml', data: new TextEncoder().encode('<GeneralSceneDescription/>') },
    { name: 'deck.glb', data: new Uint8Array([1, 2, 3]) },
  ]);
  const files = readArchive(bytes);
  assert.deepEqual([...files.keys()].sort(), ['deck.glb', 'generalscenedescription.xml']);
  assert.throws(() => writeArchive([{ name: 'a.glb', data: new Uint8Array() }, { name: 'A.GLB', data: new Uint8Array() }]), /differ by more than case/);
  assert.throws(() => writeArchive([{ name: 'models/a.glb', data: new Uint8Array() }]), /not a valid MVR file name/);
  assert.throws(() => readArchive(new Uint8Array([1, 2, 3, 4])), /Cannot read this MVR archive/);
});

test('XML parsing strips trailing NULs, refuses DTDs and keeps repeated elements as lists', () => {
  const doc = parseXml('<Root><Layer name="A"><Fixture uuid="1"/></Layer></Root>\u0000\u0000');
  assert.equal(list(doc.Root, 'Layer').length, 1);
  assert.equal(attr(list(list(doc.Root, 'Layer')[0], 'Fixture')[0], 'uuid'), '1');
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), /DTD/);
  const round = parseXml(buildXml({ A: { '@_v': '1 & 2', B: 'x < y' } }));
  assert.equal(attr(round.A, 'v'), '1 & 2');
  assert.equal(text(round.A, 'B'), 'x < y');
});

test('generated GLB boxes are valid glTF 2.0 with the requested size', () => {
  const glb = boxGlb(4, 1, 2, { base: true });
  const view = new DataView(glb.buffer);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(8, true), glb.length);
  assert.equal(glb.length % 4, 0);
  assert.deepEqual(glbBounds(glb), { min: [-2, 0, -1], max: [2, 1, 1] });
});

test('XML parser prevents quadratic NUL hang, enforces nesting depth cap and strips control chars on build', () => {
  // H1: 1 MB of NULs followed by '<' must complete quickly without regex backtracking hang.
  const start = performance.now();
  assert.throws(() => parseXml('\u0000'.repeat(1_000_000) + '<'), (e) => e instanceof Error && !(e instanceof RangeError));
  assert.ok(performance.now() - start < 1000, 'NUL-prefixed XML must reject quickly');

  // M1: Deeply nested XML throws a readable depth Error instead of stack overflow.
  const deep = '<a>'.repeat(120) + '</a>'.repeat(120);
  assert.throws(() => parseXml(deep), /nested more than 64 levels/);

  // M5: Control characters are stripped on buildXml so output stays well-formed XML.
  const built = buildXml({ Root: { '@_name': 'Bad\u0001\u0007Name' } });
  assert.doesNotMatch(built, /[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  assert.equal(attr(parseXml(built).Root, 'name'), 'BadName');
});

test('archive reader rejects overlapping STORE entries and oversized declared sizes', () => {
  // Patch central directory of a STORE zip so size >> originalSize (H2).
  const bytes = writeArchive([{ name: 'a.glb', data: new Uint8Array(64) }]);
  const patched = new Uint8Array(bytes);
  let cdOff = -1;
  for (let i = 0; i <= patched.length - 46; i++) {
    if (patched[i] === 0x50 && patched[i + 1] === 0x4b && patched[i + 2] === 0x01 && patched[i + 3] === 0x02) {
      cdOff = i;
      break;
    }
  }
  assert.ok(cdOff > 0);
  const dv = new DataView(patched.buffer);
  dv.setUint32(cdOff + 20, 100_000, true); // compressed size > originalSize (64)
  assert.throws(() => readArchive(patched), /mismatched stored sizes|exceed/);

  // Patch XML entry declared originalSize > 64 MiB (H5).
  const xmlZip = writeArchive([{ name: 'GeneralSceneDescription.xml', data: new TextEncoder().encode('<a/>') }]);
  const bigXml = new Uint8Array(xmlZip);
  let xmlCd = -1;
  for (let i = 0; i <= bigXml.length - 46; i++) {
    if (bigXml[i] === 0x50 && bigXml[i + 1] === 0x4b && bigXml[i + 2] === 0x01 && bigXml[i + 3] === 0x02) {
      xmlCd = i;
      break;
    }
  }
  new DataView(bigXml.buffer).setUint32(xmlCd + 24, 70 * 1024 * 1024, true);
  assert.throws(() => readArchive(bigXml), /exceeds 64 MiB/);
});

test('glbBounds rejects hostile non-array min/max and readPose keeps near-horizontal mounts hung', () => {
  // H4: Hostile GLB with scalar min/max returns undefined (never throws TypeError).
  const payload = new TextEncoder().encode(JSON.stringify({
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: 5, max: 5 }],
  }));
  const jsonLen = (payload.length + 3) & ~3;
  const glb = new Uint8Array(20 + jsonLen);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, glb.length, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  glb.set(payload, 20);
  glb.fill(0x20, 20 + payload.length);
  assert.equal(glbBounds(glb), undefined);

  // M3: Horizontal boom mount with w.z = -6e-17 must NOT classify as floor-standing,
  // while a deliberately tilted standing fixture (w.z = -0.3) stays standing.
  const sideBoom = coords.readPose({
    u: { x: 0, y: 0, z: 1 },
    v: { x: 0, y: 1, z: 0 },
    w: { x: -1, y: 0, z: -6e-17 },
    o: { x: 5000, y: 0, z: 3000 },
  });
  assert.equal(sideBoom.standing, false);
  assert.ok(Number.isFinite(sideBoom.yawDeg));

  const tiltedFloor = coords.readPose({
    u: { x: 0, y: 0, z: -1 },
    v: { x: 0, y: -0.9539, z: 0.3 },
    w: { x: 0.9539, y: 0, z: -0.3 },
    o: { x: 0, y: 0, z: 0 },
  });
  assert.equal(tiltedFloor.standing, true);
  assert.ok(Number.isFinite(tiltedFloor.yawDeg));
});
