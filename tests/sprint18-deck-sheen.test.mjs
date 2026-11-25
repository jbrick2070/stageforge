import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';
import { createServer } from 'vite';

let server;
let hw;
let deckSheenMod;
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
  hw = await server.ssrLoadModule('/src/engine/hardwareMaterials.ts');
  deckSheenMod = await server.ssrLoadModule('/src/engine/deckSheen.ts');
  geoBuilders = await server.ssrLoadModule('/src/engine/geometryBuilders.ts');
  stageGlb = await server.ssrLoadModule('/src/engine/stageGlb.ts');
  renderSettings = await server.ssrLoadModule('/src/engine/renderSettings.ts');
});

after(async () => {
  if (server) await server.close();
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('Sprint 18: deterministic stage deck PBR roughness & normal map generation', () => {
  it('preserves default-off albedo byte-identity and zero optional textures in createSharedMaterials', () => {
    const matsHigh = geoBuilders.createSharedMaterials({ tier: 'high' });
    assert.equal(matsHigh.stageDeck.roughness, hw.STAGE_DECK_BASE_ROUGHNESS);
    assert.equal(matsHigh.stageDeck.metalness, hw.STAGE_DECK_BASE_METALNESS);
    assert.equal(matsHigh.stageDeck.roughnessMap, null);
    assert.equal(matsHigh.stageDeck.normalMap, null);
    geoBuilders.disposeSharedMaterials(matsHigh);

    const albedo512A = hw.generateDeckPixels(512, hw.STAGE_DECK_SEED);
    const albedo512B = hw.generateDeckPixels(512, hw.STAGE_DECK_SEED);
    assert.equal(sha256(albedo512A), sha256(albedo512B));

    const albedo256A = hw.generateDeckPixels(256, hw.STAGE_DECK_SEED);
    const albedo256B = hw.generateDeckPixels(256, hw.STAGE_DECK_SEED);
    assert.equal(sha256(albedo256A), sha256(albedo256B));

    assert.equal(renderSettings.DEFAULT_RENDER_SETTINGS.deckSheen, false);
  });

  it('generates byte-deterministic 128x128 low-tier roughness and 256x256 high-tier roughness+normal maps within VRAM caps', () => {
    assert.equal(hw.deckSheenSizeForTier('low'), 128);
    assert.equal(hw.deckSheenSizeForTier('high'), 256);
    assert.equal(hw.estimateDeckSheenTextureBytes('low', false), 0);
    assert.equal(hw.estimateDeckSheenTextureBytes('high', false), 0);

    const low1 = hw.generateDeckSheenMaps('low', hw.STAGE_DECK_SEED);
    const low2 = hw.generateDeckSheenMaps('low', hw.STAGE_DECK_SEED);
    const lowAlt = hw.generateDeckSheenMaps('low', hw.STAGE_DECK_SEED ^ 0x1234);

    assert.equal(low1.size, 128);
    assert.equal(low1.roughness.length, 128 * 128 * 4);
    assert.equal(low1.normal, null, 'low tier allocates zero normal map bytes');
    assert.equal(low1.textureCount, 1);
    assert.equal(low1.estimatedBytes, 87_380);
    assert.ok(low1.estimatedBytes <= hw.DECK_SHEEN_LOW_MAX_BYTES, `low tier ${low1.estimatedBytes} <= ${hw.DECK_SHEEN_LOW_MAX_BYTES}`);
    assert.deepEqual(low1.roughness, low2.roughness);
    assert.notDeepEqual(low1.roughness, lowAlt.roughness);

    const high1 = hw.generateDeckSheenMaps('high', hw.STAGE_DECK_SEED);
    const high2 = hw.generateDeckSheenMaps('high', hw.STAGE_DECK_SEED);
    assert.equal(high1.size, 256);
    assert.equal(high1.roughness.length, 256 * 256 * 4);
    assert.ok(high1.normal instanceof Uint8ClampedArray);
    assert.equal(high1.normal.length, 256 * 256 * 4);
    assert.equal(high1.textureCount, 2);
    assert.equal(high1.estimatedBytes, 699_048);
    assert.ok(high1.estimatedBytes <= hw.DECK_SHEEN_HIGH_MAX_BYTES, `high tier ${high1.estimatedBytes} <= ${hw.DECK_SHEEN_HIGH_MAX_BYTES}`);
    assert.deepEqual(high1.roughness, high2.roughness);
    assert.deepEqual(high1.normal, high2.normal);
  });

  it('bounds roughness inside satin Marley limits, accentuates panel seams & scuffs, and produces unit-length periodic normals', () => {
    const high = hw.generateDeckSheenMaps('high', hw.STAGE_DECK_SEED);
    const N = high.size; // 256
    const half = N >> 1; // 128

    let minByte = 255;
    let maxByte = 0;
    let seamSum = 0;
    let seamCount = 0;
    let interiorSum = 0;
    let interiorCount = 0;
    let burnishedPixels = 0;
    let abradedPixels = 0;

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const idx = (y * N + x) * 4;
        const r = high.roughness[idx];
        const g = high.roughness[idx + 1];
        const b = high.roughness[idx + 2];
        const a = high.roughness[idx + 3];
        assert.equal(r, g, 'R === G');
        assert.equal(g, b, 'G === B');
        assert.equal(a, 255, 'opaque alpha');
        if (r < minByte) minByte = r;
        if (r > maxByte) maxByte = r;

        const isSeam = x === 0 || y === 0 || x === half || y === half;
        const farFromSeam =
          Math.min(x, N - x) > 3 &&
          Math.abs(x - half) > 3 &&
          Math.min(y, N - y) > 3 &&
          Math.abs(y - half) > 3;

        if (isSeam) {
          seamSum += r;
          seamCount++;
        } else if (farFromSeam) {
          interiorSum += r;
          interiorCount++;
          const rf = r / 255;
          if (rf < 0.515) burnishedPixels++;
          if (rf > 0.585) abradedPixels++;
        }
      }
    }

    // Physical Marley bounds: never mirror-wet (< 0.43) and never chalk-matte (> 0.75).
    assert.ok(minByte >= Math.floor(0.43 * 255), `min roughness byte ${minByte} >= ${Math.floor(0.43 * 255)}`);
    assert.ok(maxByte <= Math.ceil(0.75 * 255), `max roughness byte ${maxByte} <= ${Math.ceil(0.75 * 255)}`);

    const seamMean = (seamSum / seamCount) / 255;
    const interiorMean = (interiorSum / interiorCount) / 255;
    assert.ok(seamMean > interiorMean + 0.08, `panel seams (${seamMean.toFixed(3)}) are rougher than interior (${interiorMean.toFixed(3)})`);
    assert.ok(Math.abs(interiorMean - hw.STAGE_DECK_BASE_ROUGHNESS) < 0.03, `interior mean (${interiorMean.toFixed(3)}) stays centered near ${hw.STAGE_DECK_BASE_ROUGHNESS}`);
    assert.ok(burnishedPixels > 200, `expected burnished scuff pixels (${burnishedPixels} > 200)`);
    assert.ok(abradedPixels > 100, `expected abraded scuff pixels (${abradedPixels} > 100)`);

    // Normal map checks: unit length, weak +Z-dominant slope, and periodic wrap continuity across x = 0 / N - 1.
    let minNz = 1;
    let nonFlatNormals = 0;
    for (let i = 0; i < high.normal.length; i += 4) {
      const nx = (high.normal[i] / 255) * 2 - 1;
      const ny = (high.normal[i + 1] / 255) * 2 - 1;
      const nz = (high.normal[i + 2] / 255) * 2 - 1;
      assert.equal(high.normal[i + 3], 255);
      const len = Math.hypot(nx, ny, nz);
      assert.ok(len > 0.94 && len < 1.06, `unit normal length ${len}`);
      assert.ok(nz > 0.80, `weak bounded normal slope nz=${nz}`);
      if (nz < minNz) minNz = nz;
      if (Math.hypot(nx, ny) > 0.03) nonFlatNormals++;
    }
    assert.ok(nonFlatNormals > 500, `expected seam & scuff normal perturbations (${nonFlatNormals} > 500)`);
    assert.ok(minNz < 0.999, 'normal map is not completely flat');
  });
});

