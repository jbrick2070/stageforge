import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';
import { createServer } from 'vite';

let server;
let crowdMod;
let geoBuilders;
let stageGlb;
let renderSettings;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    logLevel: 'error',
  });
  crowdMod = await server.ssrLoadModule('/src/engine/crowdLighting.ts');
  geoBuilders = await server.ssrLoadModule('/src/engine/geometryBuilders.ts');
  stageGlb = await server.ssrLoadModule('/src/engine/stageGlb.ts');
  renderSettings = await server.ssrLoadModule('/src/engine/renderSettings.ts');
});

after(async () => {
  if (server) await server.close();
});

describe('Sprint 19: aggregate show-light solver (tier slots, blackout, cross-fade & energy conservation)', () => {
  it('defaults crowdLighting to false and maps low tier -> 1 light slot, high tier -> 2 light slots', () => {
    assert.equal(renderSettings.DEFAULT_RENDER_SETTINGS.crowdLighting, false);
    assert.equal(crowdMod.crowdLightSlotsForTier('low'), 1);
    assert.equal(crowdMod.crowdLightSlotsForTier('high'), 2);
  });

  it('zeroes all light colours immediately on blackout, zero master, or zero roomGain', () => {
    const center = { x: 0, y: 1.25, z: 16 };
    const heads = [
      {
        lastPreviewIntensity: 1.0,
        lastPreviewR: 0,
        lastPreviewG: 0.94,
        lastPreviewB: 1,
        fluxRatio: 1,
        lastWorldX: -6,
        lastWorldY: 9,
        lastWorldZ: 0,
        lastAimZ: 0.5,
      },
    ];
    const baseFrame = {
      ...crowdMod.createCrowdFrameInputs(),
      blackout: false,
      master: 1,
      roomGain: 1,
      blinder: 0.8,
      strobeBarBright: 2.0,
      ledBright: 0.9,
      hasLedWalls: true,
      primaryR: 0,
      primaryG: 1,
      primaryB: 1,
      accentR: 1,
      accentG: 0,
      accentB: 0.6,
    };

    for (const tier of ['low', 'high']) {
      const state = crowdMod.createCrowdShowLightState(tier);
      crowdMod.evaluateCrowdShowLights(tier, center, heads, { ...baseFrame, blackout: true }, state);
      assert.equal(state.color0.r, 0);
      assert.equal(state.color0.g, 0);
      assert.equal(state.color0.b, 0);
      assert.equal(state.color1.r, 0);
      assert.equal(state.color1.g, 0);
      assert.equal(state.color1.b, 0);
      assert.ok(Math.abs(state.dir0.length() - 1) < 1e-5, 'blackout keeps unit fallback direction');

      crowdMod.evaluateCrowdShowLights(tier, center, heads, { ...baseFrame, master: 0 }, state);
      assert.equal(state.color0.r + state.color0.g + state.color0.b, 0);

      crowdMod.evaluateCrowdShowLights(tier, center, heads, { ...baseFrame, roomGain: 0 }, state);
      assert.equal(state.color0.r + state.color0.g + state.color0.b, 0);
    }
  });

  it('conserves total RGB energy across 1-slot low tier and 2-slot high tier while separating left/right directions & colours', () => {
    const center = { x: 0, y: 1.25, z: 18 };
    const heads = [
      // House-left cyan head
      {
        lastPreviewIntensity: 0.9,
        lastPreviewR: 0.0,
        lastPreviewG: 0.95,
        lastPreviewB: 1.0,
        fluxRatio: 1.0,
        lastWorldX: -7.5,
        lastWorldY: 9.0,
        lastWorldZ: 1.0,
        lastAimZ: 0.65,
      },
      // House-right magenta head
      {
        lastPreviewIntensity: 0.9,
        lastPreviewR: 1.0,
        lastPreviewG: 0.05,
        lastPreviewB: 0.65,
        fluxRatio: 1.0,
        lastWorldX: 7.5,
        lastWorldY: 9.0,
        lastWorldZ: 1.0,
        lastAimZ: 0.65,
      },
    ];
    const frame = crowdMod.createCrowdFrameInputs();

    const low = crowdMod.createCrowdShowLightState('low');
    const high = crowdMod.createCrowdShowLightState('high');
    crowdMod.evaluateCrowdShowLights('low', center, heads, frame, low);
    crowdMod.evaluateCrowdShowLights('high', center, heads, frame, high);

    // Total RGB energy on 1-slot low tier equals sum of slot 0 + slot 1 on 2-slot high tier
    assert.ok(Math.abs(low.color0.r - (high.color0.r + high.color1.r)) < 1e-6);
    assert.ok(Math.abs(low.color0.g - (high.color0.g + high.color1.g)) < 1e-6);
    assert.ok(Math.abs(low.color0.b - (high.color0.b + high.color1.b)) < 1e-6);
    assert.equal(low.color1.r + low.color1.g + low.color1.b, 0);

    // High tier separates house-left (cyan: G > R, dir0.x < 0) and house-right (magenta: R > G, dir1.x > 0)
    assert.ok(high.dir0.x < -0.25, `expected house-left dir0.x < -0.25, got ${high.dir0.x}`);
    assert.ok(high.dir1.x > 0.25, `expected house-right dir1.x > 0.25, got ${high.dir1.x}`);
    assert.ok(high.dir0.z < -0.5, 'points from crowd toward stage (-Z)');
    assert.ok(high.dir1.z < -0.5, 'points from crowd toward stage (-Z)');
    assert.ok(high.color0.g > high.color0.r * 5, 'left slot carries cyan');
    assert.ok(high.color1.r > high.color1.g * 5, 'right slot carries magenta');

    // Audience aim coupling: heads sweeping into the house (aimZ = +0.75) produce stronger crowd response than deck-only (aimZ = -0.8)
    const downHeads = heads.map((h) => ({ ...h, lastAimZ: -0.8 }));
    const highDown = crowdMod.createCrowdShowLightState('high');
    crowdMod.evaluateCrowdShowLights('high', center, downHeads, frame, highDown);
    assert.ok(
      high.color0.g > highDown.color0.g * 1.6,
      `crowd-aimed heads (${high.color0.g.toFixed(3)}) couple stronger than deck-aimed (${highDown.color0.g.toFixed(3)})`,
    );

    // Smooth cross-fade across x = 0: sweeping a single head from x = -4 to +4 varies slot0/slot1 continuously without discontinuities
    let prevLeftR = null;
    for (let x = -4; x <= 4; x += 0.5) {
      crowdMod.evaluateCrowdShowLights(
        'high',
        center,
        [{ ...heads[1], lastWorldX: x }],
        frame,
        high,
      );
      if (prevLeftR !== null) {
        assert.ok(high.color0.r <= prevLeftR + 1e-6, 'left weight decreases monotonically as source moves right');
        assert.ok(Math.abs(high.color0.r - prevLeftR) < 0.08, 'no abrupt pop across x = 0');
      }
      prevLeftR = high.color0.r;
    }
  });
});

