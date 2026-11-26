import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import * as THREE from 'three';

let server;
let litPuffsMod;
let particleMod;
let renderBatcherMod;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  litPuffsMod = await server.ssrLoadModule('/src/engine/litPuffs.ts');
  particleMod = await server.ssrLoadModule('/src/engine/ParticleSystem.ts');
  renderBatcherMod = await server.ssrLoadModule('/src/engine/renderBatcher.ts');
});

after(async () => {
  if (server) await server.close();
});

function makeBeam(overrides = {}) {
  return {
    index: 0,
    lastPreviewIntensity: 1.0,
    lastPreviewR: 0,
    lastPreviewG: 0.94,
    lastPreviewB: 1.0,
    lastZoomScale: 1.0,
    lensOffsetY: 0.16,
    optics: {
      length: 30,
      nearRadius: 0.12,
      farRadius: 1.0,
      fluxRatio: 1.0,
    },
    lastWorldX: 0,
    lastWorldY: 9.0,
    lastWorldZ: 0,
    lastAimX: 0,
    lastAimY: -1,
    lastAimZ: 0,
    ...overrides,
  };
}

function makeFrameCtx(overrides = {}) {
  return {
    blackout: false,
    master: 1,
    roomGain: 1,
    camPosX: 0,
    camPosY: 3.5,
    camPosZ: 24,
    camFwdX: 0,
    camFwdY: -0.08,
    camFwdZ: -0.9968,
    ...overrides,
  };
}

describe('Sprint 20: default-off zero cost, memory ceiling & live toggle lifecycle', () => {
  it('allocates zero optional CPU/GPU buffers by default, stays well below 0.1 MiB on both tiers, and excludes VaporBatch from RenderBatcher', () => {
    for (const tier of ['low', 'high']) {
      const p = new particleMod.AtmosphericParticles(tier, 777);
      const statsOff = p.getLitPuffsStats();
      assert.equal(statsOff.requested, false);
      assert.equal(statsOff.allocated, false);
      assert.equal(statsOff.active, false);
      assert.equal(statsOff.suppressedReason, 'disabled');
      assert.equal(statsOff.extraBufferBytes, 0);
      assert.equal(statsOff.smokeRenderOrder, 0);
      assert.equal(statsOff.cryoRenderOrder, 0);

      for (const child of p.group.children) {
        assert.equal(child.userData.noBatch, true);
        assert.equal(child.geometry.getAttribute('broadLight'), undefined);
        assert.equal(child.geometry.getAttribute('lobeLight'), undefined);
        assert.equal(child.geometry.getAttribute('lobeOffset'), undefined);
      }

      // Verify RenderBatcher leaves particle group untouched even if rebuilt directly on a parent scene.
      const scene = new THREE.Scene();
      scene.add(p.group);
      const batcher = new renderBatcherMod.RenderBatcher(scene);
      batcher.rebuild(p.group);
      assert.equal(batcher.stats().batches, 0);
      assert.equal(batcher.stats().instances, 0);
      batcher.dispose();

      // Enable litPuffs and verify exact byte accounting & tier caps.
      p.setLitPuffs(true);
      const statsOn = p.getLitPuffsStats();
      assert.equal(statsOn.requested, true);
      assert.equal(statsOn.allocated, true);
      assert.equal(statsOn.active, true);
      assert.equal(statsOn.suppressedReason, null);
      assert.equal(statsOn.candidateCap, tier === 'high' ? 16 : 8);
      assert.equal(statsOn.beamsPerPuffCap, tier === 'high' ? 4 : 2);
      const expectedBytes = tier === 'high' ? (260 + 420) * 40 : (120 + 180) * 40;
      assert.equal(statsOn.extraBufferBytes, expectedBytes);
      assert.ok(statsOn.extraBufferBytes <= litPuffsMod.MAX_LIT_PUFFS_EXTRA_BYTES);
      assert.ok(statsOn.extraBufferBytes < 102_400);

      // Disable again -> optional attributes removed and renderOrder restored to 0.
      p.setLitPuffs(false);
      const statsRestored = p.getLitPuffsStats();
      assert.equal(statsRestored.allocated, false);
      assert.equal(statsRestored.extraBufferBytes, 0);
      assert.equal(statsRestored.smokeRenderOrder, 0);
      assert.equal(statsRestored.cryoRenderOrder, 0);
      for (const child of p.group.children) {
        assert.equal(child.geometry.getAttribute('broadLight'), undefined);
      }
      p.dispose();
    }
  });
});

