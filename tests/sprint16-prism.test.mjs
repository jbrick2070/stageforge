import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';

let server;
let prismMod;
let beamPoolsMod;
let fixtureOpticsMod;
let previewFlashMod;
let renderProbeMod;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  prismMod = await server.ssrLoadModule('/src/engine/prismPattern.ts');
  beamPoolsMod = await server.ssrLoadModule('/src/engine/beamPools.ts');
  fixtureOpticsMod = await server.ssrLoadModule('/src/data/fixtureOptics.ts');
  previewFlashMod = await server.ssrLoadModule('/src/engine/previewFlash.ts');
  renderProbeMod = await server.ssrLoadModule('/src/engine/renderProbe.ts');
});

after(async () => {
  if (server) await server.close();
});

function buildStageBeamHierarchy({ mountYaw = 0, podTiltZ = 0, pan = 0, tilt = 0, zoomScale = 1, x = 0, y = 10, z = 0, lensOffsetY = 0.17 }) {
  const pod = new THREE.Group();
  pod.position.set(x, y, z);
  pod.rotation.z = podTiltZ;

  const root = new THREE.Group();
  root.rotation.y = mountYaw;
  pod.add(root);

  const yoke = new THREE.Group();
  yoke.rotation.y = pan;
  root.add(yoke);

  const head = new THREE.Group();
  head.rotation.x = tilt;
  yoke.add(head);

  const beam = new THREE.Object3D();
  beam.scale.set(zoomScale, 1, zoomScale);
  beam.userData = { lensOffsetY };
  head.add(beam);

  pod.updateWorldMatrix(true, true);
  return { pod, beam };
}