describe('Sprint 19: shading model (rim gating, no uniform outline, anatomical height mask & hue-preserving 0.56 clamp)', () => {
  it('lights backlit FOH silhouettes on the light-facing edge while suppressing opposite-side and reverse-view uniform outlines', () => {
    const cyanBacklight = [{ viewLightDir: { x: -0.45, y: 0.35, z: -0.82 }, color: { r: 0, g: 0.75, b: 0.85 } }];
    const base = { r: 0.04, g: 0.04, b: 0.05 };
    const jacket = { r: 0.42, g: 0.45, b: 0.52 };

    // FOH camera looks toward -Z, so viewDir from spectator toward camera is +Z (0, 0, 1).
    // Grazing left shoulder normal tilted toward the house-left stage light (-0.92, 0.25, 0.30):
    const litShoulder = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: base,
      diffuseColor: jacket,
      viewNormal: { x: -0.92, y: 0.25, z: 0.30 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 1.48,
      lights: cyanBacklight,
    });

    // Opposite right-side silhouette edge facing AWAY from the house-left light (+0.95, -0.10, 0.29):
    const awayEdge = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: base,
      diffuseColor: jacket,
      viewNormal: { x: 0.95, y: -0.10, z: 0.29 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 1.48,
      lights: cyanBacklight,
    });

    assert.ok(litShoulder.added.b > 0.08, `expected visible cyan rim on light-facing shoulder (${litShoulder.added.b.toFixed(3)})`);
    assert.ok(
      litShoulder.added.b > awayEdge.added.b * 6,
      `light-facing rim (${litShoulder.added.b.toFixed(4)}) must dominate away-facing edge (${awayEdge.added.b.toFixed(4)}) — no uniform outline`,
    );

    // Lower ankle (localY = 0.20) receives much less rim than upper shoulder/head (localY = 1.60)
    const ankle = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: base,
      diffuseColor: jacket,
      viewNormal: { x: -0.92, y: 0.25, z: 0.30 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 0.20,
      lights: cyanBacklight,
    });
    assert.ok(litShoulder.added.b > ankle.added.b * 3.2, 'upper body receives stronger show rim than lower ankles');

    // Reverse orbit (camera behind stage looking into house: light is BEHIND camera, so viewLightDir has +Z aligned with +V):
    // Grazing silhouette edge (viewNormal = (-0.98, 0.15, 0.13), light from (+0, 0.35, +0.94)) has zero forward-scatter rim,
    // and front-facing chest (viewNormal = (0, 0.2, 0.98)) receives more fill than the grazing edge (opposite of an outline!).
    const reverseEdge = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: base,
      diffuseColor: jacket,
      viewNormal: { x: -0.98, y: 0.15, z: 0.13 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 1.48,
      lights: [{ viewLightDir: { x: 0, y: 0.35, z: 0.94 }, color: { r: 0, g: 0.75, b: 0.85 } }],
    });
    const reverseFrontChest = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: base,
      diffuseColor: jacket,
      viewNormal: { x: 0, y: 0.20, z: 0.98 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 1.48,
      lights: [{ viewLightDir: { x: 0, y: 0.35, z: 0.94 }, color: { r: 0, g: 0.75, b: 0.85 } }],
    });
    assert.ok(
      reverseFrontChest.added.b > reverseEdge.added.b * 3.0,
      `front-lit chest (${reverseFrontChest.added.b.toFixed(3)}) is brighter than grazing edge (${reverseEdge.added.b.toFixed(3)}) — zero reverse outline`,
    );
  });

  it('enforces hue-preserving <= 0.56 headroom clamp without altering pre-existing lighting above 0.56', () => {
    const extremeLights = [
      { viewLightDir: { x: -0.3, y: 0.4, z: -0.86 }, color: { r: 4.0, g: 2.0, b: 0.5 } },
      { viewLightDir: { x: 0.3, y: 0.4, z: -0.86 }, color: { r: 4.0, g: 2.0, b: 0.5 } },
    ];

    // 1. Dark base (0.05) on grazing crown/shoulder + extreme show light -> capped strictly <= 0.56 (below 0.66 bloom threshold)
    const fromDark = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: { r: 0.05, g: 0.05, b: 0.05 },
      diffuseColor: { r: 0.8, g: 0.8, b: 0.8 },
      viewNormal: { x: -0.65, y: 0.65, z: 0.39 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 1.65,
      lights: extremeLights,
    });
    const peakDark = Math.max(fromDark.outgoing.r, fromDark.outgoing.g, fromDark.outgoing.b);
    assert.ok(peakDark <= crowdMod.CROWD_MAX_OUTGOING_RADIANCE + 1e-6, `peak ${peakDark} <= ${crowdMod.CROWD_MAX_OUTGOING_RADIANCE}`);
    assert.ok(fromDark.added.r > fromDark.added.g && fromDark.added.g > fromDark.added.b, 'preserves R > G > B hue ordering');

    // 2. Partial headroom (base = 0.45 -> headroom = 0.11): scales RGB uniformly so hue ratio is exact
    const unclipped = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: { r: 0.0, g: 0.0, b: 0.0 },
      diffuseColor: { r: 0.6, g: 0.6, b: 0.6 },
      viewNormal: { x: -0.85, y: 0.35, z: 0.39 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 1.65,
      lights: [{ viewLightDir: { x: -0.4, y: 0.4, z: -0.82 }, color: { r: 1.2, g: 0.6, b: 0.2 } }],
    });
    const headroomClamped = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: { r: 0.45, g: 0.10, b: 0.05 },
      diffuseColor: { r: 0.6, g: 0.6, b: 0.6 },
      viewNormal: { x: -0.85, y: 0.35, z: 0.39 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 1.65,
      lights: [{ viewLightDir: { x: -0.4, y: 0.4, z: -0.82 }, color: { r: 1.2, g: 0.6, b: 0.2 } }],
    });
    assert.ok(Math.max(headroomClamped.outgoing.r, headroomClamped.outgoing.g, headroomClamped.outgoing.b) <= 0.56 + 1e-6);
    // Hue ratio added.g / added.r is preserved identically before and after headroom scaling!
    assert.ok(
      Math.abs(headroomClamped.added.g / headroomClamped.added.r - unclipped.added.g / unclipped.added.r) < 1e-6,
      'uniform scalar headroom clamp preserves exact RGB hue ratio without per-channel desaturation',
    );

    // 3. Pre-existing bright highlight already above 0.56 (e.g. 0.78) is left completely untouched!
    const preBright = crowdMod.evaluateCrowdFragmentShading({
      baseOutgoing: { r: 0.78, g: 0.62, b: 0.40 },
      diffuseColor: { r: 0.6, g: 0.6, b: 0.6 },
      viewNormal: { x: -0.85, y: 0.35, z: 0.39 },
      viewDir: { x: 0, y: 0, z: 1 },
      localY: 1.65,
      lights: extremeLights,
    });
    assert.equal(preBright.added.r, 0);
    assert.equal(preBright.added.g, 0);
    assert.equal(preBright.added.b, 0);
    assert.equal(preBright.outgoing.r, 0.78);
    assert.equal(preBright.outgoing.g, 0.62);
    assert.equal(preBright.outgoing.b, 0.40);
  });
});