describe('Sprint 20: seeded simulation invariance & cryo eviction safety', () => {
  it('keeps physics & RNG streams bit-identical between litPuffs off/on and resets lighting on fallingCo2 slot eviction', () => {
    const smokeEm = [new THREE.Vector3(-2, 0, 1), new THREE.Vector3(2, 0, 1)];
    const co2Em = [new THREE.Vector3(-3, 0, 4), new THREE.Vector3(3, 0, 4)];
    const tint = new THREE.Color('#00f0ff');
    const beams = [
      makeBeam({ index: 0, lastWorldX: -2, lastWorldZ: 2.8, lastPreviewR: 0, lastPreviewG: 1, lastPreviewB: 1 }),
      makeBeam({ index: 1, lastWorldX: 3, lastWorldZ: 4.3, lastPreviewR: 1, lastPreviewG: 0, lastPreviewB: 0.5 }),
    ];
    const lighting = {
      beams,
      blackout: false,
      master: 1,
      roomGain: 1,
      camPosX: 0,
      camPosY: 4,
      camPosZ: 24,
      camFwdX: 0,
      camFwdY: -0.1,
      camFwdZ: -0.995,
    };

    const pOff = new particleMod.AtmosphericParticles('low', 90210);
    const pOn = new particleMod.AtmosphericParticles('low', 90210);
    pOff.setEmitters(smokeEm, co2Em, 0);
    pOn.setEmitters(smokeEm, co2Em, 0);
    pOn.setLitPuffs(true, lighting);

    for (let step = 0; step < 90; step++) {
      pOff.update(1 / 60, step / 60, 0.5, 1.0, true, tint, 1.0, lighting);
      pOn.update(1 / 60, step / 60, 0.5, 1.0, true, tint, 1.0, lighting);
    }

    // Physics / RNG state must be 100% identical despite back-to-front upload sorting on pOn!
    assert.deepEqual(pOn.debugSnapshot(), pOff.debugSnapshot());
    assert.ok(pOn.getLitPuffsStats().litSmokePuffs > 0);
    assert.ok(pOn.getLitPuffsStats().litCryoPuffs > 0);

    pOn.setFallingCo2(true);
    for (let step = 0; step < 220; step++) {
      pOn.update(1 / 60, step / 60, 0.4, 0, true, tint, 1.0, lighting);
    }
    const cryoAlive = pOn.getStats().cryo.alive;
    assert.ok(cryoAlive > 100 && cryoAlive <= 180, `expected bounded fallingCo2 count, got ${cryoAlive}`);
    const poolState = new litPuffsMod.LitPuffPoolState(4);
    poolState.initSlot(0, 1);
    poolState.broadR[0] = 0.9;
    poolState.initialized[0] = 1;
    poolState.initSlot(0, 2);
    assert.equal(poolState.broadR[0], 0);
    assert.equal(poolState.initialized[0], 0);
    assert.equal(poolState.spawnSeq[0], 2);

    pOff.dispose();
    pOn.dispose();
  });
});

