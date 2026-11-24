import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const { RenderBatcher, BATCH_HIDDEN_LAYER, isBatchable, geometryHash, sameGeometry } = await compiler.ssrLoadModule('/src/engine/renderBatcher.ts');
const { VOLUMETRIC_BEAM_VARIANT, volumetricBeamProxy } = await compiler.ssrLoadModule('/src/engine/beamProxy.ts');
const { VOLUMETRIC_BEAM_VERT, VOLUMETRIC_BEAM_FRAG } = await compiler.ssrLoadModule('/src/engine/shaders.ts');

const hidden = new THREE.Layers();
hidden.set(BATCH_HIDDEN_LAYER);
const onHiddenLayer = (mesh) => mesh.layers.mask === hidden.mask;
const onDefaultLayer = (mesh) => mesh.layers.mask === new THREE.Layers().mask;
const instanceMatrix = (batch, i) => new THREE.Matrix4().fromArray(batch.instanceMatrix.array, i * 16);
/** Instance buffers are float32, so compare world matrices to float32 precision. */
const sameMatrix = (a, b) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) <= 1e-6 * Math.max(1, Math.abs(b.elements[i])));
const batches = (batcher) => batcher.group.children;

/** A rig root with `n` units, each a pod holding a body (shared geometry + material). */
function rig(n, { geometry = new THREE.BoxGeometry(1, 1, 1), material = new THREE.MeshStandardMaterial() } = {}) {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const bodies = [];
  for (let i = 0; i < n; i++) {
    const pod = new THREE.Group();
    pod.position.set(i * 2, 3, 0);
    const body = new THREE.Mesh(geometry, material);
    body.position.y = -0.5;
    pod.add(body);
    root.add(pod);
    bodies.push(body);
  }
  return { scene, root, bodies, geometry, material };
}

test('repeated parts draw as one instanced batch and follow their originals', () => {
  const { scene, root, bodies } = rig(3);
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  assert.equal(batches(batcher).length, 1);
  assert.deepEqual(batcher.stats(), { batches: 1, instances: 3, released: 0, proxied: 0 });
  assert.ok(bodies.every(onHiddenLayer), 'originals leave the rendered layer');
  const [batch] = batches(batcher);
  bodies.forEach((body, i) => assert.ok(sameMatrix(instanceMatrix(batch, i), body.matrixWorld)));

  // Animation moves an original's parent; the next render copies the new world matrix.
  const version = batch.instanceMatrix.version;
  bodies[1].parent.position.x = 40;
  bodies[1].parent.rotation.y = 0.7;
  scene.updateMatrixWorld();
  scene.onBeforeRender();
  assert.ok(sameMatrix(instanceMatrix(batch, 1), bodies[1].matrixWorld));
  assert.ok(batch.instanceMatrix.version > version, 'the changed matrices are re-uploaded');
  const settled = batch.instanceMatrix.version;
  scene.onBeforeRender();
  assert.equal(batch.instanceMatrix.version, settled, 'unchanged matrices are not re-uploaded');
});

test('hidden, detached or invisible-material originals draw nothing', () => {
  const { scene, root, bodies, material } = rig(3);
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  const [batch] = batches(batcher);
  const isZero = (i) => instanceMatrix(batch, i).determinant() === 0 && new THREE.Vector3().setFromMatrixScale(instanceMatrix(batch, i)).length() === 0;

  bodies[0].parent.visible = false;
  bodies[2].removeFromParent();
  batcher.sync();
  assert.ok(isZero(0), 'a hidden ancestor hides the instance');
  assert.ok(isZero(2), 'a detached original hides the instance');
  assert.ok(!isZero(1));

  material.visible = false;
  batcher.sync();
  assert.ok(isZero(1), 'material.visible = false hides the instance');
});

test('identical shapes built separately share a batch; different shapes do not', () => {
  const { scene, root } = rig(0);
  const material = new THREE.MeshStandardMaterial();
  for (let i = 0; i < 4; i++) root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), material));
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3.0001), material));
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  assert.deepEqual(batcher.stats(), { batches: 1, instances: 4, released: 0, proxied: 0 });
  assert.ok(onDefaultLayer(root.children[4]), 'a unique shape keeps rendering on its own');
});

