import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';

let server;
let ledResp;
let shaders;
let renderSettings;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  ledResp = await server.ssrLoadModule('/src/engine/ledWallResponse.ts');
  shaders = await server.ssrLoadModule('/src/engine/shaders.ts');
  renderSettings = await server.ssrLoadModule('/src/engine/renderSettings.ts');
});

after(async () => {
  if (server) await server.close();
});

/** Minimal #ifdef / #else / #endif preprocessor for verifying compiled GLSL branches. */
function preprocessGlsl(source, defines = {}) {
  const lines = source.split('\n');
  const out = [];
  const stack = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#ifdef ')) {
      const symbol = trimmed.slice('#ifdef '.length).trim();
      const parentActive = stack.every((s) => s.active);
      const cond = Boolean(defines[symbol]);
      stack.push({ parentActive, cond, active: parentActive && cond });
      continue;
    }
    if (trimmed === '#else') {
      const top = stack[stack.length - 1];
      assert.ok(top, 'unexpected #else');
      top.active = top.parentActive && !top.cond;
      continue;
    }
    if (trimmed === '#endif') {
      assert.ok(stack.pop(), 'unexpected #endif');
      continue;
    }
    if (stack.every((s) => s.active)) out.push(line);
  }
  assert.equal(stack.length, 0, 'unclosed #ifdef');
  return out.join('\n');
}

describe('Sprint 17: LED wall angular emissivity curve invariants', () => {
  it('preserves frontal readability, falls off smoothly to a bounded 0.30 grazing floor, and guards hostile inputs', () => {
    assert.equal(ledResp.LED_ANGULAR_FLOOR, 0.30);
    assert.equal(ledResp.LED_ANGULAR_KNEE, 0.22);
    assert.equal(ledResp.evaluateLedAngularGain(1.0), 1.0);
    assert.equal(ledResp.evaluateLedAngularGain(0.0), 0.30);

    // Out-of-range clamps cleanly and NaN falls back to neutral 1.0 (never NaN).
    assert.equal(ledResp.evaluateLedAngularGain(1.5), 1.0);
    assert.equal(ledResp.evaluateLedAngularGain(-0.4), 0.30);
    assert.equal(ledResp.evaluateLedAngularGain(-Infinity), 0.30);
    assert.equal(ledResp.evaluateLedAngularGain(Infinity), 1.0);
    assert.equal(ledResp.evaluateLedAngularGain(Number.NaN), 1.0);

    // Frontal sightlines (0..30 deg) stay >= 0.95; moderate side (60 deg) ~0.75; extreme grazing (85 deg) ~0.33.
    const g0 = ledResp.evaluateLedAngularGain(Math.cos(0));
    const g20 = ledResp.evaluateLedAngularGain(Math.cos(THREE.MathUtils.degToRad(20)));
    const g30 = ledResp.evaluateLedAngularGain(Math.cos(THREE.MathUtils.degToRad(30)));
    const g45 = ledResp.evaluateLedAngularGain(Math.cos(THREE.MathUtils.degToRad(45)));
    const g60 = ledResp.evaluateLedAngularGain(Math.cos(THREE.MathUtils.degToRad(60)));
    const g80 = ledResp.evaluateLedAngularGain(Math.cos(THREE.MathUtils.degToRad(80)));
    const g85 = ledResp.evaluateLedAngularGain(Math.cos(THREE.MathUtils.degToRad(85)));
    const g90 = ledResp.evaluateLedAngularGain(Math.cos(THREE.MathUtils.degToRad(90)));

    assert.equal(g0, 1.0);
    assert.ok(g20 > 0.98, `20 deg should stay > 0.98, got ${g20}`);
    assert.ok(g30 > 0.95, `30 deg should stay > 0.95, got ${g30}`);
    assert.ok(g45 > 0.85 && g45 < 0.92, `45 deg expected ~0.885, got ${g45}`);
    assert.ok(g60 > 0.72 && g60 < 0.79, `60 deg expected ~0.752, got ${g60}`);
    assert.ok(g80 > 0.40 && g80 < 0.50, `80 deg expected ~0.449, got ${g80}`);
    assert.ok(g85 > 0.31 && g85 < 0.37, `85 deg expected ~0.33, got ${g85}`);
    assert.ok(Math.abs(g90 - 0.30) < 1e-12);

    // Strict monotonicity and smooth bounded first/second finite differences across 1000 samples (no shoulder kinks).
    let prev = ledResp.evaluateLedAngularGain(0);
    let maxSecondDiff = 0;
    const N = 1000;
    const samples = [];
    for (let i = 0; i <= N; i++) {
      const c = i / N;
      const g = ledResp.evaluateLedAngularGain(c);
      assert.ok(Number.isFinite(g) && g >= 0.30 - 1e-12 && g <= 1.0 + 1e-12);
      if (i > 0) {
        assert.ok(g > prev, `expected strictly increasing gain at c=${c}: ${g} <= ${prev}`);
      }
      prev = g;
      samples.push(g);
    }
    for (let i = 1; i < N; i++) {
      const d2 = Math.abs(samples[i + 1] - 2 * samples[i] + samples[i - 1]);
      if (d2 > maxSecondDiff) maxSecondDiff = d2;
    }
    assert.ok(maxSecondDiff < 1e-4, `expected C^2 smooth curve without kinks, max second diff=${maxSecondDiff}`);
  });
});