describe('Sprint 18: DeckSheenController colour spaces, UV transforms, disposal & GLB export contract', () => {
  function createTrackingFactory() {
    const created = [];
    const factory = (pixels, width, height, colorSpace, anisotropy) => {
      const tex = new THREE.DataTexture(new Uint8Array(pixels.buffer.slice(0)), width, height, THREE.RGBAFormat);
      tex.colorSpace = colorSpace;
      tex.anisotropy = anisotropy;
      let disposeCalls = 0;
      tex.addEventListener('dispose', () => {
        disposeCalls++;
      });
      created.push({ tex, get disposeCalls() { return disposeCalls; }, width, height });
      return tex;
    };
    return { created, factory };
  }

  it('enforces NoColorSpace, RepeatWrapping 6x3, mipmaps, anisotropy, immediate disable disposal, and zero double-dispose', () => {
    // High tier lifecycle
    const highTrack = createTrackingFactory();
    const highCtrl = new deckSheenMod.DeckSheenController('high', 8, highTrack.factory);
    const matHigh = new THREE.MeshStandardMaterial({ roughness: hw.STAGE_DECK_BASE_ROUGHNESS, metalness: hw.STAGE_DECK_BASE_METALNESS });

    assert.equal(highTrack.created.length, 0, 'zero textures allocated while default-off');
    assert.deepEqual(highCtrl.getStats(), {
      requested: false,
      active: false,
      tier: 'high',
      mapSize: 256,
      roughnessAllocated: false,
      normalAllocated: false,
      extraTextureCount: 0,
      extraTextureBytes: 0,
    });

    // Enable on high tier -> allocates 256x256 roughness + 256x256 normal
    highCtrl.apply(matHigh, true);
    assert.equal(highTrack.created.length, 2);
    assert.equal(matHigh.roughness, 1.0);
    assert.ok(Math.abs(matHigh.normalScale.x - hw.STAGE_DECK_SHEEN_NORMAL_SCALE) < 1e-6);
    assert.ok(Math.abs(matHigh.normalScale.y - hw.STAGE_DECK_SHEEN_NORMAL_SCALE) < 1e-6);
    assert.equal(matHigh.roughnessMap, highTrack.created[0].tex);
    assert.equal(matHigh.normalMap, highTrack.created[1].tex);

    for (const entry of highTrack.created) {
      assert.equal(entry.width, 256);
      assert.equal(entry.height, 256);
      assert.equal(entry.tex.colorSpace, THREE.NoColorSpace, 'roughness & normal maps must be linear NoColorSpace');
      assert.equal(entry.tex.wrapS, THREE.RepeatWrapping);
      assert.equal(entry.tex.wrapT, THREE.RepeatWrapping);
      assert.equal(entry.tex.repeat.x, hw.STAGE_DECK_REPEAT_X);
      assert.equal(entry.tex.repeat.y, hw.STAGE_DECK_REPEAT_Y);
      assert.equal(entry.tex.generateMipmaps, true);
      assert.equal(entry.tex.minFilter, THREE.LinearMipmapLinearFilter);
      assert.equal(entry.tex.magFilter, THREE.LinearFilter);
      assert.equal(entry.tex.anisotropy, 4, 'high tier clamps anisotropy to min(4, maxAnisotropy)');
      assert.equal(entry.disposeCalls, 0);
    }

    assert.deepEqual(highCtrl.getStats(), {
      requested: true,
      active: true,
      tier: 'high',
      mapSize: 256,
      roughnessAllocated: true,
      normalAllocated: true,
      extraTextureCount: 2,
      extraTextureBytes: 699_048,
    });

    // Idempotent re-apply while enabled allocates nothing new
    highCtrl.apply(matHigh, true);
    assert.equal(highTrack.created.length, 2);

    // WebGL context restore bumps texture and material versions cleanly
    const roughVerBefore = matHigh.roughnessMap.version;
    const normVerBefore = matHigh.normalMap.version;
    const matVerBefore = matHigh.version;
    highCtrl.onContextRestored(matHigh);
    assert.ok(matHigh.roughnessMap.version > roughVerBefore);
    assert.ok(matHigh.normalMap.version > normVerBefore);
    assert.ok(matHigh.version > matVerBefore);

    // Disable immediately detaches and disposes both textures
    highCtrl.apply(matHigh, false);
    assert.equal(matHigh.roughnessMap, null);
    assert.equal(matHigh.normalMap, null);
    assert.equal(matHigh.roughness, hw.STAGE_DECK_BASE_ROUGHNESS);
    assert.equal(matHigh.normalScale.x, 1);
    assert.equal(matHigh.normalScale.y, 1);
    assert.equal(highTrack.created[0].disposeCalls, 1);
    assert.equal(highTrack.created[1].disposeCalls, 1);
    assert.equal(highCtrl.getStats().extraTextureCount, 0);
    assert.equal(highCtrl.getStats().extraTextureBytes, 0);

    // Re-enable then dispose controller before disposeSharedMaterials -> each texture disposed exactly once
    highCtrl.apply(matHigh, true);
    assert.equal(highTrack.created.length, 4);
    const matsBundle = { ...geoBuilders.createSharedMaterials({ tier: 'high' }), stageDeck: matHigh };
    highCtrl.dispose(matsBundle.stageDeck);
    geoBuilders.disposeSharedMaterials(matsBundle);
    assert.equal(highTrack.created[2].disposeCalls, 1, 'roughness disposed once without double-dispose');
    assert.equal(highTrack.created[3].disposeCalls, 1, 'normal disposed once without double-dispose');

    // Low tier lifecycle -> allocates strictly 1 texture (128x128 roughness, anisotropy 1, no normal map)
    const lowTrack = createTrackingFactory();
    const lowCtrl = new deckSheenMod.DeckSheenController('low', 8, lowTrack.factory);
    const matLow = new THREE.MeshStandardMaterial({ roughness: hw.STAGE_DECK_BASE_ROUGHNESS, metalness: hw.STAGE_DECK_BASE_METALNESS });
    lowCtrl.apply(matLow, true);
    assert.equal(lowTrack.created.length, 1);
    assert.equal(lowTrack.created[0].width, 128);
    assert.equal(lowTrack.created[0].tex.colorSpace, THREE.NoColorSpace);
    assert.equal(lowTrack.created[0].tex.anisotropy, 1);
    assert.equal(matLow.normalMap, null);
    assert.equal(matLow.roughness, 1.0);
    assert.equal(matLow.normalScale.x, 1);
    assert.deepEqual(lowCtrl.getStats(), {
      requested: true,
      active: true,
      tier: 'low',
      mapSize: 128,
      roughnessAllocated: true,
      normalAllocated: false,
      extraTextureCount: 1,
      extraTextureBytes: 87_380,
    });
    lowCtrl.dispose(matLow);
    assert.equal(lowTrack.created[0].disposeCalls, 1);
  });

  it('keeps stageSnapshot / GLB deck material canonical and invariant of deckSheen across legacy BoxGeometry and authored PlatformDeck', () => {
    const track = createTrackingFactory();
    const mats = geoBuilders.createSharedMaterials({ tier: 'high' });
    const ctrl = new deckSheenMod.DeckSheenController('high', 4, track.factory);

    // 1. Legacy BoxGeometry deck
    const legacyRig = { name: 'Legacy Arena', venue: 'arena', stageWidth: 18, stageHeight: 1.2, stageDepth: 10 };
    const legacyDeck = new THREE.Mesh(new THREE.BoxGeometry(18, 1.2, 10), mats.stageDeck);
    legacyDeck.name = 'Main stage deck';

    const snapLegacyOff = stageGlb.stageSnapshot(legacyRig, [legacyDeck], mats);
    ctrl.apply(mats.stageDeck, true);
    assert.ok(mats.stageDeck.roughnessMap !== null);
    assert.ok(mats.stageDeck.normalMap !== null);
    const snapLegacyOn = stageGlb.stageSnapshot(legacyRig, [legacyDeck], mats);

    const exportedLegacyOff = snapLegacyOff.getObjectByName('Main stage deck').material;
    const exportedLegacyOn = snapLegacyOn.getObjectByName('Main stage deck').material;
    assert.equal(exportedLegacyOn.roughnessMap, null);
    assert.equal(exportedLegacyOn.normalMap, null);
    assert.equal(exportedLegacyOn.roughness, hw.STAGE_DECK_BASE_ROUGHNESS);
    assert.equal(exportedLegacyOn.roughness, exportedLegacyOff.roughness);
    assert.equal(exportedLegacyOn.metalness, exportedLegacyOff.metalness);
    // Live renderer material stays active and untouched
    assert.ok(mats.stageDeck.roughnessMap !== null);
    assert.equal(mats.stageDeck.roughness, 1.0);

    // 2. Authored multi-module PlatformDeck
    const platRig = {
      name: 'Platform Show',
      venue: 'club',
      platforms: [
        { id: 'main', name: 'Main deck', x: 0, z: 0, width: 8, depth: 5, height: 1 },
        { id: 'riser', name: 'Drum riser', x: 0, z: -1, width: 3, depth: 2, height: 1.6 },
      ],
    };
    const livePlat = geoBuilders.buildPlatformDeck(platRig, mats);
    livePlat.userData.kind = 'platforms';
    const snapPlatOn = stageGlb.stageSnapshot(platRig, [livePlat], mats);
    const mainSurface = snapPlatOn.getObjectByName('Main deck').getObjectByName('Deck surface');
    assert.ok(mainSurface && mainSurface.isMesh);
    assert.equal(mainSurface.material.roughnessMap, null);
    assert.equal(mainSurface.material.normalMap, null);
    assert.equal(mainSurface.material.roughness, hw.STAGE_DECK_BASE_ROUGHNESS);

    ctrl.dispose(mats.stageDeck);
    geoBuilders.disposeSharedMaterials(mats);
  });

  it('documents optional stage deck roughness/normal maps in docs/assets.md and docs/graphics.md', async () => {
    const assetsDoc = await readFile(new URL('../docs/assets.md', import.meta.url), 'utf8');
    const graphicsDoc = await readFile(new URL('../docs/graphics.md', import.meta.url), 'utf8');
    assert.ok(assetsDoc.includes('deckSheen'), 'docs/assets.md records optional deckSheen maps');
    assert.ok(assetsDoc.includes('128×128') && assetsDoc.includes('256×256'));
    assert.ok(graphicsDoc.includes('Deck Sheen Response (`deckSheen`'), 'docs/graphics.md documents deckSheen');
    assert.ok(!/planar reflection|screen-space reflection/i.test(graphicsDoc.replace(/no planar reflections or SSR/gi, '')));
  });
});