describe('Sprint 20: candidate selection, separate smoke/cryo bounds & hysteresis', () => {
  it('prioritizes separated CO2 emitters alongside smoke clouds, enforces 8/16 caps, and retains candidates via 1.18x hysteresis', () => {
    const lowSet = new litPuffsMod.LitCandidateSet(litPuffsMod.candidateCapForTier('low'));
    const highSet = new litPuffsMod.LitCandidateSet(litPuffsMod.candidateCapForTier('high'));
    assert.equal(lowSet.capacity, 8);
    assert.equal(highSet.capacity, 16);

    const smokeRegion = { active: true, cx: -6, cy: 2.2, cz: -3, radius: 2.5 };
    const cryoRegion = { active: false, cx: 0, cy: 2, cz: 0, radius: 2.0 };
    const smokeEm = [new THREE.Vector3(-6, 0, -3)];
    const co2Em = [new THREE.Vector3(7, 0, 5)];
    const frame = makeFrameCtx();

    // 19 far off-stage beams + 1 beam aimed straight through the separated downstage-right CO2 emitter (7, 1.4, 5)
    const beams = [];
    for (let i = 0; i < 19; i++) {
      beams.push(makeBeam({
        index: i,
        lastWorldX: -40 - i * 2,
        lastWorldY: 12,
        lastWorldZ: -30,
        lastPreviewIntensity: 1.0,
      }));
    }
    beams.push(makeBeam({
      index: 99,
      lastWorldX: 7,
      lastWorldY: 9,
      lastWorldZ: 5,
      lastPreviewIntensity: 0.95,
    }));

    const selectedLow = lowSet.select(beams, frame, smokeRegion, cryoRegion, smokeEm, co2Em);
    assert.equal(selectedLow, 8);
    const chosenIndices = Array.from(lowSet.fixtureIndex.subarray(0, selectedLow));
    assert.equal(chosenIndices[0], 99, 'beam aimed through separated CO2 emitter must rank #1 despite smoke cloud at (-6,-3)');

    // Hysteresis check: 8 incumbent beams at intensity 1.0 vs challenger #8 at intensity 1.08 (< 1.18x) -> incumbent stays;
    // at intensity 1.25 (> 1.18x) -> challenger enters!
    const hSet = new litPuffsMod.LitCandidateSet(8);
    const base9 = Array.from({ length: 9 }, (_, i) =>
      makeBeam({ index: i, lastWorldX: 0, lastWorldZ: 0, lastPreviewIntensity: i < 8 ? 1.0 : 0.90 })
    );
    hSet.select(base9, frame, smokeRegion, cryoRegion, [], []);
    assert.deepEqual(Array.from(hSet.fixtureIndex), [0, 1, 2, 3, 4, 5, 6, 7]);

    // Nudge challenger #8 to 1.10 (still below incumbent 1.0 * 1.18 = 1.18) -> no churn!
    base9[8].lastPreviewIntensity = 1.10;
    hSet.select(base9, frame, smokeRegion, cryoRegion, [], []);
    assert.equal(Array.from(hSet.fixtureIndex).includes(8), false);

    // Raise challenger #8 to 1.26 (> 1.18) -> cleanly admitted!
    base9[8].lastPreviewIntensity = 1.26;
    hSet.select(base9, frame, smokeRegion, cryoRegion, [], []);
    assert.equal(hSet.fixtureIndex[0], 8);

    // Blackout clears candidates and resets hysteresis memory.
    assert.equal(hSet.select(base9, makeFrameCtx({ blackout: true }), smokeRegion, cryoRegion, [], []), 0);
  });
});