describe('Sprint 17: View-space normal & gl_FrontFacing geometry across flat, curved BackSide, wing, secondary, and stereo XR cameras', () => {
  function makeCamera(pos, target) {
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 220);
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(target[0], target[1], target[2]);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    return cam;
  }

  it('evaluates flat PlaneGeometry (FrontSide), distance invariance along normal, and side angles accurately', () => {
    const geo = new THREE.PlaneGeometry(18, 8.5);
    const mat = new THREE.ShaderMaterial({ side: THREE.FrontSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 6.0, -5.5);
    mesh.updateMatrixWorld(true);

    const center = new THREE.Vector3(0, 0, 0);
    const normal = new THREE.Vector3(0, 0, 1);

    // Distance sweep directly along surface normal (4 m, 12 m, 28 m, 60 m): gain is invariant === 1.0
    for (const dist of [4, 12, 28, 60]) {
      const cam = makeCamera([0, 6.0, -5.5 + dist], [0, 6.0, -5.5]);
      const sample = ledResp.computeLedSurfaceViewTerms(mesh, center, normal, cam);
      assert.equal(sample.frontFacing, true);
      assert.ok(Math.abs(sample.cosTheta - 1.0) < 1e-6);
      assert.ok(Math.abs(sample.gain - 1.0) < 1e-6);
    }

    // Off-axis side angles (0 deg, 30 deg, 60 deg, 82 deg) at 15 m throw
    for (const deg of [0, 30, 60, 82]) {
      const rad = THREE.MathUtils.degToRad(deg);
      const cam = makeCamera([15 * Math.sin(rad), 6.0, -5.5 + 15 * Math.cos(rad)], [0, 6.0, -5.5]);
      const sample = ledResp.computeLedSurfaceViewTerms(mesh, center, normal, cam);
      const expectedCos = Math.cos(rad);
      assert.ok(Math.abs(sample.cosTheta - expectedCos) < 1e-6, `deg=${deg}: got cos=${sample.cosTheta}`);
      assert.ok(Math.abs(sample.gain - ledResp.evaluateLedAngularGain(expectedCos)) < 1e-6);
    }
    geo.dispose();
    mat.dispose();
  });

  it('orients concave Curved LED wall (CylinderGeometry + THREE.BackSide + flipped UVs) inward toward the audience', () => {
    // Exact construction from StageEngine.ts:2284-2306
    const width = 18;
    const height = 8.5;
    const wallY = 6.05;
    const wallZ = -5.5;
    const radius = width * 6; // 108 m
    const thetaLen = width / radius;
    const wallGeo = new THREE.CylinderGeometry(
      radius,
      radius,
      height,
      36,
      1,
      true,
      Math.PI - thetaLen / 2,
      thetaLen,
    );
    const uv = wallGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setX(i, 1 - uv.getX(i));
    }
    const mat = new THREE.ShaderMaterial({ side: THREE.BackSide });
    const wallMesh = new THREE.Mesh(wallGeo, mat);
    wallMesh.position.set(0, wallY, wallZ + radius);
    wallMesh.updateMatrixWorld(true);

    // Center of cylinder arc (theta = pi): local pos = (0, 0, -radius), outward normal = (0, 0, -1)
    const centerPos = new THREE.Vector3(0, 0, -radius);
    const outwardCenterNormal = new THREE.Vector3(0, 0, -1);

    const fohCam = makeCamera([0, wallY, 26], [0, wallY, wallZ]);
    const centerSample = ledResp.computeLedSurfaceViewTerms(wallMesh, centerPos, outwardCenterNormal, fohCam);
    assert.equal(centerSample.flipSided, true, 'Three.js BackSide sets FLIP_SIDED=true');
    assert.equal(centerSample.frontFacing, true, 'Three.js BackSide sets gl.frontFace(CW), so gl_FrontFacing is true');
    assert.ok(Math.abs(centerSample.cosTheta - 1.0) < 1e-6, `curved center must face FOH (+Z), got cos=${centerSample.cosTheta}`);
    assert.ok(Math.abs(centerSample.gain - 1.0) < 1e-6);

    // Without FLIP_SIDED vertex negation, outward normal points -Z while gl_FrontFacing=true -> dot = -1 -> clamped to 0.30 floor!
    const unflippedRawViewNormal = centerSample.viewNormal.clone().negate();
    const wrongUnflippedGain = ledResp.evaluateLedWallFragmentGain(unflippedRawViewNormal, centerSample.viewDir, true);
    assert.equal(wrongUnflippedGain, ledResp.LED_ANGULAR_FLOOR);

    // DoubleSide check: viewing the back of a DoubleSide plane sets flipSided=false and frontFacing=false, orienting normal toward camera
    const doubleMat = new THREE.ShaderMaterial({ side: THREE.DoubleSide });
    const doubleMesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), doubleMat);
    doubleMesh.position.set(0, wallY, wallZ);
    doubleMesh.updateMatrixWorld(true);
    const rearCam = makeCamera([0, wallY, wallZ - 10], [0, wallY, wallZ]);
    const rearSample = ledResp.computeLedSurfaceViewTerms(doubleMesh, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1), rearCam);
    assert.equal(rearSample.flipSided, false);
    assert.equal(rearSample.frontFacing, false);
    assert.ok(Math.abs(rearSample.gain - 1.0) < 1e-6);
    doubleMesh.geometry.dispose();
    doubleMat.dispose();

    // Check every vertex column along the curved arc from FOH: smooth symmetric values >= 0.99 across gentle arena curve
    const posAttr = wallGeo.attributes.position;
    const normAttr = wallGeo.attributes.normal;
    for (let i = 0; i < posAttr.count; i++) {
      const lp = new THREE.Vector3().fromBufferAttribute(posAttr, i);
      const ln = new THREE.Vector3().fromBufferAttribute(normAttr, i);
      const s = ledResp.computeLedSurfaceViewTerms(wallMesh, lp, ln, fohCam);
      assert.ok(s.gain > 0.97, `expected curved vertex ${i} to read cleanly from FOH, got ${s.gain}`);
    }

    // Grazing side camera at 82 deg off-axis from center of curved wall drops gain cleanly below 0.50
    const rad82 = THREE.MathUtils.degToRad(82);
    const grazingCam = makeCamera([14 * Math.sin(rad82), wallY, wallZ + 14 * Math.cos(rad82)], [0, wallY, wallZ]);
    const grazingCenter = ledResp.computeLedSurfaceViewTerms(wallMesh, centerPos, outwardCenterNormal, grazingCam);
    assert.ok(grazingCenter.gain > 0.30 && grazingCenter.gain < 0.45, `expected grazing curved center in (0.30, 0.45), got ${grazingCenter.gain}`);

    wallGeo.dispose();
    mat.dispose();
  });

  it('handles angled Side IMAG wings, yawed secondary screens, WebXR stereo eye pairs, and degenerate vectors', () => {
    // Yawed secondary screen (-30 deg yaw -> normal points 30 deg toward audience-left, x < 0)
    const mount = new THREE.Group();
    mount.position.set(10, 5, -2);
    mount.rotation.y = THREE.MathUtils.degToRad(-30);
    const panelGeo = new THREE.PlaneGeometry(4, 6);
    const panelMat = new THREE.ShaderMaterial({ side: THREE.FrontSide });
    const panel = new THREE.Mesh(panelGeo, panelMat);
    mount.add(panel);
    mount.updateMatrixWorld(true);

    const localOrigin = new THREE.Vector3(0, 0, 0);
    const localNormal = new THREE.Vector3(0, 0, 1);

    // Camera aligned with screen's -30 deg yaw normal vs camera on opposite +50 deg side (80 deg total incidence)
    const yawRad = THREE.MathUtils.degToRad(-30);
    const alignedCam = makeCamera([10 + 10 * Math.sin(yawRad), 5, -2 + 10 * Math.cos(yawRad)], [10, 5, -2]);
    const oppRad = THREE.MathUtils.degToRad(50);
    const obliqueCam = makeCamera([10 + 10 * Math.sin(oppRad), 5, -2 + 10 * Math.cos(oppRad)], [10, 5, -2]);

    const alignedSample = ledResp.computeLedSurfaceViewTerms(panel, localOrigin, localNormal, alignedCam);
    const obliqueSample = ledResp.computeLedSurfaceViewTerms(panel, localOrigin, localNormal, obliqueCam);
    assert.ok(Math.abs(alignedSample.gain - 1.0) < 1e-6);
    assert.ok(obliqueSample.gain < 0.50 && obliqueSample.gain > 0.30);

    // Stereo XR check: left & right eye cameras 64 mm apart near an oblique panel produce distinct per-eye gains from matrixWorldInverse
    const leftEye = makeCamera([10 + 1.2 * Math.sin(oppRad) - 0.032, 5, -2 + 1.2 * Math.cos(oppRad)], [10, 5, -2]);
    const rightEye = makeCamera([10 + 1.2 * Math.sin(oppRad) + 0.032, 5, -2 + 1.2 * Math.cos(oppRad)], [10, 5, -2]);
    const leftSample = ledResp.computeLedSurfaceViewTerms(panel, localOrigin, localNormal, leftEye);
    const rightSample = ledResp.computeLedSurfaceViewTerms(panel, localOrigin, localNormal, rightEye);
    assert.notEqual(leftSample.gain, rightSample.gain);

    // Degenerate zero-length normal / zero-distance camera / NaN vector returns neutral 1.0 (never NaN)
    assert.equal(ledResp.evaluateLedWallFragmentGain({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 }, true), 1.0);
    assert.equal(ledResp.evaluateLedWallFragmentGain({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, true), 1.0);
    assert.equal(ledResp.evaluateLedWallFragmentGain({ x: Number.NaN, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, true), 1.0);

    panelGeo.dispose();
    panelMat.dispose();
  });
});