describe('Sprint 16: prismPattern coordinate agreement & orthonormal frame extraction', () => {
  it('agrees identically with VOLUMETRIC_BEAM_VERT/FRAG across hung and floor heads, pan/tilt, zoom, and arbitrary cameras', () => {
    const configs = [
      { isFloor: false, mountYaw: 0, podTiltZ: 0, pan: 0, tilt: -0.35, zoomScale: 0.55, y: 11.2 },
      { isFloor: false, mountYaw: 0.28, podTiltZ: -0.14, pan: -0.82, tilt: -0.64, zoomScale: 1.4, y: 9.6 },
      { isFloor: true, mountYaw: 0, podTiltZ: 0, pan: 0.45, tilt: 0.52, zoomScale: 0.85, y: 1.8 },
      { isFloor: true, mountYaw: -0.6, podTiltZ: 0, pan: -1.1, tilt: 0.78, zoomScale: 1.65, y: 1.8 },
    ];
    const cameras = [
      new THREE.Vector3(0, 4.5, 28),
      new THREE.Vector3(-18, 8.0, 12),
      new THREE.Vector3(14, 2.2, -9),
      new THREE.Vector3(2, 16, 4),
    ];
    const times = [0, 1.25, 4.7, 19.3];

    for (const cfg of configs) {
      const { beam } = buildStageBeamHierarchy(cfg);
      const sign = cfg.isFloor ? 1 : -1;
      const axis = new THREE.Vector3();
      const tx = new THREE.Vector3();
      const tz = new THREE.Vector3();
      assert.equal(prismMod.extractPrismFrame(beam.matrixWorld, sign, axis, tx, tz), true);

      // Verify strict orthonormality
      assert.ok(Math.abs(axis.length() - 1) < 1e-6);
      assert.ok(Math.abs(tx.length() - 1) < 1e-6);
      assert.ok(Math.abs(tz.length() - 1) < 1e-6);
      assert.ok(Math.abs(axis.dot(tx)) < 1e-6);
      assert.ok(Math.abs(axis.dot(tz)) < 1e-6);
      assert.ok(Math.abs(tx.dot(tz)) < 1e-6);

      // Verify exact agreement with raw normalized columns m[0] and m[2] on production transforms
      const e = beam.matrixWorld.elements;
      const col0 = new THREE.Vector3(e[0], e[1], e[2]).normalize();
      const col2 = new THREE.Vector3(e[8], e[9], e[10]).normalize();
      assert.ok(tx.distanceTo(col0) < 1e-6);
      assert.ok(tz.distanceTo(col2) < 1e-6);

      for (const cam of cameras) {
        const aerial = prismMod.aerialPrismAzimuth(beam.matrixWorld, 0.17, cam, cfg.isFloor);
        if (aerial.collinear) continue;
        for (const t of times) {
          const seed = 2.193;
          const phase = prismMod.prismPhase(t, seed);
          const centers = prismMod.prismShaftCenters(phase, 1.0);
          for (let k = 0; k < prismMod.PRISM_SHAFT_COUNT; k++) {
            const [uk, vk] = centers[k];
            const worldOffset = new THREE.Vector3()
              .addScaledVector(tx, uk)
              .addScaledVector(tz, vk);
            const projectedAcross = worldOffset.dot(aerial.across);
            // Exact aerial shader formula in VOLUMETRIC_BEAM_FRAG:
            // radius * sin(uTime * 0.48 + uSeed - azimuth + k * pi/4)
            const expectedAerialOffset = prismMod.PRISM_RING_RADIUS * Math.sin(
              t * prismMod.PRISM_ROTATION_RATE + seed - aerial.azimuth + k * (Math.PI / 4),
            );
            assert.ok(
              Math.abs(projectedAcross - expectedAerialOffset) < 1e-6,
              `shaft ${k} mismatch: got ${projectedAcross}, expected ${expectedAerialOffset}`,
            );
          }
        }
      }
    }
  });

  it('orthonormalizes sheared matrices cleanly and rejects zero, NaN, or rank-deficient matrices', () => {
    const axis = new THREE.Vector3();
    const tx = new THREE.Vector3();
    const tz = new THREE.Vector3();

    // Non-orthogonal shear in XZ + XY
    const sheared = new THREE.Matrix4().set(
      1.2, 0.35, 0.25, 2,
      0.1, 1.0, -0.15, 8,
      0.4, 0.2, 0.95, -3,
      0, 0, 0, 1,
    );
    assert.equal(prismMod.extractPrismFrame(sheared, -1, axis, tx, tz), true);
    assert.ok(Math.abs(axis.length() - 1) < 1e-6);
    assert.ok(Math.abs(tx.length() - 1) < 1e-6);
    assert.ok(Math.abs(tz.length() - 1) < 1e-6);
    assert.ok(Math.abs(axis.dot(tx)) < 1e-6);
    assert.ok(Math.abs(axis.dot(tz)) < 1e-6);
    assert.ok(Math.abs(tx.dot(tz)) < 1e-6);

    // Zero scale matrix -> rejected
    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    assert.equal(prismMod.extractPrismFrame(zeroMat, -1, axis, tx, tz), false);

    // Collinear m[0] and m[2] (rank-2 matrix) -> rejected
    const rank2 = new THREE.Matrix4().set(
      1, 0, 1, 0,
      0, 1, 0, 0,
      2, 0, 2, 0,
      0, 0, 0, 1,
    );
    assert.equal(prismMod.extractPrismFrame(rank2, -1, axis, tx, tz), false);

    // NaN element -> rejected
    const nanMat = new THREE.Matrix4();
    nanMat.elements[0] = Number.NaN;
    assert.equal(prismMod.extractPrismFrame(nanMat, 1, axis, tx, tz), false);
  });
});