test('lamps with their own materials share one white material and take colour per instance', () => {
  const { scene, root } = rig(0);
  const geometry = new THREE.CircleGeometry(0.2, 16);
  const lamps = [0xff0000, 0x00ff00, 0x0000ff].map((c) => new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: c })));
  const odd = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  root.add(...lamps, odd);
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  assert.equal(batcher.stats().instances, 3, 'different lamp settings (side) stay apart');
  const [batch] = batches(batcher);
  assert.deepEqual(batch.material.color.toArray(), [1, 1, 1]);
  assert.notEqual(batch.material, lamps[0].material, 'the batch owns a copy');
  const colour = (i) => Array.from(batch.instanceColor.array.slice(i * 3, i * 3 + 3));
  assert.deepEqual(colour(1), [0, 1, 0]);

  // The engine drives lamp brightness through colour, often above 1 for bloom.
  const version = batch.instanceColor.version;
  lamps[2].material.color.setRGB(3, 2, 0.5);
  batcher.sync();
  assert.deepEqual(colour(2), [3, 2, 0.5]);
  assert.ok(batch.instanceColor.version > version, 'new colours are re-uploaded');

  let disposed = 0;
  batch.material.addEventListener('dispose', () => disposed++);
  let sharedDisposed = 0;
  lamps[0].material.addEventListener('dispose', () => sharedDisposed++);
  geometry.addEventListener('dispose', () => sharedDisposed++);
  batcher.clear();
  assert.equal(disposed, 1, 'the white copy is freed');
  assert.equal(sharedDisposed, 0, "the originals' geometry and materials are left alone");
  assert.ok(lamps.every(onDefaultLayer));
});

test('transparent, custom-shader, mirrored, opted-out and ordered meshes are never batched', () => {
  const geometry = new THREE.BoxGeometry();
  const standard = new THREE.MeshStandardMaterial();
  const mirrored = new THREE.Mesh(geometry, standard);
  mirrored.scale.x = -1;
  const optedOut = new THREE.Mesh(geometry, standard);
  optedOut.userData.noBatch = true;
  const ordered = new THREE.Mesh(geometry, standard);
  ordered.renderOrder = -1;
  assert.equal(isBatchable(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ transparent: true }))), false);
  assert.equal(isBatchable(new THREE.Mesh(geometry, new THREE.ShaderMaterial())), false);
  assert.equal(isBatchable(optedOut), false);
  assert.equal(isBatchable(ordered), false);
  assert.equal(isBatchable(new THREE.InstancedMesh(geometry, standard, 2)), false);

  const { scene, root } = rig(0);
  root.add(mirrored, mirrored.clone());
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  assert.equal(batcher.stats().batches, 0, 'mirrored parts keep their own draw so winding stays correct');
});

test('a restyled original goes back to normal rendering', () => {
  const { scene, root, bodies } = rig(3);
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  bodies[1].material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  batcher.sync();
  assert.ok(onDefaultLayer(bodies[1]), 'released to the rendered layer');
  assert.equal(batcher.stats().released, 1);
  const [batch] = batches(batcher);
  assert.equal(new THREE.Vector3().setFromMatrixScale(instanceMatrix(batch, 1)).length(), 0);
  assert.ok(onHiddenLayer(bodies[0]) && onHiddenLayer(bodies[2]));
});

test('turning batching off and on, clearing and disposing restore everything', () => {
  const { scene, root, bodies } = rig(4);
  let previous = 0;
  scene.onBeforeRender = () => previous++;
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  scene.onBeforeRender();
  assert.equal(previous, 1, 'an existing scene hook still runs');

  batcher.setEnabled(false);
  assert.equal(batches(batcher).length, 0);
  assert.ok(bodies.every(onDefaultLayer));
  batcher.setEnabled(true);
  assert.equal(batcher.stats().instances, 4);

  // A rebuild replaces the batches rather than stacking them.
  batcher.rebuild(root);
  assert.equal(batches(batcher).length, 1);

  batcher.dispose();
  assert.ok(bodies.every(onDefaultLayer));
  assert.equal(batcher.group.parent, null);
  scene.onBeforeRender();
  assert.equal(previous, 2, 'the original hook is restored');
});

