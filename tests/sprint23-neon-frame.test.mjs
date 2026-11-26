import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';
import { createServer } from 'vite';

let server;
let neon;
let stageGlb;
let presets;
let authored;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  neon = await server.ssrLoadModule('/src/engine/neonFrame.ts');
  stageGlb = await server.ssrLoadModule('/src/engine/stageGlb.ts');
  presets = await server.ssrLoadModule('/src/data/presets.ts');
  authored = JSON.parse(await readFile(join(process.cwd(), 'tests', 'fixtures', 'native-authoring-v3.stageforge.show.json'), 'utf8'));
});

after(async () => {
  await server?.close();
});

describe('Sprint 23B: static neon architecture', () => {
  it('builds deterministic recognizable legacy and authored families within tier caps', () => {
    const legacyRig = structuredClone(presets.RIG_TEMPLATES.arena_mainstage);
    const legacyA = neon.buildNeonFrameSegments(legacyRig, [], 'low');
    const legacyB = neon.buildNeonFrameSegments(legacyRig, [], 'low');
    assert.deepEqual(legacyA, legacyB);
    assert.ok(legacyA.length <= 128);
    assert.equal(legacyA.filter((s) => s.sourceId === 'legacy:stage-lip').length, 1);
    assert.equal(legacyA.filter((s) => s.family === 'wing').length, 4);
    assert.equal(legacyA.filter((s) => s.sourceId.startsWith('screen:main-led')).length, 4);
    assert.equal(legacyA.filter((s) => s.sourceId.startsWith('screen:stock-wing')).length, 8);

    const authoredSegments = neon.buildNeonFrameSegments(authored.rig, authored.stage.walls, 'high');
    assert.ok(authoredSegments.length <= 512);
    assert.ok(authoredSegments.some((s) => s.sourceId.startsWith('platform:main-deck')));
    assert.ok(authoredSegments.some((s) => s.sourceId.startsWith('screen:main-led')));
    assert.ok(authoredSegments.some((s) => s.sourceId.startsWith('screen:side-led')));
    assert.equal(authoredSegments.filter((s) => s.family === 'wing').length, 4);
    for (const segment of authoredSegments) {
      assert.ok(segment.start.every(Number.isFinite));
      assert.ok(segment.end.every(Number.isFinite));
    }
  });

  it('keeps one static batch, bounded buffers, accessibility bypass, blackout and lifecycle cleanup', () => {
    const scene = new THREE.Scene();
    const controller = new neon.NeonFrameController(scene, 'high', 720);
    controller.setLayout(authored.rig, authored.stage.walls);
    controller.setPalette('#eaa64e', '#6fbbff');
    assert.deepEqual(controller.getStats(), {
      requested: false,
      allocated: false,
      active: false,
      suppressedReason: 'disabled',
      instanceCount: 0,
      capacity: 512,
      deckInstances: controller.getStats().deckInstances,
      wingInstances: 4,
      screenInstances: controller.getStats().screenInstances,
      addedDraws: 0,
      extraBufferBytes: 0,
      instanceBufferBytes: 0,
      geometryBufferBytes: 0,
    });

    controller.setPolicy(true, false);
    let stats = controller.getStats();
    assert.equal(stats.allocated, true);
    assert.equal(stats.active, true);
    assert.equal(stats.addedDraws, 1);
    assert.ok(stats.instanceCount > 0 && stats.instanceCount <= stats.capacity);
    assert.ok(stats.extraBufferBytes <= neon.NEON_FRAME_MAX_GPU_BYTES);
    const batch = scene.children.find((node) => node.userData.cosmeticLook === 'neonFrame');
    assert.ok(batch);
    const uploaded = new THREE.Color();
    const palette = new Set();
    for (let i = 0; i < batch.count; i++) {
      batch.getColorAt(i, uploaded);
      palette.add(uploaded.getHexString());
    }
    assert.deepEqual([...palette].sort(), [new THREE.Color('#eaa64e').getHexString(), new THREE.Color('#6fbbff').getHexString()].sort());
    assert.equal(scene.children.filter((node) => node.userData.cosmeticLook === 'neonFrame').length, 1);

    controller.setBlackout(true);
    stats = controller.getStats();
    assert.equal(stats.active, false);
    assert.equal(stats.suppressedReason, 'blackout');
    controller.setBlackout(false);
    const allocatedBatch = scene.children.find((node) => node.userData.cosmeticLook === 'neonFrame');
    controller.setMasterDimmer(0.4);
    assert.equal(scene.children.find((node) => node.userData.cosmeticLook === 'neonFrame'), allocatedBatch);
    assert.equal(controller.getStats().active, true);
    controller.setMasterDimmer(0);
    assert.equal(controller.getStats().active, false);
    assert.equal(controller.getStats().suppressedReason, 'master-dimmer');
    assert.equal(scene.children.find((node) => node.userData.cosmeticLook === 'neonFrame'), allocatedBatch);
    controller.setMasterDimmer(1);
    assert.equal(controller.getStats().active, true);
    controller.setViewportHeight(844);
    controller.onContextRestored();
    assert.equal(controller.getStats().active, true);

    controller.setPolicy(true, true);
    stats = controller.getStats();
    assert.equal(stats.allocated, false);
    assert.equal(stats.suppressedReason, 'true-colour');
    assert.equal(scene.children.some((node) => node.userData.cosmeticLook === 'neonFrame'), false);

    controller.setPolicy(true, false);
    assert.equal(controller.getStats().active, true);
    controller.dispose();
    assert.equal(controller.getStats().allocated, false);
    assert.equal(scene.children.some((node) => node.userData.cosmeticLook === 'neonFrame'), false);
  });

  it('defensively excludes cosmetic look nodes from GLB snapshots', () => {
    const cosmetic = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    cosmetic.name = 'must-not-export';
    cosmetic.userData.cosmeticLook = 'neonFrame';
    const authoredNode = new THREE.Group();
    authoredNode.name = 'authored-root';
    const snapshot = stageGlb.stageSnapshot(authored.rig, [authoredNode, cosmetic], {});
    assert.equal(snapshot.getObjectByName('must-not-export'), undefined);
    assert.ok(snapshot.getObjectByName('authored-root'));
    cosmetic.geometry.dispose();
    cosmetic.material.dispose();
  });
});