describe('Sprint 20: crossing coloured beams, top-K cap (2 low / 4 high), cryo vs smoke scatter & blackout', () => {
  it('separates dominant shaft lobe from crossing-beam broad scatter, caps at 2/4 beams, scatters cryo brighter than smoke, and zeroes instantly on blackout', () => {
    const frame = makeFrameCtx();
    const smokeRegion = { active: true, cx: 0, cy: 2.5, cz: 0, radius: 3.0 };
    const emptyRegion = { active: false, cx: 0, cy: 2, cz: 0, radius: 2 };

    // Five distinct overlapping beams hitting puff at (0, 2.5, 0), diam = 2.4 m (rPuff = 1.2 m),
    // ordered monotonically in irradiance so #0 cyan (-0.30 m) > #1 magenta (+0.35 m) > #2 green > #3 blue > #4 red:
    const fiveBeams = [
      makeBeam({ index: 0, lastWorldX: -0.30, lastPreviewIntensity: 1.0, lastPreviewR: 0, lastPreviewG: 1, lastPreviewB: 1, optics: { length: 30, nearRadius: 0.10, farRadius: 0.35, fluxRatio: 1 } }),
      makeBeam({ index: 1, lastWorldX: 0.35, lastPreviewIntensity: 0.92, lastPreviewR: 1, lastPreviewG: 0, lastPreviewB: 1, optics: { length: 30, nearRadius: 0.10, farRadius: 0.35, fluxRatio: 1 } }),
      makeBeam({ index: 2, lastWorldX: 0.42, lastPreviewIntensity: 0.72, lastPreviewR: 0, lastPreviewG: 1, lastPreviewB: 0, optics: { length: 30, nearRadius: 0.12, farRadius: 0.45, fluxRatio: 1 } }),
      makeBeam({ index: 3, lastWorldX: -0.45, lastPreviewIntensity: 0.64, lastPreviewR: 0, lastPreviewG: 0, lastPreviewB: 1, optics: { length: 30, nearRadius: 0.12, farRadius: 0.45, fluxRatio: 1 } }),
      makeBeam({ index: 4, lastWorldX: 0.50, lastPreviewIntensity: 0.55, lastPreviewR: 1, lastPreviewG: 0, lastPreviewB: 0, optics: { length: 30, nearRadius: 0.12, farRadius: 0.45, fluxRatio: 1 } }),
    ];

    const cands = new litPuffsMod.LitCandidateSet(16);
    cands.select(fiveBeams, frame, smokeRegion, emptyRegion, [], []);
    assert.equal(cands.count, 5);

    const lowState = new litPuffsMod.LitPuffPoolState(2);
    const highState = new litPuffsMod.LitPuffPoolState(2);

    // Low tier (K = 2): only beam #0 (cyan: G+B) and beam #1 (magenta: R+B) may contribute!
    // Notice beam #0 has R = 0, so lobeR MUST be 0 (dominant cyan shaft is NOT polluted by magenta's R!),
    // while broadR > 0 comes from crossing magenta beam #1!
    const litLow = litPuffsMod.evaluateSinglePuffLighting(0, 0, 2.5, 0, 2.4, false, 0, 2, cands, frame, lowState);
    assert.equal(litLow, true);
    assert.equal(lowState.lobeR[0], 0, 'dominant cyan lobe must not carry secondary magenta R channel');
    assert.ok(lowState.lobeG[0] > 0.1 && lowState.lobeB[0] > 0.1, 'dominant cyan lobe carries cyan G+B');
    assert.ok(lowState.offX[0] < -0.1, 'lobe world offset points toward -X where cyan shaft slices puff');
    assert.ok(lowState.broadR[0] > 0.1, 'crossing magenta beam contributes to broad scatter');

    // Verify 5th beam (#4 pure red) is strictly excluded even on high tier (K = 4):
    // Set beams 0..3 to have R = 0 and beam #4 to have R = 1 -> high tier (K = 4) must produce exact R === 0!
    const noRedTop4 = fiveBeams.map((b, idx) =>
      idx < 4 ? { ...b, lastPreviewR: 0, lastPreviewG: 0.8, lastPreviewB: 0.8 } : { ...b, lastPreviewR: 1, lastPreviewG: 0, lastPreviewB: 0 }
    );
    cands.select(noRedTop4, frame, smokeRegion, emptyRegion, [], []);
    litPuffsMod.evaluateSinglePuffLighting(0, 0, 2.5, 0, 2.4, false, 0, 4, cands, frame, highState);
    assert.equal(highState.broadR[0], 0, '5th beam must be excluded by high-tier 4-beam-per-puff cap');
    assert.equal(highState.lobeR[0], 0);

    // Cryo vs smoke scatter gain: cryo scatters brighter than smoke under identical geometry.
    const smokeCompare = new litPuffsMod.LitPuffPoolState(1);
    const cryoCompare = new litPuffsMod.LitPuffPoolState(1);
    litPuffsMod.evaluateSinglePuffLighting(0, 0, 2.5, 0, 2.0, false, 0, 2, cands, frame, smokeCompare);
    litPuffsMod.evaluateSinglePuffLighting(0, 0, 2.5, 0, 2.0, true, 0, 2, cands, frame, cryoCompare);
    const smokeTotalG = smokeCompare.broadG[0] + smokeCompare.lobeG[0];
    const cryoTotalG = cryoCompare.broadG[0] + cryoCompare.lobeG[0];
    assert.ok(cryoTotalG > smokeTotalG * 1.10, `expected cryo scatter (${cryoTotalG}) > smoke scatter (${smokeTotalG})`);

    // Blackout immediately zeroes smoothed puff lighting even when dt > 0!
    litPuffsMod.evaluateSinglePuffLighting(0, 0, 2.5, 0, 2.0, true, 1 / 60, 2, cands, makeFrameCtx({ blackout: true }), cryoCompare);
    assert.equal(cryoCompare.broadG[0], 0);
    assert.equal(cryoCompare.lobeG[0], 0);
    assert.equal(cryoCompare.initialized[0], 0);
  });
});