test('every lamp is checked against the settings it was batched with, unit 0 included', () => {
  const { scene, root } = rig(0);
  const geometry = new THREE.CircleGeometry(0.2, 12);
  // Equal values in separate objects (each material has its own blendColor) still share a batch.
  const lamps = [0, 1, 2].map(() => new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffaa00 })));
  const tinted = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  tinted.material.blendColor.setRGB(0.5, 0, 0);
  const tinted2 = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  tinted2.material.blendColor.setRGB(0.5, 0, 0);
  root.add(...lamps, tinted, tinted2);
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  assert.deepEqual(batcher.stats(), { batches: 2, instances: 5, released: 0, proxied: 0 }, 'different blend colours split the batches');

  // Restyling the first unit (the one the white copy was made from) must release it too.
  lamps[0].material.map = new THREE.Texture();
  lamps[1].material.opacity = 0.5;
  batcher.sync();
  assert.ok(onDefaultLayer(lamps[0]) && onDefaultLayer(lamps[1]));
  assert.ok(onHiddenLayer(lamps[2]));
  assert.equal(batcher.stats().released, 2);
});

test('a part mirrored or reordered after batching goes back to its own draw', () => {
  const { scene, root, bodies } = rig(3);
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  bodies[0].parent.scale.x = -1;
  bodies[2].renderOrder = 5;
  scene.updateMatrixWorld();
  batcher.sync();
  assert.ok(onDefaultLayer(bodies[0]), 'a mirrored part keeps correct winding by drawing alone');
  assert.ok(onDefaultLayer(bodies[2]), 'a part given a draw order keeps it');
  assert.ok(onHiddenLayer(bodies[1]));
});

test('each batch is culled with a sphere around its shown instances, and skipped when none are shown', () => {
  const { scene, root, bodies, geometry } = rig(3);
  const batcher = new RenderBatcher(scene);
  batcher.rebuild(root);
  const [batch] = batches(batcher);
  assert.notEqual(batch.frustumCulled, false);
  geometry.computeBoundingSphere();
  for (const body of bodies) {
    const sphere = geometry.boundingSphere.clone().applyMatrix4(body.matrixWorld);
    assert.ok(batch.boundingSphere.center.distanceTo(sphere.center) + sphere.radius <= batch.boundingSphere.radius + 1e-6);
  }
  // Moving a unit far away grows the sphere to include it.
  bodies[2].parent.position.set(0, 3, -50);
  scene.updateMatrixWorld();
  batcher.sync();
  const far = geometry.boundingSphere.clone().applyMatrix4(bodies[2].matrixWorld);
  assert.ok(batch.boundingSphere.center.distanceTo(far.center) + far.radius <= batch.boundingSphere.radius + 1e-6);

  for (const body of bodies) body.visible = false;
  batcher.sync();
  assert.equal(batch.visible, false, 'nothing shown: the batch is not drawn at all');
  bodies[1].visible = true;
  batcher.sync();
  assert.equal(batch.visible, true);
});

test('if batching fails the rig still renders, part by part', () => {
  const { scene, root, bodies } = rig(0);
  const material = new THREE.MeshStandardMaterial();
  for (let i = 0; i < 2; i++) {
    const geometry = new THREE.BoxGeometry();
    Object.defineProperty(geometry.attributes.position, 'array', { get() { throw new Error('unreadable'); } });
    const mesh = new THREE.Mesh(geometry, material);
    root.add(mesh);
    bodies.push(mesh);
  }
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  try {
    const batcher = new RenderBatcher(scene);
    assert.doesNotThrow(() => batcher.rebuild(root));
    assert.equal(batcher.stats().batches, 0);
    assert.ok(bodies.every(onDefaultLayer));
    assert.equal(warned, 1);
  } finally {
    console.warn = warn;
  }
});