describe('Sprint 16: Jacobian, EWA Gaussian filtering, energy conservation & cone bounds', () => {
  it('matches numerical finite differences for normal and grazing Jacobians and clamps extreme grazing cleanly', () => {
    const { beam } = buildStageBeamHierarchy({
      isFloor: false,
      pan: 0.32,
      tilt: -0.92, // oblique throw across stage floor
      zoomScale: 0.75,
      y: 9.5,
    });
    const axis = new THREE.Vector3();
    const tx = new THREE.Vector3();
    const tz = new THREE.Vector3();
    prismMod.extractPrismFrame(beam.matrixWorld, -1, axis, tx, tz);
    const lens = new THREE.Vector3(0, -0.17, 0).applyMatrix4(beam.matrixWorld);
    const optics = fixtureOpticsMod.fixtureOptics('beam');
    const nearRadius = optics.nearRadius * 0.75;
    const slope = (optics.farRadius * 0.75 - nearRadius) / optics.length;

    // Intersect ray near center of cone with floor y = 0
    const tHit = -lens.y / axis.y;
    const hitPoint = lens.clone().addScaledVector(axis, tHit).add(new THREE.Vector3(0.18, 0, -0.11));
    const delta = hitPoint.clone().sub(lens);
    const dWx = new THREE.Vector3(0.025, 0, 0.004);
    const dWy = new THREE.Vector3(-0.003, 0, 0.032);

    const jac = prismMod.computePrismPoolJacobian({ delta, nearRadius, slope, axis, tx, tz, dWx, dWy });
    assert.ok(jac !== null);

    // Compare analytic Jacobian against central finite differences on the floor plane
    const eps = 1e-4;
    const evalUV = (pt) => {
      const d = pt.clone().sub(lens);
      const td = d.dot(axis);
      const rad = nearRadius + slope * td;
      const rVec = d.clone().addScaledVector(axis, -td);
      return [rVec.dot(tx) / rad, rVec.dot(tz) / rad];
    };
    const [uxP, vxP] = evalUV(hitPoint.clone().addScaledVector(dWx, eps));
    const [uxM, vxM] = evalUV(hitPoint.clone().addScaledVector(dWx, -eps));
    const [uyP, vyP] = evalUV(hitPoint.clone().addScaledVector(dWy, eps));
    const [uyM, vyM] = evalUV(hitPoint.clone().addScaledVector(dWy, -eps));

    assert.ok(Math.abs(jac.jxX - (uxP - uxM) / (2 * eps)) < 1e-4);
    assert.ok(Math.abs(jac.jxY - (vxP - vxM) / (2 * eps)) < 1e-4);
    assert.ok(Math.abs(jac.jyX - (uyP - uyM) / (2 * eps)) < 1e-4);
    assert.ok(Math.abs(jac.jyY - (vyP - vyM) / (2 * eps)) < 1e-4);

    // Extreme grazing / huge derivatives clamp cleanly without NaN or Infinity
    const extreme = prismMod.prismPoolProfile(0.5, -0.2, 0.8, 1.1, 5000, -3000, 1200, 8000, 1.0);
    assert.ok(Number.isFinite(extreme) && extreme >= 0);
    // Heavy minification blends smoothly back to baseBeamPoolProfile(r)
    const r = Math.hypot(0.5, -0.2);
    assert.ok(Math.abs(extreme - prismMod.baseBeamPoolProfile(r)) < 1e-5);
  });

  it('conserves 2D disk-integrated flux relative to unsplit baseBeamPoolProfile across rotation phases', () => {
    const n = 160;
    const step = 2 / n;
    const dA = step * step;
    for (const phase of [0, 0.41, 1.23, 2.77]) {
      let prismSum = 0;
      let baseSum = 0;
      for (let iy = 0; iy < n; iy++) {
        const v = -1 + (iy + 0.5) * step;
        for (let ix = 0; ix < n; ix++) {
          const u = -1 + (ix + 0.5) * step;
          const r = Math.hypot(u, v);
          if (r >= 1) continue;
          baseSum += prismMod.baseBeamPoolProfile(r) * dA;
          prismSum += prismMod.prismPoolProfile(u, v, 1.0, phase, 0, 0, 0, 0, 1.0) * dA;
        }
      }
      assert.ok(Math.abs(baseSum - prismMod.PRISM_BEAM_INTEGRAL_E0) < 0.01);
      const relDiff = Math.abs(prismSum - baseSum) / baseSum;
      assert.ok(relDiff < 0.015, `expected disk energy within 1.5%, got relDiff=${relDiff}`);
    }

    // Near-aperture reach <= 0.01 and prismMix === 0 match baseBeamPoolProfile(r) identically
    assert.equal(prismMod.prismPoolProfile(0.3, -0.4, 0.005, 0.8, 0, 0, 0, 0, 1.0), prismMod.baseBeamPoolProfile(0.5));
    assert.equal(prismMod.prismPoolProfile(0.3, -0.4, 0.8, 0.8, 0, 0, 0, 0, 0.0), prismMod.baseBeamPoolProfile(0.5));
  });

  it('computes conservative receiver bounds for diverging, converging, grazing, and upward cones', () => {
    const receiverBounds = new THREE.Vector4(-11, -5.5, 11, 5.5);
    const lens = new THREE.Vector3(0, 10, 0);

    // Straight down diverging cone
    const down = beamPoolsMod.computeConeReceiverBounds(
      lens, new THREE.Vector3(0, -1, 0), 0.12, 0.05, 30, 1.803, receiverBounds,
    );
    assert.ok(down !== null);
    const expectedR = 0.12 + (10 - 1.803) * 0.05;
    assert.ok(Math.abs(down.right - expectedR) < 0.15);

    // Oblique converging cone (`slope < 0`) uses max(r(start), r(end)) so the wider near side is never clipped
    const obliqueDir = new THREE.Vector3(0.85, -0.5267826876, 0).normalize();
    const conv = beamPoolsMod.computeConeReceiverBounds(
      new THREE.Vector3(-4, 4.0, 0), obliqueDir, 1.5, -0.04, 30, 1.803, receiverBounds,
    );
    assert.ok(conv !== null);
    const rAtEndOnly = 1.5 + conv.end * -0.04;
    assert.ok(conv.radius > rAtEndOnly, `expected max(rStart, rEnd)=${conv.radius} > rEnd=${rAtEndOnly}`);

    // Upward floor beam below surface (`lens.y <= surfaceY`) -> null
    const below = beamPoolsMod.computeConeReceiverBounds(
      new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 1, 0), 0.12, 0.05, 30, 1.803, receiverBounds,
    );
    assert.equal(below, null);

    // Grazing near-horizontal cone intersecting wide arena floor
    const grazing = beamPoolsMod.computeConeReceiverBounds(
      new THREE.Vector3(0, 4.0, 0),
      new THREE.Vector3(0, -0.18, 0.983666).normalize(),
      0.12,
      0.055,
      30,
      0.003,
      new THREE.Vector4(-70, -70, 70, 70),
    );
    assert.ok(grazing !== null);
    assert.ok(grazing.front > grazing.back);
  });
});

