import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true },
});
after(() => server.close());
const { stageSnapshot, nameFixtureUnit } = await server.ssrLoadModule('/src/engine/stageGlb.ts');
const { buildPlatformDeck } = await server.ssrLoadModule('/src/engine/geometryBuilders.ts');
const mats = { stageDeck: new THREE.MeshStandardMaterial(), fixtureBody: new THREE.MeshStandardMaterial() };

test('overlapping platforms retain the exact batched surface area and their own names, pivots and dimensions', () => {
  const rig = { name: 'Two levels', venue: 'club', platforms: [
    { id: 'main', name: 'Main deck', x: 0, z: 0, width: 6, depth: 4, height: 1 },
    { id: 'rise', name: 'Riser', x: 1, z: 0, width: 2, depth: 2, height: 2 },
  ] };
  const live = buildPlatformDeck(rig, mats);
  live.userData.kind = 'platforms';
  const scene = stageSnapshot(rig, [live], mats);
  const deck = scene.getObjectByName('Main deck'), riser = scene.getObjectByName('Riser');
  assert.equal(deck.userData.id, 'main');
  assert.deepEqual(riser.userData, { id: 'rise', kind: 'platform', width: 2, depth: 2, height: 2 });
  assert.deepEqual(riser.position.toArray(), [1, 0, 0]);
  const triangles = group => {
    group.updateMatrixWorld(true);
    const result = [];
    const point = new THREE.Vector3();
    group.traverse(child => {
      if (!child.isMesh) return;
      const vertices = child.geometry.getAttribute('position');
      for (let v = 0; v < vertices.count; v += 3) {
        result.push(Array.from({ length: 3 }, (_, i) => point.fromBufferAttribute(vertices, v + i)
          .applyMatrix4(child.matrixWorld).toArray().join(',')).join('|'));
      }
    });
    return result.sort();
  };
  assert.deepEqual(triangles(scene), triangles(live));
  assert.equal(live.children.length, 2);
});

test('static snapshot freezes posed equipment, embeds LED geometry and expands scenic instances without show effects', () => {
  const rig = { name: 'Hardware', venue: 'club' };
  const truss = new THREE.Group();
  truss.name = 'Moving truss';
  truss.position.set(3, 6, -4);
  truss.rotation.z = 0.3;
  const lens = new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 0.6, 0.2) });
  const fixture = new THREE.Mesh(new THREE.BoxGeometry(), lens);
  const group = { type: 'beam', id: 'lights', modelName: 'Moving head', dmxUniverse: 1 };
  nameFixtureUnit(fixture, group, 1, 9);
  truss.add(fixture);
  const ray = new THREE.Mesh(new THREE.ConeGeometry(1, 10), new THREE.ShaderMaterial());
  ray.name = 'Volumetric beam';
  fixture.add(ray);
  const led = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial({ name: 'LED display',
    uniforms: { uCustomTex: { value: 'private-user-media' } } }));
  led.name = 'LED wall';
  const venue = new THREE.Group();
  venue.userData.kind = 'venue';
  venue.name = 'Crowd';
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(), mats.fixtureBody, 2);
  bulbs.name = 'Marquee bulbs';
  bulbs.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 2, 3));
  bulbs.setMatrixAt(1, new THREE.Matrix4().makeTranslation(4, 5, 6));

  const scene = stageSnapshot(rig, [truss, led, venue, bulbs], mats);
  const cloned = scene.getObjectByName('Moving head 2');
  assert.deepEqual(cloned.userData, { kind: 'beam', groupId: 'lights', model: 'Moving head', unit: 2, dmxUniverse: 1, dmxStartChannel: 9 });
  assert.notEqual(cloned.geometry, fixture.geometry);
  assert.notEqual(cloned.material, fixture.material);
  assert.equal(cloned.material.color.r, 1);
  assert.equal(lens.color.r, 2);
  assert.equal(scene.getObjectByName('Volumetric beam'), undefined);
  assert.equal(scene.getObjectByName('Crowd'), undefined);
  assert.equal(scene.getObjectByName('LED wall').material.type, 'MeshStandardMaterial');
  truss.position.y += 10;
  assert.equal(scene.getObjectByName('Moving truss').position.y, 6);
  const details = scene.getObjectByName('Marquee bulbs').children;
  assert.equal(details.length, 2);
  assert.deepEqual(details[1].position.toArray(), [4, 5, 6]);
  assert.equal(details[0].geometry, details[1].geometry);
  assert.equal(fixture.children[0], ray);
});