test('geometry is matched byte for byte, including index type and draw groups', () => {
  const a = new THREE.BoxGeometry(1, 2, 3), b = new THREE.BoxGeometry(1, 2, 3);
  assert.ok(sameGeometry(a, b));
  assert.equal(geometryHash(a), geometryHash(b));

  const wide = b.clone();
  wide.setIndex(new THREE.BufferAttribute(Uint32Array.from(b.index.array), 1));
  assert.equal(sameGeometry(a, wide), false, 'a 32-bit index is a different buffer layout');
  assert.notEqual(geometryHash(a), geometryHash(wide));

  const nudged = b.clone();
  nudged.attributes.position.array[0] += 1e-6;
  assert.equal(sameGeometry(a, nudged), false);

  const regrouped = b.clone();
  regrouped.groups[0].materialIndex = 3;
  assert.equal(sameGeometry(a, regrouped), false);
  assert.equal(new THREE.Layers().mask, 1);
  assert.equal(hidden.mask, 2 ** 31, 'the hidden layer mask is unsigned');
});

test('shader proxy groups matching sources, syncs uniforms, hides, releases on key change, and disposes cleanly', () => {
  const { scene, root } = rig(0);
  const opaqueGeo = new THREE.BoxGeometry(1, 1, 1);
  const opaqueMat = new THREE.MeshStandardMaterial();
  const opaque = [0, 1].map(() => new THREE.Mesh(opaqueGeo, opaqueMat));
  root.add(...opaque);

  const makeProxyMat = (groupKey, colorHex, val, globalVal) => {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uGroupKey: { value: groupKey },
        uColor: { value: new THREE.Color(colorHex) },
        uVal: { value: val },
        uGlobal: { value: globalVal },
      },
    });
    mat.userData.fakeProxy = true;
    return mat;
  };

  const fakeProxy = {
    name: 'FakeProxy',
    match: (material) => Boolean(material.userData?.fakeProxy),
    key: (material, mesh) => `${mesh.renderOrder}|${material.blending}|${material.uniforms.uGroupKey.value}`,
    createMaterial: (source) => new THREE.ShaderMaterial({
      transparent: source.transparent,
      depthWrite: source.depthWrite,
      blending: source.blending,
      uniforms: { uGlobal: { value: source.uniforms.uGlobal.value } },
    }),
    attributes: [
      {
        name: 'instColor',
        itemSize: 3,
        write: (material, out, offset) => {
          const c = material.uniforms.uColor.value;
          out[offset] = c.r;
          out[offset + 1] = c.g;
          out[offset + 2] = c.b;
        },
      },
      {
        name: 'instVal',
        itemSize: 1,
        write: (material, out, offset) => {
          out[offset] = material.uniforms.uVal.value;
        },
      },
    ],
    sharedUniforms: ['uGlobal'],
  };

  const m0 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.5, 4, 8, 1, true), makeProxyMat('A', 0xff0000, 0.25, 1.5));
  const m1 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.5, 4, 8, 1, true), makeProxyMat('A', 0x00ff00, 0.75, 1.5));
  const m2 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.5, 4, 8, 1, true), makeProxyMat('B', 0x0000ff, 0.5, 1.5));
  m0.renderOrder = 3;
  m1.renderOrder = 3;
  m2.renderOrder = 3;
  root.add(m0, m1, m2);

  const batcher = new RenderBatcher(scene);
  batcher.registerShaderProxy(fakeProxy);
  batcher.rebuild(root);

  assert.deepEqual(batcher.stats(), { batches: 2, instances: 4, released: 0, proxied: 2 });
  assert.ok(onHiddenLayer(m0) && onHiddenLayer(m1));
  assert.ok(onDefaultLayer(m2), 'different proxy key stays unbatched');

  const proxyBatch = batches(batcher).find((b) => b.name === 'Batch: FakeProxy');
  assert.ok(proxyBatch);
  assert.equal(proxyBatch.renderOrder, 3);
  assert.equal(proxyBatch.material.transparent, true);
  assert.equal(proxyBatch.material.depthWrite, false);
  assert.equal(proxyBatch.material.blending, THREE.AdditiveBlending);
  assert.notEqual(proxyBatch.geometry, m0.geometry, 'proxy batch owns a cloned geometry');

  const instColor = proxyBatch.geometry.getAttribute('instColor');
  const instVal = proxyBatch.geometry.getAttribute('instVal');
  assert.deepEqual(Array.from(instColor.array), [1, 0, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(instVal.array), [0.25, 0.75]);
  assert.equal(proxyBatch.material.uniforms.uGlobal.value, 1.5);

  // Per-instance attributes and shared uniforms follow changes, and steady state does not re-upload.
  const colorVersion = instColor.version;
  const valVersion = instVal.version;
  m1.material.uniforms.uColor.value.setRGB(0.25, 0.5, 1);
  m1.material.uniforms.uVal.value = 0.9;
  m0.material.uniforms.uGlobal.value = 2.25;
  batcher.sync();
  assert.ok(instColor.version > colorVersion);
  assert.ok(instVal.version > valVersion);
  assert.deepEqual(Array.from(instColor.array.slice(3, 6)), [0.25, 0.5, 1]);
  assert.equal(Math.fround(instVal.array[1]), Math.fround(0.9));
  assert.equal(proxyBatch.material.uniforms.uGlobal.value, 2.25);
  const settledVersion = instVal.version;
  batcher.sync();
  assert.equal(instVal.version, settledVersion, 'unchanged attributes are not re-uploaded');

  // Hiding a source sets zero scale; shared uniform falls back to the first shown source.
  m0.visible = false;
  m1.material.uniforms.uGlobal.value = 3.5;
  batcher.sync();
  assert.equal(new THREE.Vector3().setFromMatrixScale(instanceMatrix(proxyBatch, 0)).length(), 0);
  assert.equal(proxyBatch.material.uniforms.uGlobal.value, 3.5);
  m1.visible = false;
  batcher.sync();
  assert.equal(proxyBatch.visible, false, 'batch hides when all sources are hidden');

  // Key change releases the affected source back to normal rendering.
  m0.visible = true;
  m1.visible = true;
  m0.material.uniforms.uGroupKey.value = 'C';
  batcher.sync();
  assert.ok(onDefaultLayer(m0), 'released back to default layer on key change');
  assert.ok(onHiddenLayer(m1));
  assert.equal(batcher.stats().released, 1);
  assert.equal(batcher.stats().proxied, 1, 'released proxy sources are excluded from active proxied count');
  assert.equal(new THREE.Vector3().setFromMatrixScale(instanceMatrix(proxyBatch, 0)).length(), 0);

  // Toggling proxies off keeps opaque batches while restoring proxy sources.
  m0.material.uniforms.uGroupKey.value = 'A';
  batcher.setProxiesEnabled(false);
  assert.deepEqual(batcher.stats(), { batches: 1, instances: 2, released: 0, proxied: 0 });
  assert.ok(onDefaultLayer(m0) && onDefaultLayer(m1));
  batcher.setProxiesEnabled(true);
  assert.deepEqual(batcher.stats(), { batches: 2, instances: 4, released: 0, proxied: 2 });

  // clear() disposes the cloned geometry and proxy material copy, leaving originals untouched.
  const activeProxyBatch = batches(batcher).find((b) => b.name === 'Batch: FakeProxy');
  let copyMatDisposed = 0;
  let copyGeoDisposed = 0;
  let origDisposed = 0;
  activeProxyBatch.material.addEventListener('dispose', () => copyMatDisposed++);
  activeProxyBatch.geometry.addEventListener('dispose', () => copyGeoDisposed++);
  m0.material.addEventListener('dispose', () => origDisposed++);
  m0.geometry.addEventListener('dispose', () => origDisposed++);
  batcher.clear();
  assert.equal(copyMatDisposed, 1, 'proxy material copy is disposed on clear()');
  assert.equal(copyGeoDisposed, 1, 'proxy cloned geometry is disposed on clear()');
  assert.equal(origDisposed, 0, 'original geometries and materials are untouched');
  assert.ok(onDefaultLayer(m0) && onDefaultLayer(m1));
});