describe('Sprint 16: BeamPools flag-off parity, <0.1 MiB cap, upload bytes, low-tier guard & preview flash limiter', () => {
  it('allocates zero optional attributes/uniforms when off, tracks exact upload bytes, and enforces <0.1 MiB cap & low-tier hysteresis', () => {
    const opticsBeam = fixtureOpticsMod.fixtureOptics('beam');
    const opticsWash = fixtureOpticsMod.fixtureOptics('wash');
    const color = new THREE.Color('#00f0ff');
    const { beam: hungBeam } = buildStageBeamHierarchy({ isFloor: false, pan: 0.1, tilt: -0.2, y: 10 });
    const { beam: hungWash } = buildStageBeamHierarchy({ isFloor: false, pan: -0.1, tilt: -0.25, y: 10 });

    // 1. Default flag-off BeamPools: exact base shaders, no prismU/prismV attributes, no PRISM_POOLS define
    const poolsOff = new beamPoolsMod.BeamPools(44, 22, 11, 1.8);
    assert.equal(poolsOff.prismAllocated, false);
    const meshOff = poolsOff.group.children[0];
    assert.equal(meshOff.material.vertexShader, beamPoolsMod.POOL_VERTEX_BASE);
    assert.equal(meshOff.material.fragmentShader, beamPoolsMod.POOL_FRAGMENT_BASE);
    assert.equal(meshOff.geometry.getAttribute('prismU'), undefined);
    assert.equal(meshOff.geometry.getAttribute('prismV'), undefined);
    assert.equal(meshOff.material.defines.PRISM_POOLS, undefined);
    assert.equal(meshOff.material.uniforms.uPrismSuppressed, undefined);

    poolsOff.begin();
    poolsOff.add(hungBeam, 'beam', false, color, 1.0, opticsBeam, 1.0, 0.5);
    poolsOff.add(hungWash, 'wash', false, color, 1.0, opticsWash, 0.0, 0);
    const upOff = poolsOff.finish();
    const statsOff = poolsOff.getStats();
    assert.equal(statsOff.requested, false);
    assert.equal(statsOff.allocated, false);
    assert.equal(statsOff.suppressedReason, 'disabled');
    assert.equal(statsOff.extraBufferBytes, 0);
    // 17 floats * 4 B = 68 B per receiver-qualified instance
    assert.equal(upOff, statsOff.totalInstances * 68);
    assert.equal(statsOff.uploadBytes, upOff);
    poolsOff.begin();
    assert.equal(poolsOff.getStats().uploadBytes, 0);
    poolsOff.dispose();

    // 2. Flag-on BeamPools on Arena capacity (44 * 2 * 32 = 2,816 B < 100 KiB)
    const poolsOn = new beamPoolsMod.BeamPools(44, 22, 11, 1.8, undefined, { prism: true, tier: 'high' });
    assert.equal(poolsOn.prismAllocated, true);
    const meshOn = poolsOn.group.children[0];
    assert.equal(meshOn.material.vertexShader, beamPoolsMod.POOL_VERTEX_PRISM);
    assert.equal(meshOn.material.fragmentShader, beamPoolsMod.POOL_FRAGMENT_PRISM);
    assert.ok(meshOn.geometry.getAttribute('prismU') !== undefined);
    assert.ok(meshOn.geometry.getAttribute('prismV') !== undefined);

    poolsOn.begin();
    poolsOn.add(hungBeam, 'beam', false, color, 1.0, opticsBeam, 1.0, 0.75);
    poolsOn.add(hungWash, 'wash', false, color, 1.0, opticsWash, 1.0, 0.75); // wash never counts as prism
    const upOn = poolsOn.finish();
    const statsOn = poolsOn.getStats();
    assert.equal(statsOn.extraBufferBytes, 44 * 2 * 32);
    assert.ok(statsOn.extraBufferBytes < 100 * 1024);
    assert.equal(statsOn.active, true);
    assert.equal(statsOn.suppressedReason, null);
    assert.ok(statsOn.activePrismInstances >= 1);
    // Only the beam (not the wash) incremented prismCount
    assert.equal(statsOn.activePrismInstances, Math.floor(statsOn.totalInstances / 2));
    // 25 floats * 4 B = 100 B per receiver-qualified instance
    assert.equal(upOn, statsOn.totalInstances * 100);
    poolsOn.dispose();

    // 3. Memory-budget guard (> 100 KiB extra buffer bytes falls back cleanly to base shader)
    const oversize = new beamPoolsMod.BeamPools(2000, 22, 11, 1.8, undefined, { prism: true, tier: 'high' });
    assert.equal(oversize.prismAllocated, false);
    assert.equal(oversize.getStats().suppressedReason, 'memory-budget');
    assert.equal(oversize.getStats().extraBufferBytes, 0);
    oversize.dispose();

    // 4. Low-tier overlap hysteresis guard (never suppresses high tier; suppresses & resumes smoothly on low tier)
    assert.equal(prismMod.stepPrismOverlapGuard(false, 40, 80, 'high'), false);
    let sup = false;
    sup = prismMod.stepPrismOverlapGuard(sup, 32, 56, 'low'); // Arena World Tour Rig -> stays active!
    assert.equal(sup, false);
    sup = prismMod.stepPrismOverlapGuard(sup, 38, 70, 'low'); // exceeds 36 / 68 -> suppressed!
    assert.equal(sup, true);
    sup = prismMod.stepPrismOverlapGuard(sup, 31, 56, 'low'); // inside hysteresis band -> stays suppressed!
    assert.equal(sup, true);
    sup = prismMod.stepPrismOverlapGuard(sup, 28, 52, 'low'); // drops to <= 28 & <= 52 -> resumes!
    assert.equal(sup, false);
  });

  it('governs rapid 10 Hz goboPrism toggling in previewFlash so spatial center/ring reversals stay <= 3/s', () => {
    const state = previewFlashMod.createPreviewFlashState();
    const out = previewFlashMod.createPreviewFlashOutput();
    const white = new THREE.Color('#ffffff');

    const stepFrame = (dtSec, tSec, goboPrism, blinder = 0, limited = true) =>
      previewFlashMod.evaluatePreviewFlash(
        state,
        {
          dtSec,
          tSec,
          limited,
          blackout: false,
          master: 1,
          blinder,
          ledBright: 0,
          beatPulse: 0,
          beamIntensity: 1,
          washIntensity: 0,
          goboPrism,
          laserStrobe: 0,
          primaryColor: white,
          accentColor: white,
        },
        out,
      );

    // Initial steady frame at goboPrism = false
    stepFrame(0.4, 0.4, false);
    assert.equal(out.prismMix, 0);

    // First toggle false -> true applies immediately!
    stepFrame(0.05, 0.45, true);
    assert.equal(out.prismMix, 1);

    // Simulate 2 seconds of 10 Hz goboPrism mashing (50 ms half-period) and measure localized center & ring luminance
    const samples = [];
    let tMs = 450;
    for (let i = 0; i < 80; i++) {
      tMs += 25;
      const desiredPrism = Math.floor(tMs / 50) % 2 === 0;
      stepFrame(0.025, tMs / 1000, desiredPrism);
      const mix = out.prismMix;
      // Construct an 8x8 synthetic receiver image where cell 0 is the beam center (0, 0) and cell 1 is a prism spot
      const centerVal = Math.min(1, prismMod.prismPoolProfile(0, 0, 1.0, 0, 0, 0, 0, 0, mix));
      const spotVal = Math.min(1, prismMod.prismPoolProfile(0, -prismMod.PRISM_RING_RADIUS, 1.0, 0, 0, 0, 0, 0, mix) * 0.25);
      const rgba = new Uint8Array(16 * 16 * 4);
      for (let py = 0; py < 16; py++) {
        for (let px = 0; px < 16; px++) {
          const idx = (py * 16 + px) * 4;
          const v = py < 2 && px < 2 ? centerVal : py < 2 && px < 4 ? spotVal : 0.02;
          const byte = Math.round(Math.pow(v, 1 / 2.2) * 255);
          rgba[idx] = rgba[idx + 1] = rgba[idx + 2] = byte;
          rgba[idx + 3] = 255;
        }
      }
      samples.push({
        timeMs: tMs,
        grid: renderProbeMod.computeFrameLuminanceGrid(rgba, 16, 16, 8, 8),
      });
    }
    const analysis = renderProbeMod.analyzeRollingFlashRate(samples);
    assert.ok(
      analysis.maxGeneralFlashesPerSec <= 3,
      `expected <= 3 flashes/s under 10 Hz goboPrism mash, got ${analysis.maxGeneralFlashesPerSec}`,
    );

    // Full-rate opt-in (`limited: false`) passes goboPrism toggles immediately without holding
    stepFrame(0.02, (tMs + 20) / 1000, false, 0, false);
    assert.equal(out.prismMix, 0);
    stepFrame(0.02, (tMs + 40) / 1000, true, 0, false);
    assert.equal(out.prismMix, 1);
  });
});