describe('Sprint 20: rotated billboard UV lobe inverse, stereo viewMatrix, near-camera fade & soft-knee clamp', () => {
  it('maps world beam offsets onto exact rotated quad UVs across stereo eye poses, fades near camera, and preserves hue under clamp', () => {
    const leftEyeCam = new THREE.PerspectiveCamera(50, 1.5, 0.18, 200);
    leftEyeCam.position.set(-0.032, 2.5, 12);
    leftEyeCam.lookAt(0.4, 2.2, 0);
    leftEyeCam.updateMatrixWorld(true);
    const viewMatrix = leftEyeCam.matrixWorldInverse;

    const rightEyeCam = new THREE.PerspectiveCamera(50, 1.5, 0.18, 200);
    rightEyeCam.position.set(0.032, 2.5, 12);
    rightEyeCam.lookAt(0.4, 2.2, 0);
    rightEyeCam.updateMatrixWorld(true);

    // Construct an exact eye-space displacement generated by quad UV (u = 0.72, v = 0.34 -> uvDelta = (0.22, -0.16))
    // rotated by rotationRad = 0.93 rad with diameter = 2.6 m and aspect = 1.18:
    const rot = 0.93;
    const diam = 2.6;
    const aspect = 1.18;
    const targetDu = 0.22;
    const targetDv = -0.16;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const offX = targetDu * aspect * diam;
    const offY = targetDv * diam;
    // Forward billboard map in VAPOR_VERT_LIT: `mat2(c, s, -s, c) * offset`
    const eyeDx = c * offX - s * offY;
    const eyeDy = s * offX + c * offY;
    // Convert eye displacement back to world vector via camera world matrix:
    const worldOffset = new THREE.Vector3(eyeDx, eyeDy, 0).applyMatrix4(
      new THREE.Matrix4().extractRotation(leftEyeCam.matrixWorld),
    );

    const resLeft = litPuffsMod.evaluateLitPuffFragmentOracle({
      texUv: { u: 0.5 + targetDu, v: 0.5 + targetDv },
      vaporSample: { r: 0.85, a: 0.7 },
      tint: { r: 0.05, g: 0.06, b: 0.08 },
      centerWorld: { x: 0, y: 2.3, z: 2 },
      diameter: diam,
      rotationRad: rot,
      opacity: 0.3,
      aspect,
      broadLight: { r: 0.02, g: 0.08, b: 0.12 },
      lobeLight: { r: 0.0, g: 0.45, b: 0.50 },
      lobeWorldOffset: { x: worldOffset.x, y: worldOffset.y, z: worldOffset.z, conc: 4.5 },
      viewMatrix,
    });
    assert.ok(Math.abs(resLeft.lobeUv.u - targetDu) < 1e-6);
    assert.ok(Math.abs(resLeft.lobeUv.v - targetDv) < 1e-6);
    assert.equal(resLeft.nearFade, 1);

    // Opposite corner of quad is dimmer than the localized shaft peak:
    const resFarCorner = litPuffsMod.evaluateLitPuffFragmentOracle({
      texUv: { u: 0.10, v: 0.90 },
      vaporSample: { r: 0.85, a: 0.7 },
      tint: { r: 0.05, g: 0.06, b: 0.08 },
      centerWorld: { x: 0, y: 2.3, z: 2 },
      diameter: diam,
      rotationRad: rot,
      opacity: 0.3,
      aspect,
      broadLight: { r: 0.02, g: 0.08, b: 0.12 },
      lobeLight: { r: 0.0, g: 0.45, b: 0.50 },
      lobeWorldOffset: { x: worldOffset.x, y: worldOffset.y, z: worldOffset.z, conc: 4.5 },
      viewMatrix,
    });
    assert.ok(resLeft.g > resFarCorner.g * 1.6);

    // Right stereo eye produces a distinct stereo-consistent view projection with zero CPU camera caching:
    const resRight = litPuffsMod.evaluateLitPuffFragmentOracle({
      texUv: { u: 0.5 + targetDu, v: 0.5 + targetDv },
      vaporSample: { r: 0.85, a: 0.7 },
      tint: { r: 0.05, g: 0.06, b: 0.08 },
      centerWorld: { x: 0, y: 2.3, z: 2 },
      diameter: diam,
      rotationRad: rot,
      opacity: 0.3,
      aspect,
      broadLight: { r: 0.02, g: 0.08, b: 0.12 },
      lobeLight: { r: 0.0, g: 0.45, b: 0.50 },
      lobeWorldOffset: { x: worldOffset.x, y: worldOffset.y, z: worldOffset.z, conc: 4.5 },
      viewMatrix: rightEyeCam.matrixWorldInverse,
    });
    assert.equal(resRight.discarded, false);

    // Near-camera fade: puff 0.25 m in front of camera (`<= 0.35 m`) fades cleanly to 0 (`discarded: true`)!
    const nearPos = leftEyeCam.position.clone().add(
      leftEyeCam.getWorldDirection(new THREE.Vector3()).multiplyScalar(0.25),
    );
    const resTooClose = litPuffsMod.evaluateLitPuffFragmentOracle({
      texUv: { u: 0.5, v: 0.5 },
      vaporSample: { r: 0.9, a: 0.9 },
      tint: { r: 0.2, g: 0.2, b: 0.2 },
      centerWorld: { x: nearPos.x, y: nearPos.y, z: nearPos.z },
      diameter: 3.0,
      rotationRad: 0,
      opacity: 0.72,
      aspect: 1,
      broadLight: { r: 2, g: 2, b: 2 },
      lobeLight: { r: 2, g: 2, b: 2 },
      lobeWorldOffset: { x: 0, y: 0, z: 0, conc: 2 },
      viewMatrix,
    });
    assert.equal(resTooClose.nearFade, 0);
    assert.equal(resTooClose.discarded, true);

    // Extreme HDR input preserves exact RGB hue ratios and stays strictly <= LIT_PUFFS_MAX_ADDED_RADIANCE (0.62):
    const resExtreme = litPuffsMod.evaluateLitPuffFragmentOracle({
      texUv: { u: 0.5, v: 0.5 },
      vaporSample: { r: 1.0, a: 0.8 },
      tint: { r: 0.1, g: 0.1, b: 0.1 },
      centerWorld: { x: 0, y: 2.3, z: 2 },
      diameter: 2.0,
      rotationRad: 0,
      opacity: 0.5,
      aspect: 1,
      broadLight: { r: 10.0, g: 5.0, b: 2.5 },
      lobeLight: { r: 0, g: 0, b: 0 },
      lobeWorldOffset: { x: 0, y: 0, z: 0, conc: 0 },
      viewMatrix,
    });
    assert.ok(resExtreme.added.r <= litPuffsMod.LIT_PUFFS_MAX_ADDED_RADIANCE);
    assert.ok(Math.abs(resExtreme.added.r / resExtreme.added.g - 2.0) < 1e-6);
    assert.ok(Math.abs(resExtreme.added.g / resExtreme.added.b - 2.0) < 1e-6);
  });
});

