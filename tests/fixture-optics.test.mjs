import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const compiler = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true } });
after(() => compiler.close());
const { fixtureOptics, aerialGain } = await compiler.ssrLoadModule('/src/data/fixtureOptics.ts');

test('opted-in aerial beams conserve relative luminous flux through zoom while legacy beams keep their exposure', () => {
  for (const angle of [0.1, 4, 35.3, 179]) {
    const optics = fixtureOptics('beam', { lumens: 1483, beamAngle: angle });
    const solidAngle = zoom => 4 * Math.PI * Math.sin(Math.atan(optics.zoomSlope * zoom) / 2) ** 2;
    const reference = aerialGain(optics, 1) * solidAngle(1);
    for (const zoom of [0.42, 1, 1.77]) {
      const flux = aerialGain(optics, zoom) * solidAngle(zoom);
      assert.ok(Math.abs(flux - reference) < reference * 1e-10);
    }
    assert.ok(aerialGain(optics, 0.42) > aerialGain(optics, 1.77));
  }
  const legacy = fixtureOptics('wash');
  assert.equal(aerialGain(legacy, 0.75), 1);
  assert.equal(aerialGain(legacy, 1.6), 1);
  assert.equal(aerialGain(fixtureOptics('wash', { lumens: 0 }), 0.75), 0);
});
