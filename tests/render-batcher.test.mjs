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
  assert.deepEqual(batcher.stats(), { batches: 1, instances: 3, released: 0 });
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
  assert.deepEqual(batcher.stats(), { batches: 1, instances: 4, released: 0 });
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
  assert.deepEqual(batcher.stats(), { batches: 2, instances: 5, released: 0 }, 'different blend colours split the batches');

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