describe('Sprint 17: LED_WALL_VERT / LED_WALL_FRAG default-off isolation & anti-moiré preservation', () => {
  it('compiles zero angular varyings or helper calls when LED_ANGULAR_RESPONSE is undefined and injects authoritative constants when defined', () => {
    assert.equal(renderSettings.DEFAULT_RENDER_SETTINGS.ledAngularResponse, false);

    const vertOff = preprocessGlsl(shaders.LED_WALL_VERT, {});
    const fragOff = preprocessGlsl(shaders.LED_WALL_FRAG, {});
    assert.equal(vertOff.includes('vViewNormal'), false);
    assert.equal(vertOff.includes('vViewDir'), false);
    assert.equal(vertOff.includes('normalMatrix'), false);
    assert.ok(vertOff.includes('gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);'));
    assert.equal(fragOff.includes('vViewNormal'), false);
    assert.equal(fragOff.includes('evaluateLedAngularGainFromView'), false);

    const vertOnFront = preprocessGlsl(shaders.LED_WALL_VERT, { [ledResp.LED_ANGULAR_DEFINE]: 1 });
    const vertOnFlipSided = preprocessGlsl(shaders.LED_WALL_VERT, { [ledResp.LED_ANGULAR_DEFINE]: 1, FLIP_SIDED: 1 });
    const fragOn = preprocessGlsl(shaders.LED_WALL_FRAG, { [ledResp.LED_ANGULAR_DEFINE]: 1 });
    assert.ok(vertOnFront.includes('vec3 transformedNormal = normalMatrix * normal;'));
    assert.equal(vertOnFront.includes('transformedNormal = -transformedNormal;'), false);
    assert.ok(vertOnFlipSided.includes('transformedNormal = -transformedNormal;'));
    assert.ok(vertOnFront.includes('vViewDir = -mvPos.xyz;'));
    assert.ok(fragOn.includes('evaluateLedAngularGainFromView(vViewNormal, vViewDir, gl_FrontFacing)'));
    assert.ok(fragOn.includes(String(ledResp.LED_ANGULAR_KNEE)));

    // Verify uBrightness <= 0.0 early return stays at the very start of main() before fwidth, and diode/cabinet seam logic precedes angular gain.
    const mainBody = fragOn.slice(fragOn.indexOf('void main()'));
    const zeroIdx = mainBody.indexOf('if (uBrightness <= 0.0)');
    const fwidthDiodeIdx = mainBody.indexOf('fwidth(diode)');
    const pixelSnapIdx = mainBody.indexOf('if (uPixelSnap)');
    const fwidthCabinetIdx = mainBody.indexOf('fwidth(cabinet)');
    const angularApplyIdx = mainBody.indexOf('outRgb *= evaluateLedAngularGainFromView');
    assert.ok(zeroIdx > 0 && zeroIdx < fwidthDiodeIdx, 'uBrightness <= 0 early return must stay first');
    assert.ok(fwidthDiodeIdx < pixelSnapIdx && pixelSnapIdx < fwidthCabinetIdx, 'diode & cabinet seam order must stay unchanged');
    assert.ok(fwidthCabinetIdx < angularApplyIdx, 'angular gain must apply to final outRgb after diode & cabinet masking');
  });
});