describe('Sprint 20: intra-batch depth sorting, spawnSeq tie-breaking & inter-batch hysteresis', () => {
  it('sorts puffs back-to-front across camera flips, preserves equal-depth order via spawnSeq, and deadbands smoke/cryo batch order', () => {
    const depths = new Float32Array([8.0, 14.5, 11.2, 14.50004, 5.1]);
    const spawnSeq = new Uint32Array([40, 22, 15, 9, 50]);
    const order = new Uint16Array(5);
    litPuffsMod.sortPuffsBackToFront(5, depths, spawnSeq, order);
    // Slots 1 (14.5, seq 22) and 3 (14.50004, seq 9) are within 1e-4 m -> seq 9 (slot 3) draws BEFORE seq 22 (slot 1)!
    assert.deepEqual(Array.from(order), [3, 1, 2, 0, 4]);

    // Inter-batch smoke vs cryo renderOrder hysteresis (`±0.30 m` deadband):
    let r = litPuffsMod.resolveSmokeCryoRenderOrder(20, 16.0, 30, 12.0, true);
    assert.deepEqual(r, { smokeOrder: 1, cryoOrder: 2, smokeFirst: true });

    // Inside deadband (-0.20 m): holds smokeFirst = true without flickering!
    r = litPuffsMod.resolveSmokeCryoRenderOrder(20, 12.0, 30, 12.20, r.smokeFirst);
    assert.equal(r.smokeFirst, true);
    assert.equal(r.smokeOrder, 1);

    // Beyond deadband (-0.45 m, cryo farther than smoke): flips cleanly!
    r = litPuffsMod.resolveSmokeCryoRenderOrder(20, 12.0, 30, 12.45, r.smokeFirst);
    assert.deepEqual(r, { smokeOrder: 2, cryoOrder: 1, smokeFirst: false });

    // End-to-end AtmosphericParticles camera flip reverses uploaded instance order without changing physics:
    const p = new particleMod.AtmosphericParticles('low', 31415);
    p.setEmitters([new THREE.Vector3(0, 0, -4), new THREE.Vector3(0, 0, 4)], [], 0);
    p.setLitPuffs(true);
    const tint = new THREE.Color('#ffffff');
    const fohLighting = {
      beams: [makeBeam()],
      blackout: false,
      master: 1,
      roomGain: 1,
      camPosX: 0,
      camPosY: 3,
      camPosZ: 20,
      camFwdX: 0,
      camFwdY: 0,
      camFwdZ: -1,
    };
    for (let i = 0; i < 30; i++) {
      p.update(1 / 60, i / 60, 0, 1.0, false, tint, 1.0, fohLighting);
    }
    const fohUploaded = p.debugUploadedBatches().smoke.centers;
    assert.ok(fohUploaded.length >= 4);
    // Looking toward -Z: first uploaded puff has smaller Z (farther upstage) than last uploaded puff!
    assert.ok(fohUploaded[0][2] <= fohUploaded[fohUploaded.length - 1][2] + 1e-4);

    // Flip camera behind stage looking +Z at frozen frame (dt = 0):
    p.syncLitFromCommittedState({
      ...fohLighting,
      camPosZ: -20,
      camFwdZ: 1,
    });
    const rearUploaded = p.debugUploadedBatches().smoke.centers;
    assert.ok(rearUploaded[0][2] >= rearUploaded[rearUploaded.length - 1][2] - 1e-4);
    p.dispose();
  });
});