test('volumetricBeamProxy batches moving-head beam shaders, tracks uniforms, and releases on key changes', () => {
  const { scene, root } = rig(0);
  const makeBeam = (lensOffset, seed, softness) => {
    const geo = new THREE.CylinderGeometry(0.1, 1.4, 16, 20, 1, true);
    geo.translate(0, -(8 + lensOffset), 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VOLUMETRIC_BEAM_VERT,
      fragmentShader: VOLUMETRIC_BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uLensOffset: { value: lensOffset },
        uColor: { value: new THREE.Color(0x00f0ff) },
        uIntensity: { value: 0.8 },
        uHaze: { value: 0.78 },
        uTime: { value: 0 },
        uPrism: { value: 0 },
        uSoftness: { value: softness },
        uSeed: { value: seed },
      },
    });
    mat.userData.instancedVariant = VOLUMETRIC_BEAM_VARIANT;
    return new THREE.Mesh(geo, mat);
  };

  const b0 = makeBeam(0.25, 0.731, 1.55);
  const b1 = makeBeam(0.25, 1.462, 2.4);
  const bOther = makeBeam(0.4, 2.193, 1.55);
  root.add(b0, b1, bOther);

  const batcher = new RenderBatcher(scene);
  batcher.registerShaderProxy(volumetricBeamProxy);
  batcher.rebuild(root);

  assert.deepEqual(batcher.stats(), { batches: 1, instances: 2, released: 0, proxied: 2 });
  assert.ok(onHiddenLayer(b0) && onHiddenLayer(b1));
  assert.ok(onDefaultLayer(bOther));

  const [batch] = batches(batcher);
  assert.equal(batch.material.defines.INSTANCED_BEAM, '');
  assert.equal(batch.material.uniforms.uLensOffset.value, 0.25);

  b1.material.uniforms.uColor.value.setRGB(1, 0.25, 0.5);
  b1.material.uniforms.uIntensity.value = 1.25;
  b1.material.uniforms.uPrism.value = 1;
  b0.material.uniforms.uHaze.value = 0.92;
  b0.material.uniforms.uTime.value = 7.5;
  batcher.sync();

  const colorAttr = batch.geometry.getAttribute('instColor');
  const paramsAttr = batch.geometry.getAttribute('instParams');
  assert.deepEqual(Array.from(colorAttr.array.slice(3, 6)), [1, 0.25, 0.5]);
  assert.deepEqual(Array.from(paramsAttr.array.slice(4, 8)), [1.25, 1, Math.fround(2.4), Math.fround(1.462)]);
  assert.equal(batch.material.uniforms.uHaze.value, 0.92);
  assert.equal(batch.material.uniforms.uTime.value, 7.5);

  // Changing uLensOffset releases that beam from the batch.
  b0.material.uniforms.uLensOffset.value = 0.5;
  batcher.sync();
  assert.ok(onDefaultLayer(b0));
  assert.equal(batcher.stats().released, 1);
  assert.equal(batcher.stats().proxied, 1);
});

