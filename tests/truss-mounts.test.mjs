import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Group, Line3, MeshStandardMaterial, Vector3 } from 'three';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());
const { buildTrussGeometry } = await compiler.ssrLoadModule('/src/engine/geometryBuilders.ts');
const materials = { aluminumTruss: new MeshStandardMaterial(), chrome: new MeshStandardMaterial(), darkSteel: new MeshStandardMaterial() };
const path = [{ x: -5, z: 2 }, { x: 2, z: 2 }, { x: 2, z: -2 }];

test('lightly populated trusses keep their original mount grids', () => {
  for (const [shape, count] of [['box', 32], ['circle', 24], ['chevron', 16]]) {
    const original = buildTrussGeometry(shape, 20, materials).mountSlots;
    const sparse = buildTrussGeometry(shape, 20, materials, [], 8).mountSlots;
    assert.equal(original.length, count);
    assert.deepEqual(sparse, original);
  }
});

test('40 and 41 fixtures have distinct mounts on each transformed truss', () => {
  const pod = new Group();
  pod.position.set(7, 8, -4);
  pod.rotation.y = 0.71;
  const world = (x, z) => pod.localToWorld(new Vector3(x, -0.28, z));
  const pointOnTruss = (shape, position) => {
    if (shape === 'circle') {
      return Math.abs(position.distanceTo(world(0, 0)) - 10) < 1e-7;
    }
    const points = shape === 'box' ? [world(-10, 0), world(10, 0)]
      : shape === 'chevron' ? [world(-10, -10 * Math.tan(0.36)), world(0, 0), world(10, -10 * Math.tan(0.36))]
        : path.map(({ x, z }) => world(x, z));
    return points.slice(1).some((end, i) =>
      new Line3(points[i], end).closestPointToPoint(position, true, new Vector3()).distanceTo(position) < 1e-7);
  };
  for (const shape of ['box', 'circle', 'chevron', 'path']) {
    for (const count of [40, 41]) {
      const { mountSlots } = buildTrussGeometry(shape, 20, materials, path, count);
      const locations = new Set();
      for (let i = 0; i < count; i++) {
        const slot = mountSlots[Math.floor((i + 0.5) * mountSlots.length / count)];
        const position = pod.localToWorld(slot.pos.clone());
        assert.ok(pointOnTruss(shape, position), `${shape} fixture ${i} is off the truss`);
        assert.ok(Math.abs(position.y - 7.72) < 1e-7);
        locations.add(position.toArray().map(value => value.toFixed(7)).join(','));
      }
      assert.equal(locations.size, count, `${shape} fixtures share a mount`);
    }
  }
});