describe('Sprint 19: shader specialization, CrowdLightingController lifecycle, venue phones & GLB invariance', () => {
  it('patches MeshStandardMaterial cleanly for 1-light (low) and 2-light (high) variants before <opaque_fragment>', () => {
    const uniforms = crowdMod.createCrowdUniformBag();
    const lowShader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    crowdMod.patchCrowdStandardShader(lowShader, 1, uniforms);
    assert.ok(lowShader.vertexShader.includes('#define CROWD_SHOW_LIGHTS 1'));
    assert.ok(lowShader.fragmentShader.includes('#define CROWD_SHOW_LIGHTS 1'));
    assert.ok(lowShader.vertexShader.indexOf('vCrowdHeight =') > lowShader.vertexShader.indexOf('#include <morphtarget_vertex>'));
    assert.ok(lowShader.fragmentShader.indexOf('outgoingLight += crowdAdded;') < lowShader.fragmentShader.indexOf('#include <opaque_fragment>'));
    assert.ok('uCrowdLightDir0' in lowShader.uniforms);
    assert.ok(!('uCrowdLightDir1' in lowShader.uniforms), 'low tier does not bind second light uniform');

    const highShader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    crowdMod.patchCrowdStandardShader(highShader, 2, uniforms);
    assert.ok(highShader.vertexShader.includes('#define CROWD_SHOW_LIGHTS 2'));
    assert.ok(highShader.fragmentShader.includes('#define CROWD_SHOW_LIGHTS 2'));
    assert.ok('uCrowdLightDir1' in highShader.uniforms);
    assert.ok('uCrowdLightColor1' in highShader.uniforms);
  });

  it('keeps base crowd material untouched when off, preserves shared phone matrices & seated zero-phone rule, and leaves GLB unaffected', () => {
    const mats = geoBuilders.createSharedMaterials({ tier: 'high' });

    // 1. Standing Arena venue: phones share crowdMesh.instanceMatrix
    const arena = geoBuilders.buildVenueArchitecture('arena', 0.8, mats, 22, 11, 1.8);
    arena.group.userData.kind = 'venue';
    assert.ok(arena.crowdMesh instanceof THREE.InstancedMesh);
    assert.ok(arena.phonesMesh instanceof THREE.InstancedMesh);
    assert.equal(arena.seated, false);
    assert.equal(arena.phonesMesh.instanceMatrix, arena.crowdMesh.instanceMatrix, 'standing phones share crowd instanceMatrix');

    const baseMat = arena.crowdMesh.material;
    const origBeforeCompile = baseMat.onBeforeCompile;
    const origCacheKey = baseMat.customProgramCacheKey;

    const ctrl = new crowdMod.CrowdLightingController('high');
    ctrl.bindVenue({
      crowdMesh: arena.crowdMesh,
      phonesMesh: arena.phonesMesh,
      transforms: arena.crowdBaseTransforms,
      seated: arena.seated,
      stageDepth: 11,
    });

    // Default off: base material is 100% untouched
    assert.equal(arena.crowdMesh.material, baseMat);
    assert.equal(baseMat.onBeforeCompile, origBeforeCompile);
    assert.equal(baseMat.customProgramCacheKey, origCacheKey);
    assert.equal(ctrl.getStats().active, false);
    assert.equal(ctrl.getStats().lightSlotCount, 0);
    assert.equal(ctrl.getStats().phonesShareInstanceMatrix, true);

    // Enable: swaps in dedicated lit variant without mutating baseMat, and keeps phones sharing instanceMatrix
    ctrl.setEnabled(true);
    const litMat = arena.crowdMesh.material;
    assert.notEqual(litMat, baseMat);
    assert.equal(baseMat.onBeforeCompile, origBeforeCompile, 'base material hook never mutated');
    assert.equal(arena.phonesMesh.instanceMatrix, arena.crowdMesh.instanceMatrix, 'phones stay attached when enabled');
    assert.equal(ctrl.getStats().active, true);
    assert.equal(ctrl.getStats().lightSlotCount, 2);
    assert.ok(litMat.customProgramCacheKey().includes('crowd-show-v1-2'));

    let litDisposed = 0;
    litMat.addEventListener('dispose', () => { litDisposed++; });

    // GLB snapshot skips venue group completely whether crowdLighting is on or off
    const deck = new THREE.Mesh(new THREE.BoxGeometry(22, 1.8, 11), mats.stageDeck);
    deck.name = 'Main stage deck';
    const rig = { name: 'Arena Rig', venue: 'arena', stageWidth: 22, stageHeight: 1.8, stageDepth: 11 };
    const snapOn = stageGlb.stageSnapshot(rig, [arena.group, deck], mats);
    ctrl.setEnabled(false);
    assert.equal(litDisposed, 1, 'disabling disposes lit material variant immediately');
    assert.equal(arena.crowdMesh.material, baseMat, 'disabling restores exact original MeshStandardMaterial');
    assert.equal(baseMat.onBeforeCompile, origBeforeCompile);
    assert.equal(baseMat.customProgramCacheKey, origCacheKey);
    const snapOff = stageGlb.stageSnapshot(rig, [arena.group, deck], mats);
    assert.equal(snapOn.children.length, snapOff.children.length);
    assert.equal(snapOn.children.length, 1, 'venue crowd is excluded from GLB export');

    // 2. Seated Theatre venue: seated === true, phoneCount === 0, raked crowdCenter.y > standing crowdCenter.y
    const theatre = geoBuilders.buildVenueArchitecture('theatre', 0.8, mats, 16, 10, 1.2);
    assert.equal(theatre.seated, true);
    assert.equal(theatre.phonesMesh, null, 'theatre house has zero recording phones');
    const lowCtrl = new crowdMod.CrowdLightingController('low');
    lowCtrl.bindVenue({
      crowdMesh: theatre.crowdMesh,
      phonesMesh: theatre.phonesMesh,
      transforms: theatre.crowdBaseTransforms,
      seated: theatre.seated,
      stageDepth: 10,
    });
    lowCtrl.setEnabled(true);
    const lowStats = lowCtrl.getStats();
    assert.equal(lowStats.seated, true);
    assert.equal(lowStats.phoneCount, 0);
    assert.equal(lowStats.phonesShareInstanceMatrix, true);
    assert.equal(lowStats.lightSlotCount, 1);
    assert.ok(lowStats.crowdCenter[1] > 1.8, `raked theatre stalls raise crowdCenter.y (${lowStats.crowdCenter[1]})`);

    lowCtrl.dispose();
    ctrl.dispose();
    geoBuilders.disposeSharedMaterials(mats);
  });

  it('documents crowdLighting and its scoped artistic & clamp guarantees in docs/graphics.md', async () => {
    const graphicsDoc = await readFile(new URL('../docs/graphics.md', import.meta.url), 'utf8');
    assert.ok(graphicsDoc.includes('Crowd Show-Light Response (`crowdLighting`'));
    assert.ok(graphicsDoc.includes('artistic lighting approximation'));
    assert.ok(graphicsDoc.includes('0.56'));
  });
});