test('QA regressions: needsUpdate stays batched, non-additive or swapped shader releases, setMode avoids double rebuild, throw recovery and zoomed culling sphere', () => {
  const { scene, root } = rig(0);
  const makeBeam = (lensOffset = 0.25) => {
    const geo = new THREE.CylinderGeometry(0.1, 1.4, 16, 20, 1, true);
    geo.translate(0, -(8 + lensOffset), 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VOLUMETRIC_BEAM_VERT,
      fragmentShader: VOLUMETRIC_BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uLensOffset: { value: lensOffset },
        uColor: { value: new THREE.Color(0x00f0ff) },
        uIntensity: { value: 0.8 },
        uHaze: { value: 0.78 },
        uTime: { value: 0 },
        uPrism: { value: 0 },
        uSoftness: { value: 1.55 },
        uSeed: { value: 0.5 },
      },
    });
    mat.userData.instancedVariant = VOLUMETRIC_BEAM_VARIANT;
    return new THREE.Mesh(geo, mat);
  };

  // M1/M2/L4: needsUpdate stays batched; NormalBlending, depthWrite=true, or swapped shader releases.
  const beams = [makeBeam(), makeBeam(), makeBeam(), makeBeam()];
  beams[0].scale.set(2.1, 1, 2.1);
  beams[1].scale.set(0.35, 1, 0.35);
  beams[2].position.set(12, 8, -4);
  beams[3].position.set(-12, 8, 4);
  root.add(...beams);

  const batcher = new RenderBatcher(scene);
  batcher.registerShaderProxy(volumetricBeamProxy);
  batcher.rebuild(root);
  assert.deepEqual(batcher.stats(), { batches: 1, instances: 4, released: 0, proxied: 4 });

  // Culling sphere encloses every corner of non-uniformly zoomed cones (wide and narrow).
  const [batch] = batches(batcher);
  const v = new THREE.Vector3();
  for (const beam of beams) {
    const pos = beam.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(beam.matrixWorld);
      assert.ok(batch.boundingSphere.center.distanceTo(v) <= batch.boundingSphere.radius + 1e-4);
    }
  }

  // Bumping needsUpdate alone must not release any beam.
  beams[0].material.needsUpdate = true;
  batcher.sync();
  assert.equal(batcher.stats().released, 0);
  assert.equal(batcher.stats().proxied, 4);

  // Switching away from additive blending, enabling depthWrite, or swapping shader releases the unit.
  beams[0].material.blending = THREE.NormalBlending;
  beams[1].material.depthWrite = true;
  beams[2].material.fragmentShader = 'void main() { gl_FragColor = vec4(1.0); }';
  batcher.sync();
  assert.ok(onDefaultLayer(beams[0]) && onDefaultLayer(beams[1]) && onDefaultLayer(beams[2]));
  assert.ok(onHiddenLayer(beams[3]));
  assert.equal(batcher.stats().released, 3);
  assert.equal(batcher.stats().proxied, 1);

  // M3: setMode(false, false) clears directly without triggering an intermediate rebuild.
  beams[0].material.blending = THREE.AdditiveBlending;
  beams[1].material.depthWrite = false;
  beams[2].material.fragmentShader = VOLUMETRIC_BEAM_FRAG;
  batcher.rebuild(root);
  let createCalls = 0;
  const origCreate = volumetricBeamProxy.createMaterial;
  const spyBatcher = new RenderBatcher(new THREE.Scene());
  spyBatcher.registerShaderProxy({
    ...volumetricBeamProxy,
    createMaterial(src) { createCalls++; return origCreate(src); },
  });
  const s2 = new THREE.Group();
  s2.add(makeBeam(), makeBeam());
  spyBatcher.rebuild(s2);
  assert.equal(createCalls, 1);
  spyBatcher.setMode(false, false);
  assert.equal(createCalls, 1, 'disabling both flags must not rebuild before clearing');
  assert.equal(spyBatcher.stats().batches, 0);
  spyBatcher.setMode(true, true);
  assert.equal(createCalls, 2);
  assert.equal(spyBatcher.stats().proxied, 2);

  // L3: throwing createMaterial leaves originals on layer 0 with zero batches.
  const badScene = new THREE.Scene();
  const badRoot = new THREE.Group();
  const badMeshes = [makeBeam(), makeBeam()];
  badRoot.add(...badMeshes);
  const badBatcher = new RenderBatcher(badScene);
  badBatcher.registerShaderProxy({
    ...volumetricBeamProxy,
    createMaterial() { throw new Error('compile failed'); },
  });
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  try {
    assert.doesNotThrow(() => badBatcher.rebuild(badRoot));
    assert.equal(badBatcher.stats().batches, 0);
    assert.ok(badMeshes.every(onDefaultLayer));
    assert.equal(warned, 1);
  } finally {
    console.warn = warn;
  }
});
