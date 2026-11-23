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

const THREE = await compiler.ssrLoadModule('three');
const { aimAngles, focusMarks, focusPoint, HEAD_OFFSET, TILT_LIMIT, PAN_LIMIT, reachablePan, axisDmx, YOKE_OFFSET, FOCUS_NUDGE_RANGE } =
  await compiler.ssrLoadModule('/src/engine/focusAim.ts');
const { createBlankDesign, withPlatforms } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');
const { RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');

test('audience focus uses the full DMX travel and pans continuously across 180 degrees', () => {
  const radians = degrees => degrees * Math.PI / 180;
  assert.deepEqual([-135, -83, -79, 0, 135].map(d => axisDmx(radians(d), TILT_LIMIT)), [0, 49, 53, 128, 255]);
  for (const [from, target, expected] of [[179, -179, 181], [-179, 179, -181], [269, -85, -85]]) {
    assert.ok(Math.abs(reachablePan(radians(target), radians(from)) - radians(expected)) < 1e-10);
  }
  assert.equal(axisDmx(PAN_LIMIT, PAN_LIMIT), 255);
});

// Mirrors StageEngine.createMovingFixture: pod → root (slot yaw) → yoke (pan) → head (tilt).
function hang(isFloor, podRotation, slot, slotYaw) {
  const dir = isFloor ? 1 : -1;
  const pod = new THREE.Group();
  pod.position.set(1.5, isFloor ? 0 : 6, -3);
  pod.rotation.set(podRotation.x, podRotation.y, podRotation.z);
  const root = new THREE.Group();
  root.position.copy(slot);
  root.rotation.y = slotYaw;
  const yoke = new THREE.Group();
  yoke.position.y = dir * YOKE_OFFSET;
  const head = new THREE.Group();
  head.position.y = dir * HEAD_OFFSET;
  pod.add(root);
  root.add(yoke);
  yoke.add(head);
  return { root, yoke, head, dir };
}

function missDistance({ head, dir }, target) {
  head.updateWorldMatrix(true, false);
  const origin = head.getWorldPosition(new THREE.Vector3());
  const axis = new THREE.Vector3(0, dir, 0).applyMatrix4(head.matrixWorld).sub(origin).normalize();
  const toTarget = target.clone().sub(origin);
  assert.ok(toTarget.dot(axis) > 0, 'beam points away from the focus point');
  return toTarget.clone().cross(axis).length();
}

test('hung and floor heads converge on a focus point from any mount, pod angle and slot', () => {
  const targets = [new THREE.Vector3(0, 1.5, -2), new THREE.Vector3(4, 1, 3), new THREE.Vector3(-6, 0, 8)];
  for (const isFloor of [false, true]) {
    for (const podRotation of [{ x: 0, y: 0, z: 0 }, { x: 0.12, y: 0.8, z: -0.2 }, { x: 0, y: Math.PI, z: 0 }]) {
      for (const [slot, slotYaw] of [[new THREE.Vector3(0, 0, 0), 0], [new THREE.Vector3(3, 0, 1), 2.1]]) {
        const fixture = hang(isFloor, podRotation, slot, slotYaw);
        for (const target of targets) {
          if (isFloor && target.y <= 0.5) continue; // a floor head can't hit the floor beside it
          fixture.root.updateWorldMatrix(true, false);
          const local = fixture.root.worldToLocal(target.clone());
          const { pan, tilt } = aimAngles(local, isFloor, fixture.yoke.rotation.y, fixture.head.rotation.x);
          assert.ok(Math.abs(tilt) <= TILT_LIMIT + 1e-9);
          fixture.yoke.rotation.y = pan;
          fixture.head.rotation.x = tilt;
          assert.ok(missDistance(fixture, target) < 1e-6, `missed ${target.toArray()} (floor=${isFloor})`);
        }
      }
    }
  }
});

test('the solver keeps the current side of the yoke instead of flipping through 180°', () => {
  const local = { x: 1, y: -5, z: 2 };
  const a = aimAngles(local, false, 0, 0);
  const b = aimAngles(local, false, a.pan + Math.PI, -a.tilt);
  assert.ok(Math.abs(a.tilt + b.tilt) < 1e-9, 'expected the mirrored yoke solution');
});

test('focus points come from the deck modules, follow them, and include the audience', () => {
  const rig = withPlatforms(createBlankDesign(), [
    { id: 'deck', name: 'Main deck', x: 0, z: -1, width: 8, depth: 4, height: 1 },
    { id: 'riser', name: 'Drum riser', x: 0, z: -2, width: 3, depth: 2, height: 1.5 },
  ]);
  const marks = focusMarks(rig);
  assert.deepEqual(marks.map((m) => m.name), ['Main deck', 'Drum riser', 'Audience']);
  assert.deepEqual(marks[1], { id: 'platform:riser', name: 'Drum riser', x: 0, y: 1.5, z: -2 });
  assert.ok(marks[2].z > 1, 'audience sits downstage of the deck');

  const moved = withPlatforms(rig, rig.platforms.map((p) => (p.id === 'riser' ? { ...p, x: 2 } : p)));
  assert.equal(focusPoint(focusMarks(moved), 'platform:riser', 0, 0).x, 2);
  assert.equal(focusPoint(marks, 'platform:riser', 0.5, -0.25).x, 0.5 * FOCUS_NUDGE_RANGE);
  assert.equal(focusPoint(marks, 'platform:gone', 0, 0), null);

  // Templates without authored modules still get their deck as a focus point.
  assert.equal(focusMarks(RIG_TEMPLATES.arena_mainstage)[0].name, 'Main deck');
});
