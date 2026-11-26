import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'vite';

let server;
let settings;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  settings = await server.ssrLoadModule('/src/engine/renderSettings.ts');
});

after(async () => {
  await server?.close();
});

describe('Sprint 23A: colour/output policy', () => {
  it('keeps the development flag-off path legacy-exact and resolves accessibility without mutating requested settings', () => {
    const requested = settings.parseRenderSettings({
      ...settings.DEFAULT_RENDER_SETTINGS,
      lookOutput: false,
      trueColour: true,
      reducedEffects: true,
    });
    const before = structuredClone(requested);
    const off = settings.resolveEffectiveLookOutput(requested, 'low', true);
    assert.deepEqual(off, {
      enabled: false,
      trueColour: false,
      reducedEffects: false,
      reducedReason: null,
      videoSrgbDecode: false,
      bloomScaleCap: 1,
      bloomStrengthScale: 1,
      bloomRadius: 0.38,
      bloomThreshold: 0.66,
    });
    assert.deepEqual(requested, before);
  });

  it('keeps colour-correct video decode in True colour and applies deterministic low-tier/reduced-motion bloom caps', () => {
    const base = settings.parseRenderSettings({
      ...settings.DEFAULT_RENDER_SETTINGS,
      lookOutput: true,
      videoSrgbDecode: true,
    });
    const normal = settings.resolveEffectiveLookOutput(base, 'high', false);
    assert.equal(normal.videoSrgbDecode, true);
    assert.equal(normal.bloomScaleCap, 1);
    assert.equal(normal.bloomStrengthScale, 0.72);
    assert.equal(settings.resolveEffectiveBloomScale(base, 'high', false), 1);

    const low = settings.resolveEffectiveLookOutput(base, 'low', false);
    assert.equal(low.reducedEffects, true);
    assert.equal(low.reducedReason, 'low-tier');
    assert.equal(settings.resolveEffectiveBloomScale(base, 'low', false), 0.5);

    const motion = settings.resolveEffectiveLookOutput(base, 'high', true);
    assert.equal(motion.reducedReason, 'reduced-motion');
    assert.equal(settings.resolveEffectiveBloomScale(base, 'high', true), 0.5);

    const preference = settings.resolveEffectiveLookOutput({ ...base, reducedEffects: true }, 'high', false);
    assert.equal(preference.reducedReason, 'preference');
    assert.equal(preference.bloomStrengthScale, 0.36);

    const trueColour = settings.resolveEffectiveLookOutput({ ...base, trueColour: true }, 'high', false);
    assert.equal(trueColour.trueColour, true);
    assert.equal(trueColour.videoSrgbDecode, true);
    assert.equal(trueColour.bloomScaleCap, 0);
    assert.equal(trueColour.bloomStrengthScale, 0);
  });

  it('keeps look preferences device-local and out of every show schema', async () => {
    for (let version = 1; version <= 8; version++) {
      const schema = await readFile(join(process.cwd(), 'src', 'schemas', `show-v${version}.schema.json`), 'utf8');
      for (const key of ['lookOutput', 'lookNeonFrame', 'lookWetDeck', 'trueColour', 'reducedEffects', 'videoSrgbDecode']) {
        assert.equal(schema.includes(key), false, `${key} must not enter show-v${version}`);
      }
    }
  });
});