describe('Sprint 20: WebGL1/WebGL2 shader compatibility, context restore & docs', () => {
  it('uses loop-free WebGL1-compatible GLSL, marks resources dirty on context restore, and documents scoped bounds', () => {
    for (const src of [litPuffsMod.VAPOR_VERT_LIT, litPuffsMod.VAPOR_FRAG_LIT]) {
      assert.equal(/dFdx|dFdy|fwidth|\bflat\s|\bivec|\buvec|\bfor\s*\(|\bwhile\s*\(/.test(src), false);
    }

    const p = new particleMod.AtmosphericParticles('high', 555);
    p.setEmitters([new THREE.Vector3(0, 0, 0)], [new THREE.Vector3(1, 0, 2)], 0);
    p.setLitPuffs(true);
    p.update(0.1, 0.1, 0.5, 1.0, true, new THREE.Color('#00f0ff'), 1.0, {
      beams: [makeBeam()],
      blackout: false,
      master: 1,
      roomGain: 1,
      camPosX: 0,
      camPosY: 4,
      camPosZ: 20,
      camFwdX: 0,
      camFwdY: 0,
      camFwdZ: -1,
    });
    const prevMatVer = p.group.children[1].material.version;
    p.onContextRestored();
    assert.ok(p.group.children[1].material.version > prevMatVer);
    p.dispose();

    const doc = readFileSync(join(process.cwd(), 'docs/graphics.md'), 'utf8');
    assert.match(doc, /litPuffs/);
    assert.match(doc, /cannot cast a truss shadow/i);
    assert.match(doc, /cannot resolve per-particle cross-batch intersections/i);
  });
});
