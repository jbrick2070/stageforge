import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import * as THREE from 'three';

let server;
let wet;
let settings;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  wet = await server.ssrLoadModule('/src/engine/wetDeck.ts');
  settings = await server.ssrLoadModule('/src/engine/renderSettings.ts');
});

after(async () => {
  await server?.close();
});

describe('Sprint 23C: one neutral PMREM composition and zero-texture deck breakup', () => {
  it('keeps the legacy plan stable and replaces it with five narrow near-neutral strips', () => {
    const legacy = wet.stageEnvironmentPlan(false);
    assert.equal(legacy.composition, 'legacy');
    assert.equal(legacy.background, 0x090c14);
    assert.equal(legacy.blur, 0.04);
    assert.equal(legacy.panels.length, 3);
    assert.deepEqual(legacy.panels.map((p) => p.size), [[20, 6], [20, 4], [16, 8]]);

    const next = wet.stageEnvironmentPlan(true);
    assert.equal(next.composition, 'wet-neutral');
    assert.equal(next.background, 0x06080c);
    assert.equal(next.blur, legacy.blur);
    assert.equal(next.panels.length, 5);
    for (const panel of next.panels) {
      assert.ok(panel.size[1] <= 0.72, 'every C source is a narrow strip');
      const max = Math.max(...panel.radiance), min = Math.min(...panel.radiance);
      assert.ok(max - min <= 0.09, 'strips stay near-neutral');
      assert.ok(max <= 1.34, 'radiance remains restrained');
    }
  });

  it('specializes the shared material without textures and yields to Sprint 18 maps', () => {
    const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), roughness: 0.55, metalness: 0.08 });
    const baseHook = material.onBeforeCompile;
    const baseKey = material.customProgramCacheKey;
    wet.setWetDeckMaterial(material, true);
    assert.deepEqual(material.userData, {});
    assert.equal(material.roughnessMap, null);
    assert.equal(material.normalMap, null);
    assert.match(material.customProgramCacheKey(), /stageforge-wet-deck-v1/);

    const shader = { fragmentShader: '#include <roughnessmap_fragment>', uniforms: {} };
    material.onBeforeCompile(shader, {});
    assert.match(shader.fragmentShader, /sampledDiffuseColor/);
    assert.match(shader.fragmentShader, /!defined\( USE_ROUGHNESSMAP \)/);
    assert.match(shader.fragmentShader, /0\.69 - sampledDiffuseColor\.g \* 3\.5/);
    assert.doesNotMatch(shader.fragmentShader, /texture2D/);

    wet.setWetDeckMaterial(material, false);
    assert.deepEqual(material.userData, {});
    assert.equal(material.onBeforeCompile, baseHook);
    assert.equal(material.customProgramCacheKey, baseKey);
    material.dispose();
  });

  it('promotes only the device-local flag and keeps show schemas free of renderer policy', async () => {
    assert.equal(settings.DEFAULT_RENDER_SETTINGS.lookWetDeck, true);
    assert.equal(settings.parseRenderSettings({ lookWetDeck: false }).lookWetDeck, false);
    assert.equal(settings.parseRenderSettings({ lookWetDeck: 'yes' }).lookWetDeck, true);
    for (let version = 1; version <= 8; version++) {
      const schema = await readFile(new URL(`../src/schemas/show-v${version}.schema.json`, import.meta.url), 'utf8');
      assert.ok(!schema.includes('lookWetDeck'));
    }
  });
});
